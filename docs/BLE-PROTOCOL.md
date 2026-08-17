# PhotoX4 BLE protocol

The contract between `web/` (Web Bluetooth central) and `firmware/` (NimBLE
peripheral on the ESP32-C3). Every multi-byte integer is **little-endian**, to
match the device processor.

## GATT layout

Advertised name: `PhotoX4` (suffixed with the last two bytes of the MAC, e.g.
`PhotoX4-3F7A`, so several devices can coexist).

| Role    | UUID                                   | Properties             |
| ------- | -------------------------------------- | ---------------------- |
| Service | `7a1f0000-4b3d-4c1e-9a2b-6d5e8f7c3a10` | —                      |
| `CTRL`  | `7a1f0001-4b3d-4c1e-9a2b-6d5e8f7c3a10` | write, notify          |
| `DATA`  | `7a1f0002-4b3d-4c1e-9a2b-6d5e8f7c3a10` | write-without-response |

`CTRL` carries short framed commands and their replies. `DATA` carries file
bodies only.

## Command frames (client → device, `CTRL` write)

    [op u8][payload…]

| Op     | Name         | Payload                                              |
| ------ | ------------ | ---------------------------------------------------- |
| `0x01` | `HELLO`      | —                                                    |
| `0x02` | `SET_TIME`   | `[epoch u32][tzMinutes i16]`                         |
| `0x10` | `FILE_BEGIN` | `[size u32][crc32 u32][pathLen u8][path bytes]`      |
| `0x11` | `FILE_END`   | —                                                    |
| `0x12` | `FILE_ABORT` | —                                                    |
| `0x13` | `DELETE`     | `[pathLen u8][path bytes]`                           |
| `0x14` | `LIST`       | `[dirLen u8][dir bytes]`                             |
| `0x20` | `APPLY`      | —                                                    |
| `0x21` | `NEXT_FACE`  | —                                                    |
| `0x22` | `SHOW_FACE`  | `[faceId u8]`                                        |
| `0x23` | `BLE_OFF`    | —                                                    |

Paths are absolute, UTF-8, and must start with `/photox4/`. The device rejects
anything else, along with any path containing `..`.

## Reply frames (device → client, `CTRL` notify)

    [0x80 | op u8][status u8][payload…]

`status` is `0x00` on success. Non-zero values:

| Code   | Meaning                                     |
| ------ | ------------------------------------------- |
| `0x01` | bad request (malformed frame, bad path)     |
| `0x02` | storage error (SD open/write/rename failed) |
| `0x03` | CRC or length mismatch                      |
| `0x04` | out of sequence (e.g. `FILE_END` with no open transfer) |
| `0x05` | out of space                                |
| `0x06` | unsupported opcode                          |

`HELLO` replies with:

    [proto u8][battery u8][flags u8][freeKiB u32][photoCount u16][chunkMax u16][epoch u32]

`proto` is `1`. `flags` bit 0 = clock has been set, bit 1 = BLE was enabled by a
long press (rather than an automatic sync window). `chunkMax` is the largest
`DATA` write the device will accept.

Two frames arrive unsolicited:

| Frame  | Payload                              | Meaning                               |
| ------ | ------------------------------------ | ------------------------------------- |
| `0xE0` | `[acked u32]`                        | credit: bytes durably consumed so far |
| `0xE1` | `[size u32][nameLen u8][name bytes]` | one `LIST` entry                      |

`LIST` streams `0xE1` entries and then completes with its ordinary `0x94` reply.

**Tag numbering is not free.** A reply is `0x80 | op` and opcodes run to `0x23`,
so `0x81`–`0xA3` is reserved for replies; unsolicited frames must sit above it.
These two originally used `0x90` and `0x94`, which are exactly the replies to
`FILE_BEGIN` and `LIST` — a client that checks for notifications first swallows
those completions and the command times out. Both ends carry an assertion
against the collision now.

## File transfer

1. Client sends `FILE_BEGIN` with the total size and CRC-32 (IEEE, the zlib
   polynomial) of the body, and waits for the reply. The device opens
   `<path>.part`.
2. Client writes the body to `DATA` in chunks of at most `chunkMax` bytes, in
   order, using write-without-response.
3. The device notifies `0x90 CREDIT` after every 4 KiB it has written to SD.
   The client never lets more than 8 KiB go unacknowledged — half the device's
   16 KiB receive ring. Without that window the controller silently drops writes
   and the transfer fails its CRC.
4. Client sends `FILE_END`. The device checks the received length and CRC, then
   renames `<path>.part` over `<path>`. A failed check leaves the existing file
   untouched and returns status `0x03`.

`FILE_ABORT` (or a disconnect) deletes the `.part` file.

## Typical sync

    HELLO → SET_TIME → LIST /photox4/photos
      → FILE_BEGIN/DATA/FILE_END  ×  (the JSON files, then any new photos)
      → DELETE  ×  (photos removed in the UI)
      → APPLY

`APPLY` makes the device re-read `config.json` and the content files, rebuild the
rotation, and repaint the current face. It does not advance the rotation.

## Files the device reads

    /photox4/config.json     rotation, interval, sync window, display options
    /photox4/weather.json    today's forecast
    /photox4/quotes.json     {"items": [{"t": text, "a": author}]}
    /photox4/words.json      {"items": [{"w","p","r","d","e"}]}
    /photox4/events.json     {"items": [{"t": title, "d": days since epoch}]}
    /photox4/history.json    {"items": [{"y": year, "t": text}]}
    /photox4/photos/*.jpg    photos, pre-cropped to the panel by the browser
    /photox4/cache/*.bmp     2-bit render cache, written by the device
    /photox4/state.json      rotation cursor, last sync (device-owned)

Each text face reads only its own file, so one failed fetch in the browser never
costs the others their content, and the device parses a few hundred bytes rather
than the whole day's payload.

`config.json` is also the switch that decides whether the device is a photo
frame at all: without it (or with `"enabled": false`) the firmware boots the
normal reader, and there is no Bluetooth to connect to. It has to arrive over
USB once — the web app's Device tab will hand you the file.

Event dates are sent as whole days since the Unix epoch, computed from the civil
date on both sides (`daysFromCivil`), so a countdown cannot be a day out because
of a timezone.

Photos arrive as JPEG because it is by far the cheapest thing to push over BLE.
The device converts each one to a 2-bit (4-level) BMP on first display, using
the same dithering path the firmware already uses for book covers, and caches
the result so later rotations are a straight blit.

# desk4

The web half of a desk companion for the [Xteink X4](https://www.xteink.com/products/xteink-x4):
a static page that talks to the e-ink device over Bluetooth and gives it
something to show — your photos, today's weather, a quote, a word, a countdown,
something that happened on this date.

**→ [dude-source-cpu.github.io/desk4](https://dude-source-cpu.github.io/desk4/)**

The device changes face every ten minutes and never shows a clock. That is the
point: it is meant to be glanced at, not consulted.

```
this page  ──── Web Bluetooth ────▶  X4 firmware  ────▶  SD card  ────▶  e-ink panel
```

## What it does

- **Photos** — drop them in, they are cropped to the 480 × 800 panel, tone-mapped,
  dithered to the four grey levels the display can hold, and sent as small JPEGs.
  The preview runs the *same* dithering algorithm the firmware does, so what you
  see here is what appears on the panel.
- **Faces** — choose which are in rotation and drag them into the order you want.
- **Weather** — from [Open-Meteo](https://open-meteo.com/), no account or API key.
- **Quotes and words** — a bundled set in `data/`, plus any you add yourself.
- **Countdowns** — days until the dates you care about.
- **On this day** — a historical entry from the [Wikimedia API](https://api.wikimedia.org/).

Nothing is stored server-side. Photos live in your browser's IndexedDB and
settings in localStorage; the page is only ever static files.

## Browser support

Syncing needs **Web Bluetooth**, which means Chrome, Edge, or Opera, on desktop
or Android. Safari and Firefox cannot talk to the device at all. If you are
running inside a VM, note that Bluetooth is usually not passed through — use the
host's browser.

Everything else — preparing photos, editing content, previewing faces — works in
any browser, so you can set things up anywhere and sync later.

## Using it

1. Flash the companion firmware to the X4 and put `config.json` on its SD card
   (the Device tab will hand you the file). Until that file exists the device
   boots as a normal e-reader and has no Bluetooth to connect to.
2. Hold the power button until the screen says Bluetooth is on.
3. Open the page, press **Connect**, pick the device, press **Sync**.

Leave the tab open and it will reconnect on its own during the short Bluetooth
window the device opens after every face change, so content keeps itself current
through the day.

### The buttons on the device

| Gesture                     | What happens                                          |
| --------------------------- | ----------------------------------------------------- |
| Short click on power        | Skip to the next face                                  |
| Hold power (~2 s)           | Bluetooth on — the screen says so and names the device |
| Hold power again            | Bluetooth off, back to the rotation                    |
| Hold a front button at wake | Boot the normal e-reader instead                       |

## Firmware

The device side is a fork of
[CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader), the
open-source replacement for Xteink's stock firmware, with a photo-frame mode
added alongside the reader. It is not published here yet — it lives in the local
workspace this repo was split out of.

[`docs/BLE-PROTOCOL.md`](docs/BLE-PROTOCOL.md) documents the wire format in full:
the GATT layout, every command, the credit-based flow control, and the files the
device expects on its SD card. It is the contract `js/ble.js` implements.

## Layout

```
index.html          the whole app
js/ble.js           Web Bluetooth transport and the wire protocol
js/render.js        crop, tone-map, dither — the photo pipeline
js/preview.js       face previews
js/weather.js       Open-Meteo client
js/content.js       payload builders for the device
js/store.js         settings and the photo queue
data/               bundled quotes and words
docs/               protocol documentation
tests/browser.mjs   loads the app in headless Chrome and asserts it works
```

## Running it locally

No build step, no dependencies:

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765/`. Web Bluetooth needs a secure context, and
`localhost` counts as one, so syncing works from a local server as well as from
the published site.

To run the browser test (needs a Chromium binary on PATH):

```bash
node tests/browser.mjs
```

## Licence

MIT.

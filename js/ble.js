// Web Bluetooth transport for the PhotoX4 firmware.
// Frame layout and opcodes are specified in docs/BLE-PROTOCOL.md.

export const SERVICE_UUID = '7a1f0000-4b3d-4c1e-9a2b-6d5e8f7c3a10';
export const CTRL_UUID    = '7a1f0001-4b3d-4c1e-9a2b-6d5e8f7c3a10';
export const DATA_UUID    = '7a1f0002-4b3d-4c1e-9a2b-6d5e8f7c3a10';

export const OP = {
  HELLO: 0x01, SET_TIME: 0x02,
  FILE_BEGIN: 0x10, FILE_END: 0x11, FILE_ABORT: 0x12, DELETE: 0x13, LIST: 0x14,
  APPLY: 0x20, NEXT_FACE: 0x21, SHOW_FACE: 0x22, BLE_OFF: 0x23,
};

const NOTIFY_CREDIT = 0x90;
const NOTIFY_LIST_ENTRY = 0x94;

const STATUS_TEXT = {
  0x01: 'bad request',
  0x02: 'storage error',
  0x03: 'checksum mismatch',
  0x04: 'out of sequence',
  0x05: 'out of space',
  0x06: 'unsupported command',
};

/**
 * Unacknowledged bytes allowed in flight before waiting for a credit. Half the
 * device's receive ring, so a burst that lands while the firmware is busy
 * repainting still has somewhere to go. The ring is small because the device
 * has very little heap to spare while Bluetooth is up.
 */
const CREDIT_WINDOW = 4 * 1024;
const COMMAND_TIMEOUT_MS = 12000;

// ── CRC-32 (IEEE, zlib polynomial) ──────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── small helpers ───────────────────────────────────────────────────────────

const enc = new TextEncoder();

function frame(op, parts = []) {
  let len = 1;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  out[0] = op;
  let o = 1;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u8  = v => Uint8Array.of(v & 0xff);
const i16 = v => { const a = new Uint8Array(2); new DataView(a.buffer).setInt16(0, v, true); return a; };
const u32 = v => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0, true); return a; };

function pathBytes(path) {
  const p = enc.encode(path);
  if (p.length > 255) throw new Error(`path too long: ${path}`);
  return [u8(p.length), p];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

// ── the link ────────────────────────────────────────────────────────────────

export class DeviceLink extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.ctrl = null;
    this.data = null;
    this.chunkMax = 180;         // conservative until HELLO reports the real value
    this.hello = null;
    this.autoReconnect = true;

    this._pending = null;        // { op, resolve, reject, timer }
    this._queue = Promise.resolve();
    this._listEntries = null;
    this._acked = 0;
    this._creditWaiters = [];
    this._reconnectTimer = null;
    this._reconnecting = false;
  }

  get connected() {
    return !!(this.server && this.server.connected);
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _log(msg, kind) { this._emit('log', { msg, kind }); }

  /** Ask the user to pick a device. Must be called from a user gesture. */
  async requestAndConnect() {
    if (!isSupported()) throw new Error('This browser has no Web Bluetooth.');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'PhotoX4' }],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    await this.connect();
  }

  /**
   * Reconnect to a device the page already has permission for. Chrome only
   * exposes getDevices() when the persistent-permissions backend is on, so a
   * failure here is normal and just means the user must press Connect.
   */
  async restorePreviousDevice() {
    if (!isSupported() || !navigator.bluetooth.getDevices) return false;
    let devices = [];
    try { devices = await navigator.bluetooth.getDevices(); } catch { return false; }
    const match = devices.find(d => (d.name || '').startsWith('PhotoX4'));
    if (!match) return false;
    this.device = match;
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    return true;
  }

  /**
   * Each stage is reported separately. A generic "connection failed" is useless
   * here, because the three realistic causes need three different fixes: the
   * device slept before pairing finished, the firmware is not the companion
   * build, or the radio dropped mid-handshake.
   */
  async connect() {
    if (!this.device) throw new Error('No device selected.');
    if (this.connected) return;

    const stage = async (label, what, hint) => {
      this._emit('state', { state: 'busy', label });
      try {
        return await what();
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        const failure = new Error(hint ? `${hint} (${detail})` : detail);
        failure.stage = label;
        throw failure;
      }
    };

    this.server = await stage(
      'Connecting…',
      () => this.device.gatt.connect(),
      'The device stopped responding. Its Bluetooth window is short — hold the power button until the screen says Bluetooth is on, then try again',
    );

    const service = await stage(
      'Finding service…',
      () => this.server.getPrimaryService(SERVICE_UUID),
      'Connected, but this device is not running the companion firmware',
    );

    this.ctrl = await stage('Opening channel…', () => service.getCharacteristic(CTRL_UUID));
    this.data = await stage('Opening channel…', () => service.getCharacteristic(DATA_UUID));

    await stage('Subscribing…', () => this.ctrl.startNotifications());
    this.ctrl.addEventListener('characteristicvaluechanged', e => this._onNotify(e.target.value));

    this.hello = await stage(
      'Saying hello…',
      () => this.sayHello(),
      'The device accepted the connection but never answered. It may have gone to sleep mid-handshake',
    );

    this._emit('state', { state: 'on', label: this.device.name || 'PhotoX4' });
    this._emit('hello', this.hello);
    this._log(`connected to ${this.device.name || 'PhotoX4'}`);
  }

  disconnect() {
    this.autoReconnect = false;
    clearTimeout(this._reconnectTimer);
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  _onDisconnected() {
    this.server = null;
    this.ctrl = this.data = null;
    if (this._pending) {
      this._pending.reject(new Error('disconnected'));
      clearTimeout(this._pending.timer);
      this._pending = null;
    }
    this._creditWaiters.forEach(w => w.reject(new Error('disconnected')));
    this._creditWaiters = [];
    this._emit('state', { state: 'off', label: 'Not connected' });
    this._log('disconnected');
    if (this.autoReconnect) this._scheduleReconnect();
  }

  /** Begin (or resume) the reconnect loop for an already-permitted device. */
  startReconnecting(delay = 1000) {
    this.autoReconnect = true;
    this._scheduleReconnect(delay);
  }

  /**
   * Retry gatt.connect() forever. The device only advertises during its sync
   * window or while a long press has Bluetooth switched on, so most attempts
   * fail immediately and cost nothing.
   */
  _scheduleReconnect(delay = 4000) {
    if (this._reconnecting || !this.device) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (!this.autoReconnect || this.connected) return;
      this._reconnecting = true;
      try {
        await this.connect();
      } catch {
        // The device is asleep. Try again shortly.
      } finally {
        this._reconnecting = false;
        if (this.autoReconnect && !this.connected) this._scheduleReconnect(delay);
      }
    }, delay);
  }

  // ── notifications ─────────────────────────────────────────────────────────

  _onNotify(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (!bytes.length) return;
    const tag = bytes[0];

    if (tag === NOTIFY_CREDIT) {
      if (bytes.length >= 5) {
        this._acked = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
        const waiters = this._creditWaiters;
        this._creditWaiters = [];
        waiters.forEach(w => w.resolve());
      }
      return;
    }

    if (tag === NOTIFY_LIST_ENTRY) {
      if (this._listEntries && bytes.length >= 6) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset);
        const size = dv.getUint32(1, true);
        const nameLen = bytes[5];
        const name = new TextDecoder().decode(bytes.subarray(6, 6 + nameLen));
        this._listEntries.push({ name, size });
      }
      return;
    }

    if (!(tag & 0x80)) return;                    // not a reply frame
    const op = tag & 0x7f;
    const p = this._pending;
    if (!p || p.op !== op) return;                // stale reply; ignore
    clearTimeout(p.timer);
    this._pending = null;
    const status = bytes.length > 1 ? bytes[1] : 0xff;
    if (status !== 0) {
      p.reject(new Error(`${STATUS_TEXT[status] || `error 0x${status.toString(16)}`} (op 0x${op.toString(16)})`));
    } else {
      p.resolve(bytes.subarray(2));
    }
  }

  // ── commands ──────────────────────────────────────────────────────────────

  /** Serialised so only one command is ever outstanding on CTRL. */
  _send(op, parts = []) {
    const run = async () => {
      if (!this.connected) throw new Error('not connected');
      const payload = frame(op, parts);
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this._pending && this._pending.op === op) {
            this._pending = null;
            reject(new Error(`timed out waiting for reply to 0x${op.toString(16)}`));
          }
        }, COMMAND_TIMEOUT_MS);
        this._pending = { op, resolve, reject, timer };
      });
      try {
        await this.ctrl.writeValueWithResponse(payload);
      } catch (err) {
        if (this._pending && this._pending.op === op) {
          clearTimeout(this._pending.timer);
          this._pending = null;
        }
        throw err;
      }
      return reply;
    };
    const next = this._queue.then(run, run);
    // Keep the chain alive after a rejection without swallowing it for the caller.
    this._queue = next.catch(() => {});
    return next;
  }

  async sayHello() {
    const r = await this._send(OP.HELLO);
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const hello = {
      proto: r[0],
      battery: r[1],
      clockSet: !!(r[2] & 0x01),
      manualBle: !!(r[2] & 0x02),
      freeKiB: dv.getUint32(3, true),
      photoCount: dv.getUint16(7, true),
      chunkMax: dv.getUint16(9, true),
      epoch: dv.getUint32(11, true),
    };
    if (hello.chunkMax >= 20 && hello.chunkMax <= 512) this.chunkMax = hello.chunkMax;
    return hello;
  }

  setTime(date = new Date()) {
    const epoch = Math.floor(date.getTime() / 1000);
    const tz = -date.getTimezoneOffset();          // minutes east of UTC
    return this._send(OP.SET_TIME, [u32(epoch), i16(tz)]);
  }

  async list(dir) {
    this._listEntries = [];
    try {
      await this._send(OP.LIST, pathBytes(dir));
      return this._listEntries;                    // reference captured before the reset below
    } finally {
      this._listEntries = null;
    }
  }

  remove(path) { return this._send(OP.DELETE, pathBytes(path)); }
  apply()      { return this._send(OP.APPLY); }
  nextFace()   { return this._send(OP.NEXT_FACE); }
  showFace(id) { return this._send(OP.SHOW_FACE, [u8(id)]); }
  bleOff()     { return this._send(OP.BLE_OFF); }

  // ── file upload ───────────────────────────────────────────────────────────

  _awaitCredit(sent) {
    if (sent - this._acked <= CREDIT_WINDOW) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(waiter.timer); resolve(); },
        reject: err => { clearTimeout(waiter.timer); reject(err); },
      };
      waiter.timer = setTimeout(() => {
        this._creditWaiters = this._creditWaiters.filter(w => w !== waiter);
        reject(new Error('device stopped acknowledging data'));
      }, COMMAND_TIMEOUT_MS);
      this._creditWaiters.push(waiter);
    });
  }

  /**
   * Push one file. `onProgress(sent, total)` fires as chunks land.
   * DATA uses write-without-response for speed; the device's credit
   * notifications keep us from overrunning its receive buffer.
   */
  async sendFile(path, bytes, onProgress) {
    if (!this.connected) throw new Error('not connected');
    this._acked = 0;
    await this._send(OP.FILE_BEGIN, [u32(bytes.length), u32(crc32(bytes)), ...pathBytes(path)]);

    try {
      const chunk = this.chunkMax;
      for (let off = 0; off < bytes.length; off += chunk) {
        await this._awaitCredit(off);
        const slice = bytes.subarray(off, Math.min(off + chunk, bytes.length));
        await this.data.writeValueWithoutResponse(slice);
        if (onProgress) onProgress(Math.min(off + chunk, bytes.length), bytes.length);
      }
      // Let the last writes drain out of the controller before asking for the CRC.
      await sleep(60);
      await this._send(OP.FILE_END);
    } catch (err) {
      try { await this._send(OP.FILE_ABORT); } catch { /* already gone */ }
      throw err;
    }
  }

  sendJSON(path, obj, onProgress) {
    return this.sendFile(path, enc.encode(JSON.stringify(obj)), onProgress);
  }
}

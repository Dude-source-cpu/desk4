import { DeviceLink, isSupported, crc32 } from './ble.js';
import { processPhoto, paintLevels, dither4, panelSize } from './render.js';
import * as store from './store.js';
import * as content from './content.js';
import * as weather from './weather.js';
import * as preview from './preview.js';
import { Wizard } from './wizard.js';

const $ = id => document.getElementById(id);

const link = new DeviceLink();
let settings = store.loadSettings();
let photos = [];
let forecast = null;
let history = null;
let previewIndex = 0;
let busy = false;
let wizard = null;

// ── logging ─────────────────────────────────────────────────────────────────

function log(message, kind) {
  const el = $('log');
  const line = document.createElement('div');
  if (kind === 'error') line.className = 'e';
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `${stamp}  ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.childElementCount > 200) el.removeChild(el.firstChild);
}

// ── settings plumbing ───────────────────────────────────────────────────────

function save() {
  store.saveSettings(settings);
}

function enabledFaces() {
  return settings.faces.filter(f => f.on).map(f => f.id);
}

function bindControl(id, key, { parse = v => v, apply = null } = {}) {
  const el = $(id);
  const isCheck = el.type === 'checkbox';
  if (isCheck) el.checked = !!settings[key];
  else el.value = settings[key];

  el.addEventListener('change', () => {
    settings[key] = isCheck ? el.checked : parse(el.value);
    save();
    if (apply) apply();
  });
}

// ── faces tab ───────────────────────────────────────────────────────────────

let dragId = null;

function renderFaceList() {
  const list = $('faceList');
  list.textContent = '';

  for (const entry of settings.faces) {
    const meta = store.faceMeta(entry.id);
    const li = document.createElement('li');
    li.className = `face-item${entry.on ? '' : ' is-off'}`;
    li.draggable = true;
    li.dataset.id = entry.id;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⠿';
    grip.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'face-body';
    const name = document.createElement('div');
    name.className = 'face-name';
    name.textContent = meta.name;
    const desc = document.createElement('div');
    desc.className = 'face-desc';
    desc.textContent = meta.desc;
    body.append(name, desc);

    const warning = faceWarning(entry.id);
    if (entry.on && warning) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = warning;
      body.appendChild(warn);
    }

    const switchWrap = document.createElement('label');
    switchWrap.className = 'switch';
    switchWrap.title = `Show the ${meta.name} screen`;
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = entry.on;
    toggle.setAttribute('aria-label', `Show the ${meta.name} screen`);
    const track = document.createElement('span');
    track.className = 'track';
    switchWrap.append(toggle, track);
    toggle.addEventListener('change', () => {
      entry.on = toggle.checked;
      save();
      renderFaceList();
      previewIndex = 0;
      drawPreview();
    });

    li.append(grip, body, switchWrap);

    li.addEventListener('dragstart', () => {
      dragId = entry.id;
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      dragId = null;
      li.classList.remove('is-dragging');
      list.querySelectorAll('.face-item').forEach(el => el.classList.remove('is-over'));
    });
    li.addEventListener('dragover', event => {
      event.preventDefault();
      if (dragId && dragId !== entry.id) li.classList.add('is-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('is-over'));
    li.addEventListener('drop', event => {
      event.preventDefault();
      if (!dragId || dragId === entry.id) return;
      const from = settings.faces.findIndex(f => f.id === dragId);
      const to = settings.faces.findIndex(f => f.id === entry.id);
      const [moved] = settings.faces.splice(from, 1);
      settings.faces.splice(to, 0, moved);
      save();
      renderFaceList();
    });

    list.appendChild(li);
  }
}

function faceWarning(id) {
  if (id === 'photo' && photos.length === 0) return 'Add some photos and this will fill up.';
  if (id === 'weather' && !settings.place) return 'Set your location first, or this gets skipped.';
  if (id === 'countdown' && (!settings.events || settings.events.length === 0)) return 'Add a date to count down to.';
  if (id === 'history' && !settings.onThisDay) return 'Turn the Wikipedia lookup back on to use this.';
  return null;
}

// ── photos tab ──────────────────────────────────────────────────────────────

function thumbFromLevels(levels) {
  const { w, h } = panelSize(settings.orientation);
  const full = document.createElement('canvas');
  paintLevels(full, levels, w, h);
  const thumb = document.createElement('canvas');
  const scale = 160 / Math.max(w, h);
  thumb.width = Math.round(w * scale);
  thumb.height = Math.round(h * scale);
  const ctx = thumb.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/png');
}

function photoOpts() {
  return { ...settings.photoOpts, orientation: settings.orientation };
}

async function ingest(file) {
  const { jpeg, levels } = await processPhoto(file, photoOpts());
  return {
    id: crypto.randomUUID(),
    name: file.name,
    addedAt: Date.now(),
    original: file,
    jpeg: jpeg.buffer,
    deviceName: `${crc32(jpeg).toString(16).padStart(8, '0')}.jpg`,
    thumb: thumbFromLevels(levels),
    bytes: jpeg.length,
  };
}

async function addFiles(files) {
  const images = [...files].filter(f => f.type.startsWith('image/'));
  if (!images.length) return;

  setBusy(true, `Preparing ${images.length} photo${images.length === 1 ? '' : 's'}…`);
  let added = 0;
  for (const file of images) {
    try {
      const record = await ingest(file);
      await store.putPhoto(record);
      added++;
      setProgress(added, images.length, `Prepared ${added} of ${images.length}`);
    } catch (err) {
      log(`could not read ${file.name}: ${err.message}`, 'error');
    }
  }
  await refreshPhotos();
  setBusy(false);
  log(`${added} photo${added === 1 ? '' : 's'} ready to send`);
}

async function reprocessAll() {
  if (!photos.length) return;
  setBusy(true, 'Re-applying settings…');
  let done = 0;
  for (const photo of photos) {
    if (!photo.original) continue;
    try {
      const { jpeg, levels } = await processPhoto(photo.original, photoOpts());
      await store.putPhoto({
        ...photo,
        jpeg: jpeg.buffer,
        deviceName: `${crc32(jpeg).toString(16).padStart(8, '0')}.jpg`,
        thumb: thumbFromLevels(levels),
        bytes: jpeg.length,
      });
    } catch (err) {
      log(`could not reprocess ${photo.name}: ${err.message}`, 'error');
    }
    done++;
    setProgress(done, photos.length, `Reprocessed ${done} of ${photos.length}`);
  }
  await refreshPhotos();
  setBusy(false);
}

async function refreshPhotos() {
  photos = await store.listPhotos();
  $('photoCount').textContent = String(photos.length);

  const grid = $('photoGrid');
  grid.textContent = '';
  for (const photo of photos) {
    const li = document.createElement('li');
    li.className = 'photo-item';

    const img = document.createElement('img');
    img.src = photo.thumb;
    img.alt = photo.name;
    img.style.width = '100%';
    img.style.aspectRatio = '480 / 800';
    img.style.borderRadius = '6px';
    img.style.border = '1px solid var(--rule)';
    img.style.display = 'block';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${Math.round(photo.bytes / 1024)} KB`;

    const remove = document.createElement('button');
    remove.className = 'rm';
    remove.title = `Remove ${photo.name}`;
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      await store.deletePhoto(photo.id);
      await refreshPhotos();
      drawPreview();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = photo.name;

    li.append(img, badge, remove, meta);
    grid.appendChild(li);
  }

  renderFaceList();
}

// ── content tab ─────────────────────────────────────────────────────────────

async function renderQuotes() {
  const pool = settings.quotes && settings.quotes.length ? settings.quotes : await content.builtInQuotes();
  $('quoteCount').textContent = settings.quotes
    ? `${settings.quotes.length} of your own.`
    : `${pool.length} built in.`;

  const list = $('quoteList');
  list.textContent = '';
  if (!settings.quotes) return; // the bundled set is not editable

  settings.quotes.forEach((quote, index) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = quote.text;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = quote.author || '';
    const remove = document.createElement('button');
    remove.className = 'rm';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      settings.quotes.splice(index, 1);
      if (!settings.quotes.length) settings.quotes = null;
      save();
      renderQuotes();
      drawPreview();
    });
    li.append(span, who, remove);
    list.appendChild(li);
  });
}

function renderEvents() {
  const list = $('eventList');
  list.textContent = '';
  const today = content.epochDay(new Date());

  for (const [index, event] of (settings.events || []).entries()) {
    const [y, m, d] = event.date.split('-').map(Number);
    const days = content.daysFromCivil(y, m, d) - today;

    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = event.title;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = days < 0 ? 'past' : days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`;
    const remove = document.createElement('button');
    remove.className = 'rm';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      settings.events.splice(index, 1);
      save();
      renderEvents();
      renderFaceList();
      drawPreview();
    });
    li.append(span, who, remove);
    list.appendChild(li);
  }
}

function renderPlace() {
  $('placeCurrent').textContent = settings.place
    ? `Forecast for ${settings.place.label}`
    : 'No location set — the weather face will be skipped.';
  $('btnRefreshWeather').disabled = !settings.place;
}

async function refreshForecast() {
  if (!settings.place) return;
  try {
    forecast = await weather.fetchForecast(settings.place, settings.unit);
    log(`forecast updated for ${forecast.place}`);
    drawPreview();
  } catch (err) {
    log(`forecast failed: ${err.message}`, 'error');
  }
}

async function refreshHistory() {
  if (!settings.onThisDay) {
    history = null;
    return;
  }
  try {
    history = await content.onThisDay();
    log(`on this day: ${history.length} entries`);
  } catch (err) {
    history = null;
    log(`on this day failed: ${err.message}`, 'error');
  }
}

// ── preview ─────────────────────────────────────────────────────────────────

async function drawPreview() {
  const canvas = $('preview');
  const orientation = settings.orientation || 'portrait';
  $('deviceFrame').classList.toggle('is-landscape', orientation === 'landscape');

  const faces = enabledFaces();
  if (!faces.length) {
    preview.drawMessage(canvas, 'No faces on', 'Turn at least one on in the Faces tab.', null, orientation);
    $('previewLabel').textContent = '—';
    return;
  }

  previewIndex = ((previewIndex % faces.length) + faces.length) % faces.length;
  const id = faces[previewIndex];
  $('previewLabel').textContent = store.faceMeta(id).name;

  switch (id) {
    case 'photo': {
      if (!photos.length) {
        preview.drawMessage(canvas, 'No photos yet', 'Drop a few on the Photos tab.', null, orientation);
        break;
      }
      const { w, h } = panelSize(orientation);
      const photo = photos[0];
      const bitmap = await createImageBitmap(new Blob([photo.jpeg], { type: 'image/jpeg' }));
      const scratch = document.createElement('canvas');
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      const pixels = ctx.getImageData(0, 0, w, h).data;
      const gray = new Uint8ClampedArray(w * h);
      for (let i = 0, g = 0; i < pixels.length; i += 4, g++) gray[g] = pixels[i];
      preview.drawPhoto(canvas, dither4(gray, w, h), orientation);
      break;
    }
    case 'weather':
      preview.drawWeather(canvas, forecast, settings.showSunTimes, orientation);
      break;
    case 'quote': {
      const pool = settings.quotes && settings.quotes.length ? settings.quotes : await content.builtInQuotes();
      preview.drawQuote(canvas, pool[Math.floor(Date.now() / 60000) % pool.length], orientation);
      break;
    }
    case 'word': {
      const pool = await content.builtInWords();
      preview.drawWord(canvas, pool[Math.floor(Date.now() / 60000) % pool.length], orientation);
      break;
    }
    case 'countdown': {
      const today = content.epochDay(new Date());
      const items = (settings.events || [])
        .map(e => {
          const [y, m, d] = e.date.split('-').map(Number);
          return { title: e.title, days: content.daysFromCivil(y, m, d) - today };
        })
        .filter(e => e.days >= 0)
        .sort((a, b) => a.days - b.days);
      preview.drawCountdown(canvas, items, orientation);
      break;
    }
    case 'history':
      preview.drawHistory(canvas, history ? history[0] : null, orientation);
      break;
  }
}

// ── device ──────────────────────────────────────────────────────────────────

function setBusy(state, message) {
  busy = state;
  $('progressWrap').hidden = !state;
  if (message) $('progressText').textContent = message;
  if (!state) $('progressBar').style.width = '0%';
  updateButtons();
}

function setProgress(done, total, message) {
  $('progressBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  if (message) $('progressText').textContent = message;
}

function updateButtons() {
  const connected = link.connected;
  $('btnConnect').hidden = connected;
  $('btnDisconnect').hidden = !connected;
  $('btnSync').disabled = !connected || busy;
  $('btnNextFace').disabled = !connected || busy;
  $('btnBleOff').disabled = !connected || busy;
}

/** Human-readable "5 minutes ago" style, falling back to a date after a day. */
function agoText(timestamp) {
  if (!timestamp) return 'Never';
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(timestamp).toLocaleDateString();
}

function showStatus(hello) {
  const gb = hello.freeKiB / 1024 / 1024;
  $('stBattery').textContent = `${hello.battery}%`;
  $('stFree').textContent = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(hello.freeKiB / 1024)} MB`;
  $('stPhotos').textContent = hello.photoCount === 1 ? '1 photo' : `${hello.photoCount} photos`;
  $('stClock').textContent = hello.clockSet ? new Date(hello.epoch * 1000).toLocaleString() : 'not set';
  $('stProto').textContent = `protocol v${hello.proto}`;
  $('stSync').textContent = agoText(settings.lastSync);
}

async function sync() {
  if (!link.connected || busy) return;
  setBusy(true, 'Starting…');

  try {
    // Fresh content first: a sync is only worth doing with today's data in it.
    if (settings.place) await refreshForecast();
    await refreshHistory();

    await link.setTime();
    log('clock set');

    const seed = content.epochDay(new Date());
    const files = [
      ['/photox4/config.json', content.buildConfig(settings)],
      ['/photox4/quotes.json', await content.buildQuotes(settings, seed)],
      ['/photox4/words.json', await content.buildWords(seed)],
      ['/photox4/events.json', content.buildEvents(settings)],
      ['/photox4/history.json', content.buildHistory(history)],
    ];
    const weatherPayload = content.buildWeather(forecast);
    if (weatherPayload) files.push(['/photox4/weather.json', weatherPayload]);

    // Reconcile photos before uploading anything, so a queue that has not
    // changed costs one LIST and nothing else.
    const onDevice = await link.list('/photox4/photos');
    const deviceNames = new Set(onDevice.map(entry => entry.name));
    const wanted = new Map(photos.map(p => [p.deviceName, p]));

    const toUpload = photos.filter(p => !deviceNames.has(p.deviceName));
    const toDelete = [...deviceNames].filter(name => !wanted.has(name));

    const totalSteps = files.length + toUpload.length + toDelete.length;
    let step = 0;

    for (const [path, payload] of files) {
      setProgress(step, totalSteps, `Sending ${path.split('/').pop()}`);
      await link.sendJSON(path, payload);
      step++;
    }

    for (const name of toDelete) {
      setProgress(step, totalSteps, `Removing ${name}`);
      await link.remove(`/photox4/photos/${name}`);
      step++;
      log(`removed ${name} from the card`);
    }

    for (const photo of toUpload) {
      const bytes = new Uint8Array(photo.jpeg);
      await link.sendFile(`/photox4/photos/${photo.deviceName}`, bytes, sent => {
        const within = sent / bytes.length;
        setProgress(step + within, totalSteps, `Sending ${photo.name} — ${Math.round(within * 100)}%`);
      });
      step++;
      log(`sent ${photo.name} (${Math.round(bytes.length / 1024)} KB)`);
    }

    await link.apply();
    settings.lastSync = Date.now();
    save();
    setProgress(totalSteps, totalSteps, 'Done');

    const hello = await link.sayHello();
    showStatus(hello);
    log(`sync complete — ${toUpload.length} sent, ${toDelete.length} removed`);
  } catch (err) {
    log(`sync failed: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────

function goToPanel(name) {
  document.querySelectorAll('.tab, .bottom-tab').forEach(tab => {
    tab.classList.toggle('is-active', tab.dataset.panel === name);
  });
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireTabs() {
  document.querySelectorAll('.tab, .bottom-tab').forEach(tab => {
    tab.addEventListener('click', () => goToPanel(tab.dataset.panel));
  });
}

/** A one-line, actionable nudge under the header. */
function showHint(text, actionLabel, action) {
  $('hintText').textContent = text;
  const button = $('hintAction');
  if (actionLabel) {
    button.textContent = actionLabel;
    button.hidden = false;
    button.onclick = action;
  } else {
    button.hidden = true;
  }
  $('hint').hidden = false;
}

function hideHint() {
  $('hint').hidden = true;
}

function wireOrientation() {
  const buttons = [...document.querySelectorAll('.seg-btn')];
  const paint = () => {
    buttons.forEach(button => {
      const on = button.dataset.orientation === settings.orientation;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-checked', String(on));
    });
  };
  paint();

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      if (button.dataset.orientation === settings.orientation) return;
      settings.orientation = button.dataset.orientation;
      save();
      paint();
      await drawPreview();
      if (photos.length) {
        showHint(
          'Your photos were cropped for the other orientation. Want them redone to fit?',
          'Redo them',
          async () => {
            hideHint();
            await reprocessAll();
          },
        );
      }
    });
  }
}

/**
 * Connect, and turn a failure into something the user can act on. The common
 * one by far is the device's Bluetooth window closing mid-pairing, which reads
 * as a generic GATT error unless it is explained.
 */
async function connect() {
  hideHint();
  try {
    link.autoReconnect = $('optAutoReconnect').checked;
    await link.requestAndConnect();
    hideHint();
  } catch (err) {
    if (err.name === 'NotFoundError') return; // the picker was dismissed
    log(`connect failed: ${err.message}`, 'error');
    $('connPill').dataset.state = 'err';
    $('connLabel').textContent = 'Connection failed';
    showHint(
      'Couldn’t finish connecting. Hold the power button on the frame for two seconds until it says Bluetooth is on, then try again.',
      'Show me how',
      () => wizard.open(3),
    );
    throw err;
  }
}

function wireDevice() {
  link.addEventListener('log', event => log(event.detail.msg, event.detail.kind));
  link.addEventListener('state', event => {
    $('connPill').dataset.state = event.detail.state;
    $('connLabel').textContent = event.detail.label;
    updateButtons();
  });
  link.addEventListener('hello', event => {
    showStatus(event.detail);
    hideHint();
  });

  $('btnConnect').addEventListener('click', () => connect());
  $('btnDisconnect').addEventListener('click', () => link.disconnect());
  $('btnSync').addEventListener('click', sync);
  $('btnNextFace').addEventListener('click', () => link.nextFace().catch(err => log(err.message, 'error')));
  $('btnBleOff').addEventListener('click', () => link.bleOff().catch(err => log(err.message, 'error')));
  $('optAutoReconnect').addEventListener('change', event => {
    link.autoReconnect = event.target.checked;
    if (event.target.checked && !link.connected) link.startReconnecting();
  });
}

function wirePhotos() {
  const dropzone = $('dropzone');
  const input = $('fileInput');

  $('btnPick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach(type =>
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    }),
  );
  ['dragleave', 'drop'].forEach(type =>
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.remove('is-over');
    }),
  );
  dropzone.addEventListener('drop', event => addFiles(event.dataTransfer.files));

  const opts = settings.photoOpts;
  const sliders = [
    ['optFit', 'fit', v => v, null],
    ['optBright', 'bright', Number, 'outBright'],
    ['optContrast', 'contrast', Number, 'outContrast'],
    ['optQuality', 'quality', Number, 'outQuality'],
  ];
  for (const [id, key, parse, outId] of sliders) {
    const el = $(id);
    el.value = opts[key];
    const out = outId ? $(outId) : null;
    if (out) out.textContent = opts[key];
    el.addEventListener('input', () => {
      opts[key] = parse(el.value);
      if (out) out.textContent = opts[key];
      save();
    });
  }

  $('btnReprocess').addEventListener('click', reprocessAll);
  $('btnClearPhotos').addEventListener('click', async () => {
    if (!confirm('Remove every photo? They will also come off the frame the next time you send.')) return;
    await store.clearPhotos();
    await refreshPhotos();
    drawPreview();
  });
}

function wireContent() {
  $('btnPlaceSearch').addEventListener('click', async () => {
    const query = $('placeInput').value.trim();
    if (!query) return;
    const results = $('placeResults');
    results.textContent = '';
    results.hidden = false;
    try {
      const places = await weather.searchPlaces(query);
      if (!places.length) {
        results.hidden = true;
        log('no places matched that search', 'error');
        return;
      }
      for (const place of places) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = place.label;
        button.addEventListener('click', async () => {
          settings.place = place;
          save();
          results.hidden = true;
          renderPlace();
          renderFaceList();
          await refreshForecast();
        });
        li.appendChild(button);
        results.appendChild(li);
      }
    } catch (err) {
      results.hidden = true;
      log(`place search failed: ${err.message}`, 'error');
    }
  });

  $('btnGeo').addEventListener('click', () => {
    if (!navigator.geolocation) return log('this browser has no geolocation', 'error');
    navigator.geolocation.getCurrentPosition(
      async position => {
        const { latitude: lat, longitude: lon } = position.coords;
        const name = await weather.reverseName(lat, lon);
        settings.place = { name, label: name, lat, lon };
        save();
        renderPlace();
        renderFaceList();
        await refreshForecast();
      },
      err => log(`location failed: ${err.message}`, 'error'),
    );
  });

  $('btnRefreshWeather').addEventListener('click', refreshForecast);

  $('btnAddQuote').addEventListener('click', () => {
    const raw = $('quoteInput').value.trim();
    if (!raw) return;
    // "Quote text" then an optional attribution line starting with a dash.
    const lines = raw.split('\n');
    const attribution = lines.length > 1 && /^[—–-]/.test(lines[lines.length - 1].trim())
      ? lines.pop().trim().replace(/^[—–-]\s*/, '')
      : '';
    if (!settings.quotes) settings.quotes = [];
    settings.quotes.push({ text: lines.join(' ').trim(), author: attribution });
    save();
    $('quoteInput').value = '';
    renderQuotes();
    drawPreview();
  });

  $('btnResetQuotes').addEventListener('click', () => {
    settings.quotes = null;
    save();
    renderQuotes();
    drawPreview();
  });

  $('btnAddEvent').addEventListener('click', () => {
    const title = $('eventTitle').value.trim();
    const date = $('eventDate').value;
    if (!title || !date) return;
    settings.events = settings.events || [];
    settings.events.push({ title, date });
    settings.events.sort((a, b) => a.date.localeCompare(b.date));
    save();
    $('eventTitle').value = '';
    $('eventDate').value = '';
    renderEvents();
    renderFaceList();
    drawPreview();
  });
}

function downloadConfig() {
  const payload = JSON.stringify(content.buildConfig(settings), null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'config.json';
  anchor.click();
  URL.revokeObjectURL(url);
  log('config.json downloaded — copy it to /photox4/ on the SD card');
}

function wireSetup() {
  $('btnWizard').addEventListener('click', () => wizard.open(0));
  $('btnStarterConfig').addEventListener('click', () => {
    downloadConfig();
  });
}

function wirePreview() {
  $('btnPrevPreview').addEventListener('click', () => {
    previewIndex--;
    drawPreview();
  });
  $('btnNextPreview').addEventListener('click', () => {
    previewIndex++;
    drawPreview();
  });
}

async function main() {
  wireTabs();
  wireDevice();
  wirePhotos();
  wireContent();
  wireSetup();
  wirePreview();

  wizard = new Wizard({
    connect,
    isConnected: () => link.connected,
    downloadConfig,
    sync,
    goToPanel,
  });
  wireOrientation();

  bindControl('optInterval', 'interval', { parse: Number });
  bindControl('optSyncWindow', 'syncWindow', { parse: Number });
  bindControl('optShuffle', 'shuffle');
  bindControl('optSunTimes', 'showSunTimes', { apply: drawPreview });
  bindControl('optBatteryWarn', 'batteryWarn');
  bindControl('optUnit', 'unit', { apply: refreshForecast });
  bindControl('optOnThisDay', 'onThisDay', { apply: () => renderFaceList() });

  $('unsupported').hidden = isSupported();
  updateButtons();

  await refreshPhotos();
  renderFaceList();
  renderPlace();
  renderEvents();
  await renderQuotes();

  if (settings.place) await refreshForecast();
  await refreshHistory();
  await drawPreview();

  // A device this page already has permission for can be reconnected without a
  // fresh prompt, which is what lets an open tab catch the device's own sync
  // window. Chrome only exposes that with persistent permissions enabled.
  if (!Wizard.hasRun()) wizard.open(0);

  if (await link.restorePreviousDevice()) {
    log('found a previously paired device — waiting for it to advertise');
    if ($('optAutoReconnect').checked) link.startReconnecting();
  }
}

main().catch(err => log(`startup failed: ${err.message}`, 'error'));

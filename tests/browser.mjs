// Loads the web app in headless Chrome and reports console errors plus a few
// DOM assertions, so a broken module or a null element is caught here rather
// than in front of the device.
//
//   node tests/browser.mjs [url]

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] || 'http://localhost:8765/';

const profile = mkdtempSync(join(tmpdir(), 'photox4-chrome-'));
const chrome = spawn(
  'google-chrome-stable',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    // Port 0 lets the OS pick, and Chrome writes the real port into the profile
    // directory. A fixed port meant that a run which crashed before cleanup left
    // a browser holding it, and the next run silently attached to that stale
    // browser — with its localStorage already written, so first-visit checks
    // failed for reasons that had nothing to do with the code under test.
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Reads the port Chrome actually bound, from the file it writes on startup. */
async function debuggingPort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (port && Number(port) > 0) return Number(port);
    } catch {
      // Chrome has not written it yet.
    }
    await sleep(100);
  }
  throw new Error('Chrome never reported a debugging port');
}

const PORT = await debuggingPort();

async function target() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page');
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error('Chrome did not expose a debugging target');
}

async function cleanup(code) {
  chrome.kill('SIGTERM');
  // Chrome flushes its profile on the way out; removing it too early throws.
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp profile is not worth failing the run over.
  }
  process.exit(code);
}

// A thrown assertion or a failed evaluate must still take the browser with it,
// or the next run inherits a half-used one.
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, err => {
    console.error(err);
    chrome.kill('SIGKILL');
    process.exit(1);
  });
}
process.on('SIGINT', () => cleanup(1));

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const problems = [];

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    problems.push(`console.error: ${message.params.args.map(a => a.value ?? a.description).join(' ')}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    problems.push(`uncaught: ${details.exception?.description || details.text}`);
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    problems.push(`log: ${message.params.entry.text} (${message.params.entry.url || ''})`);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise(resolve => pending.set(id, resolve));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description || 'evaluation failed');
  }
  return result.result?.result?.value;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_UNDER_TEST });

// Give the module graph, the bundled JSON, and the first preview paint time to
// settle. Network content (weather, Wikipedia) is not required to pass.
await sleep(5000);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok    ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const faceCount = await evaluate('document.querySelectorAll(".face-item").length');
check('face list rendered', faceCount === 6, `found ${faceCount}`);

const previewLabel = await evaluate('document.getElementById("previewLabel").textContent');
check('preview shows a face name', previewLabel && previewLabel !== '—', `label is "${previewLabel}"`);

const painted = await evaluate(`(() => {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 200) ink++;
  return ink;
})()`);
check('preview canvas has content', painted > 500, `${painted} dark pixels`);

const quoteText = await evaluate('document.getElementById("quoteCount").textContent');
check('bundled quotes loaded', /\d+/.test(quoteText || ''), `text is "${quoteText}"`);

const tabsWork = await evaluate(`(() => {
  document.querySelectorAll('.tab')[2].click();
  return document.querySelector('.panel[data-panel="photos"]').classList.contains('is-active');
})()`);
check('tabs switch panels', tabsWork === true);

const configJson = await evaluate(`(async () => {
  const content = await import('./js/content.js');
  const store = await import('./js/store.js');
  return JSON.stringify(content.buildConfig(store.loadSettings()));
})()`);
check('config payload builds', !!configJson && configJson.includes('"rotation"'), configJson);

// ── desktop layout ──────────────────────────────────────────────────────────

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);

const desktop = await evaluate(`(() => {
  const shell = getComputedStyle(document.querySelector('.shell'));
  return {
    columns: shell.gridTemplateColumns.split(' ').length,
    overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    previewVisible: document.querySelector('.preview-card').getBoundingClientRect().width > 0,
  };
})()`);
check('desktop lays out rail, content and preview', desktop.columns === 3, JSON.stringify(desktop));
check('desktop keeps the preview on screen', desktop.previewVisible === true);
check('desktop does not scroll sideways', desktop.overflows === false);

await send('Emulation.clearDeviceMetricsOverride');
await sleep(200);

// ── setup wizard ────────────────────────────────────────────────────────────

/** True when the element is actually painted, not merely lacking [hidden]. */
const VISIBLE = id => `(() => {
  const el = document.getElementById('${id}');
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return getComputedStyle(el).display !== 'none' && box.width > 0 && box.height > 0;
})()`;

const wizardOpen = await evaluate(VISIBLE('wizard'));
check('wizard opens on a first visit', wizardOpen === true);

const wizardTitle = await evaluate('document.getElementById("wizTitle").textContent');
check('wizard shows its first step', !!wizardTitle, `title is "${wizardTitle}"`);

const wizardAdvanced = await evaluate(`(() => {
  document.getElementById('wizNext').click();
  return document.getElementById('wizStep').textContent;
})()`);
check('wizard advances', /Step 2 of/.test(wizardAdvanced || ''), wizardAdvanced);

// Checked by what is on screen: setting .hidden used to report success while
// .wizard{display:flex} kept the dialog visible, which is how a wizard nobody
// could dismiss passed its own test.
await evaluate(`document.getElementById('wizClose').click()`);
check('X really hides the wizard', (await evaluate(VISIBLE('wizard'))) === false);

await evaluate(`window.__wiz = document.getElementById('wizard'); __wiz.hidden = false;`);
await evaluate(`document.getElementById('wizSkip').click()`);
check('Skip setup really hides the wizard', (await evaluate(VISIBLE('wizard'))) === false);

await evaluate(`document.getElementById('wizard').hidden = false;`);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
check('Escape really hides the wizard', (await evaluate(VISIBLE('wizard'))) === false);

await evaluate(`document.getElementById('wizard').hidden = false;`);
await evaluate(`(() => {
  const next = document.getElementById('wizNext');
  for (let i = 0; i < 8; i++) next.click();
})()`);
check('Finish really hides the wizard', (await evaluate(VISIBLE('wizard'))) === false);

// The wizard footer must stay reachable on a short screen. A flex child with
// overflow-y:auto and no min-height:0 refuses to shrink and pushes the
// Back/Next row out of the sheet, which strands people on the last step.
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 2, mobile: true });
await sleep(300);

const footerReach = await evaluate(`(() => {
  const w = document.getElementById('wizard');
  w.hidden = false;
  const next = document.getElementById('wizNext');
  // Stop ON the last step: one more click is Finish, which closes the dialog
  // and would measure a hidden button.
  while (next.textContent !== 'Finish') next.click();
  const box = next.getBoundingClientRect();
  const visible = box.bottom <= window.innerHeight + 1 && box.top >= 0 && box.height > 0;
  document.getElementById('wizard').hidden = true;
  return { visible, bottom: Math.round(box.bottom), viewport: window.innerHeight };
})()`);
check('wizard footer stays on screen when short', footerReach.visible === true, JSON.stringify(footerReach));

await send('Emulation.clearDeviceMetricsOverride');
await sleep(200);

// Dismissing must survive a localStorage that throws: every exit route (X,
// backdrop, Finish, Escape) funnels through close(), so one exception there
// used to trap people in the dialog with no way out.
const closeSurvives = await evaluate(`(() => {
  const real = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new DOMException('blocked', 'QuotaExceededError'); };
  const results = {};
  const gone = el => getComputedStyle(el).display === 'none';
  try {
    const w = document.getElementById('wizard');
    w.hidden = false;
    document.getElementById('wizClose').click();
    results.viaClose = gone(w);

    w.hidden = false;
    document.getElementById('wizSkip').click();
    results.viaSkip = gone(w);

    w.hidden = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    results.viaEscape = gone(w);
  } catch (err) {
    results.threw = String(err);
  } finally {
    Storage.prototype.setItem = real;
  }
  return results;
})()`);
check('wizard closes even when storage throws', 
      closeSurvives.viaClose === true && closeSurvives.viaSkip === true && closeSurvives.viaEscape === true,
      JSON.stringify(closeSurvives));

// Everything else the app hides at runtime sits under a class that also sets
// display, so each one needs the attribute to actually win.
const hiddenElements = await evaluate(`(() => {
  const out = {};
  for (const id of ['unsupported', 'hint', 'progressWrap', 'placeResults', 'btnDisconnect']) {
    const el = document.getElementById(id);
    el.hidden = true;
    out[id] = getComputedStyle(el).display === 'none';
  }
  return out;
})()`);
check('every runtime-hidden element actually hides',
      Object.values(hiddenElements).every(Boolean), JSON.stringify(hiddenElements));

// ── sync button ─────────────────────────────────────────────────────────────

const fab = await evaluate(`(() => {
  const el = document.getElementById('fabSync');
  if (!el) return { missing: true };
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    visible: style.display !== 'none' && box.width > 40 && box.height > 40,
    round: Math.abs(box.width - box.height) < 2,
    fixed: style.position === 'fixed',
    // Disabled until a device is connected, so it cannot be pressed into an error.
    disabledWhileOffline: el.disabled === true,
    inLowerCorner: box.bottom > window.innerHeight * 0.6 && box.right > window.innerWidth * 0.6,
  };
})()`);
check('sync button is a round fixed control', fab && fab.visible && fab.round && fab.fixed, JSON.stringify(fab));
check('sync button sits in the lower corner', fab && fab.inLowerCorner, JSON.stringify(fab));
check('sync button is disabled until connected', fab && fab.disabledWhileOffline, JSON.stringify(fab));

// It has to survive a tab change: that is the whole reason it floats.
const fabAcrossTabs = await evaluate(`(async () => {
  const seen = [];
  for (const tab of document.querySelectorAll('.tab')) {
    tab.click();
    await new Promise(r => setTimeout(r, 120));
    seen.push(getComputedStyle(document.getElementById('fabSync')).display !== 'none');
  }
  return seen;
})()`);
check('sync button stays on every tab', Array.isArray(fabAcrossTabs) && fabAcrossTabs.length > 1
      && fabAcrossTabs.every(Boolean), JSON.stringify(fabAcrossTabs));

// ── photo settings reset ────────────────────────────────────────────────────

const reset = await evaluate(`(async () => {
  document.querySelector('.tab[data-panel="photos"]')?.click();
  await new Promise(r => setTimeout(r, 120));
  const bright = document.getElementById('optBright');
  const contrast = document.getElementById('optContrast');
  bright.value = '40';
  bright.dispatchEvent(new Event('input', { bubbles: true }));
  contrast.value = '1.9';
  contrast.dispatchEvent(new Event('input', { bubbles: true }));
  const changed = { bright: bright.value, contrast: contrast.value };

  document.getElementById('btnResetPhotoOpts').click();
  await new Promise(r => setTimeout(r, 400));

  const stored = JSON.parse(localStorage.getItem('photox4.settings') || '{}').photoOpts || {};
  return { changed, bright: bright.value, contrast: contrast.value, stored };
})()`);
check('reset restores the photo defaults',
      reset && reset.bright === '0' && Number(reset.contrast) === 1.15
      && reset.stored.bright === 0 && reset.stored.contrast === 1.15,
      JSON.stringify(reset));

// ── orientation ─────────────────────────────────────────────────────────────

const landscape = await evaluate(`(async () => {
  document.querySelector('.seg-btn[data-orientation="landscape"]').click();
  await new Promise(r => setTimeout(r, 600));
  const canvas = document.getElementById('preview');
  return { w: canvas.width, h: canvas.height,
           framed: document.getElementById('deviceFrame').classList.contains('is-landscape') };
})()`);
check('landscape resizes the preview to 800x480', landscape && landscape.w === 800 && landscape.h === 480,
      JSON.stringify(landscape));
check('landscape restyles the device mock', landscape && landscape.framed === true);

// Every face, in both frames, must keep its content inside the panel. Running
// off the bottom edge is exactly what the 800x480 frame did before the faces
// grew landscape-specific layouts, and it is invisible in a portrait-only test.
async function scanFaces(orientationLabel) {
  return evaluate(`(async () => {
    const canvas = document.getElementById('preview');
    const wait = () => new Promise(r => setTimeout(r, 350));
    const results = [];
    for (let i = 0; i < 6; i++) {
      document.getElementById('btnNextPreview').click();
      await wait();
      const ctx = canvas.getContext('2d');
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const dark = (x, y) => data[(y * width + x) * 4] < 200;

      let ink = 0, leftInk = 0, rightInk = 0, bottomInk = 0, topInk = 0;
      let minX = width, maxX = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!dark(x, y)) continue;
          ink++;
          if (x < width / 2) leftInk++; else rightInk++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          // The outermost rows: ink here means something was clipped by the edge
          // rather than laid out inside the margin.
          if (y >= height - 2) bottomInk++;
          if (y <= 1) topInk++;
        }
      }
      results.push({
        face: document.getElementById('previewLabel').textContent,
        ink, leftInk, rightInk, bottomInk, topInk, width,
        spanFraction: ink ? (maxX - minX) / width : 0,
      });
    }
    return results;
  })()`);
}

const landscapeFaces = await scanFaces('landscape');
const spilling = (landscapeFaces || []).filter(f => f.bottomInk > 0 || f.topInk > 0);
check('no landscape face spills past the panel edge', spilling.length === 0,
      spilling.map(f => `${f.face}: ${f.bottomInk} bottom, ${f.topInk} top`).join('; '));

const blankLandscape = (landscapeFaces || []).filter(f => f.ink < 200);
check('every landscape face draws something', blankLandscape.length === 0,
      blankLandscape.map(f => `${f.face}: ${f.ink} px`).join('; '));

// The two-column faces should be using both halves of the 800px frame; one that
// only inks the left half has fallen back to the portrait stack. Photos and the
// quote are deliberately not two-column, so they are judged differently below.
const TWO_COLUMN = ['Weather', 'Word of the day', 'On this day', 'Countdown'];
const lopsided = (landscapeFaces || [])
  .filter(f => TWO_COLUMN.includes(f.face))
  .filter(f => f.rightInk * 12 < f.leftInk);
check('two-column landscape faces use both halves', lopsided.length === 0,
      lopsided.map(f => `${f.face}: ${f.leftInk} left vs ${f.rightInk} right`).join('; '));

// The quote is set to a measure instead: a line running the full 800px is the
// thing that made it unreadable in landscape.
const quoteFace = (landscapeFaces || []).find(f => f.face === 'Quote');
check('landscape quote keeps a readable measure',
      quoteFace && quoteFace.spanFraction > 0 && quoteFace.spanFraction < 0.8,
      JSON.stringify(quoteFace));

const portrait = await evaluate(`(async () => {
  document.querySelector('.seg-btn[data-orientation="portrait"]').click();
  await new Promise(r => setTimeout(r, 600));
  const canvas = document.getElementById('preview');
  return { w: canvas.width, h: canvas.height };
})()`);
check('portrait returns to 480x800', portrait && portrait.w === 480 && portrait.h === 800,
      JSON.stringify(portrait));

// ── mobile layout ───────────────────────────────────────────────────────────

await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
await sleep(400);

const mobile = await evaluate(`(() => {
  const rail = document.querySelector('.rail');
  return {
    railVisible: getComputedStyle(rail).display !== 'none',
    overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  };
})()`);
check('navigation is reachable on a phone', mobile.railVisible === true);
check('narrow layout does not scroll sideways', mobile.overflows === false,
      `scrollWidth ${mobile.scrollWidth} vs ${mobile.inner}`);

const mobileNav = await evaluate(`(() => {
  document.querySelectorAll('.rail .tab')[1].click();
  return document.querySelector('.panel[data-panel="faces"]').classList.contains('is-active');
})()`);
check('navigation switches panels on a phone', mobileNav === true);

await send('Emulation.clearDeviceMetricsOverride');

for (const problem of problems) console.error(`      ${problem}`);
check('no console errors', problems.length === 0, `${problems.length} reported`);

console.log(failures ? `\n${failures} check(s) failed` : '\nbrowser checks passed');
await cleanup(failures ? 1 : 0);

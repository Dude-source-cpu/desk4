// Loads the web app in headless Chrome and reports console errors plus a few
// DOM assertions, so a broken module or a null element is caught here rather
// than in front of the device.
//
//   node tests/browser.mjs [url]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] || 'http://localhost:8765/';
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'photox4-chrome-'));
const chrome = spawn(
  'google-chrome-stable',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── setup wizard ────────────────────────────────────────────────────────────

const wizardOpen = await evaluate('!document.getElementById("wizard").hidden');
check('wizard opens on a first visit', wizardOpen === true);

const wizardTitle = await evaluate('document.getElementById("wizTitle").textContent');
check('wizard shows its first step', !!wizardTitle, `title is "${wizardTitle}"`);

const wizardAdvanced = await evaluate(`(() => {
  document.getElementById('wizNext').click();
  return document.getElementById('wizStep').textContent;
})()`);
check('wizard advances', /Step 2 of/.test(wizardAdvanced || ''), wizardAdvanced);

const wizardClosed = await evaluate(`(() => {
  document.getElementById('wizClose').click();
  return document.getElementById('wizard').hidden;
})()`);
check('wizard closes', wizardClosed === true);

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
  const bar = document.querySelector('.bottombar');
  const tabs = document.querySelector('.tabs');
  return {
    bottomBar: getComputedStyle(bar).display,
    topTabs: getComputedStyle(tabs).display,
    overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
  };
})()`);
check('mobile shows the bottom nav', mobile.bottomBar === 'grid', mobile.bottomBar);
check('mobile hides the desktop tabs', mobile.topTabs === 'none', mobile.topTabs);
check('mobile layout does not scroll sideways', mobile.overflows === false, `scrollWidth ${mobile.scrollWidth}`);

const mobileNav = await evaluate(`(() => {
  document.querySelectorAll('.bottom-tab')[1].click();
  return document.querySelector('.panel[data-panel="faces"]').classList.contains('is-active');
})()`);
check('mobile bottom nav switches panels', mobileNav === true);

await send('Emulation.clearDeviceMetricsOverride');

for (const problem of problems) console.error(`      ${problem}`);
check('no console errors', problems.length === 0, `${problems.length} reported`);

console.log(failures ? `\n${failures} check(s) failed` : '\nbrowser checks passed');
await cleanup(failures ? 1 : 0);

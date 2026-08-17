// First-run setup guide. It exists mostly for one step: the device's Bluetooth
// is off by default and the automatic window after a face change is too short to
// finish pairing, so without being told, the natural thing to try — press
// Connect and pick the device — fails. Step 4 puts that front and centre.

const SEEN_KEY = 'desk4.setupSeen';

const $ = id => document.getElementById(id);

export class Wizard {
  /**
   * @param {object} deps
   * @param {() => Promise<void>} deps.connect      run a user-gesture connect
   * @param {() => boolean}       deps.isConnected
   * @param {() => void}          deps.downloadConfig
   * @param {() => Promise<void>} deps.sync
   * @param {(panel: string) => void} deps.goToPanel
   */
  constructor(deps) {
    this.deps = deps;
    this.index = 0;
    this.steps = this.buildSteps();
    this.wire();
  }

  static hasRun() {
    return localStorage.getItem(SEEN_KEY) === '1';
  }

  wire() {
    $('wizClose').addEventListener('click', () => this.close());
    $('wizBack').addEventListener('click', () => this.go(this.index - 1));
    $('wizNext').addEventListener('click', () => {
      const step = this.steps[this.index];
      if (step.onNext && step.onNext() === false) return;
      if (this.index >= this.steps.length - 1) this.close();
      else this.go(this.index + 1);
    });
    $('wizard').addEventListener('click', event => {
      if (event.target === $('wizard')) this.close();
    });
  }

  open(at = 0) {
    this.index = at;
    $('wizard').hidden = false;
    this.render();
  }

  close() {
    localStorage.setItem(SEEN_KEY, '1');
    $('wizard').hidden = true;
  }

  go(index) {
    this.index = Math.max(0, Math.min(this.steps.length - 1, index));
    this.render();
  }

  render() {
    const step = this.steps[this.index];
    $('wizStep').textContent = `Step ${this.index + 1} of ${this.steps.length}`;
    $('wizTitle').textContent = step.title;
    $('wizContent').innerHTML = step.body;
    $('wizBar').style.width = `${((this.index + 1) / this.steps.length) * 100}%`;
    $('wizBack').disabled = this.index === 0;
    $('wizNext').textContent = this.index === this.steps.length - 1 ? 'Finish' : 'Next';
    if (step.onShow) step.onShow();
  }

  setState(text, kind = '') {
    const el = $('wizState');
    if (!el) return;
    el.textContent = text;
    el.className = `wizard-state ${kind}`;
  }

  buildSteps() {
    return [
      {
        title: 'Turn your X4 into a desk frame',
        body: `
          <p>This page sends photos and content to an Xteink X4 over Bluetooth. The device shows one
          face at a time — a photo, today's weather, a quote — and changes every ten minutes.</p>
          <p>There is <strong>no clock on any face</strong>. It is meant to be glanced at, not consulted.</p>
          <p class="muted small">Setup takes a few minutes and you only do it once. You can reopen this
          guide any time from the Device tab.</p>`,
      },
      {
        title: 'Flash the companion firmware',
        body: `
          <p>The frame is a build of <strong>CrossPoint Reader</strong> with a photo-frame mode added.
          Plug the X4 in over USB and flash it:</p>
          <pre>cd firmware
pio run -e companion -t upload</pre>
          <p>If the device is still on the stock Xteink firmware, install CrossPoint first with the
          <a href="https://crosspointreader.com/" target="_blank" rel="noopener">web installer</a>.</p>
          <div class="wizard-note">Already flashed? Skip ahead — nothing here is destructive.</div>`,
      },
      {
        title: 'Put config.json on the SD card',
        body: `
          <p>The device only becomes a frame — and only switches its Bluetooth on — once
          <code>/photox4/config.json</code> exists on the card. That one file has to travel over USB;
          everything after it comes over Bluetooth.</p>
          <ol>
            <li>Download the file below.</li>
            <li>Copy it into a folder called <code>photox4</code> at the root of the SD card.</li>
            <li>Put the card back in the device.</li>
          </ol>
          <p><button id="wizDownload" class="btn btn-primary btn-lg">Download config.json</button></p>
          <div class="wizard-note">It carries the settings currently on this page, so if you change the
          rotation or orientation later, just sync over Bluetooth — no need to touch the card again.</div>`,
        onShow: () => {
          const button = $('wizDownload');
          if (button) button.addEventListener('click', () => this.deps.downloadConfig());
        },
      },
      {
        title: 'Wake up Bluetooth',
        body: `
          <div class="press-demo">
            <div class="body"></div>
            <div class="caption"><strong>Hold the power button for about two seconds</strong>, until the
            screen says <em>Bluetooth is on</em> and shows a name like <code>PhotoX4-3F7A</code>.</div>
          </div>
          <p>That opens a five-minute window, which is what you want for pairing.</p>
          <div class="wizard-note">The device also opens a very short Bluetooth window after every face
          change, but it is only seconds long — usually not enough to finish pairing by hand. If a
          connection attempt fails, it is almost always because that window closed. Hold the button and
          try again.</div>
          <p class="muted small">A <em>short</em> click does something different: it skips to the next face.</p>`,
      },
      {
        title: 'Connect to your frame',
        body: `
          <p>With the device showing <em>Bluetooth is on</em>, connect and pick it from the browser's
          list. It appears as <code>PhotoX4-…</code>.</p>
          <p><button id="wizConnect" class="btn btn-primary btn-lg">Connect</button></p>
          <p id="wizState" class="wizard-state"></p>
          <div class="wizard-note">Bluetooth from a browser needs Chrome, Edge, or Opera, and a machine
          with a real Bluetooth radio — inside a virtual machine it usually is not passed through.</div>`,
        onShow: () => {
          const button = $('wizConnect');
          if (this.deps.isConnected()) this.setState('Connected.', 'ok');
          if (!button) return;
          button.addEventListener('click', async () => {
            this.setState('Waiting for you to pick the device…');
            try {
              await this.deps.connect();
              this.setState('Connected.', 'ok');
            } catch (err) {
              if (err && err.name === 'NotFoundError') this.setState('No device picked.', '');
              else this.setState(err.message || String(err), 'err');
            }
          });
        },
      },
      {
        title: 'Give it something to show',
        body: `
          <p>Two things worth doing before the first sync:</p>
          <ul>
            <li><strong>Photos</strong> — drop a handful in. They are cropped and dithered here, and the
            preview shows exactly what the panel will render.</li>
            <li><strong>A location</strong> — needed for the weather face, otherwise it is skipped.</li>
          </ul>
          <p>
            <button id="wizPhotos" class="btn">Go to Photos</button>
            <button id="wizContent" class="btn">Go to Content</button>
          </p>
          <p class="muted small">Quotes and words are already loaded, so those faces work with no setup.</p>`,
        onShow: () => {
          const photos = $('wizPhotos');
          const content = $('wizContent');
          if (photos) photos.addEventListener('click', () => { this.deps.goToPanel('photos'); this.close(); });
          if (content) content.addEventListener('click', () => { this.deps.goToPanel('content'); this.close(); });
        },
      },
      {
        title: 'Send it over',
        body: `
          <p>Press <strong>Send to frame</strong> on the Device tab. It sets the clock, sends your settings
          and content, and uploads any photos the device does not already have.</p>
          <p><button id="wizSync" class="btn btn-primary btn-lg">Send to frame</button></p>
          <p id="wizState" class="wizard-state"></p>
          <p>After this, leave the tab open and it will reconnect on its own during the device's own
          short Bluetooth windows, keeping the weather current through the day.</p>
          <div class="wizard-note">Day to day: short click skips a face, long hold turns Bluetooth on
          and off again. On USB power the frame stays awake and always reachable.</div>`,
        onShow: () => {
          const button = $('wizSync');
          if (!button) return;
          button.disabled = !this.deps.isConnected();
          if (!this.deps.isConnected()) this.setState('Connect first, on the previous step.', '');
          button.addEventListener('click', async () => {
            this.setState('Syncing…');
            try {
              await this.deps.sync();
              this.setState('Synced.', 'ok');
            } catch (err) {
              this.setState(err.message || String(err), 'err');
            }
          });
        },
      },
    ];
  }
}

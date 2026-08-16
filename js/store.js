// Persistence. Settings live in localStorage; photos are far too big for it and
// live in IndexedDB as the panel-sized JPEG bytes that get sent to the device.

const SETTINGS_KEY = 'photox4.settings';
const DB_NAME = 'photox4';
const DB_STORE = 'photos';

export const FACES = [
  { id: 'photo', name: 'Photos', desc: 'Your pictures, one per turn' },
  { id: 'weather', name: 'Weather', desc: "Today's conditions, hourly and the next few days" },
  { id: 'quote', name: 'Quote', desc: 'A line worth reading twice' },
  { id: 'word', name: 'Word of the day', desc: 'A word, how to say it, and what it means' },
  { id: 'countdown', name: 'Countdown', desc: 'Days until the things you are waiting for' },
  { id: 'history', name: 'On this day', desc: "Something that happened on today's date" },
];

const DEFAULTS = {
  interval: 10,
  syncWindow: 20,
  shuffle: false,
  showSunTimes: true,
  batteryWarn: true,
  unit: 'celsius',
  onThisDay: true,
  faces: FACES.map(f => ({ id: f.id, on: f.id !== 'countdown' })),
  place: null,
  quotes: null, // null means "use the bundled set"
  events: [],
  photoOpts: { fit: 'cover', bright: 0, contrast: 1.15, quality: 0.72 },
  lastSync: null,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    const merged = { ...structuredClone(DEFAULTS), ...parsed };
    merged.photoOpts = { ...DEFAULTS.photoOpts, ...(parsed.photoOpts || {}) };

    // Reconcile the stored order with the faces this build knows about, so an
    // added or removed face never leaves the list broken.
    const known = new Map(FACES.map(f => [f.id, f]));
    const kept = [];
    const seen = new Set();
    for (const face of merged.faces || []) {
      if (!known.has(face.id) || seen.has(face.id)) continue;
      seen.add(face.id);
      kept.push({ id: face.id, on: !!face.on });
    }
    for (const face of FACES) {
      if (!seen.has(face.id)) kept.push({ id: face.id, on: false });
    }
    merged.faces = kept;
    return merged;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function faceMeta(id) {
  return FACES.find(f => f.id === id);
}

// ── photo store ─────────────────────────────────────────────────────────────

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      store.createIndex('addedAt', 'addedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Runs `fn(store)` and resolves with the request's result once it lands. */
async function tx(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const transaction = conn.transaction(DB_STORE, mode);
    const request = fn(transaction.objectStore(DB_STORE));
    let value;
    request.onsuccess = () => {
      value = request.result;
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function listPhotos() {
  const photos = (await tx('readonly', store => store.getAll())) || [];
  return photos.sort((a, b) => a.addedAt - b.addedAt);
}

export function putPhoto(photo) {
  return tx('readwrite', store => store.put(photo));
}

export function deletePhoto(id) {
  return tx('readwrite', store => store.delete(id));
}

export function clearPhotos() {
  return tx('readwrite', store => store.clear());
}

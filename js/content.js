// Everything the text faces need, assembled into the small JSON files the
// firmware reads. Each face has its own file so one failed fetch never spoils
// the rest, and so the device parses a few hundred bytes instead of the lot.

const ONTHISDAY_API = 'https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected';

/** How many entries of each kind get sent, so a face varies between syncs. */
const SEND_QUOTES = 24;
const SEND_WORDS = 24;
const SEND_HISTORY = 6;

let bundledQuotes = null;
let bundledWords = null;

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json();
}

export async function builtInQuotes() {
  if (!bundledQuotes) bundledQuotes = await loadJson('data/quotes.json');
  return bundledQuotes;
}

export async function builtInWords() {
  if (!bundledWords) bundledWords = await loadJson('data/words.json');
  return bundledWords;
}

/**
 * Days since 1970-01-01 for a calendar date (Howard Hinnant's days_from_civil).
 * Countdowns are the one place the two sides have to agree exactly, and doing
 * the arithmetic on the civil date rather than on a timestamp keeps the answer
 * free of timezone and DST offsets. `todayEpochDay()` in CompanionContent.cpp
 * is the same function.
 */
export function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Days since the Unix epoch for the local calendar date of `date`. */
export function epochDay(date) {
  return daysFromCivil(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/**
 * Rotates through a pool a slice at a time, keyed on the day, so consecutive
 * syncs do not resend the same two dozen quotes.
 */
function daySlice(pool, count, seed) {
  if (pool.length <= count) return pool.slice();
  const start = (seed * count) % pool.length;
  const out = [];
  for (let i = 0; i < count; i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

export async function onThisDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const res = await fetch(`${ONTHISDAY_API}/${month}/${day}`);
  if (!res.ok) throw new Error(`on this day failed (${res.status})`);
  const json = await res.json();
  return (json.selected || [])
    .filter(entry => entry.text && entry.year)
    .slice(0, SEND_HISTORY)
    .map(entry => ({ y: entry.year, t: entry.text }));
}

// ── payload builders ────────────────────────────────────────────────────────

export function buildConfig(settings) {
  return {
    version: 1,
    enabled: true,
    intervalMin: settings.interval,
    syncWindowSec: settings.syncWindow,
    shuffle: settings.shuffle,
    showSunTimes: settings.showSunTimes,
    batteryWarn: settings.batteryWarn,
    orientation: settings.orientation || 'portrait',
    rotation: settings.faces.filter(f => f.on).map(f => f.id),
  };
}

export function buildWeather(forecast) {
  if (!forecast) return null;
  return {
    place: forecast.place,
    label: forecast.label,
    icon: forecast.icon,
    unit: forecast.unit,
    now: forecast.now,
    feels: forecast.feels,
    hi: forecast.hi,
    lo: forecast.lo,
    humidity: forecast.humidity,
    wind: forecast.wind,
    precip: forecast.precip,
    sunrise: forecast.sunrise,
    sunset: forecast.sunset,
    hours: forecast.hours,
    days: forecast.days,
  };
}

export async function buildQuotes(settings, seed) {
  const pool = settings.quotes && settings.quotes.length ? settings.quotes : await builtInQuotes();
  return {
    items: daySlice(pool, SEND_QUOTES, seed).map(q => ({ t: q.text ?? q.t, a: q.author ?? q.a ?? '' })),
  };
}

export async function buildWords(seed) {
  const pool = await builtInWords();
  return {
    items: daySlice(pool, SEND_WORDS, seed).map(w => ({
      w: w.word,
      p: w.pos,
      r: w.pron,
      d: w.def,
      e: w.ex,
    })),
  };
}

export function buildEvents(settings) {
  const today = epochDay(new Date());
  const items = (settings.events || [])
    .map(event => {
      const [year, month, day] = event.date.split('-').map(Number);
      return { t: event.title, d: epochDay(new Date(year, month - 1, day)) };
    })
    .filter(item => item.d >= today)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  return { items };
}

export function buildHistory(entries) {
  return { items: entries || [] };
}

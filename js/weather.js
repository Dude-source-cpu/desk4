// Open-Meteo: no key, CORS-friendly, works from a static GitHub Pages origin.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** WMO weather code → label plus the icon key the firmware draws. */
const CODES = {
  0:  ['Clear', 'clear'],
  1:  ['Mainly clear', 'partly'],
  2:  ['Partly cloudy', 'partly'],
  3:  ['Overcast', 'cloudy'],
  45: ['Fog', 'fog'],
  48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'],
  53: ['Drizzle', 'drizzle'],
  55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'drizzle'],
  57: ['Freezing drizzle', 'drizzle'],
  61: ['Light rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'],
  67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Showers', 'showers'],
  81: ['Showers', 'showers'],
  82: ['Heavy showers', 'showers'],
  85: ['Snow showers', 'snow'],
  86: ['Snow showers', 'snow'],
  95: ['Thunderstorms', 'thunder'],
  96: ['Thunderstorms', 'thunder'],
  99: ['Thunderstorms', 'thunder'],
};

export function describe(code) {
  return CODES[code] || ['—', 'cloudy'];
}

export async function searchPlaces(name) {
  const url = `${GEOCODE}?name=${encodeURIComponent(name)}&count=6&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoding failed (${res.status})`);
  const json = await res.json();
  return (json.results || []).map(r => ({
    name: r.name,
    label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export async function reverseName(lat, lon) {
  try {
    const res = await fetch(`${GEOCODE}?name=&latitude=${lat}&longitude=${lon}&count=1&format=json`);
    if (res.ok) {
      const json = await res.json();
      if (json.results && json.results[0]) return json.results[0].name;
    }
  } catch { /* naming is cosmetic */ }
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

const hhmm = iso => (iso || '').slice(11, 16);

/**
 * Today's forecast, shaped for the device: everything it needs to draw the
 * weather face without doing any date maths of its own.
 */
export async function fetchForecast(place, unit = 'celsius') {
  const params = new URLSearchParams({
    latitude: place.lat,
    longitude: place.lon,
    current: 'temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m,apparent_temperature',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '4',
    temperature_unit: unit,
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`${FORECAST}?${params}`);
  if (!res.ok) throw new Error(`forecast failed (${res.status})`);
  const j = await res.json();

  const [label, icon] = describe(j.current.weather_code);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Six three-hourly samples starting at the next whole 3-hour mark, so the
  // strip on the device covers the rest of today rather than the small hours.
  const nowIso = j.current.time;
  let start = j.hourly.time.indexOf(nowIso);
  if (start < 0) start = 0;
  const hours = [];
  for (let i = start; i < j.hourly.time.length && hours.length < 6; i += 3) {
    hours.push({
      h: Number(j.hourly.time[i].slice(11, 13)),
      t: Math.round(j.hourly.temperature_2m[i]),
      p: j.hourly.precipitation_probability?.[i] ?? 0,
      i: describe(j.hourly.weather_code[i])[1],
    });
  }

  const days = j.daily.time.slice(0, 4).map((iso, k) => ({
    d: dayNames[new Date(`${iso}T12:00:00`).getDay()],
    hi: Math.round(j.daily.temperature_2m_max[k]),
    lo: Math.round(j.daily.temperature_2m_min[k]),
    i: describe(j.daily.weather_code[k])[1],
    p: j.daily.precipitation_probability_max?.[k] ?? 0,
  }));

  return {
    place: place.label || place.name,
    unit: unit === 'fahrenheit' ? 'F' : 'C',
    now: Math.round(j.current.temperature_2m),
    feels: Math.round(j.current.apparent_temperature),
    label,
    icon,
    humidity: Math.round(j.current.relative_humidity_2m),
    wind: Math.round(j.current.wind_speed_10m),
    hi: days[0]?.hi ?? null,
    lo: days[0]?.lo ?? null,
    precip: j.daily.precipitation_probability_max?.[0] ?? 0,
    sunrise: hhmm(j.daily.sunrise?.[0]),
    sunset: hhmm(j.daily.sunset?.[0]),
    hours,
    days,
  };
}

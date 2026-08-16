// Draws each face into the 480×800 preview canvas. The photo face is exact —
// it is the same dithered plane the device receives. The text faces mirror the
// firmware's layout with web fonts, so treat them as a composition check rather
// than a pixel-accurate simulation.

import { PANEL_W, PANEL_H, paintLevels } from './render.js';

const INK = '#111';
const PAPER = '#fff';
const MARGIN = 26;
const L = MARGIN;
const R = PANEL_W - MARGIN;
const W = R - L;
const CX = PANEL_W / 2;

const SANS = '"Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

function begin(canvas) {
  canvas.width = PANEL_W;
  canvas.height = PANEL_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, PANEL_W, PANEL_H);
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.textBaseline = 'top';
  return ctx;
}

function label(ctx, text, y) {
  ctx.font = `600 15px ${SANS}`;
  ctx.textAlign = 'left';
  let x = L;
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + 3;
  }
}

function rule(ctx, y, heavy = false) {
  ctx.fillRect(L, y, W, heavy ? 2 : 1);
}

function centered(ctx, text, y, font) {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillText(text, CX, y);
}

/** Greedy word wrap, returning the lines that fit `maxWidth`. */
function wrap(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) return lines;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

// ── weather art, mirroring drawWeatherIcon() in Faces.cpp ────────────────────

function circle(ctx, cx, cy, r, color = INK) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
}

function cloudShape(ctx, cx, cy, width, color) {
  const big = width / 4;
  const small = width / 6;
  circle(ctx, cx - width / 4, cy + small / 2, small + 1, color);
  circle(ctx, cx + width / 5, cy + small / 2, small, color);
  circle(ctx, cx, cy - small / 2, big, color);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(cx - width / 2, cy + small / 2, width, big, big / 2);
  ctx.fill();
  ctx.fillStyle = INK;
}

function cloudOutline(ctx, cx, cy, width) {
  cloudShape(ctx, cx, cy, width, INK);
  cloudShape(ctx, cx, cy, width - 8, PAPER);
}

function sun(ctx, cx, cy, size) {
  const r = size / 4;
  circle(ctx, cx, cy, r);
  ctx.lineWidth = 3;
  const inner = r + size / 12;
  const outer = r + size / 5;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }
}

function streaks(ctx, cx, cy, size, count, length) {
  ctx.lineWidth = 3;
  const spacing = size / 5;
  const start = cx - (spacing * (count - 1)) / 2;
  for (let i = 0; i < count; i++) {
    const x = start + i * spacing;
    ctx.beginPath();
    ctx.moveTo(x, cy);
    ctx.lineTo(x - length / 3, cy + length);
    ctx.stroke();
  }
}

export function weatherIcon(ctx, icon, cx, cy, size) {
  switch (icon) {
    case 'clear':
      sun(ctx, cx, cy, size);
      break;
    case 'partly':
      sun(ctx, cx + size / 5, cy - size / 5, (size * 3) / 4);
      cloudOutline(ctx, cx - size / 12, cy + size / 8, (size * 3) / 4);
      break;
    case 'cloudy':
      cloudShape(ctx, cx, cy, (size * 4) / 5, INK);
      break;
    case 'fog':
      cloudOutline(ctx, cx, cy - size / 8, (size * 3) / 4);
      for (let i = 0; i < 3; i++) {
        const inset = (i % 2) * (size / 10);
        ctx.beginPath();
        ctx.roundRect(cx - size / 3 + inset, cy + size / 4 + i * (size / 10), (size * 2) / 3 - inset, 3, 2);
        ctx.fill();
      }
      break;
    case 'drizzle':
      cloudOutline(ctx, cx, cy - size / 10, (size * 3) / 4);
      streaks(ctx, cx, cy + size / 4, size, 3, size / 10);
      break;
    case 'rain':
      cloudOutline(ctx, cx, cy - size / 10, (size * 3) / 4);
      streaks(ctx, cx, cy + size / 4, size, 3, size / 6);
      break;
    case 'showers':
      sun(ctx, cx + size / 4, cy - size / 4, size / 2);
      cloudOutline(ctx, cx - size / 12, cy, (size * 2) / 3);
      streaks(ctx, cx - size / 12, cy + size / 4, size, 2, size / 7);
      break;
    case 'snow':
      cloudOutline(ctx, cx, cy - size / 8, (size * 3) / 4);
      ctx.lineWidth = 2;
      for (let i = -1; i <= 1; i++) {
        const x = cx + i * (size / 4);
        const y = cy + size / 4 + (i === 0 ? size / 14 : 0);
        const arm = size / 14;
        for (const [dx, dy] of [[arm, 0], [0, arm], [arm * 0.7, arm * 0.7], [arm * 0.7, -arm * 0.7]]) {
          ctx.beginPath();
          ctx.moveTo(x - dx, y - dy);
          ctx.lineTo(x + dx, y + dy);
          ctx.stroke();
        }
      }
      break;
    case 'thunder': {
      cloudOutline(ctx, cx, cy - size / 8, (size * 3) / 4);
      const w = size / 8;
      const h = size / 4;
      const y = cy + size / 6;
      ctx.beginPath();
      ctx.moveTo(cx + w / 2, y);
      ctx.lineTo(cx - w, y + h / 2);
      ctx.lineTo(cx, y + h / 2);
      ctx.lineTo(cx - w / 2, y + h);
      ctx.lineTo(cx + w, y + h / 3);
      ctx.lineTo(cx, y + h / 3);
      ctx.closePath();
      ctx.fill();
      break;
    }
    default:
      cloudShape(ctx, cx, cy, (size * 4) / 5, INK);
  }
}

// ── faces ───────────────────────────────────────────────────────────────────

export function drawPhoto(canvas, levels) {
  paintLevels(canvas, levels);
}

export function drawWeather(canvas, forecast, showSunTimes) {
  const ctx = begin(canvas);
  if (!forecast) {
    return drawMessage(canvas, 'No forecast yet', 'Set a location on the Content tab.', null);
  }

  let y = MARGIN + 8;
  label(ctx, 'TODAY', y);
  ctx.font = `15px ${SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText(forecast.place, R, y - 3);
  y += 26;
  rule(ctx, y, true);

  weatherIcon(ctx, forecast.icon, CX, y + 108, 150);
  y += 190;

  centered(ctx, `${forecast.now}°`, y, `700 54px ${SANS}`);
  y += 74;
  centered(ctx, forecast.label, y, `19px ${SANS}`);
  y += 34;
  centered(ctx, `H ${forecast.hi}°    L ${forecast.lo}°`, y, `700 17px ${SANS}`);
  y += 42;

  if (forecast.hours && forecast.hours.length) {
    rule(ctx, y);
    y += 14;
    const column = W / forecast.hours.length;
    forecast.hours.forEach((hour, i) => {
      const cx = L + column * i + column / 2;
      ctx.textAlign = 'center';
      ctx.font = `11px ${SANS}`;
      ctx.fillText(String(hour.h).padStart(2, '0'), cx, y);
      weatherIcon(ctx, hour.i, cx, y + 40, 40);
      ctx.font = `700 15px ${SANS}`;
      ctx.fillText(`${hour.t}°`, cx, y + 64);
      if (hour.p >= 30) {
        ctx.font = `11px ${SANS}`;
        ctx.fillText(`${hour.p}%`, cx, y + 86);
      }
    });
    y += 110;
  }

  if (forecast.days && forecast.days.length) {
    rule(ctx, y);
    y += 14;
    const column = W / forecast.days.length;
    forecast.days.forEach((day, i) => {
      const cx = L + column * i + column / 2;
      ctx.textAlign = 'center';
      ctx.font = `700 15px ${SANS}`;
      ctx.fillText(i === 0 ? 'Today' : day.d, cx, y);
      weatherIcon(ctx, day.i, cx, y + 46, 46);
      ctx.font = `11px ${SANS}`;
      ctx.fillText(`${day.hi}° ${day.lo}°`, cx, y + 74);
    });
  }

  let footerY = PANEL_H - MARGIN - 24;
  if (showSunTimes && forecast.sunrise) {
    centered(ctx, `Sunrise ${forecast.sunrise}     Sunset ${forecast.sunset}`, footerY, `11px ${SANS}`);
    footerY -= 20;
  }
  centered(
    ctx,
    `Feels ${forecast.feels}°     Wind ${forecast.wind} km/h     Rain ${forecast.precip}%`,
    footerY,
    `11px ${SANS}`,
  );
}

export function drawQuote(canvas, quote) {
  const ctx = begin(canvas);
  if (!quote) return drawMessage(canvas, 'No quotes', 'Add some on the Content tab.', null);

  const textWidth = W - 24;
  let size = 26;
  ctx.font = `${size}px ${SERIF}`;
  let lines = wrap(ctx, quote.text ?? quote.t, textWidth, 9);
  if (lines.length >= 9) {
    size = 19;
    ctx.font = `${size}px ${SERIF}`;
    lines = wrap(ctx, quote.text ?? quote.t, textWidth, 13);
  }

  const lineHeight = size + 12;
  const author = quote.author ?? quote.a ?? '';
  const blockHeight = lines.length * lineHeight + (author ? 60 : 0);
  let y = Math.max(MARGIN + 40, (PANEL_H - blockHeight) / 2);

  ctx.textAlign = 'left';
  ctx.font = `700 54px ${SANS}`;
  ctx.fillText('“', L, y - 46);

  ctx.font = `${size}px ${SERIF}`;
  for (const line of lines) {
    ctx.fillText(line, L + 12, y);
    y += lineHeight;
  }

  if (author) {
    y += 12;
    ctx.fillRect(L + 12, y, 48, 2);
    y += 14;
    ctx.font = `italic 15px ${SANS}`;
    ctx.fillText(author, L + 12, y);
  }
}

export function drawWord(canvas, word) {
  const ctx = begin(canvas);
  if (!word) return drawMessage(canvas, 'No words', 'The built-in list will be sent on the next sync.', null);

  let y = MARGIN + 8;
  label(ctx, 'WORD OF THE DAY', y);
  y += 26;
  rule(ctx, y, true);
  y += 40;

  ctx.textAlign = 'left';
  ctx.font = `700 54px ${SANS}`;
  if (ctx.measureText(word.word).width > W) ctx.font = `700 26px ${SANS}`;
  ctx.fillText(word.word, L, y);
  y += 74;

  const meta = [word.pron, word.pos].filter(Boolean).join('   |   ');
  if (meta) {
    ctx.font = `italic 15px ${SANS}`;
    ctx.fillText(meta, L, y);
    y += 42;
  }

  rule(ctx, y);
  y += 22;

  ctx.font = `19px ${SANS}`;
  for (const line of wrap(ctx, word.def, W, 6)) {
    ctx.fillText(line, L, y);
    y += 27;
  }

  if (word.ex) {
    y += 26;
    ctx.fillRect(L, y, 48, 2);
    y += 18;
    ctx.font = `italic 17px ${SERIF}`;
    for (const line of wrap(ctx, word.ex, W, 5)) {
      ctx.fillText(line, L, y);
      y += 24;
    }
  }
}

export function drawCountdown(canvas, events) {
  const ctx = begin(canvas);
  if (!events || !events.length) {
    return drawMessage(canvas, 'Nothing scheduled', 'Add a date on the Content tab.', null);
  }

  let y = MARGIN + 8;
  label(ctx, 'COUNTING DOWN', y);
  y += 26;
  rule(ctx, y, true);
  y += 48;

  const [next, ...rest] = events;
  if (next.days === 0) {
    centered(ctx, 'TODAY', y + 30, `700 26px ${SANS}`);
  } else {
    centered(ctx, String(next.days), y, `700 54px ${SANS}`);
    y += 74;
    centered(ctx, next.days === 1 ? 'day until' : 'days until', y, `15px ${SANS}`);
  }
  y += 34;

  ctx.font = `700 26px ${SANS}`;
  for (const line of wrap(ctx, next.title, W, 2)) {
    centered(ctx, line, y, `700 26px ${SANS}`);
    y += 38;
  }

  if (rest.length) {
    y += 40;
    rule(ctx, y);
    y += 20;
    for (const event of rest) {
      const count = event.days === 0 ? 'today' : `${event.days} ${event.days === 1 ? 'day' : 'days'}`;
      ctx.font = `700 17px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillText(count, R, y);
      ctx.textAlign = 'left';
      ctx.font = `17px ${SANS}`;
      ctx.fillText(event.title, L, y);
      y += 38;
    }
  }
}

export function drawHistory(canvas, entry) {
  const ctx = begin(canvas);
  if (!entry) {
    return drawMessage(canvas, 'On this day', 'Enable the Wikipedia lookup on the Content tab, then sync.', null);
  }

  let y = MARGIN + 8;
  label(ctx, 'ON THIS DAY', y);
  y += 26;
  rule(ctx, y, true);
  y += 46;

  ctx.textAlign = 'left';
  ctx.font = `700 54px ${SANS}`;
  ctx.fillText(String(entry.y), L, y);
  y += 100;

  ctx.font = `26px ${SERIF}`;
  for (const line of wrap(ctx, entry.t, W, 10)) {
    ctx.fillText(line, L, y);
    y += 40;
  }
}

export function drawMessage(canvas, title, line1, line2) {
  const ctx = canvas.getContext('2d');
  // Only clear when nothing has been drawn yet, so the fallback can be layered
  // over a face that bailed out halfway.
  if (canvas.dataset.painted !== 'partial') {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, PANEL_W, PANEL_H);
    ctx.fillStyle = INK;
  }
  ctx.textBaseline = 'top';

  let y = PANEL_H / 2 - 90;
  centered(ctx, title, y, `700 26px ${SANS}`);
  y += 56;
  ctx.fillRect(CX - 24, y, 48, 2);
  y += 24;

  for (const line of [line1, line2]) {
    if (!line) continue;
    ctx.font = `17px ${SANS}`;
    for (const wrapped of wrap(ctx, line, W - 40, 3)) {
      centered(ctx, wrapped, y, `17px ${SANS}`);
      y += 26;
    }
    y += 8;
  }
}

// Draws each face into the 480×800 preview canvas. The photo face is exact —
// it is the same dithered plane the device receives. The text faces mirror the
// firmware's layout with web fonts, so treat them as a composition check rather
// than a pixel-accurate simulation.

import { panelSize, paintLevels } from './render.js';

const INK = '#111';
const PAPER = '#fff';
const MARGIN = 26;

const SANS = '"Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

// Geometry for the frame currently being drawn. Set by begin(); every helper
// reads it rather than taking six arguments.
let PANEL_W = 480;
let PANEL_H = 800;
let L = MARGIN;
let R = PANEL_W - MARGIN;
let W = R - L;
let B = PANEL_H - MARGIN;
let CX = PANEL_W / 2;

function begin(canvas, orientation = 'portrait') {
  const size = panelSize(orientation);
  PANEL_W = size.w;
  PANEL_H = size.h;
  L = MARGIN;
  R = PANEL_W - MARGIN;
  W = R - L;
  B = PANEL_H - MARGIN;
  CX = PANEL_W / 2;

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

function label(ctx, text, y, startX = L) {
  ctx.font = `600 15px ${SANS}`;
  ctx.textAlign = 'left';
  let x = startX;
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

// ── layout helpers, mirroring the same names in Faces.cpp ────────────────────

/** True for the 800x480 frame, where a portrait stack has no room to breathe. */
function isLandscape() {
  return PANEL_W > PANEL_H;
}

/** Left/right column geometry for the landscape variants. */
function splitColumns(leftPercent, gap = 32) {
  const leftWidth = Math.floor(((W - gap) * leftPercent) / 100);
  const rightX = L + leftWidth + gap;
  return { leftX: L, leftWidth, rightX, rightWidth: R - rightX, dividerX: L + leftWidth + gap / 2 };
}

function columnDivider(ctx, columns, top, bottom) {
  if (bottom > top) ctx.fillRect(columns.dividerX, top, 1, bottom - top);
}

/** The label-and-rule masthead every text face opens with. Returns the y below it. */
function faceHeader(ctx, text) {
  let y = MARGIN + 8;
  label(ctx, text, y);
  y += 26;
  rule(ctx, y, true);
  return y;
}

/** Sets `text` down the page from `y`, stopping at `bottom`. Returns the y below it. */
function paragraph(ctx, text, x, width, y, bottom, lineHeight, cap, font) {
  ctx.font = font;
  ctx.textAlign = 'left';
  let cursor = y;
  const max = Math.max(1, Math.min(cap, Math.floor((bottom - y) / lineHeight)));
  for (const line of wrap(ctx, text, width, max)) {
    if (cursor + lineHeight > bottom) break;
    ctx.fillText(line, x, cursor);
    cursor += lineHeight;
  }
  return cursor;
}

/** Draws `text` centred on `cx` (rather than the panel centre) at `y`. */
function centeredOn(ctx, text, cx, y, font) {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillText(text, cx, y);
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

export function drawPhoto(canvas, levels, orientation = 'portrait') {
  const { w, h } = panelSize(orientation);
  paintLevels(canvas, levels, w, h);
}

/** Six three-hourly samples across `width`, mirroring drawHourStrip() on device. */
function hourStrip(ctx, forecast, left, width, y) {
  const column = width / forecast.hours.length;
  forecast.hours.forEach((hour, i) => {
    const cx = left + column * i + column / 2;
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
}

function dayStrip(ctx, forecast, left, width, y) {
  const column = width / forecast.days.length;
  forecast.days.forEach((day, i) => {
    const cx = left + column * i + column / 2;
    ctx.textAlign = 'center';
    ctx.font = `700 15px ${SANS}`;
    ctx.fillText(i === 0 ? 'Today' : day.d, cx, y);
    weatherIcon(ctx, day.i, cx, y + 46, 46);
    ctx.font = `11px ${SANS}`;
    ctx.fillText(`${day.hi}° ${day.lo}°`, cx, y + 74);
  });
}

function weatherHeader(ctx, forecast) {
  let y = MARGIN + 8;
  label(ctx, 'TODAY', y);
  ctx.font = `15px ${SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText(forecast.place, R, y - 3);
  y += 26;
  rule(ctx, y, true);
  return y;
}

/** The two-column arrangement the firmware switches to below 480px of height. */
function weatherLandscape(ctx, forecast, showSunTimes) {
  const ruleY = weatherHeader(ctx, forecast);
  const columns = splitColumns(40);

  // The footer sits on its own rule so both columns share one baseline to end
  // against, rather than each stopping wherever its content ran out.
  const footerLines = showSunTimes && forecast.sunrise ? 2 : 1;
  const bodyBottom = B - (footerLines * 18 + 12);
  rule(ctx, bodyBottom);
  columnDivider(ctx, columns, ruleY + 20, bodyBottom - 12);

  // Left: the poster, centred in its column so it never sits top-heavy.
  const ICON = 116;
  const TEMP_H = 70;
  const LABEL_H = 27;
  const RANGE_H = 26;
  const posterHeight = ICON + 14 + TEMP_H + LABEL_H + 8 + RANGE_H;
  const leftCx = columns.leftX + columns.leftWidth / 2;

  let y = Math.max(ruleY + 20, ruleY + 20 + (bodyBottom - ruleY - 20 - posterHeight) / 2);
  weatherIcon(ctx, forecast.icon, leftCx, y + ICON / 2, ICON);
  y += ICON + 14;
  centeredOn(ctx, `${forecast.now}°`, leftCx, y, `700 54px ${SANS}`);
  y += TEMP_H;
  centeredOn(ctx, forecast.label, leftCx, y, `19px ${SANS}`);
  y += LABEL_H + 8;
  centeredOn(ctx, `H ${forecast.hi}°    L ${forecast.lo}°`, leftCx, y, `700 17px ${SANS}`);

  // Right: the two forecast strips, each under its own small label.
  let rightY = ruleY + 20;
  if (forecast.hours && forecast.hours.length) {
    label(ctx, 'NEXT HOURS', rightY, columns.rightX);
    rightY += 20;
    hourStrip(ctx, forecast, columns.rightX, columns.rightWidth, rightY);
    rightY += 108;
    ctx.fillRect(columns.rightX, rightY, columns.rightWidth, 1);
    rightY += 18;
  }
  if (forecast.days && forecast.days.length && rightY + 100 <= bodyBottom) {
    label(ctx, 'THE WEEK AHEAD', rightY, columns.rightX);
    rightY += 20;
    dayStrip(ctx, forecast, columns.rightX, columns.rightWidth, rightY);
  }

  let footerY = bodyBottom + 12;
  centered(
    ctx,
    `Feels ${forecast.feels}°     Wind ${forecast.wind} km/h     Rain ${forecast.precip}%`,
    footerY,
    `11px ${SANS}`,
  );
  if (footerLines === 2) {
    footerY += 18;
    centered(ctx, `Sunrise ${forecast.sunrise}     Sunset ${forecast.sunset}`, footerY, `11px ${SANS}`);
  }
}

export function drawWeather(canvas, forecast, showSunTimes, orientation = 'portrait') {
  const ctx = begin(canvas, orientation);
  if (!forecast) {
    return drawMessage(canvas, 'No forecast yet', 'Set a location on the Content tab.', null, orientation);
  }
  if (PANEL_W > PANEL_H) return weatherLandscape(ctx, forecast, showSunTimes);

  let y = weatherHeader(ctx, forecast);

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
    hourStrip(ctx, forecast, L, W, y);
    y += 110;
  }

  if (forecast.days && forecast.days.length) {
    rule(ctx, y);
    y += 14;
    dayStrip(ctx, forecast, L, W, y);
  }

  let footerY = B - 24;
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

export function drawQuote(canvas, quote, orientation = 'portrait') {
  const ctx = begin(canvas, orientation);
  if (!quote) return drawMessage(canvas, 'No quotes', 'Add some on the Content tab.', null, orientation);

  const text = quote.text ?? quote.t;
  const author = quote.author ?? quote.a ?? '';

  // A full-width line is unreadable on the 800px frame, so the text is set to a
  // measure and the whole block is centred in what is left. The quote mark
  // hangs into the margin at the left of that block.
  ctx.font = `700 54px ${SANS}`;
  const markWidth = ctx.measureText('“').width;
  const measure = isLandscape() ? Math.min(W - markWidth - 40, 560) : W - markWidth - 12;
  const textX = L + (W - measure) / 2;

  const MARK_H = 46;
  const topLimit = MARGIN + MARK_H;
  const available = B - topLimit;
  const authorHeight = author ? 60 : 0;

  // Which size is right depends on the height actually available, so both
  // candidates are measured rather than choosing on line count alone.
  let size = 26;
  let lineHeight = size + 12;
  ctx.font = `${size}px ${SERIF}`;
  let lines = wrap(ctx, text, measure, 12);
  if (lines.length * lineHeight + authorHeight > available) {
    size = 19;
    lineHeight = size + 8;
    ctx.font = `${size}px ${SERIF}`;
    const cap = Math.max(1, Math.min(16, Math.floor((available - authorHeight) / lineHeight)));
    lines = wrap(ctx, text, measure, cap);
  }

  const blockHeight = lines.length * lineHeight + authorHeight;
  let y = Math.max(topLimit, topLimit + (available - blockHeight) / 2);

  ctx.textAlign = 'left';
  ctx.font = `700 54px ${SANS}`;
  ctx.fillText('“', textX - markWidth, y - MARK_H);

  ctx.font = `${size}px ${SERIF}`;
  for (const line of lines) {
    if (y + lineHeight > B) break;
    ctx.fillText(line, textX, y);
    y += lineHeight;
  }

  if (author && y + 40 <= B) {
    y += 14;
    ctx.fillRect(textX, y, 48, 2);
    y += 14;
    ctx.font = `italic 15px ${SANS}`;
    ctx.fillText(author, textX, y);
  }
}

/** The word itself, at the largest size that fits `width`. Returns the y below it. */
function wordHeadline(ctx, word, x, width, y) {
  ctx.textAlign = 'left';
  let size = 54;
  ctx.font = `700 ${size}px ${SANS}`;
  if (ctx.measureText(word.word).width > width) {
    size = 26;
    ctx.font = `700 ${size}px ${SANS}`;
  }
  if (ctx.measureText(word.word).width > width) {
    size = 19;
    ctx.font = `700 ${size}px ${SANS}`;
  }
  ctx.fillText(word.word, x, y);
  return y + Math.round(size * 1.36) + 4;
}

export function drawWord(canvas, word, orientation = 'portrait') {
  const ctx = begin(canvas, orientation);
  if (!word) {
    return drawMessage(canvas, 'No words', 'The built-in list will be sent on the next sync.', null, orientation);
  }

  const ruleY = faceHeader(ctx, 'WORD OF THE DAY');
  const meta = [word.pron, word.pos].filter(Boolean).join('   |   ');
  const DEF_LINE = 27;
  const EX_LINE = 24;
  const exampleBudget = word.ex ? 44 + 2 * EX_LINE : 0;

  if (isLandscape()) {
    // The word and how to say it get a narrow left column; the meaning gets the
    // whole right one, so the definition has real measure to wrap into.
    const columns = splitColumns(38);
    columnDivider(ctx, columns, ruleY + 22, B - 8);

    const leftY = wordHeadline(ctx, word, columns.leftX, columns.leftWidth, ruleY + 34);
    if (meta) {
      paragraph(ctx, meta, columns.leftX, columns.leftWidth, leftY, B, 22, 3, `italic 15px ${SANS}`);
    }

    let rightY = paragraph(ctx, word.def, columns.rightX, columns.rightWidth, ruleY + 34, B - exampleBudget,
                           DEF_LINE, 6, `19px ${SANS}`);
    if (word.ex && rightY + 44 + EX_LINE <= B) {
      rightY += 24;
      ctx.fillRect(columns.rightX, rightY, 48, 2);
      rightY += 18;
      paragraph(ctx, word.ex, columns.rightX, columns.rightWidth, rightY, B, EX_LINE, 4, `italic 17px ${SERIF}`);
    }
    return;
  }

  let y = wordHeadline(ctx, word, L, W, ruleY + 40);
  if (meta) {
    ctx.font = `italic 15px ${SANS}`;
    ctx.textAlign = 'left';
    ctx.fillText(meta, L, y);
    y += 42;
  }

  rule(ctx, y);
  y += 22;

  y = paragraph(ctx, word.def, L, W, y, B - exampleBudget, DEF_LINE, 6, `19px ${SANS}`);

  if (word.ex && y + 44 + EX_LINE <= B) {
    y += 26;
    ctx.fillRect(L, y, 48, 2);
    y += 18;
    paragraph(ctx, word.ex, L, W, y, B, EX_LINE, 5, `italic 17px ${SERIF}`);
  }
}

export function drawCountdown(canvas, events, orientation = 'portrait') {
  const ctx = begin(canvas, orientation);
  if (!events || !events.length) {
    return drawMessage(canvas, 'Nothing scheduled', 'Add a date on the Content tab.', null, orientation);
  }

  const ruleY = faceHeader(ctx, 'COUNTING DOWN');
  const [next, ...rest] = events;
  const landscape = isLandscape();

  // Landscape sets the headline event beside the list; portrait stacks them.
  const columns = splitColumns(46);
  const heroX = landscape ? columns.leftX : L;
  const heroWidth = landscape ? columns.leftWidth : W;
  const heroCx = heroX + heroWidth / 2;
  const listX = landscape ? columns.rightX : L;
  const listWidth = landscape ? columns.rightWidth : W;
  const listRight = listX + listWidth;

  let y = ruleY + (landscape ? 36 : 48);
  if (next.days === 0) {
    centeredOn(ctx, 'TODAY', heroCx, y + 30, `700 26px ${SANS}`);
    y += 30 + 38;
  } else {
    centeredOn(ctx, String(next.days), heroCx, y, `700 54px ${SANS}`);
    y += 70;
    centeredOn(ctx, next.days === 1 ? 'day until' : 'days until', heroCx, y, `15px ${SANS}`);
    y += 22;
  }
  y += 22;

  const TITLE_LINE = 38;
  ctx.font = `700 26px ${SANS}`;
  for (const line of wrap(ctx, next.title, heroWidth, 2)) {
    if (y + TITLE_LINE > B) break;
    centeredOn(ctx, line, heroCx, y, `700 26px ${SANS}`);
    y += TITLE_LINE;
  }

  if (rest.length) {
    let listY;
    if (landscape) {
      columnDivider(ctx, columns, ruleY + 22, B - 8);
      label(ctx, 'ALSO COMING UP', ruleY + 24, listX);
      listY = ruleY + 48;
    } else {
      listY = y + 40;
      rule(ctx, listY);
      listY += 20;
    }

    const ROW = 38;
    for (const event of rest) {
      if (listY + ROW > B) break;
      const count = event.days === 0 ? 'today' : `${event.days} ${event.days === 1 ? 'day' : 'days'}`;
      ctx.font = `700 17px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillText(count, listRight, listY);
      ctx.textAlign = 'left';
      ctx.font = `17px ${SANS}`;
      ctx.fillText(event.title, listX, listY);
      listY += ROW;
    }
  }
}

export function drawHistory(canvas, entry, orientation = 'portrait') {
  const ctx = begin(canvas, orientation);
  if (!entry) {
    return drawMessage(canvas, 'On this day', 'Enable the Wikipedia lookup on the Content tab, then sync.', null,
                       orientation);
  }

  const ruleY = faceHeader(ctx, 'ON THIS DAY');
  const LINE = 40;

  if (isLandscape()) {
    // The year is the hook, so it becomes a column of its own rather than a
    // banner that eats a third of the 480px height.
    const columns = splitColumns(30);
    columnDivider(ctx, columns, ruleY + 22, B - 8);
    ctx.textAlign = 'left';
    ctx.font = `700 26px ${SANS}`;
    if (entry.y) ctx.fillText(String(entry.y), columns.leftX, ruleY + 40);
    paragraph(ctx, entry.t, columns.rightX, columns.rightWidth, ruleY + 40, B, LINE, 10, `26px ${SERIF}`);
    return;
  }

  let y = ruleY + 46;
  if (entry.y) {
    ctx.textAlign = 'left';
    ctx.font = `700 26px ${SANS}`;
    ctx.fillText(String(entry.y), L, y);
    y += 60;
  }
  paragraph(ctx, entry.t, L, W, y, B, LINE, 10, `26px ${SERIF}`);
}

/**
 * Empty state for a face with nothing to show. It sizes the canvas itself: it
 * is often the first thing drawn after an orientation change, and a stale
 * canvas would keep the old frame's shape.
 */
export function drawMessage(canvas, title, line1, line2, orientation = 'portrait') {
  const ctx = begin(canvas, orientation);

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

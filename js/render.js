// Image pipeline. Photos are cropped to the panel, tone-mapped, and sent as
// grayscale JPEGs; the device re-decodes them and dithers to four levels with
// the same Atkinson kernel and thresholds mirrored below, so what this module
// previews is what the panel shows (bar JPEG artefacts).

export const PANEL_W = 480;
export const PANEL_H = 800;

/** Panel luminance the firmware assigns to each 2-bit level (BitmapHelpers.h). */
const LEVEL_VALUE = [15, 30, 80, 210];

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export async function decode(file) {
  return createImageBitmap(file);
}

/**
 * Scale/crop `bitmap` into the panel and return an 8-bit grayscale plane.
 * `fit` is 'cover' (fill, cropping the overflow) or 'contain' (letterbox white).
 */
export function toPanelGray(bitmap, { fit = 'cover', brightness = 0, contrast = 1.15 } = {}) {
  const canvas = makeCanvas(PANEL_W, PANEL_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PANEL_W, PANEL_H);

  const scale = fit === 'contain'
    ? Math.min(PANEL_W / bitmap.width, PANEL_H / bitmap.height)
    : Math.max(PANEL_W / bitmap.width, PANEL_H / bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, Math.round((PANEL_W - w) / 2), Math.round((PANEL_H - h) / 2), w, h);

  const img = ctx.getImageData(0, 0, PANEL_W, PANEL_H);
  const px = img.data;
  const gray = new Uint8ClampedArray(PANEL_W * PANEL_H);
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    // Rec. 601 luma, matching what JPEGDEC hands the firmware for colour input.
    let v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    v = (v - 128) * contrast + 128 + brightness;
    gray[g] = v;
  }
  return gray;
}

/** Wrap a grayscale plane back into a canvas so it can be encoded or drawn. */
function grayToCanvas(gray, mapLevel = false) {
  const canvas = makeCanvas(PANEL_W, PANEL_H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(PANEL_W, PANEL_H);
  const px = img.data;
  for (let g = 0, i = 0; g < gray.length; g++, i += 4) {
    const v = mapLevel ? LEVEL_VALUE[gray[g]] : gray[g];
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export async function grayToJpegBytes(gray, quality = 0.72) {
  const canvas = grayToCanvas(gray);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Atkinson dithering to four levels — a direct port of AtkinsonDitherer in
 * lib/GfxRenderer/BitmapHelpers.h, including the X4-tuned thresholds. Returns a
 * plane of level indices (0-3).
 */
export function dither4(gray, w = PANEL_W, h = PANEL_H) {
  const out = new Uint8Array(w * h);
  // Three error rows, matching the kernel's two-rows-down reach.
  let e0 = new Int16Array(w + 4);
  let e1 = new Int16Array(w + 4);
  let e2 = new Int16Array(w + 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = gray[y * w + x] + e0[x + 2];
      if (v < 0) v = 0; else if (v > 255) v = 255;

      let level, value;
      if (v < 30)       { level = 0; value = 15; }
      else if (v < 50)  { level = 1; value = 30; }
      else if (v < 140) { level = 2; value = 80; }
      else              { level = 3; value = 210; }
      out[y * w + x] = level;

      const err = (v - value) >> 3;          // only 6/8 of the error is spread
      e0[x + 3] += err;
      e0[x + 4] += err;
      e1[x + 1] += err;
      e1[x + 2] += err;
      e1[x + 3] += err;
      e2[x + 2] += err;
    }
    const t = e0; e0 = e1; e1 = e2; e2 = t;
    e2.fill(0);
  }
  return out;
}

/** Draw a dithered plane onto a visible canvas at panel resolution. */
export function paintLevels(canvas, levels) {
  canvas.width = PANEL_W;
  canvas.height = PANEL_H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(PANEL_W, PANEL_H);
  const px = img.data;
  for (let g = 0, i = 0; g < levels.length; g++, i += 4) {
    const v = LEVEL_VALUE[levels[g]];
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Full pipeline for one file: panel-sized JPEG bytes plus the dithered preview.
 */
export async function processPhoto(file, opts) {
  const bitmap = await decode(file);
  try {
    const gray = toPanelGray(bitmap, opts);
    const jpeg = await grayToJpegBytes(gray, opts.quality);
    return { gray, jpeg, levels: dither4(gray) };
  } finally {
    bitmap.close?.();
  }
}

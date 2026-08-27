/**
 * Per-frame header: a small binary barcode reading "I am character k of n".
 *
 * This is what makes the animated format robust. Without it the decoder would
 * have to trust frame ordering and frame counts, and neither survives a video
 * pipeline -- players drop frames, seeking is not frame-accurate, and a
 * re-encode can duplicate them. With it, every frame stands alone: frames can
 * arrive out of order, be duplicated, or go missing, and the only consequence of
 * a lost frame is one character reported as unknown.
 *
 * Cells are pure black or pure white, sampled at their centres, so nothing here
 * depends on colour fidelity at all.
 */

export type FrameHeader = { k: number; n: number };

/** Bits per field. 10 bits caps a message at 1023 characters. */
const FIELD_BITS = 10;
/** [1, 0] start marker, k, n, then even parity over k and n. */
const CELLS = 2 + FIELD_BITS * 2 + 1;

export type HeaderLayout = { x: number; y: number; cell: number; cells: number };

/** Fixed position derived from the canvas size, so the decoder can find it exactly. */
export function headerLayout(W: number, H: number): HeaderLayout {
  const cell = Math.max(4, Math.round(Math.min(W, H) / 110));
  const pad = Math.round(Math.min(W, H) * 0.02);
  return { x: pad + cell, y: pad + cell, cell, cells: CELLS };
}

function bitsOf({ k, n }: FrameHeader): number[] {
  const field = (v: number) =>
    Array.from({ length: FIELD_BITS }, (_, i) => (v >> (FIELD_BITS - 1 - i)) & 1);
  const body = [...field(k), ...field(n)];
  const parity = body.reduce((a, b) => a ^ b, 0);
  return [1, 0, ...body, parity];
}

export function drawFrameHeader(ctx: CanvasRenderingContext2D, W: number, H: number, header: FrameHeader) {
  const { x, y, cell } = headerLayout(W, H);
  // Backing plate: the header must read the same over a white or black preset.
  ctx.fillStyle = "#000000";
  ctx.fillRect(x - cell, y - cell, (CELLS + 2) * cell, 3 * cell);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - cell / 2, y - cell / 2, (CELLS + 1) * cell, 2 * cell);
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, CELLS * cell, cell);

  bitsOf(header).forEach((bit, i) => {
    ctx.fillStyle = bit ? "#ffffff" : "#000000";
    ctx.fillRect(x + i * cell, y, cell, cell);
  });
}

export type PixelSource = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };

/** Returns null when the plate is absent or fails its parity check. */
export function readFrameHeader(img: PixelSource): FrameHeader | null {
  return readHeaderAt(img, 0, 0, img.width, img.height);
}

/**
 * Read a frame's header without slicing it out first.
 *
 * Sheet layouts are recovered by trying each candidate n, and cropping a full
 * tile per candidate would allocate megabytes per guess for a file that may not
 * be a sheet at all. Reading in place costs 23 pixel lookups.
 */
function readHeaderAt(img: PixelSource, ox: number, oy: number, w: number, h: number): FrameHeader | null {
  const { x, y, cell } = headerLayout(w, h);
  const bits: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    const px = Math.round(ox + x + i * cell + cell / 2);
    const py = Math.round(oy + y + cell / 2);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
    const o = (py * img.width + px) * 4;
    const luma = (img.data[o] * 0.299 + img.data[o + 1] * 0.587 + img.data[o + 2] * 0.114) / 255;
    bits.push(luma > 0.5 ? 1 : 0);
  }

  if (bits[0] !== 1 || bits[1] !== 0) return null;
  const body = bits.slice(2, 2 + FIELD_BITS * 2);
  if (body.reduce((a, b) => a ^ b, 0) !== bits[bits.length - 1]) return null;

  const num = (from: number) => body.slice(from, from + FIELD_BITS).reduce((a, b) => (a << 1) | b, 0);
  const k = num(0);
  const n = num(FIELD_BITS);
  if (n < 1 || k >= n) return null;
  return { k, n };
}

// --- sprite sheet ------------------------------------------------------------

/**
 * All frames tiled into one lossless image.
 *
 * A video container is the natural home for frames, but it needs a working
 * encoder and a frame-accurate way back out, and neither is guaranteed. A sheet
 * needs neither: it is an ordinary PNG, every frame is exact, and slicing it is
 * arithmetic.
 */
export const sheetCols = (n: number) => Math.ceil(Math.sqrt(n));
export const sheetRows = (n: number) => Math.ceil(n / sheetCols(n));

/** Highest n a sheet may claim, matching the header's 10-bit fields. */
const MAX_FRAMES = 1023;

/**
 * Slice a sheet back into frames, or null if this is not one.
 *
 * The tile size is unknown until n is known, and n lives inside a tile, so the
 * layout is recovered by proposing each n in turn and checking whether the
 * implied tile 0 carries a header that agrees. The header's parity bit makes a
 * false agreement vanishingly unlikely.
 */
export function sheetTiles(img: PixelSource): PixelSource[] | null {
  for (let n = 2; n <= MAX_FRAMES; n++) {
    const cols = sheetCols(n);
    const rows = sheetRows(n);
    if (img.width % cols !== 0 || img.height % rows !== 0) continue;
    const tw = img.width / cols;
    const th = img.height / rows;
    if (tw < 200 || th < 200) continue;

    const header = readHeaderAt(img, 0, 0, tw, th);
    if (!header || header.k !== 0 || header.n !== n) continue;

    const tiles: PixelSource[] = [];
    for (let k = 0; k < n; k++) {
      tiles.push(cropTile(img, (k % cols) * tw, Math.floor(k / cols) * th, tw, th));
    }
    return tiles;
  }
  return null;
}

function cropTile(img: PixelSource, x0: number, y0: number, w: number, h: number): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

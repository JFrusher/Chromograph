/**
 * The frame the laptop displays for a phone camera to read.
 *
 * The artwork itself is unchanged -- `drawChromograph` renders into the middle of
 * this frame exactly as it renders into an export. What is added around it is
 * registration furniture, carrying no payload: four corner fiducials that pin the
 * projective transform, and a header band stating which character this frame is.
 *
 * The layout is a frozen constant rather than a function of the canvas size, and
 * that is the one real departure from `isoRect`/`plotRect`. Those derive their
 * geometry from the image dimensions because encoder and decoder share them. Here
 * they do not: the phone sees a quadrilateral and has no idea whether the monitor
 * is 1920 wide or 3840. So both sides hardcode this composition, and the display
 * scales it to fit with a single transform.
 *
 * Coordinates put the artwork's top-left at the origin, so negative values are
 * the furniture above and to the left of it.
 */

import { MAX_CHARS } from "./grid.ts";
import { contrastInk, type Preset } from "./palette.ts";
import { drawChromograph, type RenderParams } from "./render.ts";

const INNER_W = 1200;
const INNER_H = 900;
/** Clear background between artwork and band, so neither bleeds into the other. */
const GAP = 18;
/** Thickness of the band annulus, and the side of a fiducial square. */
const BAND = 48;
/** Background beyond the annulus. Gives the blob finder an edge to work against. */
const QUIET = 48;

/** Cells per band edge: see `bandBits`. */
const CELLS = 30;

const B0 = -(GAP + BAND); // outer edge of the top/left annulus
const B1 = -GAP; //          inner edge of the top/left annulus

/**
 * Where a band's cells run: the span *between* the fiducials, which occupy the
 * annulus corners. Nothing else lives in the annulus, so a cell and a fiducial
 * can never be mistaken for one another by position.
 */
const RUN_X = { from: B1, to: INNER_W - B1 }; // top and bottom bands
const RUN_Y = { from: B1, to: INNER_H - B1 }; // left and right bands

/** Top, bottom, left, right. */
export type Edge = 0 | 1 | 2 | 3;

export const SHOW = {
  inner: { x: 0, y: 0, w: INNER_W, h: INNER_H },
  band: BAND,
  gap: GAP,
  cells: CELLS,
  /** Side of a fiducial square. */
  fidSize: BAND,

  /** The whole composition, quiet zone included. */
  total: {
    x: B0 - QUIET,
    y: B0 - QUIET,
    w: INNER_W - 2 * B0 + 2 * QUIET,
    h: INNER_H - 2 * B0 + 2 * QUIET,
  },

  /**
   * Fiducial centres, in the order the detector reports them: top-left,
   * top-right, bottom-right, bottom-left. These four points are the entire
   * correspondence the homography is fitted through.
   *
   * The rectangle they form is deliberately not square. A wrong 90 degree
   * orientation hypothesis then produces a quad of visibly wrong aspect, which
   * is a free pre-filter before anything is spent on reading cells.
   */
  fid: [
    { x: B0 + BAND / 2, y: B0 + BAND / 2 },
    { x: INNER_W - B0 - BAND / 2, y: B0 + BAND / 2 },
    { x: INNER_W - B0 - BAND / 2, y: INNER_H - B0 - BAND / 2 },
    { x: B0 + BAND / 2, y: INNER_H - B0 - BAND / 2 },
  ] as const,

  /** Width and height of one band cell on a given edge. */
  cellSize(edge: Edge): { w: number; h: number } {
    const along = edge < 2 ? (RUN_X.to - RUN_X.from) / CELLS : (RUN_Y.to - RUN_Y.from) / CELLS;
    return edge < 2 ? { w: along, h: BAND } : { w: BAND, h: along };
  },

  /** Centre of cell `i` on a given edge, in show coordinates. */
  cellCentre(edge: Edge, i: number): { x: number; y: number } {
    const t = i + 0.5;
    const alongX = RUN_X.from + (t * (RUN_X.to - RUN_X.from)) / CELLS;
    const alongY = RUN_Y.from + (t * (RUN_Y.to - RUN_Y.from)) / CELLS;
    switch (edge) {
      case 0:
        return { x: alongX, y: B0 + BAND / 2 };
      case 1:
        return { x: alongX, y: INNER_H - B0 - BAND / 2 };
      case 2:
        return { x: B0 + BAND / 2, y: alongY };
      default:
        return { x: INNER_W - B0 - BAND / 2, y: alongY };
    }
  },
} as const;

/**
 * Stroke width used on the display, overriding whatever the studio slider says.
 *
 * The marker is a square of half-side `max(6, thickness * min(W,H)/1000 * 1.6)`.
 * At the inner size that scale is 0.9, so thickness 6 gives a 17px marker, which
 * shrinks to about 9px once rectified into the decode buffer -- around 85 pixels,
 * barely over `MIN_MARKER_PIXELS` before lens blur erodes the core. Thickness 10
 * gives roughly 237 pixels instead, and a fatter stroke reads better through a
 * lens anyway.
 *
 * A knob, not a constant: raise it if characters go missing, lower it if the
 * curve looks too heavy.
 */
export const SHOW_THICKNESS = 10;

// --- band codec --------------------------------------------------------------

const SYNC = [1, 0, 1, 1] as const;
/** MAX_CHARS is 120, so seven bits covers the whole range of both fields. */
const FIELD_BITS = 7;
/** Which of the four edges this band is. See `bandBits`. */
const EDGE_BITS = 2;

/**
 * CRC-8/ATM over the two payload bytes. Bitwise, no table -- it runs sixteen
 * times per band, not per pixel.
 *
 * The file format's single parity bit is far too weak here. A camera makes
 * correlated errors, and a misread band that still parses becomes a wrong
 * character committed silently, with nothing downstream to catch it. This has
 * Hamming distance 4 at this length, so every one, two and three bit error is
 * rejected.
 */
function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const bitsOf = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1);
const numOf = (bits: number[]) => bits.reduce((a, b) => (a << 1) | b, 0);

/**
 * The 30-bit word a band carries: guard, sync, edge id, k, n, CRC, guard.
 *
 * The guards at both ends are always clear, so a set cell can never be
 * four-connected to a fiducial and merge with it into a single blob. Two cells of
 * budget is a cheaper fix than a pixel gap that would have to be tuned.
 *
 * The edge id is what actually rejects a rotated reading, and it is not
 * redundant with the sync word. Every edge runs in its own canonical direction,
 * so under a 90 degree wrong hypothesis the reader traverses a *different*
 * physical edge along that edge's own forward direction and receives an
 * undamaged word: sync intact, CRC intact, k and n correct, and a marker read
 * out of a rotated warp that decodes to the wrong character with nothing left to
 * catch it. Naming the edge inside the CRC turns that into a deterministic
 * mismatch instead of a bet on how far perspective can skew an aspect ratio.
 * A 180 degree hypothesis reverses the word and dies on sync as expected.
 */
export function bandBits(k: number, n: number, edge: Edge): number[] {
  const body = [...bitsOf(edge, EDGE_BITS), ...bitsOf(k, FIELD_BITS), ...bitsOf(n, FIELD_BITS)];
  return [0, ...SYNC, ...body, ...bitsOf(crc8([k & 0x7f, n & 0x7f, edge & 0x03]), 8), 0];
}

/**
 * Read a band word back, or null if it is not the word this edge should carry.
 *
 * The sync word earns its four cells three times over. It rejects a reversed
 * reading, it confirms polarity so an inverted image is thrown out rather than
 * quietly misread, and it guarantees the band holds both a set and a clear cell
 * -- which is what lets the reader threshold against that band's own extremes
 * instead of a global one.
 */
export function parseBand(bits: number[], expectEdge: Edge): { k: number; n: number } | null {
  if (bits.length !== CELLS) return null;
  if (bits[0] !== 0 || bits[CELLS - 1] !== 0) return null;
  for (let i = 0; i < SYNC.length; i++) if (bits[1 + i] !== SYNC[i]) return null;

  let at = 1 + SYNC.length;
  const edge = numOf(bits.slice(at, at + EDGE_BITS));
  at += EDGE_BITS;
  const k = numOf(bits.slice(at, at + FIELD_BITS));
  at += FIELD_BITS;
  const n = numOf(bits.slice(at, at + FIELD_BITS));
  at += FIELD_BITS;
  const crc = numOf(bits.slice(at, at + 8));

  if (crc8([k, n, edge]) !== crc) return null;
  if (edge !== expectEdge) return null;
  if (n < 1 || k >= n || n > MAX_CHARS) return null;
  return { k, n };
}

// --- drawing -----------------------------------------------------------------

export type ShowOptions = {
  text: string;
  params: RenderParams;
  preset: Preset;
  frame: { k: number; n: number };
};

/**
 * Draw one display frame, in show coordinates. The caller places and scales it.
 *
 * The artwork goes down through the untouched `drawChromograph`, translated into
 * the inner rect -- the same translate-and-draw the sprite sheet export already
 * uses. Its own small header plate comes along with it, which costs nothing and
 * means a screenshot cropped to the artwork still opens in the existing decoder.
 * The camera never reads that plate: its cells are a hundred-and-tenth of the
 * frame sampled at a single pixel, which is exactly the scale a lens destroys.
 */
export function drawShowFrame(ctx: CanvasRenderingContext2D, o: ShowOptions): void {
  const { total } = SHOW;
  const ink = contrastInk(o.preset.bg);

  ctx.save();
  ctx.fillStyle = o.preset.bg;
  ctx.fillRect(total.x, total.y, total.w, total.h);

  ctx.fillStyle = "rgb(" + ink.r + "," + ink.g + "," + ink.b + ")";
  for (const f of SHOW.fid) ctx.fillRect(f.x - BAND / 2, f.y - BAND / 2, BAND, BAND);

  // Each edge runs in its own canonical direction -- top and bottom left to
  // right, left and right top to bottom -- and names itself, so a rotated
  // reading lands the wrong edge id in the slot and is rejected outright.
  //
  // Four edges rather than one is also the tearing defence. A camera exposure
  // straddling a display transition reads bands from both frames, so they
  // disagree on k and the frame is thrown away. Requiring the same answer on two
  // successive camera frames would not do it: a free-running camera holds phase
  // against the display for hundreds of milliseconds, so a tear reproduces at
  // the same scanline and the same wrong answer arrives twice.
  for (const edge of [0, 1, 2, 3] as Edge[]) {
    const { w, h } = SHOW.cellSize(edge);
    bandBits(o.frame.k, o.frame.n, edge).forEach((bit, i) => {
      if (!bit) return;
      const c = SHOW.cellCentre(edge, i);
      ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h);
    });
  }

  ctx.save();
  ctx.translate(SHOW.inner.x, SHOW.inner.y);
  drawChromograph(ctx, {
    text: o.text,
    params: { ...o.params, mode: "iso", thickness: SHOW_THICKNESS },
    preset: o.preset,
    width: SHOW.inner.w,
    height: SHOW.inner.h,
    frame: o.frame,
  });
  ctx.restore();
  ctx.restore();
}

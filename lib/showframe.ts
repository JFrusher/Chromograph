/**
 * The frame the laptop displays for a phone camera to read.
 *
 * A white disc holding the artwork, ringed by a black band whose outer edge is
 * scalloped into bumps and indents. The band carries no payload of its own: four
 * holes punched through it at the diagonals pin the projective transform, and the
 * scalloping states which character this frame is.
 *
 * The shape does structural work as well as visual:
 *
 *  - The white disc *circumscribes* the artwork square, so the rectified
 *    buffer's four corners land inside it and read as ground. That is exactly
 *    where `markerAt` samples the background from, so nothing downstream of the
 *    rectification has to know the composition changed.
 *  - The anchors are holes rather than bumps because a band is a single
 *    connected blob -- anything attached to it has no centroid of its own. A
 *    hole is an isolated bright region, while an indent stays connected to the
 *    page outside and is discarded along with it. So the only bright blobs in
 *    the frame are the four anchors, and there is nothing for them to compete
 *    with.
 *
 * The layout is a frozen constant rather than a function of the canvas size, and
 * that is the one real departure from `isoRect`/`plotRect`. Those derive their
 * geometry from the image dimensions because encoder and decoder share them. Here
 * they do not: the phone sees a quadrilateral and has no idea whether the monitor
 * is 1920 wide or 3840. So both sides hardcode this composition, and the display
 * scales it to fit with a single transform.
 *
 * Coordinates put the artwork's top-left at the origin, so the band runs negative
 * above and to the left of it.
 */

import { MAX_CHARS } from "./grid.ts";
import { type Preset } from "./palette.ts";
import { drawChromograph, type RenderParams } from "./render.ts";

/**
 * The artwork region, shaped to the scene rather than to the disc.
 *
 * ISO_BOX is 1.73 wide by 1.9 tall, and `isoRect` reserves a further 12% of the
 * smaller side to padding plus 8% of the height to the calibration bar's slot,
 * so the scene that actually gets drawn is markedly taller than it is wide. A
 * square region inscribed in the disc therefore wastes most of its width.
 *
 * These proportions are the ones that maximise the drawn scene for a given disc:
 * balancing isoRect's two limits puts the height at about 1.18 times the width,
 * which fits roughly a tenth more curve inside the same circle than a square
 * does. The disc, not the region, is what the eye reads as the shape.
 */
const INNER_W = 1108;
const INNER_H = 1307;

/** Half-diagonal of the artwork region: the smallest disc that can contain it. */
const INNER_HALF_DIAG = Math.hypot(INNER_W, INNER_H) / 2;

/** The white disc the artwork sits on, and the band's inner edge. */
const DISC_R = 862;

/**
 * Nominal outer edge of the band, and the radius the data is read at.
 *
 * A set cell bulges the edge out past this, a clear one scallops it in, so a
 * sample taken exactly here is inside the band for a 1 and outside it for a 0.
 */
const BAND_R = 990;
/** How far a bump reaches out, and an indent cuts in. */
const BUMP = 30;

/** Anchor holes: centred in the band, in the flat gaps between the data arcs. */
const ANCHOR_R = 926;
const ANCHOR_D = 80;

/** Degrees of arc each of the four data runs occupies, out of the 90 available. */
const ARC_SPAN = 78;
/** Cells per arc: see `bandBits`. */
const CELLS = 30;

/** Ground beyond the band. Keeps blobs off the image edge. */
const QUIET = 50;

/** Centre of the composition, in artwork coordinates. */
const CX = INNER_W / 2;
const CY = INNER_H / 2;
const DEG = Math.PI / 180;

/** The axis each data arc is centred on: top, bottom, left, right. */
const ARC_CENTRE_DEG = [270, 90, 180, 0];
/** Angular width of one cell. */
const CELL_DEG = ARC_SPAN / CELLS;

/** Top, bottom, left, right. */
export type Edge = 0 | 1 | 2 | 3;

const norm360 = (d: number) => ((d % 360) + 360) % 360;

const onCircle = (deg: number, r: number) => ({
  x: CX + r * Math.cos(deg * DEG),
  y: CY + r * Math.sin(deg * DEG),
});

/** How far the composition reaches from its centre. */
const EXTENT = BAND_R + BUMP;

export const SHOW = {
  inner: { x: 0, y: 0, w: INNER_W, h: INNER_H },
  cells: CELLS,
  /** The white disc the artwork sits on. */
  disc: { x: CX, y: CY, r: DISC_R },
  bandRadius: BAND_R,
  bump: BUMP,
  fidSize: ANCHOR_D,

  /** The whole composition, quiet zone included. */
  total: {
    x: CX - EXTENT - QUIET,
    y: CY - EXTENT - QUIET,
    w: 2 * (EXTENT + QUIET),
    h: 2 * (EXTENT + QUIET),
  },

  /**
   * Anchor centres, in the order the detector reports them: top-left, top-right,
   * bottom-right, bottom-left. These four points are the entire correspondence
   * the homography is fitted through, which is why there are four and not three
   * -- three points fix only an affine transform, and a phone held at an angle
   * produces real perspective.
   *
   * On the diagonals, not on the axes. `cornerQuad` selects by the extremes of
   * x+y and x-y, and four points at top/right/bottom/left tie on both, so the
   * selection would be degenerate. The diagonals are also where the data arcs
   * leave a flat gap in the band, which is the room these need.
   */
  fid: [
    onCircle(225, ANCHOR_R),
    onCircle(315, ANCHOR_R),
    onCircle(45, ANCHOR_R),
    onCircle(135, ANCHOR_R),
  ] as const,

  /**
   * Where cell `i` of an arc is read, on the nominal band edge.
   *
   * Every arc runs clockwise and names itself in its word. A rotated hypothesis
   * therefore samples a real arc and gets an undamaged reading whose arc id is
   * wrong, which is rejected outright rather than by a bet on how far
   * perspective can skew an aspect ratio.
   */
  cellCentre(edge: Edge, i: number): { x: number; y: number } {
    return onCircle(ARC_CENTRE_DEG[edge] - ARC_SPAN / 2 + (i + 0.5) * CELL_DEG, BAND_R);
  },
} as const;

// The disc has to contain the artwork square, or the rectified buffer's corners
// fall outside it, markerAt reads the background from the band instead, and the
// marker's polarity comes out backwards. Cheap to assert, and it fires at import
// rather than in the field.
if (DISC_R <= INNER_HALF_DIAG) {
  throw new Error(`DISC_R ${DISC_R} does not contain the artwork region (needs > ${INNER_HALF_DIAG})`);
}
// An anchor hole must sit clear of both edges of the band, including where an
// indent cuts the outer edge inwards.
if (ANCHOR_R - ANCHOR_D / 2 <= DISC_R || ANCHOR_R + ANCHOR_D / 2 >= BAND_R) {
  throw new Error("anchor holes do not fit inside the band");
}

/**
 * Stroke width used on the display, overriding whatever the studio slider says.
 *
 * The marker is a square of half-side `max(6, thickness * min(W,H)/1000 * 1.6)`.
 * What matters is how many of its pixels survive to `markerAt`, which needs
 * `MIN_MARKER_PIXELS` of them.
 *
 * A round composition costs marker pixels, and this is where that is paid back:
 * a square pattern is height-limited in a 16:9 camera frame, so it fills less of
 * that frame than a landscape rectangle would. Measured against a lens blur,
 * this leaves roughly five times the floor -- the margin that survives a focus
 * hunt or a glare pass.
 *
 * A knob, not a constant: lower it if the curve looks too heavy.
 */
export const SHOW_THICKNESS = 22;

// --- band codec --------------------------------------------------------------

const SYNC = [1, 0, 1, 1] as const;
/** MAX_CHARS is 120, so seven bits covers the whole range of both fields. */
const FIELD_BITS = 7;
/** Which of the four arcs this word belongs to. See `bandBits`. */
const EDGE_BITS = 2;

/**
 * CRC-8/ATM over the payload bytes. Bitwise, no table -- it runs sixteen times
 * per arc, not per pixel.
 *
 * The file format's single parity bit is far too weak here. A camera makes
 * correlated errors, and a misread word that still parses becomes a wrong
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
 * The 30-bit word an arc carries: guard, sync, arc id, k, n, CRC, guard.
 *
 * The guards at both ends are always clear, so the cells nearest an anchor are
 * always indents -- the band keeps its full thickness where the holes are.
 *
 * The arc id is what actually rejects a rotated reading, and it is not redundant
 * with the sync word. Every arc runs in the same direction, so under a 90 degree
 * wrong hypothesis the reader traverses a *different* arc along that arc's own
 * forward direction and receives an undamaged word: sync intact, CRC intact, k
 * and n correct, and a marker read out of a rotated rectification that decodes
 * to the wrong character with nothing left to catch it. Naming the arc inside
 * the CRC turns that into a deterministic mismatch. A 180 degree hypothesis
 * lands on a different arc too, and is rejected the same way.
 */
export function bandBits(k: number, n: number, edge: Edge): number[] {
  const body = [...bitsOf(edge, EDGE_BITS), ...bitsOf(k, FIELD_BITS), ...bitsOf(n, FIELD_BITS)];
  return [0, ...SYNC, ...body, ...bitsOf(crc8([k & 0x7f, n & 0x7f, edge & 0x03]), 8), 0];
}

/**
 * Read an arc's word back, or null if it is not the word this arc should carry.
 *
 * The sync word earns its four cells three times over. It rejects a reversed
 * reading, it confirms polarity so an inverted image is thrown out rather than
 * quietly misread, and it guarantees the arc holds both a set and a clear cell
 * -- which is what lets the reader threshold against that arc's own extremes
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

// --- band profile ------------------------------------------------------------

/**
 * Angular resolution the edge is precomputed at. A tenth of a degree is under
 * two units of arc at the band's radius, so the curve reads as continuous, and
 * one table serves both the renderer and the reader without recomputing an
 * interpolation per pixel.
 */
const PROFILE_STEPS = 3600;

/** Where a control point sits: the cell centres, plus the flat gaps between arcs. */
function bandControls(k: number, n: number): { deg: number; r: number }[] {
  const out: { deg: number; r: number }[] = [];
  for (let e = 0; e < 4; e++) {
    const word = bandBits(k, n, e as Edge);
    for (let i = 0; i < CELLS; i++) {
      out.push({
        deg: norm360(ARC_CENTRE_DEG[e] - ARC_SPAN / 2 + (i + 0.5) * CELL_DEG),
        r: BAND_R + (word[i] ? BUMP : -BUMP),
      });
    }
  }
  // The diagonals stay at the nominal radius, which is the room the anchors need.
  for (let g = 0; g < 4; g++) out.push({ deg: norm360(45 + 90 * g), r: BAND_R });
  return out.sort((a, b) => a.deg - b.deg);
}

/**
 * The band's outer edge for one frame, sampled around the whole circle.
 *
 * The bit is the value *at* a cell centre, and the edge eases between one centre
 * and the next rather than returning to nominal at every boundary. Two set cells
 * in a row therefore merge into a single broad lobe instead of two separate
 * teeth, which is what makes the edge read as a flowing wave rather than a saw.
 *
 * It also reads better. Returning to nominal between cells puts the edge at half
 * amplitude a quarter of a cell either side of centre; easing between centres
 * holds it at seven tenths there, and at full amplitude whenever the neighbouring
 * bit agrees. The sampler is most decisive exactly where the decision is made.
 */
export function bandProfile(k: number, n: number): Float64Array {
  const ctrl = bandControls(k, n);
  const out = new Float64Array(PROFILE_STEPS);

  for (let s = 0; s < PROFILE_STEPS; s++) {
    const deg = (s * 360) / PROFILE_STEPS;
    let i = ctrl.length - 1;
    for (let c = 0; c < ctrl.length; c++) if (ctrl[c].deg <= deg) i = c;
    const a = ctrl[i];
    const b = ctrl[(i + 1) % ctrl.length];
    let span = b.deg - a.deg;
    if (span <= 0) span += 360;
    let into = deg - a.deg;
    if (into < 0) into += 360;
    const u = span === 0 ? 0 : into / span;
    out[s] = a.r + ((b.r - a.r) * (1 - Math.cos(Math.PI * u))) / 2;
  }
  return out;
}

/** The band's outer radius at an angle, from a precomputed profile. */
export const radiusAt = (profile: Float64Array, deg: number) =>
  profile[Math.floor((norm360(deg) / 360) * PROFILE_STEPS) % PROFILE_STEPS];

// --- drawing -----------------------------------------------------------------

/** The page, and the disc the artwork sits on. */
export const SHOW_GROUND = "#ffffff";
/** The band. */
export const SHOW_INK = "#000000";

/**
 * The artwork's palette, fixed rather than chosen.
 *
 * Its background is the white disc, so the marker is black. That is the harder
 * polarity for `markerAt`, whose achromatic test is a saturation ratio and so
 * degenerates towards black -- which is exactly what `normalise` corrects for
 * before the marker is looked for.
 *
 * `hueOrdered` is false, and has to be: a monochromatic curve has no hue left to
 * carry the character order. That costs nothing here, because the order comes
 * from the band instead.
 */
export const SHOW_PRESET: Preset = {
  id: "show",
  name: "Display",
  bg: SHOW_GROUND,
  sat: 100,
  light: 45,
  hueOrdered: false,
  hue: 214,
};

export type ShowOptions = {
  text: string;
  params: RenderParams;
  frame: { k: number; n: number };
};

/** Angular step the band's outer edge is drawn at. Fine enough to read as a curve. */
const EDGE_STEP_DEG = 0.4;

/**
 * Draw one display frame, in show coordinates. The caller places and scales it.
 *
 * The artwork goes down through the untouched `drawChromograph`, translated into
 * the inner square -- the same translate-and-draw the sprite sheet export already
 * uses. It fills that square with its own background, which is invisible here
 * because the square is inscribed in a disc of the same colour.
 */
export function drawShowFrame(ctx: CanvasRenderingContext2D, o: ShowOptions): void {
  const { total, disc } = SHOW;
  const profile = bandProfile(o.frame.k, o.frame.n);

  ctx.save();
  ctx.fillStyle = SHOW_GROUND;
  ctx.fillRect(total.x, total.y, total.w, total.h);

  // The band as a single path: the scalloped outer edge, then the disc as a hole
  // wound the other way so the even-odd rule leaves an annulus.
  ctx.fillStyle = SHOW_INK;
  ctx.beginPath();
  for (let deg = 0; deg < 360; deg += EDGE_STEP_DEG) {
    const p = onCircle(deg, radiusAt(profile, deg));
    if (deg === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.moveTo(disc.x + disc.r, disc.y);
  ctx.arc(disc.x, disc.y, disc.r, 0, 2 * Math.PI, true);
  ctx.fill("evenodd");

  // Anchors are holes through the band. A hole is an isolated bright region,
  // which is what gives it a centroid of its own -- a bump would just be more of
  // the band, with no separate blob to find.
  ctx.fillStyle = SHOW_GROUND;
  for (const f of SHOW.fid) {
    ctx.beginPath();
    ctx.arc(f.x, f.y, ANCHOR_D / 2, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(SHOW.inner.x, SHOW.inner.y);
  drawChromograph(ctx, {
    text: o.text,
    params: { ...o.params, mode: "iso", thickness: SHOW_THICKNESS },
    preset: SHOW_PRESET,
    width: SHOW.inner.w,
    height: SHOW.inner.h,
    frame: o.frame,
    // The band already states the index, at a scale a camera can resolve. The
    // plate would only be a mark on the artwork that nothing here ever reads.
    plate: false,
  });
  ctx.restore();
  ctx.restore();
}

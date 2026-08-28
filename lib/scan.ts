/**
 * One camera frame -> one character, or nothing.
 *
 * The whole of the new decode is: find four corners, fit a projective transform,
 * read the header band through it, rectify the artwork, and hand the result to
 * the decoder that already exists. Nothing about the codec changes, because
 * `isoRect` is exactly scale-covariant -- `pad`, `barH` and `gap` are all linear
 * in the canvas size -- so a rectified buffer of the right aspect ratio is
 * indistinguishable, to every function downstream, from an exported frame.
 *
 * Rectifying rather than mapping individual points is the deliberate trade. It
 * costs a pass over a small buffer; it buys `markerAt` unmodified, background
 * sampled from real corners, the header plate excluded by its own geometry, and
 * a marker centroid that arrives already in canonical pixels.
 *
 * DOM-free and pure, so the whole chain is testable in Node against software
 * warped frames.
 */

import { CHARSET, nearestCell, type Point } from "./grid.ts";
import { SNAP_TOL, legalDist, markerAt, type ImageDataLike } from "./decode.ts";
import { fromPx, isoRect, yawOf, zOf } from "./iso.ts";
import { applyH, solveHomography, type Homography } from "./homography.ts";
import { cornerQuad, findBlobs, plausibleQuad, threshold, type Blob } from "./blobs.ts";
import { SHOW, parseBand, type Edge } from "./showframe.ts";

export type Scanned = {
  k: number;
  n: number;
  cell: number;
  char: string;
  /** 1 when the marker landed exactly on a legal knot position, 0 at the snap limit. */
  confidence: number;
};

export type ScanOptions = {
  /** Width of the rectified buffer. The first knob to turn if frames arrive late. */
  warpEdge?: number;
  /** Receives the rectified buffer, for the on-screen debug preview. */
  onWarp?: (buf: ImageDataLike) => void;
};

const EDGES: Edge[] = [0, 1, 2, 3];

/** A band whose own extremes are closer than this is background, not a band. */
const MIN_BAND_CONTRAST = 20;
/** Bands agreeing on the frame, out of four. Three leaves room for one bad edge. */
const MIN_AGREEING_BANDS = 3;
/**
 * Pixels a luminance level needs before the stretch will treat it as a real
 * feature rather than noise. Deliberately the same order as decode's
 * MIN_MARKER_PIXELS: the smallest thing that has to survive is the marker.
 */
const MIN_EXTREME_PIXELS = 40;
/**
 * Channel spread below which a pixel is treated as neutral. Comfortably above
 * amplified sensor noise, comfortably below any real stroke colour.
 */
const NEUTRAL_CHROMA = 20;

// The fiducial rectangle, used to normalise the solve's inputs. Feeding raw
// pixel magnitudes in makes the `-x*u` terms six orders larger than the literal
// 1 entries, which is where plain elimination starts losing digits. Normalising
// here is a few lines and saves composing Hartley matrices in the solver.
const FID_CX = (SHOW.fid[0].x + SHOW.fid[1].x) / 2;
const FID_CY = (SHOW.fid[0].y + SHOW.fid[3].y) / 2;
const FID_HW = (SHOW.fid[1].x - SHOW.fid[0].x) / 2;
const FID_HH = (SHOW.fid[3].y - SHOW.fid[0].y) / 2;

const normCanon = (p: { x: number; y: number }) => ({ x: (p.x - FID_CX) / FID_HW, y: (p.y - FID_CY) / FID_HH });

/** Canonical show coordinates -> camera pixels. */
type Project = (p: Point) => Point | null;

function projector(h: Homography, W: number, H: number): Project {
  return (p) => {
    const q = applyH(h, normCanon(p));
    if (!q) return null;
    return { x: ((q.x + 1) * W) / 2, y: ((q.y + 1) * H) / 2 };
  };
}

/**
 * Fit the transform under one orientation hypothesis: canonical fiducial `i`
 * observed at quad corner `i + r`.
 */
function solveFor(quad: Blob[], r: number, W: number, H: number): Homography | null {
  const src = SHOW.fid.map(normCanon);
  const dst = SHOW.fid.map((_, i) => {
    const b = quad[(i + r) % 4];
    return { x: b.cx / (W / 2) - 1, y: b.cy / (H / 2) - 1 };
  });
  return solveHomography(src, dst);
}

/** Mean luminance over a disc. The averaging is also what removes screen moire. */
function discMean(img: ImageDataLike, cx: number, cy: number, r: number): number | null {
  const { width: W, height: H, data } = img;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const o = (y * W + x) * 4;
      sum += data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/**
 * Sample one band's cells and threshold them against that band's own extremes.
 *
 * Per band, never globally. It is what makes the reading immune to auto exposure
 * and to one edge sitting under a raking reflection while another does not. The
 * sync word guarantees every band holds both a set and a clear cell, so the
 * extremes always straddle a real boundary.
 */
function readBand(img: ImageDataLike, project: Project, edge: Edge): number[] | null {
  const vals: number[] = [];
  for (let i = 0; i < SHOW.cells; i++) {
    const c = project(SHOW.cellCentre(edge, i));
    const nb = project(SHOW.cellCentre(edge, i === 0 ? 1 : i - 1));
    if (!c || !nb) return null;
    const pitch = Math.hypot(nb.x - c.x, nb.y - c.y);
    const v = discMean(img, c.x, c.y, Math.max(1, pitch * 0.25));
    if (v === null) return null;
    vals.push(v);
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < MIN_BAND_CONTRAST) return null;

  // Dark is a set cell, always. The band's polarity is fixed by the format --
  // a set cell bulges the edge outward, so its sample lands on band material --
  // and it is deliberately not tied to the polarity the anchors were found at.
  // Those are opposite here: the anchors are holes punched through the band, so
  // they are bright while the data they register is dark.
  const mid = (lo + hi) / 2;
  return vals.map((v) => (v < mid ? 1 : 0));
}

/**
 * Which frame this is, agreed by at least three of the four bands.
 *
 * This is the tearing defence, and it is a proof rather than a heuristic. A
 * camera exposure straddling a display transition takes some bands from one
 * frame and some from the next, so they name different k and the frame is
 * discarded. Requiring the same answer on two successive camera frames would
 * not work: a free-running camera holds phase against the display for hundreds
 * of milliseconds, so the tear falls on the same scanline and the identical
 * wrong answer arrives twice.
 *
 * A majority rather than unanimity, so one edge lost to glare costs nothing.
 */
function readHeader(img: ImageDataLike, project: Project): { k: number; n: number } | null {
  const tally = new Map<string, { k: number; n: number; votes: number }>();
  for (const edge of EDGES) {
    const bits = readBand(img, project, edge);
    if (!bits) continue;
    const got = parseBand(bits, edge);
    if (!got) continue;
    const key = got.k + ":" + got.n;
    const seen = tally.get(key);
    if (seen) seen.votes++;
    else tally.set(key, { k: got.k, n: got.n, votes: 1 });
  }

  let best: { k: number; n: number; votes: number } | null = null;
  for (const entry of tally.values()) if (!best || entry.votes > best.votes) best = entry;
  return best && best.votes >= MIN_AGREEING_BANDS ? { k: best.k, n: best.n } : null;
}

/**
 * Rectify the artwork into a canonical buffer.
 *
 * Nearest neighbour on purpose. The marker is a dozen-odd pixels across here and
 * located by a median over a couple of hundred of them, so interpolation buys
 * nothing the median does not already give, and this loop runs once per output
 * pixel on a phone.
 */
export function warp(img: ImageDataLike, project: Project, edge: number): ImageDataLike {
  const W = Math.max(1, Math.round(edge));
  const H = Math.max(1, Math.round((edge * SHOW.inner.h) / SHOW.inner.w));
  const out = new Uint8ClampedArray(W * H * 4);
  const scale = SHOW.inner.w / W;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      out[o + 3] = 255;
      const src = project({ x: SHOW.inner.x + (x + 0.5) * scale, y: SHOW.inner.y + (y + 0.5) * scale });
      if (!src) continue;
      const sx = Math.round(src.x - 0.5);
      const sy = Math.round(src.y - 0.5);
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const s = (sy * img.width + sx) * 4;
      out[o] = img.data[s];
      out[o + 1] = img.data[s + 1];
      out[o + 2] = img.data[s + 2];
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * Undo what the camera did to the colours, in place.
 *
 * `markerAt` decides with absolute thresholds -- within 0.06 of a pure luminance
 * extreme, and under 0.25 saturation. A camera respects neither. Auto white
 * balance under warm light lays an orange cast over a white marker and pushes it
 * straight past the saturation ceiling; auto exposure means pure white never
 * arrives as 255. Both are global and both invert cheaply, which is the other
 * half of why rectifying first is worth its cost: there is one small buffer to
 * correct instead of a whole camera frame.
 */
export function normalise(img: ImageDataLike): void {
  const { data } = img;
  const px = img.width * img.height;
  if (px === 0) return;

  // Per channel, independently: find that channel's true black and white points
  // and stretch them to 0 and 255.
  //
  // Equalising endpoints rather than means is what this needs, and it subsumes a
  // grey-world correction rather than needing one alongside. markerAt's tests are
  // both endpoint-relative -- within 0.06 of a pure extreme, and under 0.25
  // saturation -- and saturation is a ratio, so it degenerates near black: a
  // marker that should be neutral arriving as (0, 4, 8) reads as fully saturated
  // and every one of its pixels is thrown away. That is why the paper and
  // greyscale presets, whose marker is black rather than white, fail without
  // this while the black preset passes. Aligning each channel's endpoints puts a
  // neutral black back at (0,0,0) and a neutral white at (255,255,255).
  //
  // The endpoints are found by pixel count, not by percentile. A rectified frame
  // is overwhelmingly background -- the marker is a couple of hundred pixels in
  // a few hundred thousand, well under a tenth of a percent -- so any quantile
  // lands on the background, reports no range, and the stretch quietly does
  // nothing. Asking for the extreme levels backed by at least a marker's worth
  // of pixels finds them whatever share of the frame they occupy.
  for (let c = 0; c < 3; c++) {
    const hist = new Int32Array(256);
    for (let i = 0; i < px; i++) hist[data[i * 4 + c]]++;

    let lo = 0;
    let hi = 255;
    for (let seen = 0, v = 0; v < 256; v++) {
      seen += hist[v];
      if (seen >= MIN_EXTREME_PIXELS) {
        lo = v;
        break;
      }
    }
    for (let seen = 0, v = 255; v >= 0; v--) {
      seen += hist[v];
      if (seen >= MIN_EXTREME_PIXELS) {
        hi = v;
        break;
      }
    }
    // Too flat to be carrying anything: stretching it would only amplify noise.
    if (hi - lo < 8) continue;

    const gain = 255 / (hi - lo);
    for (let i = 0; i < px; i++) {
      const o = i * 4 + c;
      data[o] = (data[o] - lo) * gain;
    }
  }

  // Chroma below the noise floor is not chroma.
  //
  // markerAt discards any pixel more saturated than 0.25, and saturation is a
  // ratio, so it degenerates towards black: the stretch above amplifies each
  // channel's noise along with its signal, and a few counts of disagreement
  // against a near-zero maximum reads as a saturation approaching 1. A black
  // marker therefore loses nearly every pixel to noise that carries no colour at
  // all, which is why the paper and greyscale presets fail without this while
  // the black preset never does -- against 255, the same few counts is a
  // saturation of 0.02.
  //
  // Making the marker larger does not help, and measurably does not: it raises
  // the pixel count and leaves the proportion surviving unchanged.
  //
  // Real colour is nowhere near this threshold. A saturated stroke separates its
  // channels by well over a hundred counts, so nothing the test is meant to
  // reject is caught by this.
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) >= NEUTRAL_CHROMA) continue;
    const mean = (r + g + b) / 3;
    data[o] = mean;
    data[o + 1] = mean;
    data[o + 2] = mean;
  }
}

/**
 * Read one character out of one camera frame.
 *
 * Null is the ordinary case, not an error: most frames are mid-transition,
 * mis-framed, or blurred by a focus hunt. The loop repeats, so a rejected frame
 * costs nothing.
 */
export function scanFrame(img: ImageDataLike, opts: ScanOptions = {}): Scanned | null {
  const { warpEdge = 640, onWarp } = opts;
  if (img.width < 64 || img.height < 64) return null;

  const thr = threshold(img);

  // The anchors are holes punched through the band, so they are bright, and the
  // bright reading effectively always wins. Everything else bright is discarded
  // on the way: the page touches the image edge, the disc is far too large, and
  // an indent stays connected to the page outside. The dark reading is kept
  // behind it rather than deleted -- it costs nothing when the first succeeds.
  for (const bright of [true, false]) {
    const quad = cornerQuad(findBlobs(img, thr, bright));
    if (!quad || !plausibleQuad(quad, img.width, img.height)) continue;

    // Exactly one orientation must work. If two hypotheses both produce three
    // agreeing bands then the pattern read plausibly at more than one rotation,
    // and picking either is a coin flip on a silently wrong character.
    let found: { header: { k: number; n: number }; project: Project } | null = null;
    let passes = 0;
    for (let r = 0; r < 4; r++) {
      const h = solveFor(quad, r, img.width, img.height);
      if (!h) continue;
      const project = projector(h, img.width, img.height);
      const header = readHeader(img, project);
      if (!header) continue;
      passes++;
      found = { header, project };
    }
    if (passes !== 1 || !found) continue;

    const buf = warp(img, found.project, warpEdge);
    normalise(buf);
    onWarp?.(buf);

    const marker = markerAt(buf);
    if (!marker) continue;

    const { k, n } = found.header;
    // From here it is the existing exact decode, unchanged: k gives both the
    // marked knot's height and the camera angle, and with those known the
    // projection inverts outright.
    const g = fromPx(marker.x, marker.y, zOf(k, n), isoRect(buf.width, buf.height), yawOf(k, n));
    const { cell, dist } = nearestCell(g);
    return {
      k,
      n,
      cell,
      char: CHARSET[cell],
      confidence: Math.max(0, 1 - legalDist(dist) / SNAP_TOL),
    };
  }

  return null;
}

/**
 * Image -> text.
 *
 * The curve carries no markers, so "which cells were visited" cannot be read off
 * the path geometry -- a spline from A to Z sweeps over cells it never visited.
 * What makes it recoverable is that hue advances uniformly per character step
 * (see palette.hueAt): with N characters, knot k sits at exactly hue
 * k * HUE_SPAN / (N - 1). So the decoder needs N, and then it can sample the
 * curve at N specific hues and ignore everything in between.
 *
 * N comes from the calibration bar (one swatch per character). If the bar is
 * missing, N is recovered by fitting: the true N places every sample on a cell
 * centre, a wrong N places samples mid-transit.
 *
 * Assumes an uncropped export -- the grid's position is derived from the image
 * dimensions via plotRect.
 */

import { CELL_PITCH, CHARSET, OFFSET_R, cellCenter, nearestCell, MAX_CHARS, type Point } from "./grid.ts";
import { HUE_SPAN, HUE_START, rgbToHsv } from "./palette.ts";
import { plotRect } from "./render.ts";

export type ImageDataLike = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
};

export type DecodedChar = {
  char: string;
  cell: number;
  /** 1 = dead on a cell centre, 0 = as far away as the snap tolerance allows. */
  confidence: number;
  /** Sample position in image pixels, for the debug overlay. */
  at: Point | null;
};

export type DecodeResult = {
  text: string;
  chars: DecodedChar[];
  knotCount: number;
  source: "calibration-bar" | "fit";
  warnings: string[];
  /** Image-pixel positions of the traced hue ramp, for the debug overlay. */
  trace: Point[];
  maskedPixels: number;
};

const BINS = 1024;

/**
 * Saturation/value floors for "this pixel is the stroke core".
 *
 * Tight by design. The core is stroked last at full opacity, so its pixels carry
 * the exact encoded hue, while the bloom halo underneath is additive: where two
 * differently-hued strands' halos overlap they sum toward white, producing a
 * saturated third hue that belongs to neither. Those blends land in the wrong
 * hue bin and drag its centroid to the crossing point, which wrecks dense
 * artwork. Clipping to the core removes the problem rather than compensating for it.
 */
const MASK_CORE = { s: 0.62, v: 0.85 };
/** Fallback for images whose core no longer survives the tight mask (recompressed, rescaled). */
const MASK_LOOSE = { s: 0.45, v: 0.35 };
/** Below this many core pixels, assume the tight mask was too strict for this image. */
const MIN_CORE_PIXELS = 500;
/** A sample further than this from a legal knot position is not trusted. */
const SNAP_TOL = 0.42 * CELL_PITCH;

/**
 * A knot legally sits either on the cell centre or on the orbit ring used for
 * re-visited cells, so confidence is measured against whichever is closer.
 * Scoring against the centre alone would mark every repeated letter as doubtful.
 */
const legalDist = (distToCentre: number) => Math.min(distToCentre, Math.abs(distToCentre - OFFSET_R));

type Bins = {
  /** Median position of the curve in each hue bin. */
  cx: Float64Array;
  cy: Float64Array;
  has: Uint8Array;
  masked: number;
};

type Rect = ReturnType<typeof plotRect>;

export function decode(img: ImageDataLike): DecodeResult {
  const { width: W, height: H } = img;
  const r = plotRect(W, H);
  const warnings: string[] = [];

  let bins = buildBins(img, r.bar.y, MASK_CORE);
  if (bins.masked < MIN_CORE_PIXELS) {
    bins = buildBins(img, r.bar.y, MASK_LOOSE);
    if (bins.masked >= MIN_CORE_PIXELS) {
      warnings.push(
        "The stroke core could not be isolated cleanly, so a looser colour mask was used. " +
          "Glow bleed may pull characters off their cells.",
      );
    }
  }
  const trace = binTrace(bins);

  if (bins.masked < 200) {
    return {
      text: "",
      chars: [],
      knotCount: 0,
      source: "fit",
      warnings: [
        "No saturated curve found. Is this a Chromograph export? Monochromatic Ink carries no hue and cannot be decoded.",
      ],
      trace,
      maskedPixels: bins.masked,
    };
  }

  const bar = readCalibrationBar(img, r.bar);
  let knotCount: number;
  let source: DecodeResult["source"];

  if (bar) {
    knotCount = bar.count;
    source = "calibration-bar";
    if (bar.deviation > 6) {
      warnings.push(
        `Calibration bar hues are off by up to ${bar.deviation.toFixed(1)} degrees. The image has likely been ` +
          "re-encoded as JPEG, which damages hue before anything else. The decode below may be wrong.",
      );
    }
  } else {
    const fit = fitKnotCount(bins, r);
    knotCount = fit.count;
    source = "fit";
    warnings.push(
      "No calibration bar found, so the message length was inferred from the curve. " +
        "Enable the calibration bar when exporting for a reliable decode.",
    );
    if (fit.meanDist > SNAP_TOL) warnings.push("Poor fit: the decoded text is probably wrong.");
  }

  const chars = sampleKnots(bins, r, knotCount);
  const weak = chars.filter((c) => c.confidence < 0.35).length;
  if (weak > 0) warnings.push(`${weak} character(s) landed between grid cells and are low confidence.`);
  if (knotCount > MAX_CHARS) {
    warnings.push(`${knotCount} characters exceeds the ${MAX_CHARS} character reliable limit.`);
  }

  return {
    text: chars.map((c) => c.char).join(""),
    chars,
    knotCount,
    source,
    warnings,
    trace,
    maskedPixels: bins.masked,
  };
}

/**
 * Median position of the curve in each hue bin.
 *
 * Median rather than centroid on purpose. Where the curve crosses itself the
 * antialiased boundary between two strands blends their colours into hues that
 * belong to neither, and those pixels land in some third bin at the crossing
 * point -- far from where that bin's curve actually runs. A mean gets dragged
 * by them; a median ignores them until they outnumber the real pixels.
 */
function buildBins(img: ImageDataLike, barTop: number, mask: { s: number; v: number }): Bins {
  const { width: W, data } = img;
  const yMax = Math.min(img.height, Math.floor(barTop));

  const each = (fn: (bin: number, x: number, y: number) => void) => {
    for (let y = 0; y < yMax; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (data[i + 3] < 128) continue;
        const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        if (s < mask.s || v < mask.v) continue;
        const t = (h - HUE_START) / HUE_SPAN;
        if (t < 0 || t > 1) continue; // outside the encoded ramp
        fn(Math.round(t * (BINS - 1)), x, y);
      }
    }
  };

  // Counting sort into per-bin slices, so each bin's pixels are contiguous and
  // can be selected over without allocating an array per bin.
  const count = new Int32Array(BINS);
  each((bin) => void count[bin]++);

  const start = new Int32Array(BINS + 1);
  for (let b = 0; b < BINS; b++) start[b + 1] = start[b] + count[b];
  const masked = start[BINS];

  const xs = new Int32Array(masked);
  const ys = new Int32Array(masked);
  const cursor = Int32Array.from(start.subarray(0, BINS));
  each((bin, x, y) => {
    const i = cursor[bin]++;
    xs[i] = x;
    ys[i] = y;
  });

  const cx = new Float64Array(BINS);
  const cy = new Float64Array(BINS);
  const has = new Uint8Array(BINS);
  for (let b = 0; b < BINS; b++) {
    if (count[b] === 0) continue;
    const from = start[b];
    const to = from + count[b];
    // Sorting the slice in place is fine: nothing downstream needs pixel order.
    cx[b] = median(xs.subarray(from, to));
    cy[b] = median(ys.subarray(from, to));
    has[b] = 1;
  }

  return { cx, cy, has, masked };
}

function median(slice: Int32Array): number {
  slice.sort();
  const mid = slice.length >> 1;
  return slice.length % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
}

/** Nearest bin holding data, searching outward from `bin`. */
function binAt(bins: Bins, bin: number, radius = 10): Point | null {
  for (let d = 0; d <= radius; d++) {
    const candidates = d === 0 ? [bin] : [bin - d, bin + d];
    for (const b of candidates) {
      if (b >= 0 && b < BINS && bins.has[b]) return { x: bins.cx[b], y: bins.cy[b] };
    }
  }
  return null;
}

function binTrace(bins: Bins): Point[] {
  const out: Point[] = [];
  for (let b = 0; b < BINS; b++) if (bins.has[b]) out.push({ x: bins.cx[b], y: bins.cy[b] });
  return out;
}

const hueBin = (k: number, count: number) => Math.round((count < 2 ? 0 : k / (count - 1)) * (BINS - 1));

function sampleKnots(bins: Bins, r: Rect, count: number): DecodedChar[] {
  const out: DecodedChar[] = [];
  for (let k = 0; k < count; k++) {
    const p = binAt(bins, hueBin(k, count));
    if (!p) {
      out.push({ char: "?", cell: -1, confidence: 0, at: null });
      continue;
    }
    const { cell, dist } = nearestCell({ x: (p.x - r.x) / r.w, y: (p.y - r.y) / r.h });
    out.push({
      char: CHARSET[cell],
      cell,
      confidence: Math.max(0, 1 - legalDist(dist) / SNAP_TOL),
      at: p,
    });
  }
  return out;
}

/**
 * Recover N without a calibration bar.
 *
 * Any N where (N-1) divides the true (N-1) also fits perfectly -- sampling every
 * other knot lands on real knots too, it just drops half the message -- so take
 * the largest N that fits rather than the best-scoring one.
 */
function fitKnotCount(bins: Bins, r: Rect): { count: number; meanDist: number } {
  let best = { count: 2, meanDist: Infinity };
  let largestGood: { count: number; meanDist: number } | null = null;

  for (let n = 2; n <= MAX_CHARS; n++) {
    let sum = 0;
    let seen = 0;
    for (let k = 0; k < n; k++) {
      const p = binAt(bins, hueBin(k, n), 4);
      if (!p) continue;
      sum += nearestCell({ x: (p.x - r.x) / r.w, y: (p.y - r.y) / r.h }).dist;
      seen++;
    }
    if (seen < n) continue; // a knot hue with no curve at it means this N is wrong
    const meanDist = sum / seen;
    if (meanDist < best.meanDist) best = { count: n, meanDist };
    if (meanDist <= 0.25 * CELL_PITCH) largestGood = { count: n, meanDist };
  }
  return largestGood ?? best;
}

/**
 * The bar is one flat swatch per character. Counting the swatches gives N, and
 * their hues confirm the ramp survived whatever the image has been through.
 */
export function readCalibrationBar(
  img: ImageDataLike,
  bar: { x: number; y: number; w: number; h: number },
): { count: number; deviation: number } | null {
  const { width: W, data } = img;
  const x0 = Math.max(0, Math.round(bar.x));
  const x1 = Math.min(W, Math.round(bar.x + bar.w));
  const rows = [0.3, 0.5, 0.7]
    .map((f) => Math.round(bar.y + bar.h * f))
    .filter((y) => y >= 0 && y < img.height);
  if (rows.length === 0 || x1 - x0 < 8) return null;

  const hues: (number | null)[] = [];
  for (let x = x0; x < x1; x++) {
    const samples: number[] = [];
    for (const y of rows) {
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (s > 0.6 && v > 0.5) samples.push(h);
    }
    samples.sort((a, b) => a - b);
    hues.push(samples.length ? samples[samples.length >> 1] : null);
  }

  // Group into runs of near-constant hue. Antialiased swatch edges show up as
  // 1px runs, so anything that short is discarded rather than counted.
  const runs: { hue: number; len: number }[] = [];
  for (const h of hues) {
    if (h === null) {
      runs.push({ hue: NaN, len: 1 });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && Math.abs(last.hue - h) <= 3) {
      last.hue = (last.hue * last.len + h) / (last.len + 1);
      last.len++;
    } else {
      runs.push({ hue: h, len: 1 });
    }
  }

  const solid = runs.filter((run) => run.len >= 2 && Number.isFinite(run.hue));
  if (solid.length < 2 || solid.length > MAX_CHARS) return null;

  // Hues must climb. A bar read out of noise will not.
  for (let i = 1; i < solid.length; i++) if (solid[i].hue <= solid[i - 1].hue) return null;

  const count = solid.length;
  let deviation = 0;
  for (let k = 0; k < count; k++) {
    const ideal = HUE_START + (k / (count - 1)) * HUE_SPAN;
    deviation = Math.max(deviation, Math.abs(solid[k].hue - ideal));
  }
  if (deviation > 20) return null;
  return { count, deviation };
}

/** Normalised grid coords -> image pixels, for drawing the debug overlay. */
export function gridToImage(p: Point, W: number, H: number): Point {
  const r = plotRect(W, H);
  return { x: r.x + p.x * r.w, y: r.y + p.y * r.h };
}

export { cellCenter };

/**
 * Image -> text. Three readers, for the three shapes a Chromograph comes in.
 *
 * FRAMES (`decodeFrames`, exact). Every frame carries a header stating which
 * character it is and how many there are. From k follow both the marked knot's
 * height and the camera angle, and with those known the projection inverts, so
 * the marker's position gives the grid cell outright. Nothing analog is
 * measured, and no colour is read: the header is black and white, and so is the
 * marker. Frames are independent, so they may arrive in any order, be
 * duplicated, or go missing.
 *
 * ISOMETRIC STILL (`decodeIso`, best effort). One frame has no index, so order
 * has to come from hue: it advances uniformly per character step (see
 * palette.hueAt), and the calibration bar gives N. Position is still exact --
 * knot k's height follows from k, and that makes the projection invertible.
 *
 * FLAT STILL (`decodeFlat`, best effort). Hue for the order as above, and the
 * grid read straight off the image plane. N comes from the calibration bar, or
 * is fitted when the bar is missing.
 *
 * Every reader assumes an uncropped export: the scene's placement is derived
 * from the image dimensions alone, via plotRect / isoRect.
 */

import { CELL_PITCH, CHARSET, OFFSET_R, nearestCell, MAX_CHARS, type Point } from "./grid.ts";
import { HUE_SPAN, HUE_START, rgbToHsv } from "./palette.ts";
import { plotRect } from "./render.ts";
import { fromPx, isoRect, yawOf, zOf, type IsoRect } from "./iso.ts";
import { headerLayout, readFrameHeader } from "./frame.ts";

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
  mode: "iso" | "flat" | "frames";
  source: "frame-index" | "calibration-bar" | "fit";
  warnings: string[];
  /** Image-pixel positions of the traced hue ramp, for the debug overlay. Stills only. */
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
const MASK_CORE = { s: 0.62, v: 0.78 };
/** Fallback for images whose core no longer survives the tight mask (recompressed, rescaled). */
const MASK_LOOSE = { s: 0.45, v: 0.35 };
/** Below this many core pixels, assume the tight mask was too strict for this image. */
const MIN_CORE_PIXELS = 500;
/** A sample further than this from a legal knot position is not trusted. */
export const SNAP_TOL = 0.42 * CELL_PITCH;

/**
 * A knot legally sits either on the cell centre or on the orbit ring used for
 * re-visited cells, so confidence is measured against whichever is closer.
 * Scoring against the centre alone would mark every repeated letter as doubtful.
 */
export const legalDist = (distToCentre: number) => Math.min(distToCentre, Math.abs(distToCentre - OFFSET_R));

type Bins = {
  /** Median position of the curve in each hue bin. */
  cx: Float64Array;
  cy: Float64Array;
  has: Uint8Array;
  masked: number;
};

type Rect = ReturnType<typeof plotRect>;

/**
 * A still could have been drawn either way round, and nothing in the pixels
 * announces which. Both readings are attempted and the better-fitting one wins:
 * the wrong projection scatters knots between cells, the right one lands them on
 * centres.
 */
export function decode(img: ImageDataLike): DecodeResult {
  const flat = decodeFlat(img);
  const iso = decodeIso(img);
  if (!iso) return flat;
  return misfit(iso) <= misfit(flat) ? iso : flat;
}

function decodeFlat(img: ImageDataLike): DecodeResult {
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
      mode: "flat",
      source: "fit",
      warnings: [
        "No saturated curve found. Is this a Chromograph export? The Grayscale palette carries no hue and cannot be decoded.",
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
    mode: "flat",
    source,
    warnings,
    trace,
    maskedPixels: bins.masked,
  };
}


// --- shared: hue binning and the calibration bar ------------------------------

/**
 * Median position of the curve in each hue bin.
 *
 * Median rather than centroid on purpose. Where the curve crosses itself the
 * antialiased boundary between two strands blends their colours into hues that
 * belong to neither, and those pixels land in some third bin at the crossing
 * point -- far from where that bin's curve actually runs. A mean gets dragged by
 * them; a median ignores them until they outnumber the real pixels.
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
        // Hues past the ramp are stems and markers, never payload.
        if (t < 0 || t > 1) continue;
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
function readCalibrationBar(
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

// --- isometric still -------------------------------------------------------

/**
 * A still isometric image.
 *
 * Order still comes from hue here -- there is no way around that in a single
 * frame, which is exactly why the animated format exists. What the isometric
 * projection does give is an exact position: knot k's height follows from k, and
 * with the height known the projection inverts, so the sampled point maps to a
 * grid cell with no approximation.
 *
 * Stems are drawn in a hue range past the end of the payload ramp, so they are
 * already excluded from the hue bins and cannot disturb this.
 */
function decodeIso(img: ImageDataLike): DecodeResult | null {
  const { width: W, height: H } = img;
  const r = isoRect(W, H);
  const bins = buildBins(img, r.bar.y, MASK_CORE);
  if (bins.masked < MIN_CORE_PIXELS) return null;

  const bar = readCalibrationBar(img, r.bar);
  if (!bar) return null;

  const warnings: string[] = [];
  if (bar.deviation > 6) {
    warnings.push(
      `Calibration bar hues are off by up to ${bar.deviation.toFixed(1)} degrees, so this image has ` +
        "been re-encoded. Hue carries the order in a still image; export a sheet for an exact decode.",
    );
  }

  const chars = sampleIsoKnots(bins, r, bar.count);
  const weak = chars.filter((c) => c.confidence < 0.35).length;
  if (weak > 0) warnings.push(`${weak} character(s) landed between grid cells and are low confidence.`);

  return {
    text: chars.map((c) => c.char).join(""),
    chars,
    knotCount: bar.count,
    mode: "iso",
    source: "calibration-bar",
    warnings,
    trace: binTrace(bins),
    maskedPixels: bins.masked,
  };
}

function sampleIsoKnots(bins: Bins, r: IsoRect, count: number): DecodedChar[] {
  const out: DecodedChar[] = [];
  for (let k = 0; k < count; k++) {
    const p = binAt(bins, hueBin(k, count));
    if (!p) {
      out.push({ char: "?", cell: -1, confidence: 0, at: null });
      continue;
    }
    const { cell, dist } = nearestCell(fromPx(p.x, p.y, zOf(k, count), r));
    out.push({
      char: CHARSET[cell],
      cell,
      confidence: Math.max(0, 1 - legalDist(dist) / SNAP_TOL),
      at: p,
    });
  }
  return out;
}

/** Mean distance from a legal knot position; lower is a better-fitting reading. */
const misfit = (out: DecodeResult) =>
  out.chars.length === 0
    ? Infinity
    : out.chars.reduce((a, c) => a + (1 - c.confidence), 0) / out.chars.length;

// --- animated: frame index as the channel ------------------------------------

/**
 * The marker is achromatic: whichever of black or white the background is not.
 * So it is found by luminance, and a frame needs to carry no colour at all.
 */
const MARKER_LUMA_TOL = 0.06;
/** Anything this saturated is scene, not marker, however bright it happens to be. */
const MARKER_MAX_SAT = 0.25;
/** Fewer marker pixels than this and it is a compression artifact, not the square. */
const MIN_MARKER_PIXELS = 40;

/**
 * Decode an animated Chromograph.
 *
 * Nothing analog is measured. Each frame's header states which character it is
 * and how many there are; from k follow both the marked knot's height and the
 * camera angle, and with those two known the projection inverts exactly, so the
 * marker's position gives the grid cell outright.
 *
 * Frames are therefore independent. They may arrive in any order, be duplicated,
 * or be missing; a missing one costs exactly one character and says so.
 */
export function decodeFrames(frames: ImageDataLike[]): DecodeResult {
  const found = new Map<number, DecodedChar>();
  let knotCount = 0;
  let headerless = 0;
  let markerless = 0;

  for (const img of frames) {
    const header = readFrameHeader(img);
    if (!header) {
      headerless++;
      continue;
    }
    knotCount = Math.max(knotCount, header.n);

    const marker = markerAt(img);
    if (!marker) {
      markerless++;
      continue;
    }

    const r = isoRect(img.width, img.height);
    const g = fromPx(marker.x, marker.y, zOf(header.k, header.n), r, yawOf(header.k, header.n));
    const { cell, dist } = nearestCell(g);
    found.set(header.k, {
      char: CHARSET[cell],
      cell,
      confidence: Math.max(0, 1 - legalDist(dist) / SNAP_TOL),
      at: marker,
    });
  }

  const warnings: string[] = [];
  if (knotCount === 0) {
    return {
      text: "",
      chars: [],
      knotCount: 0,
      mode: "frames",
      source: "frame-index",
      warnings: ["No frame headers found. Is this a Chromograph animation?"],
      trace: [],
      maskedPixels: 0,
    };
  }

  const chars: DecodedChar[] = [];
  let missing = 0;
  for (let k = 0; k < knotCount; k++) {
    const hit = found.get(k);
    if (hit) chars.push(hit);
    else {
      missing++;
      chars.push({ char: "?", cell: -1, confidence: 0, at: null });
    }
  }

  if (missing > 0) warnings.push(`${missing} of ${knotCount} characters had no readable frame.`);
  if (headerless > 0) warnings.push(`${headerless} frame(s) had no readable header and were skipped.`);
  if (markerless > 0) warnings.push(`${markerless} frame(s) had a header but no marker.`);

  return {
    text: chars.map((c) => c.char).join(""),
    chars,
    knotCount,
    mode: "frames",
    source: "frame-index",
    warnings,
    trace: [],
    maskedPixels: found.size,
  };
}

const luma = (r: number, g: number, b: number) => (r * 0.299 + g * 0.587 + b * 0.114) / 255;

/**
 * Median position of the marker's pixels; median so stray artifacts cannot pull
 * it off the square.
 *
 * The background is read from the corners, and the marker is whichever luminance
 * extreme the background is not. The header plate is the one other thing on the
 * frame at a pure extreme, and it sits at a known position, so it is excluded by
 * geometry rather than by hoping it looks different.
 */
export function markerAt(img: ImageDataLike): Point | null {
  const { width: W, height: H, data } = img;
  const at = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return luma(data[i], data[i + 1], data[i + 2]);
  };
  const corners = [at(1, 1), at(W - 2, 1), at(1, H - 2), at(W - 2, H - 2)].sort((a, b) => a - b);
  const target = (corners[1] + corners[2]) / 2 > 0.5 ? 0 : 1;

  const plate = headerLayout(W, H);
  const px0 = plate.x - 2 * plate.cell;
  const px1 = plate.x + (plate.cells + 3) * plate.cell;
  const py0 = plate.y - 2 * plate.cell;
  const py1 = plate.y + 3 * plate.cell;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < H; y++) {
    const inPlateRow = y >= py0 && y <= py1;
    for (let x = 0; x < W; x++) {
      if (inPlateRow && x >= px0 && x <= px1) continue;
      const i = (y * W + x) * 4;
      if (data[i + 3] < 128) continue;
      if (Math.abs(luma(data[i], data[i + 1], data[i + 2]) - target) > MARKER_LUMA_TOL) continue;
      if (rgbToHsv(data[i], data[i + 1], data[i + 2]).s > MARKER_MAX_SAT) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < MIN_MARKER_PIXELS) return null;
  const mid = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  return { x: mid(xs), y: mid(ys) };
}

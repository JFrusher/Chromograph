/** Canvas2D renderer. Pure: same inputs -> same pixels. */

import { CELLS, COLS, ROWS, cellCenter, textToKnots, type Point } from "./grid.ts";
import { catmullRom } from "./spline.ts";
import { colorFor, contrastInk, hueAt, markerInk, stemColorFor, type Preset } from "./palette.ts";
import { isoRect, toPx as isoPx, yawOf, zOf, type IsoRect } from "./iso.ts";
import { drawFrameHeader, type FrameHeader } from "./frame.ts";

export type ViewMode = "flat" | "iso";

/**
 * Gap between a stem's top and its knot, as a multiple of stroke thickness.
 * Shared with the decoder only in spirit: it is a constant bias on every stem,
 * and the decoder ranks stems by relative length, so it cancels.
 */
export const STEM_GAP = 1.6;

export type RenderParams = {
  mode: ViewMode;
  tension: number;
  /** Core stroke width, in px, relative to a 1000px canvas. */
  thickness: number;
  gridOpacity: number;
  showBar: boolean;
  /** Isometric only. Drop lines from each knot to the base plane, for the eye. */
  stems: boolean;
};

export const DEFAULT_PARAMS: RenderParams = {
  mode: "iso",
  tension: 1,
  thickness: 6,
  gridOpacity: 0.35,
  showBar: true,
  stems: true,
};

export type PlotRect = { x: number; y: number; w: number; h: number; cell: number; bar: Rect };
type Rect = { x: number; y: number; w: number; h: number };

/**
 * Flat mode: where the 6x5 grid sits inside a WxH canvas.
 *
 * The calibration bar's slot is reserved whether or not the bar is drawn, so that
 * toggling it never moves the grid -- the decoder relies on this mapping being a
 * function of image size alone.
 */
export function plotRect(W: number, H: number): PlotRect {
  const pad = 0.07 * Math.min(W, H);
  const barH = 0.06 * H;
  const gap = 0.025 * H;
  const availW = W - 2 * pad;
  const availH = H - 2 * pad - barH - gap;
  const cell = Math.min(availW / COLS, availH / ROWS);
  const w = cell * COLS;
  const h = cell * ROWS;
  const x = (W - w) / 2;
  const y = pad + (availH - h) / 2;
  return { x, y, w, h, cell, bar: { x, y: y + h + gap, w, h: barH } };
}

/** Normalised grid coords -> device pixels (flat mode). */
const toPx = (p: Point, r: PlotRect) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });

export type DrawOptions = {
  text: string;
  params: RenderParams;
  preset: Preset;
  width: number;
  height: number;
  /**
   * One frame of the animated format. The frame index IS the character index,
   * which is what makes the animated decode exact: nothing analog is measured,
   * the marked knot's height and the camera angle both follow from k.
   */
  frame?: FrameHeader;
  /**
   * Draw the frame's header plate. On by default, because every file format
   * needs it to be decodable at all.
   *
   * The live display turns it off: it reads its index from its own surround
   * instead, at a scale a lens can actually resolve, and the plate is a
   * hundred-and-tenth of the frame sampled at a single pixel -- unreadable from
   * a camera, and so only a mark on the artwork.
   */
  plate?: boolean;
};

export function drawChromograph(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  ctx.save();
  ctx.fillStyle = o.preset.bg;
  ctx.fillRect(0, 0, o.width, o.height);
  if (o.params.mode === "iso") drawIso(ctx, o);
  else drawFlat(ctx, o);
  ctx.restore();
}

/** Keep total samples near 1500 regardless of message length. */
const samplesPerSegment = (knotCount: number) =>
  Math.min(64, Math.max(8, Math.round(1500 / Math.max(1, knotCount - 1))));

// --- flat ------------------------------------------------------------------

function drawFlat(ctx: CanvasRenderingContext2D, o: DrawOptions) {
  const { width: W, height: H, preset, params } = o;
  const r = plotRect(W, H);
  const scale = Math.min(W, H) / 1000;

  drawFlatGrid(ctx, r, params.gridOpacity, scale, preset);

  const knots = textToKnots(o.text);
  if (knots.length >= 2) {
    const curve = catmullRom(knots, params.tension, samplesPerSegment(knots.length));
    const px = curve.pts.map((p) => toPx(p, r));
    strokeRibbon(ctx, px, curve.seg, knots.length, preset, Math.max(1, params.thickness * scale));
  } else if (knots.length === 1) {
    const p = toPx(knots[0], r);
    const s = params.thickness * scale;
    ctx.fillStyle = colorFor(0, 1, preset);
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
  }

  if (params.showBar && preset.hueOrdered) drawCalibrationBar(ctx, r.bar, knots.length, scale);
}

/** Grid marks are crosses rather than dots -- a plotter tick, not a soft point. */
function drawFlatGrid(ctx: CanvasRenderingContext2D, r: PlotRect, opacity: number, scale: number, preset: Preset) {
  if (opacity <= 0) return;
  const ink = contrastInk(preset.bg);
  ctx.strokeStyle = `rgba(${ink.r},${ink.g},${ink.b},${(opacity * 0.55).toFixed(3)})`;
  ctx.lineWidth = Math.max(1, scale);
  const arm = 4 * scale;
  ctx.beginPath();
  for (let i = 0; i < CELLS; i++) {
    const p = toPx(cellCenter(i), r);
    ctx.moveTo(p.x - arm, p.y);
    ctx.lineTo(p.x + arm, p.y);
    ctx.moveTo(p.x, p.y - arm);
    ctx.lineTo(p.x, p.y + arm);
  }
  ctx.stroke();
}

// --- isometric -------------------------------------------------------------

function drawIso(ctx: CanvasRenderingContext2D, o: DrawOptions) {
  const { width: W, height: H, preset, params, frame } = o;
  const r = isoRect(W, H);
  const scale = Math.min(W, H) / 1000;
  const knots = textToKnots(o.text);
  const n = knots.length;
  const yaw = frame ? yawOf(frame.k, frame.n) : 0;

  drawBasePlane(ctx, r, params.gridOpacity, scale, preset, yaw);

  if (n === 0) {
    if (frame && o.plate !== false) drawFrameHeader(ctx, W, H, frame);
    return;
  }

  const curve = n >= 2 ? catmullRom(knots, params.tension, samplesPerSegment(n)) : { pts: knots, seg: [0] };

  // Base-plane shadow of the path: reads as a 3D chart, and shows the flat route
  // the curve would have taken.
  if (params.gridOpacity > 0 && n >= 2) {
    const ink = contrastInk(preset.bg);
    ctx.strokeStyle = `rgba(${ink.r},${ink.g},${ink.b},${(params.gridOpacity * 0.3).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    curve.pts.forEach((p, i) => {
      const q = isoPx({ x: p.x, y: p.y, z: 0 }, r, yaw);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();
  }

  if (n >= 2) {
    const px = curve.pts.map((p, i) => isoPx({ x: p.x, y: p.y, z: zOf(curve.seg[i], n) }, r, yaw));
    strokeRibbon(ctx, px, curve.seg, n, preset, Math.max(1, params.thickness * scale));
  } else {
    const p = isoPx({ x: knots[0].x, y: knots[0].y, z: zOf(0, 1) }, r, yaw);
    const s = params.thickness * scale;
    ctx.fillStyle = colorFor(0, 1, preset);
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
  }

  if (frame) {
    // Animated frames carry no stems: the marker owns the reserved hue range,
    // and the frame header already states which character this is.
    drawMarker(ctx, knots, frame, r, scale, params.thickness, yaw, preset);
    if (o.plate !== false) drawFrameHeader(ctx, W, H, frame);
    return;
  }

  // Stems go on last, after the curve. Drawn first, every place the curve crossed
  // one would cut it into two shorter runs, and the decoder would read those as
  // two extra characters.
  if (params.stems) drawStems(ctx, knots, n, preset, r, scale, params.thickness);

  if (params.showBar && preset.hueOrdered) drawCalibrationBar(ctx, r.bar, n, scale);
}

/**
 * Highlights the one knot this frame is about, with a drop line to the base so
 * the eye can place it. Position plus the frame's own k is everything the
 * decoder needs: k gives the knot's height and the camera angle, and those make
 * the projection invertible. Drawn in black or white, so a frame needs no colour
 * at all -- see palette.markerInk.
 */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  knots: Point[],
  frame: FrameHeader,
  r: IsoRect,
  scale: number,
  thickness: number,
  yaw: number,
  preset: Preset,
) {
  const knot = knots[Math.min(frame.k, knots.length - 1)];
  const z = zOf(frame.k, knots.length);
  const at = isoPx({ x: knot.x, y: knot.y, z }, r, yaw);
  const foot = isoPx({ x: knot.x, y: knot.y, z: 0 }, r, yaw);

  // Mid grey, well away from both extremes: the decoder takes the median of the
  // marker's pixels, and a drop line sharing its tone would drag that median
  // down towards the base plane instead of leaving it on the square.
  const ink = markerInk(preset.bg);
  ctx.strokeStyle = "rgb(128,128,128)";
  ctx.lineWidth = Math.max(1, thickness * scale * 0.35);
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(foot.x, foot.y);
  ctx.stroke();

  // Floor of 6px: GIF frames are small, and the decoder needs enough marker
  // pixels left after quantisation to take a stable median.
  const s = Math.max(6, thickness * scale * 1.6);
  ctx.fillStyle = `rgb(${ink.join(",")})`;
  ctx.fillRect(at.x - s, at.y - s, s * 2, s * 2);
}

/** Wireframe 6x5 grid lying at z = 0. Projection is affine, so cell edges stay straight. */
function drawBasePlane(
  ctx: CanvasRenderingContext2D,
  r: IsoRect,
  opacity: number,
  scale: number,
  preset: Preset,
  yaw = 0,
) {
  if (opacity <= 0) return;
  const ink = contrastInk(preset.bg);
  ctx.strokeStyle = `rgba(${ink.r},${ink.g},${ink.b},${(opacity * 0.5).toFixed(3)})`;
  ctx.lineWidth = Math.max(1, scale);
  ctx.beginPath();
  for (let i = 0; i <= COLS; i++) {
    const a = isoPx({ x: i / COLS, y: 0, z: 0 }, r, yaw);
    const b = isoPx({ x: i / COLS, y: 1, z: 0 }, r, yaw);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (let j = 0; j <= ROWS; j++) {
    const a = isoPx({ x: 0, y: j / ROWS, z: 0 }, r, yaw);
    const b = isoPx({ x: 1, y: j / ROWS, z: 0 }, r, yaw);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

/**
 * A vertical drop from each knot to the base plane.
 *
 * This is the geometric channel. Stems sit in a darker brightness band than the
 * curve (see palette.STEM_LIGHT), so the decoder can isolate them from the curve
 * outright, and each is one flat hue while the curve's changes continuously. From
 * a stem the decoder reads both the character -- where the foot lands on the base
 * plane -- and its position in the message -- how tall it is -- without trusting
 * colour at all.
 */
function drawStems(
  ctx: CanvasRenderingContext2D,
  knots: Point[],
  n: number,
  preset: Preset,
  r: IsoRect,
  scale: number,
  thickness: number,
) {
  ctx.lineWidth = Math.max(1, thickness * scale * 0.5);
  ctx.lineCap = "butt";
  // Stop short of the knot. Touching it would let the run continue into curve
  // pixels, whose hue at the knot is identical to the stem's, adding a length
  // bias that varies with how vertical the curve happens to be just there.
  const gap = STEM_GAP * thickness * scale;
  for (let k = 0; k < n; k++) {
    const top = isoPx({ x: knots[k].x, y: knots[k].y, z: zOf(k, n) }, r);
    const foot = isoPx({ x: knots[k].x, y: knots[k].y, z: 0 }, r);
    if (foot.y - top.y <= gap + 1) continue;
    ctx.strokeStyle = stemColorFor(k, n, preset);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y + gap);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
  }
}

// --- shared ----------------------------------------------------------------

/**
 * Canvas2D has no gradient along an arbitrary path, so the polyline is stroked
 * segment by segment with its own colour. Round caps are structural, not
 * decorative: without them consecutive one-sample segments leave gaps on curves.
 */
function strokeRibbon(
  ctx: CanvasRenderingContext2D,
  px: Point[],
  seg: number[],
  knotCount: number,
  preset: Preset,
  width: number,
) {
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < px.length - 1; i++) {
    ctx.beginPath();
    ctx.moveTo(px[i].x, px[i].y);
    ctx.lineTo(px[i + 1].x, px[i + 1].y);
    ctx.strokeStyle = colorFor((seg[i] + seg[i + 1]) / 2, knotCount, preset);
    ctx.stroke();
  }
}

/**
 * One swatch per character at that character's exact hue. Counting the swatches
 * yields the message length. Always drawn at full chroma, independent of the
 * preset, because it is a machine target rather than art.
 */
function drawCalibrationBar(ctx: CanvasRenderingContext2D, bar: Rect, knotCount: number, scale: number) {
  if (knotCount < 2) return;
  const w = bar.w / knotCount;
  for (let k = 0; k < knotCount; k++) {
    ctx.fillStyle = `hsl(${hueAt(k, knotCount).toFixed(2)}, 100%, 50%)`;
    // Overlap by a pixel: gaps would let the background bleed through and split
    // a swatch into two runs when the decoder scans the band.
    ctx.fillRect(bar.x + k * w, bar.y, w + 1, bar.h);
  }
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
}

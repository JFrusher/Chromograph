/** Canvas2D renderer. Pure: same inputs -> same pixels. */

import { CELLS, COLS, ROWS, cellCenter, textToKnots, type Point } from "./grid.ts";
import { catmullRom } from "./spline.ts";
import { colorFor, contrastInk, hueAt, type Preset } from "./palette.ts";

export type RenderParams = {
  tension: number;
  /** Core stroke width, in px, relative to a 1000px canvas. */
  thickness: number;
  gridOpacity: number;
  showBar: boolean;
};

export const DEFAULT_PARAMS: RenderParams = {
  tension: 1,
  thickness: 6,
  gridOpacity: 0.35,
  showBar: true,
};

export type PlotRect = { x: number; y: number; w: number; h: number; cell: number; bar: Rect };
type Rect = { x: number; y: number; w: number; h: number };

/**
 * Where the 6x5 grid sits inside a WxH canvas.
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

/** Normalised grid coords -> device pixels. */
const toPx = (p: Point, r: PlotRect) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });

export type DrawOptions = {
  text: string;
  params: RenderParams;
  preset: Preset;
  width: number;
  height: number;
};

export function drawChromograph(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const { width: W, height: H, preset, params } = o;
  const r = plotRect(W, H);
  const scale = Math.min(W, H) / 1000;

  ctx.save();
  ctx.fillStyle = preset.bg;
  ctx.fillRect(0, 0, W, H);

  drawGrid(ctx, r, params.gridOpacity, scale, preset);

  const knots = textToKnots(o.text);
  if (knots.length >= 2) {
    const curve = catmullRom(knots, params.tension, samplesPerSegment(knots.length));
    const px = curve.pts.map((p) => toPx(p, r));
    strokeRibbon(ctx, px, curve.seg, knots.length, preset, Math.max(1, params.thickness * scale));
  } else if (knots.length === 1) {
    const p = toPx(knots[0], r);
    ctx.fillStyle = colorFor(0, 1, preset);
    ctx.fillRect(
      p.x - params.thickness * scale,
      p.y - params.thickness * scale,
      params.thickness * scale * 2,
      params.thickness * scale * 2,
    );
  }

  if (params.showBar && preset.decodable) drawCalibrationBar(ctx, r.bar, knots.length, scale);
  ctx.restore();
}

/** Keep total samples near 1500 regardless of message length. */
const samplesPerSegment = (knotCount: number) =>
  Math.min(64, Math.max(8, Math.round(1500 / Math.max(1, knotCount - 1))));

/** Grid marks are crosses rather than dots -- a plotter tick, not a soft point. */
function drawGrid(ctx: CanvasRenderingContext2D, r: PlotRect, opacity: number, scale: number, preset: Preset) {
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
 * One swatch per character at that character's exact hue. This is the decoder's
 * primary reference: counting the swatches yields the message length, which is
 * what turns the hue ramp back into discrete knots. Always drawn at full chroma,
 * independent of the preset, because it is a machine target rather than art.
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
  // Hard 1px rule around the strip, in the spirit of a printed colour target.
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
}

/**
 * Fixed axonometric projection.
 *
 * The camera is deliberately not adjustable. The projection has to be known to
 * the decoder for the image to be readable at all, so it is a constant, not a
 * setting.
 *
 * Two properties are load-bearing:
 *
 *   1. The z axis projects to pure screen-vertical (z appears in `sy` only), so
 *      a stem dropped from a knot to the base plane is an exactly vertical line
 *      on screen, and its pixel length is a direct measure of z.
 *   2. Given z, the projection inverts exactly, so the foot of a stem gives back
 *      the grid cell it stands on.
 */

import type { Point } from "./grid.ts";

const KX = Math.cos(Math.PI / 6); // 0.866: half-width of the base rhombus
const KY = Math.sin(Math.PI / 6); // 0.5:   half-depth, foreshortened
/** Height of the z axis in the same units as the projected base plane. */
export const ZH = 0.9;

export type P3 = { x: number; y: number; z: number };

/** Screen-space bounds of the whole scene, before it is fitted to a canvas. */
export const ISO_BOX = { x0: -KX, x1: KX, y0: -KY - ZH, y1: KY };

/**
 * Height of knot k, in 0..1.
 *
 * Note `(k + 1) / n`, not `k / (n - 1)`: the first character must still have a
 * stem with non-zero length, or the decoder cannot see it and undercounts.
 */
export const zOf = (k: number, n: number) => (n < 1 ? 0 : (k + 1) / n);

export function project(p: P3): Point {
  const X = p.x - 0.5;
  const Y = p.y - 0.5;
  return { x: (X - Y) * KX, y: (X + Y) * KY - p.z * ZH };
}

/** Screen point + known height -> grid coordinates. Exact inverse of `project`. */
export function unproject(sx: number, sy: number, z: number): Point {
  const u = sx / KX; // X - Y
  const v = (sy + z * ZH) / KY; // X + Y
  return { x: (u + v) / 2 + 0.5, y: (v - u) / 2 + 0.5 };
}

export type IsoRect = {
  /** Canvas-space origin of ISO_BOX's top-left corner. */
  x: number;
  y: number;
  /** Scale from projected units to pixels. */
  s: number;
  /** Pixel length of a full-height stem (z = 1). */
  zPx: number;
  bar: { x: number; y: number; w: number; h: number };
};

/**
 * Where the scene sits inside a WxH canvas. A pure function of the canvas size:
 * the decoder recomputes it from the image dimensions alone. The calibration
 * bar's slot is reserved whether or not the bar is drawn.
 */
export function isoRect(W: number, H: number): IsoRect {
  const pad = 0.06 * Math.min(W, H);
  const barH = 0.06 * H;
  const gap = 0.02 * H;
  const availW = W - 2 * pad;
  const availH = H - 2 * pad - barH - gap;
  const boxW = ISO_BOX.x1 - ISO_BOX.x0;
  const boxH = ISO_BOX.y1 - ISO_BOX.y0;
  const s = Math.min(availW / boxW, availH / boxH);
  return {
    x: (W - boxW * s) / 2,
    y: pad + (availH - boxH * s) / 2,
    s,
    zPx: ZH * s,
    bar: { x: pad, y: pad + availH + gap, w: W - 2 * pad, h: barH },
  };
}

/** 3D grid point -> canvas pixels. */
export function toPx(p: P3, r: IsoRect): Point {
  const sp = project(p);
  return { x: r.x + (sp.x - ISO_BOX.x0) * r.s, y: r.y + (sp.y - ISO_BOX.y0) * r.s };
}

/** Canvas pixels + known height -> grid coordinates. */
export function fromPx(px: number, py: number, z: number, r: IsoRect): Point {
  return unproject((px - r.x) / r.s + ISO_BOX.x0, (py - r.y) / r.s + ISO_BOX.y0, z);
}

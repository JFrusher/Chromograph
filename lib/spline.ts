/** Centripetal Catmull-Rom sampling. */

import type { Point } from "./grid.ts";

export type Curve = {
  /** Sampled polyline. */
  pts: Point[];
  /** Fractional knot index of each sample: seg[i] === 2.5 is halfway between knot 2 and 3. */
  seg: number[];
};

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Mirror `a` through `b` to synthesise a phantom control point at the ends. */
const reflect = (a: Point, b: Point): Point => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });

/**
 * @param tension 0 = straight polyline through the knots, 1 = full spline.
 *
 * Centripetal (alpha = 0.5) parameterisation is deliberate: uniform Catmull-Rom
 * overshoots on tight turns, and an overshoot pushes the curve through cells the
 * text never visited, which is exactly what confuses the decoder.
 */
export function catmullRom(knots: Point[], tension = 1, samplesPerSegment = 32): Curve {
  if (knots.length === 0) return { pts: [], seg: [] };
  if (knots.length === 1) return { pts: [knots[0]], seg: [0] };

  const n = knots.length;
  const pts: Point[] = [];
  const seg: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? knots[i - 1] : reflect(knots[0], knots[1]);
    const p1 = knots[i];
    const p2 = knots[i + 1];
    const p3 = i + 2 < n ? knots[i + 2] : reflect(knots[n - 1], knots[n - 2]);

    // Coincident points would divide by zero; nudge instead of special-casing.
    const span = (a: Point, b: Point) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6);
    const t0 = 0;
    const t1 = t0 + span(p0, p1);
    const t2 = t1 + span(p1, p2);
    const t3 = t2 + span(p2, p3);

    for (let j = 0; j < samplesPerSegment; j++) {
      const u = j / samplesPerSegment;
      const t = lerp(t1, t2, u);

      const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
      const a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y;
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
      const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
      const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;

      const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
      const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
      const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;

      const cx = ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x;
      const cy = ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y;

      pts.push({
        x: lerp(lerp(p1.x, p2.x, u), cx, tension),
        y: lerp(lerp(p1.y, p2.y, u), cy, tension),
      });
      seg.push(i + u);
    }
  }

  pts.push(knots[n - 1]);
  seg.push(n - 1);
  return { pts, seg };
}

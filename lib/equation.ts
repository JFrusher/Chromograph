/**
 * The artwork as an equation.
 *
 * The path is fitted as a truncated Fourier series in x and y. z needs no fit at
 * all: by construction the height of the curve is exactly linear in the curve
 * parameter, z(t) = (t(N-1) + 1) / N, so the whole 3D figure is a 2D Fourier
 * series plus a straight line.
 *
 * The path is open, and a Fourier series on an open path rings badly at the seam
 * where the end fails to meet the start. So the path is mirrored before fitting:
 * forwards then backwards makes one continuous closed loop of twice the length,
 * and the series converges quickly with no seam to ring at. The consequence is
 * that the harmonics sit at half-integer frequency -- cos(pi k t) rather than
 * cos(2 pi k t) -- and t in 0..1 traces the path once, being half a period.
 *
 * It is still an approximation. `rms` reports the actual error in grid units
 * rather than leaving it to be assumed away.
 */

import { textToKnots } from "./grid.ts";
import { catmullRom } from "./spline.ts";

/** Samples used for the fit. Power of two, comfortably above any usable N. */
const SAMPLES = 512;

export type FourierFit = {
  knotCount: number;
  harmonics: number;
  /** Constant terms (a0 / 2). */
  cx: number;
  cy: number;
  ax: number[];
  bx: number[];
  ay: number[];
  by: number[];
  /** RMS reconstruction error, in grid units where the whole grid is 1 x 1. */
  rms: number;
};

export function fitFourier(text: string, tension = 1, harmonics?: number): FourierFit | null {
  const knots = textToKnots(text);
  const n = knots.length;
  if (n < 2) return null;

  // Four harmonics per character. Two is enough to see each letter's wiggle but
  // leaves visible error; four lands the fit a few percent of a cell off, which
  // is below what the decoder cares about.
  const m = harmonics ?? Math.min(192, Math.max(24, n * 4));

  const curve = catmullRom(knots, tension, Math.ceil(SAMPLES / (n - 1)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let p = 0; p < SAMPLES; p++) {
    const i = Math.min(curve.pts.length - 1, Math.round((p / SAMPLES) * (curve.pts.length - 1)));
    xs.push(curve.pts[i].x);
    ys.push(curve.pts[i].y);
  }

  // Even extension: the path, then the path reversed. One closed loop, no seam.
  const mirror = (v: number[]) => [...v, ...v.slice().reverse()];
  const mx = mirror(xs);
  const my = mirror(ys);
  const P2 = mx.length;

  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const cx = mean(mx);
  const cy = mean(my);

  const ax: number[] = [];
  const bx: number[] = [];
  const ay: number[] = [];
  const by: number[] = [];
  for (let k = 1; k <= m; k++) {
    let axk = 0;
    let bxk = 0;
    let ayk = 0;
    let byk = 0;
    for (let p = 0; p < P2; p++) {
      const ang = (2 * Math.PI * k * p) / P2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      axk += mx[p] * c;
      bxk += mx[p] * s;
      ayk += my[p] * c;
      byk += my[p] * s;
    }
    ax.push((2 / P2) * axk);
    bx.push((2 / P2) * bxk);
    ay.push((2 / P2) * ayk);
    by.push((2 / P2) * byk);
  }

  let sq = 0;
  for (let p = 0; p < SAMPLES; p++) {
    const t = p / SAMPLES;
    sq += (evaluate(cx, ax, bx, t) - xs[p]) ** 2 + (evaluate(cy, ay, by, t) - ys[p]) ** 2;
  }

  return { knotCount: n, harmonics: m, cx, cy, ax, bx, ay, by, rms: Math.sqrt(sq / SAMPLES) };
}

/** t in 0..1 traces the path once; the underlying period is 2. */
function evaluate(c: number, a: number[], b: number[], t: number): number {
  let v = c;
  for (let k = 1; k <= a.length; k++) {
    const ang = Math.PI * k * t;
    v += a[k - 1] * Math.cos(ang) + b[k - 1] * Math.sin(ang);
  }
  return v;
}

const n6 = (v: number) => v.toFixed(6);

/** Plain-text coefficient listing: the artwork as a few hundred numbers. */
export function fourierText(fit: FourierFit, text: string): string {
  const lines = [
    "Chromograph - Fourier form",
    "",
    `message      ${text}`,
    `characters   ${fit.knotCount}`,
    `harmonics    ${fit.harmonics}`,
    `rms error    ${fit.rms.toExponential(3)} grid units, or ${((fit.rms / (1 / 6)) * 100).toFixed(1)}% of one cell`,
    "",
    "for t in 0..1:",
    "x(t) = cx + sum over k of [ ax_k cos(pi k t) + bx_k sin(pi k t) ]",
    "y(t) = cy + sum over k of [ ay_k cos(pi k t) + by_k sin(pi k t) ]",
    `z(t) = (t * ${fit.knotCount - 1} + 1) / ${fit.knotCount}`,
    "",
    `cx = ${n6(fit.cx)}`,
    `cy = ${n6(fit.cy)}`,
    "",
    "k        ax           bx           ay           by",
  ];
  for (let k = 0; k < fit.harmonics; k++) {
    lines.push(
      `${String(k + 1).padStart(3)}  ${n6(fit.ax[k]).padStart(11)}  ${n6(fit.bx[k]).padStart(11)}` +
        `  ${n6(fit.ay[k]).padStart(11)}  ${n6(fit.by[k]).padStart(11)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Desmos-pasteable parametric. One expression per line; paste the whole block.
 *
 * Desmos' y axis points up and the grid's points down, hence `1 - Y(t)`.
 */
export function desmosText(fit: FourierFit): string {
  const list = (v: number[]) => `[${v.map(n6).join(",")}]`;
  return [
    `A_{x}=${list(fit.ax)}`,
    `B_{x}=${list(fit.bx)}`,
    `A_{y}=${list(fit.ay)}`,
    `B_{y}=${list(fit.by)}`,
    `M=${fit.harmonics}`,
    `X(t)=${n6(fit.cx)}+\\sum_{k=1}^{M}\\left(A_{x}\\left[k\\right]\\cos\\left(\\pi kt\\right)+B_{x}\\left[k\\right]\\sin\\left(\\pi kt\\right)\\right)`,
    `Y(t)=${n6(fit.cy)}+\\sum_{k=1}^{M}\\left(A_{y}\\left[k\\right]\\cos\\left(\\pi kt\\right)+B_{y}\\left[k\\right]\\sin\\left(\\pi kt\\right)\\right)`,
    `Z(t)=\\frac{t\\left(${fit.knotCount - 1}\\right)+1}{${fit.knotCount}}`,
    `\\left(X\\left(t\\right),1-Y\\left(t\\right)\\right)`,
  ].join("\n");
}

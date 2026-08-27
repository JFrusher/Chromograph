/**
 * Four-point projective transform, solved directly.
 *
 * The phone sees the show frame as an arbitrary quadrilateral: it does not know
 * the monitor's size, its distance, or how far the phone is tilted. Four known
 * fiducial centres and their four observed positions pin the mapping exactly,
 * which is the whole of the registration problem.
 *
 * Only one direction is ever needed. The rectifying warp maps each output pixel
 * back to a source pixel, which is canonical -> camera, and that is the same
 * direction the header band's cell centres are sampled in. There is no inverse
 * here; a caller wanting the other direction solves again with the arguments
 * swapped rather than inverting a matrix.
 */

import type { Point } from "./grid.ts";

/** Row-major 3x3. `h[8]` is pinned to 1, which fixes the free scale factor. */
export type Homography = Float64Array;

/** Below this a pivot means the source points were collinear or coincident. */
const EPS_PIVOT = 1e-9;
/** Below this a point has mapped onto the horizon and has no finite image. */
const EPS_W = 1e-6;

/**
 * Direct linear transform over four correspondences.
 *
 * Feed *normalised* coordinates -- roughly -1..1 on both axes, on both sides.
 * The `-x*u` terms are products of two coordinates, so at raw pixel magnitudes
 * they reach ~1e5 sitting beside the literal `1` entries, and six orders of
 * dynamic range in one row is where plain elimination starts shedding digits.
 * Normalising the inputs is a few lines at the call site and saves composing
 * Hartley matrices in here.
 *
 * Returns null rather than throwing: a degenerate quad is an ordinary thing for
 * a camera to see, not a programming error.
 */
export function solveHomography(src: Point[], dst: Point[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  // Augmented 8x9. Each correspondence contributes two rows:
  //   [ x y 1 0 0 0  -xu -yu | u ]
  //   [ 0 0 0 x y 1  -xv -yv | v ]
  const m = new Float64Array(8 * 9);
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    const a = i * 2 * 9;
    const b = (i * 2 + 1) * 9;
    m[a] = x; m[a + 1] = y; m[a + 2] = 1;
    m[a + 6] = -x * u; m[a + 7] = -y * u; m[a + 8] = u;
    m[b + 3] = x; m[b + 4] = y; m[b + 5] = 1;
    m[b + 6] = -x * v; m[b + 7] = -y * v; m[b + 8] = v;
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(m[r * 9 + col]) > Math.abs(m[piv * 9 + col])) piv = r;
    }
    if (Math.abs(m[piv * 9 + col]) < EPS_PIVOT) return null;
    if (piv !== col) {
      for (let c = col; c < 9; c++) {
        const t = m[col * 9 + c];
        m[col * 9 + c] = m[piv * 9 + c];
        m[piv * 9 + c] = t;
      }
    }
    const d = m[col * 9 + col];
    for (let r = col + 1; r < 8; r++) {
      const f = m[r * 9 + col] / d;
      if (f === 0) continue;
      for (let c = col; c < 9; c++) m[r * 9 + c] -= f * m[col * 9 + c];
    }
  }

  const h = new Float64Array(9);
  h[8] = 1;
  for (let r = 7; r >= 0; r--) {
    let s = m[r * 9 + 8];
    for (let c = r + 1; c < 8; c++) s -= m[r * 9 + c] * h[c];
    h[r] = s / m[r * 9 + r];
  }
  return h;
}

/**
 * Apply the transform. Null when the point lands on the horizon -- only reachable
 * at absurd tilt, but a silent Infinity propagating into the warp loop is a far
 * worse afternoon than a skipped sample.
 */
export function applyH(h: Homography, p: Point): Point | null {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < EPS_W) return null;
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

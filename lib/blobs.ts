/**
 * Finding the fiducials in a camera frame.
 *
 * Deliberately crude. The four corner squares are the only things that need
 * locating, everything about them is known in advance, and a wrong answer is
 * caught downstream by the band's CRC rather than by being clever here. So this
 * is a threshold, a flood fill, and four cheap rejection tests -- no shape
 * classifier, no sub-pixel refinement, no scale space.
 *
 * Precision is not the bottleneck, which is what licenses all of that. A two
 * pixel centroid error at 640x360 is about 0.3% of the artwork's width, which
 * reaches the grid as roughly 0.005 against a snap tolerance of 0.07. Fourteen
 * times the margin needed.
 */

import type { ImageDataLike } from "./decode.ts";

export type Blob = {
  /** Pixel count. */
  n: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

const lumaAt = (data: ImageDataLike["data"], o: number) =>
  data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;

/**
 * Split the frame into ink and background.
 *
 * Not Otsu. The scene is strongly bimodal -- a bright monitor in a dimmer room --
 * so the midpoint of the 5th and 95th percentiles lands in the same valley for a
 * third of the code. Sampling every `stride`th pixel keeps it to a few tens of
 * thousands of reads.
 *
 * ponytail: percentile midpoint, swap in Otsu if a mixed-lighting room defeats it.
 */
export function threshold(img: ImageDataLike, stride = 4): number {
  const { width: W, height: H, data } = img;
  const hist = new Int32Array(256);
  let count = 0;
  for (let i = 0; i < W * H; i += stride) {
    hist[lumaAt(data, i * 4) | 0]++;
    count++;
  }
  if (count === 0) return 128;

  const at = (frac: number) => {
    const want = frac * count;
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += hist[v];
      if (seen >= want) return v;
    }
    return 255;
  };
  return (at(0.05) + at(0.95)) / 2;
}

export type BlobOptions = {
  /** Smaller than this is sensor noise, not a fiducial. */
  minArea?: number;
  /** Larger than this share of the frame is a window or a lamp. */
  maxAreaFrac?: number;
  /** A fiducial is square; perspective skews it, but only so far. */
  minAspect?: number;
  maxAspect?: number;
  /** A solid square fills its own bounding box. A glare streak or an L does not. */
  minFill?: number;
};

const DEFAULTS: Required<BlobOptions> = {
  minArea: 40,
  maxAreaFrac: 0.03,
  minAspect: 0.35,
  maxAspect: 2.8,
  minFill: 0.6,
};

/**
 * Four-connected components of the ink, filtered down to plausible fiducials.
 *
 * `bright` selects polarity: the fiducials are drawn in whichever of black or
 * white contrasts the preset's background, so both readings are tried by the
 * caller and the one that yields a parsable band wins.
 *
 * The stack is an explicit Int32Array. A recursive fill is shorter and blows the
 * JS call stack on the first large bright region it meets, which at 640x360 is
 * any window in shot.
 */
export function findBlobs(img: ImageDataLike, thr: number, bright: boolean, opts: BlobOptions = {}): Blob[] {
  const { minArea, maxAreaFrac, minAspect, maxAspect, minFill } = { ...DEFAULTS, ...opts };
  const { width: W, height: H, data } = img;
  const total = W * H;
  const maxArea = maxAreaFrac * total;

  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const out: Blob[] = [];

  const isInk = (i: number) => {
    const l = lumaAt(data, i * 4);
    return bright ? l > thr : l < thr;
  };

  for (let start = 0; start < total; start++) {
    if (seen[start] || !isInk(start)) continue;

    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;

    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W;
      const y = (i / W) | 0;
      n++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      if (x > 0 && !seen[i - 1] && isInk(i - 1)) (seen[i - 1] = 1), (stack[sp++] = i - 1);
      if (x < W - 1 && !seen[i + 1] && isInk(i + 1)) (seen[i + 1] = 1), (stack[sp++] = i + 1);
      if (y > 0 && !seen[i - W] && isInk(i - W)) (seen[i - W] = 1), (stack[sp++] = i - W);
      if (y < H - 1 && !seen[i + W] && isInk(i + W)) (seen[i + W] = 1), (stack[sp++] = i + W);
    }

    if (n < minArea || n > maxArea) continue;
    // A blob running off the edge is the bezel, a lamp, or the frame itself --
    // never a fiducial, which always has its quiet zone in shot when the whole
    // pattern is.
    if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const aspect = bw / bh;
    if (aspect < minAspect || aspect > maxAspect) continue;
    if (n / (bw * bh) < minFill) continue;

    out.push({ n, cx: sx / n, cy: sy / n, x0, y0, x1, y1 });
  }

  return out;
}

/**
 * The four extreme corners of a set of blobs, as top-left, top-right,
 * bottom-right, bottom-left in image space.
 *
 * Band cells share the fiducials' ink and roughly their size, so no area filter
 * separates them -- but the fiducials sit at the annulus corners, outside the
 * span the cells run along, so they win every extremity outright.
 *
 * Image space, note, not canonical space: a rotated phone puts the canonical
 * top-left somewhere else entirely. Resolving that is the caller's four
 * orientation hypotheses.
 */
export function cornerQuad(blobs: Blob[]): [Blob, Blob, Blob, Blob] | null {
  if (blobs.length < 4) return null;

  const pick = (score: (b: Blob) => number) => {
    let best = blobs[0];
    for (const b of blobs) if (score(b) < score(best)) best = b;
    return best;
  };
  const tl = pick((b) => b.cx + b.cy);
  const tr = pick((b) => -(b.cx - b.cy));
  const br = pick((b) => -(b.cx + b.cy));
  const bl = pick((b) => b.cx - b.cy);

  const quad: [Blob, Blob, Blob, Blob] = [tl, tr, br, bl];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) if (quad[i] === quad[j]) return null;
  }
  return quad;
}

/**
 * Reject a quad that could not be a rectangle seen through a camera.
 *
 * Convexity and a sane side ratio between them throw out the cases where a
 * shadow or a reflection won an extremity contest. Anything subtler is left to
 * the band's CRC, which rejects it for free.
 */
export function plausibleQuad(quad: { cx: number; cy: number }[], W: number, H: number): boolean {
  if (quad.length !== 4) return false;

  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.cx - a.cx) * (c.cy - b.cy) - (b.cy - a.cy) * (c.cx - b.cx);
    if (cross === 0) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }

  let area = 0;
  let shortest = Infinity;
  let longest = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area += a.cx * b.cy - b.cx * a.cy;
    const side = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    if (side < shortest) shortest = side;
    if (side > longest) longest = side;
  }
  area = Math.abs(area) / 2;

  // Too small to read, or so elongated it cannot be a rectangle at any tilt a
  // hand holds.
  if (area < 0.01 * W * H) return false;
  if (longest / shortest > 4) return false;
  return true;
}

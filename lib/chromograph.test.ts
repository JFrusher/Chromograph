/**
 * Run with: npm test   (node --test, native TypeScript stripping, no framework)
 *
 * The pixel tests rasterise a Chromograph into a plain RGBA buffer with a ~20 line
 * disc stamper rather than a canvas, so the encode -> pixels -> decode roundtrip is
 * covered without a browser or a headless canvas dependency.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CHARSET, CELL_PITCH, cellCenter, nearestCell, sanitize, textToKnots, MAX_CHARS } from "./grid.ts";
import { catmullRom } from "./spline.ts";
import { HUE_SPAN, hueAt } from "./palette.ts";
import { plotRect } from "./render.ts";
import { decode, type ImageDataLike } from "./decode.ts";

// --- grid -------------------------------------------------------------------

test("sanitize uppercases, strips unsupported characters and caps length", () => {
  assert.equal(sanitize("Hello, world!").text, "HELLO, WORLD");
  assert.equal(sanitize("Hello, world!").dropped, 1);
  const long = sanitize("A".repeat(MAX_CHARS + 20));
  assert.equal(long.text.length, MAX_CHARS);
  assert.equal(long.truncated, true);
});

test("charset covers exactly the 30 grid cells", () => {
  assert.equal(CHARSET.length, 30);
  assert.equal(new Set(CHARSET).size, 30);
});

test("repeated letters get distinct knots that still snap to the same cell", () => {
  const knots = textToKnots("LLL");
  assert.equal(knots.length, 3);
  const cell = CHARSET.indexOf("L");
  for (const k of knots) assert.equal(nearestCell(k).cell, cell);
  for (let i = 0; i < knots.length; i++) {
    for (let j = i + 1; j < knots.length; j++) {
      const d = Math.hypot(knots[i].x - knots[j].x, knots[i].y - knots[j].y);
      assert.ok(d > 0.03, `knots ${i} and ${j} only ${d.toFixed(4)} apart`);
    }
  }
});

test("every knot lands nearer its own cell centre than any neighbour", () => {
  // The whole decoder rests on this: an orbital offset must never cross a cell border.
  for (let cell = 0; cell < 30; cell++) {
    const ch = CHARSET[cell];
    for (const knot of textToKnots(ch.repeat(6))) {
      const hit = nearestCell(knot);
      assert.equal(hit.cell, cell);
      assert.ok(hit.dist < 0.42 * CELL_PITCH);
    }
  }
});

// --- spline -----------------------------------------------------------------

test("spline passes through every knot", () => {
  const knots = textToKnots("HELLO WORLD");
  const { pts, seg } = catmullRom(knots, 1, 32);
  for (let k = 0; k < knots.length; k++) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(seg[i] - k) > 1e-6) continue;
      best = Math.min(best, Math.hypot(pts[i].x - knots[k].x, pts[i].y - knots[k].y));
    }
    assert.ok(best < 1e-9, `knot ${k} off by ${best}`);
  }
});

test("seg indices are monotonic and span the knot range", () => {
  const knots = textToKnots("ABCDEF");
  const { seg } = catmullRom(knots, 1, 16);
  for (let i = 1; i < seg.length; i++) assert.ok(seg[i] >= seg[i - 1]);
  assert.equal(seg[0], 0);
  assert.equal(seg[seg.length - 1], knots.length - 1);
});

test("zero tension collapses the curve onto the straight polyline", () => {
  const knots = textToKnots("AZ.");
  const { pts, seg } = catmullRom(knots, 0, 8);
  for (let i = 0; i < pts.length; i++) {
    const s = seg[i];
    const a = knots[Math.floor(s)];
    const b = knots[Math.min(knots.length - 1, Math.floor(s) + 1)];
    const u = s - Math.floor(s);
    assert.ok(Math.hypot(pts[i].x - (a.x + (b.x - a.x) * u), pts[i].y - (a.y + (b.y - a.y) * u)) < 1e-9);
  }
});

// --- hue --------------------------------------------------------------------

test("hue advances uniformly per character and never wraps", () => {
  const n = 12;
  assert.equal(hueAt(0, n), 0);
  assert.equal(hueAt(n - 1, n), HUE_SPAN);
  assert.ok(HUE_SPAN < 360, "a full 360 ramp would put red at both ends");
  const step = hueAt(1, n) - hueAt(0, n);
  for (let k = 1; k < n; k++) {
    assert.ok(Math.abs(hueAt(k, n) - hueAt(k - 1, n) - step) < 1e-9);
  }
});

// --- rasteriser (test fixture) ----------------------------------------------

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.min(5, Math.floor(h / 60))];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Stamp the curve into an RGBA buffer as overlapping discs, plus the calibration bar. */
function rasterise(text: string, W: number, H: number, withBar = true): ImageDataLike {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 5;
    data[i * 4 + 1] = 3;
    data[i * 4 + 2] = 15;
    data[i * 4 + 3] = 255;
  }
  const disc = (cx: number, cy: number, rad: number, rgb: [number, number, number]) => {
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
      for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (Math.hypot(x - cx, y - cy) > rad) continue;
        const i = (y * W + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
      }
    }
  };

  const r = plotRect(W, H);
  const knots = textToKnots(text);
  const n = knots.length;
  const { pts, seg } = catmullRom(knots, 1, Math.min(64, Math.max(8, Math.round(1500 / Math.max(1, n - 1)))));
  for (let i = 0; i < pts.length; i++) {
    disc(r.x + pts[i].x * r.w, r.y + pts[i].y * r.h, 3, hslToRgb(hueAt(seg[i], n), 1, 0.55));
  }

  if (withBar) {
    const bw = r.bar.w / n;
    for (let k = 0; k < n; k++) {
      const rgb = hslToRgb(hueAt(k, n), 1, 0.5);
      for (let y = Math.round(r.bar.y); y < r.bar.y + r.bar.h; y++) {
        for (let x = Math.round(r.bar.x + k * bw); x < r.bar.x + (k + 1) * bw; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 4;
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
        }
      }
    }
  }
  return { width: W, height: H, data };
}

// --- decode -----------------------------------------------------------------

test("roundtrip via the calibration bar", () => {
  const text = "HELLO WORLD";
  const out = decode(rasterise(text, 900, 900));
  assert.equal(out.source, "calibration-bar");
  assert.equal(out.knotCount, text.length);
  assert.equal(out.text, text);
  assert.ok(out.chars.every((c) => c.confidence > 0.6));
});

test("roundtrip survives repeated letters and punctuation", () => {
  const text = "ALL GOOD, YES?";
  const out = decode(rasterise(text, 1000, 1000));
  assert.equal(out.text, text);
});

test("roundtrip of a long, self-intersecting message", () => {
  const text = "THE QUICK BROWN FOX JUMPS, LAZILY?";
  const out = decode(rasterise(text, 1400, 1400));
  assert.equal(out.knotCount, text.length);
  assert.equal(out.text, text);
});

test("roundtrip without a calibration bar falls back to fitting N", () => {
  const text = "CHROMOGRAPH";
  const out = decode(rasterise(text, 900, 900, false));
  assert.equal(out.source, "fit");
  assert.equal(out.text, text);
});

test("a blank image decodes to nothing instead of hallucinating text", () => {
  const data = new Uint8ClampedArray(400 * 400 * 4);
  for (let i = 0; i < 400 * 400; i++) data[i * 4 + 3] = 255;
  const out = decode({ width: 400, height: 400, data });
  assert.equal(out.text, "");
  assert.ok(out.warnings.length > 0);
});

test("cell centres are unique and inside the unit square", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const c = cellCenter(i);
    assert.ok(c.x > 0 && c.x < 1 && c.y > 0 && c.y < 1);
    seen.add(`${c.x},${c.y}`);
  }
  assert.equal(seen.size, 30);
});

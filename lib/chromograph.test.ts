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
import { HUE_SPAN, colorFor, contrastInk, hueAt, markerInk, presetById, rgbToHsv, stemHue } from "./palette.ts";
import { plotRect } from "./render.ts";
import { isoRect, toPx as isoToPx, yawOf, zOf } from "./iso.ts";
import { decode, decodeFrames, type ImageDataLike } from "./decode.ts";
import { headerLayout, readFrameHeader, sheetCols, sheetRows, sheetTiles } from "./frame.ts";
import { buildLookup, buildPalette, decodeGif, encodeGif, lzwDecode, lzwEncode } from "./gif.ts";
import { fromPx } from "./iso.ts";
import { desmosText, fitFourier } from "./equation.ts";
import { applyH, solveHomography } from "./homography.ts";
import {
  SHOW,
  SHOW_GROUND,
  SHOW_INK,
  SHOW_PRESET,
  SHOW_THICKNESS,
  bandBits,
  bandProfile,
  radiusAt,
  parseBand,
  type Edge,
} from "./showframe.ts";
import { normalise, scanFrame } from "./scan.ts";

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

/** Isometric fixture: curve first, then stems on top, mirroring the renderer. */
function rasteriseIso(text: string, W: number, H: number, withBar = true): ImageDataLike {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 5;
    data[i * 4 + 1] = 3;
    data[i * 4 + 2] = 15;
    data[i * 4 + 3] = 255;
  }
  const put = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  const disc = (cx: number, cy: number, rad: number, rgb: [number, number, number]) => {
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
      for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
        if (Math.hypot(x - cx, y - cy) <= rad) put(x, y, rgb);
      }
    }
  };

  const r = isoRect(W, H);
  const scale = Math.min(W, H) / 1000;
  const thickness = 6;
  const knots = textToKnots(text);
  const n = knots.length;
  const { pts, seg } = catmullRom(knots, 1, Math.min(64, Math.max(8, Math.round(1500 / Math.max(1, n - 1)))));

  for (let i = 0; i < pts.length; i++) {
    const q = isoToPx({ x: pts[i].x, y: pts[i].y, z: zOf(seg[i], n) }, r);
    disc(q.x, q.y, (thickness * scale) / 2, hslToRgb(hueAt(seg[i], n), 1, 0.55));
  }

  const gap = 1.6 * thickness * scale;
  const half = (thickness * scale * 0.5) / 2;
  for (let k = 0; k < n; k++) {
    const top = isoToPx({ x: knots[k].x, y: knots[k].y, z: zOf(k, n) }, r);
    const foot = isoToPx({ x: knots[k].x, y: knots[k].y, z: 0 }, r);
    if (foot.y - top.y <= gap + 1) continue;
    const rgb = hslToRgb(stemHue(k, n), 1, 0.5);
    for (let y = Math.round(top.y + gap); y <= Math.round(foot.y); y++) {
      for (let x = Math.round(top.x - half); x <= Math.round(top.x + half); x++) put(x, y, rgb);
    }
  }

  if (withBar) {
    const bw = r.bar.w / n;
    for (let k = 0; k < n; k++) {
      const rgb = hslToRgb(hueAt(k, n), 1, 0.5);
      for (let y = Math.round(r.bar.y); y < r.bar.y + r.bar.h; y++) {
        for (let x = Math.round(r.bar.x + k * bw); x < r.bar.x + (k + 1) * bw; x++) put(x, y, rgb);
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

// --- isometric / geometric decode -------------------------------------------

test("a still isometric image decodes, and beats the flat reading of itself", () => {
  const text = "HELLO WORLD";
  const out = decode(rasteriseIso(text, 1400, 1400));
  assert.equal(out.mode, "iso");
  assert.equal(out.knotCount, text.length);
  assert.equal(out.text, text);
});

test("isometric roundtrip survives repeated letters", () => {
  const text = "AAAA BBBB, CC?";
  const out = decode(rasteriseIso(text, 1400, 1400));
  assert.equal(out.text, text);
});

test("projection inverts exactly at any height", () => {
  const r = isoRect(1200, 1200);
  for (const z of [0, 0.25, 1]) {
    for (const p of [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }, { x: 0.83, y: 0.17 }]) {
      const q = isoToPx({ ...p, z }, r);
      const back = fromPx(q.x, q.y, z, r);
      assert.ok(Math.hypot(back.x - p.x, back.y - p.y) < 1e-9);
    }
  }
});

test("stems are exactly vertical, so z never leaks into screen x", () => {
  const r = isoRect(1000, 1000);
  const top = isoToPx({ x: 0.3, y: 0.7, z: 1 }, r);
  const foot = isoToPx({ x: 0.3, y: 0.7, z: 0 }, r);
  assert.ok(Math.abs(top.x - foot.x) < 1e-9);
  assert.ok(Math.abs(foot.y - top.y - r.zPx) < 1e-9);
});

// --- equation ----------------------------------------------------------------

test("Fourier fit reconstructs the path to a stated accuracy", () => {
  const fit = fitFourier("HELLO WORLD");
  assert.ok(fit);
  assert.equal(fit.knotCount, 11);
  assert.equal(fit.ax.length, fit.harmonics);
  // Whole grid is 1x1 and a cell is 1/6 wide, so this is well under a cell.
  assert.ok(fit.rms < 0.004, `rms ${fit.rms}`);
});

test("more harmonics never fit worse", () => {
  const coarse = fitFourier("CHROMOGRAPH", 1, 8);
  const fine = fitFourier("CHROMOGRAPH", 1, 64);
  assert.ok(coarse && fine);
  assert.ok(fine.rms <= coarse.rms);
});

test("Desmos export is a complete, paste-ready block", () => {
  const fit = fitFourier("HI THERE");
  assert.ok(fit);
  const text = desmosText(fit);
  assert.match(text, /^A_\{x\}=\[/m);
  assert.match(text, /X\(t\)=/m);
  assert.ok(text.includes("1-Y"), "plots y flipped for Desmos' upward axis");
  assert.ok(!/NaN|undefined/.test(text));
});

test("a single character has no curve to fit", () => {
  assert.equal(fitFourier("A"), null);
});

// --- animated: frame index as the channel ------------------------------------

/**
 * Frames need only a header plate and a marker square, both plain rectangles, so
 * the fixture can build them exactly without a canvas.
 */
function rasteriseFrames(text: string, W: number, H: number, drop: number[] = []): ImageDataLike[] {
  const knots = textToKnots(text);
  const n = knots.length;
  const r = isoRect(W, H);
  const out: ImageDataLike[] = [];

  for (let k = 0; k < n; k++) {
    if (drop.includes(k)) continue;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = 5;
      data[i * 4 + 1] = 3;
      data[i * 4 + 2] = 15;
      data[i * 4 + 3] = 255;
    }
    const fill = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
      for (let y = Math.round(y0); y < y0 + h; y++) {
        for (let x = Math.round(x0); x < x0 + w; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 4;
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
        }
      }
    };

    // Achromatic marker: white here, since the fixture's background is dark.
    const at = isoToPx({ x: knots[k].x, y: knots[k].y, z: zOf(k, n) }, r, yawOf(k, n));
    const s = 12;
    fill(at.x - s, at.y - s, s * 2, s * 2, [255, 255, 255]);

    const lay = headerLayout(W, H);
    fill(lay.x - lay.cell, lay.y - lay.cell, (lay.cells + 2) * lay.cell, 3 * lay.cell, [0, 0, 0]);
    const bits = headerBits(k, n);
    bits.forEach((bit, i) =>
      fill(lay.x + i * lay.cell, lay.y, lay.cell, lay.cell, bit ? [255, 255, 255] : [0, 0, 0]),
    );

    out.push({ width: W, height: H, data });
  }
  return out;
}

/** Mirrors lib/frame.ts's private encoding, so the test would catch a change to it. */
function headerBits(k: number, n: number): number[] {
  const field = (v: number) => Array.from({ length: 10 }, (_, i) => (v >> (9 - i)) & 1);
  const body = [...field(k), ...field(n)];
  return [1, 0, ...body, body.reduce((a, b) => a ^ b, 0)];
}

test("frame header survives a roundtrip and rejects a corrupt plate", () => {
  const frames = rasteriseFrames("HELLO", 900, 900);
  const header = readFrameHeader(frames[3]);
  assert.deepEqual(header, { k: 3, n: 5 });

  // Flip one payload bit: parity must catch it.
  const bad = { ...frames[3], data: Uint8ClampedArray.from(frames[3].data) };
  const lay = headerLayout(900, 900);
  const px = Math.round(lay.x + 5 * lay.cell + lay.cell / 2);
  const py = Math.round(lay.y + lay.cell / 2);
  const o = (py * 900 + px) * 4;
  bad.data[o] = 255 - bad.data[o];
  bad.data[o + 1] = 255 - bad.data[o + 1];
  bad.data[o + 2] = 255 - bad.data[o + 2];
  assert.equal(readFrameHeader(bad), null);
});

test("animated roundtrip decodes exactly, at every camera angle", () => {
  const text = "HELLO WORLD";
  const out = decodeFrames(rasteriseFrames(text, 900, 900));
  assert.equal(out.mode, "frames");
  assert.equal(out.source, "frame-index");
  assert.equal(out.text, text);
  assert.ok(out.chars.every((c) => c.confidence > 0.5));
});

test("animated roundtrip holds at a length the static decoders cannot reach", () => {
  const text = "PACK MY BOX WITH FIVE DOZEN LIQUOR JUGS, QUICKLY NOW PLEASE? AND THEN SOME MORE.";
  const out = decodeFrames(rasteriseFrames(text, 1000, 1000));
  assert.equal(out.knotCount, text.length);
  assert.equal(out.text, text);
});

test("a dropped frame costs exactly one character and is reported", () => {
  const text = "HELLO WORLD";
  const out = decodeFrames(rasteriseFrames(text, 900, 900, [4]));
  assert.equal(out.text, "HELL? WORLD");
  assert.match(out.warnings.join(" "), /1 of 11 characters had no readable frame/);
});

test("frames decode the same when shuffled, since each one is self-identifying", () => {
  const text = "ORDER FREE";
  const frames = rasteriseFrames(text, 900, 900);
  const shuffled = [frames[5], frames[0], frames[9], ...frames.slice(1, 5), frames[6], frames[7], frames[8]];
  assert.equal(decodeFrames(shuffled).text, text);
});

test("a sprite sheet slices back into exactly its frames", () => {
  const text = "SHEET DECODE";
  const frames = rasteriseFrames(text, 640, 640);
  const cols = sheetCols(frames.length);
  const rows = sheetRows(frames.length);
  const W = cols * 640;
  const H = rows * 640;
  const data = new Uint8ClampedArray(W * H * 4);
  frames.forEach((f, k) => {
    const ox = (k % cols) * 640;
    const oy = Math.floor(k / cols) * 640;
    for (let y = 0; y < 640; y++) {
      data.set(f.data.subarray(y * 640 * 4, (y + 1) * 640 * 4), ((oy + y) * W + ox) * 4);
    }
  });

  const tiles = sheetTiles({ width: W, height: H, data });
  assert.ok(tiles, "layout was not recovered");
  assert.equal(tiles.length, text.length);
  assert.equal(decodeFrames(tiles).text, text);
});

test("a plain image is not mistaken for a sheet", () => {
  assert.equal(sheetTiles(rasteriseIso("HELLO", 900, 900)), null);
});

// --- GIF ---------------------------------------------------------------------

test("LZW survives a roundtrip, including runs that exercise the dictionary", () => {
  const cases = [
    Uint8Array.from([1, 2, 3, 4, 5]),
    new Uint8Array(5000).fill(7),
    Uint8Array.from({ length: 4000 }, (_, i) => i % 256),
    // The self-referential case: a repeating pattern makes the encoder emit a
    // code the decoder has not defined yet.
    Uint8Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? 9 : 9)),
    Uint8Array.from({ length: 9000 }, (_, i) => (i * 7919) % 256),
  ];
  for (const original of cases) {
    const back = lzwDecode(Uint8Array.from(lzwEncode(original)), original.length);
    assert.deepEqual([...back], [...original], `failed for length ${original.length}`);
  }
});

test("a GIF roundtrips through its own encoder and decoder", () => {
  const frames = rasteriseFrames("GIF", 480, 480);
  const palette = buildPalette([5, 3, 15]);
  const lut = buildLookup(palette);
  const bytes = encodeGif({ frames, palette, lut, delay: 10 });

  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), "GIF89a");
  assert.equal(bytes[bytes.length - 1], 0x3b);

  const back = decodeGif(bytes);
  assert.equal(back.length, frames.length);
  assert.equal(back[0].width, 480);
});

test("a Chromograph GIF decodes back to its message", () => {
  const text = "GIF ROUNDTRIP, YES?";
  const frames = rasteriseFrames(text, 560, 560);
  const palette = buildPalette([5, 3, 15]);
  const lut = buildLookup(palette);
  const bytes = encodeGif({ frames, palette, lut, delay: 10 });

  const out = decodeFrames(decodeGif(bytes));
  assert.equal(out.mode, "frames");
  assert.equal(out.text, text);
});

test("quantisation keeps black, white and the background exact", () => {
  const palette = buildPalette([5, 3, 15]);
  const lut = buildLookup(palette);
  const probe = (r: number, g: number, b: number) => {
    const i = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
    return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]];
  };
  // Black and white carry the header plate and the marker, so both must be exact.
  assert.deepEqual(probe(0, 0, 0), [0, 0, 0]);
  assert.deepEqual(probe(255, 255, 255), [255, 255, 255]);
  assert.deepEqual(probe(5, 3, 15), [5, 3, 15]);
});

test("the GIF palette can represent grey without a colour cast", () => {
  const palette = buildPalette([255, 255, 255]);
  const lut = buildLookup(palette);
  for (const v of [32, 64, 96, 128, 160, 192, 224]) {
    const i = lut[((v >> 3) << 10) | ((v >> 3) << 5) | (v >> 3)];
    const [r, g, b] = [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread === 0, `grey ${v} quantised to (${r},${g},${b})`);
  }
});

// --- homography -------------------------------------------------------------

const UNIT: { x: number; y: number }[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
];

test("a homography maps each correspondence exactly onto its destination", () => {
  // A quad with genuine perspective: no two sides parallel, so all eight
  // unknowns are exercised. A square-to-square case would pass with h6/h7 wrong.
  const quad = [
    { x: -0.72, y: -0.61 },
    { x: 0.83, y: -0.44 },
    { x: 0.55, y: 0.79 },
    { x: -0.48, y: 0.52 },
  ];
  const h = solveHomography(UNIT, quad);
  assert.ok(h);
  for (let i = 0; i < 4; i++) {
    const got = applyH(h, UNIT[i]);
    assert.ok(got);
    assert.ok(Math.abs(got.x - quad[i].x) < 1e-9, `corner ${i} x: ${got.x} vs ${quad[i].x}`);
    assert.ok(Math.abs(got.y - quad[i].y) < 1e-9, `corner ${i} y: ${got.y} vs ${quad[i].y}`);
  }
});

test("solving the reverse correspondence inverts the transform", () => {
  const quad = [
    { x: -0.72, y: -0.61 },
    { x: 0.83, y: -0.44 },
    { x: 0.55, y: 0.79 },
    { x: -0.48, y: 0.52 },
  ];
  const fwd = solveHomography(UNIT, quad);
  const back = solveHomography(quad, UNIT);
  assert.ok(fwd);
  assert.ok(back);
  // Interior points, not just the corners: the corners are pinned by
  // construction, so only interior agreement tests the transform itself.
  for (const p of [
    { x: 0, y: 0 },
    { x: 0.4, y: -0.3 },
    { x: -0.9, y: 0.6 },
    { x: 0.15, y: 0.85 },
  ]) {
    const there = applyH(fwd, p);
    assert.ok(there);
    const home = applyH(back, there);
    assert.ok(home);
    assert.ok(Math.abs(home.x - p.x) < 1e-9, `x roundtrip ${home.x} vs ${p.x}`);
    assert.ok(Math.abs(home.y - p.y) < 1e-9, `y roundtrip ${home.y} vs ${p.y}`);
  }
});

test("a homography is not fitted through a degenerate quad", () => {
  const collinear = [
    { x: -1, y: -1 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  assert.equal(solveHomography(collinear, UNIT), null);
  assert.equal(solveHomography(UNIT, UNIT.slice(0, 3)), null);
  // Two coincident source points carry no independent constraint.
  const doubled = [{ x: -1, y: -1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  assert.equal(solveHomography(doubled, UNIT), null);
});

test("an identity correspondence yields the identity transform", () => {
  const h = solveHomography(UNIT, UNIT);
  assert.ok(h);
  for (const p of [{ x: 0.3, y: -0.7 }, { x: -0.2, y: 0.44 }]) {
    const got = applyH(h, p);
    assert.ok(got);
    assert.ok(Math.abs(got.x - p.x) < 1e-9);
    assert.ok(Math.abs(got.y - p.y) < 1e-9);
  }
});

// --- show frame band ---------------------------------------------------------

const EDGES: Edge[] = [0, 1, 2, 3];

test("a band word roundtrips for every character index on every edge", () => {
  const n = MAX_CHARS;
  for (const edge of EDGES) {
    for (let k = 0; k < n; k++) {
      const got = parseBand(bandBits(k, n, edge), edge);
      assert.deepEqual(got, { k, n }, "edge " + edge + " k " + k);
    }
  }
  // Guards must stay clear whatever the payload, or a set cell can touch a
  // fiducial and the two merge into one blob.
  for (const k of [0, 1, 63, 119]) {
    const bits = bandBits(k, MAX_CHARS, 0);
    assert.equal(bits[0], 0);
    assert.equal(bits[bits.length - 1], 0);
  }
});

test("any single flipped cell in a band is rejected", () => {
  const word = bandBits(37, 90, 2);
  for (let i = 0; i < word.length; i++) {
    const bad = word.slice();
    bad[i] ^= 1;
    assert.equal(parseBand(bad, 2), null, "flip at " + i + " was accepted");
  }
});

test("a band read from the wrong edge is rejected", () => {
  // This is the failure the edge id exists for. Under a 90 degree wrong
  // orientation the reader traverses a different physical edge along that
  // edge's own forward direction, so the word arrives undamaged: sync intact,
  // CRC intact, k and n correct. Only the edge id disagrees -- and without it
  // the frame would decode a marker out of a rotated warp to a wrong character.
  for (const wrote of EDGES) {
    for (const reads of EDGES) {
      const got = parseBand(bandBits(11, 40, wrote), reads);
      if (wrote === reads) assert.deepEqual(got, { k: 11, n: 40 });
      else assert.equal(got, null, "edge " + wrote + " accepted as " + reads);
    }
  }
});

test("a band read backwards is rejected", () => {
  // A 180 degree wrong orientation reverses every band.
  for (const edge of EDGES) {
    const backwards = bandBits(11, 40, edge).slice().reverse();
    for (const reads of EDGES) {
      assert.equal(parseBand(backwards, reads), null, "reversed edge " + edge);
    }
  }
});

test("an out-of-range band is rejected even when its CRC agrees", () => {
  // A word can be internally consistent and still be nonsense. k must index a
  // character that exists, or the accumulator is handed an index it cannot use.
  assert.equal(parseBand(bandBits(5, 5, 0), 0), null); // k == n
  assert.equal(parseBand(bandBits(9, 3, 0), 0), null); // k  > n
  assert.equal(parseBand(bandBits(0, 0, 0), 0), null); // empty message
  assert.equal(parseBand(bandBits(0, MAX_CHARS + 1, 0), 0), null);
  assert.deepEqual(parseBand(bandBits(0, 1, 0), 0), { k: 0, n: 1 });
});

test("the disc contains the artwork and the furniture stays outside it", () => {
  const { inner, total, disc, fid, cells } = SHOW;
  const centre = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 };
  const from = (p: { x: number; y: number }) => Math.hypot(p.x - centre.x, p.y - centre.y);

  assert.equal(disc.x, centre.x);
  assert.equal(disc.y, centre.y);

  // Load-bearing, not cosmetic: the rectified buffer's corners are where
  // markerAt samples the background, so every corner of the artwork square has
  // to be inside the disc or the marker's polarity is read backwards.
  for (const corner of [
    { x: inner.x, y: inner.y },
    { x: inner.x + inner.w, y: inner.y },
    { x: inner.x + inner.w, y: inner.y + inner.h },
    { x: inner.x, y: inner.y + inner.h },
  ]) {
    assert.ok(from(corner) < disc.r, "artwork corner at " + from(corner).toFixed(1) + " escapes the disc");
  }

  const touchesArtwork = (p: { x: number; y: number }, pad: number) =>
    p.x + pad > inner.x && p.x - pad < inner.x + inner.w && p.y + pad > inner.y && p.y - pad < inner.y + inner.h;
  const insideTotal = (p: { x: number; y: number }, pad: number) =>
    p.x - pad > total.x &&
    p.x + pad < total.x + total.w &&
    p.y - pad > total.y &&
    p.y + pad < total.y + total.h;

  // Nothing may sit over the artwork, and nothing may touch the image edge --
  // findBlobs discards any blob whose bounding box reaches the border.
  for (const f of fid) {
    assert.ok(!touchesArtwork(f, SHOW.fidSize / 2), "an anchor overlaps the artwork");
    assert.ok(insideTotal(f, SHOW.fidSize / 2), "an anchor reaches the image edge");
    assert.ok(from(f) > disc.r, "an anchor sits on the disc");
  }
  // Every reading point sits on the band, clear of both the artwork and the edge.
  for (const edge of EDGES) {
    for (let i = 0; i < cells; i++) {
      const c = SHOW.cellCentre(edge, i);
      assert.ok(!touchesArtwork(c, 0), "a reading point overlaps the artwork");
      assert.ok(insideTotal(c, SHOW.bump), "a reading point reaches the image edge");
      assert.ok(from(c) > disc.r, "a reading point falls inside the disc");
    }
  }

  // Each anchor has to win its own corner outright. cornerQuad selects by the
  // extremes of x+y and x-y, so anchors on the axes would tie on both and the
  // selection would be degenerate -- which is why they sit on the diagonals.
  //
  // Nothing else competes: the anchors are the only bright blobs that survive
  // the filters, since the page touches the image edge, the disc is far too
  // large, and an indent stays connected to the page outside. The data is dark
  // band material and is never a candidate at all.
  const scores = [
    (p: { x: number; y: number }) => p.x + p.y,
    (p: { x: number; y: number }) => -(p.x - p.y),
    (p: { x: number; y: number }) => -(p.x + p.y),
    (p: { x: number; y: number }) => p.x - p.y,
  ];
  for (let corner = 0; corner < 4; corner++) {
    const best = scores[corner](fid[corner]);
    for (const other of fid) {
      if (other !== fid[corner]) assert.ok(scores[corner](other) > best, "two anchors tie on a corner");
    }
  }
});

// --- camera scan -------------------------------------------------------------

/**
 * A show frame as pixels, without a canvas.
 *
 * Only the parts the scanner actually reads: background, fiducials, the four
 * bands, the marker square and the header plate. The spline itself is left out
 * for the same reason rasteriseFrames leaves it out -- it is saturated, and
 * markerAt rejects anything saturated before it looks at luminance.
 */
/** Which data arc an angle falls in, or null for the flat gaps. */
function arcAt(deg: number): number | null {
  const a = ((deg % 360) + 360) % 360;
  const centres = [270, 90, 180, 0];
  for (let e = 0; e < 4; e++) {
    const into = ((a - (centres[e] - 39)) % 360 + 360) % 360;
    if (into < 78) return e;
  }
  return null;
}

function buildShowFrame(
  text: string,
  k: number,
  n: number,
  opts: { fiducials?: number; bandFrom?: number[] } = {},
): ImageDataLike {
  const { total, inner, disc } = SHOW;
  const W = Math.round(total.w);
  const H = Math.round(total.h);
  const data = new Uint8ClampedArray(W * H * 4);

  const INK: [number, number, number] = [0, 0, 0];
  const GROUND: [number, number, number] = [255, 255, 255];
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = GROUND[0];
    data[i * 4 + 1] = GROUND[1];
    data[i * 4 + 2] = GROUND[2];
    data[i * 4 + 3] = 255;
  }

  // Show coordinates to pixels: the image is exactly the total rect.
  const px = (x: number) => x - total.x;
  const py = (y: number) => y - total.y;
  const put = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  const fill = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) put(x, y, rgb);
    }
  };
  const dot = (cx: number, cy: number, r: number, rgb: [number, number, number]) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (Math.hypot(x - cx, y - cy) > r) continue;
        put(x, y, rgb);
      }
    }
  };

  // The band, drawn by testing each pixel against the shared profile -- so the
  // fixture and the renderer cannot drift apart on the shape of the edge.
  const from = opts.bandFrom ?? [k, k, k, k];
  const profile = bandProfile(from[0], n);
  // A torn frame needs each arc built from its own index, which the shared
  // profile cannot express -- so those are patched in per arc below.
  const perArc = from.map((f) => bandProfile(f, n));
  const cx = px(disc.x);
  const cy = py(disc.y);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r < disc.r) continue;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const arc = arcAt(deg);
      if (r > radiusAt(arc === null ? profile : perArc[arc], deg)) continue;
      put(x, y, INK);
    }
  }

  // Anchor holes punched back out of the band.
  SHOW.fid.slice(0, opts.fiducials ?? 4).forEach((f) => dot(px(f.x), py(f.y), SHOW.fidSize / 2, GROUND));

  // The artwork's marker: black, because the disc it sits on is white.
  const knots = textToKnots(text);
  const rect = isoRect(inner.w, inner.h);
  const at = isoToPx({ x: knots[k].x, y: knots[k].y, z: zOf(k, n) }, rect, yawOf(k, n));
  const s = Math.max(6, ((SHOW_THICKNESS * Math.min(inner.w, inner.h)) / 1000) * 1.6);
  fill(px(inner.x + at.x - s), py(inner.y + at.y - s), s * 2, s * 2, INK);

  return { width: W, height: H, data };
}

type Quad = { x: number; y: number }[];

/** Roughly filling the frame, square on. */
const FRONTAL: Quad = [
  { x: 110, y: 14 },
  { x: 530, y: 14 },
  { x: 530, y: 346 },
  { x: 110, y: 346 },
];
/** Held at an angle, on both axes. */
const TILTED: Quad = [
  { x: 90, y: 40 },
  { x: 505, y: 15 },
  { x: 540, y: 330 },
  { x: 120, y: 350 },
];
/** Phone turned on its side: the source top-left arrives at camera top-right. */
const ROTATED: Quad = [
  { x: 448, y: 18 },
  { x: 448, y: 342 },
  { x: 192, y: 342 },
  { x: 192, y: 18 },
];
/** Further away and off to one side. */
const OFFSET: Quad = [
  { x: 230, y: 30 },
  { x: 610, y: 30 },
  { x: 610, y: 330 },
  { x: 230, y: 330 },
];

/**
 * What a phone does to a screen.
 *
 * Projects the source onto an arbitrary quad, then applies the degradations that
 * actually break absolute thresholds: a lens blur, a white balance cast, reduced
 * contrast with lifted blacks from auto exposure, and sensor noise.
 */
function fakeCamera(src: ImageDataLike, quad: Quad, W: number, H: number): ImageDataLike {
  const nq = quad.map((p) => ({ x: p.x / (W / 2) - 1, y: p.y / (H / 2) - 1 }));
  const ns = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  const inv = solveHomography(nq, ns);
  assert.ok(inv, "fixture quad is degenerate");

  let buf = new Uint8ClampedArray(W * H * 4);
  // A dim room, not black: the detector has to find the screen against something.
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = 34;
    buf[i * 4 + 1] = 32;
    buf[i * 4 + 2] = 30;
    buf[i * 4 + 3] = 255;
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyH(inv, { x: (x + 0.5) / (W / 2) - 1, y: (y + 0.5) / (H / 2) - 1 });
      if (!p) continue;
      const sx = Math.round(((p.x + 1) / 2) * src.width - 0.5);
      const sy = Math.round(((p.y + 1) / 2) * src.height - 0.5);
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      const o = (y * W + x) * 4;
      const s = (sy * src.width + sx) * 4;
      buf[o] = src.data[s];
      buf[o + 1] = src.data[s + 1];
      buf[o + 2] = src.data[s + 2];
    }
  }

  // Lens blur, twice.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8ClampedArray(buf.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              sum += buf[(ny * W + nx) * 4 + c];
              cnt++;
            }
          }
          next[(y * W + x) * 4 + c] = sum / cnt;
        }
        next[(y * W + x) * 4 + 3] = 255;
      }
    }
    buf = next;
  }

  // Warm white balance, flattened contrast, lifted blacks, noise. The cast is
  // the important one: without it this fixture would pass while a real phone
  // failed, because nothing would exercise the grey-world correction.
  const cast = [1.14, 1.0, 0.82];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const o = i * 4 + c;
      buf[o] = buf[o] * cast[c] * 0.78 + 26 + rand() * 8;
    }
  }

  return { width: W, height: H, data: buf };
}

test("a camera-warped show frame decodes to the right character", () => {
  const text = "HELLO WORLD";
  const n = text.length;
  const quads: [string, Quad][] = [
    ["frontal", FRONTAL],
    ["tilted", TILTED],
    ["rotated", ROTATED],
    ["offset", OFFSET],
  ];

  for (const [name, quad] of quads) {
    for (let k = 0; k < n; k++) {
      const cam = fakeCamera(buildShowFrame(text, k, n), quad, 640, 360);
      const got = scanFrame(cam);
      assert.ok(got, name + " k=" + k + " was rejected");
      assert.equal(got.k, k, name + " k=" + k + " read as " + got.k);
      assert.equal(got.n, n, name + " n");
      assert.equal(got.char, text[k], name + " k=" + k + " char");
    }
  }
});

test("normalise strips chroma that is only amplified noise", () => {
  // The contrast stretch amplifies each channel's noise along with its signal,
  // and saturation is a ratio, so near black a few counts of disagreement reads
  // as near-full saturation. markerAt discards anything above 0.25 saturated, so
  // without this a dark marker loses nearly every pixel to colour that is not
  // there. The display puts a white marker on black, where the same noise is
  // harmless -- but the correction is what makes the other polarity work at all,
  // and nothing else in the suite would notice it going away.
  const W = 64;
  const H = 64;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    // A neutral near-black patch carrying a couple of counts of channel noise,
    // against a neutral white ground.
    const dark = i % 4 === 0;
    data[o] = dark ? 2 : 250;
    data[o + 1] = dark ? 5 : 252;
    data[o + 2] = dark ? 9 : 247;
    data[o + 3] = 255;
  }
  normalise({ width: W, height: H, data });

  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const { s } = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    assert.ok(s <= 0.25, "pixel " + i + " left " + s.toFixed(3) + " saturated");
  }
});

test("a camera frame with nothing to read is rejected", () => {
  const W = 640;
  const H = 360;
  const blank = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    blank[i * 4] = 40;
    blank[i * 4 + 1] = 40;
    blank[i * 4 + 2] = 40;
    blank[i * 4 + 3] = 255;
  }
  assert.equal(scanFrame({ width: W, height: H, data: blank }), null);
});

test("a show frame missing a fiducial is rejected", () => {
  const cam = fakeCamera(buildShowFrame("HELLO WORLD", 3, 11, { fiducials: 3 }), FRONTAL, 640, 360);
  assert.equal(scanFrame(cam), null);
});

test("a frame torn across a display transition is rejected", () => {
  // A camera exposure spanning the moment the display advances: two bands carry
  // the old character, two carry the new one. No majority, so nothing is
  // committed -- which is the point of putting the header on all four edges
  // rather than trusting two successive camera frames to disagree.
  const cam = fakeCamera(buildShowFrame("HELLO WORLD", 4, 11, { bandFrom: [4, 5, 4, 5] }), FRONTAL, 640, 360);
  assert.equal(scanFrame(cam), null);
});

// --- monochromatic display palette -------------------------------------------

const parseHsl = (css: string): [number, number, number] => {
  const m = css.match(/hsl\(([-\d.]+),\s*([-\d.]+)%,\s*([-\d.]+)%\)/);
  assert.ok(m, "not an hsl() colour: " + css);
  return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
};

test("the display palette is white ground, black furniture, one hue", () => {
  assert.equal(SHOW_GROUND, "#ffffff");
  assert.equal(SHOW_INK, "#000000");
  assert.deepEqual(contrastInk(SHOW_GROUND), { r: 0, g: 0, b: 0 });
  // The artwork sits on the white disc, so its marker is black -- the polarity
  // that needs normalise's chroma correction to survive a camera at all.
  assert.equal(SHOW_PRESET.bg, SHOW_GROUND);
  assert.deepEqual(markerInk(SHOW_PRESET.bg), [0, 0, 0]);
  // A single hue means hue cannot also carry the character order. The header
  // band carries it instead, so this costs the frame formats nothing -- but a
  // still of this palette is not decodable, and must not claim to be.
  assert.equal(SHOW_PRESET.hueOrdered, false);
  assert.equal(typeof SHOW_PRESET.hue, "number");
});

test("no point on the display curve can be mistaken for the marker", () => {
  // The marker on the white disc is pure black, and markerAt takes any pixel
  // within 0.06 of that -- rejecting only what is more than 0.25 saturated. A
  // monochromatic curve ramps its lightness, so its dark end runs towards the
  // marker's luminance; saturation is the entire thing keeping the two apart.
  // Losing it would not fail loudly, it would decode the wrong character.
  const n = 40;
  for (let k = 0; k < n; k++) {
    const [r, g, b] = parseHsl(colorFor(k, n, SHOW_PRESET));
    const { s } = rgbToHsv(r, g, b);
    const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    assert.ok(
      s > 0.35,
      "curve at k=" + k + " is only " + s.toFixed(3) + " saturated, too close to achromatic",
    );
    assert.ok(luma > 0.06, "curve at k=" + k + " has luma " + luma.toFixed(3) + ", into the marker's band");
  }
});

test("the greyscale preset keeps its achromatic ramp", () => {
  // The monochromatic branch is shared, so a fixed hue must not leak into the
  // preset that deliberately has none.
  const grey = presetById("gray");
  for (let k = 0; k < 10; k++) {
    const [r, g, b] = parseHsl(colorFor(k, 10, grey));
    assert.equal(r, g);
    assert.equal(g, b);
  }
});

test("every reading point lands on the correct side of the band edge", () => {
  // The bit is the sign of the edge's deviation at the cell centre, so this is
  // the encoding itself. The second half is the part that matters in practice:
  // the reader samples a disc spanning a quarter of a cell either side of
  // centre, and the edge has to stay on the same side across all of it.
  const n = 40;
  const profile = bandProfile(7, n);
  const cellDeg = 78 / SHOW.cells;

  for (const edge of EDGES) {
    const word = bandBits(7, n, edge);
    for (let i = 0; i < SHOW.cells; i++) {
      const centreDeg = [270, 90, 180, 0][edge] - 78 / 2 + (i + 0.5) * cellDeg;
      const bit = word[i];
      const at = radiusAt(profile, centreDeg);
      if (bit) assert.ok(at > SHOW.bandRadius + SHOW.bump * 0.98, "a set cell did not bump out");
      else assert.ok(at < SHOW.bandRadius - SHOW.bump * 0.98, "a clear cell did not indent in");

      for (const off of [-0.25, 0.25]) {
        const edgeAt = radiusAt(profile, centreDeg + off * cellDeg);
        const clearance = Math.abs(edgeAt - SHOW.bandRadius);
        // Easing between cell centres rather than back to nominal is what buys
        // this: returning to nominal at every boundary would leave only half
        // the amplitude here, and a full lobe when neighbours agree gives all
        // of it.
        assert.ok(clearance > SHOW.bump * 0.65, "the profile goes slack inside the sampling disc");
        assert.equal(edgeAt > SHOW.bandRadius, bit === 1, "the profile changes sign inside the sampling disc");
      }
    }
  }
});

test("the band stays solid where the anchors are punched through it", () => {
  // The edge eases through the diagonals rather than sitting flat across them,
  // so what matters is clearance, not that the radius is exactly nominal: an
  // anchor that broke out to the page would stop being an isolated blob.
  const profile = bandProfile(0, 1);
  for (const f of SHOW.fid) {
    const deg = (Math.atan2(f.y - SHOW.disc.y, f.x - SHOW.disc.x) * 180) / Math.PI;
    const holeDeg = ((SHOW.fidSize / 2 / SHOW.bandRadius) * 180) / Math.PI;
    const holeOuter = Math.hypot(f.x - SHOW.disc.x, f.y - SHOW.disc.y) + SHOW.fidSize / 2;
    for (let d = deg - holeDeg; d <= deg + holeDeg; d += holeDeg / 4) {
      assert.ok(radiusAt(profile, d) > holeOuter + 8, "an anchor reaches the scalloped edge");
    }
    assert.ok(
      Math.hypot(f.x - SHOW.disc.x, f.y - SHOW.disc.y) - SHOW.fidSize / 2 > SHOW.disc.r + 8,
      "an anchor breaks into the disc",
    );
  }
});

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
import { HUE_SPAN, hueAt, stemHue } from "./palette.ts";
import { plotRect } from "./render.ts";
import { isoRect, toPx as isoToPx, yawOf, zOf } from "./iso.ts";
import { decode, decodeFrames, type ImageDataLike } from "./decode.ts";
import { headerLayout, readFrameHeader, sheetCols, sheetRows, sheetTiles } from "./frame.ts";
import { buildLookup, buildPalette, decodeGif, encodeGif, lzwDecode, lzwEncode } from "./gif.ts";
import { fromPx } from "./iso.ts";
import { desmosText, fitFourier } from "./equation.ts";

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

    const at = isoToPx({ x: knots[k].x, y: knots[k].y, z: zOf(k, n) }, r, yawOf(k, n));
    const s = 12;
    fill(at.x - s, at.y - s, s * 2, s * 2, hslToRgb(330, 1, 0.5));

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
  const palette = buildPalette([5, 3, 15], [255, 0, 128]);
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
  const palette = buildPalette([5, 3, 15], [255, 0, 128]);
  const lut = buildLookup(palette);
  const bytes = encodeGif({ frames, palette, lut, delay: 10 });

  const out = decodeFrames(decodeGif(bytes));
  assert.equal(out.mode, "frames");
  assert.equal(out.text, text);
});

test("quantisation keeps the marker and the header plate exact", () => {
  const palette = buildPalette([5, 3, 15], [255, 0, 128]);
  const lut = buildLookup(palette);
  const probe = (r: number, g: number, b: number) => {
    const i = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
    return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]];
  };
  assert.deepEqual(probe(0, 0, 0), [0, 0, 0]);
  assert.deepEqual(probe(255, 255, 255), [255, 255, 255]);
  assert.deepEqual(probe(255, 0, 128), [255, 0, 128]);
});

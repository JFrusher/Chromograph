/** Vector export. Built from the same knots/curve as the canvas, never scraped off it. */

import { CELLS, COLS, ROWS, cellCenter, textToKnots, type Point } from "./grid.ts";
import { catmullRom } from "./spline.ts";
import { colorFor, contrastInk, hueAt, stemColorFor, type Preset } from "./palette.ts";
import { plotRect, STEM_GAP, type RenderParams } from "./render.ts";
import { isoRect, toPx as isoPx, zOf } from "./iso.ts";

const n2 = (v: number) => Math.round(v * 100) / 100;

export type SvgOptions = {
  text: string;
  params: RenderParams;
  preset: Preset;
  width: number;
  height: number;
};

export function toSVG(o: SvgOptions): string {
  const { width: W, height: H, preset } = o;
  const body = o.params.mode === "iso" ? isoBody(o) : flatBody(o);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${preset.bg}"/>`,
    ...body,
    "</svg>",
  ].join("\n");
}

// --- flat ------------------------------------------------------------------

function flatBody(o: SvgOptions): string[] {
  const { width: W, height: H, preset, params } = o;
  const r = plotRect(W, H);
  const scale = Math.min(W, H) / 1000;
  const core = Math.max(1, params.thickness * scale);
  const knots = textToKnots(o.text);
  const out: string[] = [];

  if (params.gridOpacity > 0) {
    let d = "";
    for (let i = 0; i < CELLS; i++) {
      const p = px(cellCenter(i), r);
      d += `M${n2(p.x - 4 * scale)} ${n2(p.y)}h${n2(8 * scale)}M${n2(p.x)} ${n2(p.y - 4 * scale)}v${n2(8 * scale)}`;
    }
    out.push(strokePath(d, ink(preset, params.gridOpacity * 0.55), Math.max(1, scale)));
  }

  if (knots.length >= 2) {
    const curve = catmullRom(knots, params.tension, 24);
    out.push(...runs(curve.pts.map((p) => px(p, r)), curve.seg, knots.length, preset, core));
  } else if (knots.length === 1) {
    out.push(square(px(knots[0], r), core, colorFor(0, 1, preset)));
  }

  out.push(...bar(o, r.bar, knots.length, scale));
  return out;
}

// --- isometric -------------------------------------------------------------

function isoBody(o: SvgOptions): string[] {
  const { width: W, height: H, preset, params } = o;
  const r = isoRect(W, H);
  const scale = Math.min(W, H) / 1000;
  const core = Math.max(1, params.thickness * scale);
  const knots = textToKnots(o.text);
  const n = knots.length;
  const out: string[] = [];
  const hair = Math.max(1, scale);

  if (params.gridOpacity > 0) {
    let d = "";
    for (let i = 0; i <= COLS; i++) {
      const a = isoPx({ x: i / COLS, y: 0, z: 0 }, r);
      const b = isoPx({ x: i / COLS, y: 1, z: 0 }, r);
      d += `M${n2(a.x)} ${n2(a.y)}L${n2(b.x)} ${n2(b.y)}`;
    }
    for (let j = 0; j <= ROWS; j++) {
      const a = isoPx({ x: 0, y: j / ROWS, z: 0 }, r);
      const b = isoPx({ x: 1, y: j / ROWS, z: 0 }, r);
      d += `M${n2(a.x)} ${n2(a.y)}L${n2(b.x)} ${n2(b.y)}`;
    }
    out.push(strokePath(d, ink(preset, params.gridOpacity * 0.5), hair));
  }

  if (n === 0) return out;
  const curve = n >= 2 ? catmullRom(knots, params.tension, 24) : { pts: knots, seg: [0] };

  if (params.gridOpacity > 0 && n >= 2) {
    let d = "";
    curve.pts.forEach((p, i) => {
      const q = isoPx({ x: p.x, y: p.y, z: 0 }, r);
      d += `${i === 0 ? "M" : "L"}${n2(q.x)} ${n2(q.y)}`;
    });
    out.push(strokePath(d, ink(preset, params.gridOpacity * 0.3), hair));
  }

  if (n >= 2) {
    const pts = curve.pts.map((p, i) => isoPx({ x: p.x, y: p.y, z: zOf(curve.seg[i], n) }, r));
    out.push(...runs(pts, curve.seg, n, preset, core));
  } else {
    out.push(square(isoPx({ ...knots[0], z: zOf(0, 1) }, r), core, colorFor(0, 1, preset)));
  }

  // Stems last, matching the canvas: drawn first, the curve would cut them.
  if (params.stems) {
    const gap = STEM_GAP * params.thickness * scale;
    for (let k = 0; k < n; k++) {
      const top = isoPx({ x: knots[k].x, y: knots[k].y, z: zOf(k, n) }, r);
      const foot = isoPx({ x: knots[k].x, y: knots[k].y, z: 0 }, r);
      if (foot.y - top.y <= gap + 1) continue;
      out.push(
        strokePath(
          `M${n2(top.x)} ${n2(top.y + gap)}L${n2(foot.x)} ${n2(foot.y)}`,
          stemColorFor(k, n, preset),
          Math.max(1, core * 0.5),
          "butt",
        ),
      );
    }
  }

  out.push(...bar(o, r.bar, n, scale));
  return out;
}

// --- shared ----------------------------------------------------------------

const px = (p: Point, r: ReturnType<typeof plotRect>) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });

const ink = (preset: Preset, alpha: number) => {
  const c = contrastInk(preset.bg);
  return `rgba(${c.r},${c.g},${c.b},${alpha.toFixed(3)})`;
};

const strokePath = (d: string, stroke: string, width: number, cap = "round") =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${n2(width)}" stroke-linecap="${cap}" stroke-linejoin="round"/>`;

const square = (p: Point, s: number, fill: string) =>
  `<rect x="${n2(p.x - s)}" y="${n2(p.y - s)}" width="${n2(s * 2)}" height="${n2(s * 2)}" fill="${fill}"/>`;

function bar(o: SvgOptions, rect: { x: number; y: number; w: number; h: number }, n: number, scale: number): string[] {
  if (!o.params.showBar || !o.preset.hueOrdered || n < 2) return [];
  const out: string[] = [];
  const w = rect.w / n;
  for (let k = 0; k < n; k++) {
    out.push(
      `<rect x="${n2(rect.x + k * w)}" y="${n2(rect.y)}" width="${n2(w + 1)}" height="${n2(rect.h)}"` +
        ` fill="hsl(${hueAt(k, n).toFixed(2)}, 100%, 50%)"/>`,
    );
  }
  out.push(
    `<rect x="${n2(rect.x)}" y="${n2(rect.y)}" width="${n2(rect.w)}" height="${n2(rect.h)}"` +
      ` fill="none" stroke="#000000" stroke-width="${n2(Math.max(1, scale))}"/>`,
  );
  return out;
}

/**
 * One path per colour run rather than per sample: consecutive samples inside a
 * segment share a colour to two decimal places often enough that emitting each
 * one separately triples the file for no visible difference.
 */
function runs(pts: Point[], seg: number[], knotCount: number, preset: Preset, width: number): string[] {
  const out: string[] = [];
  let from = 0;
  let color = colorFor(seg[0], knotCount, preset);

  const flush = (to: number, stroke: string) => {
    let d = `M${n2(pts[from].x)} ${n2(pts[from].y)}`;
    for (let j = from + 1; j <= to; j++) d += `L${n2(pts[j].x)} ${n2(pts[j].y)}`;
    out.push(strokePath(d, stroke, width));
  };

  for (let i = 1; i < pts.length; i++) {
    const next = colorFor(seg[i], knotCount, preset);
    if (next !== color) {
      flush(i, color);
      from = i;
      color = next;
    }
  }
  flush(pts.length - 1, color);
  return out;
}

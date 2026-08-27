/** Vector export. Built from the same knots/curve as the canvas, never scraped off it. */

import { CELLS, cellCenter, textToKnots, type Point } from "./grid.ts";
import { catmullRom } from "./spline.ts";
import { colorFor, contrastInk, hueAt, type Preset } from "./palette.ts";
import { plotRect, type RenderParams } from "./render.ts";

const n2 = (v: number) => Math.round(v * 100) / 100;

export function toSVG(opts: {
  text: string;
  params: RenderParams;
  preset: Preset;
  width: number;
  height: number;
}): string {
  const { width: W, height: H, preset, params } = opts;
  const r = plotRect(W, H);
  const scale = Math.min(W, H) / 1000;
  const core = Math.max(1, params.thickness * scale);
  const knots = textToKnots(opts.text);

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${preset.bg}"/>`,
  ];

  if (params.gridOpacity > 0) {
    const ink = contrastInk(preset.bg);
    const stroke = `rgba(${ink.r},${ink.g},${ink.b},${(params.gridOpacity * 0.55).toFixed(3)})`;
    let d = "";
    for (let i = 0; i < CELLS; i++) {
      const p = px(cellCenter(i), r);
      d += `M${n2(p.x - 4 * scale)} ${n2(p.y)}h${n2(8 * scale)}M${n2(p.x)} ${n2(p.y - 4 * scale)}v${n2(8 * scale)}`;
    }
    out.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${n2(Math.max(1, scale))}"/>`);
  }

  if (knots.length >= 2) {
    const curve = catmullRom(knots, params.tension, 24);
    const pts = curve.pts.map((p) => px(p, r));
    out.push(...segments(pts, curve.seg, knots.length, preset, core));
  } else if (knots.length === 1) {
    const p = px(knots[0], r);
    out.push(
      `<rect x="${n2(p.x - core)}" y="${n2(p.y - core)}" width="${n2(core * 2)}" height="${n2(core * 2)}"` +
        ` fill="${colorFor(0, 1, preset)}"/>`,
    );
  }

  if (params.showBar && preset.decodable && knots.length >= 2) {
    const w = r.bar.w / knots.length;
    for (let k = 0; k < knots.length; k++) {
      out.push(
        `<rect x="${n2(r.bar.x + k * w)}" y="${n2(r.bar.y)}" width="${n2(w + 1)}" height="${n2(r.bar.h)}"` +
          ` fill="hsl(${hueAt(k, knots.length).toFixed(2)}, 100%, 50%)"/>`,
      );
    }
    out.push(
      `<rect x="${n2(r.bar.x)}" y="${n2(r.bar.y)}" width="${n2(r.bar.w)}" height="${n2(r.bar.h)}"` +
        ` fill="none" stroke="#000000" stroke-width="${n2(Math.max(1, scale))}"/>`,
    );
  }

  out.push("</svg>");
  return out.join("\n");
}

const px = (p: Point, r: ReturnType<typeof plotRect>) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });

/**
 * One path per colour run rather than per sample: consecutive samples inside a
 * segment share a colour to two decimal places often enough that emitting each
 * one separately triples the file for no visible difference.
 */
function segments(
  pts: Point[],
  seg: number[],
  knotCount: number,
  preset: Preset,
  width: number,
): string[] {
  const out: string[] = [];
  let from = 0;
  let color = colorFor(seg[0], knotCount, preset);

  const flush = (to: number, stroke: string) => {
    let d = `M${n2(pts[from].x)} ${n2(pts[from].y)}`;
    for (let j = from + 1; j <= to; j++) d += `L${n2(pts[j].x)} ${n2(pts[j].y)}`;
    out.push(
      `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${n2(width)}"` +
        ` stroke-linecap="round" stroke-linejoin="round"/>`,
    );
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

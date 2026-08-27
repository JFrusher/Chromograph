/** Hue mapping and visual presets. */

/**
 * Hue runs 0 (red) to 300 (magenta). Deliberately NOT the full 360: a wrapping
 * ramp puts red at both ends, so the decoder could not tell the start of the
 * message from the end.
 */
export const HUE_START = 0;
export const HUE_SPAN = 300;

/**
 * Hue as a function of fractional knot index -- uniform per character step,
 * NOT per unit of arc length.
 *
 * This is what makes a marker-less curve decodable: with N characters, knot k
 * sits at exactly hue k * HUE_SPAN / (N - 1). Everything between those hues is
 * transit, so the decoder can sample the N knot hues and ignore the cells the
 * curve merely passed over.
 */
export function hueAt(seg: number, knotCount: number): number {
  if (knotCount < 2) return HUE_START;
  return HUE_START + (seg / (knotCount - 1)) * HUE_SPAN;
}

export type Preset = {
  id: string;
  name: string;
  bg: string;
  sat: number;
  light: number;
  /** False when the preset carries no hue, so order cannot be recovered from it. */
  decodable: boolean;
};

/**
 * Backgrounds are deliberately neutral. A saturated background (navy, say) leaks
 * its own hue into the antialiased edge of every stroke, and those blends land in
 * the hue bin at the background's hue -- which is a real character's bin. Grey,
 * black and white have no hue to leak.
 */
export const PRESETS: Preset[] = [
  { id: "black", name: "Black", bg: "#000000", sat: 100, light: 55, decodable: true },
  { id: "silver", name: "Silver", bg: "#c0c0c0", sat: 100, light: 35, decodable: true },
  { id: "paper", name: "Paper", bg: "#ffffff", sat: 100, light: 42, decodable: true },
  { id: "gray", name: "Grayscale", bg: "#ffffff", sat: 0, light: 30, decodable: false },
];

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

/** Colour at a fractional knot index. */
export function colorFor(seg: number, knotCount: number, preset: Preset): string {
  if (!preset.decodable) {
    // No hue to encode direction with, so ramp lightness instead. Still readable
    // by eye as a direction cue; still not machine-decodable.
    const t = knotCount < 2 ? 0 : seg / (knotCount - 1);
    return `hsl(0, 0%, ${(72 - t * 72).toFixed(1)}%)`;
  }
  return `hsl(${hueAt(seg, knotCount).toFixed(2)}, ${preset.sat}%, ${preset.light}%)`;
}

/**
 * Stems live in a hue range the payload never uses: 305..355, just past the
 * ramp's magenta end.
 *
 * Brightness cannot separate them from the curve, which is the trap. An
 * antialiased curve edge fading into the background is that colour multiplied
 * by coverage, and multiplying RGB by a scalar leaves hue and saturation alone
 * while sweeping value continuously from 1 to 0 -- straight through any band
 * you might reserve. Hue is the one channel antialiasing against a neutral
 * background does not move.
 *
 * The range still varies with k, so two stems that overlap on screen usually
 * differ enough in hue for the decoder to cut them apart.
 */
export const STEM_HUE_START = 305;
export const STEM_HUE_SPAN = 50;

export const stemHue = (k: number, knotCount: number) =>
  knotCount < 2 ? STEM_HUE_START : STEM_HUE_START + (k / (knotCount - 1)) * STEM_HUE_SPAN;

/** Colour of the stem dropped from knot k. */
export function stemColorFor(k: number, knotCount: number, preset: Preset): string {
  if (!preset.decodable) return "hsl(0, 0%, 45%)";
  return `hsl(${stemHue(k, knotCount).toFixed(2)}, 100%, 50%)`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Ink colour that reads against a preset's background. */
export function contrastInk(bg: string): { r: number; g: number; b: number } {
  const [r, g, b] = hexToRgb(bg);
  const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
  return luma > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}

/** RGB 0-255 -> HSV with h in degrees 0-360, s and v in 0-1. */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

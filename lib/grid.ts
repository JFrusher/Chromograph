/** 5x6 character grid: text <-> normalised (0..1) plane coordinates. */

export type Point = { x: number; y: number };

export const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ .,?";
export const COLS = 6;
export const ROWS = 5;
export const CELLS = COLS * ROWS; // 30

/**
 * Ceiling for a message.
 *
 * Set by the sheet and animated formats, whose frame headers carry an index
 * rather than measuring anything, and by how large a sprite sheet stays
 * practical to decode in a browser. Still images are a different matter: hue has
 * to carry the order there, and it stays reliable to about 60 characters --
 * which the UI says rather than pretending otherwise.
 */
export const MAX_CHARS = 120;

/** Beyond this, a single still image is no longer a dependable carrier. */
export const STILL_RELIABLE_CHARS = 60;

/** Smaller of the two cell pitches, in normalised units. */
export const CELL_PITCH = Math.min(1 / COLS, 1 / ROWS);

/**
 * Orbital radius for re-visited cells. Must be:
 *   - large enough that two visits to the same cell are visually distinct
 *   - small enough that a knot never lands closer to a neighbouring cell centre,
 *     which would make the decoder snap it to the wrong character.
 */
export const OFFSET_R = 0.055;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // 137.5 degrees

if (OFFSET_R >= 0.4 * CELL_PITCH) {
  throw new Error(`OFFSET_R ${OFFSET_R} too large for cell pitch ${CELL_PITCH}`);
}

export function cellCenter(index: number): Point {
  return {
    x: ((index % COLS) + 0.5) / COLS,
    y: (Math.floor(index / COLS) + 0.5) / ROWS,
  };
}

export type Sanitised = {
  text: string;
  dropped: number;
  truncated: boolean;
};

/** Uppercase, strip unsupported characters, cap length. */
export function sanitize(raw: string): Sanitised {
  const upper = raw.toUpperCase();
  let kept = "";
  for (const ch of upper) if (CHARSET.includes(ch)) kept += ch;
  const truncated = kept.length > MAX_CHARS;
  return {
    text: truncated ? kept.slice(0, MAX_CHARS) : kept,
    dropped: upper.length - kept.length,
    truncated,
  };
}

/**
 * Sanitised text -> spline knots. The nth visit to a cell is pushed onto an
 * orbit around its centre so repeated characters do not collapse into one point.
 */
export function textToKnots(text: string): Point[] {
  const visits = new Map<number, number>();
  const knots: Point[] = [];
  for (const ch of text) {
    const cell = CHARSET.indexOf(ch);
    if (cell < 0) continue;
    const v = visits.get(cell) ?? 0;
    visits.set(cell, v + 1);
    const c = cellCenter(cell);
    if (v === 0) {
      knots.push(c);
    } else {
      const theta = v * GOLDEN_ANGLE;
      knots.push({ x: c.x + OFFSET_R * Math.cos(theta), y: c.y + OFFSET_R * Math.sin(theta) });
    }
  }
  return knots;
}

/** Nearest cell index to a normalised point, plus its distance. */
export function nearestCell(p: Point): { cell: number; dist: number } {
  let cell = 0;
  let best = Infinity;
  for (let i = 0; i < CELLS; i++) {
    const c = cellCenter(i);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < best) {
      best = d;
      cell = i;
    }
  }
  return { cell, dist: best };
}

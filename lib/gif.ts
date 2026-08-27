/**
 * GIF89a encoder and decoder, no dependencies.
 *
 * Both directions are written out by hand rather than leaning on the browser,
 * for one reason: it makes the whole path testable in Node. The WebM route
 * cannot be, because it needs a working video encoder in the environment, and
 * that turned out not to be a given.
 *
 * GIF is 8-bit, so frames have to be quantised to 256 colours. That is fine
 * here: the decode reads a black-and-white header plate and the position of one
 * saturated marker square, and the palette is built to hold both exactly.
 */

export type Frame = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };

/** Subarrays of a caller's buffer are not necessarily backed by a plain ArrayBuffer. */
type Bytes = Uint8Array<ArrayBufferLike>;

const CLEAR = 256;
const EOI = 257;

// --- palette -----------------------------------------------------------------

/**
 * Colours that must survive quantisation exactly: black and white -- which carry
 * the header plate and the marker both -- and the background.
 *
 * The rest is a 6x6x6 cube plus a grey ramp. The cube is deliberately equal on
 * all three axes: give blue a different number of levels and no mid grey is
 * representable at all, so every grey picks up a colour cast -- which is
 * conspicuous on a greyscale palette, where the whole image is greys.
 */
export function buildPalette(bg: [number, number, number]): Uint8Array {
  const pal = new Uint8Array(768);
  const put = (i: number, c: [number, number, number]) => pal.set(c, i * 3);
  put(0, [0, 0, 0]);
  put(1, [255, 255, 255]);
  put(2, bg);

  let i = 3;
  const level = (v: number) => Math.round((v * 255) / 5);
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) put(i++, [level(r), level(g), level(b)]);
    }
  }
  // Remaining slots go to a finer grey ramp, between the cube's coarse steps.
  const greys = 256 - i;
  for (let n = 0; n < greys; n++) {
    const v = Math.round(((n + 1) * 255) / (greys + 1));
    put(i++, [v, v, v]);
  }
  return pal;
}

/**
 * Nearest-palette-entry table over 5 bits per channel.
 *
 * Matching each pixel against 256 entries directly would be 256 comparisons per
 * pixel across millions of pixels. Bucketing to 32768 colours once and reusing
 * the answer turns the per-pixel cost into a single array read.
 */
export function buildLookup(pal: Uint8Array): Uint8Array {
  const lut = new Uint8Array(32768);
  for (let bucket = 0; bucket < 32768; bucket++) {
    const r = ((bucket >> 10) & 31) * 8 + 4;
    const g = ((bucket >> 5) & 31) * 8 + 4;
    const b = (bucket & 31) * 8 + 4;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = r - pal[i * 3];
      const dg = g - pal[i * 3 + 1];
      const db = b - pal[i * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    lut[bucket] = best;
  }

  // The first three entries carry the header plate, the marker and the
  // background, and the decode reads all three by exact value. Nearest-neighbour
  // does not guarantee them -- a fine grey ramp sits closer to the centre of the
  // near-black bucket than pure black does -- so pin those buckets outright.
  for (const i of [0, 1, 2]) {
    lut[bucketOf(pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2])] = i;
  }
  return lut;
}

const bucketOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

function quantise(frame: Frame, lut: Uint8Array): Uint8Array {
  const n = frame.width * frame.height;
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    out[p] = lut[bucketOf(frame.data[o], frame.data[o + 1], frame.data[o + 2])];
  }
  return out;
}

// --- bit plumbing ------------------------------------------------------------

class ByteSink {
  bytes: number[] = [];
  private bits = 0;
  private nbits = 0;

  /** GIF packs LZW codes least-significant bit first. */
  writeCode(code: number, width: number) {
    this.bits |= code << this.nbits;
    this.nbits += width;
    while (this.nbits >= 8) {
      this.bytes.push(this.bits & 0xff);
      this.bits >>= 8;
      this.nbits -= 8;
    }
  }

  flush() {
    if (this.nbits > 0) {
      this.bytes.push(this.bits & 0xff);
      this.bits = 0;
      this.nbits = 0;
    }
  }
}

/** Image data travels as sub-blocks of at most 255 bytes, terminated by a zero. */
function subBlocks(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

// --- LZW ---------------------------------------------------------------------

export function lzwEncode(indices: Uint8Array): number[] {
  const sink = new ByteSink();
  let width = 9;
  let next = EOI + 1;
  let dict = new Map<number, number>();

  sink.writeCode(CLEAR, width);
  if (indices.length === 0) {
    sink.writeCode(EOI, width);
    sink.flush();
    return sink.bytes;
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    sink.writeCode(prefix, width);
    dict.set(key, next++);
    if (next > 1 << width) {
      if (width < 12) width++;
      else {
        // The dictionary is full: start a fresh one, as the decoder will too.
        sink.writeCode(CLEAR, width);
        dict = new Map();
        width = 9;
        next = EOI + 1;
      }
    }
    prefix = k;
  }

  sink.writeCode(prefix, width);
  sink.writeCode(EOI, width);
  sink.flush();
  return sink.bytes;
}

export function lzwDecode(bytes: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  let at = 0;

  // Dictionary entries as (prefix, suffix) pairs, walked backwards when emitting.
  const prefixOf = new Int32Array(4096);
  const suffixOf = new Uint8Array(4096);
  const reset = () => {
    for (let i = 0; i < 256; i++) {
      prefixOf[i] = -1;
      suffixOf[i] = i;
    }
  };
  reset();

  let width = 9;
  let next = EOI + 1;
  let prev = -1;
  let bitPos = 0;
  const stack = new Uint8Array(4096);

  const emit = (code: number) => {
    let depth = 0;
    let c = code;
    while (c >= 0 && depth < 4096) {
      stack[depth++] = suffixOf[c];
      c = prefixOf[c];
    }
    while (depth > 0 && at < pixels) out[at++] = stack[--depth];
  };

  const totalBits = bytes.length * 8;
  while (bitPos + width <= totalBits) {
    let code = 0;
    for (let b = 0; b < width; b++) {
      const p = bitPos + b;
      code |= ((bytes[p >> 3] >> (p & 7)) & 1) << b;
    }
    bitPos += width;

    if (code === CLEAR) {
      reset();
      width = 9;
      next = EOI + 1;
      prev = -1;
      continue;
    }
    if (code === EOI) break;

    if (prev < 0) {
      emit(code);
      prev = code;
      continue;
    }

    if (code < next) {
      emit(code);
      prefixOf[next] = prev;
      // The new entry's suffix is the first byte of the code just emitted.
      let c = code;
      while (prefixOf[c] >= 0) c = prefixOf[c];
      suffixOf[next] = suffixOf[c];
      next++;
    } else {
      // The self-referential case: the code was defined by this very step.
      let c = prev;
      while (prefixOf[c] >= 0) c = prefixOf[c];
      prefixOf[next] = prev;
      suffixOf[next] = suffixOf[c];
      next++;
      emit(next - 1);
    }

    if (next === 1 << width && width < 12) width++;
    prev = code;
  }
  return out;
}

// --- container ---------------------------------------------------------------

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const short = (v: number) => [v & 0xff, (v >> 8) & 0xff];

export function encodeGif(opts: {
  frames: Frame[];
  palette: Uint8Array;
  lut: Uint8Array;
  /** Frame delay in hundredths of a second. */
  delay: number;
}): Uint8Array<ArrayBuffer> {
  const { frames, palette, lut, delay } = opts;
  if (frames.length === 0) throw new Error("no frames");
  const W = frames[0].width;
  const H = frames[0].height;

  const out: number[] = [
    ...ascii("GIF89a"),
    ...short(W),
    ...short(H),
    0xf7, // global colour table, 256 entries
    0,
    0,
    ...palette,
    // Netscape extension: loop forever.
    0x21,
    0xff,
    0x0b,
    ...ascii("NETSCAPE2.0"),
    0x03,
    0x01,
    ...short(0),
    0x00,
  ];

  for (const frame of frames) {
    out.push(0x21, 0xf9, 0x04, 0x04, ...short(delay), 0x00, 0x00);
    out.push(0x2c, ...short(0), ...short(0), ...short(W), ...short(H), 0x00);
    out.push(8, ...subBlocks(lzwEncode(quantise(frame, lut))));
  }

  out.push(0x3b);
  return Uint8Array.from(out);
}

/** Every frame as full-size RGBA. Frames here are opaque and full-frame by construction. */
export function decodeGif(bytes: Uint8Array): Frame[] {
  if (String.fromCharCode(...bytes.subarray(0, 3)) !== "GIF") throw new Error("Not a GIF.");
  let p = 6;
  const W = bytes[p] | (bytes[p + 1] << 8);
  const H = bytes[p + 2] | (bytes[p + 3] << 8);
  const packed = bytes[p + 4];
  p += 7;

  let global: Bytes = new Uint8Array(0);
  if (packed & 0x80) {
    const size = 3 * (1 << ((packed & 7) + 1));
    global = bytes.subarray(p, p + size);
    p += size;
  }

  const skipBlocks = () => {
    while (bytes[p] !== 0) p += bytes[p] + 1;
    p++;
  };
  const readBlocks = () => {
    const parts: Uint8Array[] = [];
    while (bytes[p] !== 0) {
      const len = bytes[p];
      parts.push(bytes.subarray(p + 1, p + 1 + len));
      p += len + 1;
    }
    p++;
    const total = parts.reduce((a, b) => a + b.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  };

  const frames: Frame[] = [];
  let transparent = -1;

  while (p < bytes.length) {
    const marker = bytes[p];
    if (marker === 0x3b) break;

    if (marker === 0x21) {
      const label = bytes[p + 1];
      p += 2;
      if (label === 0xf9) {
        const len = bytes[p];
        const flags = bytes[p + 1];
        transparent = flags & 1 ? bytes[p + 4] : -1;
        p += len + 1;
        skipBlocks();
      } else {
        skipBlocks();
      }
      continue;
    }

    if (marker !== 0x2c) {
      p++;
      continue;
    }

    p++;
    const left = bytes[p] | (bytes[p + 1] << 8);
    const top = bytes[p + 2] | (bytes[p + 3] << 8);
    const fw = bytes[p + 4] | (bytes[p + 5] << 8);
    const fh = bytes[p + 6] | (bytes[p + 7] << 8);
    const flags = bytes[p + 8];
    p += 9;

    let table: Bytes = global;
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1));
      table = bytes.subarray(p, p + size);
      p += size;
    }
    if (flags & 0x40) throw new Error("Interlaced GIFs are not supported.");

    const minCodeSize = bytes[p++];
    if (minCodeSize !== 8) throw new Error("Only 8-bit GIFs are supported.");
    const indices = lzwDecode(readBlocks(), fw * fh);

    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const idx = indices[y * fw + x];
        const o = ((top + y) * W + (left + x)) * 4;
        if (idx === transparent) continue;
        rgba[o] = table[idx * 3];
        rgba[o + 1] = table[idx * 3 + 1];
        rgba[o + 2] = table[idx * 3 + 2];
        rgba[o + 3] = 255;
      }
    }
    frames.push({ width: W, height: H, data: rgba });
  }

  return frames;
}

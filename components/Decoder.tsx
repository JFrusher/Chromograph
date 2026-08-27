"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CELLS, COLS, ROWS, cellCenter } from "@/lib/grid";
import { isoRect, toPx as isoToPx } from "@/lib/iso";
import { decode, decodeFrames, gridToImage, type DecodeResult } from "@/lib/decode";
import { framesFromVideo } from "@/lib/anim";
import { sheetTiles } from "@/lib/frame";
import { decodeGif } from "@/lib/gif";

/** Bounds the decode passes and the debug canvas on huge still uploads. */
const MAX_EDGE = 2048;
/** Sheets are read at full size, so this is the real ceiling. */
const MAX_PIXELS = 60_000_000;

function toImageData(bitmap: ImageBitmap, w: number, h: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

type Props = {
  /** Renders the current studio artwork offscreen, so it can be decoded without a file. */
  getCurrentImage: () => ImageData | null;
};

export default function Decoder({ getCurrentImage }: Props) {
  const [image, setImage] = useState<ImageData | null>(null);
  const [result, setResult] = useState<DecodeResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fromVideo = useRef(false);

  const load = useCallback(async (file: File) => {
    setNote(null);
    if (/video|\.webm$/i.test(file.type || file.name)) {
      try {
        setNote("Reading frames. This plays the animation through, so it takes about as long as the clip.");
        const frames = await framesFromVideo(file, (n) => setNote(`Read ${n} frames...`));
        if (frames.length === 0) throw new Error("No frames were readable.");
        fromVideo.current = true;
        setImage(frames[0]);
        setResult(decodeFrames(frames));
        setNote(null);
      } catch (err) {
        setNote(err instanceof Error ? err.message : "Could not read that video.");
      }
      return;
    }
    if (/gif/i.test(file.type || file.name)) {
      try {
        setNote("Decoding GIF frames...");
        const frames = decodeGif(new Uint8Array(await file.arrayBuffer()));
        if (frames.length === 0) throw new Error("That GIF has no frames.");
        fromVideo.current = true;
        setImage(new ImageData(new Uint8ClampedArray(frames[0].data), frames[0].width, frames[0].height));
        setResult(decodeFrames(frames));
        setNote(null);
      } catch (err) {
        setNote(err instanceof Error ? err.message : "Could not read that GIF.");
      }
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > MAX_PIXELS) {
        bitmap.close();
        throw new Error("That image is too large to decode.");
      }

      // Sheets must be examined at full resolution: downscaling makes the tile
      // grid non-integer and the layout unrecoverable.
      const full = toImageData(bitmap, bitmap.width, bitmap.height);
      const tiles = sheetTiles(full);
      if (tiles) {
        fromVideo.current = true;
        setImage(new ImageData(new Uint8ClampedArray(tiles[0].data), tiles[0].width, tiles[0].height));
        setResult(decodeFrames(tiles));
        bitmap.close();
        return;
      }

      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      setImage(toImageData(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)));
      bitmap.close();
      if (/jpe?g/i.test(file.type)) {
        setNote("JPEG detected. Chroma subsampling smears hue, which is the only thing carrying the message. Expect errors.");
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not read that file. PNG, WebP, JPEG or WebM only.");
      setImage(null);
      setResult(null);
    }
  }, []);

  // Stills decode from the image itself; an animation has already produced its
  // result by the time the first frame lands here, so it must not be re-decoded.
  useEffect(() => {
    if (!image || fromVideo.current) {
      fromVideo.current = false;
      return;
    }
    // A sprite sheet is still a PNG, so it arrives here; frames win when present.
    const tiles = sheetTiles(image);
    setResult(tiles ? decodeFrames(tiles) : decode(image));
  }, [image]);

  // Separate pass: the debug canvas is only mounted once there is a result, so
  // painting it in the decode effect would target a canvas that does not exist yet.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!image || !result || !canvas || !ctx) return;
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.putImageData(image, 0, 0);
    drawOverlay(ctx, image.width, image.height, result);
  }, [image, result]);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void load(file);
        }}
        className={`w-in flex flex-col items-center gap-2 p-4 text-center ${
          dragging ? "outline-2 outline-dotted outline-[var(--dark)] -outline-offset-4" : ""
        }`}
      >
        <p className="font-bold">Drop a Chromograph PNG, sheet, GIF or WebM here</p>
        <p className="max-w-[440px] text-[var(--shadow)]">
          A sheet, GIF or WebM decodes exactly: every frame states which character it is, so
          order, dropped frames and compression all stop mattering. A still image is best effort.
          Either way the scene is placed from the file's dimensions, so it must be uncropped.
        </p>
        <div className="flex gap-[3px]">
          <label className="w-out w-btn">
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg,image/gif,video/webm"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void load(file);
              }}
            />
            Browse...
          </label>
          <button
            onClick={() => {
              const img = getCurrentImage();
              if (img) setImage(img);
            }}
            className="w-out w-btn"
          >
            Use current artwork
          </button>
        </div>
      </div>

      {note && <Notice>{note}</Notice>}

      {result && (
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-1">
            <div className="w-in p-1">
              <canvas ref={canvasRef} className="block h-auto w-full" />
            </div>
            {result.mode === "frames" && (
              <p className="text-[var(--shadow)]">
                Showing frame 1 of {result.knotCount}. Each of the others was read at its own
                camera angle.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <fieldset className="w-etch px-2 pb-2 pt-1">
              <legend className="px-1 font-bold">Decoded</legend>
              <p className="w-in break-words p-1.5 font-[Courier_New,monospace] text-[13px]">
                {result.chars.length === 0 ? (
                  <span className="text-[var(--shadow)]">(nothing)</span>
                ) : (
                  result.chars.map((c, i) => (
                    <span
                      key={i}
                      title={`confidence ${(c.confidence * 100).toFixed(0)}%`}
                      className={
                        c.confidence > 0.6
                          ? ""
                          : c.confidence > 0.35
                            ? "bg-[#ffff00]"
                            : "bg-[var(--selected)] text-[var(--light)]"
                      }
                    >
                      {c.char === " " ? "·" : c.char}
                    </span>
                  ))
                )}
              </p>
            </fieldset>

            <table className="w-full">
              <tbody>
                <Row
                  k="Read from"
                  v={result.mode === "frames" ? "frame index" : result.mode === "iso" ? "stem geometry" : "hue"}
                />
                <Row
                  k="Length source"
                  v={
                    result.source === "frame-index"
                      ? "frame header"
                      : result.source === "calibration-bar"
                        ? "calibration bar"
                        : "curve fit"
                  }
                />
                <Row k="Characters" v={String(result.knotCount)} />
                <Row
                  k={result.mode === "frames" ? "Frames read" : "Curve pixels"}
                  v={result.maskedPixels.toLocaleString()}
                />
              </tbody>
            </table>

            {result.warnings.map((w, i) => (
              <Notice key={i}>{w}</Notice>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="border border-[var(--shadow)] px-1.5 py-0.5">{k}</td>
      <td className="border border-[var(--shadow)] px-1.5 py-0.5 font-bold">{v}</td>
    </tr>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-[var(--dark)] bg-[#ffffe1] px-1.5 py-1">
      <span className="font-bold">! </span>
      {children}
    </p>
  );
}

/** Dimmed source image + what the decoder actually found. */
function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, out: DecodeResult) {
  const s = Math.min(W, H) / 1000;
  ctx.fillStyle = "rgba(0,0,0,0.66)";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  if (out.mode === "iso" || out.mode === "frames") {
    // The base plane the stem feet were measured against.
    const r = isoRect(W, H);
    for (let i = 0; i <= COLS; i++) {
      const a = isoToPx({ x: i / COLS, y: 0, z: 0 }, r);
      const b = isoToPx({ x: i / COLS, y: 1, z: 0 }, r);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let j = 0; j <= ROWS; j++) {
      const a = isoToPx({ x: 0, y: j / ROWS, z: 0 }, r);
      const b = isoToPx({ x: 1, y: j / ROWS, z: 0 }, r);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
  } else {
    for (let i = 0; i < CELLS; i++) {
      const p = gridToImage(cellCenter(i), W, H);
      ctx.rect(p.x - 13 * s, p.y - 13 * s, 26 * s, 26 * s);
    }
  }
  ctx.stroke();

  if (out.trace.length > 1) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.beginPath();
    ctx.moveTo(out.trace[0].x, out.trace[0].y);
    for (const p of out.trace.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  const box = 13 * s;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(1, s);
  // In a multi-frame decode every marker was found on its own frame, at its own
  // camera angle. Only the frame actually on screen may be drawn over it.
  const shown = out.mode === "frames" ? out.chars.slice(0, 1) : out.chars;
  shown.forEach((c, i) => {
    if (!c.at) return;
    ctx.fillStyle = c.confidence > 0.6 ? "#00ff00" : c.confidence > 0.35 ? "#ffff00" : "#ff0000";
    ctx.fillRect(c.at.x - box, c.at.y - box, box * 2, box * 2);
    ctx.strokeStyle = "#000000";
    ctx.strokeRect(c.at.x - box, c.at.y - box, box * 2, box * 2);
    ctx.fillStyle = "#000000";
    ctx.font = `bold ${Math.round(16 * s)}px "Courier New", monospace`;
    ctx.fillText(c.char === " " ? "·" : c.char, c.at.x, c.at.y + s);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.round(11 * s)}px "Courier New", monospace`;
    ctx.fillText(String(i + 1), c.at.x, c.at.y - 21 * s);
  });
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CELLS, COLS, ROWS, cellCenter } from "@/lib/grid";
import Notice from "./Notice";
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

/**
 * A decode and the frame it should be shown against, set together.
 *
 * One piece of state rather than two, because they must never disagree: a
 * multi-frame decode's preview is only its first frame, and deriving the result
 * from the preview would silently re-read that one frame as a still.
 */
type View = { preview: ImageData; result: DecodeResult };

const asImageData = (f: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }) =>
  new ImageData(new Uint8ClampedArray(f.data), f.width, f.height);

export default function Decoder({ getCurrentImage }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const load = useCallback(async (file: File) => {
    setNote(null);
    const name = file.type || file.name;
    try {
      if (/video|\.webm$/i.test(name)) {
        setNote("Reading frames. This plays the animation through, so it takes about as long as the clip.");
        const frames = await framesFromVideo(file, (n) => setNote(`Read ${n} frames...`));
        if (frames.length === 0) throw new Error("No frames were readable.");
        setView({ preview: frames[0], result: decodeFrames(frames) });
        setNote(null);
        return;
      }

      if (/gif/i.test(name)) {
        setNote("Decoding GIF frames...");
        const frames = decodeGif(new Uint8Array(await file.arrayBuffer()));
        if (frames.length === 0) throw new Error("That GIF has no frames.");
        setView({ preview: asImageData(frames[0]), result: decodeFrames(frames) });
        setNote(null);
        return;
      }

      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error("That image is too large to decode.");

        // Sheets must be examined at full resolution: downscaling makes the tile
        // grid non-integer and the layout unrecoverable.
        const tiles = sheetTiles(toImageData(bitmap, bitmap.width, bitmap.height));
        if (tiles) {
          setView({ preview: asImageData(tiles[0]), result: decodeFrames(tiles) });
          return;
        }

        const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const still = toImageData(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
        setView({ preview: still, result: decode(still) });
        if (/jpe?g/i.test(file.type)) {
          setNote("JPEG detected. Chroma subsampling smears hue, which carries the order in a still. Expect errors.");
        }
      } finally {
        bitmap.close();
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not read that file. PNG, WebP, JPEG, GIF or WebM only.");
      setView(null);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!view || !canvas || !ctx) return;
    canvas.width = view.preview.width;
    canvas.height = view.preview.height;
    ctx.putImageData(view.preview, 0, 0);
    drawOverlay(ctx, view.preview.width, view.preview.height, view.result);
  }, [view]);

  const useCurrent = () => {
    const image = getCurrentImage();
    if (image) setView({ preview: image, result: decode(image) });
  };

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
            onClick={useCurrent}
            className="w-out w-btn"
          >
            Use current artwork
          </button>
        </div>
      </div>

      {note && <Notice>{note}</Notice>}

      {view && (
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-1">
            <div className="w-in p-1">
              <canvas ref={canvasRef} className="block h-auto w-full" />
            </div>
            {view.result.mode === "frames" && (
              <p className="text-[var(--shadow)]">
                Showing frame 1 of {view.result.knotCount}. Each of the others was read at its own
                camera angle.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <fieldset className="w-etch px-2 pb-2 pt-1">
              <legend className="px-1 font-bold">Decoded</legend>
              <p className="w-in break-words p-1.5 font-[Courier_New,monospace] text-[13px]">
                {view.result.chars.length === 0 ? (
                  <span className="text-[var(--shadow)]">(nothing)</span>
                ) : (
                  view.result.chars.map((c, i) => (
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
                  v={view.result.mode === "frames" ? "frame index" : "hue"}
                />
                <Row
                  k="Length source"
                  v={
                    view.result.source === "frame-index"
                      ? "frame header"
                      : view.result.source === "calibration-bar"
                        ? "calibration bar"
                        : "curve fit"
                  }
                />
                <Row k="Characters" v={String(view.result.knotCount)} />
                <Row
                  k={view.result.mode === "frames" ? "Frames read" : "Curve pixels"}
                  v={view.result.maskedPixels.toLocaleString()}
                />
              </tbody>
            </table>

            {view.result.warnings.map((w, i) => (
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

/** Dimmed source image + what the decoder actually found. */
function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, out: DecodeResult) {
  const s = Math.min(W, H) / 1000;
  ctx.fillStyle = "rgba(0,0,0,0.66)";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  if (out.mode === "iso" || out.mode === "frames") {
    // The base plane the marker was unprojected onto.
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

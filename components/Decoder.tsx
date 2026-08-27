"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CELLS, cellCenter } from "@/lib/grid";
import { decode, gridToImage, type DecodeResult } from "@/lib/decode";

/** Bounds the decode passes and the debug canvas on huge uploads. */
const MAX_EDGE = 2048;

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

  const load = useCallback(async (file: File) => {
    setNote(null);
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      setImage(ctx.getImageData(0, 0, w, h));
      if (/jpe?g/i.test(file.type)) {
        setNote("JPEG detected. Chroma subsampling smears hue, which is the only thing carrying the message. Expect errors.");
      }
    } catch {
      setNote("Could not read that file. PNG, WebP or JPEG only.");
      setImage(null);
      setResult(null);
    }
  }, []);

  useEffect(() => {
    setResult(image ? decode(image) : null);
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
        <p className="font-bold">Drop a Chromograph PNG here</p>
        <p className="max-w-[440px] text-[var(--shadow)]">
          The grid position is derived from the image dimensions, so the export must be uncropped.
          Exports with the calibration bar decode most reliably.
        </p>
        <div className="flex gap-[3px]">
          <label className="w-out w-btn">
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg"
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
          <div className="w-in p-1">
            <canvas ref={canvasRef} className="block h-auto w-full" />
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
                <Row k="Length source" v={result.source === "calibration-bar" ? "calibration bar" : "curve fit"} />
                <Row k="Characters" v={String(result.knotCount)} />
                <Row k="Curve pixels" v={result.maskedPixels.toLocaleString()} />
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

/** Dimmed source image + traced hue ramp + where each character was sampled. */
function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, out: DecodeResult) {
  const s = Math.min(W, H) / 1000;
  ctx.fillStyle = "rgba(0,0,0,0.66)";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  for (let i = 0; i < CELLS; i++) {
    const p = gridToImage(cellCenter(i), W, H);
    ctx.rect(p.x - 13 * s, p.y - 13 * s, 26 * s, 26 * s);
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
  out.chars.forEach((c, i) => {
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

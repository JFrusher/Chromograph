"use client";

import { useCallback, useMemo, useState } from "react";
import CanvasView from "@/components/CanvasView";
import Decoder from "@/components/Decoder";
import Sidebar from "@/components/Sidebar";
import { sanitize } from "@/lib/grid";
import { presetById } from "@/lib/palette";
import { DEFAULT_PARAMS, drawChromograph, type RenderParams } from "@/lib/render";
import { toSVG } from "@/lib/svg";
import { desmosText, fitFourier, fourierText } from "@/lib/equation";

/** Short edge of a PNG export, in pixels. */
const EXPORT_SHORT_EDGE = 2048;

export default function Page() {
  const [text, setText] = useState("HELLO WORLD");
  const [params, setParams] = useState<RenderParams>(DEFAULT_PARAMS);
  const [presetId, setPresetId] = useState("black");
  const [tab, setTab] = useState<"encode" | "decode">("encode");
  const [viewport, setViewport] = useState({ w: 1200, h: 900 });
  const [equationNote, setEquationNote] = useState<string | null>(null);

  const preset = presetById(presetId);
  const clean = useMemo(() => sanitize(text), [text]);

  const onResize = useCallback((w: number, h: number) => setViewport({ w, h }), []);

  /** Export keeps the viewport's aspect ratio, so the PNG frames like the screen does. */
  const exportSize = () => {
    const aspect = viewport.w / Math.max(1, viewport.h);
    return aspect >= 1
      ? { width: Math.round(EXPORT_SHORT_EDGE * aspect), height: EXPORT_SHORT_EDGE }
      : { width: EXPORT_SHORT_EDGE, height: Math.round(EXPORT_SHORT_EDGE / aspect) };
  };

  const renderOffscreen = useCallback(
    (width: number, height: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      drawChromograph(ctx, { text: clean.text, params, preset, width, height });
      return { canvas, ctx };
    },
    [clean.text, params, preset],
  );

  const exportPNG = () => {
    const { width, height } = exportSize();
    const rendered = renderOffscreen(width, height);
    rendered?.canvas.toBlob((blob) => blob && download(`${slug(clean.text)}.png`, blob), "image/png");
  };

  const exportSVG = () => {
    const { width, height } = exportSize();
    const svg = toSVG({ text: clean.text, params, preset, width, height });
    download(`${slug(clean.text)}.svg`, new Blob([svg], { type: "image/svg+xml" }));
  };

  const exportFourier = () => {
    const fit = fitFourier(clean.text, params.tension);
    if (!fit) {
      setEquationNote("Need at least two characters before there is a path to fit.");
      return;
    }
    download(`${slug(clean.text)}-fourier.txt`, new Blob([fourierText(fit, clean.text)], { type: "text/plain" }));
    setEquationNote(`${fit.harmonics} harmonics, ${((fit.rms / (1 / 6)) * 100).toFixed(1)}% of a cell RMS error.`);
  };

  const copyDesmos = async () => {
    const fit = fitFourier(clean.text, params.tension);
    if (!fit) {
      setEquationNote("Need at least two characters before there is a path to fit.");
      return;
    }
    const text = desmosText(fit);
    try {
      await navigator.clipboard.writeText(text);
      setEquationNote(`Copied ${fit.harmonics} harmonics. Paste into a blank Desmos graph.`);
    } catch {
      // Clipboard needs a permission the page may not have; a file always works.
      download(`${slug(clean.text)}-desmos.txt`, new Blob([text], { type: "text/plain" }));
      setEquationNote("Clipboard was blocked, so it downloaded as a file instead.");
    }
  };

  const getCurrentImage = useCallback(() => {
    const rendered = renderOffscreen(1600, 1200);
    return rendered ? rendered.ctx.getImageData(0, 0, 1600, 1200) : null;
  }, [renderOffscreen]);

  return (
    <div className="h-full p-1">
      <div className="w-out flex h-full flex-col">
        <div className="w-title">
          <span className="grow">Chromograph - {clean.text || "Untitled"}</span>
          {/* Window controls are chrome, not behaviour: a browser tab has no
              minimise or restore, so these are shown but do nothing. */}
          {["–", "□", "✕"].map((glyph, i) => (
            <span key={i} aria-hidden className="w-out w-titlebtn text-[var(--dark)]">
              {glyph}
            </span>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          <Sidebar
            text={text}
            setText={setText}
            clean={clean}
            params={params}
            setParams={setParams}
            preset={preset}
            setPresetId={setPresetId}
            onExportPNG={exportPNG}
            onExportSVG={exportSVG}
            onExportFourier={exportFourier}
            onCopyDesmos={copyDesmos}
            equationNote={equationNote}
          />

          <div className="flex min-w-0 flex-1 flex-col p-1">
            <div className="flex gap-[2px] pl-1">
              {(
                [
                  ["encode", "Encode"],
                  ["decode", "Decode"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`w-out border-b-0 px-3 py-[3px] ${tab === id ? "relative z-10 pb-[5px] font-bold" : ""}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Both panes stay mounted so switching tabs does not drop the
                decoder's loaded image or force the canvas to re-measure. */}
            <div className="w-out relative min-h-0 flex-1 p-1">
              <div className={`absolute inset-1 ${tab === "encode" ? "" : "invisible"}`}>
                <div className="w-in h-full p-1">
                  <CanvasView text={clean.text} params={params} preset={preset} onResize={onResize} />
                </div>
              </div>
              <div className={`absolute inset-1 overflow-hidden ${tab === "decode" ? "" : "invisible"}`}>
                <Decoder getCurrentImage={getCurrentImage} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-1 border-t border-[var(--light)] p-1">
          <StatusCell className="grow">
            {clean.text.length} character{clean.text.length === 1 ? "" : "s"}
          </StatusCell>
          <StatusCell>{preset.name}</StatusCell>
          <StatusCell>{params.mode === "iso" ? "Isometric" : "Flat"}</StatusCell>
          <StatusCell>
            {!preset.decodable
              ? "Art only"
              : params.mode === "iso" && params.stems
                ? "Geometric + colour"
                : "Colour only"}
          </StatusCell>
        </div>
      </div>
    </div>
  );
}

function StatusCell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`w-in !bg-[var(--face)] px-1.5 py-[1px] ${className}`}>{children}</div>;
}

function slug(text: string) {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "chromograph"
  );
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

"use client";

import { useCallback, useEffect, useRef } from "react";
import { drawChromograph, type RenderParams } from "@/lib/render";
import type { Preset } from "@/lib/palette";

type Props = {
  text: string;
  params: RenderParams;
  preset: Preset;
  /** Reports CSS-pixel size so exports can match the viewport's aspect ratio. */
  onResize?: (w: number, h: number) => void;
};

/** Static render: nothing here animates, so it paints on change and then stops. */
export default function CanvasView({ text, params, preset, onResize }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      onResize?.(canvas.clientWidth, canvas.clientHeight);
    }
    drawChromograph(ctx, { text, params, preset, width: w, height: h });
  }, [text, params, preset, onResize]);

  useEffect(() => {
    paint();
  }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-label="Chromograph render" />;
}

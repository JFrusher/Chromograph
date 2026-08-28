"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { scanFrame } from "@/lib/scan";
import type { ImageDataLike } from "@/lib/decode";

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

type Captured = { char: string; confidence: number };

/** Window over which the accepted-frame rate is averaged, in ms. */
const RATE_WINDOW = 2000;

type WakeLockish = { release: () => Promise<void> };

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const gotRef = useRef(new Map<number, Captured>());
  const acceptsRef = useRef<number[]>([]);
  const framesRef = useRef(0);

  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState("");
  const [n, setN] = useState(0);
  const [chars, setChars] = useState<(Captured | undefined)[]>([]);
  const [rate, setRate] = useState({ accepted: 0, seen: 0 });
  const [screenSource, setScreenSource] = useState(false);

  useEffect(() => {
    setScreenSource(new URLSearchParams(window.location.search).get("src") === "screen");
  }, []);

  // A phone held still at a monitor is not touching the screen, so it dims and
  // then sleeps partway through a transfer.
  useEffect(() => {
    if (status !== "running") return;
    const api = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockish> } }).wakeLock;
    if (!api) return;
    let lock: WakeLockish | null = null;
    let dropped = false;
    const acquire = () => {
      api
        .request("screen")
        .then((l) => {
          if (dropped) void l.release().catch(() => {});
          else lock = l;
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      dropped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [status]);

  const reset = useCallback(() => {
    gotRef.current = new Map();
    acceptsRef.current = [];
    framesRef.current = 0;
    setN(0);
    setChars([]);
  }, []);

  /** Draw the rectified buffer, so a bad hold is visible rather than guessed at. */
  const showWarp = useCallback((buf: ImageDataLike) => {
    const canvas = previewRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (canvas.width !== buf.width || canvas.height !== buf.height) {
      canvas.width = buf.width;
      canvas.height = buf.height;
    }
    const out = ctx.createImageData(buf.width, buf.height);
    out.data.set(buf.data);
    ctx.putImageData(out, 0, 0);
  }, []);

  const start = useCallback(async () => {
    setError("");
    reset();
    try {
      const wantScreen = new URLSearchParams(window.location.search).get("src") === "screen";
      // src=screen swaps the camera for a captured window. Same MediaStream, same
      // pipeline, no hardware: open /show in one window and point this at it to
      // exercise the whole live path on a laptop.
      const stream = wantScreen
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          });

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      setStatus("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a video source.");
      setStatus("error");
    }
  }, [reset]);

  useEffect(() => {
    if (status !== "running") return;
    const video = videoRef.current as VideoWithFrameCallback | null;
    const work = workRef.current;
    if (!video || !work) return;
    const ctx = work.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    let stopped = false;
    let rafHandle = 0;

    const grab = () => {
      if (stopped) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw > 0 && vh > 0) {
        // Half size, taken once. drawImage does the downscale on the GPU, so
        // this is the only readback in the loop -- the whole per-frame budget.
        const w = Math.max(1, Math.round(vw / 2));
        const h = Math.max(1, Math.round(vh / 2));
        if (work.width !== w || work.height !== h) {
          work.width = w;
          work.height = h;
        }
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);

        framesRef.current++;
        const got = scanFrame(img, { onWarp: showWarp });
        if (got) {
          acceptsRef.current.push(performance.now());
          const prev = gotRef.current.get(got.k);
          // A frame that read the marker more cleanly wins. Both passed the
          // band CRC, so this only ever refines a character, never invents one.
          if (!prev || got.confidence > prev.confidence) {
            gotRef.current.set(got.k, { char: got.char, confidence: got.confidence });
            setN(got.n);
            setChars(Array.from({ length: got.n }, (_, i) => gotRef.current.get(i)));
          }
        }
      }
      schedule();
    };

    const schedule = () => {
      if (stopped) return;
      // One callback per camera frame, so nothing is processed twice or missed.
      if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(grab);
      else rafHandle = requestAnimationFrame(grab);
    };

    schedule();
    return () => {
      stopped = true;
      cancelAnimationFrame(rafHandle);
    };
  }, [status, showWarp]);

  // The rate readout is the calibration knob: it is how you find the working
  // distance, rather than guessing at it.
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => {
      const cutoff = performance.now() - RATE_WINDOW;
      acceptsRef.current = acceptsRef.current.filter((t) => t > cutoff);
      setRate({ accepted: Math.round((acceptsRef.current.length / RATE_WINDOW) * 1000), seen: framesRef.current });
    }, 500);
    return () => clearInterval(id);
  }, [status]);

  useEffect(
    () => () => {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const have = chars.filter(Boolean).length;
  const text = chars.map((c) => c?.char ?? "?").join("");
  const complete = n > 0 && have === n;

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2" style={{ background: "var(--face)" }}>
      <div className="w-out flex flex-wrap items-center gap-2 p-2">
        <strong>Chromograph scan</strong>
        {status !== "running" && (
          <button className="w-out w-btn px-2 py-[2px]" onClick={() => void start()}>
            {screenSource ? "Capture a window" : "Start camera"}
          </button>
        )}
        {status === "running" && (
          <button className="w-out w-btn px-2 py-[2px]" onClick={reset}>
            Reset
          </button>
        )}
        {status === "running" && (
          <span className="w-etch px-2 py-[2px]">
            {rate.accepted}/s accepted · {rate.seen} frames seen
          </span>
        )}
        {screenSource && <span className="w-etch px-2 py-[2px]">Screen source</span>}
      </div>

      {error && <div className="w-out p-2">{error}</div>}

      {status === "idle" && !error && (
        <div className="w-out p-2">
          Play <code>/show</code> full screen on the other device, then point this at it. Fill the frame with
          the pattern, and keep all four corner squares in shot.
        </div>
      )}

      <div className="w-in relative" style={{ background: "#000" }}>
        <video ref={videoRef} className="block max-h-[46vh] w-full object-contain" playsInline muted />
        <canvas
          ref={previewRef}
          className="w-in absolute bottom-1 right-1"
          style={{ width: 128, background: "#000" }}
          aria-label="Rectified artwork"
        />
      </div>
      <canvas ref={workRef} className="hidden" />

      {n > 0 && (
        <div className="w-out flex flex-col gap-2 p-2">
          <div className="flex items-center gap-2">
            <span>
              {have}/{n} characters
            </span>
            {complete && <strong>Complete</strong>}
          </div>

          {/* Which indices are still missing, so a bad patch is obvious and you
              can shift the phone rather than wait the loop out again. */}
          <div className="flex flex-wrap gap-[2px]">
            {chars.map((c, i) => (
              <span
                key={i}
                title={"character " + (i + 1)}
                style={{
                  width: 10,
                  height: 10,
                  background: c ? "var(--title)" : "var(--shadow)",
                  display: "inline-block",
                }}
              />
            ))}
          </div>

          <div className="w-in break-words p-1" style={{ background: "var(--field)", minHeight: 40 }}>
            {text}
          </div>

          <div className="flex gap-2">
            <button
              className="w-out w-btn px-2 py-[2px]"
              disabled={!complete}
              onClick={() => void navigator.clipboard?.writeText(text)}
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

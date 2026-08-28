"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sanitize } from "@/lib/grid";
import { DEFAULT_PARAMS } from "@/lib/render";
import { SHOW, SHOW_GROUND, drawShowFrame } from "@/lib/showframe";

/**
 * Dwell per frame, in milliseconds.
 *
 * A camera frame is untorn only if the sensor's whole readout window -- roughly
 * 25ms on a phone at 30fps -- falls inside one dwell, so the odds of a clean
 * capture are about (dwell - readout) / dwell. At 125ms that is 0.8, against
 * 3.75 camera frames per displayed frame: three clean looks at every character.
 * Enough that an autofocus hunt, a hand tremor or a glare pass does not cost the
 * character on this pass of the loop.
 *
 * Real rooms differ, so this is a knob rather than a constant.
 */
const SPEEDS = [
  { id: "slow", label: "Slow", fps: 5 },
  { id: "normal", label: "Normal", fps: 8 },
  { id: "fast", label: "Fast", fps: 12 },
] as const;

/** Past this many characters a full loop is a long hold for a steady hand. */
const LONG_MESSAGE = 40;

type WakeLockish = { release: () => Promise<void> };

/**
 * Keep the display awake.
 *
 * A screen that dims halfway through a transfer takes the marker's contrast with
 * it, and one that sleeps ends the transfer. Re-acquired on visibility change
 * because the lock is dropped whenever the tab is hidden.
 */
function useWakeLock() {
  useEffect(() => {
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
  }, []);
}

export default function ShowPage() {
  const [text, setText] = useState("HELLO WORLD");
  const [speedId, setSpeedId] = useState<(typeof SPEEDS)[number]["id"]>("normal");
  const [chrome, setChrome] = useState(true);
  const [frame, setFrame] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** rAF ticks elapsed on the current frame, and the frame itself. */
  const tickRef = useRef(0);
  const kRef = useRef(0);
  /** Recent rAF deltas, for working out the monitor's refresh period. */
  const deltasRef = useRef<number[]>([]);

  useWakeLock();

  const clean = useMemo(() => sanitize(text), [text]);
  const speed = SPEEDS.find((s) => s.id === speedId) ?? SPEEDS[1];
  const n = clean.text.length;

  // Read the message off the URL once, so the studio can hand off with a link
  // and a phone-side bookmark can carry its own settings. Read from
  // window.location rather than useSearchParams: this page is a leaf, and the
  // hook would drag a Suspense boundary in for one string.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("t");
    const s = q.get("s");
    if (t) setText(t);
    if (s && SPEEDS.some((x) => x.id === s)) setSpeedId(s as (typeof SPEEDS)[number]["id"]);
  }, []);

  const paint = useCallback(
    (k: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || n < 1) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      // Fit the frozen composition to whatever the screen is, centred. One
      // transform: everything downstream draws in show coordinates and never
      // needs to know the display's size.
      const { total } = SHOW;
      const s = Math.min(w / total.w, h / total.h);
      ctx.setTransform(s, 0, 0, s, (w - total.w * s) / 2 - total.x * s, (h - total.h * s) / 2 - total.y * s);
      drawShowFrame(ctx, { text: clean.text, params: DEFAULT_PARAMS, frame: { k, n } });
    },
    [clean.text, n],
  );

  /**
   * Advance on a whole number of refreshes rather than a timer.
   *
   * setInterval against a compositor produces frames that occasionally last one
   * refresh instead of eight, and a camera that catches one of those reads a
   * torn frame for reasons nothing downstream can diagnose. Counting ticks makes
   * every dwell identical by construction.
   */
  useEffect(() => {
    if (n < 1) return;
    kRef.current = 0;
    tickRef.current = 0;
    deltasRef.current = [];
    let raf = 0;
    let last = 0;
    /** Assume 60Hz until enough deltas have been seen to know better. */
    let refresh = 1000 / 60;
    let measured = false;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (last) {
        const d = now - last;
        if (!measured && d > 1 && d < 100) {
          const ds = deltasRef.current;
          ds.push(d);
          if (ds.length >= 20) {
            const sorted = ds.slice().sort((a, b) => a - b);
            refresh = sorted[sorted.length >> 1];
            measured = true;
          }
        }
      }
      last = now;

      const perFrame = Math.max(4, Math.round(1000 / speed.fps / refresh));
      if (tickRef.current === 0) {
        paint(kRef.current);
        setFrame(kRef.current);
      }
      tickRef.current++;
      if (tickRef.current >= perFrame) {
        tickRef.current = 0;
        kRef.current = (kRef.current + 1) % n;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paint, n, speed.fps]);

  const goFullscreen = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
    setChrome(false);
  };

  const loopSeconds = (n / speed.fps).toFixed(1);

  return (
    <div className="flex h-full flex-col" style={{ background: SHOW_GROUND }}>
      {chrome && (
        <div className="w-out flex flex-wrap items-center gap-2 p-2" style={{ background: "var(--face)" }}>
          <label className="flex items-center gap-1">
            <span>Message</span>
            <input
              className="w-in px-1 py-[2px]"
              style={{ background: "var(--field)", width: 260 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Message to transfer"
            />
          </label>


          <select className="w-in px-1 py-[2px]" value={speedId} onChange={(e) => setSpeedId(e.target.value as typeof speedId)} aria-label="Speed">
            {SPEEDS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.fps}/s)
              </option>
            ))}
          </select>

          <button className="w-out w-btn px-2 py-[2px]" onClick={goFullscreen}>
            Fullscreen
          </button>
          <button className="w-out w-btn px-2 py-[2px]" onClick={() => setChrome(false)}>
            Hide controls
          </button>

          <span className="w-etch px-2 py-[2px]">
            {n} char{n === 1 ? "" : "s"} · frame {frame + 1}/{Math.max(1, n)} · loop {loopSeconds}s
          </span>

          {n === 0 && <span className="w-etch px-2 py-[2px]">Nothing to send.</span>}
          {n > LONG_MESSAGE && (
            <span className="w-etch px-2 py-[2px]">
              Long message: a full loop is {loopSeconds}s of steady holding.
            </span>
          )}
          {clean.dropped > 0 && (
            <span className="w-etch px-2 py-[2px]">
              {clean.dropped} character{clean.dropped === 1 ? "" : "s"} dropped — the alphabet is A–Z, space, . , ?
            </span>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full" aria-label="Chromograph transfer display" />
        {!chrome && (
          <button
            className="w-out w-btn absolute left-2 top-2 px-2 py-[2px] opacity-40 hover:opacity-100"
            onClick={() => setChrome(true)}
          >
            Controls
          </button>
        )}
      </div>
    </div>
  );
}

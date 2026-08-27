"use client";

import { MAX_CHARS, STILL_RELIABLE_CHARS, type Sanitised } from "@/lib/grid";
import { PRESETS, type Preset } from "@/lib/palette";
import type { RenderParams, ViewMode } from "@/lib/render";

type Props = {
  text: string;
  setText: (v: string) => void;
  clean: Sanitised;
  params: RenderParams;
  setParams: (fn: (p: RenderParams) => RenderParams) => void;
  preset: Preset;
  setPresetId: (id: string) => void;
  onExportPNG: () => void;
  onExportSVG: () => void;
  onExportAnimation: () => void;
  onExportSheet: () => void;
  onExportGif: () => void;
  recording: boolean;
  onExportFourier: () => void;
  onCopyDesmos: () => void;
  equationNote: string | null;
};

export default function Sidebar(p: Props) {
  const set =
    <K extends keyof RenderParams>(key: K) =>
    (v: RenderParams[K]) =>
      p.setParams((prev) => ({ ...prev, [key]: v }));

  return (
    <aside className="flex w-[268px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--shadow)] p-2">
      <Group label="Message">
        <textarea
          value={p.text}
          onChange={(e) => p.setText(e.target.value)}
          rows={3}
          spellCheck={false}
          className="w-in w-full resize-none font-[Courier_New,monospace] text-[12px] uppercase"
        />
        <div className="flex justify-between">
          <span>A-Z SPACE . , ?</span>
          <span className="font-bold">
            {p.clean.text.length} / {MAX_CHARS}
          </span>
        </div>
        {p.clean.text.length > STILL_RELIABLE_CHARS && (
          <Notice>
            Past {STILL_RELIABLE_CHARS} characters a single still image is no longer dependable:
            hue alone has to carry the order. Save a sheet or WebM, which decode exactly.
          </Notice>
        )}
        {(p.clean.dropped > 0 || p.clean.truncated) && (
          <Notice>
            {p.clean.dropped > 0 && `${p.clean.dropped} unsupported character(s) removed. `}
            {p.clean.truncated && `Trimmed to ${MAX_CHARS}, the point where a sprite sheet stops being practical to decode.`}
          </Notice>
        )}
      </Group>

      <Group label="View">
        <div className="flex gap-[3px]">
          {(
            [
              ["iso", "Isometric"],
              ["flat", "Flat"],
            ] as [ViewMode, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => set("mode")(id)}
              data-pressed={p.params.mode === id}
              className="w-out w-btn flex-1"
            >
              {label}
            </button>
          ))}
        </div>
        {p.params.mode === "iso" && (
          <label className="flex items-start gap-1.5">
            <input type="checkbox" checked={p.params.stems} onChange={(e) => set("stems")(e.target.checked)} />
            <span>
              Stems
              <span className="block text-[var(--shadow)]">
                Drop lines from each knot to the base plane. Structure for the eye; the decode
                does not depend on them.
              </span>
            </span>
          </label>
        )}
      </Group>

      <Group label="Palette">
        <div className="grid grid-cols-2 gap-[3px]">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => p.setPresetId(preset.id)}
              data-pressed={preset.id === p.preset.id}
              className="w-out w-btn min-w-0 !px-1 text-left"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="h-[10px] w-[10px] border border-[var(--dark)]"
                  style={{ background: preset.bg }}
                />
                {preset.name}
              </span>
            </button>
          ))}
        </div>
        {!p.preset.decodable && <Notice>No hue: exports of this palette cannot be decoded.</Notice>}
      </Group>

      <Group label="Geometry">
        <Slider label="Tension" value={p.params.tension} min={0} max={1} step={0.01} onChange={set("tension")} />
        <Slider
          label="Thickness"
          value={p.params.thickness}
          min={1}
          max={20}
          step={0.5}
          onChange={set("thickness")}
          format={(v) => `${v} px`}
        />
        <Slider label="Grid" value={p.params.gridOpacity} min={0} max={1} step={0.01} onChange={set("gridOpacity")} />
        <label className="flex items-start gap-1.5">
          <input
            type="checkbox"
            checked={p.params.showBar}
            onChange={(e) => set("showBar")(e.target.checked)}
          />
          <span>
            Calibration bar
            <span className="block text-[var(--shadow)]">One swatch per character. The decoder reads length from it.</span>
          </span>
        </label>
      </Group>

      <Group label="Export">
        <div className="flex gap-[3px]">
          <button onClick={p.onExportPNG} className="w-out w-btn flex-1">
            Save PNG
          </button>
          <button onClick={p.onExportSVG} className="w-out w-btn flex-1">
            Save SVG
          </button>
        </div>
        <div className="flex gap-[3px]">
          <button onClick={p.onExportSheet} className="w-out w-btn flex-1 min-w-0">
            Sheet PNG
          </button>
          <button onClick={p.onExportGif} disabled={p.recording} className="w-out w-btn flex-1 min-w-0">
            {p.recording ? "Working..." : "GIF"}
          </button>
          <button onClick={p.onExportAnimation} disabled={p.recording} className="w-out w-btn flex-1 min-w-0">
            WebM
          </button>
        </div>
        <p className="text-[var(--shadow)]">
          Save PNG decodes by hue and is best effort. Sheet, GIF and WebM each carry one frame
          per character stamped with its own index, and decode exactly. The GIF is the rotating
          one and needs nothing from the browser; WebM needs a video encoder, which not every
          browser has.
        </p>
      </Group>

      <Group label="Equation">
        <div className="flex gap-[3px]">
          <button onClick={p.onExportFourier} className="w-out w-btn flex-1 min-w-0">
            Fourier
          </button>
          <button onClick={p.onCopyDesmos} className="w-out w-btn flex-1 min-w-0">
            Desmos
          </button>
        </div>
        <p className="text-[var(--shadow)]">
          The path as a truncated Fourier series; height is exactly linear in t, so it needs no
          fit. Desmos copies a paste-ready block.
        </p>
        {p.equationNote && <Notice>{p.equationNote}</Notice>}
      </Group>
    </aside>
  );
}

/** Win95 group box: etched hairline with the label notched into the top edge. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="w-etch px-2 pb-2 pt-1">
      <legend className="px-1 font-bold">{label}</legend>
      <div className="flex flex-col gap-1.5">{children}</div>
    </fieldset>
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

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-[Courier_New,monospace]">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

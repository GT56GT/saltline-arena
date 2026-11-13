import { useEffect, useState } from "react";
import { DEFAULTS, getSettings, onSettings, resetSettings, updateSettings, type Settings } from "../settings";

type Tab = "gameplay" | "graphics" | "audio";

/** Options menu: gameplay, graphics, audio. Changes apply immediately and are saved in this browser. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings>(getSettings());
  const [tab, setTab] = useState<Tab>("gameplay");
  useEffect(() => onSettings(setS), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const set = (p: Partial<Settings>) => updateSettings(p);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <header className="st-head">
          <h2>Settings</h2>
          <button className="btn ghost small" onClick={onClose}>Done</button>
        </header>
        <div className="st-body">
          <nav className="st-tabs">
            {(["gameplay", "graphics", "audio"] as Tab[]).map((t) => (
              <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>
            ))}
          </nav>
          <div className="st-rows">
            {tab === "gameplay" && (
              <>
                <Slider label="Mouse sensitivity" value={s.sens} min={0.2} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => set({ sens: v })} />
                <Toggle label="Invert look up / down" value={s.invertY} onChange={(v) => set({ invertY: v })} />
                <Choice label="Enemy names" value={s.names} options={[["aim", "Under crosshair"], ["always", "Always"]]} onChange={(v) => set({ names: v })}
                  hint="Teammates' names always show. Showing enemy names only when you aim at them keeps the screen clean." />
              </>
            )}
            {tab === "graphics" && (
              <>
                <Slider label="Field of view" value={s.fov} min={60} max={100} step={1} fmt={(v) => `${Math.round(v)}°`} onChange={(v) => set({ fov: v })} />
                <Choice label="Quality" value={s.quality} options={[["auto", "Auto"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]]} onChange={(v) => set({ quality: v })}
                  hint="Auto picks a level from your device when the match loads. Lower it if the game stutters." />
              </>
            )}
            {tab === "audio" && (
              <>
                <Slider label="Master volume" value={s.master} min={0} max={1} step={0.01} fmt={pct} onChange={(v) => set({ master: v })} />
                <Slider label="Effects (guns, footsteps)" value={s.effects} min={0} max={1} step={0.01} fmt={pct} onChange={(v) => set({ effects: v })} />
                <Slider label="Other players' footsteps" value={s.footsteps} min={0} max={1.5} step={0.01} fmt={pct} onChange={(v) => set({ footsteps: v })}
                  hint="Steps, jumps, landings and climbs. Above 100% makes them stand out more." />
                <Choice label="Teammate footsteps" value={s.teamSteps} options={[["normal", "Normal"], ["quiet", "Quiet"], ["off", "Off"]]} onChange={(v) => set({ teamSteps: v })}
                  hint="Quiet keeps enemies easy to pick out. Applies in team matches." />
                <Toggle label="Show my noise level" value={s.noise} onChange={(v) => set({ noise: v })} />
                <Slider label="Ambience (sea, rain, wind)" value={s.ambience} min={0} max={1} step={0.01} fmt={pct} onChange={(v) => set({ ambience: v })} />
                <Slider label="Music in matches" value={s.music} min={0} max={1} step={0.01} fmt={(v) => (v === 0 ? "Off" : pct(v))} onChange={(v) => set({ music: v })}
                  hint="Off by default so you can hear footsteps." />
              </>
            )}
          </div>
        </div>
        <footer className="st-foot">
          <button className="btn link" onClick={() => resetSettings()} disabled={JSON.stringify(s) === JSON.stringify(DEFAULTS)}>Reset to defaults</button>
          <span>Saved on this device</span>
        </footer>
      </div>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Slider({ label, value, min, max, step, fmt, onChange, hint }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void; hint?: string }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="st-row">
      <span className="st-label">{label}{hint && <small>{hint}</small>}</span>
      <span className="st-ctl">
        <input type="range" min={min} max={max} step={step} value={value} style={{ ["--fill" as string]: `${fill}%` }} onChange={(e) => onChange(+e.target.value)} />
        <output>{fmt(value)}</output>
      </span>
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="st-row">
      <span className="st-label">{label}</span>
      <span className="st-ctl seg">
        <button aria-pressed={!value} onClick={() => onChange(false)}>Off</button>
        <button aria-pressed={value} onClick={() => onChange(true)}>On</button>
      </span>
    </div>
  );
}

function Choice<T extends string>({ label, value, options, onChange, hint }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; hint?: string }) {
  return (
    <div className="st-row">
      <span className="st-label">{label}{hint && <small>{hint}</small>}</span>
      <span className="st-ctl seg">
        {options.map(([v, l]) => <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}
      </span>
    </div>
  );
}

// Player settings, saved in this browser. The renderer bridge applies them live to the original
// game (sensitivity, invert, FOV, quality, audio channels); the menus edit them.

export type Quality = "auto" | "low" | "medium" | "high";
export type NameMode = "aim" | "always";

export interface Settings {
  sens: number; // 0.2 .. 3
  invertY: boolean;
  fov: number; // 60 .. 100
  quality: Quality;
  master: number; // 0 .. 1
  effects: number;
  ambience: number;
  music: number; // in matches; 0 = off
  names: NameMode; // enemy names: under the crosshair only, or always
}

export const DEFAULTS: Settings = {
  sens: 1,
  invertY: false,
  fov: 74,
  quality: "auto",
  master: 0.85,
  effects: 1,
  ambience: 0.7,
  music: 0,
  names: "aim",
};

const KEY = "arena.settings.v1";
const listeners = new Set<(s: Settings) => void>();

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    const s = { ...DEFAULTS, ...raw } as Settings;
    s.sens = clamp(+s.sens, 0.2, 3, DEFAULTS.sens);
    s.fov = clamp(+s.fov, 60, 100, DEFAULTS.fov);
    for (const k of ["master", "effects", "ambience", "music"] as const) s[k] = clamp(+s[k], 0, 1, DEFAULTS[k]);
    if (!["auto", "low", "medium", "high"].includes(s.quality)) s.quality = "auto";
    if (s.names !== "always") s.names = "aim";
    s.invertY = !!s.invertY;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function clamp(v: number, lo: number, hi: number, d: number) {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}

let current = load();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: settings last for this visit */
  }
  for (const f of listeners) f(current);
}

export function resetSettings() {
  updateSettings({ ...DEFAULTS });
}

export function onSettings(f: (s: Settings) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

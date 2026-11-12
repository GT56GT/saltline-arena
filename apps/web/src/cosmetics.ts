// Mirrors server/server/src/cosmetics.rs. Visual only: colours of visor and armour plates.
export const COSMETICS: Record<string, { slot: "visor" | "plates"; color: string; name: string }> = {
  "founders-visor": { slot: "visor", color: "#ffb347", name: "Founders Visor" },
  "harbour-teal": { slot: "plates", color: "#2f8f8a", name: "Harbour Teal Plates" },
  "rust-red": { slot: "plates", color: "#a8432a", name: "Rust Red Plates" },
  "signal-gold": { slot: "visor", color: "#ffd36a", name: "Signal Gold Visor" },
  "chrome-visor": { slot: "visor", color: "#d9e3ea", name: "Chrome Visor" },
  "night-shift": { slot: "plates", color: "#c8e63c", name: "Night-Shift Hi-Vis" },
};

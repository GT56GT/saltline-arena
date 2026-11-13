// Recorded sound effects (made in Adobe Firefly, processed by audio-tools/process.py) in place of the
// original game's synthesized ones. public/audio/manifest.json lists each sound and how many
// versions it has; files are public/audio/<name>_<i>.wav. Anything that fails to load simply keeps
// its synthesized sound, so a missing or broken file never silences the game.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SoundLoad { loaded: string[]; failed: string[] }

export async function loadRecordedSounds(G: any, base = "/audio/"): Promise<SoundLoad> {
  const res: SoundLoad = { loaded: [], failed: [] };
  const A = G.audio;
  if (!A || !A.ctx || !A.setBuffers) return res;
  let manifest: Record<string, number>;
  try {
    const r = await fetch(base + "manifest.json", { cache: "no-cache" });
    if (!r.ok) return res;
    manifest = await r.json();
  } catch {
    return res;
  }
  await Promise.all(
    Object.entries(manifest).map(async ([name, count]) => {
      try {
        const bufs = await Promise.all(
          Array.from({ length: count }, async (_, i) => {
            const r = await fetch(`${base}${name}_${i}.wav`);
            if (!r.ok) throw new Error(`${name}_${i}: ${r.status}`);
            return A.ctx.decodeAudioData(await r.arrayBuffer());
          }),
        );
        if (A.setBuffers(name, bufs)) res.loaded.push(name);
        else res.failed.push(name);
      } catch (e) {
        console.warn("[arena] recorded sound unavailable, keeping the synthesized one:", name, e);
        res.failed.push(name);
      }
    }),
  );
  return res;
}

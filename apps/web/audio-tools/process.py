"""Turn raw Firefly takes into game-ready one-shots for Saltline Arena.

For each sound: mono, a 35 Hz high-pass (removes the sub-bass swell and DC drift some takes have),
cut to the useful part, short fades so nothing clicks, then levelled so every version of a sound is
equally loud in its first 80 ms (what you hear in rapid fire) with the peak at the level the game's
mix was designed for (the `peak` of the original synthesized sound). 16-bit mono WAV, 48 kHz.

Usage: python3 process.py <raw folder> <out folder>
"""
import sys, os, json
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

RAW, OUT = sys.argv[1], sys.argv[2]
SR = 48000
HP = butter(2, 35, "highpass", fs=SR, output="sos")

def load(rel):
    sr, x = wavfile.read(os.path.join(RAW, rel))
    assert sr == SR, (rel, sr)
    x = x.astype(np.float32) / 32768.0
    if x.ndim == 2:
        x = x.mean(1)
    return sosfilt(HP, x).astype(np.float32)

def first_hit(x, frac=0.05, after=0):
    a = np.abs(x[after:])
    return after + int(np.argmax(a > frac * a.max()))

def cut(x, start, length, fade_out, fade_in=0.002):
    seg = x[max(0, start):max(0, start) + int(length * SR)].copy()
    n_in = max(1, int(fade_in * SR))
    seg[:n_in] *= np.sin(np.linspace(0, np.pi / 2, n_in)) ** 2
    n_out = int(fade_out * SR)
    if n_out:
        seg[-n_out:] *= np.cos(np.linspace(0, np.pi / 2, n_out)) ** 2
    return seg

def ms(t):
    return int(t * SR / 1000)

def soft_limit(x, cap):
    """Leave everything below 80% of `cap` alone; round off what is above so nothing passes `cap`."""
    knee = 0.8 * cap
    y = x.copy()
    over = np.abs(x) > knee
    y[over] = np.sign(x[over]) * (knee + (cap - knee) * np.tanh((np.abs(x[over]) - knee) / (cap - knee)))
    return y

def level(takes, peak, rms80=None):
    """Same loudness over the first 80 ms for every take. With `rms80`, match that loudness (the
    synthesized sound being replaced) and soft-limit peaks to `peak`; without, the loudest level at
    which no take passes `peak`."""
    rms = [np.sqrt(np.mean(t[:ms(80)] ** 2)) for t in takes]
    if rms80 is None:
        target = min(r * peak / np.abs(t).max() for r, t in zip(rms, takes))
        return [t * (target / r) for t, r in zip(takes, rms)]
    return [soft_limit(t * (rms80 / r), peak) for t, r in zip(takes, rms)]

P = {
    "shot": "1 prompt/Firefly_audio_Single_assault_rifle_gunshot,_5.56_mm,_close_first_variation{}.wav",
    "shot2": "2 prompt/Firefly_audio_Single_assault_rifle_gunshot,_5.56_mm,_close_first_variation{}-2.wav",
    "shed": "3 prompt/Firefly_audio_Gunshot_echo_tail_only,_short_boomy_metallic_rever_variation{}.wav",
    "dry": "4 prompt/Firefly_audio_Empty_rifle_dry_fire,_single_trigger_click_with_a__variation{}.wav",
    "mag": "5 prompt/Firefly_audio_Assault_rifle_magazine_release_button_and_magazine_variation{}.wav",
}
out = {}

# rifle_shot: four clean single shots (prompt 1 takes 3, 4; prompt 2 takes 4, 1 cut before its slap).
shots = []
for rel, length, fade in [(P["shot"].format(3), 0.45, 0.15), (P["shot"].format(4), 0.45, 0.15), (P["shot2"].format(4), 0.45, 0.15), (P["shot2"].format(1), 0.32, 0.10)]:
    x = load(rel)
    s = first_hit(x) - ms(1)
    shots.append(cut(x, s, length, fade))
out["rifle_shot"] = level(shots, 0.97, rms80=0.24)  # measured: synthesized shot 0.23-0.25

# rifle_tail_in: the shed reverb, attack softened (the shot itself is already playing).
tails = []
for v in (2, 4):
    x = load(P["shed"].format(v))
    tails.append(cut(x, first_hit(x) - ms(1), 0.9, 0.4, fade_in=0.025))
out["rifle_tail_in"] = level(tails, 0.62, rms80=0.13)  # measured: 0.125-0.134

# rifle_dry: the first click only (the takes have a stray second click near 0.9 s).
dry = []
for v in (4, 2):
    x = load(P["dry"].format(v))
    dry.append(cut(x, first_hit(x) - ms(1), 0.15, 0.07))
out["rifle_dry"] = level(dry, 0.5, rms80=0.041)  # measured: 0.041

# reload_magout: release-button click spliced straight onto the magazine pull (the raw takes wait
# ~0.75 s between them, which would land late against the reload animation).
mags = []
for v in (3, 2):
    x = load(P["mag"].format(v))
    c0 = first_hit(x, 0.05)
    click = cut(x, c0 - ms(1), 0.10, 0.03)
    big = first_hit(x, 0.3, after=ms(600))
    pull = cut(x, big - ms(25), 0.29, 0.11, fade_in=0.02)
    # overlap the click's tail with the pull's lead-in: no dead digital silence between them
    joined = np.zeros(ms(80) + len(pull), np.float32)
    joined[:len(click)] += click
    joined[ms(80):] += pull
    mags.append(joined)
out["reload_magout"] = level(mags, 0.6)

os.makedirs(OUT, exist_ok=True)
manifest = {}
for name, takes in out.items():
    manifest[name] = len(takes)
    for i, t in enumerate(takes):
        y = np.clip(t, -1, 1)
        wavfile.write(os.path.join(OUT, f"{name}_{i}.wav"), SR, (y * 32767).astype(np.int16))
        print(f"{name}_{i}.wav  {len(t)/SR:.2f}s  peak {np.abs(t).max():.2f}  rms80 {np.sqrt(np.mean(t[:ms(80)]**2)):.3f}")
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"))
print(manifest)

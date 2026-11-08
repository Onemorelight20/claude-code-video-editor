#!/usr/bin/env python3
"""Per-clip quality metrics from proxies (numpy only) -> <episode>/analysis.json

Usage: python3 tools/analyze.py episodes/<name>
Sampled at RATE fps, for every sample:
  sharp  - variance of Laplacian (focus / motion blur), higher = sharper
  shake  - global camera shift vs previous sample (px @ 90px width), via phase correlation
  motion - mean abs difference after removing global shift (action inside the frame)
  luma   - mean brightness 0..255
Used by the web UI (quality graph under each clip) and for picking clean 1s windows.
"""
import json, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np

RATE = 10
W, H = 90, 160  # analysis size (portrait); landscape clips are analysed as H x W


def frames(proxy: Path, w: int, h: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(proxy), "-vf",
                          f"fps={RATE},scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)


def shift(a, b, win):
    fa, fb = np.fft.fft2(a * win), np.fft.fft2(b * win)
    r = fa * np.conj(fb)
    r /= np.abs(r) + 1e-6
    c = np.fft.ifft2(r).real
    y, x = np.unravel_index(np.argmax(c), c.shape)
    if y > c.shape[0] // 2: y -= c.shape[0]
    if x > c.shape[1] // 2: x -= c.shape[1]
    return int(y), int(x)


def analyse(clip, ep: Path):
    w, h = (W, H) if clip["height"] >= clip["width"] else (H, W)
    f = frames(ep / "proxies" / f'{clip["id"]}.mp4', w * 2, h * 2)   # 180x320 for sharpness
    lap = (-4 * f[:, 1:-1, 1:-1] + f[:, :-2, 1:-1] + f[:, 2:, 1:-1] + f[:, 1:-1, :-2] + f[:, 1:-1, 2:])
    sharp = lap.reshape(len(f), -1).var(axis=1)
    small = f.reshape(len(f), h, 2, w, 2).mean(axis=(2, 4))
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    shake, motion = [0.0], [0.0]
    for i in range(1, len(small)):
        dy, dx = shift(small[i], small[i - 1], win)
        shake.append(float(np.hypot(dy, dx)))
        aligned = np.roll(small[i - 1], (dy, dx), axis=(0, 1))
        m = 6  # ignore borders wrapped by roll
        motion.append(float(np.abs(small[i] - aligned)[m:-m, m:-m].mean()))
    r = lambda a: [round(float(x), 1) for x in a]
    return clip["id"], {"rate": RATE, "sharp": r(sharp), "shake": r(shake), "motion": r(motion),
                        "luma": r(small.mean(axis=(1, 2)))}


def main():
    ep = Path(sys.argv[1]).resolve()
    clips = json.loads((ep / "sources.json").read_text())["clips"]
    with ThreadPoolExecutor(max_workers=6) as pool:
        res = dict(pool.map(lambda c: analyse(c, ep), clips))
    (ep / "analysis.json").write_text(json.dumps(res, separators=(",", ":")))
    for cid, a in res.items():
        s = np.array(a["sharp"]); k = np.array(a["shake"])
        print(f"{cid}: sharp med {np.median(s):6.1f}  shake med {np.median(k):4.1f}  max {k.max():4.1f}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Where the camera itself moves (not the hands): jumps inside a shot, drift over a long clip.

  python3 tools/camera.py episodes/<ep> jumps IMG_0123 2.5 6.5   -> frame-to-frame shifts (30 fps)
  python3 tools/camera.py episodes/<ep> drift IMG_0456 0 135     -> moves between 0.5 s samples (for timelapses)

Phase correlation of the whole frame (180x320 grey, Hann window) gives the global shift between two frames.
Hands moving over a static background do not shift the whole frame, a camera bump or pan does.
A "jump" of 3+ px per frame (of 320) for several frames is a visible bump: cut the shot after it.
A timelapse needs a static camera: in `drift`, 6+ px between samples means the camera moved.
"""
import subprocess, sys
from pathlib import Path
import numpy as np

W, H = 180, 320
WIN = np.outer(np.hanning(H), np.hanning(W))


def frames(ep: Path, clip, t0, t1, fps):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t0}", "-t", f"{t1 - t0}", "-i", str(ep / "proxies" / f"{clip}.mp4"),
                          "-vf", f"fps={fps},scale={W}:{H},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)


def shift(a, b):
    """Global shift (dx, dy) in px of 180x320 and the correlation peak (low peak = unreliable)."""
    A = np.fft.fft2((a - a.mean()) * WIN)
    B = np.fft.fft2((b - b.mean()) * WIN)
    r = A * np.conj(B)
    r /= np.abs(r) + 1e-9
    c = np.fft.ifft2(r).real
    ky, kx = np.unravel_index(np.argmax(c), c.shape)
    return (kx if kx < W // 2 else kx - W), (ky if ky < H // 2 else ky - H), float(c.max())


def main():
    ep, mode, clip = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    t0, t1 = float(sys.argv[4]), float(sys.argv[5])
    fps, limit = (30, 2) if mode == "jumps" else (2, 6)
    f = frames(ep, clip, t0, t1, fps)
    moves = []
    for i in range(1, len(f)):
        dx, dy, p = shift(f[i - 1], f[i])
        if (dx * dx + dy * dy) ** 0.5 >= limit and p > 0.05:
            moves.append((t0 + i / fps, dx, dy, p))
    print(f"{clip} {t0:.2f}-{t1:.2f} s, {mode}: {len(moves)} camera moves (>= {limit} px of {H} per {1 / fps:.2f} s)")
    for t, dx, dy, p in moves:
        print(f"  {t:7.2f} s  dx {dx:+3d}  dy {dy:+3d}  (peak {p:.2f})")


if __name__ == "__main__":
    main()

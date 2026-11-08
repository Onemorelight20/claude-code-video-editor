#!/usr/bin/env python3
"""Make lightweight H.264 proxies + filmstrips for the web UI.

Usage: python3 tools/proxies.py episodes/<name> [--force]
  proxies/<id>.mp4   short side 360px, keyframe every 0.5s (fast scrubbing in browser)
  strips/<id>.jpg    filmstrip: 1 frame per STRIP_STEP seconds, 72px wide each
Final renders always use the original 4K sources, proxies are only for preview.
"""
import json, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STRIP_STEP = 1.0   # seconds between filmstrip frames
STRIP_W = 72       # px width of one filmstrip frame (portrait -> 128px high)


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def make(ep: Path, clip: dict, force: bool):
    src = ep / clip["path"]
    proxy = ep / "proxies" / f'{clip["id"]}.mp4'
    strip = ep / "strips" / f'{clip["id"]}.jpg'
    portrait = clip["height"] >= clip["width"]
    if force or not proxy.exists():
        scale = "scale=360:-2" if portrait else "scale=-2:360"
        run(["ffmpeg", "-y", "-v", "error", "-hwaccel", "videotoolbox", "-i", str(src),
             "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
             "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", str(proxy)])
    if force or not strip.exists():
        # exactly n frames: frame k shows t = k*STRIP_STEP (the last one is clamped to the clip end)
        n = max(1, int(clip["duration"] // STRIP_STEP) + 1)
        fps = clip["fps"] or 30
        last = max(0, int(clip["duration"] * fps) - 2)
        idx = sorted({min(round(k * STRIP_STEP * fps), last) for k in range(n)})
        idx += [idx[-1]] * (n - len(idx))
        sel = "+".join(f"eq(n,{i})" for i in sorted(set(idx)))
        run(["ffmpeg", "-y", "-v", "error", "-i", str(proxy),
             "-vf", f"select='{sel}',scale={STRIP_W}:-2,tile={n}x1",
             "-fps_mode", "passthrough", "-frames:v", "1", "-q:v", "5", str(strip)])
    return clip["id"]


def main():
    ep = Path(sys.argv[1]).resolve()
    force = "--force" in sys.argv
    (ep / "proxies").mkdir(exist_ok=True)
    (ep / "strips").mkdir(exist_ok=True)
    clips = json.loads((ep / "sources.json").read_text())["clips"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for i, cid in enumerate(pool.map(lambda c: make(ep, c, force), clips), 1):
            print(f"[{i}/{len(clips)}] {cid}", flush=True)


if __name__ == "__main__":
    main()

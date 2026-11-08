#!/usr/bin/env python3
"""Find "still points" between movements, to cut on completed actions (knife stroke, stir, pour).

  python3 tools/actions.py episodes/<ep> <seg_id|clip> [t0 t1]      -> motion curve + still points
  python3 tools/actions.py episodes/<ep> --all                       -> every segment of edl.json, ±0.8 s around it

Motion energy = mean abs difference of consecutive frames (30 fps, inside the segment's crop, 72x128 grey),
smoothed over 3 frames. A still point is a local minimum: the hand / knife has finished a movement.
Cutting from one still point to another keeps whole movements inside a shot, and when the next shot
also starts at a still point the rhythm of the action continues across the cut.
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from light import crop_px  # noqa: E402


def energy(ep: Path, clip, seg, t0, t1):
    pw, ph = (360, 640) if clip["height"] >= clip["width"] else (640, 360)
    cw, ch, x, y = crop_px(clip, seg, pw, ph)
    fps = 30
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0, t0):.3f}", "-t", f"{t1 - max(0, t0):.3f}",
                          "-i", str(ep / "proxies" / f'{clip["id"]}.mp4'),
                          "-vf", f"fps={fps},crop={cw}:{ch}:{x}:{y},scale=72:128,format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    f = np.frombuffer(raw, np.uint8).reshape(-1, 128, 72).astype(np.float32)
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    d = np.convolve(np.pad(d, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    times = max(0, t0) + (np.arange(len(d)) + 1) / fps   # d[i] = change into frame i+1
    return times, d


def still_points(times, d, min_drop=0.25):
    """Local minima that are clearly lower than the movement around them."""
    out = []
    for i in range(2, len(d) - 2):
        if d[i] <= d[i - 1] and d[i] <= d[i + 1] and d[i] <= d[i - 2] and d[i] <= d[i + 2]:
            lo, hi = max(0, i - 12), min(len(d), i + 13)
            peak = max(d[lo:i].max(initial=0), d[i + 1:hi].max(initial=0))
            if peak > 0 and (peak - d[i]) / peak >= min_drop:
                out.append((round(float(times[i]), 3), round(float(d[i]), 2), round(float(peak), 2)))
    return out


def show(ep, clip, seg, t0, t1, label=""):
    times, d = energy(ep, clip, seg, t0, t1)
    pts = still_points(times, d)
    top = max(d.max(), 1e-6)
    print(f"{label}{clip['id']} {t0:.2f}-{t1:.2f}s  (segment {seg.get('in', t0):.2f}-{seg.get('out', t1):.2f})")
    bars = " ▁▂▃▄▅▆▇█"
    line = "".join(bars[min(8, int(v / top * 8.999))] for v in d)
    ticks = "".join("|" if abs((t * 10) % 5) < 0.34 or abs((t * 10) % 5 - 5) < 0.34 else " " for t in times)
    for k in range(0, len(line), 90):
        print(f"  {times[k]:6.2f} {line[k:k + 90]}")
        print(f"         {ticks[k:k + 90]}")
    print("  still points:", ", ".join(f"{t:.2f}" for t, _, _ in pts) or "—")
    return pts


def main():
    ep = Path(sys.argv[1]).resolve()
    clips = {c["id"]: c for c in json.loads((ep / "sources.json").read_text())["clips"]}
    edl = json.loads((ep / "edl.json").read_text())
    segs = {s["id"]: s for s in edl["segments"]}
    if sys.argv[2] == "--all":
        for i, s in enumerate(edl["segments"], 1):
            c = clips[s["clip"]]
            show(ep, c, s, max(0, s["in"] - 0.8), min(c["duration"], s["out"] + 0.8), f"#{i} {s['id']} {s['note']}: ")
        return
    key = sys.argv[2]
    seg = segs.get(key) or {"clip": key, "zoom": 1, "x": 0.5, "y": 0.5}
    c = clips[seg["clip"]]
    t0 = float(sys.argv[3]) if len(sys.argv) > 3 else max(0, seg.get("in", 0) - 0.8)
    t1 = float(sys.argv[4]) if len(sys.argv) > 4 else min(c["duration"], seg.get("out", c["duration"]) + 0.8)
    show(ep, c, seg, t0, t1)


if __name__ == "__main__":
    main()

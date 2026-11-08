#!/usr/bin/env python3
"""Contact sheet of one clip (for reviewing footage frame by frame).

Usage: python3 tools/sheet.py episodes/<name> IMG_0123 [t0] [t1] [step] [cols] [-o out.png]
Frame (row r, col c) is at time t0 + (r*cols + c)*step seconds. ffmpeg here has no drawtext,
so sheets are unlabeled: use that formula to map a frame back to a timestamp.
"""
import json, math, subprocess, sys
from pathlib import Path

args = [a for a in sys.argv[1:]]
out = None
if "-o" in args:
    i = args.index("-o"); out = args[i + 1]; del args[i:i + 2]
ep, cid = Path(args[0]).resolve(), args[1]
clip = next(c for c in json.loads((ep / "sources.json").read_text())["clips"] if c["id"] == cid)
t0 = float(args[2]) if len(args) > 2 else 0.0
t1 = float(args[3]) if len(args) > 3 else clip["duration"]
step = float(args[4]) if len(args) > 4 else 0.5
cols = int(args[5]) if len(args) > 5 else 10
n = max(1, int(math.floor((min(t1, clip["duration"] - 0.01) - t0) / step)) + 1)
rows = math.ceil(n / cols)
out = out or f"/tmp/sheet_{cid}_{t0:g}-{t1:g}.png"
# select frames by timestamp: one frame at each t0 + k*step
sel = "+".join(f"eq(n,{round((t0 + k * step) * clip['fps'])})" for k in range(n))
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(ep / "proxies" / f"{cid}.mp4"),
                "-vf", f"select='{sel}',scale=120:213:force_original_aspect_ratio=decrease,"
                       f"pad=120:213:(ow-iw)/2:(oh-ih)/2,tile={cols}x{rows}:padding=2:color=white",
                "-fps_mode", "passthrough", "-frames:v", "1", out], check=True)
print(f"{out}: {n} frames, t = {t0:g} + k*{step:g}s, {cols} per row")

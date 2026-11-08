#!/usr/bin/env python3
"""Per-segment light: auto balance between shots + manual tweaks from the review UI.

  python3 tools/light.py episodes/<ep>                 -> refresh auto values in grades.json, print table
  python3 tools/light.py episodes/<ep> --sheet x.png   -> before / after sheet (middle frame of every segment)

grades.json (written by this tool and by the UI, read by render.py):
  {"target": 0.43, "segments": {"s02": {"clip": "IMG_0123", "brightness": 0.1, "contrast": 0, "temp": 0,
                                        "auto": 0.1, "key": 0.39, "source": "auto" | "user"}}}
  source "auto": brightness follows the auto balance (recomputed when the segment changes);
  source "user": values were set in the UI and are kept as they are.

Grade maths, the same in web/app.js gradeColor() (live preview) and here (LUT for lut3d):
  temp       white balance shift that keeps luma (effects.temperature, strength 0.5 per unit)
  brightness midtone gamma: v ** 2**(-b), black and white points stay put (no clipping, no grey whites)
  contrast   S-curve around mid grey (effects.s_curve, strength 0.3 per unit)
Ranges in the UI: brightness ±0.8, contrast ±0.5, temp ±1.
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import effects as fx  # noqa: E402

AUTO_STRENGTH = 0.6   # share of the gap to the target that the auto balance closes
AUTO_LIMIT = 0.45     # max |brightness| set automatically
SAMPLES = 5           # frames measured per segment
KEYS = ("brightness", "contrast", "temp")


# ---------------------------------------------------------------- maths
def grade_rgb(c, brightness=0.0, contrast=0.0, temp=0.0):
    c = np.clip(c, 0, 1)
    if temp:
        c = np.clip(fx.temperature(c, 0.5 * temp), 0, 1)
    if brightness:
        c = c ** (2.0 ** (-brightness))
    if contrast:
        c = fx.s_curve(c, 0.3 * contrast)
    return np.clip(c, 0, 1)


def is_identity(g):
    return not g or all(abs(float(g.get(k, 0) or 0)) < 1e-3 for k in KEYS)


def grade_values(g):
    return {k: round(float((g or {}).get(k, 0) or 0), 3) for k in KEYS}


def write_grade_cube(g, path: Path):
    grid = fx.lut_grid()
    fx.write_cube(grade_rgb(grid, **grade_values(g)), path)


# ---------------------------------------------------------------- measuring
def crop_px(clip, seg, w, h):
    """Crop window of a segment in proxy pixels (same maths as render.crop_box)."""
    sw, sh = clip["width"], clip["height"]
    target = 9 / 16
    base_w = min(sw, sh * target)
    z = max(1.0, float(seg.get("zoom", 1)))
    cw, ch = base_w / z, base_w / z / target
    cx, cy = float(seg.get("x", 0.5)) * sw, float(seg.get("y", 0.5)) * sh
    x = min(max(cx - cw / 2, 0), sw - cw)
    y = min(max(cy - ch / 2, 0), sh - ch)
    k = w / sw
    return int(cw * k) // 2 * 2, int(ch * k) // 2 * 2, int(x * k) // 2 * 2, int(y * k) // 2 * 2


def measure(ep: Path, clip, seg):
    """Luma statistics (encoded Y', 0..1) of the cropped frames of a segment."""
    proxy = ep / "proxies" / f'{clip["id"]}.mp4'
    pw = 360 if clip["height"] >= clip["width"] else 640
    ph = 640 if clip["height"] >= clip["width"] else 360
    cw, ch, x, y = crop_px(clip, seg, pw, ph)
    vals = []
    for i in range(SAMPLES):
        t = seg["in"] + (seg["out"] - seg["in"]) * (i + 0.5) / SAMPLES
        raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(proxy), "-frames:v", "1",
                              "-vf", f"crop={cw}:{ch}:{x}:{y},scale=72:128,format=gray", "-f", "rawvideo", "-"],
                             capture_output=True, check=True).stdout
        if raw:
            vals.append(np.frombuffer(raw, np.uint8).astype(np.float32))
    y_ = (np.concatenate(vals) - 16) / 219  # limited range -> 0..1
    y_ = np.clip(y_, 0, 1)
    return {"p50": float(np.percentile(y_, 50)), "p80": float(np.percentile(y_, 80)), "mean": float(y_.mean())}


def key_of(stats):
    """Brightness of the lit subject: between median and the bright part (robust to black pans / white plates)."""
    return 0.5 * stats["p50"] + 0.5 * stats["p80"]


def auto_brightness(key, target):
    """Gamma that moves the key AUTO_STRENGTH of the way to the target, as brightness = -log2(gamma)."""
    key = min(max(key, 0.03), 0.97)
    goal = key + AUTO_STRENGTH * (target - key)
    g = np.log(goal) / np.log(key)
    return float(np.clip(-np.log2(g), -AUTO_LIMIT, AUTO_LIMIT))


# ---------------------------------------------------------------- grades.json
def load_grades(ep: Path):
    p = ep / "grades.json"
    return json.loads(p.read_text()) if p.exists() else {"target": None, "segments": {}}


def save_grades(ep: Path, data):
    p = ep / "grades.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    tmp.replace(p)


def refresh(ep: Path, edl=None, force=False):
    """Make sure every active segment has a grade; recompute auto values where the shot changed.
    Returns {seg_id: grade}. Manual values ("user") are never overwritten."""
    if edl is None:
        edl = json.loads((ep / "edl.json").read_text())
    clips = {c["id"]: c for c in json.loads((ep / "sources.json").read_text())["clips"]}
    data = load_grades(ep)
    gs = data.setdefault("segments", {})
    segs = [s for s in edl["segments"] if not s.get("disabled")]
    sig = lambda s: [s["clip"], round(s["in"], 3), round(s["out"], 3), s.get("zoom", 1), s.get("x", .5), s.get("y", .5)]
    changed = False
    for s in segs:
        g = gs.get(s["id"])
        if force or not g or g.get("sig") != sig(s):
            stats = measure(ep, clips[s["clip"]], s)
            new = {"sig": sig(s), "clip": s["clip"], "key": round(key_of(stats), 4)}
            if g and g.get("source") == "user" and g.get("clip") == s["clip"]:
                new.update({k: g.get(k, 0) for k in KEYS}, source="user")   # keep manual tweak of the same shot
            else:
                new.update(brightness=0, contrast=0, temp=0, source="auto")
            gs[s["id"]] = new
            changed = True
    keys = [gs[s["id"]]["key"] for s in segs]
    target = round(float(np.median(keys)), 4) if keys else 0.45
    if target != data.get("target"):
        data["target"] = target
        changed = True
    for s in segs:
        g = gs[s["id"]]
        a = round(auto_brightness(g["key"], target), 3)
        if g.get("auto") != a:
            g["auto"] = a
            changed = True
        if g.get("source", "auto") == "auto" and g.get("brightness") != a:
            g["brightness"] = a
            changed = True
    if changed:
        save_grades(ep, data)
    return {s["id"]: gs[s["id"]] for s in segs}


def sheet(ep: Path, dst: Path):
    """Two rows per 11 segments: original middle frame above, graded below."""
    edl = json.loads((ep / "edl.json").read_text())
    clips = {c["id"]: c for c in json.loads((ep / "sources.json").read_text())["clips"]}
    grades = refresh(ep, edl)
    segs = [s for s in edl["segments"] if not s.get("disabled")]
    tmp = ep / "cache" / "lightsheet"
    tmp.mkdir(parents=True, exist_ok=True)
    for f in tmp.glob("*.png"):
        f.unlink()
    for i, s in enumerate(segs):
        c = clips[s["clip"]]
        pw, ph = (360, 640) if c["height"] >= c["width"] else (640, 360)
        cw, ch, x, y = crop_px(c, s, pw, ph)
        t = (s["in"] + s["out"]) / 2
        base = tmp / f"b{i:03d}.png"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(ep / "proxies" / f'{c["id"]}.mp4'),
                        "-frames:v", "1", "-vf", f"crop={cw}:{ch}:{x}:{y},scale=108:192", str(base)], check=True)
        g = grades[s["id"]]
        out = tmp / f"g{i:03d}.png"
        if is_identity(g):
            out.write_bytes(base.read_bytes())
        else:
            cube = tmp / f"g{i:03d}.cube"
            write_grade_cube(g, cube)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(base), "-vf", f"lut3d=file='{cube}'", str(out)], check=True)
    n, per = len(segs), 11
    rows = []
    for r in range(0, n, per):
        idx = list(range(r, min(n, r + per)))
        for kind in ("b", "g"):
            row = tmp / f"row_{kind}{r:03d}.png"
            inputs = sum((["-i", str(tmp / f"{kind}{i:03d}.png")] for i in idx), [])
            pad = per - len(idx)
            flt = f"hstack=inputs={len(idx)}" if len(idx) > 1 else "null"
            if pad:
                flt += f",pad=iw+{pad * 108}:ih:0:0:white"
            flt += ",pad=iw:ih+4:0:0:white" if kind == "b" else ",pad=iw:ih+14:0:0:red"
            subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", flt, str(row)], check=True)
            rows.append(row)
    inputs = sum((["-i", str(rw)] for rw in rows), [])
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", f"vstack=inputs={len(rows)}", str(dst)],
                   check=True)
    print(f"{dst}: pairs of rows = original / balanced, {per} segments per pair")


def main():
    ep = Path(sys.argv[1]).resolve()
    if "--sheet" in sys.argv:
        sheet(ep, Path(sys.argv[sys.argv.index("--sheet") + 1]))
        return
    grades = refresh(ep, force="--force" in sys.argv)
    edl = json.loads((ep / "edl.json").read_text())
    target = load_grades(ep)["target"]
    print(f"target key {target}")
    for i, s in enumerate([s for s in edl["segments"] if not s.get("disabled")], 1):
        g = grades[s["id"]]
        print(f"#{i:2d} {s['id']:4s} {s['clip']} key {g['key']:.3f}  auto {g['auto']:+.2f}  "
              f"brightness {g['brightness']:+.2f} ({g['source']})  {s['note']}")


if __name__ == "__main__":
    main()

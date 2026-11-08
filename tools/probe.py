#!/usr/bin/env python3
"""Probe all source clips of an episode -> <episode>/sources.json

Usage: python3 tools/probe.py episodes/<name>
Collects duration, display size (after rotation), fps, shoot time, audio presence.
"""
import json, subprocess, sys
from pathlib import Path

VIDEO_EXT = {".mov", ".mp4", ".m4v"}


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    fmt = d["format"]
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    w, h = v["width"], v["height"]
    if abs(rot) in (90, 270):
        w, h = h, w
    num, den = (int(x) for x in v["avg_frame_rate"].split("/"))
    tags = fmt.get("tags", {})
    has_audio = any(s["codec_type"] == "audio" and s.get("codec_name") == "aac" for s in d["streams"])
    return {
        "duration": round(float(fmt["duration"]), 3),
        "width": w, "height": h, "rotation": rot,
        "fps": round(num / den, 3) if den else None,
        "codec": v["codec_name"],
        "shot_at": tags.get("com.apple.quicktime.creationdate") or tags.get("creation_time"),
        "audio": has_audio,
        "size_mb": round(int(fmt["size"]) / 1e6, 1),
    }


def main():
    ep = Path(sys.argv[1]).resolve()
    files = sorted((p for p in (ep / "sources").rglob("*") if p.suffix.lower() in VIDEO_EXT),
                   key=lambda p: p.name)
    clips = []
    for p in files:
        info = probe(p)
        info["id"] = p.stem
        info["path"] = str(p.relative_to(ep))
        clips.append(info)
        print(f'{p.stem}  {info["duration"]:7.2f}s  {info["width"]}x{info["height"]}  {info["fps"]}fps  {info["shot_at"]}')
    clips.sort(key=lambda c: (c["shot_at"] or "", c["id"]))
    (ep / "sources.json").write_text(json.dumps({"clips": clips}, indent=1, ensure_ascii=False))
    total = sum(c["duration"] for c in clips)
    print(f"{len(clips)} clips, {total/60:.1f} min total -> {ep/'sources.json'}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Create a new episode from Google Drive zips / folders / video files and prepare it for the UI.

Usage:
  python3 tools/new_episode.py <episode-name> <zip|folder|video> [...]
  e.g. python3 tools/new_episode.py 2026-03-14-pancakes ~/Downloads/pancakes-001.zip ~/Downloads/pancakes-002.zip

Steps: unpack every zip into its own empty folder episodes/<name>/sources/partN
(folders and loose videos are symlinked, not copied) -> probe -> proxies + strips -> analysis.
Then open the UI (./start.sh), build the edit, and render.
"""
import subprocess, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEO_EXT = {".mov", ".mp4", ".m4v"}


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    name, inputs = sys.argv[1], [Path(a).expanduser().resolve() for a in sys.argv[2:]]
    ep = ROOT / "episodes" / name
    sources = ep / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    part = len(list(sources.glob("part*")))
    for src in inputs:
        if src.suffix.lower() == ".zip":
            part += 1
            dst = sources / f"part{part}"
            dst.mkdir()
            with zipfile.ZipFile(src) as z:  # zipfile drops absolute paths and ".." components
                members = [m for m in z.namelist() if Path(m).suffix.lower() in VIDEO_EXT]
                print(f"{src.name}: {len(members)} videos -> {dst.relative_to(ROOT)}")
                z.extractall(dst, members)
        elif src.is_dir() or src.suffix.lower() in VIDEO_EXT:
            dst = sources / "linked"
            dst.mkdir(exist_ok=True)
            files = [src] if src.is_file() else [f for f in src.rglob("*") if f.suffix.lower() in VIDEO_EXT]
            for f in files:
                link = dst / f.name
                if not link.exists():
                    link.symlink_to(f)
            print(f"{src}: linked {len(files)} videos")
        else:
            print(f"skip {src} (not a zip / folder / video)")
    py = sys.executable
    for step in ("probe.py", "proxies.py", "analyze.py"):
        print(f"--- {step}")
        subprocess.run([py, str(ROOT / "tools" / step), str(ep)], check=True)
    print(f"\nready: episodes/{name}  ->  ./start.sh, choose the episode in the UI")


if __name__ == "__main__":
    main()

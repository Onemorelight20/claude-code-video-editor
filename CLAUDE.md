# CLAUDE.md

Guide for Claude Code working in this repository.

## What this is

A local toolkit for editing vertical cooking videos (TikTok, Reels, Shorts) together with Claude Code.
Raw phone clips go in, a 1080x1920 H.264 MP4 comes out.

There is no timeline editor in the usual sense. The edit is a JSON file, `episodes/<ep>/edl.json`.
`tools/render.py` turns it into a video with ffmpeg. A local web UI lets a human watch every
version, react to it and make small changes themselves.

Requirements: Python 3 with `numpy`, `ffmpeg` and `ffprobe` on PATH, a browser with WebGL2.
Speech detection with Whisper is optional (for example a local mlx-whisper install).

## Who does what

- **Claude edits and renders.** Claude reviews the footage, writes `shotlog.json`, `edl.json` and
  optionally `board.json`, renders versions and replies to the human's notes.
- **The human reviews in the UI** (`./start.sh`, then http://127.0.0.1:8765). In the UI they:
  - leave notes ("instructions") anchored to a shot, a moment or the whole video;
  - swap a shot for an alternative from the Shots board;
  - re-trim a shot, or insert a new range from the footage;
  - tune per-shot light, captions, transitions and effects;
  - render a new version themselves ("Render version").
- The UI writes into the episode folder too: `edl.json` (trims, inserts, board picks), `grades.json`,
  `texts.json`, `transitions.json` and `instructions.json`. Every render, Claude's or the UI's, reads all of them.

## The edit loop

The UI tells the human to ask Claude in chat to apply the notes ("apply my notes", or "внеси правки" in Ukrainian). Then:

```sh
python3 tools/instructions.py list episodes/<ep>                 # open notes, resolved against the current edl.json
# re-read episodes/<ep>/edl.json, then edit it
python3 tools/render.py episodes/<ep> --sheet /tmp/sheet.png      # optional: first / middle / last frame of every shot
python3 tools/render.py episodes/<ep> --note "what changed"        # -> renders/<base>_vN.mp4 + _vN.json
python3 tools/instructions.py reply episodes/<ep> <id> done "what was done" --version N
```

Rules:

- **Re-read `edl.json` right before every edit.** The UI may have changed it since you last read it
  (a trim, an insert, a board pick). Never write back a stale copy.
- **Never re-cut ranges the human picked.** Ranges set in the clip editor, taken from the Shots board
  or quoted in a note are final. Don't move them to still points or trim them unless asked.
  Matching the crop (`zoom`, `x`, `y`) to the neighbouring shots is fine.
- **Keep segment ids stable.** Notes, captions, grades, transitions and the board point at `seg_id`.
  A new shot gets a new id (`s<N>`, one above the highest number in use).
- Don't overwrite grades with `"source": "user"` in `grades.json`; those are the human's light tweaks.
- Every segment needs a short, human `note`. The UI shows it as the shot name and the tools print it.
  Write notes and replies in the language the human uses.
- `instructions.py list` prints, for each note: the shot it was anchored to, where that shot is now,
  the source clip and the exact source time (`clip @ src_t`). Use those, not the timeline time `t`,
  which is only valid for the version the note was written on.
- If a note is unclear, reply with status `question`. The UI shows the question with an "answer" button.
- Notes given in chat go into the same log:
  `instructions.py add episodes/<ep> "text" --done "reply" --version N`.
- Notes sent from the Effects tab carry an `effects` payload. Apply them with
  `instructions.py apply-effects episodes/<ep> <id>`, then render. This replaces `output.effects`
  and the `motion` of every segment.
- `--version N` is the version you just rendered; `render.py` prints the file name (`<base>_vN.mp4`).
- When the human accepts a version, write `renders/current.json`:
  `{"file": "<base>_vN.mp4", "why": "..."}`. The UI opens that version by default.
  Renders started from the UI update it themselves.

Statuses are `open`, `question` and `done`. A `done` note that the human edits, or marks
"not right, redo", goes back to `open`.

## Starting a new episode

```sh
python3 tools/new_episode.py 2026-03-14-pancakes ~/Downloads/pancakes-001.zip ~/Downloads/pancakes-002.zip
```

Inputs can be zips, folders or loose `.mov` / `.mp4` / `.m4v` files. Each zip is unpacked into its
own `sources/partN/`; folders and files are symlinked into `sources/linked/`. The script then runs
`probe.py`, `proxies.py` and `analyze.py`.

Then:

1. Look through the footage with contact sheets (`tools/sheet.py`) and write `shotlog.json`:
   `{"IMG_0123": {"stage": "batter", "note": "whisk in a bowl, top view"}}`.
   The footage panel in the UI groups clips by `stage` and searches the notes.
2. Agree the target length and the hook with the human. Ask for recipe facts (quantities,
   temperatures, times); don't read them off the footage.
3. Write `edl.json` following `docs/edl-format.md` and `docs/editing-playbook.md`.
   Use `analysis.json`, `tools/actions.py` and `tools/camera.py` to pick clean ranges.
4. Optionally write `board.json` with one or two alternatives per shot.
5. Check with `render.py --sheet`, render with `--note`, and point the human to the UI.

A fresh `output` block: `{"width": 1080, "height": 1920, "fps": 30, "audio": true, "transition": {"type": "cut", "audio": 0.1}}`.

## Key commands

```sh
./start.sh                                                  # UI on http://127.0.0.1:8765 (PORT=... to change)
python3 tools/server.py --port 8765 --lan                   # also reachable from a phone on the same Wi-Fi
python3 tools/new_episode.py <name> <zip|folder|video> ...  # new episode + probe + proxies + analysis
python3 tools/sheet.py episodes/<ep> IMG_0123 [t0] [t1] [step] [cols] [-o out.png]   # contact sheet of one clip
python3 tools/actions.py episodes/<ep> <seg_id|clip> [t0 t1]   # motion curve and still points (where to cut)
python3 tools/actions.py episodes/<ep> --all                # the same for every segment
python3 tools/camera.py episodes/<ep> jumps IMG_0123 2.5 6.5   # camera bumps inside a range (30 fps)
python3 tools/camera.py episodes/<ep> drift IMG_0123 0 135     # is the camera static? (for timelapses)
python3 tools/light.py episodes/<ep> [--force]              # refresh auto light balance, print a table
python3 tools/light.py episodes/<ep> --sheet light.png      # before / after sheet
python3 tools/render.py episodes/<ep> --note "..."          # new version
python3 tools/render.py episodes/<ep> --out /tmp/test.mp4   # one-off file, no version, no sidecar
python3 tools/render.py episodes/<ep> --sheet sheet.png     # review sheet of the current edl.json
python3 tools/render.py episodes/<ep> --export <base>_vN.mp4 [--preset 4k]   # 4K master of a version
python3 tools/render.py episodes/<ep> --look warm --note "..."   # legacy colour look, edl.json untouched
python3 tools/render.py episodes/<ep> --looks-sheet looks.png    # latest render x every legacy look
python3 tools/instructions.py list|reply|add|apply-effects ...  # see "The edit loop"
python3 tools/effects.py                                    # regenerate effects/library.json and effects/luts/
python3 tools/probe.py episodes/<ep>                        # preparation steps, run by new_episode.py:
python3 tools/proxies.py episodes/<ep> [--force]            #   sources.json, proxies + strips,
python3 tools/analyze.py episodes/<ep>                      #   analysis.json
```

## Episode folder

```
episodes/<name>/
  sources/              originals: partN/ from zips, linked/ symlinks. Never modify.
  sources.json          probe.py: clips with duration, size after rotation, fps, shot time, audio
  proxies/<id>.mp4      360p H.264 for the UI and the analysis tools
  strips/<id>.jpg       filmstrips, one frame per second
  analysis.json         analyze.py: sharpness, shake, motion, luma at 10 samples per second
  shotlog.json          Claude: footage log {clip: {stage, note}}
  edl.json              THE CURRENT EDIT
  board.json            optional: alternatives for every shot (Shots tab)
  instructions.json     notes from the UI, the chat and UI edits, with replies
  grades.json           per-shot light (auto balance + UI tweaks)
  texts.json, texts/    captions and their PNGs (drawn by the browser)
  transitions.json      per-cut transitions from the UI
  edl_history/          backups of edl.json before every UI edit
  previews/             transition previews (safe to delete)
  cache/                rendered segments and LUTs (safe to delete)
  renders/              <base>_vN.mp4 + _vN.json sidecars, current.json, exports/
```

`<base>` is the folder name without the date prefix: `2026-03-14-pancakes` renders `pancakes_v3.mp4`.

## Things that bite

- **Caption PNGs come from the browser.** `render.py` overlays `texts/<id>_<hash>_<1080|2160>.png`.
  The `hash` covers the caption's text and look, not its timing. If you change a caption's text or
  style in `texts.json`, the old hash still points at the old PNG and the old text gets burned in.
  After such an edit, have the PNGs redrawn: reload the UI (it reads `texts.json` only on load) and
  press "Render version", which re-saves every caption first; or drive the page headlessly and call
  `saveCaptions(true)`.
  A caption without a `hash` or PNG is skipped (`caption <id> skipped: no PNG`).
  Timing fields (`seg_id`, `offset`, `dur`, `end_seg`, `end_pad`) can be edited freely.
- Keep new captions `"hidden": true` until the human has approved the wording.
- Board candidates set the shot's sound: a pick removes `volume`, `audio_mute`, `ramp` and `motion`
  and takes them from the candidate. Put `"volume": 0` on candidates that must stay silent.
- The server reloads `effects.py`, `light.py` and `render.py` before each UI render, export or preview
  if they changed. After changing `server.py` or `web/`, restart the server.
- One render per episode at a time (`renders/.lock`): a CLI render waits for a UI render and vice versa.
- Sheets have no text labels. In `sheet.py`, frame (row r, column c) is at `t0 + (r*cols + c)*step`.
- `cache/`, `previews/`, `proxies/` and `strips/` can be regenerated. Never touch `sources/`.
- No music in the file. The human adds it in the app, so leave the original sound in (`output.audio: true`).

## Docs

- `docs/edl-format.md`: every field of `edl.json` and the other episode files, the render sidecar.
- `docs/editing-playbook.md`: how to cut: hook, complete actions, timelapses, sound, captions.
- `docs/ui.md`: the review UI, tab by tab, and its keyboard shortcuts.
- `docs/architecture.md`: render pipeline, effects, auto light balance, server API.

## Private notes

`CONTEXT.md` and `CLAUDE.local.md` are gitignored. Keep per-episode decisions (what was picked and why,
version history, recipe facts) and personal preferences there, never in tracked files. Where they
exist, they override the defaults in `docs/editing-playbook.md`.

@CONTEXT.md

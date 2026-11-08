# Architecture

Python tools (standard library plus `numpy`) drive `ffmpeg`. A static web page served by a small
standard-library server is the review UI. All state is plain files in `episodes/<name>/`; there is no database.

```
zips / folders ──> new_episode.py ──> sources/ ──> probe.py ──> sources.json
                                                   proxies.py ──> proxies/, strips/
                                                   analyze.py ──> analysis.json

Claude ──> edl.json, shotlog.json, board.json            UI ──> edl.json (inserts, replacements, board picks)
                                                                grades.json, texts.json + texts/*.png,
                                                                transitions.json, instructions.json

render.py <── edl.json + grades.json + texts.json + transitions.json + original sources
          ──> renders/<base>_vN.mp4 + renders/<base>_vN.json (sidecar) ──> UI timeline
```

## Preparation

- `probe.py`: `ffprobe` every clip under `sources/`. Width and height are swapped for 90° rotation, so they are
  the display size. `audio` is true when there is an AAC stream (phones also record extra spatial tracks,
  which are ignored). Clips are sorted by shooting time.
- `proxies.py`: H.264 proxies with the short side at 360 px and a keyframe every 15 frames, for fast scrubbing
  in the browser, plus filmstrips (one 72 px frame per second, tiled). Final renders always use the originals.
- `analyze.py`: per clip, 10 samples per second from the proxy: sharpness (variance of the Laplacian),
  camera shake (phase correlation between samples), motion inside the frame (difference after removing the
  global shift), luma.
- `actions.py` and `camera.py` work on proxies on demand: motion energy inside a crop at 30 fps
  (still points), and whole-frame phase correlation (camera jumps and drift).

## Render pipeline

`tools/render.py` turns `edl.json` into `renders/<base>_vN.mp4` in two stages: a cached render of every
segment, then one ffmpeg graph that joins them.

### 1. Plan

- Load `edl.json` and drop `disabled` segments.
- Refresh the light grades (`light.refresh`, see below). This only happens for the real `edl.json`;
  renders of other EDLs (exports, tests) just read `grades.json`.
- Plan every cut: `(video half, audio half, type)` in frames. The type comes from `transitions.json`, then the
  segment's `transition_in`, then `output.transition`. Each half is limited to `(frames - 2) / 2` of the shorter
  neighbour. A hard cut still gets the default sound crossfade (`output.transition.audio`).

### 2. Per-segment cache

Each segment is rendered from the original source into `cache/<key>.mov`, where `<key>` is a SHA-1 of
everything that affects its pixels or sound: source path, `in`, `out`, `speed`, `zoom`, `x`, `y`, `motion`,
`volume`, `audio_mute`, `ramp`, the grade values, output size and fps, the handle lengths, and flags for slow
motion and denoise. Editing one shot re-renders only that shot. `cache/` can be deleted at any time.

Inside one segment render:

- **Handles.** The segment is rendered with `pre` / `post` extra frames, enough for the transitions on both
  sides. Where the source has no such frames (the shot starts at 0 s or ends at the clip end), the edge frame
  is frozen (`tpad` clone), so any cut can take a transition.
- **Seek and timing.** `-ss` before `-i` on the original file, then `setpts` for the speed (or the ramp
  expression, a piecewise function of time with logarithmic ease segments), `fps=30` and `trim` to an exact
  frame count: `round(duration * fps)` plus the handles.
- **Crop and scale.** A 9:16 window (`crop_box`) scaled to the output size with lanczos. A push-in is a
  `perspective` filter between crop and scale: sub-pixel smooth, without `zoompan` jitter.
- **Slow motion.** `minterpolate` (motion-compensated, bidirectional) at output size, so there are no repeated frames.
- **Timelapse blend.** A `tmix` branch averages `blend` frames and is overlaid only in the fast part of the ramp.
  (`tmix`'s own `enable` option corrupts the chroma in ffmpeg 8.0, hence the overlay.)
- **Light grade.** The shot's grade becomes a 33³ 3D LUT (`cache/fx/grade_<hash>.cube`) applied with `lut3d`
  in RGB. YUV/RGB conversions use `accurate_rnd+full_chroma_int+bitexact`: the default swscale rounding darkens
  every conversion by about 2 levels.
- **Sound.** The first audio stream, `atempo` for the speed. Ramps are split into five parts (1x, ease, fast
  middle, ease, 1x); parts faster than 4x become silence. Then the optional denoise (`highpass=80`, `afftdn`),
  `volume`, `audio_mute` ranges (gain ramps over 30 ms via `aeval`), padding to the exact sample count,
  and 15 ms fades at both ends against clicks. Clips without sound get silence.
- **Encode.** x264 `veryfast`, CRF 10, one keyframe per second; PCM 48 kHz stereo. Rendered to a temp file and renamed.

### 3. Assembly

One ffmpeg graph (`assemble_graph`) takes all cached parts:

- Video and sound are assembled separately, so a cut can be hard for the picture and still have a short
  equal-power sound crossfade.
- Each part is split into a head (handle + first frames), a body and a tail. Neighbouring tail and head go
  through `xfade` (picture) or `acrossfade` with `qsin` curves (sound). Transitions are centred on the cut, so the
  timeline length and every shot's start stay exactly the sum of the segment frames.
- Bodies and transitions are concatenated, then:
  1. the legacy colour look (`output.look`, an ffmpeg filter chain);
  2. the effects graph (`effects.build_graph`, see below);
  3. caption overlays: each caption PNG is a looped input with alpha fades, overlaid with `enable=between(t, a, b)`.
     The 1080 PNG is used for 1080p and the 2160 PNG for 4K; a mismatched size is scaled with premultiplied alpha.
- Final encode: libx264 `slow`, CRF 17, High profile, yuv420p, one keyframe per second, BT.709 tags,
  `+faststart`, AAC 192 kbit/s (or no audio when `output.audio` is false). Progress is read from `-progress pipe:1`.
- Renders of one episode are serialized with an `flock` on `renders/.lock`.

### 4. Sidecar

`renders/<base>_vN.json` stores the EDL snapshot with each shot's exact `start` and `dur`, the baked grade, the
transition actually rendered into each shot (`trans_in`) and the captions with absolute times.
The UI builds its timeline from it and compares it with the current files to show what is not rendered yet.
Format: `docs/edl-format.md`.

### 4K export

`render.py --export <base>_vN.mp4 --preset 4k` (or Download > 4K in the UI) rebuilds a version from its sidecar:
the same segments, baked grades, captions (at their absolute times, using the 2160 px PNGs), transitions and look,
at 2160 x 3840 with libx264 `medium`, CRF 17, level 5.1. The 4K segments get their own cache entries.
Output: `renders/exports/<base>_vN_4k.mp4`.

### Previews and sheets

- `preview_transition`: a 2 s, 360p preview of one cut (1 s each side) built from the proxies with the real
  `xfade`, cached in `previews/tr_<hash>.mp4`.
- `render.py --sheet`: first, middle and last frame of every segment, from the proxies.
- `render.py --looks-sheet`: key frames of the newest version under every legacy look.

## Effects: one recipe, two implementations

`tools/effects.py` is the single definition of the colour looks and effects. The same maths runs in
ffmpeg for the render and in a WebGL2 shader (`web/app.js`) for the live preview.

- **Colour looks** are small numpy recipes built from shared building blocks (`temperature`, `vibrance`,
  `s_curve`, `fade`, `tone`, `gamma`, `tame_greens`). Each recipe is baked into a 33³ 3D LUT.
  - Render: the table at the chosen strength (blended towards identity) is written to `cache/fx/look_<id>_<k>.cube`
    and applied with `lut3d` trilinear.
  - Preview: the same table as a PNG strip (`effects/luts/<id>.png`, x = blue slice x 33 + red, y = green),
    sampled trilinearly in the shader and mixed by strength. Trilinear `lut3d` and the shader give the same result.
- **Light and texture effects** use the same formulas and the constants in `P` (exported to
  `effects/library.json`):
  - sharpen: a 3x3 unsharp kernel;
  - diffusion: blur at 1/4 resolution, `lighten` blend;
  - glow: highlights above 0.6, blurred at 1/4 resolution, `screen` blend;
  - leak: two warm blobs moving on sine paths over time, `screen` blend;
  - vignette: smoothstep mask between radii 0.45 and 1.05, multiplied;
  - grain: luma noise of a fixed amplitude.
- **Order** in the render: sharpen, look, diffusion, glow, leak, vignette, grain.
- **Push-in** is per segment (`motion.pushin`): `perspective` in the segment render, a texture-coordinate zoom in the preview.
- The preview was checked against the render on the same frame: each effect matched within about one 8-bit level on average.

To change or add a look or effect: edit `tools/effects.py`, run `python3 tools/effects.py` to regenerate
`effects/library.json` and `effects/luts/*.png`, and mirror any formula change in the shader in `web/app.js`.
The UI reads the library from `/effects/`.

The older `render.py: LOOKS` (`natural`, `warm`, `film`, `bright`) are plain ffmpeg filter chains without a
preview. They remain for `--look` comparisons and old versions.

## Auto light balance

`tools/light.py` evens out brightness between shots. `light.refresh` runs inside every render of the real `edl.json`:

1. For every active segment without a grade, or whose `sig` (clip, in, out, zoom, x, y) changed, it measures
   5 frames spread over the shot, cropped like the shot, from the proxy at 72 x 128 grey.
2. The **key** of a shot is `0.5 * median + 0.5 * 80th percentile` of its luma (0-1). Halfway between the median
   and the bright part, it is robust to dark pans and white plates.
3. The **target** is the median key of all shots.
4. The **auto brightness** moves each key 60% of the way to the target:
   `goal = key + 0.6 * (target - key)`, `brightness = -log2(ln(goal) / ln(key))`, clipped to plus or minus 0.45.
5. Shots with `source: "auto"` take that value. Shots with `source: "user"` (set in the Light tab) keep their
   values as long as they use the same clip.

The grade maths, in this order, is identical in `light.grade_rgb` (for the LUT) and the `gradeC` shader
function in `web/app.js`:

- `temp`: white balance shift that keeps luma (`effects.temperature` at 0.5 per unit);
- `brightness`: midtone gamma `v ** 2**(-b)`; black and white stay put, so nothing clips and whites don't go grey;
- `contrast`: S-curve around mid grey (`effects.s_curve` at 0.3 per unit).

The player shows a rendered version that already contains its grades, so the preview applies only the difference
between the pending and the baked grade. `python3 tools/light.py episodes/<ep>` prints the table
(`--force` re-measures everything); `--sheet` makes a before / after sheet.

## Server

`tools/server.py` is a `ThreadingHTTPServer` from the standard library. It binds to 127.0.0.1, or to all
interfaces with `--lan`. There is no authentication, so only use `--lan` on a network you trust.

### API

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/episodes` | List of episodes: name, clip count, title, version count. |
| GET | `/api/episodes/<ep>` | Everything the UI needs: clips, shotlog, versions with their timelines and export state, `current`, instructions, grades, texts, transitions, active `edl.json` segments, render job state, board. |
| POST | `/api/episodes/<ep>/instructions` | Add a note. Only known fields are kept; the server sets `id`, `created`, `status: open`, `by: user`. |
| PATCH | `/api/episodes/<ep>/instructions/<id>` | Edit `text` and / or `status`. |
| DELETE | `/api/episodes/<ep>/instructions/<id>` | Delete a note. |
| POST | `/api/episodes/<ep>/render` | `{"note": "..."}`: new version in the background; updates `renders/current.json` when done. |
| POST | `/api/episodes/<ep>/export` | `{"file": "pancakes_v4.mp4", "preset": "4k"}`: 4K export in the background. |
| PUT | `/api/episodes/<ep>/grades/<seg_id>` | `{"brightness", "contrast", "temp"}` (clamped to the UI ranges, sets `source: user`) or `{"reset": true}` (back to auto). |
| PUT | `/api/episodes/<ep>/texts` | `{"items": [...]}`: replaces `texts.json` (whitelisted fields). |
| POST | `/api/episodes/<ep>/texts/<id>.png?size=1080\|2160&hash=<8 hex>` | A caption PNG drawn by the browser. |
| PUT | `/api/episodes/<ep>/transitions` | `{"cuts": {seg_id: {"type", "dur"}}}`: replaces `transitions.json` (types validated, `dur` clamped to 0.1-2.0). |
| POST | `/api/episodes/<ep>/transition-preview` | `{"file", "seg_id", "type", "dur"}`: returns the URL of a 2 s 360p preview. |
| POST | `/api/episodes/<ep>/segments` | `{"clip", "in", "out", "mode": "after"\|"replace", "target", "note"}`: insert or replace a shot in `edl.json`. |
| POST | `/api/episodes/<ep>/board/pick` | `{"step", "cand"}`: a board candidate replaces its shot in `edl.json`. |
| GET | `/media/<ep>/<proxies\|strips\|renders\|previews>/<file>` | Media with HTTP Range support (video seeking). |
| GET | `/download/<ep>/<file>` | A render or export as an attachment. |
| GET | `/effects/<path>` | `library.json` and LUT PNGs for the live preview. |
| GET | `/reference/<file>` | Videos from `reference/` (optional examples; not shown in the UI). |

`/segments` and `/board/pick` back up `edl.json` to `edl_history/` first and log the change in
`instructions.json` as a done note with `by: "ui"`. A replacement keeps the shot's `id`, `note` and `volume`;
when the clip is the same it also keeps `speed`, `ramp`, `motion` and `audio_mute`, and the crop.

### Behaviour worth knowing

- **Atomic writes.** Every JSON file is written to a temp file and renamed, under a server-wide lock,
  so Claude can read any file at any moment.
- **Fresh code.** The server runs for hours while Claude edits `tools/*.py`. Before each render, export or
  transition preview it reloads `effects`, `light` and `render` if their files changed and no job is running.
  Changes to `server.py` itself or to `web/` need a server restart (web files are served with `no-cache`).
- **Background jobs.** UI renders and exports run in threads; their progress is part of `GET /api/episodes/<ep>`,
  which the page polls every 3 seconds.
- **Validation.** Episode and file names must match `^[\w.\- ]+$`; only `web/*.js` and `web/*.css` are served
  besides `index.html`.
- **Cache busting.** The UI adds `?v=<mtime>` to media URLs, so regenerated proxies and strips show up at once.

## Frontend

No build step and no framework. Scripts load in this order:

- `web/i18n.js`: interface language (UK / EN) and `t()` lookups;
- `web/app.js`: player, timeline, notes, footage panel, clip viewer, version and download menus, effects
  preview (WebGL2);
- `web/studio.js`: light, captions (drawing and PNG upload), transitions, pending-change detection, clip editor
  range picker and shot trimming;
- `web/board.js`: the Shots board.

Scripts talk through a few chained hooks on `window` (`onEpisodeData`, `onSideTab`, `onVersionHook`, ...).

Some maths exists on both sides and must be changed together:

| Python | JavaScript |
|---|---|
| `render.ramp_of`, `ramp_out` | `app.js: rampOf`, `srcOffset`; `board.js: bdDur` |
| `render.place_texts` | `studio.js: capTimes` |
| `light.grade_rgb` | `app.js: gradeC` (shader) |
| `effects.py` recipes and constants | `app.js` shaders (via `effects/library.json`) |
| `render.PLACEHOLDERS` | `studio.js: PLACEHOLDERS` |

## Platform notes

The tools were built on macOS. A few spots are platform-specific:

- `proxies.py` decodes with `-hwaccel videotoolbox`; remove the flag elsewhere.
- `start.sh` opens the browser with `open`.
- `render.py` uses `fcntl` for the render lock (Unix only).
- Sheets have no text labels, so they don't depend on an ffmpeg built with `drawtext`.

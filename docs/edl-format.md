# Episode file formats

Everything about one video lives in `episodes/<name>/`. All times are in seconds.
"Source seconds" are positions inside a clip; "timeline seconds" are positions in the rendered video.

| File | Written by | Read by |
|---|---|---|
| `edl.json` | Claude; the UI (trims, inserts, board picks) | `render.py`, the analysis tools, the UI |
| `texts.json` + `texts/` | the UI (Captions tab); Claude | `render.py`, the UI |
| `transitions.json` | the UI (Transitions tab) | `render.py`, the UI |
| `grades.json` | `light.py` (auto), the UI (Light tab) | `render.py`, the UI |
| `board.json` | Claude; the UI sets `pick` | the UI (Shots tab) |
| `instructions.json` | the UI, `instructions.py` | `instructions.py`, the UI |
| `shotlog.json` | Claude | the UI (footage panel) |
| `sources.json`, `analysis.json` | `probe.py`, `analyze.py` | everything |
| `renders/<base>_vN.json` | `render.py` | the UI, `render.py --export` |

The server writes JSON atomically (temp file, then rename), so a file is never half-written when you read it.
Before the UI changes `edl.json` it saves a copy to `edl_history/edl_<timestamp>.json`.

## edl.json

```json
{
 "title": "Pancakes",
 "output": {"width": 1080, "height": 1920, "fps": 30, "audio": true,
            "transition": {"type": "cut", "audio": 0.1}, "denoise": true,
            "effects": {"look": {"id": "appetizing", "strength": 0.45}}},
 "segments": [
  {"id": "s1", "clip": "IMG_0123", "in": 4.2, "out": 5.6, "speed": 1,
   "zoom": 1, "x": 0.5, "y": 0.5, "note": "hook: syrup on the stack"},
  {"id": "s2", "clip": "clip_02", "in": 0.8, "out": 2.4, "speed": 1,
   "zoom": 1.4, "x": 0.5, "y": 0.42, "volume": 0, "note": "flour into the bowl"},
  {"id": "s3", "clip": "clip_03", "in": 2.0, "out": 62.0, "speed": 1,
   "zoom": 1, "x": 0.5, "y": 0.5, "volume": 0, "note": "whisk in a bowl",
   "ramp": {"speed": 12, "hold": 0.4, "ease": 0.6, "blend": 3}}
 ]
}
```

Top level:

- `title`: shown in the UI's episode picker, together with the date from the folder name.
- `output`: settings for the whole video (below).
- `segments`: the shots, in timeline order.

Other top-level keys are ignored by the tools. You can keep free-form notes there.

### output

| Field | Default | Meaning |
|---|---|---|
| `width`, `height` | required | Output size, normally 1080 x 1920. The 4K export overrides it with 2160 x 3840. |
| `fps` | required | Output frame rate, normally 30. |
| `audio` | `true` | `false` renders without a sound track. |
| `transition` | hard cuts | Default for every cut. `{"type": "cut", "audio": 0.1}`: hard picture cut with a 0.1 s sound crossfade. `{"type": "dissolve", "dur": 0.27}`: every cut becomes a fade of `dur` seconds. `audio` is the minimum length of the sound crossfade at each cut; leave it out for no sound crossfade. |
| `effects` | none | Whole-video colour look and effects, see below. |
| `denoise` | `false` | Clean up the sound of every shot that keeps sound: highpass at 80 Hz plus an adaptive FFT denoiser (`afftdn`). |
| `look` | `"natural"` | Legacy colour looks applied at the final encode: `natural`, `warm`, `film`, `bright`. Prefer `effects`. |

### output.effects

```json
"effects": {"look": {"id": "appetizing", "strength": 0.6},
            "glow": 0.3, "diffusion": 0.4, "leak": 0.3, "vignette": 0.35, "grain": 0.3, "sharpen": 0.3}
```

Strengths go from 0 to 1; 0 or a missing key means off. One colour look at most:
`appetizing`, `warm`, `golden`, `cream`, `portra`, `vintage`, `fresh`, `evening`.
The recipes live in `tools/effects.py`. This block is usually written by
`instructions.py apply-effects` from a note sent from the Effects tab.

### segments

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Stable id. Notes, captions, grades, transitions and the board refer to it. Ids made by the UI are `s<N>`. |
| `clip` | required | Clip id from `sources.json` (the file name without extension, e.g. `IMG_0123`). |
| `in`, `out` | required | Source seconds. |
| `note` | required | Shot name shown in the UI and printed by the tools. Keep it short and human. |
| `speed` | `1` | Constant speed. Timeline length = `(out - in) / speed`, rounded to whole frames. Ignored when a `ramp` is active. |
| `zoom` | `1` | Crop factor, 1 or more. |
| `x`, `y` | `0.5` | Centre of the crop as a fraction of the source width / height. The crop is always 9:16 and is clamped to stay inside the frame, so landscape sources are cropped automatically. |
| `volume` | `1` | Sound level, 0 to 1. `0` mutes the shot. |
| `audio_mute` | none | `[[from, to], ...]` in source seconds: silence these ranges (for example a voice), with 30 ms ramps. |
| `denoise` | `output.denoise` | `true` / `false` for this shot only. |
| `ramp` | none | Smooth speed-up for long processes and timelapses, see below. |
| `motion` | none | `{"pushin": strength}`: slow push-in over the shot. |
| `transition_in` | none | Fallback transition into this shot: `"cut"` or `{"type": "fade", "dur": 0.3}`. `transitions.json` wins over it. |
| `disabled` | `false` | `true` keeps the segment in the file but leaves it out of renders, the UI and the tools. |

#### ramp

```json
"ramp": {"speed": 12, "hold": 0.4, "ease": 0.6, "blend": 3}
```

- The shot plays at 1x for `hold` source seconds at both ends, so the action starts and ends naturally.
  Over `ease` seconds it speeds up smoothly to `speed`, holds that in the middle, and slows down again.
- Defaults: `hold` 0.4, `ease` 0.6. If `2 * (hold + ease)` is more than 90% of the shot, both shrink proportionally.
- Only active when `speed` is above 1. While a ramp is active, the segment's own `speed` is ignored.
- Timeline length, with `L = out - in`, `S = speed`, `h = hold`, `r = ease`:
  `2h + 2r * ln(S) / (S - 1) + (L - 2h - 2r) / S`.
  The same maths is in `render.py` (`ramp_of`, `ramp_out`, `ramp_expr`) and `web/app.js` (`rampOf`, `srcOffset`).
- `blend`: number of neighbouring source frames averaged in the fast part (motion blur, like frame blending
  in an NLE), 0 to 64. It applies from the middle of the speed-up to the middle of the slow-down.
  It is ignored on shots with `motion`. Around `speed / 4` looks smooth; much more smears moving objects.
- Sound: the 1x parts keep their sound, the ease parts play at their average tempo, the fast middle
  plays at `speed`. Any part faster than 4x is silent.

#### Slow motion

`speed` below 0.95, with no `ramp` and no `motion`, is rendered with motion-interpolated in-between
frames (`minterpolate`), so slow motion is smooth instead of repeating frames. These shots render slower.

#### motion.pushin

`{"pushin": 0.5}` zooms in by `0.12 * strength` over the shot (0.5 gives 6%, 1.0 gives 12%).
The UI slider goes from 0 to 1. It is rendered with a sub-pixel `perspective` filter, so it doesn't jitter.

#### What triggers a re-render of a segment

Each segment is cached in `cache/<hash>.mov`. The hash covers `clip`, `in`, `out`, `speed`, `zoom`,
`x`, `y`, `motion`, `volume`, `audio_mute`, `ramp`, the shot's light grade, the output size and fps,
the transition handles and the denoise / slow-motion flags. Changing `note`, `id` or the order of
shots does not re-render a segment.

## texts.json

Captions, made in the Captions tab. The browser draws each caption into a transparent PNG and the render
overlays it, so the file shows exactly what the preview shows.

```json
{"items": [
 {"id": "c01", "text": "whisk the batter", "hidden": false,
  "font": "Caveat", "weight": 700, "italic": false, "upper": false, "size": 0.058,
  "color": "#fff6e6", "style": "plain", "box": "#000000", "boxOpacity": 0.5,
  "align": "center", "x": 0.5, "y": 0.17, "maxWidth": 0.84, "lineHeight": 1.18,
  "shadow": true, "shadowColor": "#000000", "shadowOpacity": 0.55, "shadowBlur": 0.37,
  "shadowDist": 0.05, "shadowAngle": 90,
  "seg_id": "s3", "offset": 0.2, "end_seg": "s4", "end_pad": 0.15, "dur": 3, "start": 6.4, "fade": 0.25,
  "hash": "1a2b3c4d"}
]}
```

Timing (the same rules in `render.py: place_texts` and `web/studio.js: capTimes`):

- **Start** = start of shot `seg_id` on the timeline + `offset`. If `seg_id` is not in the edit, `start` (timeline seconds) is used.
- **End** = end of shot `end_seg` minus `end_pad` (default 0.15) when `end_seg` is set and in the edit.
  Otherwise start + `dur` (default 3).
- So captions follow their shots when the edit changes. Changing the timing by hand in the Captions tab
  removes `end_seg` and `end_pad`; from then on `dur` applies.
- `fade`: alpha fade in and out, default 0.25 s, at most a third of the caption. `0` = no fade.
- Captions are clamped to the video; anything shorter than 0.1 s is dropped.

Not burned in: `hidden: true`, empty text, the placeholder text of a new caption, or no `hash`.

Look:

| Field | Meaning |
|---|---|
| `font`, `weight`, `italic`, `upper` | Google font family, weight, italic, all caps. |
| `size` | Font size as a fraction of the frame height. |
| `color` | Text colour, `#rrggbb`. |
| `style` | `plain`, `outline` or `box`. The legacy value `shadow` means `plain` with a soft shadow. |
| `box`, `boxOpacity` | Colour of the box or the outline; box opacity. |
| `align` | `left`, `center`, `right` inside the text block. |
| `x`, `y` | Centre of the text block as fractions of the frame. |
| `maxWidth`, `lineHeight` | Wrap width as a fraction of the frame width; line height as a multiple of `size`. |
| `shadow`, `shadowColor`, `shadowOpacity` | Drop shadow on or off, its colour and opacity. |
| `shadowBlur`, `shadowDist` | Blur and distance as fractions of the font size. |
| `shadowAngle` | Direction in degrees, 90 = straight down. |

`hash` is 8 hex characters computed by the browser from the text and the look fields (not the timing).
The PNGs are `texts/<id>_<hash>_1080.png` and `texts/<id>_<hash>_2160.png`. If you edit the text or
look by hand, the PNGs must be redrawn by the UI (see "Things that bite" in `CLAUDE.md`).
When the UI saves, the server keeps only the fields listed in `server.py: TEXT_FIELDS`, and ids must match `[\w-]{1,40}`.

## transitions.json

```json
{"cuts": {"s4": {"type": "fade", "dur": 0.4}, "s9": {"type": "slideleft", "dur": 0.3}}}
```

- The key is the id of the shot **after** the cut. A cut without an entry falls back to the segment's
  `transition_in`, then to `output.transition`.
- `type`: `cut` or an ffmpeg `xfade` name from `render.py: TRANSITION_TYPES`.
  The UI offers 16 of them: `cut`, `fade`, `fadeblack`, `fadewhite`, `dissolve`, `slideleft`, `slideright`,
  `slideup`, `smoothleft`, `wipeleft`, `circleopen`, `zoomin`, `hblur`, `radial`, `coverleft`, `pixelize`.
- `dur`: seconds. The server clamps it to 0.1-2.0; the UI slider offers 0.1-1.2.
- A transition is centred on the cut, so shot timings and caption anchors don't move.
  Each half is limited by the length of the shorter neighbouring shot. When the source has no frames
  before or after the shot, the edge frame is frozen, so a transition works on any cut.

## grades.json

Per-shot light. Written by `light.py` (auto balance, refreshed on every render of the real `edl.json`)
and by the Light tab.

```json
{"target": 0.43,
 "segments": {
  "s1": {"clip": "IMG_0123", "sig": ["IMG_0123", 4.2, 5.6, 1, 0.5, 0.5], "key": 0.39, "auto": 0.1,
         "brightness": 0.1, "contrast": 0, "temp": 0, "source": "auto"}}}
```

| Field | Meaning |
|---|---|
| `target` | Median `key` of all active shots; the auto balance pulls every shot towards it. |
| `key` | Measured brightness of the shot (see `docs/architecture.md`). |
| `sig` | Clip, in, out, zoom, x, y when it was measured. A different `sig` triggers a new measurement. |
| `auto` | Brightness the auto balance suggests. |
| `brightness` | -0.8 to 0.8. Midtone gamma: `v ** 2**(-b)`; black and white stay put. |
| `contrast` | -0.5 to 0.5. S-curve around mid grey. |
| `temp` | -1 to 1. Warmer (+) or cooler (-) white balance that keeps brightness. |
| `source` | `auto`: `brightness` follows `auto`. `user`: set in the UI, kept as is while the shot uses the same clip. |

## board.json

The Shots board: for every shot of the edit, Claude's pick and alternatives from the footage.

```json
{"steps": [
 {"id": "b1", "seg_id": "s1", "part": "Hook", "title": "syrup on the stack", "pick": 0,
  "cands": [
   {"clip": "IMG_0123", "in": 4.2, "out": 5.6, "zoom": 1, "x": 0.5, "y": 0.5, "speed": 1,
    "why": "closest angle, syrup runs down the side"},
   {"clip": "clip_04", "in": 0.8, "out": 2.4, "zoom": 1.3, "x": 0.5, "y": 0.45, "volume": 0,
    "why": "brighter, but the hand covers the plate at the end"}
  ]}
]}
```

- Steps are shown in order, under a heading whenever `part` changes. `title` names the step.
- The first candidate is Claude's pick. `why` is shown under each candidate.
- Candidate fields: `clip`, `in`, `out` (required), `zoom`, `x`, `y`, `speed`, and optionally `volume`,
  `audio_mute`, `ramp`, `motion`.
- "Take" (`POST /api/episodes/<ep>/board/pick`) replaces segment `seg_id` in `edl.json`:
  `clip`, `in`, `out`, `speed` (default 1), `zoom` (1), `x`, `y` (0.5) come from the candidate.
  `volume`, `audio_mute`, `ramp` and `motion` are removed and taken from the candidate only if it has them.
  The segment keeps its `id`, `note` and any other fields. The server sets `pick`, backs up `edl.json`
  and logs the change in `instructions.json`.

## instructions.json

```json
{"items": [
 {"id": "i031410153003", "created": "2026-03-14T10:15:30", "by": "user",
  "anchor": "moment", "text": "start this a bit later, when the spoon is in the middle",
  "version": 3, "file": "pancakes_v3.mp4", "t": 12.4,
  "seg_id": "s7", "seg_n": 7, "seg_note": "whisk in a bowl", "seg_offset": 0.6,
  "clip": "clip_03", "src_t": 3.1,
  "refs": [{"clip": "clip_05", "t": 4.2, "t2": 5.6}],
  "status": "done", "reply": "Moved the start to 3.4 s.", "reply_version": 4,
  "updated": "2026-03-14T10:40:02"}
]}
```

| Field | Meaning |
|---|---|
| `id` | `i...` from the Notes tab, `c...` added from chat, `u...` logged UI edits (inserts, replacements, board picks). |
| `by` | `user` (Notes tab), `chat` (`instructions.py add`), `ui` (an edit the UI already made). |
| `anchor` | `segment` (a whole shot), `moment` (an exact moment), `general` (the whole video). |
| `version`, `file` | The version on screen when the note was written. |
| `t` | Timeline seconds in that version. Only valid for that version. |
| `seg_id`, `seg_n`, `seg_note`, `seg_offset` | The shot: stable id, its number and name in that version, seconds from its start. |
| `clip`, `src_t` | The exact source frame. |
| `refs` | Footage ranges mentioned from the clip editor: `t` alone is a moment, `t`-`t2` is a range. |
| `effects` | Only on notes from the Effects tab: `{"global": {...output.effects...}, "pushin": {"strength", "scope": "all"\|"one", "seg_id"} \| null}`. |
| `status` | `open`, `question` or `done`. |
| `reply`, `reply_version` | Claude's answer and the version it refers to. |

The UI shows `done` notes from the latest `reply_version` and hides older ones behind a checkbox.
`instructions.py list` resolves `seg_id` against the current `edl.json` and prints where the shot is now.

## shotlog.json

```json
{"IMG_0123": {"stage": "serving", "note": "stack of pancakes, syrup poured from above"},
 "clip_03": {"stage": "batter", "note": "whisk in a bowl, top view, static camera"}}
```

Claude writes it after reviewing the footage. The footage panel groups clips by `stage` in shooting order
and searches clip ids, notes and stages. A shot inserted from the clip editor is named after the clip's `note`.

## sources.json and analysis.json

`sources.json` (from `probe.py`), clips sorted by shooting time:

```json
{"clips": [{"id": "IMG_0123", "path": "sources/part1/IMG_0123.MOV", "duration": 18.4,
            "width": 2160, "height": 3840, "rotation": -90, "fps": 30.0, "codec": "hevc",
            "shot_at": "2026-03-14T09:12:03+0100", "audio": true, "size_mb": 120.5}]}
```

`width` and `height` are the display size after rotation. `audio` is true when the clip has an AAC track.

`analysis.json` (from `analyze.py`), per clip, 10 samples per second from the proxy:

```json
{"IMG_0123": {"rate": 10, "sharp": [...], "shake": [...], "motion": [...], "luma": [...]}}
```

- `sharp`: variance of the Laplacian; higher is sharper (focus, motion blur).
- `shake`: global camera shift since the previous sample, in pixels at 90 px width.
- `motion`: change inside the frame after removing the camera shift (the action).
- `luma`: mean brightness, 0-255.

## Render outputs

`renders/<base>_vN.mp4` is a version; `<base>` is the episode folder name without its date prefix.
Next to it, the sidecar `renders/<base>_vN.json` records exactly what was rendered. The UI builds its
timeline from it and `render.py --export` rebuilds the 4K master from it.

```json
{"version": 4, "file": "pancakes_v4.mp4", "created": "2026-03-14T10:39:51", "duration": 58.2,
 "note": "hook starts later; flour shot muted", "look": "natural", "look_name": "...",
 "output": {"width": 1080, "height": 1920, "fps": 30, "audio": true, "transition": {"type": "cut", "audio": 0.1}},
 "segments": [
  {"id": "s1", "clip": "IMG_0123", "in": 4.2, "out": 5.6, "speed": 1, "zoom": 1, "x": 0.5, "y": 0.5,
   "note": "hook: syrup on the stack", "start": 0.0, "dur": 1.4,
   "grade": {"brightness": 0.1, "contrast": 0.0, "temp": 0.0}, "trans_in": null},
  {"id": "s2", "...": "...", "start": 1.4, "dur": 1.6, "grade": {"...": 0}, "trans_in": {"type": "cut", "dur": 0.0}}
 ],
 "texts": [{"id": "c01", "hash": "1a2b3c4d", "start": 3.2, "end": 5.85, "text": "whisk the batter"}]}
```

- `segments`: the rendered (non-disabled) segments with all their edl fields, plus `start` and `dur`
  on the timeline, the baked light `grade` and `trans_in` (the transition actually rendered into the shot,
  `null` for the first one).
- `texts`: the captions that were burned in, with absolute times.
- The UI compares these with the current files to show what is "not in the file yet".

Other render files:

- `renders/current.json`: `{"file": "<base>_vN.mp4", "why": "..."}`, the version the UI opens by default.
- `renders/exports/<base>_vN_4k.mp4`: 4K master (2160 x 3840) rebuilt from the original sources.
- `renders/.lock`: lock file that serializes renders of one episode.

# Review UI

The review UI is where the human watches each version, leaves notes for Claude and makes small changes
themselves. It is a plain HTML/JS page (`web/`) served by `tools/server.py` (Python standard library only).

```sh
./start.sh                                   # http://127.0.0.1:8765, opens the browser; PORT=9000 ./start.sh to change
python3 tools/server.py --port 8765 --lan    # also listen on the local network, e.g. to review on a phone
```

The page polls the server every 3 seconds. A new version rendered by Claude shows up as a
"New version ready" banner; notes and replies update by themselves.

Labels below are the English ones; the Ukrainian name follows where it helps.

## Workspace layout

On a desktop window of at least 1180 x 680 everything fits without page scrolling, like an editing program:

```
+-----------------------------------------------------------------------+
| header: footage toggle, episode, version, Render version, Download,   |
|         UK / EN, ?                                                     |
+--------------+------------------------------+-------------------------+
| Footage      | Player (9:16)                | Inspector tabs          |
| (Матеріал)   |                              | Notes, Shots, Light,    |
|              | controls                     | Captions, Transitions,  |
|              |                              | Effects                 |
+--------------+------------------------------+-------------------------+
| Timeline (docked at the bottom)                                       |
+-----------------------------------------------------------------------+
```

Each panel scrolls on its own. On narrower screens the page scrolls instead; below 1000 px the order is
player, timeline, tabs, footage. On a phone everything is one column.

### Header

- **Footage toggle** (or `M`): show or hide the footage panel. The browser remembers the choice.
- **Episode** picker: the `title` from `edl.json` and the date from the folder name.
- **Version** picker: every rendered version with its date; `✓ main` marks the one in `renders/current.json`,
  which opens by default. When another version is open, a pill "not main · back to vN" takes you back.
  The change note of the version is shown next to it.
- **Render version · N**: renders a new version on the server from the current `edl.json`, light, captions
  and transitions. `N` counts the changes not yet in the file; with no changes the button is disabled.
  During the render it shows the progress. When it is done, the UI opens the new version and makes it the main one.
- **Download**: the 1080 x 1920 file of the open version, or a **4K version** (2160 x 3840, rebuilt from the
  original clips, a couple of minutes). With `--lan`, open the address on a phone and download straight to it.
- **UK / EN**: interface language (see below).
- **?** (or `?`): keyboard shortcuts and a short "how it works".

### Player

- Click the video to play or pause. Under it: back to start, play / pause, one frame back / forward
  (1/30 s), time, playback speed (1x, 0.5x, 0.25x), sound, loop, full screen (`F`, keeps 9:16).
- Captions and the live preview of light and effects are drawn over the video, so what you see is what the
  next render will contain.

### Timeline

- The shots of the open version with thumbnails, numbers and names. The numbers are the ones notes refer to.
- Click or drag to seek. The current shot has a blue frame.
- **✎** on a shot (shown on hover, on the current shot and on touch screens) or a **double-click** opens the shot
  in the clip editor to trim or replace it.
- Marks above the shots: notes (coloured by status), captions and transitions (diamonds).
  A honey-coloured line under a shot means it has changes that are not in the file yet.
- Zoom: `-` / `+` buttons or keys, pinch or Cmd/Ctrl + wheel, up to 16x. **Fit** (`0`) shows the whole video.

## Inspector tabs

### Notes (Вказівки)

The main channel to Claude. Everything here is stored in `instructions.json`.

- **Current shot card**: number, name, source clip and second; **Trim shot** (same as ✎), **Alternatives · N**
  (jumps to this shot on the Shots board), **whole clip →** (opens the source clip in the clip editor).
- **Pin to**: `shot` (the whole shot), `moment` (this exact moment) or `whole video`. The anchor follows the
  playhead until you start typing; the first letter pins it.
- Quick phrases ("remove", "longer", "shorter", "another moment of this clip", ...) append to the text.
- `Enter` adds the note, `Shift+Enter` makes a new line.
- Footage ranges mentioned from the clip editor are attached as references.
- The list shows questions first, then new notes, then done ones with Claude's replies.
  Done notes from the latest round of replies are always visible; older ones appear with **show all done**.
- Actions on a note: **✎ edit** (or double-click the text), **not right, redo** (re-opens a done note),
  **reply** (to Claude's question), **delete** (click twice). Editing the text of a note sends it back
  to Claude as new.
- When there are new notes, a strip says how many and offers to **Copy** the phrase to send Claude in chat
  ("apply my notes").
- The tab shows a counter of new notes and questions.

### Shots (Кадри)

The shot board from `board.json`, if Claude made one. For every shot of the edit: Claude's pick (first) and
alternatives from the footage, grouped by recipe part.

- Each candidate shows a thumbnail, the clip and range, the duration on the timeline, tempo (timelapse,
  slow motion), crop and "no sound", plus Claude's reason.
- **▶** plays the candidate over the player with the same crop and speed. Click the overlay or play the
  main video to close it.
- **Use** puts the candidate into `edl.json` right away (a backup goes to `edl_history/`, and the change is
  logged as a done note). It appears in the video after **Render version**.
- States: `✓ in the edit` (matches `edl.json`), `not in the video yet` (changed but not rendered), or the shot
  is no longer in the edit. Click a step's title to jump to that shot.

### Light (Світло)

Light is already balanced between shots automatically on every render. This tab fine-tunes one shot at a time.

- Sliders for the shot under the playhead: **Brightness** (-0.8 to 0.8), **Contrast** (-0.5 to 0.5),
  **Warmth** (-1 to 1). Changes show live on the video and are saved to `grades.json` as `source: user`.
- **Auto** returns the shot to the automatic balance.
- **Hold: before / after** (or hold `B`) shows the version as rendered.
- A list of all shots with their brightness; click one to jump there.

### Captions (Текст)

Captions are burned into the video at render time. The browser draws each one into a transparent PNG,
so the file looks exactly like the preview.

- **+ Add caption here** adds a caption at the playhead, anchored to the shot under it.
  Drag captions directly on the video; clicking one on the video selects it.
- The editor (back to **All captions** with ←):
  - text (`Shift+Enter` for a new line);
  - **Presets**: seven ready styles;
  - **Font**: 14 Google fonts, all with Cyrillic; bold, italic, all caps, alignment; **Size**;
  - **Text color**; **Style**: None, Outline or Box, with box colour and opacity;
  - **Shadow**: presets, colour, opacity, blur, distance, direction;
  - **Position and timing**: Top / Center / Bottom or drag; **Start here**, **End here**, **Duration**,
    **fade in**; **Delete caption** (or `Delete` / `Backspace` while a caption is selected).
- While editing, a dashed rectangle marks the TikTok safe zone (x 4-82%, y 8-78%).
- A new caption starts with placeholder text; until you change it, it is never burned in.
- Captions that are already in the file are not drawn twice. A changed caption is drawn over the old one
  until the next render.
- Setting the timing by hand removes "ends with shot X"; from then on the caption has a fixed duration.

### Transitions (Переходи)

- Works on the cut nearest to the playhead; ‹ › move to the previous or next cut.
- 16 types: Cut, Crossfade, Dip to black, Flash, Scatter, Slide (left, right, up), Smooth slide, Wipe,
  Circle, Zoom in, Blur, Radar, Cover, Pixelate. **Duration** 0.1-1.2 s.
- **Preview transition** builds a 2 s, 360p preview of that cut from the proxies in about a second.
- **Apply to all cuts** copies the current choice to every cut; **All straight** resets every cut to a hard cut.
- Saved to `transitions.json`; rendered on the next version.

### Effects (Ефекти)

A live WebGL preview over the video. The final render uses the same colour tables and formulas.

- **Presets**: none, cozy, tasty, dreamy, film, evening.
- **Color**: one look at a time with a strength slider. Thumbnails show the current frame in each look.
- **Light**: soft glow, diffusion, light leaks, vignette. **Texture**: film grain, sharpen.
  **Motion**: slow push-in, on all shots or only the current one.
- **Hold: before / after** (or hold `B`), **Reset all**.
- **Send to Claude: render a version with these effects** creates a note with the settings attached.
  Effects are not written to `edl.json` directly: Claude applies them with
  `tools/instructions.py apply-effects` and renders.

## Footage panel and clip editor

The **Footage** panel lists every clip, grouped by the stages in `shotlog.json`, in shooting order.

- Search covers clip ids, notes and stages. **only clips not in the edit** hides used clips;
  used ones show the shot numbers they appear in.
- Hover a card to scrub through the clip; click it to open the clip editor.

The **clip editor** is a large window:

- **Left:** the whole footage library again (search, "not in the edit"). The open clip is highlighted.
  Clicking another clip opens it in place. If you came from ✎ to replace a shot, the target shot is kept,
  so a shot can be replaced with a piece of a different clip.
- **Middle:** the clip with normal video controls.
- **Right:** where the clip is used in the edit, the current time, and the range picker:
  - an **overview** of the whole clip (shots that use it, the selection, the visible window: drag it to scroll);
  - a **filmstrip** with the selection: drag the handles or the whole range, click to seek;
  - zoom: `-` / `+`, **Zoom to selection** (`Z`), **Whole clip** (`0`), wheel or pinch to zoom at the pointer,
    sideways scroll to pan. Clips longer than 12 s open zoomed in on the selection;
  - **[ Start here** (`I`), **End here ]** (`O`), **Selection** (loop the selected range);
  - mode **Insert after** a chosen shot (or at the very start) or **Replace shot**;
  - **＋ Add to video** / **✓ Replace shot** writes the range into `edl.json` (backup in `edl_history/`,
    logged as a done note). It appears in the video after **Render version**;
  - **Mention in a note** inserts the range, e.g. `[IMG_0123 4.20–5.60 s]`, into the note you are writing
    and attaches it as a reference.

Trim and replace flow:

1. Press ✎ on a timeline shot (or double-click it, or **Trim shot** in the Notes tab). The editor opens on
   that shot's current range from `edl.json`, in **Replace shot** mode.
2. Move the handles, or pick another clip on the left.
3. Press **✓ Replace shot**. The shot keeps its id, name, captions and `volume`. If the clip is the same,
   speed, timelapse, push-in and muted ranges are kept too; the crop is kept only for the same clip.
4. Press **Render version** (or ask Claude to continue editing).

Ranges must be at least 0.2 s long.

## Keyboard shortcuts

Press `?` in the UI for the same list.

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` / `→` | 1/30 s back / forward |
| `Shift` + `←` / `→` | previous / next shot of the edit |
| `Home` | from the start |
| `F` | full screen |
| `V` | the previously viewed version, at the same moment |
| `B` (hold) | without the unrendered light / effects changes |
| `N` or `Enter` | write a note |
| `+` / `-` / `0` | timeline zoom in / out / fit |
| `M` | show / hide the footage panel |
| `Esc` | close a window, leave a text field |
| `?` | shortcuts window |

In the clip editor:

| Key | Action |
|---|---|
| `I` / `O` | start / end of the range at the current frame |
| `Space` | play / pause the clip |
| `+` / `-` | zoom the filmstrip |
| `Z` | zoom to the selection |
| `0` | whole clip |
| wheel / pinch | zoom at the pointer; sideways scroll pans |

In text fields, `Enter` saves or sends and `Shift+Enter` makes a new line (notes, note editing, the effects
comment, captions). `Esc` cancels editing a note.

## Language

The **UK / EN** switch in the header sets the interface language. The choice is stored in the browser
(`localStorage`, key `lang`). Switching saves pending edits first, then reloads the page.

Without a stored choice, the UI starts in Ukrainian for an existing user (one who has opened an episode
before) or a browser set to Ukrainian, otherwise in English.

Translations live in `web/i18n.js`, gettext style: the Ukrainian string is the key and `EN` maps it to
English; a missing key falls back to Ukrainian. Only interface text is translated. Notes, captions, Claude's
replies, shot names and footage notes stay exactly as written.

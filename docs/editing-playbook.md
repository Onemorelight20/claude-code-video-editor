# Editing playbook

Defaults for cutting short vertical cooking videos without a face or voice-over.
They are starting points, not rules: the human's notes always win. Record what a particular
person prefers, and per-episode decisions, in the private notes (`CONTEXT.md`, gitignored),
not in this file.

## Before the first cut

- Agree with the human:
  - the target length;
  - the hook;
  - whether there will be step captions;
  - what happens to the original sound.
- Review all the footage before choosing anything. Make contact sheets
  (`tools/sheet.py`) and write `shotlog.json` with a stage and a note for every clip.
- Ask for recipe facts (quantities, temperatures, times). Don't read them off the footage.

## Structure

Default order: **hook, process in chronological order, serving, loop back to the hook.**

- **Hook first, in the first 1-2 seconds.** Show the finished dish in action: a knife cutting through,
  a pour, steam rising, a first bite lifted. A close shot with a slow push-in works well.
- Don't open with an empty bowl, raw ingredients or a wide establishing shot of the kitchen.
  Start with the hook.
- A "preview" right after the hook (a few quick shots of the process) is an option. It can blunt
  the hook, so try it in one version rather than by default.
- **Show every step of the recipe.** Hide only trivial handling (fetching a container, opening a pack),
  and keep the step readable. Show the state before, the action and the state after; don't jump
  straight to the result.
- **Put each shot where the action really happens.** If the oven is switched off at the end of baking,
  that shot goes after the baking, not before it.
- End on serving and the plate, about 2-3 s. Ideally the last shot leads back into the first one,
  so the video loops.

Length:

- Decide it with the human. A calm recipe at about 2 s per action easily runs past a minute.
  Some creator monetisation programmes only count videos longer than one minute.
- An aesthetic edit under a minute needs timelapses for the repeated actions, and fewer steps.

## Strong shots

- The action is clearly visible, from a good angle, with no fumbles: no knife that doesn't cut on the
  first try, no hand covering the subject, no camera jerk.
- Pick the best take, not the first one you find.
- Check that the shot shows the action it is named after, not the neighbouring one
  (trimming a piece is not slicing it).
- No faces by default. Check the edges of a range: people often walk into frame at the end of a clip.
- Hide messy moments (a spill, a drip on the tray) with a tighter crop or a different moment.
- Wide shots read badly when they are short. Crop closer: on a 4K source, `zoom` 1.4-2.0 still looks sharp.
- Useful data: `analysis.json` has `sharp` (focus, motion blur) and `shake` at 10 samples per second.

## Complete actions, cut at still points

**Smoothness comes from complete actions, not from effects.**

- Each shot holds one whole movement: the knife from touching the board to lifting off, one full slice,
  a pour until the stream ends.
- Cut when the movement has finished, at a still point. Start the next shot at the start of a new
  movement. The rhythm of the action then carries across the cut.
- Find still points with:

  ```sh
  python3 tools/actions.py episodes/<ep> s7          # motion curve of shot s7, 0.8 s around it
  python3 tools/actions.py episodes/<ep> IMG_0123 10 20   # any clip and range
  python3 tools/actions.py episodes/<ep> --all       # every shot of the edit
  ```

  It measures motion inside the shot's crop at 30 fps and lists local minima at least 25% below the
  movement around them. Confirm a candidate with a 15 fps contact sheet of the range.
- Cut on the action: don't show the hand reaching in. A match cut works best at the peak of an action.
- A jump cut within the same angle is fine when both shots are complete movements.
- If one action was filmed as two clips back to back, prefer one continuous piece: a movement without
  a cut is smoother.
- In a pan, pairs read well: add an ingredient, then stir.
- Default to hard cuts with a short sound crossfade (`output.transition = {"type": "cut", "audio": 0.1}`).
  Visual transitions are the human's choice in the Transitions tab.

## Pace

- Default: 1-2 s per shot, as long as the whole movement takes. About 2 s per action for a calm recipe.
- **No runs of 0.5 s shots.** They feel choppy. If very fast cuts suit a moment (chopping, spices),
  keep it to a handful in a row and then let the pace breathe.
- Don't force the cuts onto a fixed beat grid. Complete actions matter more. If the human provides a
  music track, you can measure its beats and nudge cuts onto them within the still points.
- Most shots run at 1x. Speed up only long, monotonous processes where you can see change.
  An edit where half the shots are sped up feels weak.
- Slow motion (`"speed": 0.5`, rendered with interpolated frames) suits the final "tasty" close-ups.

## Timelapses and speed ramps

Use a `ramp` for long repetitive processes: a mixer running for minutes, stirring a pot, arranging
slices on a tray, a long simmer.

- **Static camera only.** A timelapse from a moving camera is chaos. Check the range first:

  ```sh
  python3 tools/camera.py episodes/<ep> drift IMG_0123 0 135
  ```

  It compares samples 0.5 s apart; a move of 6+ px (of 320) means the camera moved. If it moves,
  pick a window where it stands still.
- **Speed x7 to x20, with `blend`.** Set `blend` to about speed / 4 (x20 gives 5, x7 gives 2).
  More blend smears moving objects.
- **Not x40-x80.** That speed reads as frantic, even on a static camera.
- For shorter processes, a 2-4x ramp in the middle with 1x at both ends is enough. `hold` and `ease`
  keep the start and the end of the action natural.
- With several sped-up shots in a row, vary the speeds so the rhythm isn't uniform.
- Sound faster than 4x is silent in the render. Usually mute the shot, or keep a natural sound at the 1x ends.

## Camera bumps

```sh
python3 tools/camera.py episodes/<ep> jumps IMG_0123 2.5 6.5
```

- This lists frame-to-frame camera shifts at 30 fps. A jump of 3+ px (of 320) over several frames is a
  visible bump. Hands moving over a static background don't count; only the whole frame moving does.
- Cut the bump out: start the shot after it or end before it, and keep the action.
- In a finished render, a mean difference between neighbouring frames (90x160 grey) above about 6,
  away from a cut, points to a jerk.

## Sound

Default: keep the real kitchen sounds (knife, whisk, pour, sizzle, oven door) and remove all speech.
Music, if any, is added by the human in the app.

- **Remove speech completely.** Mute the shot (`"volume": 0`) or just the words (`"audio_mute": [[from, to]]`
  in source seconds).
- **Mute shots without a nice sound.** Keep sound only on shots you have checked.
- Turn loud clicks and bangs down to `volume` 0.25-0.35. Clips can differ by 20-30 dB; check peaks with
  ffmpeg (`astats`, `volumedetect`).
- `"denoise": true` on `output` (or on a shot) cleans up hum, hiss and extractor-fan rumble.
- When the clip editor replaces a shot, the old `volume` is kept. Board candidates carry their own
  `volume`; give silent ones `"volume": 0`.

### Finding speech

There is no bundled tool for this; write a short script.

1. **Whisper** (for example a local mlx-whisper install, optional). Cut each shot's sound plus 0.3 s
   into a 16 kHz mono WAV and transcribe it with word timestamps. Real speech shows up as coherent phrases
   with word probabilities of 0.6 or more across several words.
2. **Ignore the usual hallucinations.** On silence and kitchen noise Whisper invents stock phrases:
   - "You", "Yep", "Thank you", "Thanks for watching!";
   - "Subtitles by the Amara.org community" and similar subtitle credits;
   - the same in other languages, e.g. Ukrainian "Дякую" / "Дякую за перегляд" ("thank you" /
     "thanks for watching") and Russian "Продолжение следует" ("to be continued") or "Субтитры делал..."
     ("subtitles by...");
   - rhythmic syllables such as "tu-tu-tu" from a whisk hitting a bowl.
3. For doubtful shots, run it again with the language forced to each language spoken in the kitchen.
   If only stock phrases come out, there is no speech.
4. **Pitch check** as a second opinion: autocorrelation over 40 ms frames. Voice shows periodicity above
   0.5 with a pitch in the voice range (roughly 80-300 Hz) that keeps changing. A flat pitch
   (for example 151 Hz plus or minus 1) is an appliance hum, not a voice.
5. Run the check again on the finished render when the human asks for "no voices".

## Captions

- Default: no running captions. The recipe goes in the post description; on screen only a short hook
  title. The platform's own text tool is an alternative for the title.
- If you use step captions: short, lowercase, one line, one per step, one style for the whole video.
- **Agree the wording before burning in.** Send the human a list "shot -> caption" in chat. Add the
  captions with `"hidden": true` and unhide them only after approval.
- **Match the action on screen exactly.** "whisk" only where a whisk is moving, "stir" for a spoon,
  "pour" only while something is poured.
- Anchor each caption to its shot (`seg_id` + `offset`) and end it with `end_seg`, so it follows re-cuts.
- Check that each caption fits on one line: the visible height of its PNG should be about one line
  (`size` x `lineHeight` of the frame height). Twice that means it wrapped; shorten the text.
- Position: in the upper part of the frame, but inside the safe zone (y around 0.15-0.18).

## Safe zone

The TikTok app covers the bottom of the frame (description, sound) and the right column (buttons).
Keep captions and the key action inside **x 4-82%, y 8-78%** of the frame. The Captions tab draws this
zone as a dashed rectangle while you edit. Reels and Shorts cover similar areas.

## Colour and light

- The auto light balance evens out brightness between shots on every render. The human fine-tunes in the Light tab.
- A natural look is a safe default. Add a colour look (for example `appetizing` at about 45%) only when the
  human chooses one in the Effects tab.
- White food and plates should stay white, not blue.
- Don't combine a look from this tool with an in-app filter; the correction would apply twice.

## Tips for faceless cooking videos

- **What the platform measures:** how many viewers stay past the first 3 seconds, how many watch to the
  end and rewatch (loop), and how many save the video.
- **Hook in 0-2 s:** the finished result in motion. Never an empty bowl.
- **Oddly satisfying moments** hold attention: a knife through a crisp crust, batter ribbons falling from
  a whisk, syrup running down a stack, something sizzling as it hits the pan.
- **Match cut for anything that cooks unseen:** the oven door closes, cut, the door opens on the finished result.
- **Loop:** the last shot leads into the first.
- **Slow push-in (10-20%) on texture shots:** `"motion": {"pushin": 1.0}` gives about 12%.
- **Sound:** original kitchen sounds at 80-100%, music at 8-15%, added in the app. No talking.
- **Music, if the human adds it:** a strong beat at 0:00 with no quiet intro, because the hook is short.
  Line up the most striking moment with the rise or drop of the track. Some business accounts may only use
  the platform's commercial music library, so music is added per app and never burned into the file.
- **Text:** recipe with quantities in the description, on screen at most a short hook title inside the safe zone.

#!/usr/bin/env python3
"""Render an episode's edl.json into a TikTok-ready MP4 (1080x1920, H.264, 30 fps).

Usage: python3 tools/render.py episodes/<name> --note "what changed"   -> renders/<name>_vN.mp4 + _vN.json
       python3 tools/render.py episodes/<name> --out /tmp/x.mp4            -> one-off file, no version
       python3 tools/render.py episodes/<name> --sheet sheet.png           -> review sheet only
       python3 tools/render.py episodes/<name> --look warm --note "..."    -> try a colour look (edl.json untouched)
       python3 tools/render.py episodes/<name> --looks-sheet looks.png     -> key frames of the latest render × every look

Pipeline:
  1. every segment is cut from the ORIGINAL 4K source into cache/<hash>.mov
     (frame-exact, crop/zoom, per-segment light grade from grades.json as a 3D LUT,
     PCM audio with 15 ms fades against clicks) plus "handles": a few extra frames before / after
     for the dissolve into the neighbour. The hash covers everything that affects the pixels,
     so editing one segment re-renders only that segment.
  2. one ffmpeg graph trims bodies and handles, makes the transitions (xfade + equal-power
     acrossfade, centred on the cut so the beat grid stays), concatenates, applies the global
     look / effects and encodes once (libx264 crf 17).
  3. a sidecar renders/<name>_vN.json stores the EDL snapshot with exact timeline positions,
     baked grades, the change note and duration; the review UI builds its timeline from it.
Transitions: default = output.transition in edl.json ({"type": "cut", "audio": 0.1} = hard cut with a 0.1 s
sound crossfade). Per cut: transitions.json {"cuts": {<id of the shot after the cut>: {"type", "dur"}}}, set in the
UI (any ffmpeg xfade type: fade, fadeblack, slideleft, zoomin, ...); edl segment "transition_in" is the fallback.
Transitions are centred on the cut; missing source frames for the handles are cloned (frozen), so any cut works.
Captions: texts.json (made in the UI "Captions" tab). The browser draws every caption into a transparent
PNG (texts/<id>_<hash>_1080|2160.png, exactly what the preview shows); here they are overlaid after
the look / effects, with alpha fades, at times anchored to segment ids (seg_id + offset, dur).
No music, no text: those are added later in TikTok / CapCut.
"""
import fcntl, hashlib, json, math, re, subprocess, sys, time
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import effects as fxlib  # noqa: E402
import light  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
QUALITY = {  # final encode presets
    "standard": ["-preset", "slow", "-crf", "17", "-profile:v", "high"],                    # 1080p for TikTok
    "4k": ["-preset", "medium", "-crf", "17", "-profile:v", "high", "-level:v", "5.1"],      # master from 4K sources
}
FADE = 0.015  # s, audio fade at every cut
ACC = ":flags=accurate_rnd+full_chroma_int+bitexact"  # exact YUV<->RGB (default rounding darkens ~2 levels)

# Colour looks, applied once in the final encode (segment cache stays valid).
# edl.json: "output": {"look": "warm"}; or --look for a one-off comparison render.
LOOKS = {
    "natural": ("натуральний", ""),
    "warm": ("теплий вечір",  # cosy like the reference: warmer white balance, softer highlights, light vignette
             "colorbalance=rs=.05:bs=-.06:rm=.05:gm=.005:bm=-.06:rh=.02:bh=-.05,"
             "curves=all='0/0.025 0.5/0.475 1/0.95',eq=saturation=1.06:gamma=0.95,vignette=angle=0.55"),
    "film": ("плівка",  # faded blacks, warm highlights, slightly muted colours, fine grain
             "curves=r='0/0.05 0.5/0.53 1/0.98':g='0/0.045 0.5/0.5 1/0.95':b='0/0.07 0.5/0.46 1/0.88',"
             "eq=saturation=0.92:contrast=0.97,noise=alls=4:allf=t+u,vignette=angle=0.45"),
    "bright": ("світлий кремовий",  # airy and clean: lighter, low contrast, creamy whites
               "eq=brightness=0.04:contrast=0.9:saturation=0.97:gamma=1.08,"
               "colorbalance=rh=.04:gh=.015:bh=-.04:rm=.015:bm=-.025,curves=all='0/0.04 1/1'"),
}


def load_clips(ep: Path):
    return {c["id"]: c for c in json.loads((ep / "sources.json").read_text())["clips"]}


def load(ep: Path):
    return json.loads((ep / "edl.json").read_text()), load_clips(ep)


def ramp_of(seg):
    """Smooth speed ramp of a shot: "ramp": {"speed": S, "hold": h, "ease": r} (source seconds).
    1x for `hold` at both ends (the action starts and ends naturally), eases up over `ease` to S in the middle.
    Returns (S, h, r, L, R, P): R = output length of one ease, P = output length of the fast middle."""
    rp = seg.get("ramp")
    if not rp or float(rp.get("speed", 1)) <= 1.001:
        return None
    S = float(rp["speed"])
    L = float(seg["out"]) - float(seg["in"])
    h, r = float(rp.get("hold", 0.4)), float(rp.get("ease", 0.6))
    if 2 * (h + r) > 0.9 * L:                      # short shot: shrink hold / ease proportionally
        k = 0.9 * L / (2 * (h + r))
        h, r = h * k, r * k
    R = r * math.log(S) / (S - 1)
    P = (L - 2 * h - 2 * r) / S
    return S, h, r, L, R, P


def out_duration(seg):
    """Seconds the shot lasts on the timeline."""
    rp = ramp_of(seg)
    if rp:
        S, h, r, L, R, P = rp
        return 2 * h + 2 * R + P
    return (float(seg["out"]) - float(seg["in"])) / float(seg.get("speed", 1))


def ramp_out(rp, u):
    """Source offset u (s from seg in, may be < 0 or > L for handles) -> output offset. Same maths as ramp_expr."""
    S, h, r, L, R, P = rp
    if u < h:
        return u
    if u < h + r:
        return h + r / (S - 1) * math.log(1 + (S - 1) * (u - h) / r)
    if u < L - h - r:
        return h + R + (u - h - r) / S
    if u < L - h:
        v = u - (L - h - r)
        return h + R + P + r / (S - 1) * math.log(S / (S - (S - 1) * v / r))
    return h + 2 * R + P + (u - (L - h))


def ramp_expr(rp, lead):
    """ffmpeg expression in T (input seconds, 0 = `lead` s before seg in) -> output seconds."""
    S, h, r, L, R, P = rp
    u = f"(T-{lead:.6f})"
    k = S - 1
    a = f"{u}"
    b = f"({h:.6f}+{r / k:.6f}*log(1+{k:.6f}*({u}-{h:.6f})/{r:.6f}))"
    c = f"({h + R:.6f}+({u}-{h + r:.6f})/{S:.6f})"
    d = f"({h + R + P:.6f}+{r / k:.6f}*log({S:.6f}/({S:.6f}-{k:.6f}*({u}-{L - h - r:.6f})/{r:.6f})))"
    e = f"({h + 2 * R + P:.6f}+({u}-{L - h:.6f}))"
    x = (f"if(lt({u}\\,{h:.6f})\\,{a}\\,if(lt({u}\\,{h + r:.6f})\\,{b}\\,if(lt({u}\\,{L - h - r:.6f})\\,{c}\\,"
         f"if(lt({u}\\,{L - h:.6f})\\,{d}\\,{e}))))")
    return f"({x}+{lead:.6f})"


def frames_of(seg, fps):
    """Number of output frames of a segment (timeline length)."""
    return max(1, round(out_duration(seg) * fps))


def crop_box(clip, seg, W, H):
    """Crop window in source pixels (after rotation). Same math as web/app.js:cropBox()."""
    sw, sh = clip["width"], clip["height"]
    target = W / H
    base_w = min(sw, sh * target)          # biggest window with output aspect
    z = max(1.0, float(seg.get("zoom", 1)))
    cw, ch = base_w / z, base_w / z / target
    cx, cy = float(seg.get("x", 0.5)) * sw, float(seg.get("y", 0.5)) * sh
    x = min(max(cx - cw / 2, 0), sw - cw)
    y = min(max(cy - ch / 2, 0), sh - ch)
    ev = lambda v: int(v) // 2 * 2
    return ev(cw), ev(ch), ev(x), ev(y)


def ramp_blend(seg):
    """Frames averaged in the fast part of a timelapse: "ramp": {"speed": 20, "blend": 10}; 0 = off.
    Shots with a push-in keep the plain path (the motion filter sits between crop and scale)."""
    rp = seg.get("ramp")
    if not ramp_of(seg) or seg.get("motion"):
        return 0
    return max(0, min(64, int(rp.get("blend", 0))))


def slow_mo(seg):
    """Slower than ~0.95x without a ramp or push-in: rendered with interpolated frames."""
    return not ramp_of(seg) and float(seg.get("speed", 1)) < 0.95 and not seg.get("motion")


def denoise_of(seg, out):
    """Noise clean-up of a shot's sound (hum, hiss, fridge/hood rumble): `"denoise": true` on the segment
    or on `output` (every shot that keeps sound). `"denoise": false` on a segment turns it off.
    highpass 80 Hz + adaptive FFT denoiser (afftdn, tracks the noise floor)."""
    if float(seg.get("volume", 1)) <= 0:
        return ""
    on = seg.get("denoise", out.get("denoise", False))
    return "highpass=f=80,afftdn=nr=14:nf=-45:tn=1," if on else ""


def seg_key(ep, clip, seg, out, pre=0, post=0, grade=None):
    keys = ("in", "out", "speed", "zoom", "x", "y", "motion", "volume", "audio_mute", "ramp")
    blob = json.dumps([clip["path"], [seg.get(k) for k in keys], out["width"], out["height"], out["fps"],
                       pre, post, light.grade_values(grade), 4] + (["mi1"] if slow_mo(seg) else [])
                      + (["dn1"] if denoise_of(seg, out) else []), sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def render_segment(ep: Path, clip, seg, out, dst: Path, pre=0, post=0, grade=None):
    """Segment + `pre`/`post` handle frames, exactly n + pre + post frames.
    Handles the source does not have (shot starts at 0 s / ends at the clip end) are frozen frames."""
    W, H, fps = out["width"], out["height"], out["fps"]
    rp = ramp_of(seg)
    speed = 1.0 if rp else float(seg.get("speed", 1))   # ramps run their handles at 1x
    n = frames_of(seg, fps)
    total = n + pre + post
    dur = total / fps
    have_pre = int(seg["in"] * fps / speed + 1e-6)
    have_post = max(0, int((clip["duration"] - seg["out"]) * fps / speed) - 1)
    miss_pre, miss_post = max(0, pre - have_pre), max(0, post - have_post)
    start = seg["in"] - (pre - miss_pre) * speed / fps
    take = total - miss_pre - miss_post           # frames that really come from the source
    src_dur = take / fps * speed
    lead = (pre - miss_pre) / fps                 # source seconds before seg in that are rendered
    if rp:
        src_dur = lead + rp[3] + (post - miss_post) / fps
    cw, ch, x, y = crop_box(clip, seg, W, H)
    g = ""
    if not light.is_identity(grade):
        cube = ep / "cache" / "fx" / f"grade_{hashlib.sha1(json.dumps(light.grade_values(grade), sort_keys=True).encode()).hexdigest()[:12]}.cube"
        if not cube.exists():
            cube.parent.mkdir(parents=True, exist_ok=True)
            light.write_grade_cube(grade, cube)
        g = (f",scale=in_color_matrix=bt709:in_range=tv{ACC},format=gbrp,lut3d=file='{cube}':interp=trilinear,"
             f"scale=out_color_matrix=bt709:out_range=tv{ACC},format=yuv420p")
    pad = ""
    if miss_pre or miss_post:
        pad = f"tpad=start={miss_pre}:start_mode=clone:stop=-1:stop_mode=clone,trim=end_frame={total},"
    timing = f"setpts='{ramp_expr(rp, lead)}/TB'" if rp else f"setpts=(PTS-STARTPTS)/{speed}"
    blend = ramp_blend(seg)
    if slow_mo(seg):
        # slow motion: motion-compensated in-between frames at output size (no repeated frames, no judder)
        v = (f"[0:v]setpts=PTS-STARTPTS,crop={cw}:{ch}:{x}:{y},scale={W}:{H}:flags=lanczos,setsar=1,"
             f"minterpolate=fps={fps / speed:.4f}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,"
             f"settb=1/{fps},setpts=N,fps={fps},trim=end_frame={take},setpts=PTS-STARTPTS,{pad}format=yuv420p{g}[v]")
    elif blend:
        # smooth timelapse: average `blend` successive source frames (motion blur, like an NLE's frame blending),
        # only where the shot runs fast (from the middle of the ease up to the middle of the ease down).
        # tmix's own `enable` breaks the chroma in ffmpeg 8.0, so the blended branch is overlaid where it is wanted.
        S, h, r, L, R, P = rp
        a, b = lead + h + r / 2, lead + L - h - r / 2
        ones = " ".join(["1"] * blend)
        v = (f"[0:v]setpts=PTS-STARTPTS,crop={cw}:{ch}:{x}:{y},scale={W}:{H}:flags=lanczos,setsar=1,split=2[bu][bb];"
             f"[bb]tmix=frames={blend}:weights='{ones}':scale={1 / blend:.6f}[bm];"
             f"[bu][bm]overlay=0:0:eof_action=pass:enable='between(t\\,{a:.4f}\\,{b:.4f})',"
             f"{timing},fps={fps},trim=end_frame={take},setpts=PTS-STARTPTS,{pad}format=yuv420p{g}[v]")
    else:
        v = (f"[0:v]setpts=PTS-STARTPTS,{timing},fps={fps},trim=end_frame={take},setpts=PTS-STARTPTS,{pad}"
             f"crop={cw}:{ch}:{x}:{y},{fxlib.segment_motion_filter(seg, n, pre)}"
             f"scale={W}:{H}:flags=lanczos,setsar=1,format=yuv420p{g}[v]")
    delay = f"adelay=delays={round(miss_pre / fps * 1000)}:all=1," if miss_pre else ""
    to_out = (lambda t: ramp_out(rp, t - seg["in"]) + lead) if rp else (lambda t: (t - max(0.0, start)) / speed)
    gain = audio_gain(seg, to_out, miss_pre / fps)
    tail = (f"aresample=48000,aformat=channel_layouts=stereo,{denoise_of(seg, out)}{delay}apad,"
            f"atrim=end_sample={round(dur * 48000)},{gain}"
            f"afade=t=in:d={FADE},afade=t=out:st={dur - FADE:.4f}:d={FADE}[a]")
    if clip.get("audio") and rp:
        S, h, r, L, R, P = rp
        # 1x | ease (average tempo) | fast middle (tempo S, silent when too fast to sound real) | ease | 1x
        cuts = [0, lead + h, lead + h + r, lead + L - h - r, lead + L - h, src_dur]
        ease_t = r / R
        parts = []
        for k in range(5):
            a0, a1 = cuts[k], cuts[k + 1]
            tempo = 1 if k in (0, 4) else (ease_t if k in (1, 3) else S)
            parts.append((a0, a1, tempo))
        g = [f"[0:a:0]atrim=duration={src_dur:.4f},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,asplit=5" + "".join(f"[r{k}]" for k in range(5))]
        for k, (a0, a1, tempo) in enumerate(parts):
            if tempo > 4:   # too fast to sound real (speech turns into chirps): silence for that part
                g.append(f"[r{k}]anullsink;anullsrc=r=48000:cl=stereo,atrim=duration={(P if k == 2 else R):.5f}[q{k}]")
            else:
                g.append(f"[r{k}]atrim=start={a0:.5f}:end={a1:.5f},asetpts=PTS-STARTPTS,aresample=48000,atempo={tempo:.5f}[q{k}]")
        g.append("".join(f"[q{k}]" for k in range(5)) + "concat=n=5:v=0:a=1," + tail)
        a = ";".join(g)
    elif clip.get("audio"):
        a = f"[0:a:0]atrim=duration={src_dur:.4f},asetpts=PTS-STARTPTS,atempo={speed}," + tail
    else:
        a = f"anullsrc=r=48000:cl=stereo,atrim=end_sample={round(dur * 48000)}[a]"
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-t", f"{src_dur + 0.5:.4f}",
           "-i", str(ep / clip["path"]), "-filter_complex", f"{v};{a}", "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-g", str(fps),
           "-c:a", "pcm_s16le", "-ar", "48000", str(dst)]
    subprocess.run(cmd, check=True)


TRANSITION_TYPES = {  # ffmpeg xfade names allowed from the UI
    "fade", "fadeblack", "fadewhite", "dissolve", "slideleft", "slideright", "slideup", "slidedown",
    "smoothleft", "smoothright", "smoothup", "smoothdown", "wipeleft", "wiperight", "wipeup", "wipedown",
    "circleopen", "circleclose", "zoomin", "hblur", "radial", "pixelize", "coverleft", "coverright",
    "revealleft", "revealright", "squeezeh", "squeezev", "fadegrays", "vertopen", "horzopen", "diagtl", "diagbr"}


def load_transitions(ep: Path):
    p = ep / "transitions.json"
    return json.loads(p.read_text()).get("cuts", {}) if p.exists() else {}


def cut_choice(out, seg, user):
    """(type, dur) wanted for the cut INTO seg: user's choice > edl segment > edl default."""
    u = user.get(seg["id"])
    if isinstance(u, dict) and u.get("type"):
        return u["type"], float(u.get("dur", 0.4))
    ov = seg.get("transition_in")
    if ov == "cut":
        return "cut", 0.0
    tr = out.get("transition") or {}
    if isinstance(ov, dict):
        return ov.get("type", "fade"), float(ov.get("dur", 0.3))
    if tr.get("type") == "dissolve":
        return "fade", float(tr.get("dur", 0.27))
    return "cut", 0.0


def audio_gain(seg, to_out, lead):
    """Per-shot sound: "volume" (0 = mute, 1 = as shot) and "audio_mute": [[from, to], ...] in clip seconds
    (e.g. a voice). Muted ranges ramp over 30 ms so nothing clicks. Returns a filter chain prefix.
    to_out(clip seconds) -> seconds in the rendered part (before the frozen lead-in)."""
    out = ""
    vol = float(seg.get("volume", 1))
    if abs(vol - 1) > 1e-3:
        out += f"volume={vol:.3f},"
    for a, b in seg.get("audio_mute") or []:
        la = to_out(float(a)) + lead      # clip seconds -> seconds in this rendered part
        lb = to_out(float(b)) + lead
        g = f"clip(max({la:.4f}-t\\,t-{lb:.4f})/0.03\\,0\\,1)"
        out += f"aeval=exprs='val(0)*{g}|val(1)*{g}':channel_layout=stereo,"
    return out


def plan_transitions(segs, clips, out, user=None):
    """Per cut: (video half, audio half, xfade type) in frames. A hard cut keeps the default short
    sound crossfade (output.transition.audio). Limited only by the lengths of the two shots."""
    fps = out["fps"]
    user = user or {}
    tr = out.get("transition") or {}
    a_def = max(1, round(float(tr.get("audio", 0.1)) * fps / 2)) if tr.get("audio") else 0
    plan = []
    for a, b in zip(segs, segs[1:]):
        typ, dur = cut_choice(out, b, user)
        if typ != "cut" and typ not in TRANSITION_TYPES:
            typ = "fade"
        hv = 0 if typ == "cut" else max(1, round(dur * fps / 2))
        lim = max(0, min((frames_of(a, fps) - 2) // 2, (frames_of(b, fps) - 2) // 2))
        hv = min(hv, lim)
        ha = min(max(hv, a_def), lim)
        plan.append((hv, ha, typ if hv else "cut"))
    return plan


@contextmanager
def render_lock(ep: Path):
    """One render per episode at a time (the UI and the CLI may both start one)."""
    (ep / "renders").mkdir(exist_ok=True)
    with open(ep / "renders" / ".lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def version_base(ep: Path) -> str:
    """'2026-03-14-pancakes' -> 'pancakes' (file names of versions: pancakes_v3.mp4)."""
    return re.sub(r"^\d{4}-\d{2}-\d{2}-", "", ep.name) or ep.name


def next_version(ep: Path) -> int:
    nums = [int(m.group(1)) for f in (ep / "renders").glob(f"{version_base(ep)}_v*.mp4")
            if (m := re.search(r"_v(\d+)\.mp4$", f.name))]
    return max(nums, default=0) + 1


PLACEHOLDERS = ("", "Ваш напис", "Your caption")  # default text of a new caption in the UI (uk / en): a draft, never burned in


def load_texts(ep: Path):
    p = ep / "texts.json"
    return json.loads(p.read_text()).get("items", []) if p.exists() else []


def place_texts(items, segs, fps):
    """Absolute start / end of every caption on this timeline (follows its segment when re-edited)."""
    starts, ends, t = {}, {}, 0
    for s in segs:
        starts[s["id"]] = t / fps
        t += frames_of(s, fps)
        ends[s["id"]] = t / fps
    total = t / fps
    placed = []
    for it in items:
        if it.get("hidden") or str(it.get("text", "")).strip() in PLACEHOLDERS or not it.get("hash"):
            continue  # empty or still the UI placeholder: a draft, never burned in
        if it.get("seg_id") and it["seg_id"] not in starts:
            continue  # its shot was removed from the edit: the caption goes with it (comes back if the shot does)
        a = starts.get(it.get("seg_id"))
        a = a + float(it.get("offset", 0)) if a is not None else float(it.get("start", 0))
        e = ends.get(it.get("end_seg"))   # "until the end of that shot": follows the shots when they are re-cut
        b = e - float(it.get("end_pad", 0.15)) if e is not None else a + float(it.get("dur", 3))
        b = min(total, b)
        a = max(0.0, a)
        if b - a >= 0.1:
            placed.append({**it, "start": round(a, 3), "end": round(b, 3)})
    return placed


def text_graph(ep: Path, texts, W, H, fps, total, first_input, src="[vout]", out="[vfinal]"):
    """Overlay caption PNGs (with alpha fades) on top of the finished picture."""
    want = "2160" if H > 1920 else "1080"
    args, g, cur = [], [], src
    for k, it in enumerate(texts):
        files = [ep / "texts" / f"{it['id']}_{it['hash']}_{sz}.png" for sz in (want, "2160", "1080")]
        png = next((f for f in files if f.exists()), None)
        if png is None:
            print(f"caption {it['id']} skipped: no PNG", file=sys.stderr)
            continue
        idx = first_input + len(args) // 8
        args += ["-loop", "1", "-framerate", str(fps), "-t", f"{total + 0.5:.3f}", "-i", str(png)]
        a, b = it["start"], it["end"]
        f = min(float(it.get("fade", 0.25)), (b - a) / 3)
        chain = f"[{idx}:v]format=rgba"
        if not png.name.endswith(f"_{want}.png"):
            chain += f",premultiply=inplace=1,scale={W}:{H}:flags=lanczos,unpremultiply=inplace=1"
        if f > 0.01:
            chain += f",fade=t=in:st={a:.3f}:d={f:.3f}:alpha=1,fade=t=out:st={b - f:.3f}:d={f:.3f}:alpha=1"
        g.append(chain + f"[tx{k}]")
        g.append(f"{cur}[tx{k}]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})':eof_action=pass[vt{k}]")
        cur = f"[vt{k}]"
    g.append(f"{cur}null{out}")
    return ";".join(g), args


def snapshot(edl, out_path: Path, version, note: str, look: str = "natural", grades=None, texts=None):
    """Sidecar with exact timeline positions (and the baked light) of every rendered segment."""
    fps = edl["output"]["fps"]
    segs, t = [], 0
    for s in edl["segments"]:
        if s.get("disabled"):
            continue
        n = frames_of(s, fps)
        g = light.grade_values((grades or {}).get(s["id"]))
        tr = s.get("_trans_in")
        clean = {k: v for k, v in s.items() if k != "_trans_in"}
        segs.append({**clean, "start": round(t / fps, 4), "dur": round(n / fps, 4), "grade": g, "trans_in": tr})
        t += n
    return {"version": version, "file": out_path.name, "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "duration": round(t / fps, 4), "note": note, "look": look, "look_name": LOOKS[look][0],
            "output": edl["output"], "segments": segs, "texts": texts or []}


def render(ep: Path, out_path: Path = None, note: str = "", progress=print, look: str = None,
           edl: dict = None, size=None, quality: str = "standard", grades: dict = None, texts: list = None,
           transitions: dict = None):
    """Render edl.json (or a given edl dict, e.g. a version snapshot) -> MP4.
    Without out_path the result becomes the next version renders/<name>_vN.mp4 (+ sidecar).
    grades: {seg_id: grade}; default = grades.json (auto balance + tweaks from the UI).
    texts: captions; default = texts.json. transitions: per-cut choices; default = transitions.json."""
    with render_lock(ep):
        return _render(ep, out_path, note, progress, look, edl, size, quality, grades, texts, transitions)


def _render(ep, out_path, note, progress, look, edl, size, quality, grades, texts, transitions):
    clips = load_clips(ep)
    if edl is None:
        edl = json.loads((ep / "edl.json").read_text())
    look = look or edl["output"].get("look") or "natural"
    if look not in LOOKS:
        raise ValueError(f"unknown look {look}; known: {', '.join(LOOKS)}")
    out = dict(edl["output"])
    if size:
        out["width"], out["height"] = size
    segs = [dict(s) for s in edl["segments"] if not s.get("disabled")]
    edl = {**edl, "segments": segs}
    (ep / "cache").mkdir(exist_ok=True)
    (ep / "renders").mkdir(exist_ok=True)
    if grades is None:  # auto balance only for the real edit; a custom edl (tests, exports) just reads
        real = [s for s in json.loads((ep / "edl.json").read_text()).get("segments", []) if not s.get("disabled")]
        main = segs == real
        grades = light.refresh(ep) if main else dict(light.load_grades(ep).get("segments", {}))
    fps = out["fps"]
    if transitions is None:
        transitions = load_transitions(ep)
    plan = plan_transitions(segs, clips, out, transitions)
    parts = []
    for i, seg in enumerate(segs):
        clip = clips[seg["clip"]]
        cin = plan[i - 1] if i > 0 else (0, 0, "cut")     # (video half, audio half, type) of the cut into it
        cout = plan[i] if i < len(plan) else (0, 0, "cut")  # ... and of the cut out of it
        pre, post = max(cin[:2]), max(cout[:2])             # handle frames rendered around the shot
        g = grades.get(seg["id"])
        part = ep / "cache" / f"{seg_key(ep, clip, seg, out, pre, post, g)}.mov"
        if not part.exists():
            tmp = part.with_suffix(".tmp.mov")
            render_segment(ep, clip, seg, out, tmp, pre, post, g)
            tmp.rename(part)
        parts.append({"path": part, "pre": pre, "n": frames_of(seg, fps), "v": (cin[0], cout[0]), "a": (cin[1], cout[1]),
                      "type": cin[2]})
        seg["_trans_in"] = {"type": cin[2], "dur": round(2 * cin[0] / fps, 3)} if i > 0 else None
        progress({"stage": "segments", "done": i + 1, "total": len(segs)})
    version = None
    if out_path is None:
        version = next_version(ep)
        out_path = ep / "renders" / f"{version_base(ep)}_v{version}.mp4"
    total = sum(frames_of(s, fps) for s in segs) / fps
    progress({"stage": "encode", "done": 0, "total": round(total, 2)})
    assembly = assemble_graph(parts, fps)
    # colour/light effects run once over the joined video (segment cache stays valid)
    src = "[vcat]"
    pre = ""
    if LOOKS[look][1]:
        pre = f"[vcat]{LOOKS[look][1]}[pre];"
        src = "[pre]"
    graph, extra = fxlib.build_graph(out.get("effects"), out["width"], out["height"], fps, total,
                                     ep / "cache" / "fx", src=src, first_extra_input=len(parts))
    placed = place_texts(load_texts(ep) if texts is None else texts, segs, fps)
    tgraph, targs = text_graph(ep, placed, out["width"], out["height"], fps, total,
                               first_input=len(parts) + len([a for a in extra if a == "-i"]))
    graph += ";" + tgraph
    extra += targs
    inputs = sum((["-i", str(p["path"])] for p in parts), [])
    with_audio = out.get("audio", True)
    if not with_audio:
        assembly += ";[acat]anullsink"
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs, *extra,
           "-filter_complex", assembly + ";" + pre + graph, "-map", "[vfinal]", *(["-map", "[acat]"] if with_audio else []),
           "-c:v", "libx264", *QUALITY[quality],
           "-pix_fmt", "yuv420p", "-r", str(out["fps"]), "-g", str(out["fps"]), "-movflags", "+faststart",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    cmd += ["-c:a", "aac", "-b:a", "192k"] if with_audio else ["-an"]
    cmd += ["-progress", "pipe:1", "-nostats", str(out_path)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    for line in proc.stdout:
        if line.startswith("out_time_us="):
            try:
                progress({"stage": "encode", "done": round(int(line.split("=")[1]) / 1e6, 2), "total": round(total, 2)})
            except ValueError:
                pass
    if proc.wait() != 0:
        raise RuntimeError("final encode failed")
    if version is not None:
        out_path.with_suffix(".json").write_text(json.dumps(
            snapshot({**edl, "output": out}, out_path, version, note, look, grades,
                     [{k: t[k] for k in ("id", "hash", "start", "end", "text")} for t in placed]),
            indent=1, ensure_ascii=False))
    progress({"stage": "done", "file": out_path.name, "duration": round(total, 2)})
    return out_path


def assemble_graph(parts, fps):
    """Cut the cached parts (each = shot + handles) into bodies and transition pieces and join them.
    Video and audio are assembled separately: a cut can be hard for the picture and still have a short
    equal-power crossfade in the sound. parts: [{"path", "pre", "n", "v": (in, out), "a": (in, out)}]
    with half-lengths in frames; every transition is centred on the cut, so shot timings stay exact.
    Output labels: [vcat] [acat]."""
    spf = 48000 / fps
    S = lambda f: int(round(f * spf))  # frame -> audio sample
    g = []
    for kind in ("v", "a"):
        seq = []
        for i, p in enumerate(parts):
            pre, n = p["pre"], p["n"]
            hin, hout = p[kind]
            pieces = []
            if hin:
                pieces.append(("h", pre - hin, pre + hin))
            if n - hin - hout > 0:
                pieces.append(("b", pre + hin, pre + n - hout))
            if hout:
                pieces.append(("t", pre + n - hout, pre + n + hout))
            names = "".join(f"[{kind}{i}{x[0]}s]" for x in pieces)
            src = f"[{i}:{kind}]"
            if kind == "v":
                g.append(f"{src}split={len(pieces)}{names}" if len(pieces) > 1 else f"{src}null{names}")
            else:
                g.append(f"{src}asplit={len(pieces)}{names}" if len(pieces) > 1 else f"{src}anull{names}")
            for name, a, b in pieces:
                if kind == "v":
                    g.append(f"[v{i}{name}s]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS[v{i}{name}]")
                else:
                    g.append(f"[a{i}{name}s]atrim=start_sample={S(a)}:end_sample={S(b)},asetpts=PTS-STARTPTS[a{i}{name}]")
            if hin:
                if kind == "v":
                    g.append(f"[v{i - 1}t][v{i}h]xfade=transition={p.get('type', 'fade')}:duration={2 * hin / fps:.5f}:offset=0[vx{i}]")
                else:
                    g.append(f"[a{i - 1}t][a{i}h]acrossfade=ns={S(2 * hin)}:c1=qsin:c2=qsin[ax{i}]")
                seq.append(f"[{kind}x{i}]")
            if n - hin - hout > 0:
                seq.append(f"[{kind}{i}b]")
        flag = "v=1:a=0" if kind == "v" else "v=0:a=1"
        g.append("".join(seq) + f"concat=n={len(seq)}:{flag}[{kind}cat]")
    return ";".join(g)


def preview_transition(ep: Path, seg_a, seg_b, typ: str, dur: float, dst: Path, side=1.0):
    """Quick 360p preview of one cut from the proxies: last `side` s of A + first `side` s of B,
    transition centred on the cut (frozen frames where the source has no handles). ~1 s to make."""
    clips = load_clips(ep)
    fps, W, H = 30, 360, 640
    h = 0 if typ == "cut" else max(1, round(dur * fps / 2))
    na, nb = min(round(side * fps), frames_of(seg_a, fps)), min(round(side * fps), frames_of(seg_b, fps))
    h = min(h, (na - 2) // 2, (nb - 2) // 2) if h else 0
    chains, inputs = [], []
    for k, (seg, t0f, tot) in enumerate(((seg_a, frames_of(seg_a, fps) - na, na + h), (seg_b, -h, nb + h))):
        c = clips[seg["clip"]]
        speed = float(seg.get("speed", 1))
        pw, ph = (360, 640) if c["height"] >= c["width"] else (640, 360)
        cw, ch, x, y = light.crop_px(c, seg, pw, ph)
        start = seg["in"] + t0f * speed / fps
        miss_pre = max(0, round(-start * fps / speed)) if start < 0 else 0
        start = max(0.0, start)
        inputs += ["-ss", f"{start:.4f}", "-t", f"{tot / fps * speed + 0.5:.4f}", "-i", str(ep / "proxies" / f'{c["id"]}.mp4')]
        chains.append(f"[{k}:v]setpts=(PTS-STARTPTS)/{speed},fps={fps},trim=end_frame={tot - miss_pre},setpts=PTS-STARTPTS,"
                      f"tpad=start={miss_pre}:start_mode=clone:stop=-1:stop_mode=clone,trim=end_frame={tot},"
                      f"crop={cw}:{ch}:{x}:{y},scale={W}:{H},setsar=1,format=yuv420p[p{k}]")
    if h:
        join = f"[p0][p1]xfade=transition={typ}:duration={2 * h / fps:.5f}:offset={(na - h) / fps:.5f}[v]"
    else:
        join = "[p0][p1]concat=n=2:v=1:a=0[v]"
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".part.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(chains) + ";" + join,
                    "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(tmp)], check=True)
    tmp.replace(dst)
    return dst


def export(ep: Path, file: str, preset: str = "4k", progress=print) -> Path:
    """High-quality master of an existing version, rebuilt from the 4K sources with the same edit,
    look and effects: renders/exports/<name>_vN_4k.mp4."""
    meta = json.loads((ep / "renders" / Path(file).with_suffix(".json").name).read_text())
    edl = {"output": meta["output"], "segments": meta["segments"]}
    dst = ep / "renders" / "exports" / f"{Path(file).stem}_{preset}.mp4"
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".part.mp4")
    size = (2160, 3840) if preset == "4k" else None
    baked = {s["id"]: s.get("grade") for s in meta["segments"]}  # the light this version was made with
    caps = [{**t, "seg_id": None, "dur": t["end"] - t["start"]} for t in meta.get("texts", [])]
    trans = {s["id"]: s["trans_in"] for s in meta["segments"] if s.get("trans_in")}
    render(ep, tmp, progress=progress, look=meta.get("look"), edl=edl, size=size,
           quality="4k" if preset == "4k" else "standard", grades=baked, texts=caps, transitions=trans)
    tmp.replace(dst)
    return dst


def sheet(ep: Path, dst: Path, per_row=4):
    """Review sheet: first / middle / last frame of every segment, from the proxies."""
    edl, clips = load(ep)
    seq = ep / "cache" / "sheet"
    seq.mkdir(parents=True, exist_ok=True)
    for old in seq.glob("*.png"):
        old.unlink()
    segs = [s for s in edl["segments"] if not s.get("disabled")]
    fps = edl["output"]["fps"]
    k = 0
    for s in segs:
        for t in (s["in"], (s["in"] + s["out"]) / 2, s["out"] - 1 / fps):
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i",
                            str(ep / "proxies" / f"{s['clip']}.mp4"), "-frames:v", "1", "-vf",
                            "scale=110:196:force_original_aspect_ratio=decrease,pad=110:196:(ow-iw)/2:(oh-ih)/2",
                            str(seq / f"{k:04d}.png")], check=True)
            k += 1
    cols = per_row * 3
    rows = -(-k // cols)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-start_number", "0", "-i", str(seq / "%04d.png"),
                    "-vf", f"tile={cols}x{rows}:padding=3:margin=2:color=white", "-frames:v", "1", str(dst)],
                   check=True)
    print(f"{dst}: {len(segs)} segments, 3 frames each (in / mid / out), {per_row} segments per row")


def looks_sheet(ep: Path, dst: Path, times=None):
    """Rows = looks (order of LOOKS), columns = key frames of the newest versioned render."""
    renders = sorted((ep / "renders").glob("*_v*.json"), key=lambda f: json.loads(f.read_text())["version"])
    meta = json.loads(renders[-1].read_text())
    src = ep / "renders" / meta["file"]
    if times is None:  # middle of 6 evenly spread segments
        segs = meta["segments"]
        times = [segs[round(i * (len(segs) - 1) / 5)]["start"] + segs[round(i * (len(segs) - 1) / 5)]["dur"] / 2
                 for i in range(6)]
    tmp = ep / "cache" / "looks"
    tmp.mkdir(parents=True, exist_ok=True)
    rows = []
    for li, (key, (_, chain)) in enumerate(LOOKS.items()):
        cells = []
        for ti, t in enumerate(times):
            f = tmp / f"{li}_{ti}.png"
            vf = (chain + "," if chain else "") + "scale=216:384"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
                            "-vf", vf, str(f)], check=True)
            cells.append(f)
        row = tmp / f"row_{li}.png"
        inputs = sum((["-i", str(c)] for c in cells), [])
        subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex",
                        f"hstack=inputs={len(cells)},pad=iw:ih+6:0:0:white", str(row)], check=True)
        rows.append(row)
    inputs = sum((["-i", str(r)] for r in rows), [])
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", f"vstack=inputs={len(rows)}",
                    str(dst)], check=True)
    print(f"{dst}: rows = {', '.join(LOOKS)}; columns at t = {', '.join(f'{t:.1f}' for t in times)} s of {meta['file']}")


def main():
    ep = Path(sys.argv[1]).resolve()
    args = sys.argv[2:]
    if "--sheet" in args:
        sheet(ep, Path(args[args.index("--sheet") + 1]))
        return
    if "--looks-sheet" in args:
        looks_sheet(ep, Path(args[args.index("--looks-sheet") + 1]))
        return
    if "--export" in args:
        t = time.time()
        dst = export(ep, args[args.index("--export") + 1], args[args.index("--preset") + 1] if "--preset" in args else "4k",
                     progress=lambda p: None)
        print(f"exported {dst} in {time.time() - t:.1f}s")
        return
    out = Path(args[args.index("--out") + 1]).resolve() if "--out" in args else None
    note = args[args.index("--note") + 1] if "--note" in args else ""
    look = args[args.index("--look") + 1] if "--look" in args else None
    t = time.time()
    path = render(ep, out, note, progress=lambda p: print(p, flush=True) if p["stage"] == "done" else None, look=look)
    print(f"rendered {path} in {time.time() - t:.1f}s")


if __name__ == "__main__":
    main()

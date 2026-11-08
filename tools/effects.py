#!/usr/bin/env python3
"""Effects library: one definition, two implementations that match.

  * ffmpeg filter graph for tools/render.py      (build_graph / segment_motion_filter)
  * WebGL live preview in the review UI          (web/app.js reads effects/library.json + LUT PNGs)

Colour looks are 3D LUTs generated here from small recipes, so the preview and the render use the
very same table (ffmpeg lut3d trilinear == shader trilinear). Light / texture effects use the same
formulas and constants on both sides (blur at 1/4 resolution, same thresholds, same vignette curve).

Usage: python3 tools/effects.py          -> regenerate effects/library.json and effects/luts/*

Effect settings (edl.json "output": {"effects": {...}}), strengths 0..1:
  {"look": {"id": "appetizing", "strength": 0.6}, "glow": 0.3, "diffusion": 0.4, "leak": 0.3,
   "vignette": 0.35, "grain": 0.3, "sharpen": 0.3}
Per segment: "motion": {"pushin": 0.5}  (0.5 -> 6% slow push-in over the segment)
"""
import json, subprocess
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FX_DIR = ROOT / "effects"
LUT_N = 33

# constants shared with the shader (exported to library.json -> app.js)
P = {
    "glow": {"threshold": 0.6, "sigma": 0.02},        # sigma as a fraction of frame height
    "diffusion": {"sigma": 0.007},
    "vignette": {"inner": 0.45, "outer": 1.05},
    "grain": {"amp": 16.0},                          # ±amp in 8-bit luma at strength 1
    "sharpen": {"amount": 0.7},                      # 3x3 unsharp weight at strength 1
    "leak": {"color": [1.0, 0.58, 0.28]},
    "pushin": {"zoom": 0.12},                        # zoom gained over one segment at strength 1
}


# ---------------------------------------------------------------- colour recipes (float RGB 0..1)
def luma(c):
    return c @ np.array([0.2126, 0.7152, 0.0722])


def saturate(c, s):
    y = luma(c)[..., None]
    return y + (c - y) * s


def vibrance(c, v):
    """Boost weak colours more than strong ones (food looks richer without neon reds)."""
    sat = (c.max(-1) - c.min(-1))[..., None]
    return saturate(c, 1 + v * (1 - sat))


def s_curve(c, k):
    """k>0 adds contrast around mid grey, k<0 softens it; endpoints stay 0 and 1."""
    return c + 2 * k * (c - c * c) * (2 * c - 1)


def fade(c, lift=0.0, gain=1.0):
    return lift + c * (gain - lift)


def temperature(c, t):
    """t>0 warmer, t<0 cooler; keeps brightness."""
    y0 = luma(c)
    w = c * np.array([1 + 0.09 * t, 1 + 0.015 * t, 1 - 0.11 * t])
    y1 = luma(w)
    return w * (y0 / np.maximum(y1, 1e-4))[..., None]


def tone(c, shadows=(0, 0, 0), highlights=(0, 0, 0)):
    """Split toning: add a colour offset to shadows / highlights."""
    y = luma(c)[..., None]
    wh = np.clip((y - 0.35) / 0.55, 0, 1) ** 1.5
    ws = np.clip((0.55 - y) / 0.5, 0, 1) ** 1.5
    return c + wh * np.array(highlights) + ws * np.array(shadows)


def gamma(c, g):
    return np.clip(c, 0, 1) ** g


def tame_greens(c, amount, warm=0.0):
    """Desaturate (and slightly warm) green areas, like film stock does."""
    g_mask = np.clip((c[..., 1] - np.maximum(c[..., 0], c[..., 2])) * 5, 0, 1)[..., None]
    out = saturate(c, 1 - amount)
    out = out + np.array([warm, 0, -warm * 0.5])
    return c * (1 - g_mask) + out * g_mask


LOOKS = {
    "appetizing": ("Апетитний", "Соковитіші кольори їжі, трохи більше контрасту й тепла",
                   lambda c: s_curve(vibrance(temperature(c, 0.15), 0.35), 0.10)),
    "warm": ("Теплий", "Легке тепло без зміни яскравості, денне світло стає м'якшим",
             lambda c: vibrance(temperature(c, 0.45), 0.08)),
    "golden": ("Золота година", "Теплі золоті світлі ділянки, ніби вечірнє сонце",
               lambda c: fade(s_curve(tone(temperature(c, 0.55), (0.012, 0.0, -0.01), (0.045, 0.018, -0.05)), 0.07), 0.02)),
    "cream": ("Кремовий", "Ніжні пастельні кольори, підняті тіні, кремові білі",
              lambda c: tone(saturate(s_curve(fade(c, 0.07, 0.965), -0.05), 0.86), (0.0, 0.0, 0.0), (0.02, 0.012, -0.015))),
    "portra": ("Плівка Portra", "М'яка плівкова гама: теплі тони, спокійні зелені, легкий матовий низ",
               lambda c: saturate(tone(tame_greens(fade(s_curve(c, -0.04), 0.035), 0.35, 0.03),
                                       (-0.01, 0.004, 0.016), (0.025, 0.01, -0.03)), 0.95)),
    "vintage": ("Вінтаж", "Вицвіла тепла плівка 70-х",
                lambda c: tone(temperature(saturate(fade(c, 0.08, 0.93), 0.75), 0.5), (0.0, 0.0, 0.0), (0.03, 0.02, -0.05))),
    "fresh": ("Світлий свіжий", "Світліше й чистіше, нейтральні білі",
              lambda c: s_curve(saturate(temperature(gamma(c, 0.9), -0.12), 1.05), 0.05)),
    "evening": ("Затишний вечір", "Темніше й тепліше, ніби під теплою лампою",
                lambda c: tone(s_curve(temperature(gamma(c, 1.12), 0.5), 0.08), (0.0, 0.0, 0.0), (0.03, 0.012, -0.03))),
}

EFFECTS = [  # id, category, name, description, default strength
    ("glow", "light", "М'яке світіння", "Світлі місця м'яко сяють, затишна «мрійливість»", 0.35),
    ("diffusion", "light", "Дифузія", "Як фільтр Pro-Mist: м'якші світлі, легкий серпанок", 0.4),
    ("leak", "light", "Відблиски світла", "Теплі світлові плями повільно пливуть з кутів кадру", 0.35),
    ("vignette", "light", "Віньєтка", "Темніші краї, погляд тягне до центру", 0.35),
    ("grain", "texture", "Плівкове зерно", "Легке живе зерно, як на плівці", 0.3),
    ("sharpen", "texture", "Чіткість", "Чіткіші текстури їжі", 0.35),
    ("pushin", "motion", "Повільний наїзд", "Камера плавно наближається протягом кадру", 0.5),
]

PRESETS = [
    ("none", "Без ефектів", {}),
    ("cozy", "Затишно", {"look": {"id": "golden", "strength": 0.5}, "glow": 0.25, "vignette": 0.3, "grain": 0.2}),
    ("tasty", "Апетитно", {"look": {"id": "appetizing", "strength": 0.6}, "sharpen": 0.35, "vignette": 0.15}),
    ("dreamy", "Мрійливо", {"look": {"id": "cream", "strength": 0.5}, "diffusion": 0.45, "leak": 0.3}),
    ("film", "Плівка", {"look": {"id": "portra", "strength": 0.7}, "grain": 0.4, "vignette": 0.25}),
    ("evening", "Вечір", {"look": {"id": "evening", "strength": 0.6}, "glow": 0.3, "leak": 0.25, "vignette": 0.35}),
]


# English names and descriptions for the UI (library.json name_en / desc_en; web/app.js shows them in English)
LOOKS_EN = {
    "appetizing": ("Appetizing", "Juicier food colors, a little more contrast and warmth"),
    "warm": ("Warm", "Gentle warmth without changing brightness; daylight gets softer"),
    "golden": ("Golden hour", "Warm golden highlights, like the evening sun"),
    "cream": ("Creamy", "Soft pastel colors, lifted shadows, creamy whites"),
    "portra": ("Portra film", "Soft film palette: warm tones, calm greens, slightly matte blacks"),
    "vintage": ("Vintage", "Faded warm 70s film"),
    "fresh": ("Light and fresh", "Brighter and cleaner, neutral whites"),
    "evening": ("Cozy evening", "Darker and warmer, as if under a warm lamp"),
}
EFFECTS_EN = {
    "glow": ("Soft glow", "Highlights glow softly for a cozy, dreamy look"),
    "diffusion": ("Diffusion", "Like a Pro-Mist filter: softer highlights, a light haze"),
    "leak": ("Light leaks", "Warm patches of light drift slowly in from the corners"),
    "vignette": ("Vignette", "Darker edges draw the eye to the center"),
    "grain": ("Film grain", "Light, lively grain, like on film"),
    "sharpen": ("Clarity", "Crisper food textures"),
    "pushin": ("Slow push-in", "The camera moves in smoothly over the shot"),
}
PRESETS_EN = {"none": "No effects", "cozy": "Cozy", "tasty": "Tasty", "dreamy": "Dreamy", "film": "Film", "evening": "Evening"}

# ---------------------------------------------------------------- LUT files
def lut_grid(n=LUT_N):
    """[b][g][r] grid of RGB values (r fastest), the .cube ordering."""
    v = np.linspace(0, 1, n)
    b, g, r = np.meshgrid(v, v, v, indexing="ij")
    return np.stack([r, g, b], axis=-1)


def look_table(look_id, strength=1.0):
    grid = lut_grid()
    out = np.clip(LOOKS[look_id][2](grid.copy()), 0, 1)
    return np.clip(grid + (out - grid) * strength, 0, 1)


def write_cube(table, path: Path):
    n = table.shape[0]
    lines = [f"LUT_3D_SIZE {n}"]
    lines += [f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in table.reshape(-1, 3)]
    path.write_text("\n".join(lines) + "\n")


def write_png(rgb_u8: np.ndarray, path: Path, pix_fmt="rgb24"):
    h, w = rgb_u8.shape[:2]
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", pix_fmt, "-s", f"{w}x{h}",
                    "-i", "-", "-frames:v", "1", str(path)], input=rgb_u8.tobytes(), check=True)


def lut_png(table, path: Path):
    """2D strip for WebGL: x = b_slice * N + r, y = g."""
    n = table.shape[0]
    strip = table.transpose(1, 0, 2, 3).reshape(n, n * n, 3)  # [g][b*n + r]
    write_png(np.round(strip * 255).astype(np.uint8), path)


def generate_library():
    (FX_DIR / "luts").mkdir(parents=True, exist_ok=True)
    looks = []
    for lid, (name, desc, _) in LOOKS.items():
        t = look_table(lid)
        lut_png(t, FX_DIR / "luts" / f"{lid}.png")
        looks.append({"id": lid, "name": name, "desc": desc, "name_en": LOOKS_EN[lid][0], "desc_en": LOOKS_EN[lid][1],
                      "lut": f"luts/{lid}.png", "default": 0.6})
    lib = {
        "lut_size": LUT_N, "params": P, "looks": looks,
        "effects": [{"id": i, "cat": c, "name": n, "desc": d, "name_en": EFFECTS_EN[i][0], "desc_en": EFFECTS_EN[i][1],
                     "default": v} for i, c, n, d, v in EFFECTS],
        "presets": [{"id": i, "name": n, "name_en": PRESETS_EN[i], "fx": fx} for i, n, fx in PRESETS],
    }
    (FX_DIR / "library.json").write_text(json.dumps(lib, ensure_ascii=False, indent=1))
    print(f"effects library: {len(looks)} looks, {len(EFFECTS)} effects, {len(PRESETS)} presets -> {FX_DIR}")


# ---------------------------------------------------------------- ffmpeg side
def vignette_mask(W, H, k, path: Path):
    a = H / W
    x = (np.arange(W) + 0.5) / W - 0.5
    y = ((np.arange(H) + 0.5) / H - 0.5) * a
    d = np.sqrt(x[None, :] ** 2 + y[:, None] ** 2) / np.sqrt(0.25 + 0.25 * a * a)
    e0, e1 = P["vignette"]["inner"], P["vignette"]["outer"]
    s = np.clip((d - e0) / (e1 - e0), 0, 1)
    m = 1 - k * s * s * (3 - 2 * s)
    write_png(np.round(m * 255).astype(np.uint8), path, "gray")


def leak_expr(ch):
    """Same formula as leak() in the shader; X,Y,W,H,T are geq variables."""
    col = P["leak"]["color"][ch]
    a = "(H/W)"
    cx1, cy1 = "(0.05+0.18*sin(0.31*T))", "(0.12+0.07*sin(0.23*T+1.3))"
    cx2, cy2 = "(0.95+0.10*sin(0.19*T+2.0))", "(0.85+0.06*sin(0.27*T))"
    d1 = f"((X/W-{cx1})*(X/W-{cx1})+((Y/H-{cy1})*{a})*((Y/H-{cy1})*{a}))/(0.45*0.45)"
    d2 = f"((X/W-{cx2})*(X/W-{cx2})+((Y/H-{cy2})*{a})*((Y/H-{cy2})*{a}))/(0.35*0.35)"
    return f"255*min(1,{col}*(exp(-2.2*{d1})+0.6*exp(-2.2*{d2})))"


def active(fx):
    fx = fx or {}
    on = {k: float(v) for k, v in fx.items() if k != "look" and isinstance(v, (int, float)) and v > 0.001}
    look = fx.get("look") if isinstance(fx.get("look"), dict) and fx["look"].get("strength", 0) > 0.001 else None
    return look, on


def build_graph(fx, W, H, fps, duration, tmp: Path, src="[0:v]", out="[vout]", first_extra_input=1):
    """Filter-complex chain applying the effects. Returns (graph, extra ffmpeg input args)."""
    look, on = active(fx)
    if not look and not on:
        return f"{src}null{out}", []
    tmp.mkdir(parents=True, exist_ok=True)
    g, extra, n = [], [], [0]
    q = f"{W // 4}:{H // 4}"

    def lab():
        n[0] += 1
        return f"[fx{n[0]}]"

    cur = lab()
    # accurate_rnd: swscale's default rounding darkens every YUV<->RGB conversion by ~2 levels;
    # with it the round trip is lossless and matches the browser's decode exactly (measured)
    acc = ":flags=accurate_rnd+full_chroma_int+bitexact"
    g.append(f"{src}setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,"
             f"scale=in_color_matrix=bt709:in_range=tv{acc},format=gbrp{cur}")
    if "sharpen" in on:
        a = round(P["sharpen"]["amount"] * on["sharpen"], 2)
        A, B = round(a * 100), round(100 + 400 * a)
        m = f"0 -{A} 0 -{A} {B} -{A} 0 -{A} 0"
        nxt = lab()
        g.append(f"{cur}convolution=0m='{m}':1m='{m}':2m='{m}':0rdiv=0.01:1rdiv=0.01:2rdiv=0.01{nxt}")
        cur = nxt
    if look:
        cube = tmp / f"look_{look['id']}_{look['strength']:.3f}.cube"
        if not cube.exists():
            write_cube(look_table(look["id"], look["strength"]), cube)
        nxt = lab()
        g.append(f"{cur}lut3d=file='{cube}':interp=trilinear{nxt}")
        cur = nxt
    if "diffusion" in on:
        s = P["diffusion"]["sigma"] * H / 4
        a, b, bl, nxt = lab(), lab(), lab(), lab()
        g.append(f"{cur}split{a}{b}")
        g.append(f"{b}scale={q}:flags=bilinear,gblur=sigma={s:.3f},scale={W}:{H}:flags=bilinear{bl}")
        g.append(f"{a}{bl}blend=all_mode=lighten:all_opacity={on['diffusion']:.3f}{nxt}")
        cur = nxt
    if "glow" in on:
        s = P["glow"]["sigma"] * H / 4
        t = P["glow"]["threshold"]
        a, b, bl, nxt = lab(), lab(), lab(), lab()
        g.append(f"{cur}split{a}{b}")
        g.append(f"{b}curves=all='0/0 {t}/0 1/1',scale={q}:flags=bilinear,gblur=sigma={s:.3f},"
                 f"scale={W}:{H}:flags=bilinear{bl}")
        g.append(f"{a}{bl}blend=all_mode=screen:all_opacity={on['glow']:.3f}{nxt}")
        cur = nxt
    if "leak" in on:
        lk, nxt = lab(), lab()
        g.append(f"nullsrc=s={W // 4}x{H // 4}:r={fps}:d={duration + 1:.3f},format=gbrp,"
                 f"geq=r='{leak_expr(0)}':g='{leak_expr(1)}':b='{leak_expr(2)}',scale={W}:{H}:flags=bilinear{lk}")
        g.append(f"{cur}{lk}blend=all_mode=screen:all_opacity={on['leak']:.3f}:shortest=1{nxt}")
        cur = nxt
    if "vignette" in on:
        mask = tmp / f"vignette_{W}x{H}_{on['vignette']:.3f}.png"
        if not mask.exists():
            vignette_mask(W, H, on["vignette"], mask)
        idx = first_extra_input + len(extra) // 6
        extra += ["-loop", "1", "-framerate", str(fps), "-i", str(mask)]
        mk, nxt = lab(), lab()
        g.append(f"[{idx}:v]format=gbrp{mk}")
        g.append(f"{cur}{mk}blend=all_mode=multiply:shortest=1{nxt}")
        cur = nxt
    tail = f"scale=out_color_matrix=bt709:out_range=tv{acc},format=yuv420p"
    if "grain" in on:
        amp = P["grain"]["amp"] * on["grain"]
        tail += f",noise=c0s={max(1, round(2 * amp))}:c0f=t+u"
    g.append(f"{cur}{tail}{out}")
    return ";".join(g), extra


def segment_motion_filter(seg, n_frames, pre=0):
    """Slow push-in for one segment (perspective = sub-pixel smooth, no zoompan jitter).
    pre = handle frames rendered before the segment start (zoom stays 1 there)."""
    m = (seg.get("motion") or {}).get("pushin", 0)
    if not m or n_frames < 2:
        return ""
    z = f"(1+{P['pushin']['zoom'] * m:.4f}*max(0\\,in-{pre})/{n_frames - 1})"
    x0, y0 = f"W*(1-1/{z})/2", f"H*(1-1/{z})/2"
    x1, y1 = f"W-W*(1-1/{z})/2", f"H-H*(1-1/{z})/2"
    return (f"perspective=x0='{x0}':y0='{y0}':x1='{x1}':y1='{y0}':x2='{x0}':y2='{y1}':x3='{x1}':y3='{y1}'"
            f":interpolation=cubic:eval=frame,")


def describe(fx, motion_segments=None):
    """Human readable summary, e.g. for version notes."""
    look, on = active(fx)
    names = {e[0]: e[2] for e in EFFECTS}
    parts = []
    if look:
        parts.append(f"{LOOKS[look['id']][0]} {round(look['strength'] * 100)}%")
    parts += [f"{names[k]} {round(v * 100)}%" for k, v in on.items() if k in names]
    if motion_segments:
        parts.append(f"{names['pushin']} на {motion_segments} кадр.")
    return ", ".join(parts) or "без ефектів"


if __name__ == "__main__":
    generate_library()

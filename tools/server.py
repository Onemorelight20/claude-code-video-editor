#!/usr/bin/env python3
"""Review UI: watch rendered versions, leave instructions for Claude.  Stdlib only.

Usage: python3 tools/server.py [--port 8765] [--lan]   ->  http://127.0.0.1:8765
       --lan  also listen on the local network (to review from a phone on the same Wi-Fi)

API
  GET    /api/episodes                         list of episodes
  GET    /api/episodes/<ep>                    clips, shotlog, versions (+timeline), instructions
  POST   /api/episodes/<ep>/instructions       add an instruction
  PATCH  /api/episodes/<ep>/instructions/<id>  edit text / status
  DELETE /api/episodes/<ep>/instructions/<id>
  POST   /api/episodes/<ep>/export             {"file": "pancakes_v4.mp4", "preset": "4k"} -> background export
  POST   /api/episodes/<ep>/render             {"note": "..."} -> new version from edl + grades + texts (background)
  PUT    /api/episodes/<ep>/grades/<seg_id>    {"brightness", "contrast", "temp"} | {"reset": true} -> grades.json
  PUT    /api/episodes/<ep>/texts              {"items": [...]} -> texts.json (captions burned in at render)
  PUT    /api/episodes/<ep>/transitions        {"cuts": {seg_id: {"type", "dur"}}} -> transitions.json
  POST   /api/episodes/<ep>/transition-preview {"file", "seg_id", "type", "dur"} -> 2 s 360p preview from proxies
  POST   /api/episodes/<ep>/segments           {"clip", "in", "out", "mode": "after"|"replace", "target"} -> edl.json
  POST   /api/episodes/<ep>/texts/<id>.png?size=1080|2160&hash=<8 hex>   PNG of a caption, drawn by the browser
  GET    /media/<ep>/<proxies|strips|renders>/<file>   media with HTTP Range (video seeking)
  GET    /download/<ep>/<file>                 the same file as an attachment (renders/ or renders/exports/)
  GET    /effects/<path>                       effects library (library.json, LUT PNGs) for the live preview
  GET    /reference/<file>                     reference videos
Instructions live in episodes/<ep>/instructions.json; Claude reads them with tools/instructions.py.
"""
import hashlib, json, mimetypes, re, socket, sys, threading, time, traceback
from urllib.parse import parse_qs
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import effects  # noqa: E402
import light  # noqa: E402
import render as renderer  # noqa: E402

TOOLS = Path(__file__).resolve().parent
_code_mtime = max(f.stat().st_mtime for f in TOOLS.glob("*.py"))


def fresh_renderer():
    """The server lives for hours while Claude edits tools/*.py. Before a render / export / preview,
    reload the render modules if their code changed, so the UI never renders with stale code
    (a render once silently lost a fix that way)."""
    global _code_mtime
    now = max(f.stat().st_mtime for f in TOOLS.glob("*.py"))
    busy = any(j.get("running") for j in list(renders.values()) + list(exports.values()))
    if now > _code_mtime and not busy:
        import importlib
        for mod in (effects, light, renderer):  # dependency order: render imports effects + light
            importlib.reload(mod)
        _code_mtime = now
        sys.stderr.write("tools reloaded\n")
    return renderer

ROOT = Path(__file__).resolve().parent.parent
EPISODES = ROOT / "episodes"
WEB = ROOT / "web"
MEDIA_DIRS = {"proxies", "strips", "renders", "previews"}
NAME = re.compile(r"^[\w.\- ]+$")
INST_FIELDS = {"anchor", "t", "seg_id", "seg_n", "seg_note", "seg_offset", "clip", "src_t",
               "version", "file", "text", "refs", "status", "effects"}
lock = threading.Lock()
exports = {}  # (episode, file, preset) -> {"running", "stage", "done", "total", "error"}
renders = {}  # episode -> {"running", "stage", "done", "total", "error", "file"}
TEXT_FIELDS = {"id", "text", "font", "weight", "italic", "size", "color", "style", "box", "boxOpacity",
               "outline", "align", "x", "y", "maxWidth", "lineHeight", "upper", "spacing", "seg_id", "offset",
               "start", "dur", "fade", "hash", "hidden", "shadow", "shadowColor", "shadowOpacity",
               "shadowBlur", "shadowDist", "shadowAngle", "end_seg", "end_pad"}


def run_render(name, d, note):
    def progress(p):
        with lock:
            renders[name].update(p)
    try:
        out = renderer.render(d, note=note, progress=progress)
        write_json(d / "renders" / "current.json", {"file": out.name, "why": "зроблено з інтерфейсу: " + note})
        with lock:
            renders[name].update(running=False, stage="done", file=out.name)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        with lock:
            renders[name].update(running=False, stage="error", error=str(e))


def run_export(name, d, file, preset):
    key = (name, file, preset)

    def progress(p):
        with lock:
            exports[key].update(p)
    try:
        renderer.export(d, file, preset, progress=progress)
        with lock:
            exports[key].update(running=False, stage="done")
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        with lock:
            exports[key].update(running=False, stage="error", error=str(e))


def episode_dir(name):
    if not NAME.match(name):
        raise FileNotFoundError(name)
    d = EPISODES / name
    if not (d / "sources.json").exists():
        raise FileNotFoundError(name)
    return d


def read_json(p, default=None):
    return json.loads(p.read_text()) if p.exists() else default


def write_json(p: Path, data):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    tmp.replace(p)  # atomic: Claude may read the file at any moment


def versions_of(d):
    """Rendered versions, newest first. Sidecar <file>.json (from render.py) gives the timeline."""
    out = []
    for f in (d / "renders").glob("*.mp4"):
        meta = read_json(f.with_suffix(".json"), {}) or {}
        ex = {}
        for preset in ("4k",):
            e = d / "renders" / "exports" / f"{f.stem}_{preset}.mp4"
            with lock:
                job = dict(exports.get((d.name, f.name, preset), {}))
            if e.exists():
                ex[preset] = {"file": e.name, "mb": round(e.stat().st_size / 1e6, 1)}
            elif job:
                ex[preset] = {"job": job}
        out.append({
            "exports": ex, "can_export": bool(meta),
            "file": f.name, "version": meta.get("version"), "note": meta.get("note", ""),
            "look_name": meta.get("look_name", ""), "output": meta.get("output"),
            "duration": meta.get("duration"), "segments": meta.get("segments"), "texts": meta.get("texts", []),
            "created": meta.get("created") or time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(f.stat().st_mtime)),
            "mb": round(f.stat().st_size / 1e6, 1), "path": str(f), "mtime": int(f.stat().st_mtime),
        })
    out.sort(key=lambda v: (v["version"] is not None, v["version"] or 0, v["mtime"]), reverse=True)
    return out


def instructions_path(d):
    return d / "instructions.json"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.command != "GET":
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"null")

    def send_file(self, path: Path, cache=True, attachment=None):
        if not path.is_file():
            return self.send_json({"error": "not found"}, 404)
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
        if m:
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            elif m.group(2):
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        if attachment:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(attachment)}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # browser cancelled the request (normal while seeking)

    def route_ep(self, path, suffix=""):
        m = re.fullmatch(r"/api/episodes/([^/]+)" + suffix, path)
        if not m:
            return None, None
        return episode_dir(m.group(1)), m

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path in ("/", "/index.html"):
                return self.send_file(WEB / "index.html", cache=False)
            if re.fullmatch(r"/[\w-]+\.(?:js|css)", path) and (WEB / path[1:]).is_file():   # web/*.js, web/*.css only
                return self.send_file(WEB / path[1:], cache=False)
            if path == "/api/episodes":
                eps = [{"name": d.name, "clips": len(read_json(d / "sources.json")["clips"]),
                        "title": (read_json(d / "edl.json", {}) or {}).get("title"),
                        "versions": len(list((d / "renders").glob("*.mp4")))}
                       for d in (sorted(EPISODES.iterdir()) if EPISODES.is_dir() else []) if (d / "sources.json").exists()]
                return self.send_json(eps)
            d, _ = self.route_ep(path)
            if d:
                clips = [{k: c[k] for k in ("id", "duration", "width", "height", "fps")}
                         for c in read_json(d / "sources.json")["clips"]]
                media = [f.stat().st_mtime for sub in ("proxies", "strips") for f in (d / sub).glob("*")]
                return self.send_json({
                    "name": d.name, "clips": clips,
                    "shotlog": read_json(d / "shotlog.json", {}),
                    "versions": versions_of(d),
                    "current": (read_json(d / "renders" / "current.json", {}) or {}).get("file"),
                    "instructions": read_json(instructions_path(d), {"items": []})["items"],
                    "references": sorted(f.name for f in (ROOT / "reference").glob("*")
                                         if f.suffix.lower() in (".mp4", ".mov")),
                    "strip_step": 1.0,
                    "media_version": int(max(media or [0])),  # bumps when proxies/strips change
                    "grades": light.load_grades(d).get("segments", {}),
                    "texts": read_json(d / "texts.json", {"items": []})["items"],
                    "transitions": read_json(d / "transitions.json", {"cuts": {}}).get("cuts", {}),
                    "edl_segs": [{k: sg.get(k) for k in ("id", "clip", "in", "out", "zoom", "speed", "ramp", "note")}
                                 for sg in read_json(d / "edl.json", {"segments": []})["segments"]
                                 if not sg.get("disabled")],
                    "render_job": dict(renders.get(d.name, {})),
                    "board": read_json(d / "board.json", None),
                })
            m = re.fullmatch(r"/media/([^/]+)/([a-z]+)/([^/]+)", path)
            if m and m.group(2) in MEDIA_DIRS and NAME.match(m.group(3)):
                d = episode_dir(m.group(1))
                return self.send_file(d / m.group(2) / m.group(3), cache=m.group(2) != "renders")
            m = re.fullmatch(r"/download/([^/]+)/([^/]+)", path)
            if m and NAME.match(m.group(2)):
                d = episode_dir(m.group(1))
                f = d / "renders" / m.group(2)
                if not f.exists():
                    f = d / "renders" / "exports" / m.group(2)
                return self.send_file(f, cache=False, attachment=m.group(2))
            m = re.fullmatch(r"/effects/((?:luts/)?[\w.\-]+)", path)
            if m:
                return self.send_file(ROOT / "effects" / m.group(1), cache=False)
            m = re.fullmatch(r"/reference/([^/]+)", path)
            if m and NAME.match(m.group(1)):
                return self.send_file(ROOT / "reference" / m.group(1))
            self.send_json({"error": "not found"}, 404)
        except FileNotFoundError:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        try:
            d, _ = self.route_ep(path, "/export")
        except FileNotFoundError:
            d = None
        if d:
            return self.start_export(d)
        try:
            d, _ = self.route_ep(path, "/render")
        except FileNotFoundError:
            d = None
        if d:
            return self.start_render(d)
        try:
            d, m = self.route_ep(path, r"/texts/([\w-]+)\.png")
        except FileNotFoundError:
            d = None
        if d:
            return self.save_text_png(d, m.group(2))
        for suffix, fn in (("/transition-preview", self.transition_preview), ("/segments", self.add_segment),
                           ("/board/pick", self.board_pick)):
            try:
                d, _ = self.route_ep(path, suffix)
            except FileNotFoundError:
                d = None
            if d:
                return fn(d)
        try:
            d, _ = self.route_ep(path, "/instructions")
        except FileNotFoundError:
            d = None
        if not d:
            return self.send_json({"error": "not found"}, 404)
        data = self.body_json() or {}
        if not str(data.get("text", "")).strip():
            return self.send_json({"error": "порожня вказівка"}, 400)
        with lock:
            p = instructions_path(d)
            doc = read_json(p, {"items": []})
            item = {k: v for k, v in data.items() if k in INST_FIELDS}
            item.update(id="i" + time.strftime("%m%d%H%M%S") + f"{len(doc['items']):02d}",
                        created=time.strftime("%Y-%m-%dT%H:%M:%S"), status="open", reply="", by="user")
            doc["items"].append(item)
            write_json(p, doc)
        self.send_json(item)

    def start_export(self, d):
        data = self.body_json() or {}
        fresh_renderer()
        file, preset = str(data.get("file", "")), str(data.get("preset", "4k"))
        if not NAME.match(file) or not (d / "renders" / Path(file).with_suffix(".json").name).exists() or preset != "4k":
            return self.send_json({"error": "цю версію не можна експортувати"}, 400)
        key = (d.name, file, preset)
        with lock:
            if exports.get(key, {}).get("running"):
                return self.send_json({"ok": True, "already": True})
            exports[key] = {"running": True, "stage": "start", "done": 0, "total": 0}
        threading.Thread(target=run_export, args=(d.name, d, file, preset), daemon=True).start()
        self.send_json({"ok": True})

    def start_render(self, d):
        note = str((self.body_json() or {}).get("note", "")).strip()[:500] or "Нова версія з інтерфейсу"
        fresh_renderer()
        with lock:
            if renders.get(d.name, {}).get("running"):
                return self.send_json({"ok": True, "already": True})
            renders[d.name] = {"running": True, "stage": "start", "done": 0, "total": 0}
        threading.Thread(target=run_render, args=(d.name, d, note), daemon=True).start()
        self.send_json({"ok": True})

    def save_text_png(self, d, tid):
        q = parse_qs(urlparse(self.path).query)
        size, h = (q.get("size") or [""])[0], (q.get("hash") or [""])[0]
        n = int(self.headers.get("Content-Length", 0))
        if size not in ("1080", "2160") or not re.fullmatch(r"[0-9a-f]{8}", h) or not 0 < n < 20_000_000:
            return self.send_json({"error": "bad request"}, 400)
        data = self.rfile.read(n)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return self.send_json({"error": "not a png"}, 400)
        (d / "texts").mkdir(exist_ok=True)
        dst = d / "texts" / f"{tid}_{h}_{size}.png"
        tmp = dst.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(dst)
        self.send_json({"ok": True, "file": dst.name})

    def do_PUT(self):
        path = unquote(urlparse(self.path).path)
        try:
            d, m = self.route_ep(path, r"/grades/([\w-]+)")
        except FileNotFoundError:
            d = None
        if d:
            return self.save_grade(d, m.group(2))
        try:
            d, _ = self.route_ep(path, "/transitions")
        except FileNotFoundError:
            d = None
        if d:
            data = self.body_json() or {}
            cuts = {}
            for sid, v in (data.get("cuts") or {}).items():
                if not re.fullmatch(r"[\w-]{1,40}", str(sid)) or not isinstance(v, dict):
                    continue
                typ = str(v.get("type", "cut"))
                if typ != "cut" and typ not in renderer.TRANSITION_TYPES:
                    continue
                cuts[sid] = {"type": typ, "dur": round(max(0.1, min(2.0, float(v.get("dur", 0.4)))), 2)}
            with lock:
                write_json(d / "transitions.json", {"cuts": cuts})
            return self.send_json({"ok": True, "count": len(cuts)})
        try:
            d, _ = self.route_ep(path, "/texts")
        except FileNotFoundError:
            d = None
        if d:
            data = self.body_json() or {}
            items = [{k: v for k, v in it.items() if k in TEXT_FIELDS} for it in data.get("items", [])
                     if isinstance(it, dict) and re.fullmatch(r"[\w-]{1,40}", str(it.get("id", "")))]
            with lock:
                write_json(d / "texts.json", {"items": items})
            return self.send_json({"ok": True, "count": len(items)})
        self.send_json({"error": "not found"}, 404)

    def transition_preview(self, d):
        data = self.body_json() or {}
        fresh_renderer()
        typ, dur = str(data.get("type", "fade")), float(data.get("dur", 0.4))
        if typ != "cut" and typ not in renderer.TRANSITION_TYPES:
            return self.send_json({"error": "невідомий перехід"}, 400)
        meta = read_json(d / "renders" / Path(str(data.get("file", ""))).with_suffix(".json").name, None) \
            if NAME.match(str(data.get("file", ""))) else None
        segs = (meta or {}).get("segments") or read_json(d / "edl.json", {"segments": []})["segments"]
        segs = [s for s in segs if not s.get("disabled")]
        i = next((k for k, s in enumerate(segs) if s["id"] == data.get("seg_id")), None)
        if not i:
            return self.send_json({"error": "немає такої склейки"}, 400)
        a, b = segs[i - 1], segs[i]
        key = json.dumps([a["clip"], a["in"], a["out"], a.get("zoom"), a.get("x"), a.get("y"),
                          b["clip"], b["in"], b["out"], b.get("zoom"), b.get("x"), b.get("y"), typ, round(dur, 2)])
        name = "tr_" + hashlib.sha1(key.encode()).hexdigest()[:12] + ".mp4"
        dst = d / "previews" / name
        try:
            if not dst.exists():
                renderer.preview_transition(d, a, b, typ, dur, dst)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self.send_json({"error": str(e)}, 500)
        self.send_json({"ok": True, "url": f"/media/{quote(d.name)}/previews/{name}"})

    def add_segment(self, d):
        """A range picked in the footage browser goes straight into edl.json (and the log)."""
        data = self.body_json() or {}
        clips = {c["id"]: c for c in read_json(d / "sources.json")["clips"]}
        c = clips.get(str(data.get("clip", "")))
        try:
            a, b = round(float(data["in"]), 3), round(float(data["out"]), 3)
        except (KeyError, TypeError, ValueError):
            return self.send_json({"error": "потрібні in / out"}, 400)
        if not c or not (0 <= a < b <= c["duration"] + 0.01) or b - a < 0.2:
            return self.send_json({"error": "неправильний діапазон"}, 400)
        mode, target = data.get("mode", "after"), data.get("target") or None
        with lock:
            edl = read_json(d / "edl.json")
            segs = edl["segments"]
            hist = d / "edl_history"
            hist.mkdir(exist_ok=True)
            (hist / f"edl_{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(json.dumps(edl, indent=1, ensure_ascii=False))
            nums = [int(m.group(1)) for s in segs if (m := re.fullmatch(r"s(\d+)", s["id"]))]
            new = {"id": f"s{max(nums, default=0) + 1}", "clip": c["id"], "in": a, "out": b, "speed": 1,
                   "zoom": 1, "x": 0.5, "y": 0.5,
                   "note": str(data.get("note") or "").strip()[:80] or f"{c['id']} {a:.2f}–{b:.2f}"}
            idx = next((k for k, s in enumerate(segs) if s["id"] == target), None)
            if mode == "replace":
                if idx is None:
                    return self.send_json({"error": "немає кадру для заміни"}, 400)
                old = segs[idx]
                new.update(id=old["id"], zoom=old.get("zoom", 1) if old["clip"] == c["id"] else 1,
                           x=old.get("x", 0.5) if old["clip"] == c["id"] else 0.5,
                           y=old.get("y", 0.5) if old["clip"] == c["id"] else 0.5,
                           note=str(data.get("note") or "").strip()[:80] or old.get("note", new["note"]))
                if "volume" in old:   # a muted shot stays muted: the new range may have talk in it too
                    new["volume"] = old["volume"]
                if old["clip"] == c["id"]:   # same clip re-cut: timelapse / slow motion / push-in stay as they were
                    for key in ("speed", "ramp", "motion", "audio_mute"):
                        if key in old:
                            new[key] = old[key]
                segs[idx] = new
                what = f"замінено кадр «{old.get('note', old['id'])}» на {c['id']} {a:.2f}–{b:.2f} с"
            else:
                pos = 0 if idx is None else idx + 1
                segs.insert(pos, new)
                after = "на початок" if idx is None else f"після «{segs[idx].get('note', segs[idx]['id'])}»"
                what = f"додано {c['id']} {a:.2f}–{b:.2f} с {after}"
            write_json(d / "edl.json", edl)
            doc = read_json(instructions_path(d), {"items": []})
            doc["items"].append({"id": "u" + time.strftime("%m%d%H%M%S") + f"{len(doc['items']):02d}",
                                 "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "by": "ui", "anchor": "general",
                                 "text": "З відзнятого матеріалу: " + what, "status": "done",
                                 "reply": "Внесено в монтаж (edl.json). З'явиться в наступній версії — «⟳ Зробити версію».",
                                 "refs": [{"clip": c["id"], "t": a, "t2": b}]})
            write_json(instructions_path(d), doc)
        self.send_json({"ok": True, "segment": new, "what": what})

    def board_pick(self, d):
        """Shot board: candidate N of a step replaces that step's segment in edl.json (backup + log)."""
        data = self.body_json() or {}
        bp = d / "board.json"
        board = read_json(bp, None)
        if not board:
            return self.send_json({"error": "немає дошки кадрів"}, 404)
        step = next((s for s in board.get("steps", []) if s.get("id") == data.get("step")), None)
        try:
            k = int(data.get("cand"))
            cand = step["cands"][k]
            a, b = round(float(cand["in"]), 3), round(float(cand["out"]), 3)
        except (TypeError, ValueError, IndexError, KeyError):
            return self.send_json({"error": "немає такого варіанта"}, 400)
        c = {x["id"]: x for x in read_json(d / "sources.json")["clips"]}.get(cand.get("clip"))
        if not c or not (0 <= a < b <= c["duration"] + 0.01):
            return self.send_json({"error": "неправильний діапазон"}, 400)
        with lock:
            edl = read_json(d / "edl.json")
            segs = edl["segments"]
            idx = next((i for i, sg in enumerate(segs) if sg["id"] == step["seg_id"]), None)
            if idx is None:
                return self.send_json({"error": "цього кадру вже немає в монтажі"}, 409)
            hist = d / "edl_history"
            hist.mkdir(exist_ok=True)
            stamp = time.strftime('%Y%m%d-%H%M%S') + f"_{int(time.time() * 1000) % 1000:03d}"  # several picks a second
            (hist / f"edl_{stamp}.json").write_text(json.dumps(edl, indent=1, ensure_ascii=False))
            look = ("clip", "in", "out", "speed", "zoom", "x", "y", "volume", "audio_mute", "ramp", "motion")
            new = {key: v for key, v in segs[idx].items() if key not in look}
            new.update({"clip": c["id"], "in": a, "out": b, "speed": cand.get("speed", 1), "zoom": cand.get("zoom", 1),
                        "x": cand.get("x", 0.5), "y": cand.get("y", 0.5)})
            for key in ("volume", "audio_mute", "ramp", "motion"):  # sound / motion belong to the candidate
                if key in cand:
                    new[key] = cand[key]
            segs[idx] = new
            write_json(d / "edl.json", edl)
            step["pick"] = k
            write_json(bp, board)
            what = f"«{step.get('title', step['seg_id'])}» — варіант {k + 1}: {c['id']} {a:.2f}–{b:.2f} с"
            doc = read_json(instructions_path(d), {"items": []})
            doc["items"].append({"id": "u" + time.strftime("%m%d%H%M%S") + f"{len(doc['items']):02d}",
                                 "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "by": "ui", "anchor": "general",
                                 "text": "Дошка кадрів: " + what, "status": "done",
                                 "reply": "Внесено в монтаж (edl.json). З'явиться в наступній версії — «⟳ Зробити версію».",
                                 "refs": [{"clip": c["id"], "t": a, "t2": b}]})
            write_json(instructions_path(d), doc)
        self.send_json({"ok": True, "segment": new, "what": what})

    def save_grade(self, d, sid):
        data = self.body_json() or {}
        edl = read_json(d / "edl.json", {"segments": []})
        seg = next((s for s in edl["segments"] if s["id"] == sid), None)
        with lock:
            gd = light.load_grades(d)
            g = gd.setdefault("segments", {}).setdefault(sid, {})
            if seg:
                g["clip"] = seg["clip"]
            if data.get("reset"):
                g.update(brightness=g.get("auto", 0), contrast=0, temp=0, source="auto")
            else:
                lim = {"brightness": 0.8, "contrast": 0.5, "temp": 1.0}
                for k, m in lim.items():
                    if k in data:
                        g[k] = round(max(-m, min(m, float(data[k]))), 3)
                g["source"] = "user"
            light.save_grades(d, gd)
        self.send_json({"ok": True, "grade": g})

    def do_PATCH(self):
        self.edit_item(delete=False)

    def do_DELETE(self):
        self.edit_item(delete=True)

    def edit_item(self, delete):
        path = unquote(urlparse(self.path).path)
        try:
            d, m = self.route_ep(path, r"/instructions/([\w-]+)")
        except FileNotFoundError:
            d = None
        if not d:
            return self.send_json({"error": "not found"}, 404)
        iid = m.group(2)
        data = {} if delete else (self.body_json() or {})
        with lock:
            p = instructions_path(d)
            doc = read_json(p, {"items": []})
            items = doc["items"]
            idx = next((i for i, it in enumerate(items) if it["id"] == iid), None)
            if idx is None:
                return self.send_json({"error": "not found"}, 404)
            if delete:
                items.pop(idx)
            else:
                items[idx].update({k: v for k, v in data.items() if k in ("text", "status")})
                items[idx]["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            write_json(p, doc)
        self.send_json({"ok": True})


def main():
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8765
    host = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"Review UI: http://127.0.0.1:{port}")
    if host == "0.0.0.0":
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("192.0.2.1", 80))  # no packets sent; picks the LAN interface
            print(f"on the phone (same Wi-Fi): http://{s.getsockname()[0]}:{port}")
        except OSError:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

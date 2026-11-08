#!/usr/bin/env python3
"""Instructions left in the review UI (episodes/<ep>/instructions.json): read them and answer.

  python3 tools/instructions.py list   episodes/<ep> [--all]
  python3 tools/instructions.py reply  episodes/<ep> <id> done|question|open "reply" [--version N]
  python3 tools/instructions.py add    episodes/<ep> "text" [--done "reply"] [--version N]   (a note given in chat)
  python3 tools/instructions.py apply-effects episodes/<ep> <id>   (a note from the Effects tab -> edl.json)

`list` resolves every anchor against the current edl.json: which segment it is now, its source clip
and the exact source time, so the instruction can be applied directly.
"""
import json, sys, time
from pathlib import Path


def load(ep):
    p = ep / "instructions.json"
    return p, (json.loads(p.read_text()) if p.exists() else {"items": []})


def save(p, doc):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    tmp.replace(p)


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def cmd_list(ep, show_all):
    _, doc = load(ep)
    edl = json.loads((ep / "edl.json").read_text())
    active = [s for s in edl["segments"] if not s.get("disabled")]
    pos = {s["id"]: i for i, s in enumerate(active)}
    items = [it for it in doc["items"] if show_all or it.get("status") != "done"]
    if not items:
        print("no open notes")
    for it in items:
        print(f"[{it['id']}] {it.get('status', 'open').upper()}  ({it.get('anchor', 'general')}, v{it.get('version')}, {it.get('created', '')})")
        print(f"   text: {it['text']}")
        if it.get("anchor") != "general" and it.get("seg_id"):
            now = pos.get(it["seg_id"])
            where = f"now #{now + 1}" if now is not None else "the segment is no longer in the edl"
            print(f"   where: #{it.get('seg_n')} «{it.get('seg_note')}» at {it.get('t')} s in v{it.get('version')} ({where}); "
                  f"segment {it['seg_id']}, +{it.get('seg_offset')} s; source {it.get('clip')} @ {it.get('src_t')} s")
        for r in it.get("refs") or []:
            span = f"{r['t']}–{r['t2']} s" if r.get("t2") is not None else f"@ {r['t']} s"
            print(f"   ref: {r['clip']} {span}")
        if it.get("effects"):
            print(f"   effects: {json.dumps(it['effects'], ensure_ascii=False)}  -> apply-effects {it['id']}")
        if it.get("reply"):
            print(f"   reply: {it['reply']}")
        print()


def cmd_reply(ep, iid, status, text, version):
    p, doc = load(ep)
    it = next((x for x in doc["items"] if x["id"] == iid), None)
    if not it:
        sys.exit(f"no instruction {iid}")
    it.update(status=status, reply=text, updated=time.strftime("%Y-%m-%dT%H:%M:%S"))
    if version:
        it["reply_version"] = int(version)
    save(p, doc)
    print(f"{iid} -> {status}")


def cmd_add(ep, text, done, version):
    p, doc = load(ep)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    it = {"id": "c" + time.strftime("%m%d%H%M%S") + f"{len(doc['items']):02d}", "created": now, "by": "chat",
          "anchor": "general", "text": text, "status": "open", "reply": ""}
    if done is not None:
        it.update(status="done", reply=done, updated=now)
    if version:
        it["reply_version"] = int(version)
    doc["items"].append(it)
    save(p, doc)
    print(it["id"])


def cmd_apply_effects(ep, iid):
    """Effects chosen in the UI -> edl.json: output.effects (whole video) + per-segment motion."""
    _, doc = load(ep)
    it = next((x for x in doc["items"] if x["id"] == iid), None)
    if not it or not it.get("effects"):
        sys.exit(f"{iid}: no effects in this instruction")
    fx = it["effects"]
    p = ep / "edl.json"
    edl = json.loads(p.read_text())
    edl["output"]["effects"] = fx.get("global") or {}
    push = fx.get("pushin")
    for s in edl["segments"]:
        s.pop("motion", None)
        if push and (push.get("scope") == "all" or s["id"] == push.get("seg_id")):
            s["motion"] = {"pushin": round(float(push["strength"]), 2)}
    p.write_text(json.dumps(edl, indent=1, ensure_ascii=False))
    n = sum(1 for s in edl["segments"] if s.get("motion"))
    print(f"edl.json: effects {edl['output']['effects']}; push-in on {n} segment(s)")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, ep = sys.argv[1], Path(sys.argv[2]).resolve()
    if cmd == "list":
        cmd_list(ep, "--all" in sys.argv)
    elif cmd == "reply":
        cmd_reply(ep, sys.argv[3], sys.argv[4], sys.argv[5], arg("--version"))
    elif cmd == "add":
        cmd_add(ep, sys.argv[3], arg("--done"), arg("--version"))
    elif cmd == "apply-effects":
        cmd_apply_effects(ep, sys.argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()

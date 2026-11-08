"use strict";
// Review UI: watch a rendered version, see its timeline, leave instructions for Claude.
// Editing itself happens on Claude's side (edl.json -> tools/render.py -> new version).

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const enc = encodeURIComponent;
const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (t) => (t == null ? "—" : (Math.round(t * 100) / 100).toFixed(2));
const FPS = 30;
const dpr = window.devicePixelRatio || 1;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
};

const S = {
  ep: null, clips: {}, order: [], shotlog: {}, versions: [], V: null, insts: [],
  stripStep: 1, mv: 0, anchor: "segment", captured: null, draftRefs: [], pps: 40, tlZoom: 1,
  curIdx: -1, sigV: "", sigI: "", editing: null,
};
const video = $("#video");

// ---------- helpers ----------
const proxyUrl = (id) => `/media/${enc(S.ep)}/proxies/${enc(id)}.mp4?v=${S.mv}`;
const stripUrl = (id) => `/media/${enc(S.ep)}/strips/${enc(id)}.jpg?v=${S.mv}`;
const renderUrl = (v) => `/media/${enc(S.ep)}/renders/${enc(v.file)}?v=${v.mtime}`;
const segs = () => (S.V && S.V.segments) || [];
const duration = () => (S.V && S.V.duration) || video.duration || 0;
const vLabel = (v) => (v.version != null ? `v${v.version}` : t("файл"));
// shot names without internal tags like «(вибір користувача)» / «(межі користувача)»
const noteLabel = (n) => String(n || "").replace(/\s*\((?:вибір|межі) користувача(?:[^)]*)\)/g, "").trim();

function thumbStyle(el, id, t, boxW, boxH) {
  const c = S.clips[id];
  if (!c) return;
  const n = Math.max(1, Math.floor(c.duration / S.stripStep) + 1);
  const k = clamp(Math.round(t / S.stripStep), 0, n - 1);
  const fa = c.width / c.height;
  let fw, fh;
  if (fa > boxW / boxH) { fh = boxH; fw = boxH * fa; } else { fw = boxW; fh = boxW / fa; }
  el.style.backgroundImage = `url(${stripUrl(id)})`;
  el.style.backgroundSize = `${n * fw}px ${fh}px`;
  el.style.backgroundPosition = `${-k * fw + (boxW - fw) / 2}px ${(boxH - fh) / 2}px`;
}

function segIndexAt(t) {
  const ss = segs();
  for (let i = 0; i < ss.length; i++) if (t < ss[i].start + ss[i].dur - 1e-6) return i;
  return ss.length - 1;
}
// speed ramp of a shot (same maths as tools/render.py ramp_of / ramp_out): output offset -> source offset
function rampOf(s) {
  const rp = s && s.ramp;
  if (!rp || !(+rp.speed > 1.001)) return null;
  const S = +rp.speed, L = s.out - s.in;
  let h = rp.hold ?? 0.4, r = rp.ease ?? 0.6;
  if (2 * (h + r) > 0.9 * L) { const k = (0.9 * L) / (2 * (h + r)); h *= k; r *= k; }
  return [S, h, r, L, (r * Math.log(S)) / (S - 1), (L - 2 * h - 2 * r) / S];
}
function srcOffset(s, o) {
  const rp = rampOf(s);
  if (!rp) return o * (s.speed || 1);
  const [S, h, r, L, R, P] = rp;
  if (o < h) return o;
  if (o < h + R) return h + (r / (S - 1)) * (Math.exp(((o - h) * (S - 1)) / r) - 1);
  if (o < h + R + P) return h + r + (o - h - R) * S;
  if (o < h + 2 * R + P) { const q = o - h - R - P; return L - h - r + ((S * r) / (S - 1)) * (1 - Math.exp((-q * (S - 1)) / r)); }
  return L - h + (o - (h + 2 * R + P));
}
// where is the playhead: segment, offset inside it, time in the source clip
function posInfo(t) {
  const i = segIndexAt(t);
  const s = segs()[i];
  if (!s) return { t: r2(t) };
  const off = clamp(t - s.start, 0, s.dur);
  return {
    t: r2(t), seg_id: s.id, seg_n: i + 1, seg_note: noteLabel(s.note) || s.clip, seg_offset: r2(off),
    clip: s.clip, src_t: r2(s.in + srcOffset(s, off)),
  };
}
// time of an instruction in the version on screen (segments keep their id between versions)
function anchorTime(it) {
  if (it.anchor === "general" || it.t == null) return null;
  const s = it.seg_id && segs().find((x) => x.id === it.seg_id);
  if (s) return s.start + clamp(it.seg_offset || 0, 0, Math.max(0, s.dur - 0.01));
  if (S.V && it.version === S.V.version) return it.t;
  return null;
}

// ---------- load ----------
// header selects take the width of the chosen option (not of the longest one)
function fitSelect(sel) {
  const opt = sel && sel.selectedOptions[0];
  if (!opt) return;
  const cs = getComputedStyle(sel);
  const c = fitSelect.c || (fitSelect.c = document.createElement("canvas").getContext("2d"));
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 6;
  sel.style.width = Math.ceil(c.measureText(opt.textContent).width + pad) + "px";
}
const fitHeader = () => { fitSelect($("#episode")); fitSelect($("#version")); };
if (document.fonts) document.fonts.ready.then(fitHeader);
const MONTHS = LANG === "en"
  ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  : ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function epLabel(e) {  // "2026-03-14-pancakes" + title "Млинці" -> "Млинці · 14 березня" (EN: "Млинці · March 14")
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(e.name);
  const when = !m ? "" : LANG === "en" ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : `${+m[3]} ${MONTHS[+m[2] - 1]}`;
  return [e.title || e.name.replace(/^\d{4}-\d{2}-\d{2}-/, ""), when].filter(Boolean).join(" · ");
}
async function init() {
  const eps = await (await fetch("/api/episodes")).json();
  const sel = $("#episode");
  sel.innerHTML = eps.map((e) => `<option value="${e.name}">${epLabel(e)}</option>`).join("");
  S.epTitles = Object.fromEntries(eps.map((e) => [e.name, e.title || e.name]));
  const last = store.get("ep");
  const name = eps.some((e) => e.name === last) ? last : eps.length && eps[eps.length - 1].name;
  if (name) { sel.value = name; fitSelect(sel); await loadEpisode(name); }
  sel.onchange = () => { fitSelect(sel); loadEpisode(sel.value); };
  setInterval(poll, 3000);
}

async function fetchEpisode(name) {
  return (await fetch(`/api/episodes/${enc(name)}`)).json();
}

async function loadEpisode(name) {
  const d = await fetchEpisode(name);
  S.ep = name;
  S.clips = {}; S.order = [];
  for (const c of d.clips) { S.clips[c.id] = c; S.order.push(c.id); }
  S.shotlog = d.shotlog || {};
  S.stripStep = d.strip_step || 1;
  S.mv = d.media_version || 0;
  S.V = null;
  store.set("ep", name);
  S.current = d.current;
  if (window.onEpisodeData) window.onEpisodeData(d, true);
  applyVersions(d.versions, true);
  applyInstructions(d.instructions);
  fxInit();  // WebGL preview also serves the light tab
  $("#clipCount").textContent = tn(S.order.length, "{n} кліп", "{n} кліпи", "{n} кліпів");
  renderBrowser();
}

function applyVersions(versions, initial) {
  const sig = versions.map((v) => v.file + v.mtime).join("|");
  if (S.V) S.V = versions.find((v) => v.file === S.V.file) || S.V;
  S.versions = versions;
  renderDownloadMenu();
  if (sig === S.sigV && !initial) return;
  S.sigV = sig;
  S.versions = versions;
  const sel = $("#version");
  sel.innerHTML = versions.map((v) => {
    const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(v.created || "");
    const when = !m ? "" : LANG === "en" ? `${MONTHS[+m[1] - 1].slice(0, 3)} ${+m[2]}, ${m[3]}` : `${+m[2]}.${m[1]}, ${m[3]}`;
    const look = v.look_name && v.look_name !== "натуральний" ? ` · ${t(v.look_name)}` : "";
    const cur = v.file === S.current ? ` · ${t("✓ основна")}` : "";
    return `<option value="${v.file}">${vLabel(v)}${cur}${look} · ${v.duration ? fmt(v.duration) + " " + t("с") : v.mb + " " + t("МБ")} · ${when}</option>`;
  }).join("") || `<option value="">${t("ще немає рендерів")}</option>`;
  const newest = versions[0];
  if (initial || !S.V) {
    // open the version the user picked as the main one (renders/current.json), else the newest
    const pick = versions.find((v) => v.file === S.current) || newest;
    if (pick) setVersion(pick.file);
  } else {
    sel.value = S.V.file;
    fitSelect(sel);
    if (newest && newest.file !== S.V.file && newest.version != null && (S.V.version == null || newest.version > S.V.version)) {
      $("#newVersionName").textContent = vLabel(newest);
      $("#newVersion").classList.remove("hidden");
    }
  }
}

// switching versions keeps the moment on screen, so looks / edits can be compared frame to frame
function setVersion(file) {
  const v = S.versions.find((x) => x.file === file);
  if (!v) return;
  const keep = S.V ? video.currentTime : 0;
  const wasPlaying = !video.paused;
  if (S.V && S.V.file !== file) S.prevFile = S.V.file;
  S.V = v;
  document.title = `${(S.epTitles && S.epTitles[S.ep]) || S.ep} · ${vLabel(v)}`;
  $("#version").value = file;
  $("#versionNote").textContent = v.note || "";
  renderOldVer();
  $("#versionNote").title = v.note || "";
  $("#version").title = v.note ? t("Що змінилось: {note}\n\nКлавіша V — попередня переглянута версія", { note: v.note }) : t("Версія монтажу");
  fitSelect($("#version"));
  $("#newVersion").classList.add("hidden");
  renderDownloadMenu();
  fxOnVersion();
  video.src = renderUrl(v);
  video.addEventListener("loadedmetadata", () => {
    video.currentTime = Math.min(keep, Math.max(0, video.duration - 0.05));
    if (wasPlaying) video.play();
  }, { once: true });
  S.curIdx = -1;
  renderTimeline(); renderScrubTicks(); renderMarks(); renderList(); renderBrowser();
  if (window.onVersionHook) window.onVersionHook();
}

// a version other than the main one (renders/current.json) is open: say so, one click back
function renderOldVer() {
  const b = $("#oldVer"), cur = S.versions.find((v) => v.file === S.current);
  const old = !!(S.V && cur && S.V.file !== cur.file);
  b.classList.toggle("hidden", !old);
  if (old) b.textContent = t("не основна · до {v}", { v: vLabel(cur) });
}
$("#oldVer").onclick = () => { if (S.current) setVersion(S.current); };

function applyInstructions(items) {
  const sig = JSON.stringify(items);
  if (sig === S.sigI) return;
  S.sigI = sig;
  S.insts = items;
  if (!S.editing) renderList();
  renderMarks();
}

async function poll() {
  if (!S.ep || document.hidden) return;
  try {
    const d = await fetchEpisode(S.ep);
    if (d.current !== S.current) { S.current = d.current; S.sigV = ""; renderOldVer(); }
    if (window.onEpisodeData) window.onEpisodeData(d, false);
    applyVersions(d.versions, false);
    applyInstructions(d.instructions);
  } catch (e) { /* server restarting */ }
}

// ---------- player ----------
function togglePlay() { video.paused ? video.play() : video.pause(); }
function seek(t) {
  const d = duration();
  video.currentTime = clamp(t, 0, Math.max(0, d - 0.001));
}
function stepFrame(n) {
  video.pause();
  const f = Math.round(video.currentTime * FPS) + n;
  seek(f / FPS + 0.001);
}
function stepSeg(dir) {
  const ss = segs();
  if (!ss.length) return;
  const i = segIndexAt(video.currentTime);
  if (dir > 0) seek((ss[i + 1] || ss[i]).start + 0.001);
  else if (video.currentTime - ss[i].start > 0.3) seek(ss[i].start + 0.001);
  else seek(ss[Math.max(0, i - 1)].start + 0.001);
}
$("#playBtn").onclick = togglePlay;
$("#frame").onclick = togglePlay;
$("#toStart").onclick = () => { seek(0); video.play(); };
$("#frameBack").onclick = () => stepFrame(-1);
$("#frameFwd").onclick = () => stepFrame(1);
$("#speedBtn").onclick = () => {
  const next = { 1: 0.5, 0.5: 0.25, 0.25: 1 }[video.playbackRate] || 1;
  video.playbackRate = next;
  $("#speedBtn").textContent = next + "×";
};
$("#muteBtn").onclick = () => {
  video.muted = !video.muted;
  store.set("muted", video.muted ? "1" : "0");
  $("#muteBtn").classList.toggle("is-muted", video.muted);
};
$("#loopBtn").onclick = () => {
  video.loop = !video.loop;
  $("#loopBtn").classList.toggle("primary", video.loop);
};
video.addEventListener("play", () => { S.played = true; });
video.muted = store.get("muted") === "1";
$("#muteBtn").classList.toggle("is-muted", video.muted);

// scrubber under the video
function renderScrubTicks() {
  const d = duration();
  $("#scrubSegs").innerHTML = d ? segs().slice(1).map((s) => `<i style="left:${(s.start / d) * 100}%"></i>`).join("") : "";
}
function scrubDrag(el, timeAt) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const wasPlaying = !video.paused;
    video.pause();
    seek(timeAt(e));
    const move = (ev) => seek(timeAt(ev));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (wasPlaying) video.play();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}
scrubDrag($("#scrub"), (e) => {
  const r = $("#scrub").getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration();
});

function frameLoop() {
  const t = video.currentTime, d = duration();
  $("#time").textContent = `${fmt(t)} / ${fmt(d)}`;
  const pct = d ? (t / d) * 100 : 0;
  $("#scrubFill").style.width = pct + "%";
  $("#scrubThumb").style.left = pct + "%";
  $("#tlPlayhead").style.left = t * S.pps + "px";
  if (!video.paused) tlFollow(false);
  $("#playBtn").classList.toggle("is-playing", !video.paused);
  $("#bigPlay").classList.toggle("off", !video.paused || S.played);
  const i = segs().length ? segIndexAt(t) : -1;
  if (i !== S.curIdx) { S.curIdx = i; onSegChange(); if (window.onSegChangeHook) window.onSegChangeHook(); }
  if (window.onFrameHook) window.onFrameHook();
  if (!S.captured) renderAnchorLabel();
  requestAnimationFrame(frameLoop);
}

function onSegChange() {
  $$(".seg.cur").forEach((e) => e.classList.remove("cur"));
  const s = segs()[S.curIdx];
  const el = $(`.seg[data-i="${S.curIdx}"]`);
  if (el) {
    el.classList.add("cur");
    tlFollow(true);
  }
  $("#openSrc").classList.toggle("hidden", !s);
  $("#now .nowActs").classList.toggle("hidden", !s);
  if (window.onNowShot) window.onNowShot(s);
  if (!s) {
    $("#nowNum").textContent = "";
    $("#nowNote").textContent = S.V ? t("Для цього файлу немає таймлайну") : "";
    $("#nowSrc").textContent = "";
    return;
  }
  $("#nowNum").textContent = S.curIdx + 1;
  $("#nowNote").textContent = noteLabel(s.note) || s.clip;
  const sp = s.ramp && +s.ramp.speed > 1 ? t(" · прискорення до {x}× у середині", { x: s.ramp.speed }) : (s.speed || 1) !== 1 ? t(" · швидкість {x}×", { x: s.speed }) : "";
  $("#nowSrc").textContent = t("{a}–{b} с у відео · джерело {clip}, {i}–{o} с", { a: fmt(s.start), b: fmt(s.start + s.dur), clip: s.clip, i: fmt(s.in), o: fmt(s.out) }) + sp;
}
$("#nowTrim").onclick = () => { if (window.editShot && S.curIdx >= 0) window.editShot(S.curIdx); };
$("#nowAlt").onclick = () => {
  const s = segs()[S.curIdx];
  setSideTab("board");
  if (s && window.boardFocus) window.boardFocus(s.id);
};
$("#openSrc").onclick = () => {
  const p = posInfo(video.currentTime);
  if (p.clip) openClip(p.clip, p.src_t);
};

// ---------- timeline ----------
function renderTimeline() {
  const tl = $("#timeline"), ruler = $("#ruler");
  tl.innerHTML = ""; ruler.innerHTML = "";
  const d = duration();
  const avail = $("#tlScroll").clientWidth - 8;
  const th = parseFloat(getComputedStyle(tl).height) || 100;
  if (!segs().length) {
    tl.innerHTML = `<div class="muted small" style="padding:8px">${t("Для цього файлу немає таймлайну (його рендерили без опису версії).")}</div>`;
    S.pps = d ? avail / d : 40;
    $("#tlInfo").textContent = "";
    return;
  }
  S.pps = (avail / d) * S.tlZoom;   // zoom 1 = the whole video fits the width
  $("#tlInfo").textContent = `${tn(segs().length, "{n} кадр", "{n} кадри", "{n} кадрів")} · ${fmt(d)} ${t("с")}`;
  $("#tlFit").disabled = S.tlZoom === 1;
  $("#tlOut").disabled = S.tlZoom <= 1;
  $("#tlIn").disabled = S.tlZoom >= 16;
  segs().forEach((s, i) => {
    const w = s.dur * S.pps;
    const el = document.createElement("div");
    el.className = "seg";
    el.style.width = w + "px";
    el.dataset.i = i;
    el.title = `#${i + 1} ${noteLabel(s.note)}\n`
      + t("{a}–{b} с · {clip} {i}–{o} с", { a: fmt(s.start), b: fmt(s.start + s.dur), clip: s.clip, i: fmt(s.in), o: fmt(s.out) })
      + `\n${t("✎ або подвійний клік — підрізати кадр")}`;
    el.innerHTML = `<div class="th"></div><span class="num">${i + 1}</span>`
      + `<button class="segEdit" title="${t("Підрізати кадр")}">`
      + `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg></button><div class="lab"></div>`;
    el.querySelector(".lab").textContent = noteLabel(s.note) || s.clip;
    const eb = el.querySelector(".segEdit");
    eb.addEventListener("pointerdown", (e) => e.stopPropagation());   // not a scrub
    eb.onclick = (e) => { e.stopPropagation(); if (window.editShot) window.editShot(i); };
    el.addEventListener("dblclick", () => { if (window.editShot) window.editShot(i); });
    thumbStyle(el.querySelector(".th"), s.clip, (s.in + s.out) / 2, w - 2, th);
    tl.appendChild(el);
  });
  const step = S.pps < 14 ? 10 : S.pps < 30 ? 5 : S.pps < 60 ? 2 : 1;
  for (let x = 0; x <= d + 1e-6; x += 0.5) {
    const sp = document.createElement("span");
    const whole = Math.abs(x - Math.round(x)) < 1e-6;
    if (!whole) sp.className = "half";
    else if (Math.round(x) % step === 0) sp.textContent = t("{n}с", { n: Math.round(x) });
    sp.style.left = x * S.pps + "px";
    ruler.appendChild(sp);
  }
  tl.style.width = ruler.style.width = $("#tlMarks").style.width = d * S.pps + 4 + "px";
  S.curIdx = -1;
  if (typeof markPending === "function") markPending();   // honey marks on shots changed since this version
}
// timeline zoom: 1 = whole video fits the width; k = 0 fits again
function tlZoomBy(k) {
  const sc = $("#tlScroll");
  const t = video.currentTime;
  const x = t * S.pps - sc.scrollLeft;          // keep the playhead where it is on screen
  S.tlZoom = k === 0 ? 1 : clamp(S.tlZoom * k, 1, 16);
  renderTimeline(); renderMarks();
  if (typeof renderCapMarks === "function") renderCapMarks();
  if (typeof renderTransMarks === "function") renderTransMarks();
  sc.scrollLeft = Math.max(0, t * S.pps - (S.tlZoom === 1 ? 0 : clamp(x, 40, sc.clientWidth - 40)));
  frameLoopOnce();
}
function frameLoopOnce() { $("#tlPlayhead").style.left = video.currentTime * S.pps + "px"; }
// keep the playhead visible on a zoomed timeline (jump a page ahead while playing, recentre on seeks)
function tlFollow(force) {
  const sc = $("#tlScroll"), x = video.currentTime * S.pps;
  if (x < sc.scrollLeft + 8 || x > sc.scrollLeft + sc.clientWidth - 8) {
    if (force || !video.paused) sc.scrollLeft = Math.max(0, x - (video.paused ? sc.clientWidth / 3 : 24));
  }
}
video.addEventListener("seeked", () => tlFollow(true));
$("#tlIn").onclick = () => tlZoomBy(1.5);
$("#tlOut").onclick = () => tlZoomBy(1 / 1.5);
$("#tlFit").onclick = () => tlZoomBy(0);
$("#tlScroll").addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;     // pinch on a trackpad / ⌘ + wheel = zoom
  e.preventDefault();
  tlZoomBy(Math.exp(-e.deltaY * 0.01));
}, { passive: false });

scrubDrag($("#tlScroll"), (e) => {
  const sc = $("#tlScroll");
  const r = sc.getBoundingClientRect();
  return clamp((e.clientX - r.left + sc.scrollLeft) / S.pps, 0, duration());
});

// markers of instructions on the timeline + scrubber
function renderMarks() {
  const tm = $("#tlMarks"), sm = $("#scrubMarks");
  tm.innerHTML = ""; sm.innerHTML = "";
  $$(".seg.has-open").forEach((e) => e.classList.remove("has-open"));
  const d = duration();
  const colors = { open: "var(--open)", question: "var(--question)", done: "var(--done)" };
  for (const it of S.insts) {
    const t = anchorTime(it);
    if (t == null || !d) continue;
    if (!instShown(it, lastRound())) continue;
    const a = document.createElement("i");
    a.style.left = t * S.pps + "px";
    a.style.background = colors[it.status] || colors.open;
    a.title = it.text;
    tm.appendChild(a);
    const b = document.createElement("i");
    b.style.left = (t / d) * 100 + "%";
    b.style.background = colors[it.status] || colors.open;
    sm.appendChild(b);
    if (it.status !== "done") {
      const el = $(`.seg[data-i="${segIndexAt(t)}"]`);
      if (el) el.classList.add("has-open");
    }
  }
}

// ---------- compose instruction ----------
function anchorText(p, mode) {
  if (mode === "general") return t("все відео");
  if (!p.seg_n) return `${fmt(p.t)} ${t("с")}`;
  return mode === "moment" ? `#${p.seg_n} ${p.seg_note} · ${fmt(p.t)} ${t("с")}` : `#${p.seg_n} ${p.seg_note}`;
}
function renderAnchorLabel() {
  const p = S.captured || posInfo(video.currentTime);
  const txt = anchorText(p, S.anchor);
  const el = $("#anchorLabel");
  if (el.textContent !== txt) el.textContent = txt;
}
$$("#anchorMode button").forEach((b) => (b.onclick = () => {
  S.anchor = b.dataset.a;
  $$("#anchorMode button").forEach((x) => x.classList.toggle("on", x === b));
  renderAnchorLabel();
}));
// typing pins the moment: from then on the anchor no longer follows the playhead
$("#text").addEventListener("focus", () => video.pause());
$("#text").addEventListener("input", () => {
  if (!S.captured && $("#text").value.trim()) S.captured = posInfo(video.currentTime);
  if (!$("#text").value.trim() && !S.draftRefs.length) S.captured = null;
  renderAnchorLabel();
});
// Enter sends, Shift+Enter makes a new line (also in edit mode and the effects comment)
const isSend = (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing;
$("#text").addEventListener("keydown", (e) => {
  if (isSend(e)) { e.preventDefault(); addInstruction(); }
});
$$("#chips button").forEach((b) => (b.onclick = () => {
  const ta = $("#text");
  const add = b.textContent;
  ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, "") + "; " + add : add[0].toUpperCase() + add.slice(1);
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}));
function renderDraftRefs() {
  $("#refs").innerHTML = S.draftRefs.map((r) => `<span class="mono">${r.clip} @ ${fmt(r.t)} ${t("с")}</span>`).join("");
}
async function addInstruction() {
  const text = $("#text").value.trim();
  if (!text) { $("#text").focus(); return; }
  const p = S.captured || posInfo(video.currentTime);
  const body = { anchor: S.anchor, text, refs: S.draftRefs, version: S.V && S.V.version, file: S.V && S.V.file };
  if (S.anchor !== "general") Object.assign(body, p);
  $("#addStatus").textContent = t("зберігаю…");
  const res = await fetch(`/api/episodes/${enc(S.ep)}/instructions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) { $("#addStatus").textContent = t("помилка: {e}", { e: t((await res.json()).error) }); return; }
  $("#text").value = "";
  S.captured = null; S.draftRefs = [];
  renderDraftRefs();
  $("#addStatus").textContent = t("додано ✓");
  setTimeout(() => ($("#addStatus").textContent = ""), 2000);
  await poll();
}
$("#addBtn").onclick = addInstruction;

// ---------- instruction list ----------
const ST = { open: t("нова"), question: t("питання"), done: t("виконано") };
// which done instructions to show: the last round of replies always, older ones only with «усі виконані»
function lastRound() {
  return Math.max(0, ...S.insts.filter((x) => x.status === "done").map((x) => +x.reply_version || 0));
}
function instShown(it, round) {
  if (it.status !== "done" || $("#showDone").checked) return true;
  return round > 0 && +it.reply_version === round;
}
function renderApplyStrip() {
  const n = S.insts.filter((x) => x.status === "open").length;
  $("#applyStrip").classList.toggle("hidden", !n);
  $("#applyText").innerHTML = n ? t("Нових вказівок: <b>{n}</b>. Напиши Claude в чаті «внеси правки».", { n }) : "";
}
$("#applyCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(t("внеси правки")); $("#applyCopy span").textContent = t("Скопійовано"); }
  catch (e) { $("#applyCopy span").textContent = t("не вдалося"); }
  setTimeout(() => { $("#applyCopy span").textContent = t("Копіювати"); }, 1500);
};
$("#showDone").checked = store.get("showDone") === "1";

function renderList() {
  const box = $("#list");
  box.innerHTML = "";
  const round = lastRound();
  const rank = { question: 0, open: 1, done: 2 };
  const items = [...S.insts].sort((a, b) => (rank[a.status] - rank[b.status]) || (a.created < b.created ? 1 : -1));
  const n = (s) => S.insts.filter((x) => x.status === s).length;
  $("#counts").textContent = t("нових {a} · питань {n} · виконано {c}", { a: n("open"), n: n("question"), c: n("done") });
  const waiting = n("open") + n("question");
  $("#notesBadge").textContent = waiting;
  $("#notesBadge").classList.toggle("hidden", !waiting);
  $("#notesBadge").title = t("{a} нових, {n} з питанням", { a: n("open"), n: n("question") });
  const hiddenDone = S.insts.filter((x) => !instShown(x, round)).length;
  $("#showDoneLbl").textContent = !$("#showDone").checked && hiddenDone ? t("усі виконані (ще {n})", { n: hiddenDone }) : t("усі виконані");
  renderApplyStrip();
  for (const it of items) {
    if (!instShown(it, round)) continue;
    const el = document.createElement("div");
    el.className = `inst ${it.status}`;
    el.dataset.id = it.id;
    const at = anchorTime(it);
    const where = it.anchor === "general" || !it.seg_n ? t("все відео")
      : `#${it.seg_n} ${it.seg_note || ""}${it.anchor === "moment" ? " · " + fmt(it.t) + " " + t("с") : ""}`;
    el.innerHTML = `<div class="meta"><span class="st">${ST[it.status] || it.status}</span>
        <span class="${at != null ? "anchor" : ""}"></span><span>${it.version != null ? "v" + it.version : ""}</span>
        <span>${(it.created || "").slice(11, 16)}</span>${it.by === "chat" ? `<span>${t("· з чату")}</span>` : ""}</div>
      <div class="text"></div>${it.reply ? `<div class="reply"><b>Claude${it.reply_version ? " · v" + it.reply_version : ""}:</b> </div>` : ""}
      <div class="act"></div>`;
    el.querySelector(".meta span:nth-child(2)").textContent = where;
    el.querySelector(".text").textContent = it.text;
    if (it.reply) el.querySelector(".reply").append(it.reply);
    const anchor = el.querySelector(".anchor");
    if (anchor) anchor.onclick = () => { video.pause(); seek(at + 0.001); };
    const act = el.querySelector(".act");
    const btn = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; act.appendChild(b); return b; };
    btn(t("✎ редагувати"), () => editItem(el, it, false));
    if (it.status === "done") btn(t("не так, переробити"), () => patch(it.id, { status: "open" }));
    if (it.status === "question") btn(t("відповісти"), () => editItem(el, it, true));
    const tx = el.querySelector(".text");
    tx.title = t("Подвійний клік — редагувати");
    tx.ondblclick = () => editItem(el, it, false);
    const del = btn(t("видалити"), () => {
      if (del.dataset.sure) return remove(it.id);
      del.dataset.sure = "1"; del.textContent = t("точно видалити?"); del.classList.add("danger");
      setTimeout(() => { delete del.dataset.sure; del.textContent = t("видалити"); del.classList.remove("danger"); }, 2500);
    });
    box.appendChild(el);
  }
  if (!box.children.length) box.innerHTML = `<div class="muted small">${t("Поки що вказівок немає. Постав відео на паузу на потрібному кадрі й напиши, що змінити.")}</div>`;
}
function editItem(el, it, answering) {
  S.editing = it.id;
  const ta = document.createElement("textarea");
  ta.value = answering ? it.text + t("\n— ") : it.text;
  ta.rows = Math.min(8, Math.max(2, ta.value.split("\n").length + 1));
  el.querySelector(".text").replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const act = el.querySelector(".act");
  act.innerHTML = "";
  const save = document.createElement("button");
  save.textContent = t("зберегти (Enter)");
  save.className = "primary";
  const cancel = document.createElement("button");
  cancel.textContent = t("скасувати (Esc)");
  act.append(save, cancel);
  const done = () => { S.editing = null; renderList(); };
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    // unchanged text keeps the status; a real edit goes back to Claude as "нова"
    await patch(it.id, text === it.text ? { text } : { text, status: "open" });
    done();
  };
  cancel.onclick = done;
  ta.addEventListener("keydown", (e) => {
    if (isSend(e)) { e.preventDefault(); save.click(); }
    if (e.key === "Escape") { e.preventDefault(); cancel.click(); }
  });
}
async function patch(id, data) {
  await fetch(`/api/episodes/${enc(S.ep)}/instructions/${enc(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  await poll();
}
async function remove(id) {
  await fetch(`/api/episodes/${enc(S.ep)}/instructions/${enc(id)}`, { method: "DELETE" });
  await poll();
}
$("#showDone").onchange = () => { store.set("showDone", $("#showDone").checked ? "1" : "0"); renderList(); renderMarks(); };

// ---------- footage browser + clip viewer ----------
function usage() {
  const m = {};
  segs().forEach((s, i) => (m[s.clip] = m[s.clip] || []).push(i + 1));
  return m;
}
// footage cards grouped by stage; used by the «Матеріал» panel and by the library beside the clip editor.
// The clip open in the editor (S.libSel) is highlighted in both.
function renderLib(box, q, unusedOnly, onPick) {
  q = q.trim().toLowerCase();
  const used = usage();
  box.innerHTML = "";
  let stage = null, cards = null, shown = 0;
  for (const id of S.order) {
    const c = S.clips[id], log = S.shotlog[id] || {};
    if (unusedOnly && used[id]) continue;
    if (q && !`${id} ${log.note || ""} ${log.stage || ""}`.toLowerCase().includes(q)) continue;
    shown++;
    const st = log.stage || t("Без етапу");
    if (st !== stage) {
      stage = st;
      const h = document.createElement("div");
      h.className = "stage";
      h.textContent = st;
      box.appendChild(h);
      cards = document.createElement("div");
      cards.className = "cards";
      box.appendChild(cards);
    }
    const card = document.createElement("div");
    card.className = "card" + (id === S.libSel ? " sel" : "");
    card.dataset.id = id;
    card.innerHTML = `<div class="th">${used[id] ? `<span class="badge">#${used[id].join(" #")}</span>` : ""}<span class="dur">${t("{n}с", { n: fmt(c.duration) })}</span></div>
      <div class="id mono">${id}</div><div class="nt"></div>`;
    card.querySelector(".nt").textContent = log.note || "";
    const th = card.querySelector(".th");
    th._t = c.duration / 2;
    const paint = () => thumbStyle(th, id, th._t, th.clientWidth || 94, th.clientHeight || 167);
    th.onmousemove = (e) => { th._t = clamp(e.offsetX / th.clientWidth, 0, 1) * c.duration; paint(); };
    th.onmouseleave = () => { th._t = c.duration / 2; paint(); };
    card.onclick = () => onPick(id, th._t);
    card.title = `${id}: ${log.note || ""}`;
    cards.appendChild(card);
    paint();
  }
  if (!shown) {
    const e = document.createElement("div");
    e.className = "muted small libEmpty";
    e.textContent = q ? t("Нічого не знайдено за «{q}».", { q }) : t("Нічого не знайдено.");
    box.appendChild(e);
  }
}
function renderBrowser() {
  if (!S.ep) return;
  renderLib($("#browser"), $("#search").value, $("#unusedOnly").checked, (id, t) => openClip(id, t));
  if (!$("#modal").classList.contains("hidden")) renderModalLib();
}
function renderModalLib() {
  renderLib($("#mLibList"), $("#mSearch").value, $("#mUnused").checked,
    (id, t) => (window.switchClip ? window.switchClip(id, t) : openClip(id, t)));
}
// highlight the clip open in the editor without redrawing the lists
function markLibSel(scroll) {
  $$(".card").forEach((c) => c.classList.toggle("sel", c.dataset.id === S.libSel));
  const el = $("#mLibList .card.sel");
  if (el && scroll) el.scrollIntoView({ block: scroll === "center" ? "center" : "nearest" });
}
$("#mSearch").oninput = renderModalLib;
$("#mUnused").onchange = renderModalLib;
$("#search").oninput = renderBrowser;
$("#unusedOnly").onchange = renderBrowser;

const mv = $("#mVideo");
function openClip(id, at) {
  video.pause();
  const log = S.shotlog[id] || {};
  $("#mTitle").textContent = `${id} · ${fmt(S.clips[id].duration)} ${t("с")}`;
  $("#mStage").textContent = log.stage || "";
  $("#mNote").textContent = log.note || "";
  const used = segs().map((s, i) => ({ s, i })).filter((x) => x.s.clip === id);
  $("#mUsed").innerHTML = used.length
    ? t("У монтажі: ") + used.map((x) => `<b>#${x.i + 1}</b> ${fmt(x.s.in)}–${fmt(x.s.out)} ${t("с")}`).join(", ")
    : `<span class='muted'>${t("Цей кліп зараз не в монтажі.")}</span>`;
  mv.dataset.clip = id;
  if (mv.getAttribute("src") !== proxyUrl(id)) mv.src = proxyUrl(id);
  const go = () => { mv.currentTime = clamp(at || 0, 0, S.clips[id].duration - 0.05); };
  if (mv.readyState >= 1) go(); else mv.addEventListener("loadedmetadata", go, { once: true });
  const opening = $("#modal").classList.contains("hidden");
  S.libSel = id;
  $("#modal").classList.remove("hidden");
  if (opening) renderModalLib();
  markLibSel(opening ? "center" : "nearest");
  if (window.onOpenClip) window.onOpenClip(id, at || 0);
}
function closeClip() { mv.pause(); $("#modal").classList.add("hidden"); }
const showClipTime = () => { $("#mTime").textContent = `${mv.dataset.clip} @ ${fmt(mv.currentTime)} ${t("с")}`; };
mv.addEventListener("timeupdate", showClipTime);
mv.addEventListener("seeked", showClipTime);
$("#mClose").onclick = closeClip;
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeClip(); };
$("#mInsert").onclick = () => {
  const ref = { clip: mv.dataset.clip, t: r2(mv.currentTime) };
  const ta = $("#text");
  if (!S.captured) S.captured = posInfo(video.currentTime);
  S.draftRefs.push(ref);
  ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, " ") : "") + `[${ref.clip} @ ${fmt(ref.t)} ${t("с")}] `;
  renderDraftRefs();
  closeClip();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  renderAnchorLabel();
};

// ---------- header ----------
$("#version").onchange = (e) => setVersion(e.target.value);
$("#newVersionBtn").onclick = () => setVersion(S.versions[0].file);
$("#newVersionX").onclick = () => $("#newVersion").classList.add("hidden");

// player full screen (F); captions / effects overlays stay on, they are inside #frame
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if ($("#frame").parentElement.requestFullscreen) $("#frame").parentElement.requestFullscreen().catch(() => {});
}
$("#fullBtn").onclick = (e) => { e.stopPropagation(); toggleFull(); };

// footage panel on the left (M): shown / hidden, remembered per browser
function setLibrary(on) {
  document.body.classList.toggle("lib-off", !on);
  $("#libToggle").setAttribute("aria-pressed", on ? "true" : "false");
  store.set("lib", on ? "1" : "0");
}
setLibrary(store.get("lib") !== "0");
$("#libToggle").onclick = () => setLibrary(document.body.classList.contains("lib-off"));
$("#libClose").onclick = () => setLibrary(false);

// keys & tips (?)
const keysOpen = () => !$("#keysModal").classList.contains("hidden");
function showKeys(on) { $("#keysModal").classList.toggle("hidden", !on); }
$("#helpBtn").onclick = () => showKeys(true);
$("#keysClose").onclick = () => showKeys(false);
$("#keysModal").onclick = (e) => { if (e.target.id === "keysModal") showKeys(false); };

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if ((e.code === "Enter" || e.code === "Space") && e.target.closest && e.target.closest("button, a, summary, [role=tab]")) return;
  if (e.target.matches("input, textarea, select")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (keysOpen()) {
    if (e.key === "Escape" || e.key === "?") { e.preventDefault(); showKeys(false); }
    return;
  }
  if (!$("#modal").classList.contains("hidden")) {
    if (e.key === "Escape") closeClip();
    return;
  }
  if (e.key === "?") { e.preventDefault(); showKeys(true); return; }
  if (e.code === "KeyB" && !e.repeat && (FX.active() || (window.gradeDeltaActive && window.gradeDeltaActive()))) { setBefore(true); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.code) {
    case "Space": e.preventDefault(); togglePlay(); break;
    case "ArrowLeft": e.preventDefault(); e.shiftKey ? stepSeg(-1) : stepFrame(-1); break;
    case "ArrowRight": e.preventDefault(); e.shiftKey ? stepSeg(1) : stepFrame(1); break;
    case "Home": e.preventDefault(); seek(0); video.play(); break;
    case "KeyN": case "Enter":
      e.preventDefault();
      if (S.sideTab === "text" && !$("#tEditor").classList.contains("hidden")) { $("#tText").focus(); break; }
      if (S.sideTab && S.sideTab !== "notes") setSideTab("notes");
      $("#text").focus();
      break;
    case "KeyV": if (S.prevFile) setVersion(S.prevFile); break;
    case "KeyM": setLibrary(document.body.classList.contains("lib-off")); break;
    case "KeyF": toggleFull(); break;
    case "Equal": case "NumpadAdd": tlZoomBy(1.5); break;
    case "Minus": case "NumpadSubtract": tlZoomBy(1 / 1.5); break;
    case "Digit0": case "Numpad0": tlZoomBy(0); break;
    default: return;
  }
});
// buttons must not keep focus, otherwise Space would "click" them instead of play/pause
document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) b.blur(); });

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderTimeline(); renderMarks(); }, 150);
});
video.addEventListener("loadedmetadata", () => { if (!segs().length) { renderTimeline(); renderScrubTicks(); } });

// ---------- download ----------
function renderDownloadMenu() {
  const m = $("#dlMenu");
  const v = S.V;
  if (!v) { m.innerHTML = `<div class="muted small">${t("Немає версії")}</div>`; return; }
  const name = vLabel(v);
  const dl = (f) => `/download/${enc(S.ep)}/${enc(f)}`;
  let html = `<a class="opt" href="${dl(v.file)}" download><b>${name} · 1080×1920 · ${v.mb} ${t("МБ")}</b>
      <span class="muted small">${t("Оптимально для TikTok: H.264, ~15 Мбіт/с, оригінальний звук")}</span></a>`;
  const ex = (v.exports || {})["4k"];
  if (ex && ex.file) {
    html += `<a class="opt" href="${dl(ex.file)}" download><b>${name} · 4K 2160×3840 · ${ex.mb} ${t("МБ")}</b>
      <span class="muted small">${t("Максимальна якість: зібрано наново з 4K-оригіналів")}</span></a>`;
  } else if (ex && ex.job && ex.job.running) {
    const j = ex.job;
    const pct = j.stage === "segments" ? (j.done / (j.total || 1)) * 55 : j.stage === "encode" ? 55 + (j.done / (j.total || 1)) * 45 : 2;
    html += `<div class="opt"><b>${t("4K: збираю з оригіналів… {p}%", { p: Math.round(pct) })}</b>
      <span class="muted small">${t("~1–3 хв, можна закрити меню")}</span><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  } else if (v.can_export) {
    html += `<button class="opt" id="mk4k"><b>${t("Зробити 4K-версію (≈2 хв)")}</b>
      <span class="muted small">${t("2160×3840 з оригінальних кліпів, ~200 МБ")}${ex && ex.job && ex.job.error ? t(" · минулого разу помилка: {e}", { e: ex.job.error }) : ""}</span></button>`;
  }
  html += `<div class="muted small" style="padding:2px 4px">${t("На телефон: запусти <span class=\"mono\">python3 tools/server.py --lan</span> і відкрий адресу з iPhone в тій самій Wi-Fi, тоді файл завантажиться одразу на телефон.")}</div>`;
  m.innerHTML = html;
  const mk = $("#mk4k");
  if (mk) mk.onclick = async (e) => {
    e.stopPropagation();
    await fetch(`/api/episodes/${enc(S.ep)}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: v.file, preset: "4k" }),
    });
    await poll();
  };
}
$("#dlBtn").onclick = (e) => { e.stopPropagation(); renderDownloadMenu(); $("#dlMenu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest(".dl")) $("#dlMenu").classList.add("hidden"); });

// ---------- side tabs ----------
$$("#sideTabs button").forEach((b) => (b.onclick = () => setSideTab(b.dataset.tab)));
function setSideTab(tab) {
  S.sideTab = tab;
  $$("#sideTabs button").forEach((x) => { x.classList.toggle("on", x.dataset.tab === tab); x.setAttribute("aria-selected", x.dataset.tab === tab ? "true" : "false"); });
  for (const [t, id] of [["notes", "#tabNotes"], ["board", "#tabBoard"], ["light", "#tabLight"], ["text", "#tabText"], ["trans", "#tabTrans"], ["fx", "#tabFx"]]) {
    $(id).classList.toggle("hidden", t !== tab);
  }
  if (tab === "fx") fxInit().then(() => { fxRender(); fxThumbs(); });
  if (window.onSideTab) window.onSideTab(tab);
}

// ---------- effects library: live WebGL preview ----------
// Same maths as tools/effects.py: colour looks are the same 3D LUTs (trilinear), blur at 1/4 res
// with the same sigma, same glow threshold, vignette curve, light-leak path and grain amplitude.
const FX = {
  lib: null, gl: null, ready: false, before: false, thumbsTimer: null,
  st: { look: null, lookK: 0.6, k: {}, on: {}, pushScope: "all", pushSeg: null },
  active() { return !!(this.st.look || Object.keys(this.st.on).some((id) => this.st.on[id])); },
};
const fxCanvas = $("#fxCanvas");

async function fxInit() {
  if (FX.lib) return;
  FX.lib = await (await fetch("/effects/library.json")).json();
  for (const e of FX.lib.effects) { FX.st.k[e.id] = e.default; FX.st.on[e.id] = false; }
  buildFxUI();
  FX.ready = glInit();
  if (!FX.ready) $("#fxStatus").textContent = t("WebGL2 недоступний у цьому браузері: прев'ю не працюватиме, але вказівку надіслати можна.");
  video.addEventListener("seeked", () => { fxRender(); fxThumbsSoon(); });
  video.addEventListener("pause", fxThumbsSoon);
  const loop = () => { fxRender(); video.requestVideoFrameCallback(loop); };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
  else (function raf() { if (!video.paused) fxRender(); requestAnimationFrame(raf); })();
}

const VS = `#version 300 es
out vec2 uv; void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); uv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;
const FS = {
  a: `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uVideo, uLut; uniform vec2 uPx; uniform float uSharp, uLookK, uN, uZoom, uGB, uGC, uGT;
vec3 vid(vec2 p){ return texture(uVideo, p).rgb; }
// per-segment light, same maths as tools/light.py grade_rgb (here as a delta to what the version has baked)
vec3 gradeC(vec3 c){
  if (uGT != 0.0) {
    float t = 0.5*uGT; vec3 Y = vec3(0.2126, 0.7152, 0.0722);
    vec3 w = c*vec3(1.0+0.09*t, 1.0+0.015*t, 1.0-0.11*t);
    c = clamp(w*(dot(c, Y)/max(dot(w, Y), 1e-4)), 0.0, 1.0);
  }
  if (uGB != 0.0) c = pow(max(c, vec3(0.0)), vec3(exp2(-uGB)));
  if (uGC != 0.0) { float k = 0.3*uGC; c = c + 2.0*k*(c - c*c)*(2.0*c - 1.0); }
  return clamp(c, 0.0, 1.0);
}
vec3 lut(vec3 c){
  float n = uN; float b = clamp(c.b,0.,1.)*(n-1.); float z0 = floor(b); float z1 = min(z0+1., n-1.); float f = b - z0;
  vec2 rg = clamp(c.rg,0.,1.)*(n-1.) + 0.5;
  vec3 s0 = texture(uLut, vec2((rg.x + z0*n)/(n*n), rg.y/n)).rgb;
  vec3 s1 = texture(uLut, vec2((rg.x + z1*n)/(n*n), rg.y/n)).rgb;
  return mix(s0, s1, f);
}
void main(){
  vec2 p = 0.5 + (uv - 0.5) / uZoom;
  vec3 c = vid(p);
  if (uSharp > 0.0) {
    vec2 d = uPx / uZoom;
    vec3 nb = vid(p+vec2(d.x,0.)) + vid(p-vec2(d.x,0.)) + vid(p+vec2(0.,d.y)) + vid(p-vec2(0.,d.y));
    c = clamp(c*(1.0+4.0*uSharp) - uSharp*nb, 0.0, 1.0);
  }
  if (uGB != 0.0 || uGC != 0.0 || uGT != 0.0) c = gradeC(c);
  if (uLookK > 0.0) c = mix(c, lut(c), uLookK);
  o = vec4(c, 1.0);
}`,
  down: `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uSrc; uniform float uT;
void main(){ vec3 c = texture(uSrc, uv).rgb; if (uT > 0.0) c = max(c - uT, 0.0) / (1.0 - uT); o = vec4(c, 1.0); }`,
  blur: `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uDir; uniform float uSigma;
void main(){
  int r = int(ceil(3.0*uSigma)); vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -40; i <= 40; i++) { if (i < -r || i > r) continue;
    float w = exp(-0.5*float(i*i)/(uSigma*uSigma)); acc += w*texture(uSrc, uv + uDir*float(i)).rgb; ws += w; }
  o = vec4(acc/ws, 1.0);
}`,
  diff: `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uBase, uBlur; uniform float uK;
void main(){ vec3 a = texture(uBase, uv).rgb, b = texture(uBlur, uv).rgb; o = vec4(mix(a, max(a, b), uK), 1.0); }`,
  fin: `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uBase, uGlow; uniform float uGlowK, uLeakK, uVigK, uGrainK, uTime, uFrame, uVigIn, uVigOut, uGrainAmp;
uniform vec2 uRes; uniform vec3 uLeakCol;
vec3 screen(vec3 a, vec3 b){ return 1.0 - (1.0-a)*(1.0-b); }
void main(){
  vec3 c = texture(uBase, uv).rgb;
  if (uGlowK > 0.0) c = mix(c, screen(c, texture(uGlow, uv).rgb), uGlowK);
  vec2 im = vec2(uv.x, 1.0 - uv.y); float a = uRes.y / uRes.x;
  if (uLeakK > 0.0) {
    vec2 c1 = vec2(0.05+0.18*sin(0.31*uTime), 0.12+0.07*sin(0.23*uTime+1.3));
    vec2 c2 = vec2(0.95+0.10*sin(0.19*uTime+2.0), 0.85+0.06*sin(0.27*uTime));
    vec2 v1 = vec2(im.x-c1.x, (im.y-c1.y)*a), v2 = vec2(im.x-c2.x, (im.y-c2.y)*a);
    vec3 L = min(vec3(1.0), uLeakCol*(exp(-2.2*dot(v1,v1)/(0.45*0.45)) + 0.6*exp(-2.2*dot(v2,v2)/(0.35*0.35))));
    c = mix(c, screen(c, L), uLeakK);
  }
  if (uVigK > 0.0) {
    float d = length(vec2(im.x-0.5, (im.y-0.5)*a)) / sqrt(0.25 + 0.25*a*a);
    c *= 1.0 - uVigK * smoothstep(uVigIn, uVigOut, d);
  }
  if (uGrainK > 0.0) {
    float n = fract(sin(dot(gl_FragCoord.xy + uFrame*vec2(17.13, 41.7), vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * 2.0 * uGrainAmp * uGrainK * 1.164 / 255.0;
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
};

function glInit() {
  const gl = fxCanvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return false;
  FX.gl = gl;
  FX.float = !!gl.getExtension("EXT_color_buffer_float");
  const compile = (type, src) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  FX.prog = {};
  for (const [k, src] of Object.entries(FS)) {
    const pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, src));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    FX.prog[k] = { pr, loc: {} };
  }
  FX.vao = gl.createVertexArray();
  FX.tex = { video: mkTex(), white: mkTex() };
  gl.bindTexture(gl.TEXTURE_2D, FX.tex.white);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  FX.luts = {};
  for (const l of FX.lib.looks) {
    const img = new Image();
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, FX.luts[l.id] = mkTex());
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      fxRender(); fxThumbsSoon();
    };
    img.src = `/effects/${l.lut}`;
  }
  return true;
}
function mkTex() {
  const gl = FX.gl, t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function mkTarget(w, h, float) {
  const gl = FX.gl, tex = mkTex();
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb, w, h };
}
function ensureTargets(W, H) {
  if (FX.size === `${W}x${H}`) return;
  FX.size = `${W}x${H}`;
  fxCanvas.width = W; fxCanvas.height = H;
  FX.t = { a: mkTarget(W, H, FX.float), b: mkTarget(W, H, FX.float),
           q0: mkTarget(W >> 2, H >> 2, FX.float), q1: mkTarget(W >> 2, H >> 2, FX.float) };
}
// draw a full-screen pass: textures bound in order to units 0..n
function pass(name, target, w, h, tex, uni) {
  const gl = FX.gl, P = FX.prog[name];
  gl.useProgram(P.pr);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
  gl.viewport(0, 0, w, h);
  Object.entries(tex).forEach(([k, t], i) => {
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(P.loc[k] ??= gl.getUniformLocation(P.pr, k), i);
  });
  for (const [k, v] of Object.entries(uni)) {
    const loc = P.loc[k] ??= gl.getUniformLocation(P.pr, k);
    if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, loc, v); else gl.uniform1f(loc, v);
  }
  gl.bindVertexArray(FX.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function fxZoom() {
  const k = FX.st.on.pushin ? FX.st.k.pushin : 0;
  if (!k || !segs().length) return 1;
  const i = segIndexAt(video.currentTime), s = segs()[i];
  if (FX.st.pushScope === "one" && s.id !== FX.st.pushSeg) return 1;
  const p = clamp((video.currentTime - s.start) / Math.max(1 / FPS, s.dur - 1 / FPS), 0, 1);
  return 1 + FX.lib.params.pushin.zoom * k * p;
}
// one frame of the effect chain; target null = on screen canvas
function fxDraw(look, lookK, opt, target) {
  const gl = FX.gl, W = video.videoWidth, H = video.videoHeight, t = FX.t, P = FX.lib.params;
  const k = (id) => (opt.only ? 0 : FX.st.on[id] ? FX.st.k[id] : 0);
  const lutTex = (look && FX.luts[look]) || FX.tex.white;
  const gd = (!opt.only && window.gradeDelta && window.gradeDelta()) || { b: 0, c: 0, t: 0 };
  pass("a", t.a, W, H, { uVideo: FX.tex.video, uLut: lutTex },
       { uPx: [1 / W, 1 / H], uSharp: P.sharpen.amount * k("sharpen"), uLookK: look && FX.luts[look] ? lookK : 0,
         uN: FX.lib.lut_size, uZoom: opt.only ? 1 : fxZoom(), uGB: gd.b, uGC: gd.c, uGT: gd.t });
  let base = t.a;
  const q = [W >> 2, H >> 2];
  const blur = (src, sigma) => {
    pass("down", t.q0, q[0], q[1], { uSrc: src.tex }, { uT: sigma.t || 0 });
    pass("blur", t.q1, q[0], q[1], { uSrc: t.q0.tex }, { uDir: [1 / q[0], 0], uSigma: sigma.s });
    pass("blur", t.q0, q[0], q[1], { uSrc: t.q1.tex }, { uDir: [0, 1 / q[1]], uSigma: sigma.s });
  };
  if (k("diffusion")) {
    blur(base, { s: P.diffusion.sigma * H / 4 });
    pass("diff", t.b, W, H, { uBase: base.tex, uBlur: t.q0.tex }, { uK: k("diffusion") });
    base = t.b;
  }
  if (k("glow")) blur(base, { s: P.glow.sigma * H / 4, t: P.glow.threshold });
  pass("fin", target, target ? target.w : W, target ? target.h : H, { uBase: base.tex, uGlow: t.q0.tex },
       { uGlowK: k("glow"), uLeakK: k("leak"), uVigK: k("vignette"), uGrainK: k("grain"), uTime: video.currentTime,
         uFrame: Math.round(video.currentTime * FPS), uVigIn: P.vignette.inner, uVigOut: P.vignette.outer,
         uGrainAmp: P.grain.amp, uRes: [W, H], uLeakCol: P.leak.color });
}
function uploadVideo() {
  const gl = FX.gl;
  gl.bindTexture(gl.TEXTURE_2D, FX.tex.video);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
}
function fxRender() {
  const fxOn = FX.active(), lightOn = !!(window.gradeDeltaActive && window.gradeDeltaActive());
  const show = FX.ready && (fxOn || lightOn) && !FX.before;
  fxCanvas.classList.toggle("hidden", !show);
  $("#fxBadge").classList.toggle("hidden", !show);
  $("#fxBadge").textContent = fxOn ? t("ефекти · прев'ю") : t("світло · прев'ю");
  if (!show || video.readyState < 2 || !video.videoWidth) return;
  ensureTargets(video.videoWidth, video.videoHeight);
  uploadVideo();
  fxDraw(FX.st.look, FX.st.lookK, {}, null);
}
// colour thumbnails: every look applied to the current frame
function fxThumbsSoon() { clearTimeout(FX.thumbsTimer); FX.thumbsTimer = setTimeout(fxThumbs, 120); }
function fxThumbs() {
  if (!FX.ready || $("#tabFx").classList.contains("hidden") || video.readyState < 2 || !video.videoWidth) return;
  const gl = FX.gl, W = video.videoWidth, H = video.videoHeight;
  ensureTargets(W, H);
  uploadVideo();
  const tw = 90, th = 160;
  FX.thumbT ??= mkTarget(tw, th, false);
  const buf = new Uint8Array(tw * th * 4);
  for (const el of $$(".look")) {
    const id = el.dataset.id || null;
    if (id && !FX.luts[id]) continue;
    fxDraw(id, id ? 1 : 0, { only: true }, FX.thumbT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, FX.thumbT.fb);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const cv = el.querySelector("canvas");
    cv.width = tw; cv.height = th;
    const img = new ImageData(tw, th);
    for (let y = 0; y < th; y++) img.data.set(buf.subarray((th - 1 - y) * tw * 4, (th - y) * tw * 4), y * tw * 4);
    cv.getContext("2d").putImageData(img, 0, 0);
  }
  fxRender();
}

// ---------- effects UI ----------
// names and descriptions come from effects/library.json (tools/effects.py); English ones are name_en / desc_en
const fxName = (x) => (LANG === "en" && x.name_en) || x.name;
const fxDesc = (x) => (LANG === "en" && x.desc_en) || x.desc;
function buildFxUI() {
  const L = FX.lib;
  $("#fxPresets").innerHTML = "";
  for (const p of L.presets) {
    const b = document.createElement("button");
    b.textContent = fxName(p);
    b.onclick = () => applyPreset(p.fx);
    $("#fxPresets").appendChild(b);
  }
  const grid = $("#fxLooks");
  grid.innerHTML = "";
  for (const l of [{ id: "", name: t("Без кольору"), desc: t("Як у версії") }, ...L.looks]) {
    const el = document.createElement("div");
    el.className = "look" + (!l.id ? " on" : "");
    el.dataset.id = l.id;
    el.title = fxDesc(l);
    el.innerHTML = `<canvas></canvas><div class="ln"></div>`;
    el.querySelector(".ln").textContent = fxName(l);
    el.onclick = () => {
      FX.st.look = l.id || null;
      if (l.id && !FX.st.lookTouched) FX.st.lookK = l.default;
      syncFxUI(); fxRender();
    };
    grid.appendChild(el);
  }
  $("#lookK").oninput = (e) => { FX.st.lookK = e.target.value / 100; FX.st.lookTouched = true; syncFxUI(); fxRender(); };
  const boxes = { light: $("#fxLight"), texture: $("#fxTexture"), motion: $("#fxMotion") };
  Object.values(boxes).forEach((b) => (b.innerHTML = ""));
  for (const e of L.effects) {
    const row = document.createElement("div");
    row.className = "fxRow off";
    row.dataset.id = e.id;
    row.innerHTML = `<input type="checkbox"><span class="nm"></span><span class="pct mono"></span>
      <span></span><input type="range" min="0" max="100"><span></span><span class="ds"></span>`;
    row.querySelector(".nm").textContent = fxName(e);
    row.querySelector(".ds").textContent = fxDesc(e);
    const cb = row.querySelector("input[type=checkbox]"), rg = row.querySelector("input[type=range]");
    cb.onchange = () => {
      FX.st.on[e.id] = cb.checked;
      if (e.id === "pushin" && cb.checked && FX.st.pushScope === "one") FX.st.pushSeg = posInfo(video.currentTime).seg_id;
      syncFxUI(); fxRender();
    };
    rg.oninput = () => { FX.st.k[e.id] = rg.value / 100; FX.st.on[e.id] = true; syncFxUI(); fxRender(); };
    if (e.id === "pushin") {
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="all">${t("на всі кадри")}</option><option value="one">${t("лише на поточний кадр")}</option>`;
      sel.onchange = () => {
        FX.st.pushScope = sel.value;
        FX.st.pushSeg = sel.value === "one" ? posInfo(video.currentTime).seg_id : null;
        syncFxUI(); fxRender();
      };
      row.appendChild(sel);
    }
    boxes[e.cat].appendChild(row);
  }
  $("#fxCompare").onpointerdown = () => setBefore(true);
  $("#fxCompare").onpointerup = $("#fxCompare").onpointerleave = () => setBefore(false);
  $("#fxReset").onclick = () => applyPreset({});
  $("#fxSend").onclick = sendFx;
  $("#fxNote").addEventListener("keydown", (e) => { if (isSend(e)) { e.preventDefault(); sendFx(); } });
  syncFxUI();
  fxOnVersion();
}
function applyPreset(fx) {
  for (const e of FX.lib.effects) {
    FX.st.on[e.id] = typeof fx[e.id] === "number";
    FX.st.k[e.id] = typeof fx[e.id] === "number" ? fx[e.id] : e.default;
  }
  FX.st.look = fx.look ? fx.look.id : null;
  FX.st.lookK = fx.look ? fx.look.strength : 0.6;
  syncFxUI(); fxRender();
}
function setBefore(b) {
  FX.before = b;
  $("#fxCompare").classList.toggle("on", b);
  fxRender();
}
document.addEventListener("keyup", (e) => { if (e.code === "KeyB") setBefore(false); });

function fxSettings() {
  const out = {};
  if (FX.st.look) out.look = { id: FX.st.look, strength: Math.round(FX.st.lookK * 100) / 100 };
  for (const e of FX.lib.effects) if (FX.st.on[e.id] && e.id !== "pushin") out[e.id] = Math.round(FX.st.k[e.id] * 100) / 100;
  return out;
}
function fxSummaryText() {
  const L = FX.lib, parts = [];
  if (FX.st.look) parts.push(`${fxName(L.looks.find((l) => l.id === FX.st.look))} ${Math.round(FX.st.lookK * 100)}%`);
  for (const e of L.effects) {
    if (!FX.st.on[e.id]) continue;
    let part = `${fxName(e)} ${Math.round(FX.st.k[e.id] * 100)}%`;
    if (e.id === "pushin") {
      const s = FX.st.pushScope === "one" && segs().find((x) => x.id === FX.st.pushSeg);
      part += s ? t(" (лише кадр #{n} «{note}»)", { n: segs().indexOf(s) + 1, note: s.note || s.clip }) : t(" (на всі кадри)");
    }
    parts.push(part);
  }
  return parts.join(", ");
}
function syncFxUI() {
  if (!FX.lib) return;
  $$(".look").forEach((el) => el.classList.toggle("on", (el.dataset.id || null) === FX.st.look));
  $("#lookSlider").classList.toggle("hidden", !FX.st.look);
  if (FX.st.look) {
    $("#lookName").textContent = fxName(FX.lib.looks.find((l) => l.id === FX.st.look));
    $("#lookK").value = Math.round(FX.st.lookK * 100);
    $("#lookKv").textContent = Math.round(FX.st.lookK * 100) + "%";
  }
  for (const row of $$(".fxRow")) {
    const id = row.dataset.id;
    row.classList.toggle("off", !FX.st.on[id]);
    row.querySelector("input[type=checkbox]").checked = !!FX.st.on[id];
    row.querySelector("input[type=range]").value = Math.round(FX.st.k[id] * 100);
    row.querySelector(".pct").textContent = Math.round(FX.st.k[id] * 100) + "%";
    const sel = row.querySelector("select");
    if (sel) sel.value = FX.st.pushScope;
  }
  const txt = fxSummaryText();
  $("#fxSummary").innerHTML = txt ? t("Вибрано: <b></b>") : `<span class="muted">${t("Нічого не вибрано. Почни з готового набору або кольору.")}</span>`;
  if (txt) $("#fxSummary b").textContent = txt;
  $("#fxSend").disabled = !txt;
}
// effects already baked into the version on screen
function fxOnVersion() {
  if (!FX.lib || !S.V) return;
  const fx = (S.V.output || {}).effects;
  $("#fxBaked").textContent = fx && Object.keys(fx).length ? t("Ця версія вже з ефектами, прев'ю додасть зверху") : "";
}
async function sendFx() {
  const txt = fxSummaryText();
  if (!txt) return;
  const note = $("#fxNote").value.trim();
  const body = {
    anchor: "general", version: S.V && S.V.version, file: S.V && S.V.file,
    text: t("Ефекти: {fx}.", { fx: txt }) + (note ? " " + note : ""),
    effects: { global: fxSettings(), pushin: FX.st.on.pushin ? { strength: FX.st.k.pushin, scope: FX.st.pushScope, seg_id: FX.st.pushSeg } : null },
  };
  $("#fxStatus").textContent = t("надсилаю…");
  const res = await fetch(`/api/episodes/${enc(S.ep)}/instructions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  $("#fxStatus").textContent = res.ok ? t("надіслано ✓ (видно у «Вказівках»). Напиши Claude «застосуй вказівки».") : t("помилка");
  if (res.ok) { $("#fxNote").value = ""; await poll(); }
}

requestAnimationFrame(frameLoop);
init();

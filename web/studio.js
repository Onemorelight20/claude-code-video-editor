"use strict";
// "Світло" and "Текст" tabs.
// Light: per-segment brightness / contrast / warmth on top of the auto balance (grades.json). The live
//   preview is the WebGL pass in app.js (gradeC), fed with the difference to what the version has baked.
// Text: captions drawn by drawCaption(). The same function paints the live preview and the PNGs that
//   render.py burns into the video (texts/<id>_<hash>_1080|2160.png), so what you see is what you get.

const ST2 = {
  grades: {}, gradeTimers: {}, texts: [], sel: null, saveTimer: null, uploaded: new Set(),
  job: {}, waitingRender: false, loaded: false, saving: false,
};
const tc = $("#txtCanvas");
const ZERO_G = { brightness: 0, contrast: 0, temp: 0 };
const signed = (v, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);

// ================================================================= light
const segAt = () => (segs().length ? segs()[segIndexAt(video.currentTime)] : null);
const bakedGrade = (s) => ({ ...ZERO_G, ...((s && s.grade) || {}) });
function pendingGrade(s) {
  if (!s) return { ...ZERO_G, source: "auto" };
  const g = ST2.grades[s.id];
  if (!g) return { ...bakedGrade(s), source: "auto" };
  return { brightness: +g.brightness || 0, contrast: +g.contrast || 0, temp: +g.temp || 0,
           source: g.source || "auto", auto: g.auto };
}
const differs = (a, b) => ["brightness", "contrast", "temp"].some((k) => Math.abs((a[k] || 0) - (b[k] || 0)) > 0.004);
window.gradeDelta = () => {
  const s = segAt();
  if (!s) return null;
  const p = pendingGrade(s), b = bakedGrade(s);
  return { b: p.brightness - b.brightness, c: p.contrast - b.contrast, t: p.temp - b.temp };
};
window.gradeDeltaActive = () => {
  const d = window.gradeDelta();
  return !!d && (Math.abs(d.b) > 0.004 || Math.abs(d.c) > 0.004 || Math.abs(d.t) > 0.004);
};

function renderLightPanel() {
  const s = segAt();
  $("#lightCur").classList.toggle("hidden", !s);
  if (!s) return;
  const i = segs().indexOf(s), p = pendingGrade(s);
  $("#lNum").textContent = i + 1;
  $("#lNote").textContent = noteLabel(s.note) || s.clip;
  $("#lSrc").textContent = p.source === "user" ? t("вручну") : t("авто");
  $("#lB").value = Math.round(p.brightness * 100);
  $("#lC").value = Math.round(p.contrast * 100);
  $("#lT").value = Math.round(p.temp * 100);
  $("#lBv").textContent = signed(p.brightness);
  $("#lCv").textContent = signed(p.contrast);
  $("#lTv").textContent = signed(p.temp);
  renderLightList();
}
function renderLightList() {
  const box = $("#lightList");
  const cur = segAt();
  box.innerHTML = "";
  segs().forEach((s, i) => {
    const p = pendingGrade(s);
    const row = document.createElement("div");
    row.className = "lrow" + (s === cur ? " cur" : "") + (p.source === "user" ? " user" : "")
      + (differs(p, bakedGrade(s)) ? " pending" : "");
    const w = Math.min(50, Math.abs(p.brightness) / 0.8 * 50);
    const left = p.brightness >= 0 ? 50 : 50 - w;
    row.innerHTML = `<span class="num">${i + 1}</span><span class="nt"></span>
      <span class="bar" title="${t("яскравість {v}", { v: signed(p.brightness) })}"><b></b><i style="left:${left}%;width:${w}%"></i></span>`;
    row.querySelector(".nt").textContent = `${noteLabel(s.note) || s.clip} ☀ ${signed(p.brightness)}`;
    row.onclick = () => { video.pause(); seek(s.start + Math.min(0.3, s.dur / 2)); };
    box.appendChild(row);
  });
}
function onLightInput() {
  const s = segAt();
  if (!s) return;
  const g = { ...(ST2.grades[s.id] || {}), clip: s.clip, source: "user",
              brightness: $("#lB").value / 100, contrast: $("#lC").value / 100, temp: $("#lT").value / 100 };
  ST2.grades[s.id] = g;
  $("#lBv").textContent = signed(g.brightness);
  $("#lCv").textContent = signed(g.contrast);
  $("#lTv").textContent = signed(g.temp);
  $("#lSrc").textContent = t("вручну");
  fxRender();
  renderLightList();
  markPending();
  clearTimeout(ST2.gradeTimers[s.id]);
  $("#lStatus").textContent = t("зберігаю…");
  ST2.gradeTimers[s.id] = setTimeout(() => saveGrade(s.id, { brightness: g.brightness, contrast: g.contrast, temp: g.temp }), 400);
}
async function saveGrade(id, body) {
  delete ST2.gradeTimers[id];
  try {
    const res = await fetch(`/api/episodes/${enc(S.ep)}/grades/${enc(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.grade) ST2.grades[id] = d.grade;
    $("#lStatus").textContent = res.ok ? t("збережено ✓") : t("помилка");
  } catch (e) { $("#lStatus").textContent = t("сервер недоступний"); }
}
async function flushGrades() {
  const ids = Object.keys(ST2.gradeTimers);
  for (const id of ids) {
    clearTimeout(ST2.gradeTimers[id]);
    const g = ST2.grades[id];
    await saveGrade(id, { brightness: g.brightness, contrast: g.contrast, temp: g.temp });
  }
}
["#lB", "#lC", "#lT"].forEach((sel) => $(sel).addEventListener("input", onLightInput));
$("#lAuto").onclick = async () => {
  const s = segAt();
  if (!s) return;
  clearTimeout(ST2.gradeTimers[s.id]);
  delete ST2.gradeTimers[s.id];
  await saveGrade(s.id, { reset: true });
  renderLightPanel();
  fxRender();
  markPending();
};
$("#lCompare").onpointerdown = () => setBefore(true);
$("#lCompare").onpointerup = $("#lCompare").onpointerleave = () => setBefore(false);

// ================================================================= captions
const FONTS = [
  { f: "Montserrat", l: t("Сучасний"), w: [400, 700, 900], it: true },
  { f: "Unbounded", l: t("Трендовий"), w: [400, 700, 900] },
  { f: "Rubik", l: t("Округлий"), w: [400, 700, 900], it: true },
  { f: "Comfortaa", l: t("М'який"), w: [400, 700] },
  { f: "Playfair Display", l: t("Елегантний"), w: [400, 700], it: true },
  { f: "Yeseva One", l: t("Вишуканий"), w: [400] },
  { f: "Caveat", l: t("Рукописний"), w: [400, 700] },
  { f: "Marck Script", l: t("Каліграфія"), w: [400] },
  { f: "Bad Script", l: t("Нотатки"), w: [400] },
  { f: "Great Vibes", l: t("Розчерк"), w: [400] },
  { f: "Lobster", l: t("Ретро"), w: [400] },
  { f: "Pacifico", l: t("Літній"), w: [400] },
  { f: "Amatic SC", l: t("Крейда"), w: [400, 700] },
  { f: "Neucha", l: t("Зошит"), w: [400] },
];
const SH_SOFT = { shadow: true, shadowColor: "#000000", shadowOpacity: 0.55, shadowBlur: 0.37, shadowDist: 0.05, shadowAngle: 90 };
const SH_NONE = { shadow: false };
const TPRESETS = [
  { n: t("TikTok плашка"), v: { font: "Montserrat", weight: 700, italic: false, upper: false, color: "#111111", style: "box", box: "#ffffff", boxOpacity: 1, size: 0.034, ...SH_NONE } },
  { n: t("Заголовок"), v: { font: "Unbounded", weight: 900, italic: false, upper: true, color: "#ffffff", style: "plain", box: "#000000", boxOpacity: 0.5, size: 0.046, ...SH_SOFT } },
  { n: t("Затишний"), v: { font: "Caveat", weight: 700, italic: false, upper: false, color: "#fff6e6", style: "plain", box: "#000000", boxOpacity: 0.5, size: 0.062, ...SH_SOFT } },
  { n: t("Елегантний"), v: { font: "Playfair Display", weight: 700, italic: true, upper: false, color: "#ffffff", style: "plain", box: "#000000", boxOpacity: 0.5, size: 0.044, ...SH_SOFT } },
  { n: t("Розчерк"), v: { font: "Great Vibes", weight: 400, italic: false, upper: false, color: "#ffffff", style: "plain", box: "#000000", boxOpacity: 0.5, size: 0.07, ...SH_SOFT } },
  { n: t("Ретро"), v: { font: "Lobster", weight: 400, italic: false, upper: false, color: "#ffd27a", style: "outline", box: "#5a2a12", boxOpacity: 1, size: 0.056,
                     shadow: true, shadowColor: "#3b1a08", shadowOpacity: 0.9, shadowBlur: 0, shadowDist: 0.07, shadowAngle: 45 } },
  { n: t("Крейда"), v: { font: "Amatic SC", weight: 700, italic: false, upper: false, color: "#ffffff", style: "box", box: "#000000", boxOpacity: 0.45, size: 0.062, ...SH_NONE } },
];
const SHPRESETS = [
  { n: t("М'яка"), v: { shadowColor: "#000000", shadowOpacity: 0.55, shadowBlur: 0.37, shadowDist: 0.05, shadowAngle: 90 } },
  { n: t("Чітка"), v: { shadowColor: "#000000", shadowOpacity: 0.85, shadowBlur: 0, shadowDist: 0.06, shadowAngle: 45 } },
  { n: t("Довга"), v: { shadowColor: "#000000", shadowOpacity: 0.45, shadowBlur: 0.08, shadowDist: 0.16, shadowAngle: 45 } },
  { n: t("Тепла"), v: { shadowColor: "#5a2a12", shadowOpacity: 0.75, shadowBlur: 0.3, shadowDist: 0.06, shadowAngle: 90 } },
  { n: t("Світіння"), v: { shadowColor: "#ffd27a", shadowOpacity: 0.95, shadowBlur: 0.7, shadowDist: 0, shadowAngle: 90 } },
  { n: t("Ореол"), v: { shadowColor: "#000000", shadowOpacity: 0.8, shadowBlur: 0.55, shadowDist: 0, shadowAngle: 90 } },
];
const SHCOLORS = ["#000000", "#3b1a08", "#5a2a12", "#1d2b53", "#ffffff", "#ffd27a", "#ff6b81", "#7bd88f"];
// old captions stored the shadow as style "shadow"
function shadowOf(it) {
  const legacy = it.style === "shadow" && it.shadow === undefined;
  const on = legacy || !!it.shadow;
  return { on, color: it.shadowColor || "#000000", opacity: it.shadowOpacity ?? 0.55, blur: it.shadowBlur ?? 0.37,
           dist: it.shadowDist ?? 0.05, angle: it.shadowAngle ?? 90 };
}
function applyShadow(ctx, it, px) {
  const sh = shadowOf(it);
  if (!sh.on) return false;
  const a = (sh.angle * Math.PI) / 180;
  ctx.shadowColor = hexA(sh.color, sh.opacity);
  ctx.shadowBlur = sh.blur * px * 0.6;
  ctx.shadowOffsetX = Math.cos(a) * sh.dist * px;
  ctx.shadowOffsetY = Math.sin(a) * sh.dist * px;
  return true;
}
function clearShadow(ctx) { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
const COLORS = ["#ffffff", "#fff6e6", "#111111", "#ffd27a", "#ff9f43", "#ff6b81", "#e74c3c", "#7bd88f", "#7aa7ff"];
const BOXCOLORS = ["#ffffff", "#000000", "#fff6e6", "#ffd27a", "#ff6b81", "#5a2a12"];
const LOOK_KEYS = ["text", "font", "weight", "italic", "size", "color", "style", "box", "boxOpacity",
                   "align", "x", "y", "maxWidth", "lineHeight", "upper"];
// shadow keys join the hash only when set, so captions made before them keep their hash (and baked PNG)
const SH_KEYS = ["shadow", "shadowColor", "shadowOpacity", "shadowBlur", "shadowDist", "shadowAngle"];
const DRAW_VERSION = "c1";  // bump when drawCaption() changes the look of existing captions

const fontInfo = (f) => FONTS.find((x) => x.f === f) || FONTS[0];
const fontStr = (it, px) => `${it.italic ? "italic " : ""}${it.weight || 400} ${px}px "${it.font}"`;
const capText = (it) => (it.upper ? String(it.text || "").toUpperCase() : String(it.text || ""));
// default text of a new caption, Ukrainian or English UI; never burned in (render.py skips both),
// so a forgotten draft can't leak into the video
const PLACEHOLDERS = ["Ваш напис", "Your caption"];
const PLACEHOLDER = t("Ваш напис");
const isDraft = (it) => !String(it.text || "").trim() || PLACEHOLDERS.includes(String(it.text).trim());
function capHash(it) {
  const keys = LOOK_KEYS.concat(SH_KEYS.filter((k) => it[k] !== undefined));
  const str = DRAW_VERSION + JSON.stringify(keys.map((k) => (it[k] === undefined ? null : it[k])));
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function capTimes(it) {
  const s = it.seg_id && segs().find((x) => x.id === it.seg_id);
  const a = Math.max(0, s ? s.start + (+it.offset || 0) : (+it.start || 0));
  const total = duration() || 1e9;
  const e = it.end_seg && segs().find((x) => x.id === it.end_seg);   // ends with that shot (same rule as render.py)
  const b = e ? e.start + e.dur - (+(it.end_pad ?? 0.15)) : a + (+it.dur || 3);
  return { a, b: Math.min(total, b) };
}

// layout in pixels of a W x H frame; everything is relative to the frame, so any size looks the same
function layoutCaption(ctx, it, W, H) {
  const px = (it.size || 0.04) * H;
  ctx.font = fontStr(it, px);
  const maxW = (it.maxWidth || 0.84) * W;
  const lines = [];
  for (const para of capText(it).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = words[0];
    for (const w of words.slice(1)) {
      const t = line + " " + w;
      if (ctx.measureText(t).width <= maxW) line = t;
      else { lines.push(line); line = w; }
    }
    lines.push(line);
  }
  const lh = px * (it.lineHeight || 1.18);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths), blockH = lh * lines.length;
  const cx = (it.x ?? 0.5) * W, cy = (it.y ?? 0.2) * H;
  return { px, lh, lines, widths, blockW, blockH, cx, cy, top: cy - blockH / 2 };
}
function lineX(L, it, i) {
  if (it.align === "left") return L.cx - L.blockW / 2;
  if (it.align === "right") return L.cx + L.blockW / 2 - L.widths[i];
  return L.cx - L.widths[i] / 2;
}
function drawCaption(ctx, it, W, H, alpha = 1) {
  const L = layoutCaption(ctx, it, W, H);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.font = fontStr(it, L.px);
  const style = it.style === "shadow" ? "plain" : (it.style || "plain");
  if (style === "box") {  // TikTok-like: one rounded box per line, filled as one path (no double alpha)
    const padX = L.px * 0.36, padY = L.lh * 0.04, r = L.px * 0.26;
    const path = new Path2D();
    L.lines.forEach((line, i) => {
      if (!line) return;
      const x = lineX(L, it, i) - padX, y = L.top + L.lh * i - padY;
      const w = L.widths[i] + 2 * padX, h = L.lh + 2 * padY;
      path.roundRect(x, y, w, h, r);
    });
    ctx.fillStyle = hexA(it.box || "#ffffff", it.boxOpacity ?? 1);
    applyShadow(ctx, it, L.px);   // the label casts the shadow
    ctx.fill(path);
    clearShadow(ctx);
  }
  L.lines.forEach((line, i) => {
    if (!line) return;
    const x = lineX(L, it, i), y = L.top + L.lh * (i + 0.5);
    const glyphShadow = style !== "box";
    if (style === "outline") {
      ctx.strokeStyle = it.box || "#000000";
      ctx.lineWidth = L.px * 0.14;
      if (glyphShadow) applyShadow(ctx, it, L.px);
      ctx.strokeText(line, x, y);
      clearShadow(ctx);
    } else if (glyphShadow) {
      applyShadow(ctx, it, L.px);
    }
    ctx.fillStyle = it.color || "#ffffff";
    ctx.fillText(line, x, y);
    clearShadow(ctx);
  });
  ctx.restore();
  return L;
}
function capBox(it, W, H) {  // normalized bounding box for hit-testing
  const ctx = capBox.ctx || (capBox.ctx = document.createElement("canvas").getContext("2d"));
  const L = layoutCaption(ctx, it, W, H);
  const pad = L.px * 0.45;
  return { x0: (L.cx - L.blockW / 2 - pad) / W, x1: (L.cx + L.blockW / 2 + pad) / W,
           y0: (L.top - pad * 0.5) / H, y1: (L.top + L.blockH + pad * 0.5) / H };
}
async function capPNG(it, W, H) {
  await document.fonts.load(fontStr(it, 64), capText(it) || "Аа");
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  drawCaption(c.getContext("2d"), it, W, H, 1);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

// ---------- preview on the video ----------
function isBaked(it, a, b) {
  const baked = (S.V && S.V.texts) || [];
  const h = capHash(it);
  return baked.some((x) => x.id === it.id && x.hash === h && Math.abs(x.start - a) < 0.02 && Math.abs(x.end - b) < 0.02);
}
function drawOverlay() {
  const fr = $("#frame");
  const W = Math.round(fr.clientWidth * dpr), H = Math.round(fr.clientHeight * dpr);
  if (tc.width !== W || tc.height !== H) { tc.width = W; tc.height = H; }
  const ctx = tc.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const editing = S.sideTab === "text";
  if (!ST2.texts.length && !editing) return;
  const now = video.currentTime;
  for (const it of ST2.texts) {
    if (it.hidden || !String(it.text || "").trim()) continue;
    const { a, b } = capTimes(it);
    const vis = now >= a - 0.001 && now <= b;
    const sel = editing && it.id === ST2.sel;
    if (!vis && !sel) continue;
    if (!isBaked(it, a, b)) {
      const f = Math.min(+it.fade || 0, (b - a) / 3);
      let alpha = vis ? 1 : 0.35;  // paused: full opacity so the caption can be edited at its first frame
      if (vis && f > 0.01 && !video.paused) alpha = Math.min(1, (now - a) / f, (b - now) / f);
      drawCaption(ctx, it, W, H, alpha);
    }
    if (sel) {
      const bx = capBox(it, W, H);
      ctx.save();
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeStyle = "#9db6f4";
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(bx.x0 * W, bx.y0 * H, (bx.x1 - bx.x0) * W, (bx.y1 - bx.y0) * H);
      ctx.restore();
    }
  }
  if (editing) {  // TikTok covers the bottom (caption, sound) and the right column (buttons)
    ctx.save();
    ctx.setLineDash([4 * dpr, 6 * dpr]);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(0.04 * W, 0.08 * H, 0.78 * W, 0.70 * H);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
    ctx.fillText(t("безпечна зона TikTok"), 0.05 * W, 0.08 * H - 6 * dpr);
    ctx.restore();
  }
}
// the caption under the playhead is marked in the list
function markNowCaptions() {
  const t = video.currentTime;
  $$("#tList .trow").forEach((r) => {
    const it = ST2.texts.find((x) => x.id === r.dataset.id);
    const ab = it && capTimes(it);
    r.classList.toggle("now", !!ab && t >= ab.a && t <= ab.b);
  });
}
$("#tBack").onclick = () => selectCaption(null);
window.onFrameHook = () => {
  drawOverlay();
  if (S.sideTab === "text" && !ST2.sel) markNowCaptions();
  if (S.sideTab === "trans") {
    const c = curCut();
    if (c !== ST2.lastCut) { ST2.lastCut = c; renderTrans(); }
  }
};

// drag captions on the video (only in the Text tab)
tc.addEventListener("pointerdown", (e) => {
  if (S.sideTab !== "text") return;
  e.stopPropagation();
  e.preventDefault();
  const r = tc.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  const t = video.currentTime;
  const cands = ST2.texts.filter((it) => {
    if (it.hidden) return false;
    const { a, b } = capTimes(it);
    return it.id === ST2.sel || (t >= a && t <= b);
  });
  const hit = cands.reverse().find((it) => {
    const bx = capBox(it, r.width, r.height);
    return px >= bx.x0 && px <= bx.x1 && py >= bx.y0 && py <= bx.y1;
  });
  if (!hit) {
    tc._play = !ST2.sel;          // nothing selected -> the click means play / pause
    selectCaption(null);
    return;
  }
  tc._play = false;
  video.pause();
  selectCaption(hit.id);
  tc.setPointerCapture(e.pointerId);
  const sx = hit.x ?? 0.5, sy = hit.y ?? 0.2;
  let moved = false;
  const move = (ev) => {
    moved = true;
    let x = clamp(sx + (ev.clientX - e.clientX) / r.width, 0.05, 0.95);
    if (Math.abs(x - 0.5) < 0.015) x = 0.5;  // snap to the centre line
    hit.x = Math.round(x * 1000) / 1000;
    hit.y = Math.round(clamp(sy + (ev.clientY - e.clientY) / r.height, 0.04, 0.96) * 1000) / 1000;
  };
  const up = () => {
    tc.removeEventListener("pointermove", move);
    tc.removeEventListener("pointerup", up);
    tc.removeEventListener("pointercancel", up);
    if (moved) scheduleCapSave();
  };
  tc.addEventListener("pointermove", move);
  tc.addEventListener("pointerup", up);
  tc.addEventListener("pointercancel", up);
});
tc.addEventListener("click", (e) => {
  if (S.sideTab !== "text") return;
  e.stopPropagation();
  if (tc._play) { tc._play = false; togglePlay(); }
});
tc.addEventListener("dblclick", (e) => { if (S.sideTab === "text" && ST2.sel) { e.stopPropagation(); $("#tText").focus(); } });

// ---------- editor ----------
const selItem = () => ST2.texts.find((x) => x.id === ST2.sel);
function selectCaption(id) {
  ST2.sel = id;
  renderTextList();
  renderTextEditor();
}
function newCaption() {
  const p = posInfo(video.currentTime);
  const base = JSON.parse(JSON.stringify(TPRESETS[0].v));
  return { id: "t" + Date.now().toString(36), text: PLACEHOLDER, ...base, align: "center", x: 0.5, y: 0.17,
           maxWidth: 0.84, lineHeight: 1.18, seg_id: p.seg_id || null, offset: p.seg_offset || 0,
           start: p.t || 0, dur: 3, fade: 0.25 };
}
function renderTextList() {
  const box = $("#tList");
  box.innerHTML = "";
  const items = [...ST2.texts].sort((x, y) => capTimes(x).a - capTimes(y).a);
  for (const it of items) {
    const { a, b } = capTimes(it);
    const row = document.createElement("div");
    row.className = "trow" + (it.id === ST2.sel ? " sel" : "");
    row.dataset.id = it.id;
    row.innerHTML = `<span class="tt"></span><span class="tm mono">${fmt(a)}–${fmt(b)} ${t("с")}</span>`;
    const tt = row.querySelector(".tt");
    tt.textContent = (String(it.text || "").replace(/\n/g, " / ") || t("(порожньо)")) + (isDraft(it) ? t("  · чернетка: зміни текст") : "");
    row.onclick = () => { selectCaption(it.id); video.pause(); seek(a + 0.05); };
    box.appendChild(row);
  }
  if (!items.length) box.innerHTML = `<div class="muted small">${t("Написів ще немає.")}</div>`;
  // captions baked into the version on screen that are gone / changed now
  const baked = (S.V && S.V.texts) || [];
  const stale = baked.filter((x) => {
    const it = ST2.texts.find((y) => y.id === x.id);
    if (!it) return true;
    const { a, b } = capTimes(it);
    return !isBaked(it, a, b);
  });
  $("#tBakedNote").classList.toggle("hidden", !stale.length);
  $("#tBakedNote").textContent = stale.length
    ? (stale.length === 1 ? t("У цій версії ще є старий напис — зникне після «Зробити версію».")
                          : t("У цій версії ще є старі написи — зникне після «Зробити версію».")) : "";
}
function renderTextEditor() {
  const it = selItem();
  $("#tEditor").classList.toggle("hidden", !it);
  $("#tabText").classList.toggle("detail", !!it);
  $("#tBackLbl").textContent = t("Усі написи ({n})", { n: ST2.texts.length });
  if (!it) return;
  if (document.activeElement !== $("#tText")) $("#tText").value = it.text || "";
  $("#tText").style.fontFamily = `"${it.font}"`;
  $$("#tFonts .fontTile").forEach((el) => el.classList.toggle("on", el.dataset.f === it.font));
  const fi = fontInfo(it.font);
  $("#tBold").classList.toggle("on", (it.weight || 400) >= 700);
  $("#tBold").disabled = fi.w.length < 2;
  $("#tItalic").classList.toggle("on", !!it.italic);
  $("#tItalic").disabled = !fi.it;
  $("#tUpper").classList.toggle("on", !!it.upper);
  $$("#tAlign button").forEach((b) => b.classList.toggle("on", b.dataset.al === (it.align || "center")));
  $("#tSize").value = Math.round((it.size || 0.04) * 1000);
  $("#tSizeV").textContent = Math.round((it.size || 0.04) * 1920) + "px";
  $$("#tColors .sw").forEach((el) => el.classList.toggle("on", el.dataset.c === it.color));
  const st = it.style === "shadow" ? "plain" : (it.style || "plain");
  $$("#tStyle button").forEach((b) => b.classList.toggle("on", b.dataset.st === st));
  const sh = shadowOf(it);
  $("#shOn").checked = sh.on;
  $("#shBody").classList.toggle("off", !sh.on);
  $("#shWhere").textContent = sh.on ? (st === "box" ? t("— від плашки") : t("— від літер")) : "";
  $$("#shColors .sw").forEach((el) => el.classList.toggle("on", el.dataset.c === sh.color));
  $("#shOp").value = Math.round(sh.opacity * 100);  $("#shOpV").textContent = Math.round(sh.opacity * 100) + "%";
  $("#shBlur").value = Math.round(sh.blur * 100);   $("#shBlurV").textContent = Math.round(sh.blur * 100);
  $("#shDist").value = Math.round(sh.dist * 100);   $("#shDistV").textContent = Math.round(sh.dist * 100);
  $("#shAng").value = Math.round(sh.angle);         $("#shAngV").textContent = Math.round(sh.angle) + "°";
  $("#tBoxRow").classList.toggle("hidden", st !== "box" && st !== "outline");
  $("#tBoxLbl").textContent = st === "outline" ? t("Колір контуру") : t("Колір плашки");
  $("#tBoxOpRow").classList.toggle("hidden", st !== "box");
  $$("#tBoxColors .sw").forEach((el) => el.classList.toggle("on", el.dataset.c === it.box));
  $("#tBoxOp").value = Math.round((it.boxOpacity ?? 1) * 100);
  $("#tBoxOpV").textContent = Math.round((it.boxOpacity ?? 1) * 100) + "%";
  const { a, b } = capTimes(it);
  $("#tTime").textContent = `${fmt(a)}–${fmt(b)} ${t("с")}`;
  if (document.activeElement !== $("#tDur")) $("#tDur").value = Math.max(0.1, b - a).toFixed(1);
  $("#tFade").checked = (+it.fade || 0) > 0;
}
function edit(fn) {
  const it = selItem();
  if (!it) return;
  fn(it);
  renderTextEditor();
  renderTextList();
  renderCapMarks();
  scheduleCapSave();
}
function buildTextUI() {
  const pr = $("#tPresets");
  pr.innerHTML = "";
  for (const p of TPRESETS) {
    const b = document.createElement("button");
    b.textContent = p.n;
    b.style.fontFamily = `"${p.v.font}"`;
    b.style.fontWeight = p.v.weight;
    b.style.fontStyle = p.v.italic ? "italic" : "normal";
    b.onclick = () => edit((it) => Object.assign(it, JSON.parse(JSON.stringify(p.v))));
    pr.appendChild(b);
  }
  const fg = $("#tFonts");
  fg.innerHTML = "";
  for (const f of FONTS) {
    const el = document.createElement("div");
    el.className = "fontTile";
    el.dataset.f = f.f;
    el.innerHTML = `<div class="smp">${t("Смачно")}</div><div class="fl"></div>`;
    el.querySelector(".smp").style.fontFamily = `"${f.f}"`;
    el.querySelector(".smp").style.fontWeight = f.w.includes(700) ? 700 : 400;
    el.querySelector(".fl").textContent = `${f.l} · ${f.f}`;
    el.onclick = () => edit((it) => {
      it.font = f.f;
      if (!f.w.includes(it.weight)) it.weight = (it.weight || 400) >= 700 ? f.w[f.w.length - 1] : f.w[0];
      if (!f.it) it.italic = false;
    });
    fg.appendChild(el);
  }
  const sw = (box, list, key) => {
    box.innerHTML = "";
    for (const c of list) {
      const el = document.createElement("span");
      el.className = "sw";
      el.dataset.c = c;
      el.style.background = c;
      el.onclick = () => edit((it) => { it[key] = c; });
      box.appendChild(el);
    }
    const inp = document.createElement("input");
    inp.type = "color";
    inp.title = t("Свій колір");
    inp.oninput = () => edit((it) => { it[key] = inp.value; });
    box.appendChild(inp);
  };
  sw($("#tColors"), COLORS, "color");
  sw($("#tBoxColors"), BOXCOLORS, "box");
  const shc = $("#shColors");
  shc.innerHTML = "";
  for (const c of SHCOLORS) {
    const el = document.createElement("span");
    el.className = "sw"; el.dataset.c = c; el.style.background = c;
    el.onclick = () => shEdit((it) => { it.shadowColor = c; });
    shc.appendChild(el);
  }
  const shi = document.createElement("input");
  shi.type = "color"; shi.title = t("Свій колір тіні");
  shi.oninput = () => shEdit((it) => { it.shadowColor = shi.value; });
  shc.appendChild(shi);
  const shp = $("#shPresets");
  shp.innerHTML = "";
  for (const pr of SHPRESETS) {
    const b = document.createElement("button");
    b.textContent = pr.n;
    b.onclick = () => shEdit((it) => Object.assign(it, pr.v));
    shp.appendChild(b);
  }
}
$("#tText").addEventListener("input", () => edit((it) => { it.text = $("#tText").value; }));
$("#tText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#tText").blur(); }
});
$("#tBold").onclick = () => edit((it) => {
  const w = fontInfo(it.font).w;
  it.weight = (it.weight || 400) >= 700 ? w[0] : w.find((x) => x >= 700) || w[w.length - 1];
});
$("#tItalic").onclick = () => edit((it) => { it.italic = !it.italic; });
$("#tUpper").onclick = () => edit((it) => { it.upper = !it.upper; });
$$("#tAlign button").forEach((b) => (b.onclick = () => edit((it) => { it.align = b.dataset.al; })));
$("#tSize").addEventListener("input", () => edit((it) => { it.size = $("#tSize").value / 1000; }));
$$("#tStyle button").forEach((b) => (b.onclick = () => edit((it) => {
  if (it.style === "shadow" && it.shadow === undefined) Object.assign(it, SH_SOFT);  // keep the old shadow
  it.style = b.dataset.st;
  if (it.style === "outline" && (!it.box || it.box === "#ffffff")) it.box = "#000000";
})));
// shadow controls: switching on keeps the last values, sliders store fractions of the font size
const shEdit = (fn) => edit((it) => {
  if (it.style === "shadow") { Object.assign(it, SH_SOFT); it.style = "plain"; }
  if (!it.shadow) Object.assign(it, { ...SH_SOFT, ...Object.fromEntries(Object.entries(it).filter(([k]) => k.startsWith("shadow") && k !== "shadow")) });
  it.shadow = true;
  fn(it);
});
$("#shOn").onchange = () => edit((it) => {
  if (it.style === "shadow") it.style = "plain";
  if ($("#shOn").checked) Object.assign(it, { ...SH_SOFT, ...Object.fromEntries(Object.entries(it).filter(([k]) => k.startsWith("shadow") && k !== "shadow")) }, { shadow: true });
  else it.shadow = false;
});
$("#shOp").addEventListener("input", () => shEdit((it) => { it.shadowOpacity = $("#shOp").value / 100; }));
$("#shBlur").addEventListener("input", () => shEdit((it) => { it.shadowBlur = $("#shBlur").value / 100; }));
$("#shDist").addEventListener("input", () => shEdit((it) => { it.shadowDist = $("#shDist").value / 100; }));
$("#shAng").addEventListener("input", () => shEdit((it) => { it.shadowAngle = +$("#shAng").value; }));
$("#tBoxOp").addEventListener("input", () => edit((it) => { it.boxOpacity = $("#tBoxOp").value / 100; }));
$$("[data-pos]").forEach((b) => (b.onclick = () => edit((it) => { it.y = +b.dataset.pos; it.x = 0.5; })));
$("#tStartHere").onclick = () => edit((it) => {
  const { b } = capTimes(it);
  const p = posInfo(video.currentTime);
  it.seg_id = p.seg_id || null;
  it.offset = p.seg_offset || 0;
  it.start = p.t || 0;
  it.dur = b - (p.t || 0) >= 0.5 ? Math.round((b - p.t) * 100) / 100 : (+it.dur || 3);
  delete it.end_seg; delete it.end_pad;
});
$("#tEndHere").onclick = () => edit((it) => {
  const { a } = capTimes(it);
  it.dur = Math.max(0.5, Math.round((video.currentTime - a) * 100) / 100);
  delete it.end_seg; delete it.end_pad;
});
$("#tDur").addEventListener("change", () => edit((it) => { it.dur = Math.max(0.5, +$("#tDur").value || 3); delete it.end_seg; delete it.end_pad; }));
$("#tFade").onchange = () => edit((it) => { it.fade = $("#tFade").checked ? 0.25 : 0; });
$("#tDel").onclick = () => {
  const it = selItem();
  if (!it) return;
  ST2.texts = ST2.texts.filter((x) => x !== it);
  selectCaption(null);
  renderCapMarks();
  scheduleCapSave();
};
$("#tAdd").onclick = () => {
  video.pause();
  const it = newCaption();
  ST2.texts.push(it);
  selectCaption(it.id);
  renderCapMarks();
  scheduleCapSave();
  $("#tText").focus();
  $("#tText").select();
};

// ---------- saving ----------
function scheduleCapSave() {
  clearTimeout(ST2.saveTimer);
  $("#tSave").textContent = t("зберігаю…");
  markPending();
  ST2.saveTimer = setTimeout(() => saveCaptions(false), 600);
}
async function saveCaptions(force) {
  clearTimeout(ST2.saveTimer);
  ST2.saveTimer = null;
  while (ST2.saving) await new Promise((r) => setTimeout(r, 100));
  ST2.saving = true;
  try {
    for (const it of ST2.texts) {
      const h = capHash(it);
      if (!force && it.hash === h && ST2.uploaded.has(it.id + h)) continue;
      for (const [W, H, sz] of [[1080, 1920, 1080], [2160, 3840, 2160]]) {
        const blob = await capPNG(it, W, H);
        const res = await fetch(`/api/episodes/${enc(S.ep)}/texts/${enc(it.id)}.png?size=${sz}&hash=${h}`, {
          method: "POST", headers: { "Content-Type": "image/png" }, body: blob,
        });
        if (!res.ok) throw new Error("png upload failed");
      }
      it.hash = h;
      ST2.uploaded.add(it.id + h);
    }
    const res = await fetch(`/api/episodes/${enc(S.ep)}/texts`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: ST2.texts }),
    });
    $("#tSave").textContent = res.ok ? t("збережено ✓") : t("помилка збереження");
  } catch (e) {
    $("#tSave").textContent = t("помилка: {e}", { e: e.message });
  } finally {
    ST2.saving = false;
    markPending();
  }
}

// ---------- caption bars on the timeline ----------
function renderCapMarks() {
  let box = $("#tlCaps");
  if (!box) {
    box = document.createElement("div");
    box.id = "tlCaps";
    $("#timeline").before(box);
  }
  box.innerHTML = "";
  for (const it of ST2.texts) {
    if (it.hidden) continue;
    const { a, b } = capTimes(it);
    const el = document.createElement("i");
    el.style.left = a * S.pps + "px";
    el.style.width = Math.max(4, (b - a) * S.pps) + "px";
    el.title = it.text;
    box.appendChild(el);
  }
}

// ================================================================= new version from the UI
function pendingInfo() {
  const lightSegs = [];
  segs().forEach((s, i) => { if (differs(pendingGrade(s), bakedGrade(s))) lightSegs.push(i + 1); });
  const baked = (S.V && S.V.texts) || [];
  const live = ST2.texts.filter((it) => !it.hidden && !isDraft(it));
  const capsChanged = live.length !== baked.length || live.some((it) => { const { a, b } = capTimes(it); return !isBaked(it, a, b); });
  const trans = [];
  segs().forEach((s, i) => {
    if (!i) return;
    const want = trWant(s.id), have = trHave(s);
    if (want.type !== have.type || (want.type !== "cut" && Math.abs(want.dur - have.dur) > 0.04)) trans.push({ n: i + 1, want });
  });
  const edl = edlDiff();
  return { lightSegs, caps: live.length, capsChanged, trans, edl };
}
function markPending() {
  const p = pendingInfo();
  const n = p.lightSegs.length + p.trans.length + (p.capsChanged ? 1 : 0) + (p.edl.changed ? Math.max(1, p.edl.n || 0) : 0);
  const any = n > 0;
  const btn = $("#mkVersion");
  btn.classList.toggle("pending", any);
  if (!(ST2.job && ST2.job.running) && !ST2.waitingRender) {
    btn.querySelector("span").textContent = any ? t("Зробити версію · {n}", { n }) : t("Зробити версію");
    btn.disabled = !any;
  }
  btn.title = any ? t("Є зміни, яких ще немає у файлі: {list}", { list: pendingText(p) }) : t("Змін немає: версія вийде така сама");
  // honey line under the shots that will change
  const mark = new Set(p.lightSegs.map((k) => k - 1));
  p.trans.forEach((x) => mark.add(x.n - 1));
  (p.edl.ids || []).forEach((id) => { const i = segs().findIndex((s) => s.id === id); if (i >= 0) mark.add(i); });
  $$(".seg").forEach((el) => el.classList.toggle("pend", mark.has(+el.dataset.i)));
}
function pendingText(p) {
  const parts = [];
  if (p.edl.changed) parts.push(t("Монтаж: {x}", { x: p.edl.text }));
  if (p.lightSegs.length) parts.push(t("Світло змінено вручну: {list}", { list: p.lightSegs.map((n) => "#" + n).join(", ") }));
  if (p.trans.length) parts.push(t("Переходи: {list}", { list: p.trans.map((x) => `#${x.n} ${TRNAME[x.want.type] || x.want.type}${x.want.type !== "cut" ? " " + x.want.dur.toFixed(1) + " " + t("с") : ""}`).join(", ") }));
  if (p.capsChanged) parts.push(p.caps ? t("Написи: {n}", { n: p.caps }) : t("Написи прибрано"));
  return parts.join(". ");
}
$("#mkVersion").onclick = async () => {
  const btn = $("#mkVersion");
  btn.disabled = true;
  btn.querySelector("span").textContent = t("Зберігаю…");
  $("#mkStatus").textContent = "";
  try {
    await flushGrades();
    await saveCaptions(true);
    await saveTransitions();
    const p = pendingInfo();
    const note = (pendingText(p) || t("Перерендер без змін")) + t(" (зроблено з інтерфейсу)");
    const res = await fetch(`/api/episodes/${enc(S.ep)}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
    });
    if (!res.ok) throw new Error(t((await res.json()).error || "помилка"));
    ST2.waitingRender = true;
    btn.querySelector("span").textContent = t("Рендер…");
  } catch (e) {
    $("#mkStatus").textContent = t("помилка: {e}", { e: e.message });
    btn.disabled = false;
    markPending();
  }
};
function renderJobStatus() {
  const j = ST2.job || {};
  const btn = $("#mkVersion");
  if (j.running) {
    btn.disabled = true;
    const pct = j.stage === "segments" ? (j.done / (j.total || 1)) * 50 : j.stage === "encode" ? 50 + (j.done / (j.total || 1)) * 50 : 2;
    btn.classList.add("busy");
    btn.style.setProperty("--p", pct.toFixed(0) + "%");
    btn.querySelector("span").textContent = t("Рендер {p}%", { p: Math.round(pct) });
    $("#mkStatus").textContent = "";
  } else if (ST2.waitingRender && j.stage === "done") {
    btn.disabled = false;
    ST2.waitingRender = false;
    btn.classList.remove("busy");
    $("#mkStatus").textContent = "";
    markPending();
    S.sigV = "";  // force the version list to refresh, then open the new one
    poll().then(() => { if (S.versions.some((v) => v.file === j.file)) setVersion(j.file); });
  } else if (j.stage === "error") {
    btn.disabled = false;
    ST2.waitingRender = false;
    btn.classList.remove("busy");
    $("#mkStatus").textContent = t("помилка рендеру: {e}", { e: j.error || "" });
    markPending();
  } else if (!ST2.waitingRender) {
    btn.classList.remove("busy");
    markPending();
  }
}

// ================================================================= hooks from app.js
window.onEpisodeData = (d, initial) => {
  ST2.job = d.render_job || {};
  if (initial || !Object.keys(ST2.gradeTimers).length) ST2.grades = d.grades || {};
  if (initial || !ST2.loaded) {
    ST2.texts = (d.texts || []).map((x) => ({ ...x }));
    ST2.uploaded = new Set(ST2.texts.filter((x) => x.hash).map((x) => x.id + x.hash));
    ST2.sel = null;
    ST2.loaded = true;
    renderTextList();
    renderTextEditor();
  }
  if (initial || !ST2.trSaveTimer) ST2.trans = d.transitions || {};
  ST2.edlSegs = d.edl_segs || [];
  if (S.sideTab === "light") renderLightPanel();
  renderJobStatus();
  renderTrans();
  markPending();
};
window.onVersionHook = () => {
  renderLightPanel();
  renderTextList();
  renderTextEditor();
  renderCapMarks();
  renderTrans();
  markPending();
};
window.onSegChangeHook = () => {
  if (S.sideTab === "light") renderLightPanel();
  fxRender();
};
window.onSideTab = (tab) => {
  tc.classList.toggle("edit", tab === "text");
  if (tab !== "trans") closeTransPreview();
  renderTransMarks();
  if (tab === "light") { fxInit().then(() => { renderLightPanel(); fxRender(); }); }
  if (tab === "text") { renderTextList(); renderTextEditor(); }
  if (tab === "trans") renderTrans();
};
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (S.sideTab === "text" && ST2.sel && (e.key === "Delete" || e.key === "Backspace")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    $("#tDel").click();
  }
}, true);
new ResizeObserver(() => renderCapMarks()).observe($("#tlScroll"));

// ================================================================= transitions between shots
// transitions.json {cuts: {<id of the shot after the cut>: {type, dur}}}; rendered by render.py (ffmpeg xfade)
const TRTYPES = [
  ["cut", "Пряма", "✂"], ["fade", "Наплив", "◐"], ["fadeblack", "Через чорне", "●"], ["fadewhite", "Спалах", "○"],
  ["dissolve", "Розсип", "⁘"], ["slideleft", "Зсув ←", "⇠"], ["slideright", "Зсув →", "⇢"], ["slideup", "Зсув ↑", "⇡"],
  ["smoothleft", "М'який зсув", "↜"], ["wipeleft", "Шторка", "▤"], ["circleopen", "Коло", "◯"], ["zoomin", "Наїзд", "⊕"],
  ["hblur", "Розмиття", "≋"], ["radial", "Радар", "◔"], ["coverleft", "Накриття", "▧"], ["pixelize", "Пікселі", "▦"],
].map(([k, n, ic]) => [k, t(n), ic]);
const TRNAME = Object.fromEntries(TRTYPES.map(([k, n]) => [k, n]));
ST2.trans = {};
ST2.edlSegs = [];
const trWant = (id) => {
  const t = ST2.trans[id];
  return t && t.type ? { type: t.type, dur: +t.dur || 0.4 } : { type: "cut", dur: 0 };
};
const trHave = (s) => (s && s.trans_in && s.trans_in.type ? { type: s.trans_in.type, dur: +s.trans_in.dur || 0 } : { type: "cut", dur: 0 });
function curCut() {  // index of the shot after the cut nearest to the playhead
  const ss = segs();
  if (ss.length < 2) return -1;
  const t = video.currentTime;
  let best = 1, bd = 1e9;
  for (let i = 1; i < ss.length; i++) {
    const d = Math.abs(ss[i].start - t);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function renderTrans() {
  const box = $("#trTypes");
  if (!box) return;
  if (!box.children.length) {
    for (const [k, n, ic] of TRTYPES) {
      const b = document.createElement("button");
      b.dataset.t = k;
      b.innerHTML = `<span class="ic">${ic}</span>${n}`;
      b.onclick = () => setTrans(k);
      box.appendChild(b);
    }
  }
  const i = curCut();
  const ss = segs();
  $("#trBlock").classList.toggle("hidden", i < 0);
  if (i < 0) return;
  const a = ss[i - 1], b = ss[i];
  const want = trWant(b.id), have = trHave(b);
  ST2.trCur = b.id;
  $("#trCut").innerHTML = t("Склейка <b>#{a} → #{b}</b> · {t} с", { a: i, b: i + 1, t: fmt(b.start) }) + `<br><span class="muted"></span>`;
  $("#trCut .muted").textContent = `${noteLabel(a.note) || a.clip} → ${noteLabel(b.note) || b.clip}`;
  $$("#trTypes button").forEach((x) => x.classList.toggle("on", x.dataset.t === want.type));
  const dur = want.type === "cut" ? (ST2.trLastDur || 0.4) : want.dur;
  $("#trDur").value = Math.round(dur * 100);
  $("#trDurV").textContent = dur.toFixed(2) + " " + t("с");
  $("#trDurRow").classList.toggle("off", want.type === "cut");
  const same = want.type === have.type && (want.type === "cut" || Math.abs(want.dur - have.dur) < 0.04);
  $("#trStatus").textContent = same
    ? t("У файлі: {x}", { x: `${TRNAME[have.type] || have.type}${have.type !== "cut" ? " " + have.dur.toFixed(2) + " " + t("с") : ""}` })
    : t("Буде: {x} — після «Зробити версію»", { x: `${TRNAME[want.type] || want.type}${want.type !== "cut" ? " " + want.dur.toFixed(2) + " " + t("с") : ""}` });
  renderTransMarks();
}
function setTrans(type, dur) {
  const id = ST2.trCur;
  if (!id) return;
  const d = dur ?? (ST2.trans[id] && ST2.trans[id].type !== "cut" ? +ST2.trans[id].dur : (ST2.trLastDur || 0.4));
  if (type === "cut") delete ST2.trans[id];
  else { ST2.trans[id] = { type, dur: Math.round(d * 100) / 100 }; ST2.trLastDur = d; }
  renderTrans();
  markPending();
  scheduleTransSave();
  previewTrans();
}
$("#trDur").addEventListener("input", () => {
  const id = ST2.trCur, t = ST2.trans[id];
  const d = $("#trDur").value / 100;
  $("#trDurV").textContent = d.toFixed(2) + " " + t("с");
  ST2.trLastDur = d;
  if (!t) return;
  t.dur = d;
  markPending();
  scheduleTransSave();
});
$("#trDur").addEventListener("change", () => { if (ST2.trans[ST2.trCur]) previewTrans(); renderTrans(); });
function scheduleTransSave() {
  clearTimeout(ST2.trSaveTimer);
  ST2.trSaveTimer = setTimeout(saveTransitions, 400);
}
async function saveTransitions() {
  clearTimeout(ST2.trSaveTimer);
  ST2.trSaveTimer = null;
  try {
    await fetch(`/api/episodes/${enc(S.ep)}/transitions`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cuts: ST2.trans }),
    });
  } catch (e) { $("#trStatus").textContent = t("сервер недоступний"); }
}
async function previewTrans() {
  const id = ST2.trCur;
  if (!id || !S.V) return;
  const w = trWant(id);
  $("#trStatus").textContent = t("готую прев'ю…");
  try {
    const res = await fetch(`/api/episodes/${enc(S.ep)}/transition-preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: S.V.file, seg_id: id, type: w.type, dur: w.dur || ST2.trLastDur || 0.4 }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(t(d.error || "помилка"));
    const pv = $("#trPreview");
    video.pause();
    pv.src = d.url;
    pv.classList.remove("hidden");
    $("#trPreviewLbl").classList.remove("hidden");
    pv.currentTime = 0;
    pv.play();
    renderTrans();
  } catch (e) { $("#trStatus").textContent = t("прев'ю не вийшло: {e}", { e: e.message }); }
}
function closeTransPreview() {
  const pv = $("#trPreview");
  pv.pause();
  pv.classList.add("hidden");
  $("#trPreviewLbl").classList.add("hidden");
}
$("#trPreview").addEventListener("click", (e) => { e.stopPropagation(); closeTransPreview(); });
$("#trPlay").onclick = previewTrans;
video.addEventListener("play", closeTransPreview);
function jumpCut(dir) {
  closeTransPreview();
  const ss = segs(), i = curCut();
  const j = clamp(i + dir, 1, ss.length - 1);
  video.pause();
  seek(ss[j].start - 0.4);
}
$("#trPrev").onclick = () => jumpCut(-1);
$("#trNext").onclick = () => jumpCut(1);
$("#trAll").onclick = () => {
  const w = trWant(ST2.trCur);
  segs().forEach((sg, i) => {
    if (!i) return;
    if (w.type === "cut") delete ST2.trans[sg.id];
    else ST2.trans[sg.id] = { ...w };
  });
  renderTrans(); markPending(); scheduleTransSave();
  $("#trStatus").textContent = t("{name} на всіх {n} склейках", { name: TRNAME[w.type], n: segs().length - 1 });
};
$("#trReset").onclick = () => {
  ST2.trans = {};
  renderTrans(); markPending(); scheduleTransSave();
};
function renderTransMarks() {
  let box = $("#tlTrans");
  if (!box) {
    box = document.createElement("div");
    box.id = "tlTrans";
    $("#timeline").before(box);
  }
  box.innerHTML = "";
  segs().forEach((sg, i) => {
    if (!i) return;
    const want = trWant(sg.id), have = trHave(sg);
    if (want.type === "cut" && have.type === "cut") return;
    const el = document.createElement("i");
    el.style.left = sg.start * S.pps + "px";
    el.className = (want.type !== have.type ? "pending" : "") + (sg.id === ST2.trCur && S.sideTab === "trans" ? " cur" : "");
    el.title = `#${i}→#${i + 1}: ${TRNAME[want.type] || want.type}`;
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.onclick = (e) => { e.stopPropagation(); setSideTab("trans"); video.pause(); seek(sg.start - 0.4); };
    box.appendChild(el);
  });
}

// ================================================================= montage changes not yet rendered
function edlDiff() {
  const key = (x) => `${x.id}|${x.clip}|${(+x.in).toFixed(2)}|${(+x.out).toFixed(2)}|${(+(x.speed ?? 1)).toFixed(3)}|${x.ramp ? +x.ramp.speed : 0}`;
  const have = segs().map(key);
  const want = (ST2.edlSegs || []).map(key);
  if (!ST2.edlSegs.length || have.join() === want.join()) return { changed: false, text: "", ids: [], n: 0 };
  const hv = new Map(segs().map((x) => [x.id, x])), wv = new Map(ST2.edlSegs.map((x) => [x.id, x]));
  const parts = [], ids = [];
  for (const x of ST2.edlSegs) {
    const h = hv.get(x.id);
    if (!h) parts.push(`+ ${x.clip} ${(+x.in).toFixed(2)}–${(+x.out).toFixed(2)}`);
    else if (h.clip !== x.clip || Math.abs(h.in - x.in) > 0.004 || Math.abs(h.out - x.out) > 0.004) {
      parts.push(`«${noteLabel(x.note) || x.id}» → ${x.clip} ${(+x.in).toFixed(2)}–${(+x.out).toFixed(2)}`);
      ids.push(x.id);
    }
  }
  for (const x of segs()) if (!wv.has(x.id)) { parts.push(`− «${noteLabel(x.note) || x.id}»`); ids.push(x.id); }
  return { changed: true, text: parts.join(", ") || t("змінено порядок"), ids, n: parts.length || 1 };
}

// ================================================================= edit a shot of the edit (timeline ✎ / double click)
// Opens its clip in the editor on the shot's range (edl.json may already be newer than the version on screen),
// in "replace this shot" mode: move the range, then «Замінити кадр».
window.editShot = (i) => {
  const s = segs()[i];
  if (!s) return;
  const live = (ST2.edlSegs || []).find((x) => x.id === s.id) || s;
  openClip(live.clip, +live.in);
  M.a = +live.in;
  M.b = +live.out;
  M.edit = s.id;
  $("#mMode").value = "replace";
  initView();
  buildStrip();
  fillWhere();
  renderRange();
  const sp = live.ramp && +live.ramp.speed > 1 ? t(", таймлапс ×{x} збережеться", { x: +live.ramp.speed })
    : (live.speed && +live.speed !== 1 ? t(", швидкість {x}× збережеться", { x: +live.speed }) : "");
  $("#mAddStatus").textContent = t("Кадр #{n} «{note}»: посунь межі й натисни «Замінити кадр»{sp}.",
    { n: i + 1, note: noteLabel(live.note || s.note) || live.clip, sp });
};

// another clip picked in the library beside the editor: if a shot is being replaced (✎ on the timeline),
// keep that target, so the shot can be replaced with a piece of a different clip
window.switchClip = (id, at) => {
  const keep = $("#mMode").value === "replace" ? M.edit : null;
  openClip(id, at);
  if (!keep) return;
  M.edit = keep;
  $("#mMode").value = "replace";
  buildStrip();
  fillWhere();
  const i = segs().findIndex((x) => x.id === keep);
  const s = segs()[i];
  if (s) $("#mAddStatus").textContent = t("Заміна кадру #{n} «{note}» шматком з {clip}: вибери межі й натисни «Замінити кадр».",
    { n: i + 1, note: noteLabel(s.note) || s.clip, clip: id });
};

// ================================================================= footage: pick a range for the video
const M = { clip: null, a: 0, b: 1, loop: false, v0: 0, v1: 1 };
const mvd = $("#mVideo");
function mDur() { return M.clip ? S.clips[M.clip].duration : 1; }

// ---- zoom: the strip shows the window v0..v1 of the clip; the mini-map above it shows the whole clip.
// Long clips open zoomed on the selected range, so a 2 s piece of a 79 s clip is wide enough to trim.
const ZOOM_FROM = 12;   // clips longer than this (s) open zoomed
const vSpan = () => Math.max(1e-6, M.v1 - M.v0);
const t2p = (t) => ((t - M.v0) / vSpan()) * 100;
const minSpan = () => Math.min(mDur(), 1);
function setView(v0, v1, redraw = true) {
  const d = mDur();
  const span = clamp(v1 - v0, minSpan(), d);
  M.v0 = clamp(v0, 0, d - span);
  M.v1 = M.v0 + span;
  if (redraw) { buildStrip(); renderRange(); }
}
function fitView(redraw = true) {   // the selected range with context around it (about a third of the strip)
  const pad = Math.max(1.5, (M.b - M.a) * 0.75);
  setView(M.a - pad, M.b + pad, redraw);
}
function initView() { if (mDur() > ZOOM_FROM) fitView(false); else setView(0, mDur(), false); }
function zoomAt(f, center) {        // f > 1 zooms in, keeping `center` (clip seconds) where it is on the strip
  const c = clamp(center ?? (M.v0 + M.v1) / 2, M.v0, M.v1);
  const k = (c - M.v0) / vSpan(), span = clamp(vSpan() / f, minSpan(), mDur());
  setView(c - k * span, c - k * span + span);
}
const panBy = (dt) => setView(M.v0 + dt, M.v1 + dt);
function keepInView(t) {           // dragging a handle past an edge scrolls the strip
  if (t < M.v0) panBy(t - M.v0);
  else if (t > M.v1) panBy(t - M.v1);
}
window.onOpenClip = (id, t) => {
  M.clip = id;
  M.loop = false;
  M.edit = null;
  $("#mMode").value = "after";   // opened from the footage: adding is the safe default (✎ on the timeline replaces)
  const used = segs().filter((x) => x.clip === id);
  const near = used.find((x) => t >= x.in - 0.3 && t <= x.out + 0.3) || null;
  if (near) { M.a = +near.in; M.b = +near.out; }
  else { M.a = clamp((t || 0) - 0.5, 0, Math.max(0, mDur() - 1)); M.b = clamp(M.a + 1.5, M.a + 0.2, mDur()); }
  initView();
  buildStrip();
  fillWhere();
  renderRange();
  $("#mAddStatus").textContent = "";
};
function buildStrip() {
  const tr = $("#mTrack"), strip = $("#mStrip");
  const W = tr.clientWidth || 400, H = 64, c = S.clips[M.clip];
  const slotW = Math.max(20, H * (c.width / c.height));
  const n = Math.ceil(W / slotW);
  strip.innerHTML = "";
  for (let j = 0; j < n; j++) {
    const d = document.createElement("div");
    d.style.width = slotW + "px";
    thumbStyle(d, M.clip, M.v0 + ((j + 0.5) * slotW / W) * vSpan(), slotW, H);
    strip.appendChild(d);
  }
  const marks = $("#mUsedMarks"), om = $("#mOverMarks");
  marks.innerHTML = "";
  om.innerHTML = "";
  segs().forEach((x) => {
    if (x.clip !== M.clip) return;
    const i = document.createElement("i");
    if (x.id === M.edit) i.className = "ed";
    i.style.left = t2p(x.in) + "%";
    i.style.width = ((x.out - x.in) / vSpan()) * 100 + "%";
    marks.appendChild(i);
    const o = document.createElement("i");
    o.style.left = (x.in / c.duration) * 100 + "%";
    o.style.width = ((x.out - x.in) / c.duration) * 100 + "%";
    om.appendChild(o);
  });
  const zoomed = vSpan() < c.duration - 1e-3;
  $("#mView").textContent = zoomed ? t("видно {a}–{b} с з {d} с", { a: fmt(M.v0), b: fmt(M.v1), d: fmt(c.duration) })
    : t("увесь кліп · {d} с", { d: fmt(c.duration) });
  $("#mZoomOut").disabled = $("#mZoomAll").disabled = !zoomed;
  $("#mZoomIn").disabled = vSpan() <= minSpan() + 1e-3;
}
function renderRange() {
  const d = mDur();
  $("#mSel").style.left = t2p(M.a) + "%";
  $("#mSel").style.width = ((M.b - M.a) / vSpan()) * 100 + "%";
  $("#mOverSel").style.left = (M.a / d) * 100 + "%";
  $("#mOverSel").style.width = ((M.b - M.a) / d) * 100 + "%";
  $("#mOverWin").style.left = (M.v0 / d) * 100 + "%";
  $("#mOverWin").style.width = (vSpan() / d) * 100 + "%";
  $("#mRange").textContent = t("Вибрано: {a}–{b} с · {d} с", { a: fmt(M.a), b: fmt(M.b), d: fmt(M.b - M.a) });
  $("#mLoop").classList.toggle("on", M.loop && !mvd.paused);
}
function fillWhere() {
  const sel = $("#mWhere"), mode = $("#mMode").value;
  const ss = segs();
  const opts = [];
  if (mode === "after") opts.push(`<option value="">${t("на самий початок")}</option>`);
  ss.forEach((x, i) => opts.push(`<option value="${x.id}">#${i + 1} ${String(noteLabel(x.note) || x.clip).replace(/</g, "&lt;")}</option>`));
  sel.innerHTML = opts.join("");
  // default: the place in the recipe by shooting order (clips are sorted by time of shooting)
  const ord = (id) => S.order.indexOf(id);
  let pick = null;
  if (mode === "replace") {
    pick = (M.edit && ss.some((x) => x.id === M.edit) ? M.edit : null) || (ss.find((x) => x.clip === M.clip) || {}).id || null;
  }
  $("#mAdd").textContent = mode === "replace" ? t("✓ Замінити кадр") : t("＋ Додати у відео");
  if (!pick) {
    for (const x of ss) {
      if (ord(x.clip) < ord(M.clip) || (x.clip === M.clip && +x.in <= M.a)) pick = x.id;
    }
    if (mode === "replace" && !pick && ss.length) pick = ss[0].id;
  }
  sel.value = pick || "";
}
$("#mMode").onchange = fillWhere;
const mFrac = (e, el) => { const r = el.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
const mTime = (e, free = false) => {   // free: the pointer may be past the strip's edges (handle drags scroll)
  const f = mFrac(e, $("#mTrack"));
  return clamp(M.v0 + (free ? f : clamp(f, 0, 1)) * vSpan(), 0, mDur());
};
$("#mTrack").addEventListener("pointerdown", (e) => {
  if (!M.clip) return;
  const tr = $("#mTrack");
  tr.setPointerCapture(e.pointerId);
  const cls = e.target.classList;
  const mode = cls.contains("hl") ? "a" : cls.contains("hr") ? "b" : e.target.id === "mSel" ? "move" : "seek";
  const t0 = mTime(e), a0 = M.a, b0 = M.b, d = mDur();
  M.loop = false;
  mvd.pause();
  if (mode === "seek") mvd.currentTime = t0;
  const move = (ev) => {
    const t = mTime(ev, mode !== "seek");
    if (mode === "seek") { mvd.currentTime = t; return; }
    if (mode === "a") { M.a = clamp(t, 0, M.b - 0.2); mvd.currentTime = M.a; keepInView(M.a); }
    else if (mode === "b") { M.b = clamp(t, M.a + 0.2, d); mvd.currentTime = Math.max(M.a, M.b - 1 / FPS); keepInView(M.b); }
    else { const len = b0 - a0; M.a = clamp(a0 + t - t0, 0, d - len); M.b = M.a + len; mvd.currentTime = M.a; keepInView(t > t0 ? M.b : M.a); }
    renderRange();
  };
  const up = () => {
    tr.removeEventListener("pointermove", move);
    tr.removeEventListener("pointerup", up);
    tr.removeEventListener("pointercancel", up);
  };
  tr.addEventListener("pointermove", move);
  tr.addEventListener("pointerup", up);
  tr.addEventListener("pointercancel", up);
});
function setIn() { M.a = clamp(mvd.currentTime, 0, mDur() - 0.2); if (M.b < M.a + 0.2) M.b = Math.min(mDur(), M.a + 1); keepInView(M.a); renderRange(); }
function setOut() { M.b = clamp(mvd.currentTime, 0.2, mDur()); if (M.a > M.b - 0.2) M.a = Math.max(0, M.b - 1); keepInView(M.b); renderRange(); }
// zoom controls, wheel / pinch (zoom at the pointer), sideways scroll (pan), mini-map (drag the frame to pan)
const zoomCenter = () => (M.b > M.v0 && M.a < M.v1 ? (Math.max(M.a, M.v0) + Math.min(M.b, M.v1)) / 2 : (M.v0 + M.v1) / 2);
$("#mZoomIn").onclick = () => zoomAt(2, zoomCenter());
$("#mZoomOut").onclick = () => zoomAt(0.5, zoomCenter());
$("#mZoomSel").onclick = () => fitView();
$("#mZoomAll").onclick = () => setView(0, mDur());
function mWheel(e) {
  if (!M.clip) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * k, dy = e.deltaY * k;
  if (Math.abs(dx) > Math.abs(dy)) { panBy((dx / ($("#mTrack").clientWidth || 400)) * vSpan()); return; }
  const center = e.currentTarget.id === "mOver" ? clamp(mFrac(e, $("#mOver")), 0, 1) * mDur() : mTime(e);
  zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025)), center);
}
$("#mTrack").addEventListener("wheel", mWheel, { passive: false });
$("#mOver").addEventListener("wheel", mWheel, { passive: false });
$("#mOver").addEventListener("pointerdown", (e) => {
  if (!M.clip || e.button > 0) return;
  const ov = $("#mOver");
  ov.setPointerCapture(e.pointerId);
  const d = mDur(), span = vSpan(), f0 = mFrac(e, ov);
  if (e.target.id !== "mOverWin") setView(f0 * d - span / 2, f0 * d + span / 2);   // jump there, then drag
  const v00 = M.v0;
  const move = (ev) => { const nv = v00 + (mFrac(ev, ov) - f0) * d; setView(nv, nv + span); };
  const up = () => {
    ov.removeEventListener("pointermove", move);
    ov.removeEventListener("pointerup", up);
    ov.removeEventListener("pointercancel", up);
  };
  ov.addEventListener("pointermove", move);
  ov.addEventListener("pointerup", up);
  ov.addEventListener("pointercancel", up);
});
new ResizeObserver(() => { if (M.clip && !$("#modal").classList.contains("hidden")) buildStrip(); }).observe($("#mTrack"));
$("#mSetIn").onclick = setIn;
$("#mSetOut").onclick = setOut;
$("#mLoop").onclick = () => {
  M.loop = !(M.loop && !mvd.paused);
  if (M.loop) { mvd.currentTime = M.a; mvd.play(); } else mvd.pause();
  renderRange();
};
(function mLoopTick() {
  if (M.clip && !$("#modal").classList.contains("hidden")) {
    if (M.loop && !mvd.paused && mvd.currentTime >= M.b - 0.5 / FPS) mvd.currentTime = M.a;
    const hp = t2p(mvd.currentTime);
    $("#mHead").style.left = hp + "%";
    $("#mHead").style.display = hp < -0.5 || hp > 100.5 ? "none" : "";
    $("#mOverHead").style.left = (mvd.currentTime / mDur()) * 100 + "%";
    $("#mLoop").classList.toggle("on", M.loop && !mvd.paused);
  }
  requestAnimationFrame(mLoopTick);
})();
$("#mAdd").onclick = async () => {
  const mode = $("#mMode").value, target = $("#mWhere").value || null;
  $("#mAddStatus").textContent = t("додаю…");
  try {
    const res = await fetch(`/api/episodes/${enc(S.ep)}/segments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      // a replaced shot keeps its own name (the step), a new one is named after the clip's log note
      body: JSON.stringify({ clip: M.clip, in: r2(M.a), out: r2(M.b), mode, target,
                             note: mode === "replace" ? "" : (S.shotlog[M.clip] || {}).note || "" }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(t(d.error || "помилка"));
    // the server describes the change in Ukrainian (it also goes into the notes log); in English say it here
    const v = { clip: M.clip, a: r2(M.a).toFixed(2), b: r2(M.b).toFixed(2) };
    $("#mAddStatus").textContent = LANG !== "en" ? "✓ " + d.what + ". Буде в наступній версії — «Зробити версію»."
      : mode === "replace" ? t("✓ Кадр замінено: {clip} {a}–{b} с. Буде в наступній версії — «Зробити версію».", v)
      : t("✓ Додано {clip} {a}–{b} с. Буде в наступній версії — «Зробити версію».", v);
    await poll();
    markPending();
  } catch (e) { $("#mAddStatus").textContent = t("не вийшло: {e}", { e: e.message }); }
};
$("#mInsert").onclick = () => {
  const ref = { clip: M.clip, t: r2(M.a), t2: r2(M.b) };
  const ta = $("#text");
  if (!S.captured) S.captured = posInfo(video.currentTime);
  S.draftRefs.push(ref);
  ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, " ") : "") + `[${ref.clip} ${fmt(ref.t)}–${fmt(ref.t2)} ${t("с")}] `;
  $("#refs").innerHTML = S.draftRefs.map((x) => `<span class="mono">${x.clip} ${fmt(x.t)}${x.t2 != null ? "–" + fmt(x.t2) : ""} ${t("с")}</span>`).join("");
  M.loop = false;
  mvd.pause();
  $("#modal").classList.add("hidden");
  setSideTab("notes");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
};
document.addEventListener("keydown", (e) => {
  if ($("#modal").classList.contains("hidden") || e.target.matches("input, textarea, select")) return;
  if (e.code === "KeyI") { e.preventDefault(); e.stopImmediatePropagation(); setIn(); }
  else if (e.code === "KeyO") { e.preventDefault(); e.stopImmediatePropagation(); setOut(); }
  else if (e.code === "Space") { e.preventDefault(); e.stopImmediatePropagation(); M.loop = false; mvd.paused ? mvd.play() : mvd.pause(); }
  else if (e.code === "Equal" || e.code === "NumpadAdd") { e.preventDefault(); e.stopImmediatePropagation(); zoomAt(2, zoomCenter()); }
  else if (e.code === "Minus" || e.code === "NumpadSubtract") { e.preventDefault(); e.stopImmediatePropagation(); zoomAt(0.5, zoomCenter()); }
  else if (e.code === "KeyZ") { e.preventDefault(); e.stopImmediatePropagation(); fitView(); }
  else if (e.code === "Digit0" || e.code === "Numpad0") { e.preventDefault(); e.stopImmediatePropagation(); setView(0, mDur()); }
}, true);

buildTextUI();

// before a reload (UK / EN switch in i18n.js): send edits still waiting for their debounce
window.flushPending = async () => {
  if (ST2.saveTimer) await saveCaptions(false);
  await flushGrades();
  if (ST2.trSaveTimer) await saveTransitions();
};

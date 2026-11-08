"use strict";
// «Монтаж» (Edit) tab: change the cut without Claude. The list is the live edl.json (the draft); the player shows
// the last render, so every change here appears in the video after «Зробити версію». Each change goes through
// POST /api/episodes/<ep>/edit: the server keeps a backup, an undo / redo stack and a log line for Claude.
const ED = { segs: [], undo: {}, sel: null, sig: "", play: null, drag: null, msgTimer: null };
const edBox = $("#tabEdit");
const ICON = {
  grip: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M9 6.5a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zm6 0a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zM9 13.3a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zm6 0a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zM9 20.1a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zm6 0a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6z"/></svg>',
  play: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M8 5.5v13l10.5-6.5z"/></svg>',
  undo: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5L4.5 12 9 16.5"/><path d="M4.5 12h10a5 5 0 010 10h-2"/></svg>',
  redo: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7.5l4.5 4.5-4.5 4.5"/><path d="M19.5 12h-10a5 5 0 000 10h2"/></svg>',
  trim: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  up: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14.5l6-6 6 6"/></svg>',
  down: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>',
  del: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  mute: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/></svg>',
  sound: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.2a4 4 0 010 5.6M18 6.8a7.5 7.5 0 010 10.4"/></svg>',
};
const SPEEDS = [
  { id: "s0.5", label: "0.5×", title: "Сповільнити вдвічі (плавно, з домальованими кадрами)", props: { speed: 0.5 } },
  { id: "s1", label: "1×", title: "Звичайна швидкість", props: { speed: 1 } },
  { id: "s1.5", label: "1.5×", title: "Трохи швидше", props: { speed: 1.5 } },
  { id: "s2", label: "2×", title: "Удвічі швидше", props: { speed: 2 } },
  { id: "r8", label: "×8", title: "Таймлапс ×8: початок і кінець дії звичайні, середина швидко", props: { ramp: { speed: 8 } } },
  { id: "r20", label: "×20", title: "Таймлапс ×20 — для довгих одноманітних дій з нерухомої камери", props: { ramp: { speed: 20 } } },
];
const speedId = (s) => (s.ramp && +s.ramp.speed > 1.001 ? "r" + +s.ramp.speed : "s" + +(+(s.speed ?? 1)).toFixed(3));
function edDur(s) {
  const rp = rampOf(s);
  return rp ? 2 * rp[1] + 2 * rp[4] + rp[5] : (s.out - s.in) / (+s.speed || 1);
}
const versionSeg = (id) => segs().find((x) => x.id === id);
// is this shot different in the draft from the version on screen?
function edChanged(s) {
  const v = versionSeg(s.id);
  if (!v) return true;
  const n = (a, d) => +(a ?? d);
  return v.clip !== s.clip || Math.abs(v.in - s.in) > 0.004 || Math.abs(v.out - s.out) > 0.004
    || speedId(v) !== speedId(s) || Math.abs(n(v.zoom, 1) - n(s.zoom, 1)) > 0.004 || Math.abs(n(v.x, 0.5) - n(s.x, 0.5)) > 0.004
    || Math.abs(n(v.y, 0.5) - n(s.y, 0.5)) > 0.004 || Math.abs(n(v.volume, 1) - n(s.volume, 1)) > 0.004;
}

// ---------- server ----------
async function edApi(body, okMsg) {
  try {
    const res = await fetch(`/api/episodes/${enc(S.ep)}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, lang: LANG }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "помилка");
    edMsg(okMsg || d.what || "");
    await poll();
    if (typeof markPending === "function") markPending();
    return d;
  } catch (e) {
    edMsg(t("не вийшло: {e}", { e: e.message }), true);
    return null;
  }
}
function edMsg(text, bad) {
  ED.msg = text ? { text, bad: !!bad } : null;
  paintMsg();
  clearTimeout(ED.msgTimer);
  ED.msgTimer = setTimeout(() => { ED.msg = null; paintMsg(); }, 6000);
}
function paintMsg() {
  const el = $("#edMsg");
  if (!el) return;
  el.textContent = ED.msg ? ED.msg.text : "";
  el.classList.toggle("bad", !!(ED.msg && ED.msg.bad));
}
const edSet = (s, props) => edApi({ op: "set", id: s.id, props }, "");
const edUndo = () => ED.undo.undo && edApi({ op: "undo" }, t("Скасовано"));
const edRedo = () => ED.undo.redo && edApi({ op: "redo" }, t("Повторено"));
function edDelete(s) {
  if (ED.segs.length <= 1) return;
  const i = ED.segs.indexOf(s);
  ED.sel = (ED.segs[i + 1] || ED.segs[i - 1] || {}).id || null;
  edApi({ op: "delete", id: s.id }, t("Кадр прибрано. Скасувати — ⌘Z"));
}
function edMove(s, dir) {
  const ids = ED.segs.map((x) => x.id), i = ids.indexOf(s.id), j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  edApi({ op: "order", ids }, "");
}

// ---------- list ----------
function edBadges(s) {
  const b = [];
  if (s.ramp && +s.ramp.speed > 1.001) b.push(t("таймлапс ×{s}", { s: +s.ramp.speed }));
  else if ((+s.speed || 1) < 0.999) b.push(t("сповільнено {s}×", { s: +(+s.speed).toFixed(2) }));
  else if ((+s.speed || 1) > 1.001) b.push(`${+(+s.speed).toFixed(2)}×`);
  if (s.volume != null && +s.volume === 0) b.push(t("без звуку"));
  else if (s.volume != null && +s.volume < 0.999) b.push(t("звук {n}%", { n: Math.round(+s.volume * 100) }));
  if ((+s.zoom || 1) > 1.001) b.push(t("кроп ×{z}", { z: (+s.zoom).toFixed(2) }));
  if (s.motion) b.push(t("наїзд"));
  return b;
}
function renderEdit() {
  if (!edBox || S.sideTab !== "edit") return;
  if (ED.drag) return;
  const keepFocus = edBox.contains(document.activeElement) && document.activeElement.matches("input[type=text]");
  if (keepFocus) return;   // don't redraw under the cursor while a name is being typed
  const scroll = edBox.scrollTop;
  const total = ED.segs.reduce((a, s) => a + edDur(s), 0);
  const changed = ED.segs.filter(edChanged).length + segs().filter((v) => !ED.segs.some((s) => s.id === v.id)).length;
  const orderDiff = ED.segs.map((s) => s.id).filter((id) => versionSeg(id)).join() !== segs().map((s) => s.id).filter((id) => ED.segs.some((s) => s.id === id)).join();
  edBox.innerHTML = `
    <div class="edTop">
      <div class="edTitle"><b>${t("Чернетка монтажу")}</b>
        <span class="muted small mono">${tn(ED.segs.length, "{n} кадр", "{n} кадри", "{n} кадрів")} · ${fmt(total)} ${t("с")}</span>
        <span class="edDiff small">${changed || orderDiff ? t("є зміни, яких ще немає у відео") : ""}</span></div>
      <div class="row edTools">
        <button id="edPlay" title="${t("Програти чернетку з початку: кадри з матеріалу з кропом і швидкістю, без рендеру (без звуку)")}">${ICON.play}<span>${t("Переглянути чернетку")}</span></button>
        <button id="edUndo" class="icon" ${ED.undo.undo ? "" : "disabled"}>${ICON.undo}</button>
        <button id="edRedo" class="icon" ${ED.undo.redo ? "" : "disabled"}>${ICON.redo}</button>
        <span id="edMsg" class="small muted"></span>
      </div>
      <div class="muted small">${t("Зміни одразу йдуть у монтаж, у відео — після «Зробити версію». Тягни кадр за ⋮⋮, щоб змінити порядок.")}</div>
    </div>
    <div id="edList"></div>`;
  $("#edUndo").title = ED.undo.undo ? t("Скасувати: {w} (⌘Z)", { w: ED.undo.undo }) : (ED.undo.stale ? t("Монтаж змінено поза інтерфейсом (наприклад, Claude) — скасувати нема чого") : t("Нема чого скасувати"));
  $("#edRedo").title = ED.undo.redo ? t("Повторити: {w} (⇧⌘Z)", { w: ED.undo.redo }) : t("Нема чого повторити");
  paintMsg();
  $("#edUndo").onclick = edUndo;
  $("#edRedo").onclick = edRedo;
  $("#edPlay").onclick = () => edPlayAll(0);
  const list = $("#edList");
  const nowId = (segs()[S.curIdx] || {}).id;
  ED.segs.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "edRow" + (s.id === ED.sel ? " sel" : "") + (s.id === nowId ? " edNow" : "") + (edChanged(s) ? " pend" : "");
    row.dataset.id = s.id;
    row.innerHTML = `<span class="edGrip" title="${t("Перетягни, щоб змінити порядок")}">${ICON.grip}</span>
      <button class="edThumb" title="${t("Подивитись цей кадр")}">${ICON.play}</button>
      <div class="edInfo"><div class="edName"><span class="num">${i + 1}</span> <b></b></div>
        <div class="edMeta small mono"></div><div class="edBadges"></div></div>`;
    row.querySelector("b").textContent = noteLabel(s.note) || s.clip;
    row.querySelector(".edMeta").textContent = `${s.clip} · ${fmt(+s.in)}–${fmt(+s.out)} · ${fmt(edDur(s))} ${t("с")}`;
    row.querySelector(".edBadges").innerHTML = edBadges(s).map((x) => `<span>${x}</span>`).join("");
    thumbStyle(row.querySelector(".edThumb"), s.clip, (+s.in + +s.out) / 2, 36, 64);
    row.querySelector(".edThumb").onclick = (e) => { e.stopPropagation(); edStop(); bdPreview({ ...s, in: +s.in, out: +s.out }); };
    row.onclick = () => {
      ED.sel = ED.sel === s.id ? null : s.id;
      const v = versionSeg(s.id);
      if (v && ED.sel) { video.pause(); seek(v.start + 0.05); }
      renderEdit();
    };
    row.querySelector(".edGrip").addEventListener("pointerdown", (e) => edDragStart(e, s));
    row.querySelector(".edGrip").onclick = (e) => e.stopPropagation();
    list.appendChild(row);
    if (s.id === ED.sel) list.appendChild(edProps(s, i));
  });
  edBox.scrollTop = scroll;
}

// ---------- properties of the selected shot ----------
function edProps(s, i) {
  const p = document.createElement("div");
  p.className = "edProps";
  const vol = s.volume == null ? 1 : +s.volume;
  p.innerHTML = `
    <label class="edField"><span>${t("Назва")}</span><input type="text" class="edNote" maxlength="80"></label>
    <div class="edField"><span>${t("Швидкість")}</span><div class="seg3 edSpeed"></div></div>
    <div class="edField"><span>${t("Звук")}</span>
      <div class="edVolRow"><button class="icon edMute" title="${vol === 0 ? t("Увімкнути звук") : t("Вимкнути звук")}">${vol === 0 ? ICON.mute : ICON.sound}</button>
        <input type="range" class="edVol" min="0" max="100" value="${Math.round(vol * 100)}"><span class="mono edVolV">${Math.round(vol * 100)}%</span></div></div>
    <div class="edField"><span>${t("Кадрування")}</span>
      <div class="edCropRow"><div class="edCrop"><div class="edCropImg"></div><div class="edCropWin" title="${t("Тягни, щоб вибрати частину кадру")}"></div></div>
        <div class="edCropCtl"><div class="edZoomRow"><input type="range" class="edZoom" min="100" max="250" value="${Math.round((+s.zoom || 1) * 100)}">
          <span class="mono edZoomV">×${(+s.zoom || 1).toFixed(2)}</span></div>
          <div class="muted small">${t("Наблизь повзунком і тягни рамку на мініатюрі, щоб вибрати частину кадру.")}</div>
          <button class="edCropReset">${t("Увесь кадр")}</button></div></div></div>
    <div class="row edActs">
      <button class="edTrim">${ICON.trim}<span>${t("Підрізати")}</span></button>
      <button class="edIns">${ICON.plus}<span>${t("Вставити після")}</span></button>
      <button class="icon edUp" title="${t("На одне місце раніше")}" ${i === 0 ? "disabled" : ""}>${ICON.up}</button>
      <button class="icon edDown" title="${t("На одне місце пізніше")}" ${i === ED.segs.length - 1 ? "disabled" : ""}>${ICON.down}</button>
      <span class="spacer"></span>
      <button class="danger edDel" ${ED.segs.length <= 1 ? "disabled" : ""}>${ICON.del}<span>${t("Прибрати")}</span></button>
    </div>`;
  const note = p.querySelector(".edNote");
  note.value = noteLabel(s.note) || "";
  note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); note.blur(); } if (e.key === "Escape") { note.value = noteLabel(s.note) || ""; note.blur(); } });
  note.addEventListener("blur", () => { const v = note.value.trim(); if (v && v !== (noteLabel(s.note) || "")) edSet(s, { note: v }); else renderEdit(); });
  const sp = p.querySelector(".edSpeed"), cur = speedId(s);
  for (const o of SPEEDS) {
    const b = document.createElement("button");
    b.textContent = o.label;
    b.title = t(o.title);
    b.classList.toggle("on", o.id === cur);
    b.onclick = (e) => { e.stopPropagation(); if (o.id !== cur) edSet(s, o.props); };
    sp.appendChild(b);
  }
  if (!SPEEDS.some((o) => o.id === cur)) {   // a speed set by Claude that is not one of the presets
    const b = document.createElement("button");
    b.textContent = cur[0] === "r" ? "×" + cur.slice(1) : cur.slice(1) + "×";
    b.classList.add("on");
    sp.appendChild(b);
  }
  const vr = p.querySelector(".edVol"), vv = p.querySelector(".edVolV");
  vr.oninput = () => { vv.textContent = vr.value + "%"; };
  vr.onchange = () => edSet(s, { volume: vr.value / 100 });
  p.querySelector(".edMute").onclick = () => edSet(s, { volume: vol === 0 ? 1 : 0 });
  edCrop(p, s);
  p.querySelector(".edTrim").onclick = () => { const k = segs().findIndex((x) => x.id === s.id); if (k >= 0) window.editShot(k); else edMsg(t("Цього кадру ще немає у відео: зроби версію, щоб підрізати його в редакторі."), true); };
  p.querySelector(".edIns").onclick = () => edInsertAfter(s);
  p.querySelector(".edUp").onclick = () => edMove(s, -1);
  p.querySelector(".edDown").onclick = () => edMove(s, 1);
  p.querySelector(".edDel").onclick = () => edDelete(s);
  p.addEventListener("click", (e) => e.stopPropagation());
  return p;
}

// crop: the same maths as render.py crop_box(): 9:16 window, zoom shrinks it, x / y = its centre in the source
function cropWin(c, zoom, x, y) {
  const sw = c.width, sh = c.height, target = 9 / 16;
  const bw = Math.min(sw, sh * target), z = Math.max(1, zoom);
  const cw = bw / z, ch = cw / target;
  const x0 = clamp(x * sw - cw / 2, 0, sw - cw), y0 = clamp(y * sh - ch / 2, 0, sh - ch);
  return { sw, sh, cw, ch, x0, y0 };
}
function edCrop(p, s) {
  const c = S.clips[s.clip];
  if (!c) return;
  const box = p.querySelector(".edCrop"), img = p.querySelector(".edCropImg"), win = p.querySelector(".edCropWin");
  const BW = 90, BH = Math.round(BW * c.height / c.width);
  box.style.width = BW + "px";
  box.style.height = BH + "px";
  thumbStyle(img, s.clip, (+s.in + +s.out) / 2, BW, BH);
  const st = { zoom: +s.zoom || 1, x: s.x ?? 0.5, y: s.y ?? 0.5 };
  const draw = () => {
    const w = cropWin(c, st.zoom, st.x, st.y);
    Object.assign(win.style, { left: (w.x0 / w.sw) * BW + "px", top: (w.y0 / w.sh) * BH + "px",
                               width: (w.cw / w.sw) * BW + "px", height: (w.ch / w.sh) * BH + "px" });
    p.querySelector(".edZoomV").textContent = "×" + st.zoom.toFixed(2);
  };
  draw();
  const zr = p.querySelector(".edZoom");
  zr.oninput = () => { st.zoom = zr.value / 100; draw(); };
  zr.onchange = () => edSet(s, { zoom: st.zoom, x: st.x, y: st.y });
  p.querySelector(".edCropReset").onclick = () => edSet(s, { zoom: 1, x: 0.5, y: 0.5 });
  win.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    win.setPointerCapture(e.pointerId);
    const w0 = cropWin(c, st.zoom, st.x, st.y), sx = e.clientX, sy = e.clientY;
    const cx0 = w0.x0 + w0.cw / 2, cy0 = w0.y0 + w0.ch / 2;
    let moved = false;
    const move = (ev) => {
      moved = true;
      st.x = clamp(cx0 + ((ev.clientX - sx) / BW) * w0.sw, w0.cw / 2, w0.sw - w0.cw / 2) / w0.sw;
      st.y = clamp(cy0 + ((ev.clientY - sy) / BH) * w0.sh, w0.ch / 2, w0.sh - w0.ch / 2) / w0.sh;
      draw();
    };
    const up = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      if (moved) edSet(s, { x: Math.round(st.x * 1000) / 1000, y: Math.round(st.y * 1000) / 1000 });
    };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
  });
}

// insert a new shot after this one: the clip editor opens with the footage library beside it
function edInsertAfter(s) {
  edStop();
  openClip(s.clip, Math.min(S.clips[s.clip].duration - 0.1, +s.out + 0.5));
  $("#mMode").value = "after";
  fillWhere();
  $("#mWhere").value = s.id;
  const n = ED.segs.indexOf(s) + 1;
  $("#mAddStatus").textContent = t("Вибери шматок (можна з іншого кліпу ліворуч) і натисни «Додати у відео»: він стане після кадру #{n}.", { n });
}

// ---------- drag to reorder (pointer events: mouse, pen and touch) ----------
function edDragStart(e, s) {
  e.preventDefault();
  e.stopPropagation();
  const rows = [...edBox.querySelectorAll(".edRow")];
  const from = rows.findIndex((r) => r.dataset.id === s.id);
  ED.drag = { from, p: from };
  rows[from].classList.add("dragging");
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const y = ev.clientY;
    let p = rows.length;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k].getBoundingClientRect();
      if (y < r.top + r.height / 2) { p = k; break; }
    }
    ED.drag.p = p;
    const q = p > from ? p - 1 : p;
    rows.forEach((r, k) => {
      r.classList.toggle("dropBefore", q !== from && p <= from && k === p);
      r.classList.toggle("dropAfter", q !== from && p > from && k === p - 1);
    });
    const eb = edBox.getBoundingClientRect();   // scroll the panel near its edges
    if (y < eb.top + 40) edBox.scrollTop -= 14; else if (y > eb.bottom - 40) edBox.scrollTop += 14;
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    const { from: f, p } = ED.drag;
    ED.drag = null;
    rows.forEach((r) => r.classList.remove("dragging", "dropBefore", "dropAfter"));
    const q = p > f ? p - 1 : p;
    if (q === f) { renderEdit(); return; }
    const ids = ED.segs.map((x) => x.id);
    const [id] = ids.splice(f, 1);
    ids.splice(q, 0, id);
    edApi({ op: "order", ids }, t("Порядок змінено"));
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

// ---------- play the draft without rendering: shot after shot from the proxies (crop + speed, no sound) ----------
function edPlayAll(from) {
  edStop();
  if (typeof closeBoardPreview === "function") closeBoardPreview();
  if (!ED.segs.length) return;
  video.pause();
  ED.play = { i: from || 0 };
  bdPv.classList.remove("hidden");
  bdLbl.classList.remove("hidden");
  edLoad();
  requestAnimationFrame(edTick);
}
function edLoad() {
  const s = ED.segs[ED.play.i];
  if (!s) { edStop(); return; }
  const url = proxyUrl(s.clip), z = Math.max(1, +s.zoom || 1);
  const x = clamp(s.x ?? 0.5, 0.5 / z, 1 - 0.5 / z), y = clamp(s.y ?? 0.5, 0.5 / z, 1 - 0.5 / z);
  bdPv.style.transform = z > 1.001 ? `scale(${z}) translate(${(0.5 - x) * 100}%, ${(0.5 - y) * 100}%)` : "";
  const rate = clamp((s.out - s.in) / Math.max(0.05, edDur(s)), 0.25, 16);
  bdLbl.textContent = t("Чернетка · кадр {n} з {m} · клік — зупинити", { n: ED.play.i + 1, m: ED.segs.length });
  const go = () => { if (!ED.play) return; bdPv.playbackRate = rate; bdPv.currentTime = +s.in; bdPv.play().catch(() => {}); };
  if (bdPv.dataset.src === url && bdPv.readyState >= 1) go();
  else { bdPv.dataset.src = url; bdPv.src = url; bdPv.addEventListener("loadedmetadata", go, { once: true }); }
  ED.play.started = performance.now();
  $$("#edList .edRow").forEach((r) => r.classList.toggle("playing", r.dataset.id === s.id));
}
function edTick() {
  if (!ED.play) return;
  const s = ED.segs[ED.play.i];
  if (!s) { edStop(); return; }
  const wrapped = bdPv.readyState >= 1 && performance.now() - ED.play.started > 400 && bdPv.currentTime < +s.in - 0.3;
  if (s && bdPv.readyState >= 1 && (bdPv.currentTime >= +s.out - 0.03 || wrapped)) { ED.play.i++; edLoad(); }
  if (ED.play) requestAnimationFrame(edTick);
}
function edStop() {
  if (!ED.play) return;
  ED.play = null;
  bdPv.pause();
  bdPv.classList.add("hidden");
  bdLbl.classList.add("hidden");
  bdReset();
  $$("#edList .edRow.playing").forEach((r) => r.classList.remove("playing"));
}
bdPv.addEventListener("click", () => edStop());
video.addEventListener("play", edStop);

// ---------- effects: apply straight to the edit (no Claude) ----------
const fxApply = $("#fxApply");
if (fxApply) fxApply.onclick = async () => {
  const txt = fxSummaryText();
  const effects = { global: fxSettings(), pushin: FX.st.on.pushin ? { strength: FX.st.k.pushin, scope: FX.st.pushScope, seg_id: FX.st.pushSeg } : null };
  $("#fxStatus").textContent = t("застосовую…");
  const d = await edApi({ op: "effects", effects }, "");
  $("#fxStatus").textContent = d ? t("✓ Застосовано{fx}. У відео — після «Зробити версію».", { fx: txt ? ": " + txt : "" }) : t("не вийшло");
};

// ---------- the main version ----------
const makeMain = $("#makeMain");
if (makeMain) makeMain.onclick = async () => {
  if (!S.V) return;
  const res = await fetch(`/api/episodes/${enc(S.ep)}/current`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: S.V.file }),
  });
  if (res.ok) { await poll(); if (typeof renderOldVer === "function") renderOldVer(); }
};

// ---------- keys: ⌘Z / ⇧⌘Z everywhere, Delete in this tab ----------
document.addEventListener("keydown", (e) => {
  if (e.target.matches && e.target.matches("input, textarea, select")) return;
  if (!$("#modal").classList.contains("hidden")) return;
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.shiftKey) edRedo(); else edUndo();
    return;
  }
  if (S.sideTab === "edit" && ED.sel && (e.key === "Delete" || e.key === "Backspace")) {
    const s = ED.segs.find((x) => x.id === ED.sel);
    if (s) { e.preventDefault(); e.stopImmediatePropagation(); edDelete(s); }
  }
  if (e.key === "Escape" && ED.play) edStop();
}, true);

// ---------- hooks (chained after studio.js and board.js) ----------
(() => {
  const prevData = window.onEpisodeData, prevTab = window.onSideTab, prevVer = window.onVersionHook, prevSeg = window.onSegChangeHook;
  window.onEpisodeData = (d, initial) => {
    if (prevData) prevData(d, initial);
    const sig = JSON.stringify([d.edl_segs || [], d.undo || {}]);
    if (initial || sig !== ED.sig) {
      ED.sig = sig;
      ED.segs = (d.edl_segs || []).map((s) => ({ ...s, in: +s.in, out: +s.out }));
      ED.undo = d.undo || {};
      if (ED.sel && !ED.segs.some((s) => s.id === ED.sel)) ED.sel = null;
      renderEdit();
    }
  };
  window.onSideTab = (tab) => { if (prevTab) prevTab(tab); if (tab === "edit") renderEdit(); else edStop(); };
  window.onVersionHook = () => { if (prevVer) prevVer(); renderEdit(); };
  window.onSegChangeHook = () => {
    if (prevSeg) prevSeg();
    if (S.sideTab !== "edit") return;
    const id = (segs()[S.curIdx] || {}).id;
    $$("#edList .edRow").forEach((r) => r.classList.toggle("edNow", r.dataset.id === id));
  };
})();

// Shot board ("Кадри" tab): for every shot of the edit, Claude's pick and alternatives from the footage.
// ▶ plays the candidate range (cropped like the edit) over the player; «Взяти» puts it into edl.json
// (server: POST /api/episodes/<ep>/board/pick → backup in edl_history/, entry in instructions.json).
const BD = { board: null, edl: [], key: "", prev: null, busy: false, msg: {} };
const bdPv = $("#trPreview");
const bdLbl = $("#trPreviewLbl");
const BD_TRANS_LABEL = bdLbl.textContent;
const PLAY_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M8 5.5v13l10.5-6.5z"/></svg>';

// tempo of a shot: timelapse speed or plain speed (same range at another speed is another candidate)
const bdTempoKey = (x) => (x.ramp && +x.ramp.speed > 1.001 ? "r" + +x.ramp.speed : "s" + (+(x.speed ?? 1)).toFixed(3));
const bdSame = (s, c) => !!s && s.clip === c.clip && Math.abs(+s.in - c.in) < 0.011 && Math.abs(+s.out - c.out) < 0.011
  && (s.zoom == null || c.zoom == null || Math.abs(+s.zoom - +c.zoom) < 0.011)
  && (s.speed === undefined && s.ramp === undefined ? true : bdTempoKey(s) === bdTempoKey(c));
// timeline length of a candidate; a "ramp" (timelapse) uses the same formula as render.py:ramp_out
function bdDur(c) {
  const L = c.out - c.in, rp = c.ramp;
  if (rp && +rp.speed > 1.001) {
    const S = +rp.speed, h = rp.hold ?? 0.4, r = rp.ease ?? 0.6;
    return 2 * h + (2 * r * Math.log(S)) / (S - 1) + (L - 2 * h - 2 * r) / S;
  }
  return L / (c.speed || 1);
}
// how fast the ▶ preview plays: timelapses as fast as the browser allows, slow motion slowed down
const bdRate = (c) => (c.ramp && +c.ramp.speed > 1.001 ? Math.min(16, +c.ramp.speed) : clamp(+c.speed || 1, 0.25, 4));
function bdTempo(c) {
  if (c.ramp && +c.ramp.speed > 1.001) return t(" · таймлапс ×{x}", { x: +c.ramp.speed });
  if ((+c.speed || 1) < 0.999) return t(" · сповільнено ×{x}", { x: (+c.speed).toFixed(2) });
  if ((+c.speed || 1) > 1.001) return t(" · швидше ×{x}", { x: (+c.speed).toFixed(2) });
  return "";
}

function renderBoard() {
  const box = $("#tabBoard");
  if (!box || S.sideTab !== "board") return;
  const b = BD.board;
  if (!b || !Array.isArray(b.steps) || !b.steps.length) {
    box.innerHTML = `<p class="muted small bdIntro">${t("Для цього відео дошки кадрів ще немає.")}</p>`;
    return;
  }
  const scroll = box.scrollTop;
  const edl = new Map(BD.edl.map((s) => [s.id, s]));
  const order = BD.edl.map((s) => s.id);
  const baked = new Map(segs().map((s) => [s.id, s]));
  box.innerHTML = "";
  const intro = document.createElement("p");
  intro.className = "muted small bdIntro";
  intro.textContent = t("Для кожного кадру монтажу: мій вибір (перший) і альтернативи з матеріалу. "
    + "▶ — подивитись шматок, «Взяти» — одразу в монтаж. Нову версію робить «Зробити версію».");
  box.appendChild(intro);
  let part = null;
  for (const st of b.steps) {
    const seg = edl.get(st.seg_id);
    const n = order.indexOf(st.seg_id) + 1;
    if (st.part !== part) {
      part = st.part;
      const h = document.createElement("h3");
      h.className = "bdPart";
      h.textContent = part || "";
      box.appendChild(h);
    }
    const el = document.createElement("div");
    el.className = "bdStep";
    el.dataset.seg = st.seg_id;
    const vs = baked.get(st.seg_id);
    const stale = seg && vs && !bdSame(vs, { clip: seg.clip, in: +seg.in, out: +seg.out, zoom: seg.zoom,
                                             speed: seg.speed, ramp: seg.ramp || undefined });
    el.innerHTML = `<div class="bdHead"><span class="num">${n || "–"}</span><b></b>
      <span class="bdState small"></span></div><div class="bdCands"></div>`;
    el.querySelector("b").textContent = noteLabel(st.title) || st.seg_id;
    const state = el.querySelector(".bdState");
    if (!seg) state.textContent = t("кадру немає в монтажі");
    else if (stale) { state.textContent = t("ще не у відео"); state.classList.add("pend"); }
    else if (BD.msg[st.id]) state.textContent = BD.msg[st.id];
    if (vs) {
      const head = el.querySelector(".bdHead");
      head.classList.add("go");
      head.title = t("Перейти до цього кадру у відео");
      head.onclick = () => { video.pause(); seek(vs.start + 0.05); };
    }
    const list = el.querySelector(".bdCands");
    st.cands.forEach((c, k) => {
      const on = bdSame(seg, c);
      const card = document.createElement("div");
      card.className = "bdCand" + (on ? " on" : "");
      card.innerHTML = `<button class="bdThumb" title="${t("Подивитись цей шматок")}">${PLAY_SVG}</button>
        <div class="bdInfo">
          <div class="bdMeta mono"></div>
          <div class="bdWhy small"></div>
          <div class="bdAct"></div>
        </div>`;
      const th = card.querySelector(".bdThumb");
      thumbStyle(th, c.clip, (c.in + c.out) / 2, 54, 96);
      th.onclick = () => bdPreview(c);
      card.querySelector(".bdMeta").textContent =
        `${k === 0 && !/^(твій вибір|your pick)/i.test(c.why || "") ? t("вибір Claude · ") : ""}${c.clip} · ${fmt(c.in)}–${fmt(c.out)} · ${fmt(bdDur(c))} ${t("с")}`
        + bdTempo(c) + (c.zoom > 1.001 ? t(" · кроп ×{x}", { x: (+c.zoom).toFixed(2) }) : "") + (c.volume === 0 ? t(" · без звуку") : "");
      card.querySelector(".bdWhy").textContent = c.why || "";
      const act = card.querySelector(".bdAct");
      if (on) {
        act.innerHTML = `<span class="bdIn small">${t("✓ у монтажі")}</span>`;
      } else if (seg) {
        const btn = document.createElement("button");
        btn.textContent = t("Взяти");
        btn.disabled = BD.busy;
        btn.onclick = () => bdPick(st, k);
        act.appendChild(btn);
      }
      list.appendChild(card);
    });
    box.appendChild(el);
  }
  box.scrollTop = scroll;
  markBoardCur();
}
// the shot on screen is outlined on the board; «Варіанти» in the current-shot card scrolls to it
function markBoardCur() {
  const s = segs()[S.curIdx];
  $$("#tabBoard .bdStep").forEach((el) => el.classList.toggle("cur", !!s && el.dataset.seg === s.id));
}
window.boardFocus = (segId) => {
  const el = document.querySelector(`#tabBoard .bdStep[data-seg="${segId}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
};
// number of alternatives for the shot on screen (button in the current-shot card)
window.onNowShot = (s) => {
  const st = s && BD.board && (BD.board.steps || []).find((x) => x.seg_id === s.id);
  const n = st ? Math.max(0, st.cands.length - 1) : 0;
  $("#nowAlt").classList.toggle("hidden", !n);
  $("#nowAltN").textContent = n ? n : "";
  if (S.sideTab === "board") markBoardCur();
};

async function bdPick(st, k) {
  BD.busy = true;
  BD.msg[st.id] = t("вношу…");
  renderBoard();
  try {
    const res = await fetch(`/api/episodes/${enc(S.ep)}/board/pick`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: st.id, cand: k }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(t(d.error || "помилка"));
    BD.edl = BD.edl.map((s) => (s.id === d.segment.id
      ? { ...s, clip: d.segment.clip, in: d.segment.in, out: d.segment.out, zoom: d.segment.zoom,
          speed: d.segment.speed, ramp: d.segment.ramp || null } : s));
    if (window.ST2) { ST2.edlSegs = BD.edl; if (typeof markPending === "function") markPending(); }
    BD.msg[st.id] = "";
  } catch (e) {
    BD.msg[st.id] = t("не вийшло: {e}", { e: e.message });
  } finally {
    BD.busy = false;
    renderBoard();
  }
}

// ---------- preview of a candidate over the player (the same overlay the transition preview uses) ----------
function bdPreview(c) {
  const url = proxyUrl(c.clip);
  video.pause();
  BD.prev = { a: c.in, b: c.out, url };
  const z = Math.max(1, +c.zoom || 1);
  const x = clamp(c.x ?? 0.5, 0.5 / z, 1 - 0.5 / z), y = clamp(c.y ?? 0.5, 0.5 / z, 1 - 0.5 / z);
  bdPv.style.transform = z > 1.001 ? `scale(${z}) translate(${(0.5 - x) * 100}%, ${(0.5 - y) * 100}%)` : "";
  const rate = bdRate(c);
  bdLbl.textContent = t("{clip} · {a}–{b} с{rate} · клік — закрити", { clip: c.clip, a: fmt(c.in), b: fmt(c.out), rate: rate !== 1 ? ` · ×${rate}` : "" });
  bdPv.classList.remove("hidden");
  bdLbl.classList.remove("hidden");
  const go = () => {
    bdPv.playbackRate = rate;
    bdPv.currentTime = c.in;
    bdPv.play().catch(() => {});
    requestAnimationFrame(bdTick);
  };
  if (bdPv.dataset.src === url && bdPv.readyState >= 1) go();
  else {
    bdPv.dataset.src = url;
    bdPv.src = url;
    bdPv.addEventListener("loadedmetadata", go, { once: true });
  }
}
function bdTick() {
  if (!BD.prev || bdPv.classList.contains("hidden")) return;
  if (bdPv.currentTime >= BD.prev.b || bdPv.currentTime < BD.prev.a - 0.3) bdPv.currentTime = BD.prev.a;
  requestAnimationFrame(bdTick);
}
function bdReset() {  // hand the overlay back to the transition preview untouched
  BD.prev = null;
  bdPv.style.transform = "";
  bdPv.playbackRate = 1;
  bdLbl.textContent = BD_TRANS_LABEL;
}
function closeBoardPreview() {
  if (!BD.prev) return;
  bdPv.pause();
  bdPv.classList.add("hidden");
  bdLbl.classList.add("hidden");
  bdReset();
}
bdPv.addEventListener("loadstart", () => {
  if (BD.prev && !bdPv.currentSrc.includes(BD.prev.url.split("?")[0])) { delete bdPv.dataset.src; bdReset(); }
});
bdPv.addEventListener("click", () => { if (BD.prev) bdReset(); });
video.addEventListener("play", () => { if (BD.prev) closeBoardPreview(); });

// ---------- hooks (chained after studio.js) ----------
(() => {
  const prevData = window.onEpisodeData, prevTab = window.onSideTab, prevVer = window.onVersionHook;
  window.onEpisodeData = (d, initial) => {
    if (prevData) prevData(d, initial);
    const key = JSON.stringify([d.board || null, d.edl_segs || []]);
    if (initial || key !== BD.key) {
      BD.key = key;
      BD.board = d.board || null;
      BD.edl = d.edl_segs || [];
      renderBoard();
    }
  };
  window.onSideTab = (tab) => {
    if (prevTab) prevTab(tab);
    if (tab === "board") renderBoard(); else closeBoardPreview();
  };
  window.onVersionHook = () => { if (prevVer) prevVer(); renderBoard(); };
})();

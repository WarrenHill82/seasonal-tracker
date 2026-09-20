const state = {
  range: "today",
  settings: {},
  meta: {},
  schedule: null,
  library: [],
  pickerPage: 1,
  pickerHasNext: false,
  pickerSeason: null,
  pickerYear: null,
  searchTimer: null,
  notifications: [],
};

const $ = (sel) => document.querySelector(sel);
const board = $("#board");

const DAY_ACCENTS = ["#7ad0ff", "#8b7bff", "#3dd68c", "#f0c36a", "#ff8a5b", "#ff9aa2", "#5b8def"];

function notify(type, title, detail = "") {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    title,
    detail,
    time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
  state.notifications = [item, ...state.notifications].slice(0, 20);
  const list = $("#notify-list");
  if (list) {
    list.innerHTML = state.notifications
      .map(
        (n) => `
          <div class="notify-item ${n.type}">
            <div class="notify-headline">
              <span class="notify-tag">${n.type === "error" ? "Error" : n.type === "warn" ? "Warn" : "Info"}</span>
              <time>${n.time}</time>
            </div>
            <strong>${n.title}</strong>
            ${n.detail ? `<small>${n.detail}</small>` : ""}
          </div>
        `,
      )
      .join("");
  }
  const panel = $("#notify-panel");
  if (panel && !panel.classList.contains("hidden") && type === "error") {
    panel.classList.remove("hidden");
  }
  const badge = $("#notify-badge");
  if (badge) {
    const hasError = state.notifications.some((n) => n.type === "error");
    badge.classList.toggle("hidden", !hasError);
  }
}

function reportError(err, context = "Request failed") {
  const message = err && err.message ? err.message : String(err || "Unknown error");
  notify("error", context, message);
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2200);
}

async function api(path, opts = {}) {
  const req = {
    headers: { "Content-Type": "application/json" },
    ...opts,
  };

  try {
    const res = await fetch(path, req);
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || res.statusText || `HTTP ${res.status}`);
      err.status = res.status;
      err.__reported = true;
      reportError(err, `Request failed: ${path}`);
      throw err;
    }
    return data;
  } catch (err) {
    if (!err || err.__reported) throw err;
    err.__reported = true;
    reportError(err, `Request failed: ${path}`);
    throw err;
  }
}

window.api = api;
window.reportError = reportError;
window.notify = notify;

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function countdown(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "aired";
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme || "dark";
  document.body.classList.toggle("compact", !!state.settings.compact);
  $("#btn-layout").textContent = state.settings.layout === "stacks" ? "Stacks" : "Rows";
  const pick = state.settings.pickerLayout || "tiles";
  document.querySelectorAll("#picker-layout button").forEach((b) => {
    b.classList.toggle("active", b.dataset.pick === pick);
  });
  const grid = $("#picker-grid");
  grid.classList.toggle("tiles", pick === "tiles");
  grid.classList.toggle("rows", pick === "rows");
  const combinedLegend = $("#combined-legend");
  if (combinedLegend) {
    combinedLegend.hidden = state.settings.progressMode !== "combined";
  }
}

function episodeTotal(show) {
  return show.episodes || Math.max(show.subAired || 0, show.dubAired || 0, show.nextSubEpisode || 0, 12);
}

function nextEpisode(show, kind) {
  if (kind === "dub") return (show.nextEvents || []).find((e) => e.kind === "dub")?.episode;
  if (kind === "combined") {
    const events = show.nextEvents || [];
    return events[0]?.episode || show.nextSubEpisode;
  }
  return show.nextSubEpisode;
}

function pipClass(n, aired, watched, nextEp) {
  const cls = ["pip"];
  if (watched >= n) cls.push("watched");
  else if (aired >= n) cls.push("aired");
  else cls.push("future");
  if (nextEp === n) cls.push("next");
  return cls.join(" ");
}

function combinedPipClass(n, show) {
  const cls = ["pip"];
  const watched = Math.max(show.watchedSub || 0, show.watchedDub || 0);
  const subAired = show.subAired || 0;
  const dubAired = show.dubAired || 0;
  if (watched >= n) cls.push("watched");
  else if (dubAired >= n) cls.push("dub-aired");
  else if (subAired >= n) cls.push("sub-aired");
  else cls.push("future");
  if (nextEpisode(show, "combined") === n) cls.push("next");
  return cls.join(" ");
}

function makePip(n, className, title, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = String(n);
  el.setAttribute("aria-label", title);
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return el;
}

function pips(show, kind) {
  const total = Math.min(episodeTotal(show), 26);
  const wrap = document.createElement("div");
  wrap.className = "pips";
  for (let n = 1; n <= total; n += 1) {
    if (kind === "combined") {
      wrap.appendChild(
        makePip(n, combinedPipClass(n, show), `Ep ${n}`, () => {
          const current = Math.max(show.watchedSub || 0, show.watchedDub || 0);
          setProgress(show, "combined", n === current ? n - 1 : n);
        }),
      );
    } else {
      const aired = kind === "dub" ? show.dubAired || 0 : show.subAired || 0;
      const watched = kind === "dub" ? show.watchedDub || 0 : show.watchedSub || 0;
      wrap.appendChild(
        makePip(n, pipClass(n, aired, watched, nextEpisode(show, kind)), `${kind.toUpperCase()} ep ${n}`, () => {
          setProgress(show, kind, n === watched ? n - 1 : n);
        }),
      );
    }
  }
  if ((show.episodes || 0) > 26) {
    const more = document.createElement("span");
    more.className = "counts";
    more.textContent = `+${show.episodes - 26}`;
    wrap.appendChild(more);
  }
  return wrap;
}

function trackRow(show, kind) {
  const row = document.createElement("div");
  row.className = "track";
  const lbl = kind === "combined" ? "EPS" : kind.toUpperCase();
  row.innerHTML = `<span class="lbl">${lbl}</span>`;
  row.appendChild(pips(show, kind));
  const counts = document.createElement("span");
  counts.className = "counts";
  if (kind === "combined") {
    const subA = show.subAired;
    const dubA = show.dubAired;
    const total = show.episodes;
    counts.textContent = `S ${subA ?? "?"} · D ${dubA ?? "?"} / ${total ?? "?"}`;
  } else {
    const aired = kind === "dub" ? show.dubAired : show.subAired;
    const remaining = kind === "dub" ? show.remainingDub : show.remainingSub;
    const total = show.episodes;
    if (aired == null && remaining == null) counts.textContent = "—";
    else counts.textContent = `${aired ?? "?"} / ${total ?? "?"} · ${remaining == null ? "?" : remaining} left`;
  }
  row.appendChild(counts);
  return row;
}

function stackCol(show, kind) {
  const total = Math.min(episodeTotal(show), 16);
  const posterTop = state.settings.stackPoster === "top";
  const col = document.createElement("div");
  col.className = "stack-col";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = kind === "combined" ? "EPS" : kind.toUpperCase();
  if (posterTop) col.appendChild(tag);
  for (let n = 1; n <= total; n += 1) {
    if (kind === "combined") {
      col.appendChild(
        makePip(n, combinedPipClass(n, show), `Ep ${n}`, () => {
          const current = Math.max(show.watchedSub || 0, show.watchedDub || 0);
          setProgress(show, "combined", n === current ? n - 1 : n);
        }),
      );
    } else {
      const aired = kind === "dub" ? show.dubAired || 0 : show.subAired || 0;
      const watched = kind === "dub" ? show.watchedDub || 0 : show.watchedSub || 0;
      col.appendChild(
        makePip(n, pipClass(n, aired, watched, nextEpisode(show, kind)), `${kind.toUpperCase()} ep ${n}`, () => {
          setProgress(show, kind, n === watched ? n - 1 : n);
        }),
      );
    }
  }
  if (!posterTop) col.appendChild(tag);
  return col;
}

function appendTracks(target, show, mode) {
  if (state.settings.progressMode === "combined") {
    target.appendChild(mode === "stack" ? stackCol(show, "combined") : trackRow(show, "combined"));
    return;
  }
  if (state.settings.showSub !== false) {
    target.appendChild(mode === "stack" ? stackCol(show, "sub") : trackRow(show, "sub"));
  }
  if (state.settings.showDub !== false) {
    target.appendChild(mode === "stack" ? stackCol(show, "dub") : trackRow(show, "dub"));
  }
}

function showMeta(show) {
  const bits = [];
  const foci = show.focusAll && show.focusAll.length ? show.focusAll : (show.focus ? [show.focus] : []);
  if (foci.length) {
    foci.forEach((focus) => {
      bits.push(`<span class="chip next">${focus.kind.toUpperCase()} ${focus.episode} · ${fmtTime(focus.at)} · ${countdown(focus.at)}</span>`);
    });
  } else if (show.nextEvents && show.nextEvents[0]) {
    const n = show.nextEvents[0];
    bits.push(`<span class="chip next">${n.kind.toUpperCase()} ${n.episode} · ${fmtTime(n.at)} · ${countdown(n.at)}</span>`);
  }
  if (show.score) bits.push(`<span class="chip">${(show.score / 10).toFixed(1)}</span>`);
  if (show.dubLag) bits.push(`<span class="chip warn">Dub ${show.dubLag} behind</span>`);
  if (show.dubDelayed) bits.push(`<span class="chip warn">Dub delayed</span>`);
  if (show.format) bits.push(`<span class="chip">${show.format}</span>`);
  return bits.join("");
}

function renderRow(show) {
  const card = document.createElement("article");
  card.dataset.sid = String(show.id);
  card.className = "row-card" + (state.settings.compact ? " compact" : "");
  card.innerHTML = `
    <img class="poster" src="${show.cover || ""}" alt="" />
    <div class="row-body">
      <div class="title-line">
        <h4>${show.title}</h4>
        <div class="progress-btns">
          <button type="button" data-act="remove">Remove</button>
        </div>
      </div>
      <div class="meta">${showMeta(show)}</div>
    </div>
  `;
  const body = card.querySelector(".row-body");
  appendTracks(body, show, "row");
  card.querySelector("[data-act=remove]").addEventListener("click", () => removeShow(show.id));
  return card;
}

function renderStack(show) {
  const posterTop = state.settings.stackPoster === "top";
  const card = document.createElement("article");
  card.dataset.sid = String(show.id);
  card.className = "stack-card" + (posterTop ? " poster-top" : "");
  const img = document.createElement("img");
  img.className = "poster";
  img.src = show.cover || "";
  const h = document.createElement("h4");
  h.textContent = show.title;
  const cols = document.createElement("div");
  cols.className = "stack-cols";
  appendTracks(cols, show, "stack");
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = showMeta(show);
  if (posterTop) {
    card.appendChild(img);
    card.appendChild(h);
    card.appendChild(cols);
    card.appendChild(meta);
  } else {
    card.appendChild(cols);
    card.appendChild(img);
    card.appendChild(h);
    card.appendChild(meta);
  }
  return card;
}

function isWeekRange(range) {
  return range === "this_week" || range === "next_week" || range === "week_after";
}

function paintCard(show) {
  return (state.settings.layout || "rows") === "stacks" ? renderStack(show) : renderRow(show);
}

function cardsClass() {
  const layout = state.settings.layout || "rows";
  const poster = state.settings.stackPoster === "top" ? " poster-top" : "";
  return `cards ${layout}${layout === "stacks" ? poster : ""}`;
}

function renderDaySection(label, shows, { column, accent } = {}) {
  const wrap = document.createElement("section");
  wrap.className = column ? "day-col" : "day-block";
  if (accent) wrap.style.setProperty("--day-accent", accent);
  wrap.innerHTML = `<h3>${label}</h3>`;
  const cards = document.createElement("div");
  cards.className = cardsClass();
  shows.forEach((s) => cards.appendChild(paintCard(s)));
  wrap.appendChild(cards);
  return wrap;
}

function renderBoard() {
  board.innerHTML = "";
  const layout = state.settings.layout || "rows";

  if (state.range === "library") {
    if (!state.library.length) {
      board.innerHTML = `<div class="empty">Nothing pinned yet. Click <b>Add shows</b> and pick this season’s titles.</div>`;
      return;
    }
    board.appendChild(renderDaySection(`Pinned shows · ${state.library.length}`, state.library));
    const panel = document.createElement("div");
    panel.className = "sync-panel";
    panel.innerHTML = '<button type="button" id="btn-add-library">Add shows</button><button type="button" id="btn-sync">Sync</button>';
    board.appendChild(panel);
    panel.querySelector("#btn-add-library").addEventListener("click", () => $("#btn-add").click());
    panel.querySelector("#btn-sync").addEventListener("click", async () => {
      const button = panel.querySelector("#btn-sync");
      button.disabled = true;
      button.textContent = "Syncing…";
      try {
        await api("/api/sync", { method: "POST", body: "{}" });
        toast("Library schedule synced");
        await loadSchedule();
      } finally {
        button.disabled = false;
        button.textContent = "Sync";
      }
    });
    return;
  }

  const days = state.schedule?.days || [];
  $("#range-label").textContent = `${state.schedule?.label || ""} · ${state.schedule?.count || 0} airings`;
  if (!days.length) {
    board.innerHTML = `<div class="empty">None of your pinned shows air in this window. Add more from the season list, or switch to <b>My shows</b>.</div>`;
    return;
  }

  if (isWeekRange(state.range) || layout === "stacks") {
    const strip = document.createElement("div");
    strip.className = "week-strip";
    days.forEach((day, i) => {
      strip.appendChild(renderDaySection(day.label, day.shows, { column: true, accent: DAY_ACCENTS[i % DAY_ACCENTS.length] }));
    });
    board.appendChild(strip);
    return;
  }

  days.forEach((day, i) => {
    board.appendChild(renderDaySection(day.label, day.shows, { accent: DAY_ACCENTS[i % DAY_ACCENTS.length] }));
  });
}

async function loadSchedule() {
  $("#range-label").textContent = "Refreshing…";
  if (state.range === "library") {
    const data = await api("/api/library");
    state.library = data.shows;
    $("#range-label").textContent = `${data.shows.length} pinned shows`;
    renderBoard();
    return;
  }
  const [sched, lib] = await Promise.all([
    api(`/api/schedule?range=${state.range}`),
    api("/api/library"),
  ]);
  state.schedule = sched;
  state.library = lib.shows;
  renderBoard();
}

async function setProgress(show, kind, value) {
  const body = { id: show.id };
  if (kind === "combined") {
    body.watchedSub = value;
    body.watchedDub = value;
  } else if (kind === "dub") body.watchedDub = value;
  else body.watchedSub = value;
  const data = await api("/api/library/progress", { method: "POST", body: JSON.stringify(body) });
  state.library = data.shows;
  await loadSchedule();
}

function markPickerItem(id, inLibrary) {
  document.querySelectorAll("#picker-grid .pick").forEach((el) => {
    if (Number(el.dataset.id) === Number(id)) {
      el.classList.toggle("in", inLibrary);
    }
  });
}

async function removeShow(id) {
  await api("/api/library/remove", { method: "POST", body: JSON.stringify({ id }) });
  toast("Removed from widget");
  markPickerItem(id, false);
  await loadSchedule();
}

async function addShow(item) {
  await api("/api/library/add", { method: "POST", body: JSON.stringify(item) });
  toast(`Pinned ${item.title}`);
  markPickerItem(item.id, true);
  await loadSchedule();
}

function fillSeasonSelect() {
  const sel = $("#season-select");
  const seasons = ["WINTER", "SPRING", "SUMMER", "FALL"];
  const year = state.meta.year;
  const opts = [];
  for (let y = year - 1; y <= year + 1; y += 1) {
    seasons.forEach((s) => opts.push(`<li data-value="${s}-${y}">${s} ${y}</li>`));
  }
  sel.innerHTML = `<button type="button" class="select-btn" aria-label="Season"></button><ul class="select-menu">${opts.join("")}</ul>`;
  const current = `${state.pickerSeason}-${state.pickerYear}`;
  const button = sel.querySelector(".select-btn");
  const items = [...sel.querySelectorAll("li")];
  const choose = (value) => {
    const item = items.find((li) => li.dataset.value === value) || items[0];
    state.pickerSeason = item.dataset.value.split("-")[0];
    state.pickerYear = Number(item.dataset.value.split("-")[1]);
    state.pickerPage = 1;
    state.pickerHasNext = false;
    button.textContent = item.textContent;
    items.forEach((li) => li.classList.toggle("active", li === item));
    sel.classList.remove("open");
    loadPicker();
  };
  button.textContent = current.replace("-", " ");
  button.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const willOpen = !sel.classList.contains("open");
    closeSelects();
    sel.classList.toggle("open", willOpen);
  });
  items.forEach((item) => item.addEventListener("click", (ev) => {
    ev.preventDefault();
    choose(item.dataset.value);
  }));
  choose(current);
}

function renderPick(m) {
  const layout = state.settings.pickerLayout || "tiles";
  const el = document.createElement("button");
  el.type = "button";
  el.className = "pick" + (layout === "rows" ? " pick-row" : "") + (m.inLibrary ? " in" : "");
  el.dataset.id = m.id;
  const meta = [m.format, m.episodes ? `${m.episodes} ep` : null, m.seasonYear].filter(Boolean).join(" · ");
  if (layout === "rows") {
    el.innerHTML = `<img src="${m.cover || ""}" alt="" /><span>${m.title}<small>${meta}</small></span>`;
  } else {
    el.innerHTML = `<img src="${m.cover || ""}" alt="" /><span>${m.title}</span>`;
  }
  el.addEventListener("mouseenter", () => {
    const tip = $("#hover-tip");
    if (!tip || !m.description) return;
    const title = document.createElement("strong");
    title.textContent = m.title;
    const description = document.createElement("div");
    description.textContent = m.description;
    tip.replaceChildren(title, description);
    tip.classList.remove("hidden");
    const rect = el.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 380))}px`;
    tip.style.top = `${Math.min(rect.bottom + 8, innerHeight - 140)}px`;
  });
  el.addEventListener("mouseleave", () => $("#hover-tip")?.classList.add("hidden"));
  el.addEventListener("click", () => {
    if (el.classList.contains("in")) removeShow(m.id);
    else addShow(m);
  });
  return el;
}

async function loadPicker(query) {
  const grid = $("#picker-grid");
  const scrollTop = grid.scrollTop;
  grid.innerHTML = "<p class='hint'>Loading titles…</p>";
  try {
    let media;
    if (query) {
      media = (await api(`/api/search?q=${encodeURIComponent(query)}&season=${state.pickerSeason}&year=${state.pickerYear}`)).media;
      $("#page-info").textContent = `${media.length} results`;
      state.pickerHasNext = false;
    } else {
      const data = await api(`/api/season?season=${state.pickerSeason}&year=${state.pickerYear}&page=${state.pickerPage}`);
      media = data.media;
      const p = data.pageInfo || {};
      state.pickerHasNext = Boolean(p.hasNextPage);
      $("#page-info").textContent = `${state.pickerSeason} ${state.pickerYear} · page ${p.currentPage || state.pickerPage}`;
    }
    $("#page-prev").disabled = !query && state.pickerPage <= 1;
    $("#page-next").disabled = Boolean(query) || !state.pickerHasNext;
    grid.innerHTML = "";
    media.forEach((m) => grid.appendChild(renderPick(m)));
    if (!media.length) grid.innerHTML = "<p class='hint'>No titles on this page.</p>";
    grid.scrollTop = scrollTop;
  } catch (err) {
    grid.innerHTML = `<p class="hint">Could not load catalog: ${err.message}</p>`;
  }
}

function closeSelects(except) {
  document.querySelectorAll(".select.open").forEach((el) => {
    if (el !== except) el.classList.remove("open");
  });
}

function setSelectValue(root, value) {
  const hidden = root.querySelector("input[type=hidden]");
  const btn = root.querySelector(".select-btn");
  const items = [...root.querySelectorAll("li")];
  const match = items.find((li) => li.dataset.value === value) || items[0];
  hidden.value = match.dataset.value;
  btn.textContent = match.textContent;
  items.forEach((li) => li.classList.toggle("active", li === match));
}

function wireSelects() {
  document.querySelectorAll(".select").forEach((root) => {
    const btn = root.querySelector(".select-btn");
    if (!btn) return;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const willOpen = !root.classList.contains("open");
      closeSelects();
      root.classList.toggle("open", willOpen);
    });
    root.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", (ev) => {
        ev.preventDefault();
        setSelectValue(root, li.dataset.value);
        root.classList.remove("open");
      });
    });
  });
  document.addEventListener("click", () => closeSelects());
}

function fillSettingsForm() {
  const form = $("#settings-form");
  const s = state.settings;
  setSelectValue(form.querySelector('[data-name="theme"]'), s.theme || "dark");
  setSelectValue(form.querySelector('[data-name="titleLanguage"]'), s.titleLanguage || "english");
  setSelectValue(form.querySelector('[data-name="weekStart"]'), s.weekStart || "sunday");
}

function syncDrawerFade() {
  const drawerOpen = !$("#drawer").classList.contains("hidden") || !$("#settings").classList.contains("hidden");
  document.body.classList.toggle("drawer-open", drawerOpen);
}

function wire() {
  const notifyPanel = $("#notify-panel");
  const notifyClose = $("#notify-close");
  const notifyButton = $("#btn-notifications");

  if (notifyButton) {
    notifyButton.addEventListener("click", () => {
      if (!notifyPanel) return;
      notifyPanel.classList.toggle("hidden");
    });
  }

  if (notifyClose) {
    notifyClose.addEventListener("click", () => notifyPanel && notifyPanel.classList.add("hidden"));
  }

  wireSelects();
  $("#btn-layout").addEventListener("click", async () => {
    const next = state.settings.layout === "stacks" ? "rows" : "stacks";
    state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify({ layout: next }) });
    applyTheme();
    renderBoard();
  });
  const openPicker = () => {
    $("#settings").classList.add("hidden");
    $("#drawer").classList.remove("hidden");
    syncDrawerFade();
    loadPicker();
  };
  $("#btn-add").addEventListener("click", openPicker);
  $("#drawer-close").addEventListener("click", () => {
    $("#drawer").classList.add("hidden");
    syncDrawerFade();
  });
  $("#btn-settings").addEventListener("click", () => {
    fillSettingsForm();
    $("#settings").classList.remove("hidden");
    syncDrawerFade();
  });
  $("#settings-close").addEventListener("click", () => {
    $("#settings").classList.add("hidden");
    syncDrawerFade();
  });
  $("#settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const payload = {
      theme: form.theme.value,
      titleLanguage: form.titleLanguage.value,
      weekStart: form.weekStart.value,
    };
    state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    applyTheme();
    $("#settings").classList.add("hidden");
    syncDrawerFade();
    toast("Settings saved");
    loadSchedule();
  });
  document.querySelectorAll("#picker-layout button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pick = btn.dataset.pick;
      state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify({ pickerLayout: pick }) });
      applyTheme();
      const q = $("#search").value.trim();
      loadPicker(q.length >= 2 ? q : null);
    });
  });
  $("#search").addEventListener("input", (ev) => {
    clearTimeout(state.searchTimer);
    const q = ev.target.value.trim();
    state.searchTimer = setTimeout(() => loadPicker(q.length >= 2 ? q : null), 280);
  });
  $("#page-prev").addEventListener("click", () => {
    state.pickerPage = Math.max(1, state.pickerPage - 1);
    loadPicker();
  });
  $("#page-next").addEventListener("click", () => {
    if (!state.pickerHasNext) return;
    state.pickerPage += 1;
    loadPicker();
  });
}

async function boot() {
  wire();
  state.meta = await api("/api/meta");
  state.settings = state.meta.settings || {};
  state.pickerSeason = state.meta.season;
  state.pickerYear = state.meta.year;
  $("#season-chip").textContent = `${state.meta.season} ${state.meta.year}`;
  fillSeasonSelect();
  applyTheme();
  await loadSchedule();
  setInterval(() => loadSchedule().catch(() => {}), 5 * 60 * 1000);
}

boot().catch((err) => {
  board.innerHTML = `<div class="empty">${err.message}</div>`;
});

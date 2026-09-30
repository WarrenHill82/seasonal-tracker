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
window.trackerSettingsReady = false;

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
  fetch("/api/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context,
      message,
      stack: err && err.stack ? err.stack : "",
    }),
    keepalive: true,
  }).catch(() => {});
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

async function openExternalLink(url) {
  try {
    await api("/api/open", { method: "POST", body: JSON.stringify({ url }) });
  } catch (_) {
    // The shared API handler reports failures in Notifications.
  }
}

window.api = api;
window.reportError = reportError;
window.notify = notify;

window.addEventListener("error", (event) => {
  const error = event.error || new Error(event.message || "Unhandled browser error");
  if (!error.__reported) {
    error.__reported = true;
    reportError(error, "Unhandled browser error");
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason || "Unhandled promise rejection"));
  if (!error.__reported) {
    error.__reported = true;
    reportError(error, "Unhandled promise rejection");
  }
});

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function showHasDub(show) {
  return (show.dubAired || 0) > 0 || !!show.hasDubSchedule || (show.nextEvents || []).some((event) => event.kind === "dub");
}

function nextAirEvent(show, kind) {
  const now = Date.now() - 60 * 1000;
  const events = (show.nextEvents || []).concat(kind === "sub" ? (show.upcomingSub || []) : []);
  const matches = events
    .filter((event) => {
      if (!event || !event.at || (kind === "dub" && event.kind !== "dub") || (kind === "sub" && event.kind && event.kind !== "sub")) return false;
      return new Date(event.at).getTime() >= now;
    })
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (matches[0]) return matches[0];
  if (kind === "sub" && show.nextSubAt && new Date(show.nextSubAt).getTime() >= now) {
    return { at: show.nextSubAt, episode: show.nextSubEpisode };
  }
  return null;
}

function cardTitleTip(show) {
  const parts = [];
  const sub = nextAirEvent(show, "sub");
  const dub = nextAirEvent(show, "dub");
  parts.push(`<strong>${show.title}</strong>`);
  parts.push(`<span class="chip sub">${sub ? `SUB ep ${sub.episode || "?"} · ${fmtDateTime(sub.at)}` : "SUB finished"}</span>`);
  if (showHasDub(show) || dub) {
    parts.push(`<span class="chip dub">${dub ? `DUB ep ${dub.episode || "?"} · ${fmtDateTime(dub.at)}` : "DUB finished"}</span>`);
  }
  return `${parts[0]}<div class="meta">${parts.slice(1).join("")}</div>`;
}

function placeHoverTip(html, element) {
  const tip = $("#hover-tip");
  if (!tip) return;
  tip.innerHTML = html;
  tip.classList.remove("hidden");
  const rect = element.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 320))}px`;
  tip.style.top = `${Math.min(rect.bottom + 8, innerHeight - 120)}px`;
}

function hideHoverTip() {
  $("#hover-tip")?.classList.add("hidden");
}

function wireCardTitle(title, show) {
  title.addEventListener("mouseenter", () => placeHoverTip(cardTitleTip(show), title));
  title.addEventListener("mouseleave", hideHoverTip);
}

function setupZoomControl(groupId, target, settingKey, onChange) {
  const group = $(`#${groupId}`);
  if (!group) return;
  const presets = [...group.querySelectorAll("[data-zoom]")];
  const validLevels = presets.map((button) => Number(button.dataset.zoom));
  const stored = Number(state.settings[settingKey]);
  const initial = Number.isFinite(stored)
    ? validLevels.reduce((nearest, level) => Math.abs(level - stored) < Math.abs(nearest - stored) ? level : nearest, validLevels[0])
    : 75;
  const apply = (percent) => {
    state.settings[settingKey] = percent;
    if (target) target.style.zoom = `${percent / 100}`;
    presets.forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.zoom) === percent));
    });
    if (onChange) onChange();
  };
  presets.forEach((button) => {
    button.addEventListener("click", async () => {
      const percent = Number(button.dataset.zoom);
      if (!validLevels.includes(percent)) return;
      apply(percent);
      try {
        const settings = await api("/api/settings", {
          method: "POST",
          body: JSON.stringify({ [settingKey]: percent }),
        });
        state.settings = { ...settings, ...state.settings };
      } catch (_) {
        // The shared API handler reports persistence failures in Notifications.
      }
    });
  });
  apply(initial);
}

function setupZoomControls() {
  setupZoomControl("main-zoom", null, "mainZoom", renderBoard);
  setupZoomControl("picker-zoom", $("#picker-grid"), "pickerZoom");
  setupZoomControl("settings-zoom", $("#settings-form"), "settingsZoom");
  setupZoomControl("notify-zoom", $("#notify-list"), "notificationsZoom");
  setupZoomControl("details-zoom", $("#show-details-content"), "detailsZoom");
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
  wireCardTitle(card.querySelector("h4"), show);
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
  wireCardTitle(h, show);
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
  cards.style.zoom = `${Number(state.settings.mainZoom ?? 75) / 100}`;
  shows.forEach((s) => {
    const card = paintCard(s);
    card.addEventListener("click", (event) => openShowDetails(s.id, event));
    cards.appendChild(card);
  });
  wrap.appendChild(cards);
  return wrap;
}

function appendFormattedDescription(parent, sourceNode) {
  if (sourceNode.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(sourceNode.nodeValue || ""));
    return;
  }
  if (sourceNode.nodeType !== Node.ELEMENT_NODE) return;

  const tag = sourceNode.tagName.toLowerCase();
  if (tag === "a") {
    let href = "";
    try {
      const url = new URL(sourceNode.getAttribute("href") || "", location.origin);
      if (url.protocol === "http:" || url.protocol === "https:") href = url.href;
    } catch (_) {
      href = "";
    }
    if (href) {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        openExternalLink(href);
      });
      parent.appendChild(anchor);
      for (const child of sourceNode.childNodes) appendFormattedDescription(anchor, child);
      return;
    }
  }

  const allowedTags = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "h3", "h4", "hr", "code", "pre", "sup", "sub"]);
  const target = allowedTags.has(tag) ? document.createElement(tag) : parent;
  if (target !== parent) parent.appendChild(target);
  for (const child of sourceNode.childNodes) appendFormattedDescription(target, child);
}

function renderFormattedDescription(container, markup) {
  if (!markup) {
    container.textContent = "No description available.";
    return;
  }
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  for (const child of parsed.body.childNodes) appendFormattedDescription(container, child);
}

async function openShowDetails(showId) {
  const panel = $("#show-details");
  const content = $("#show-details-content");
  if (!panel || !content) return;
  panel.classList.remove("hidden");
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const maxLeft = Math.max(8, innerWidth - width - 8);
  const maxTop = Math.max(8, innerHeight - height - 8);
  const xRatio = Number.isFinite(Number(state.settings.detailsPanelX)) ? Math.max(0, Math.min(1, Number(state.settings.detailsPanelX))) : 0.5;
  const yRatio = Number.isFinite(Number(state.settings.detailsPanelY)) ? Math.max(0, Math.min(1, Number(state.settings.detailsPanelY))) : 0.5;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.left = `${8 + (maxLeft - 8) * xRatio}px`;
  panel.style.top = `${8 + (maxTop - 8) * yRatio}px`;
  content.textContent = "Loading show details…";
  try {
    const show = await api(`/api/show/${showId}`);
    const title = document.createElement("h2");
    title.textContent = show.title || "Show details";
    const sources = document.createElement("div");
    sources.className = "show-sources";
    const anischedule = (show.sourceLinks || []).find((link) => link.name === "AniSchedule")?.url || "https://github.com/RockinChaos/AniSchedule/tree/master/readable";
    const sourceLinks = [
      { name: "AniList", url: show.sourceUrl || show.siteUrl || `https://anilist.co/anime/${show.id}` },
      { name: "AniSchedule", url: anischedule },
      { name: "MyAnimeList", url: show.idMal ? `https://myanimelist.net/anime/${show.idMal}` : `https://myanimelist.net/anime.php?q=${encodeURIComponent(show.title || "")}` },
      { name: "IMDb", url: `https://www.imdb.com/find/?q=${encodeURIComponent(show.title || "")}` },
    ];
    for (const link of sourceLinks) {
      if (!link.url) continue;
      const source = document.createElement("a");
      source.href = link.url;
      source.setAttribute("role", "button");
      source.textContent = link.name;
      source.addEventListener("click", (clickEvent) => {
        clickEvent.preventDefault();
        openExternalLink(link.url);
      });
      sources.appendChild(source);
    }
    const heading = document.createElement("div");
    heading.className = "show-details-heading";
    heading.append(title);
    const nexusButton = document.createElement("button");
    nexusButton.type = "button";
    nexusButton.className = "nexus-open-button";
    nexusButton.textContent = "Open Anime Nexus";
    nexusButton.addEventListener("click", async () => {
      const override = nexusInput.value.trim();
      const url = override || `https://anime.nexus/series?search=${encodeURIComponent(show.title || "")}`;
      openExternalLink(url);
    });
    const nexusInput = document.createElement("input");
    nexusInput.className = "nexus-url-input";
    nexusInput.type = "url";
    nexusInput.placeholder = "Optional Anime Nexus link";
    nexusInput.value = show.nexusUrl || "";
    nexusInput.setAttribute("aria-label", "Optional Anime Nexus link");
    nexusInput.addEventListener("blur", async () => {
      const nexusUrl = nexusInput.value.trim();
      if (nexusUrl === (show.nexusUrl || "")) return;
      try {
        await api("/api/library/progress", {
          method: "POST",
          body: JSON.stringify({ id: show.id, nexusUrl }),
        });
        show.nexusUrl = nexusUrl;
        const savedShow = state.library.find((item) => Number(item.id) === Number(show.id));
        if (savedShow) savedShow.nexusUrl = nexusUrl;
      } catch (_) {
        // The shared API handler reports failures in Notifications.
      }
    });
    const descriptionArea = document.createElement("section");
    descriptionArea.className = "show-description-area";
    const descriptionTitle = document.createElement("h3");
    descriptionTitle.textContent = "Synopsis";
    const description = document.createElement("div");
    description.className = "show-description";
    renderFormattedDescription(description, show.description);
    descriptionArea.append(descriptionTitle, description);
    const list = document.createElement("div");
    list.className = "episode-list";
    for (const episode of show.episodesSchedule || []) {
      const row = document.createElement("div");
      row.className = "episode-row";
      row.innerHTML = `<b>Episode ${episode.episode}</b><span>${episode.source.toUpperCase()}</span><time>${episode.airDate}</time>`;
      list.appendChild(row);
    }
    const scheduleTitle = document.createElement("h3");
    scheduleTitle.className = "episode-list-title";
    scheduleTitle.textContent = "Episode schedule";
    content.replaceChildren(heading, sources, nexusButton, nexusInput, descriptionArea, scheduleTitle, list);
  } catch (error) {
    if (!error.__reported) reportError(error, "Could not load show details");
    content.textContent = `Could not load show details: ${error.message}`;
  }
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
  const data = await api("/api/library/remove", { method: "POST", body: JSON.stringify({ id }) });
  toast("Removed from widget");
  markPickerItem(id, false);
  state.library = data.shows || state.library.filter((show) => Number(show.id) !== Number(id));
  if (state.range === "library") {
    renderBoard();
  } else {
    await loadSchedule();
  }
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
    const image = document.createElement("img");
    image.src = m.cover || "";
    image.alt = "";
    const details = document.createElement("span");
    details.className = "pick-row-details";
    const title = document.createElement("span");
    title.className = "pick-row-title";
    title.textContent = m.title || "Untitled";
    const metadata = document.createElement("small");
    metadata.textContent = meta;
    const tags = (Array.isArray(m.tags) ? m.tags : [])
      .filter((tag) => tag && tag.name && !tag.isGeneralSpoiler && !tag.isMediaSpoiler && !tag.isAdult)
      .sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0))
      .slice(0, 4);
    details.append(title, metadata);
    if (tags.length) {
      const tagLine = document.createElement("span");
      tagLine.className = "pick-tags";
      for (const tag of tags) {
        const chip = document.createElement("span");
        chip.className = "pick-tag";
        chip.textContent = tag.name;
        tagLine.appendChild(chip);
      }
      details.appendChild(tagLine);
    }
    el.append(image, details);
  } else {
    el.innerHTML = `<img src="${m.cover || ""}" alt="" /><span>${m.title}</span>`;
  }
  const positionPickerTip = (event) => {
    const tip = $("#hover-tip");
    if (!tip) return;
    tip.style.left = `${Math.max(8, Math.min(event.clientX + 14, innerWidth - 380))}px`;
    tip.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - 140))}px`;
  };
  el.addEventListener("mousemove", positionPickerTip);
  el.addEventListener("mouseenter", async (event) => {
    const tip = $("#hover-tip");
    if (!tip) return;
    const hoverToken = {};
    el._hoverToken = hoverToken;
    tip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = m.title;
    const description = document.createElement("div");
    description.textContent = m.description || "Loading description…";
    tip.replaceChildren(title, description);
    tip.classList.remove("hidden");
    positionPickerTip(event);
    if (!m.description) {
      try {
        const details = await api(`/api/show/${m.id}`);
        m.description = details.description || "";
      } catch (_) {
        if (el._hoverToken === hoverToken) description.textContent = "Description unavailable.";
        return;
      }
    }
    if (el._hoverToken !== hoverToken || !m.description || !el.matches(":hover")) return;
    tip.replaceChildren(title, description);
    description.textContent = m.description;
  });
  el.addEventListener("mouseleave", () => {
    el._hoverToken = null;
    $("#hover-tip")?.classList.add("hidden");
  });
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
    if (!err.__reported) reportError(err, "Could not load catalog");
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

function enablePanelDragging(panel, handle) {
  if (!panel || !handle) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      moved = true;
      const maxLeft = Math.max(8, innerWidth - rect.width - 8);
      const maxTop = Math.max(8, innerHeight - rect.height - 8);
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${Math.max(8, Math.min(maxLeft, rect.left + moveEvent.clientX - startX))}px`;
      panel.style.top = `${Math.max(8, Math.min(maxTop, rect.top + moveEvent.clientY - startY))}px`;
    };
    const stop = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      if (!moved) return;
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(8, innerWidth - rect.width - 8);
      const maxTop = Math.max(8, innerHeight - rect.height - 8);
      const position = {
        detailsPanelX: maxLeft === 8 ? 0 : (rect.left - 8) / (maxLeft - 8),
        detailsPanelY: maxTop === 8 ? 0 : (rect.top - 8) / (maxTop - 8),
      };
      state.settings = { ...state.settings, ...position };
      api("/api/settings", { method: "POST", body: JSON.stringify(position) })
        .then((settings) => { state.settings = { ...settings, ...state.settings }; })
        .catch(() => {});
    };
    event.preventDefault();
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  });
}

function enablePickerCornerResizing(panel) {
  if (!panel) return;
  panel.querySelectorAll(".picker-resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      const fromLeft = handle.dataset.resizeFrom === "left";
      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const minWidth = 280;
        const minHeight = 180;
        const right = fromLeft ? rect.right : Math.min(moveEvent.clientX, innerWidth - 8);
        const left = fromLeft ? Math.max(8, Math.min(moveEvent.clientX, rect.right - minWidth)) : rect.left;
        const width = Math.max(minWidth, right - left);
        const maxBottom = Math.min(innerHeight - 8, rect.top + innerHeight - 24);
        const bottom = Math.max(rect.top + minHeight, Math.min(moveEvent.clientY, maxBottom));
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = `${left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.width = `${width}px`;
        panel.style.height = `${bottom - rect.top}px`;
      };
      const stop = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
      };
      event.preventDefault();
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
    });
  });
}

function wire() {
  enablePickerCornerResizing($("#drawer"));
  const showDetails = $("#show-details");
  enablePanelDragging(showDetails, showDetails?.querySelector(".drawer-head"));
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
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    $("#drawer").classList.add("hidden");
    $("#settings").classList.add("hidden");
    $("#show-details").classList.add("hidden");
    if (notifyPanel) notifyPanel.classList.add("hidden");
    $("#hover-tip").classList.add("hidden");
    closeSelects();
    syncDrawerFade();
  });
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
  $("#show-details-close").addEventListener("click", () => $("#show-details").classList.add("hidden"));
  document.addEventListener("mousedown", (event) => {
    const panel = $("#show-details");
    if (!panel.classList.contains("hidden") && !panel.contains(event.target)) {
      panel.classList.add("hidden");
    }
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
  window.trackerSettingsReady = true;
  window.dispatchEvent(new Event("tracker-settings-ready"));
  setupZoomControls();
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

(function () {
  const STORE = 'st-nexus-urls';

  const css = document.createElement('style');
  css.textContent = [
    'h4.nexus-editing,input.nexus-input{',
    'box-sizing:border-box!important;width:100%!important;',
    'height:2.6em!important;font-size:11px!important;font-weight:600!important;',
    'border-radius:6px!important;border:1px solid var(--line,#2a3340)!important;',
    'background:var(--card-2,#1c2430)!important;color:var(--text,#e8eef6)!important;',
    'padding:2px 6px!important;margin:4px 0 0!important;',
    '}'
  ].join('');
  document.head.appendChild(css);

  function loadMap() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); }
    catch (e) { return {}; }
  }
  function saveMap(map) {
    localStorage.setItem(STORE, JSON.stringify(map));
  }
  function nexusFor(show) {
    const map = loadMap();
    return show.nexusUrl || map[String(show.id)] || '';
  }
  function searchUrl(title) {
    return 'https://anime.nexus/series?search=' + encodeURIComponent(title || '');
  }
  function isSeriesUrl(url) {
    return /^https?:\/\/anime\.nexus\/series\/[0-9a-f-]{36}\//i.test(url || '');
  }
  function persist(show, url) {
    const map = loadMap();
    if (url) map[String(show.id)] = url;
    else delete map[String(show.id)];
    saveMap(map);
    show.nexusUrl = url || undefined;
    fetch('/api/library/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: show.id, nexusUrl: url || '' })
    }).catch(function (err) {
      if (window.reportError) window.reportError(err, 'Save library progress failed');
      else console.error(err);
    });
  }
  function openNexus(url) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    }).catch(function (err) {
      if (window.reportError) window.reportError(err, 'Open link failed');
      fetch('/api/open?url=' + encodeURIComponent(url)).catch(function (fallbackErr) {
        if (window.reportError) window.reportError(fallbackErr, 'Open link fallback failed');
      });
    });
  }
  function insideWidget(el) {
    return !!(el && el.closest && (el.closest('#app') || el.closest('.statusbar') || el.closest('.drawer')));
  }

  function fmtWhen(at) {
    if (typeof fmtTime === 'function') return fmtTime(at);
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return String(at || '');
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function nextAir(show, kind) {
    const now = Date.now() - 60 * 1000;
    const pool = (show.nextEvents || []).concat(kind === 'sub' ? (show.upcomingSub || []) : []);
    const hits = pool.filter(function (e) {
      if (!e || !e.at) return false;
      if (kind === 'dub' && e.kind !== 'dub') return false;
      if (kind === 'sub' && e.kind && e.kind !== 'sub') return false;
      return new Date(e.at).getTime() >= now;
    }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    if (hits[0]) return hits[0];
    if (kind === 'sub' && show.nextSubAt && new Date(show.nextSubAt).getTime() >= now) {
      return { at: show.nextSubAt, episode: show.nextSubEpisode };
    }
    return null;
  }
  function hasDub(show) {
    return (show.dubAired || 0) > 0 || !!show.hasDubSchedule || (show.nextEvents || []).some(function (e) { return e.kind === 'dub'; });
  }
  function titleHtml(show) {
    const bits = [];
    const sub = nextAir(show, 'sub');
    const dub = nextAir(show, 'dub');
    if (sub) bits.push('<span class="chip sub">SUB ep ' + (sub.episode || '?') + ' · ' + fmtWhen(sub.at) + '</span>');
    else bits.push('<span class="chip sub">SUB finished</span>');
    if (hasDub(show) || dub) {
      if (dub) bits.push('<span class="chip dub">DUB ep ' + (dub.episode || '?') + ' · ' + fmtWhen(dub.at) + '</span>');
      else bits.push('<span class="chip dub">DUB finished</span>');
    }
    return '<strong>' + show.title + '</strong><div class="meta">' + bits.join('') + '</div>';
  }
  function titleText(show) {
    const sub = nextAir(show, 'sub');
    const dub = nextAir(show, 'dub');
    const parts = [show.title];
    parts.push(sub ? ('SUB ' + fmtWhen(sub.at)) : 'SUB finished');
    if (hasDub(show) || dub) parts.push(dub ? ('DUB ' + fmtWhen(dub.at)) : 'DUB finished');
    return parts.join(' · ');
  }
  function placeTip(html, el) {
    const tip = document.querySelector('#hover-tip');
    if (!tip) return;
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left, innerWidth - 320)) + 'px';
    tip.style.top = Math.min(r.bottom + 8, innerHeight - 120) + 'px';
  }
  function hideTip() {
    const tip = document.querySelector('#hover-tip');
    if (tip) tip.classList.add('hidden');
  }

  function restoreTitle(input, show) {
    if (!input.parentNode) return;
    const url = input.value.trim();
    if (isSeriesUrl(url)) persist(show, url);
    const h = document.createElement('h4');
    h.textContent = show.title;
    h.style.cursor = 'pointer';
    input.replaceWith(h);
    wireTitle(h, show);
  }

  function showInput(titleEl, show, opened) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nexus-input';
    input.value = opened;
    input.spellcheck = false;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    function close() {
      document.removeEventListener('mousedown', onDocClick, true);
      restoreTitle(input, show);
    }
    function onDocClick(ev) {
      if (ev.target === input) return;
      if (!insideWidget(ev.target)) return;
      close();
    }
    document.addEventListener('mousedown', onDocClick, true);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    });
  }

  function wireTitle(title, show) {
    title.addEventListener('mouseenter', function () { placeTip(titleHtml(show), title); });
    title.addEventListener('mouseleave', hideTip);
    title.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      hideTip();
      const saved = nexusFor(show);
      openNexus(saved || searchUrl(show.title));
      showInput(title, show, saved || '');
    });
  }

  const orig = window.paintCard;
  if (typeof orig !== 'function') return;
  window.paintCard = function (show) {
    const card = orig(show);
    let title = card.querySelector('h4, a.show-title');
    if (!title) return card;
    if (title.tagName === 'A') {
      const h = document.createElement('h4');
      h.textContent = show.title;
      title.replaceWith(h);
      title = h;
    }
    title.style.cursor = 'pointer';
    wireTitle(title, show);
    return card;
  };
})();

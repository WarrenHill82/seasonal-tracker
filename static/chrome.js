(function () {
  if (!document.getElementById('st-layout-css')) {
    const css = document.createElement('style');
    css.id = 'st-layout-css';
    css.textContent = [
      '.board{overflow-y:auto!important;}',
      'body.layout-bar .week-strip{display:flex!important;flex-direction:row!important;align-items:flex-start!important;width:100%!important;}',
      'body.layout-bar .week-strip .day-col{flex:1 1 0!important;min-width:170px!important;overflow:hidden!important;}',
      'body.layout-bar .week-strip .cards{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;gap:8px!important;width:100%!important;}',
      'body.layout-bar .stack-card.compact{width:100%!important;max-width:160px!important;}',
      'body.layout-row .week-strip{display:flex!important;flex-direction:column!important;width:100%!important;}',
      'body.layout-row .week-strip .cards{display:flex!important;flex-wrap:wrap!important;gap:8px!important;width:100%!important;}',
      '.stack-card.compact{width:140px!important;max-width:160px!important;overflow:hidden!important;position:relative!important;}',
      '.stack-card.compact .poster{width:100%!important;aspect-ratio:2/3!important;object-fit:cover!important;}',
      '.stack-card.compact h4{display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important;overflow:hidden!important;height:2.6em!important;line-height:1.3!important;word-break:break-word!important;cursor:pointer!important;color:var(--text,#e8eef6)!important;}',
      '.stack-card.compact h4:hover{color:#7eb8ff!important;text-decoration:underline!important;}',
      '.card-remove{position:absolute!important;top:6px!important;right:6px!important;width:22px!important;height:22px!important;border:0!important;border-radius:11px!important;background:#000a!important;color:#fff!important;cursor:pointer!important;line-height:22px!important;padding:0!important;font-size:14px!important;}',
      '.stack-card.airing,.row-card.airing{border:2px solid #ef5350!important;}',
      '.stack-card.finished,.row-card.finished{border:2px solid #3dd68c!important;}',
      '.stack-card.sub-done,.row-card.sub-done{border:2px solid #ff8a5b!important;}',
      '.remain-tiles{display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;justify-content:center!important;gap:6px!important;}',
      '.remain-tile{display:flex!important;flex-direction:column!important;align-items:center!important;min-width:44px!important;flex:1 1 0!important;max-width:64px!important;padding:4px 6px!important;border-radius:10px!important;}',
      '.remain-tile b{font-size:15px!important;display:block!important;}',
      '.remain-tile small{font-size:8px!important;text-transform:uppercase!important;display:block!important;}',
      '.remain-tile.sub,.remain-tile.dub{background:color-mix(in srgb,#ff8a5b 22%,var(--card-2,#1c2430))!important;color:#ff8a5b!important;}',
      '.remain-tile.done{background:color-mix(in srgb,#3dd68c 22%,var(--card-2,#1c2430))!important;color:#3dd68c!important;}',
      '.hover-tip{position:fixed!important;z-index:90!important;max-width:min(360px,80vw)!important;background:var(--bg-2,#151b24)!important;color:var(--text,#e8eef6)!important;border:1px solid var(--line,#2a3340)!important;border-radius:12px!important;padding:10px 12px!important;}',
      '.hover-tip.hidden{display:none!important;}',
      '.statusbar{display:flex!important;align-items:center!important;height:32px!important;}',
      '.statusbar .tools{margin-left:auto!important;display:flex!important;align-items:center!important;gap:4px!important;}',
      '.statusbar .icon-btn{width:26px!important;height:26px!important;display:grid!important;place-items:center!important;}'
    ].join('');
    document.head.appendChild(css);
  }
  function isBar() {
    const l = state.settings.layout;
    return l === 'stacks' || l === 'bar';
  }
  function viewEnd() {
    if (state.range === 'library' || state.range === 'today' || !state.schedule || !state.schedule.end) {
      return new Date();
    }
    const end = new Date(state.schedule.end);
    return Number.isNaN(end.getTime()) ? new Date() : end;
  }
  function viewAired(show, kind) {
    const total = show.episodes || 12;
    let aired = Number(kind === 'dub' ? show.dubAired : show.subAired);
    if (!Number.isFinite(aired)) aired = 0;
    const end = viewEnd();
    (show.nextEvents || []).concat(kind === 'sub' ? (show.upcomingSub || []) : []).forEach(function (e) {
      if (!e || !e.at) return;
      if (e.kind && e.kind !== kind && !(kind === 'sub' && !e.kind)) return;
      const t = new Date(e.at);
      if (Number.isNaN(t.getTime()) || t > end) return;
      if (e.episode != null) aired = Math.max(aired, Number(e.episode));
    });
    if (kind === 'sub' && show.nextSubAt && show.nextSubEpisode) {
      let nextAt = new Date(show.nextSubAt);
      let nextEp = Number(show.nextSubEpisode);
      while (!Number.isNaN(nextAt.getTime()) && nextAt <= end && aired < total) {
        aired = Math.max(aired, nextEp);
        nextEp += 1;
        nextAt = new Date(nextAt.getTime() + 7 * 24 * 3600 * 1000);
      }
    }
    return Math.min(aired, total);
  }
  function hasDub(show) {
    return (show.dubAired || 0) > 0 || !!show.hasDubSchedule || (show.nextEvents || []).some(function (e) { return e.kind === 'dub'; });
  }
  function borderClass(show) {
    const total = show.episodes;
    const subDone = !!(total && viewAired(show, 'sub') >= Number(total));
    const dubExists = hasDub(show);
    const dubDone = !!(total && viewAired(show, 'dub') >= Number(total));
    if (dubExists && subDone && !dubDone) return ' sub-done';
    if (subDone && (!dubExists || dubDone)) return ' finished';
    if (show.status === 'FINISHED' && dubExists && !dubDone) return ' sub-done';
    if (show.status === 'FINISHED') return ' finished';
    return '';
  }
  function fmtWhen(at) {
    if (typeof fmtTime === 'function') return fmtTime(at);
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function titleTip(show) {
    const total = show.episodes || 12;
    const subDone = viewAired(show, 'sub') >= Number(total) || show.status === 'FINISHED';
    const dubExists = hasDub(show);
    const dubDone = !dubExists || viewAired(show, 'dub') >= Number(total);
    if (subDone && dubDone) {
      return '<strong>' + show.title + '</strong><div class="meta"><span class="chip dub">Finished</span></div>';
    }
    const bits = [];
    const subEv = (show.nextEvents || []).find(function (e) { return e.kind === 'sub'; }) || (show.nextSubAt ? { at: show.nextSubAt, episode: show.nextSubEpisode } : null);
    const dubEv = (show.nextEvents || []).find(function (e) { return e.kind === 'dub'; });
    if (!subDone && subEv && subEv.at) bits.push('<span class="chip sub">SUB ep ' + (subEv.episode || '?') + ' · ' + fmtWhen(subEv.at) + '</span>');
    else if (subDone) bits.push('<span class="chip sub">SUB finished</span>');
    if (dubExists) {
      if (!dubDone && dubEv && dubEv.at) bits.push('<span class="chip dub">DUB ep ' + (dubEv.episode || '?') + ' · ' + fmtWhen(dubEv.at) + '</span>');
      else if (dubDone) bits.push('<span class="chip dub">DUB finished</span>');
    }
    if (!bits.length) bits.push('<span class="chip">No upcoming air date</span>');
    return '<strong>' + show.title + '</strong><div class="meta">' + bits.join('') + '</div>';
  }
  function nexusSearch(title) {
    return 'https://anime.nexus/series?search=' + encodeURIComponent(title || '');
  }
  function localKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function airDow(show) {
    if (show.airDow != null && show.airDow !== '') return Number(show.airDow);
    const samples = (show.nextEvents || []).concat(show.upcomingSub || []);
    if (show.nextSubAt) samples.push({ at: show.nextSubAt });
    for (let i = 0; i < samples.length; i += 1) {
      if (!samples[i] || !samples[i].at) continue;
      const d = new Date(samples[i].at);
      if (!Number.isNaN(d.getTime())) return d.getDay();
    }
    return null;
  }
  function pillTip(show, kind) {
    const total = show.episodes || 12;
    const aired = viewAired(show, kind);
    const left = Math.max(0, total - aired);
    const label = kind === 'dub' ? 'DUB' : 'SUB';
    return '<strong>' + show.title + '</strong><div class="meta">' +
      '<span class="chip ' + kind + '">' + label + ' ' + aired + ' / ' + total + ' aired</span>' +
      '<span class="chip ' + kind + '">' + left + ' left</span></div>';
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
  function compactCard(show) {
    const card = document.createElement('article');
    card.className = 'stack-card compact' + borderClass(show);
    card.dataset.sid = String(show.id);
    const img = document.createElement('img');
    img.className = 'poster';
    img.src = show.cover || '';
    if (state.range === 'library') {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'card-remove';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove from tracker');
      x.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof removeShow === 'function') removeShow(show.id);
      });
      card.appendChild(x);
    }
    const title = document.createElement('h4');
    title.textContent = show.title;
    title.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.open(nexusSearch(show.title), '_blank', 'noopener');
    });
    title.addEventListener('mouseenter', function () { placeTip(titleTip(show), title); });
    title.addEventListener('mouseleave', hideTip);
    const tiles = document.createElement('div');
    tiles.className = 'remain-tiles';
    const total = show.episodes || 12;
    function add(kind) {
      const aired = viewAired(show, kind);
      const el = document.createElement('span');
      el.className = 'remain-tile ' + kind + (aired >= Number(total) ? ' done' : '');
      el.innerHTML = '<b>' + aired + '/' + total + '</b><small>' + (kind === 'dub' ? 'DUB' : 'SUB') + '</small>';
      el.addEventListener('mouseenter', function (ev) {
        ev.stopPropagation();
        placeTip(pillTip(show, kind), el);
      });
      el.addEventListener('mouseleave', hideTip);
      tiles.appendChild(el);
    }
    if (state.settings.showSub !== false) add('sub');
    if (hasDub(show) && state.settings.showDub !== false) add('dub');
    if (!tiles.childElementCount) add('sub');
    card.appendChild(img);
    card.appendChild(tiles);
    card.appendChild(title);
    return card;
  }
  window.paintCard = function (show) { return compactCard(show); };
  const originalApply = window.applyTheme;
  window.applyTheme = function () {
    if (typeof originalApply === 'function') originalApply();
    document.body.classList.toggle('layout-bar', isBar());
    document.body.classList.toggle('layout-row', !isBar());
    const layoutBtn = document.querySelector('#btn-layout');
    if (layoutBtn) {
      layoutBtn.classList.toggle('is-bar', isBar());
      layoutBtn.innerHTML = '<svg class="i-row" viewBox="0 0 20 20" width="16" height="16"><rect x="1" y="3" width="18" height="3" rx="1"/><rect x="1" y="8.5" width="18" height="3" rx="1"/><rect x="1" y="14" width="18" height="3" rx="1"/></svg><svg class="i-bar" viewBox="0 0 20 20" width="16" height="16"><rect x="3" y="1" width="3" height="18" rx="1"/><rect x="8.5" y="1" width="3" height="18" rx="1"/><rect x="14" y="1" width="3" height="18" rx="1"/></svg>';
    }
  };
  const originalRenderBoard = window.renderBoard;
  window.renderBoard = function () {
    if (typeof originalRenderBoard === 'function') originalRenderBoard();
    document.body.classList.toggle('layout-bar', isBar());
    document.body.classList.toggle('layout-row', !isBar());
  };
  function bustReload() {
    const u = new URL(location.href);
    u.searchParams.set('_', String(Date.now()));
    location.replace(u.toString());
  }
  const reloadUi = document.querySelector('#btn-reload-ui');
  if (reloadUi) reloadUi.addEventListener('click', bustReload);
  const reloadAll = document.querySelector('#btn-reload-widget');
  if (reloadAll) reloadAll.addEventListener('click', function () {
    fetch('/api/reload', { method: 'POST', body: '{}' }).catch(function (err) {
      if (window.reportError) window.reportError(err, 'Reload request failed');
      else console.error(err);
    });
    setTimeout(bustReload, 900);
  });
})();

(function () {
  function airedNow(show, kind) {
    const total = show.episodes || 12;
    let aired = Number(kind === 'dub' ? show.dubAired : show.subAired);
    if (!Number.isFinite(aired)) aired = 0;
    const scheduleAired = Number(kind === 'dub' ? show.scheduleDubAired : show.scheduleSubAired);
    if (Number.isFinite(scheduleAired)) aired = Math.max(aired, scheduleAired);
    let nextEp = null;
    let nextAt = null;
    if (kind === 'dub') {
      const ev = (show.nextEvents || []).find(function (e) { return e.kind === 'dub'; });
      if (ev) { nextEp = ev.episode; nextAt = ev.at; }
    } else {
      const ev = (show.nextEvents || []).find(function (e) { return (e.kind || 'sub') === 'sub'; });
      nextEp = (ev && ev.episode) || show.nextSubEpisode;
      nextAt = (ev && ev.at) || show.nextSubAt;
    }
    if (nextEp != null) {
      const t = nextAt ? new Date(nextAt) : null;
      const pending = t && !Number.isNaN(t.getTime()) && t.getTime() > Date.now();
      const fromNext = pending ? Number(nextEp) - 1 : Number(nextEp);
      if (Number.isFinite(fromNext)) aired = Math.max(aired, fromNext);
    }
    if (state.range === 'next_week' || state.range === 'week_after') {
      const end = state.schedule && state.schedule.end ? new Date(state.schedule.end) : null;
      if (end && nextEp != null && nextAt) {
        let at = new Date(nextAt);
        let ep = Number(nextEp);
        if (!Number.isNaN(at.getTime()) && at.getTime() <= Date.now()) {
          at = new Date(at.getTime() + 7 * 24 * 3600 * 1000);
          ep += 1;
        }
        if (!Number.isNaN(at.getTime()) && at <= end) aired = Math.max(aired, ep);
      }
    }
    return Math.min(Math.max(0, aired), total);
  }
  window.airedNow = airedNow;

  function pillHtml(show, kind) {
    const total = show.episodes || 12;
    const aired = airedNow(show, kind);
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

  const orig = window.paintCard;
  if (typeof orig !== 'function') return;
  window.paintCard = function (show) {
    const card = orig(show);
    const total = show.episodes || 12;
    const sub = airedNow(show, 'sub');
    const dub = airedNow(show, 'dub');
    const dubTile = card.querySelector('.remain-tile.dub');
    const subDone = sub >= Number(total);
    const dubDone = !dubTile || dub >= Number(total);
    card.classList.remove('airing', 'sub-done', 'finished');
    if (subDone && dubDone) card.classList.add('finished');
    else if (subDone || (dubTile && dub >= Number(total))) card.classList.add('sub-done');
    else card.classList.add('airing');
    card.querySelectorAll('.remain-tile').forEach(function (el) {
      const kind = el.classList.contains('dub') ? 'dub' : 'sub';
      const aired = kind === 'dub' ? dub : sub;
      const b = el.querySelector('b');
      if (b) b.textContent = aired + '/' + total;
      el.classList.toggle('done', aired >= Number(total));
      el.onmouseenter = function (ev) {
        ev.stopPropagation();
        placeTip(pillHtml(show, kind), el);
      };
      el.onmouseleave = hideTip;
    });
    return card;
  };
})();

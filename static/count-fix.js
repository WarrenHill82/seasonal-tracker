(function () {
  function airedNow(show, kind) {
    const total = show.episodes || 12;
    const scheduleAired = Number(kind === 'dub' ? show.scheduleDubAired : show.scheduleSubAired);
    if (Number.isFinite(scheduleAired)) return Math.min(Math.max(0, scheduleAired), total);
    let aired = Number(kind === 'dub' ? show.dubAired : show.subAired);
    if (!Number.isFinite(aired)) aired = 0;
    const now = Date.now();
    let horizon = now;
    if (state.range === 'next_week' || state.range === 'week_after') {
      const end = state.schedule && state.schedule.end ? new Date(state.schedule.end).getTime() : NaN;
      if (Number.isFinite(end)) horizon = end;
    }
    const events = (show.nextEvents || []).filter(function (event) {
      return (event.kind || 'sub') === kind;
    });
    events.push.apply(events, kind === 'sub' ? (show.upcomingSub || []) : (show.upcomingDub || []));
    events.forEach(function (event) {
      if (event.episode == null || !event.at) return;
      const at = new Date(event.at).getTime();
      const episode = Number(event.episode);
      if (!Number.isFinite(at) || !Number.isFinite(episode)) return;
      if (at <= horizon) aired = Math.max(aired, episode);
    });
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
    tip.style.left = Math.max(8, Math.min(r.left, innerWidth - 460)) + 'px';
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

(function () {
  const KEY = 'st-card-sort';
  const OPTIONS = [
    { id: 'name', label: 'Name' },
    { id: 'air', label: 'Air date' }
  ];

  let mode = state.settings.cardSort || localStorage.getItem(KEY) || 'name';
  if (!OPTIONS.some(function (o) { return o.id === mode; })) mode = 'name';

  const css = document.createElement('style');
  css.textContent = [
    '.sort-wrap{position:relative;display:inline-flex;align-items:center;gap:6px;margin-right:4px;}',
    '.sort-wrap .sort-btn{height:22px;padding:0 8px;border:1px solid var(--line,#2a3340);border-radius:8px;background:var(--card-2,#1c2430);color:var(--text,#e8eef6);font-size:11px;cursor:pointer;}',
    '.sort-wrap .sort-menu{position:absolute;right:0;bottom:calc(100% + 6px);display:none;min-width:140px;list-style:none;margin:0;padding:4px;background:var(--card,#1a2330);border:1px solid var(--line,#2a3340);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:30;}',
    '.sort-wrap.open .sort-menu{display:block;}',
    '.sort-wrap .sort-menu li{padding:7px 10px;border-radius:8px;cursor:pointer;font-size:11px;}',
    '.sort-wrap .sort-menu li:hover,.sort-wrap .sort-menu li.active{background:var(--card-2,#243042);}'
  ].join('');
  document.head.appendChild(css);

  const tools = document.querySelector('.statusbar .tools');
  if (!tools) return;

  const wrap = document.createElement('span');
  wrap.className = 'sort-wrap';
  wrap.innerHTML = '<button type="button" class="sort-btn">Sort: Name</button><ul class="sort-menu"></ul>';

  const btn = wrap.querySelector('.sort-btn');
  const menu = wrap.querySelector('.sort-menu');

  OPTIONS.forEach(function (opt) {
    const item = document.createElement('li');
    item.textContent = opt.label;
    item.dataset.value = opt.id;
    if (opt.id === mode) item.classList.add('active');
    item.addEventListener('click', function () {
      mode = opt.id;
      localStorage.setItem(KEY, mode);
      state.settings.cardSort = mode;
      if (typeof api === 'function') {
        api('/api/settings', { method: 'POST', body: JSON.stringify({ cardSort: mode }) })
          .then(function (settings) { state.settings = Object.assign({}, settings, state.settings); })
          .catch(function () {});
      }
      btn.textContent = 'Sort: ' + opt.label;
      menu.querySelectorAll('li').forEach(function (node) {
        node.classList.toggle('active', node.dataset.value === mode);
      });
      wrap.classList.remove('open');
      sortLanes();
    });
    menu.appendChild(item);
  });

  btn.textContent = 'Sort: ' + (OPTIONS.find(function (o) { return o.id === mode; }) || OPTIONS[0]).label;
  btn.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    wrap.classList.toggle('open');
  });
  document.addEventListener('click', function () {
    wrap.classList.remove('open');
  });

  tools.insertBefore(wrap, tools.firstChild);

  function findShow(card) {
    const id = card.dataset.sid;
    const lib = state.library || [];
    let show = lib.find(function (s) { return String(s.id) === String(id); });
    if (show) return show;
    const days = (state.schedule && state.schedule.days) || [];
    for (let i = 0; i < days.length; i += 1) {
      const hit = (days[i].shows || []).find(function (s) { return String(s.id) === String(id); });
      if (hit) return hit;
    }
    return null;
  }

  function value(card) {
    const show = findShow(card) || {};
    const title = (show.title || (card.querySelector('h4') || {}).textContent || '').toLowerCase();
    if (mode === 'air') {
      const first = show.focus || (show.nextEvents || [])[0];
      if (first && first.ts) return Number(first.ts);
      if (show.nextSubAt) return Date.parse(show.nextSubAt) || Number.MAX_SAFE_INTEGER;
      return Number.MAX_SAFE_INTEGER;
    }
    return title;
  }

  function sortLanes() {
    document.querySelectorAll('.cards').forEach(function (box) {
      const kids = [].slice.call(box.querySelectorAll(':scope > [data-sid], :scope > .stack-card, :scope > .row-card'));
      if (!kids.length) return;
      kids.sort(function (a, b) {
        const va = value(a);
        const vb = value(b);
        if (va < vb) return -1;
        if (va > vb) return 1;
        return Number(a.dataset.sid) - Number(b.dataset.sid);
      });
      kids.forEach(function (k) { box.appendChild(k); });
    });
  }

  function syncModeFromSettings() {
    const saved = state.settings.cardSort;
    if (!OPTIONS.some(function (option) { return option.id === saved; })) return;
    mode = saved;
    btn.textContent = 'Sort: ' + (OPTIONS.find(function (option) { return option.id === mode; }) || OPTIONS[0]).label;
    menu.querySelectorAll('li').forEach(function (node) {
      node.classList.toggle('active', node.dataset.value === mode);
    });
    sortLanes();
  }

  const orig = window.renderBoard;
  window.renderBoard = function () {
    if (typeof orig === 'function') orig();
    sortLanes();
  };

  if (window.trackerSettingsReady) syncModeFromSettings();
  else window.addEventListener('tracker-settings-ready', syncModeFromSettings, { once: true });
  sortLanes();
})();

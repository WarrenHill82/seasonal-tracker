/* Status-bar week pager + My shows layout lock.
 *
 * This file must NOT touch .day-col nodes. chrome.js paints the board,
 * week-fix.js is the only owner of column order / dates / seating.
 * If you reseat or rotate here you will get duplicate weekdays.
 */
(function () {
  let offset = Number(state.weekOffset || 0);
  // Layout in force before we forced bar on My shows. Restored on leave.
  let layoutBeforeLibrary = null;

  const css = document.createElement('style');
  css.textContent = [
    '.statusbar .ranges{padding-left:14px!important;gap:6px!important;align-items:center!important;}',
    '#btn-today{margin-left:2px!important;}',
    '.week-pager{display:inline-flex!important;align-items:center!important;gap:2px!important;',
    'height:22px!important;border:1px solid var(--line,#2a3340)!important;border-radius:8px!important;padding:0 4px!important;}',
    '.week-pager button{min-width:22px!important;width:22px!important;height:20px!important;padding:0!important;font-size:14px!important;}',
    '#week-label{font-size:11px!important;min-width:6.2rem!important;text-align:center!important;opacity:.9!important;padding:0 4px!important;}',
    '#week-now.active,.week-pager.is-on{box-shadow:inset 0 0 0 1px color-mix(in srgb,#7eb8ff 45%,transparent);}'
  ].join('');
  document.head.appendChild(css);

  const nav = document.querySelector('#ranges');
  if (!nav || typeof loadSchedule !== 'function') return;
  nav.innerHTML =
    '<button type="button" id="btn-today" data-range="today">Today</button>' +
    '<button type="button" id="week-now">This week</button>' +
    '<span class="week-pager" id="week-pager">' +
      '<button type="button" id="week-prev" aria-label="Previous week">‹</button>' +
      '<span id="week-label">This week</span>' +
      '<button type="button" id="week-next" aria-label="Next week">›</button>' +
    '</span>' +
    '<button type="button" data-range="library">My shows</button>';

  function isWeek() {
    return state.range === 'this_week' || state.range === 'next_week' ||
      state.range === 'week_after' || state.range === 'week';
  }
  // app.js uses this to pick the week-strip layout.
  window.isWeekRange = function (range) {
    return range === 'this_week' || range === 'next_week' ||
      range === 'week_after' || range === 'week';
  };

  function paintActive() {
    nav.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
    const today = document.querySelector('#btn-today');
    const mine = nav.querySelector('[data-range="library"]');
    const jump = document.querySelector('#week-now');
    const pager = document.querySelector('#week-pager');
    if (state.range === 'today' && today) today.classList.add('active');
    else if (state.range === 'library' && mine) mine.classList.add('active');
    if (jump) jump.classList.toggle('active', isWeek() && offset === 0);
    if (pager) pager.classList.toggle('is-on', isWeek());
    const prev = document.querySelector('#week-prev');
    if (prev) prev.disabled = false;
    // Date text is written by week-fix.js from the same offset.
  }

  function applyLibraryLayout() {
    if (state.range === 'library') {
      if (layoutBeforeLibrary == null) layoutBeforeLibrary = state.settings.layout;
      state.settings.layout = 'stacks'; // bar, not persisted
    } else if (layoutBeforeLibrary != null) {
      state.settings.layout = layoutBeforeLibrary;
      layoutBeforeLibrary = null;
    }
    if (typeof applyTheme === 'function') applyTheme();
  }

  // Fetch calendar week `offset` (0 = this Sun-Sat) and repaint.
  async function loadWeek() {
    state.weekOffset = offset;
    state.range = 'this_week';
    applyLibraryLayout();
    paintActive();
    try {
      const [sched, lib] = await Promise.all([
        api('/api/schedule?range=this_week&offset=' + offset),
        api('/api/library')
      ]);
      state.schedule = sched;
      state.library = lib.shows || [];
      renderBoard();
    } catch (e) {
      if (typeof toast === 'function') toast(e.message);
    }
    paintActive();
  }

  function goToday() {
    state.range = 'today';
    state.weekOffset = 0;
    applyLibraryLayout();
    paintActive();
    loadSchedule().then(paintActive);
  }
  function goLibrary() {
    state.range = 'library';
    applyLibraryLayout();
    paintActive();
    loadSchedule().then(function () {
      paintActive();
      renderBoard();
    });
  }

  document.querySelector('#btn-today').addEventListener('click', goToday);
  nav.querySelector('[data-range="library"]').addEventListener('click', goLibrary);
  document.querySelector('#week-now').addEventListener('click', function () {
    offset = 0;
    loadWeek();
  });
  document.querySelector('#week-prev').addEventListener('click', function () {
    offset -= 1;
    loadWeek();
  });
  document.querySelector('#week-next').addEventListener('click', function () {
    offset += 1;
    loadWeek();
  });

  const origRender = window.renderBoard;
  window.renderBoard = function () {
    if (typeof origRender === 'function') origRender();
    if (state.range === 'library') {
      document.body.classList.add('layout-bar');
      document.body.classList.remove('layout-row');
    }
    paintActive();
  };

  paintActive();
})();

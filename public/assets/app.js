/* Docker Manager client shell (progressive enhancement).
   No framework, no inline handlers. Everything degrades to server-rendered
   HTML: navigation is links, the drawer has a URL, forms POST without JS. */
(() => {
  'use strict';

  // ----- theme (FR-030, design §7.3) -------------------------------------
  const THEME_KEY = 'dm_theme';
  const systemMq = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;

  function resolved(mode) {
    return mode === 'system' ? (systemMq.matches ? 'dark' : 'light') : mode;
  }
  function storedTheme() {
    return localStorage.getItem(THEME_KEY) || 'system';
  }
  function applyTheme(mode) {
    root.dataset.theme = resolved(mode);
    root.dataset.themePref = mode;
  }
  applyTheme(storedTheme());
  systemMq.addEventListener('change', () => {
    if (storedTheme() === 'system') applyTheme('system');
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-set]');
    if (!btn) return;
    const mode = btn.getAttribute('data-theme-set');
    localStorage.setItem(THEME_KEY, mode);
    applyTheme(mode);
    document.querySelectorAll('[data-theme-set]').forEach((b) => {
      const on = b.getAttribute('data-theme-set') === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // Persist to the dm_theme cookie for future page renders.
    const token = document.querySelector('meta[name="csrf-token"]');
    fetch('/api/settings', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token ? token.content : '',
      },
      body: JSON.stringify({ theme: mode }),
    }).catch(() => {});
  });

  // ----- CSRF (double-submit cookie; token also in meta) ------------------
  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }
  function csrfHeaders(extra) {
    return Object.assign({ 'x-csrf-token': csrfToken() }, extra || {});
  }

  // ----- toasts (design §6.6.6) ------------------------------------------
  function toast(message, kind) {
    const wrap = document.getElementById('toasts') || document.querySelector('[data-toasts]');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.textContent = message;
    wrap.appendChild(el);
    window.setTimeout(() => el.remove(), 5000);
  }
  window.dmToast = toast;

  // ----- drawer (C-04, design §7.4) --------------------------------------
  // The drawer URL is a real page (history state is a bonus when JS runs).
  let drawerReturnScroll = 0;

  function openDrawer(url, push) {
    const panel = document.querySelector('[data-drawer]');
    const body = document.querySelector('[data-drawer-body]');
    if (!panel || !body) {
      window.location.href = url; // JS on, no drawer shell: plain navigation
      return;
    }
    if (push !== false) {
      drawerReturnScroll = window.scrollY;
      history.pushState({ drawer: url }, '', url);
    }
    panel.hidden = false;
    document.body.classList.add('drawer-open');
    body.setAttribute('aria-busy', 'true');
    body.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    fetch(url, { headers: { 'x-dm-fragment': '1' } })
      .then((r) => r.text())
      .then((html) => {
        body.innerHTML = html;
        body.removeAttribute('aria-busy');
        const close = panel.querySelector('[data-drawer-close]');
        if (close) close.focus();
      })
      .catch(() => {
        body.innerHTML = '<div class="error-banner">Failed to load details.</div>';
      });
  }

  function closeDrawer() {
    const panel = document.querySelector('[data-drawer]');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove('drawer-open');
    window.scrollTo(0, drawerReturnScroll);
    if (history.state && history.state.drawer) {
      history.pushState({}, '', panel.getAttribute('data-drawer-list'));
    }
  }

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('a[data-drawer-url]');
    if (opener) {
      e.preventDefault();
      openDrawer(opener.getAttribute('data-drawer-url'), true);
      return;
    }
    if (e.target.closest('[data-drawer-close]')) {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (e.target.closest('[data-drawer-overlay]')) closeDrawer();
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      const name = tab.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach((b) => {
        const on = b === tab;
        b.classList.toggle('chip--on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('[data-tabpanel]').forEach((p) => {
        p.hidden = p.getAttribute('data-tabpanel') !== name;
      });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape unwinds the topmost layer: confirm dialog, row menu, activity
    // drawer, then the detail drawer.
    if (confirmBackdrop && !confirmBackdrop.hidden) {
      if (!confirmInFlight) closeConfirm();
      return;
    }
    if (rowMenu && !rowMenu.hidden) { closeMenu(true); return; }
    if (actShell && !actShell.hidden) { actShell.hidden = true; return; }
    closeDrawer();
  });

  window.addEventListener('popstate', () => {
    // The drawer URL lives in history; back closes it.
    closeDrawer();
  });

  // Open the drawer directly on drawer pages (the panel is server-rendered).
  const bootDrawer = document.querySelector('[data-drawer][data-drawer-open-url]');
  if (bootDrawer) openDrawer(bootDrawer.getAttribute('data-drawer-open-url'), false);

  // ----- client-side filter (P1: state + text on the loaded rows) ---------
  const filterInput = document.querySelector('[data-filter-input]');
  const rows = () => Array.from(document.querySelectorAll('[data-filter-item]'));

  function applyClientFilter() {
    const q = (filterInput ? filterInput.value : '').trim().toLowerCase();
    const states = Array.from(document.querySelectorAll('[data-state-filter]:checked'))
      .map((b) => b.getAttribute('data-state-filter'));
    rows().forEach((row) => {
      const hay = (row.getAttribute('data-filter-text') || row.textContent).toLowerCase();
      const state = row.getAttribute('data-state') || '';
      const okQ = !q || hay.includes(q);
      const okS = states.length === 0 || states.includes(state);
      row.hidden = !(okQ && okS);
    });
    // Show the row-hide hint only when something is filtered.
    const cards = document.querySelector('[data-cards]');
    if (cards) cards.classList.toggle('cards--filtered', Boolean(q || states.length));
  }

  if (filterInput) {
    filterInput.addEventListener('input', applyClientFilter);
    document.querySelectorAll('[data-state-filter]').forEach((b) => {
      b.addEventListener('change', applyClientFilter);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== filterInput &&
          !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        filterInput.focus();
      }
    });
  }

  // ----- note editor (FR-012) --------------------------------------------
  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-note-open]');
    if (openBtn) {
      const form = document.querySelector('[data-note-form]');
      if (form) {
        form.hidden = false;
        const input = form.querySelector('input');
        if (input) input.focus();
      }
      openBtn.hidden = true;
      return;
    }
    const cancel = e.target.closest('[data-note-cancel]');
    if (cancel) {
      const form = cancel.closest('[data-note-form]');
      if (form) form.hidden = true;
      const openBtn = document.querySelector('[data-note-open]');
      if (openBtn) openBtn.hidden = false;
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-note-form]');
    if (!form) return;
    e.preventDefault();
    const id = form.getAttribute('data-note-id');
    const value = form.querySelector('input').value;
    fetch(`/api/containers/${encodeURIComponent(id)}/note`, {
      method: 'PATCH',
      headers: csrfHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ note: value }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('save failed');
        return r.json();
      })
      .then(() => {
        toast('Note saved.', 'ok');
        form.hidden = true;
        const openBtn = document.querySelector('[data-note-open]');
        if (openBtn) {
          openBtn.hidden = false;
          const shown = document.querySelector('[data-note-value]');
          if (shown) shown.textContent = value || 'Add note';
        }
      })
      .catch(() => toast('Failed to save note.', 'error'));
  });

  // ----- copy fields (C-19) ----------------------------------------------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.getAttribute('data-copy');
    const done = () => toast('Copied to clipboard.', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      toast('Copy failed.', 'error');
    }
    ta.remove();
  }

  // ----- updated-ago ticker ----------------------------------------------
  // P1: data-updated-ago refreshes each minute (P3 SSE extends this).
  window.setInterval(() => {
    document.querySelectorAll('[data-updated-at]').forEach((el) => {
      const then = Number(el.getAttribute('data-updated-at'));
      if (!then) return;
      const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
      if (secs < 60) el.textContent = `${secs}s ago`;
      else if (secs < 3600) el.textContent = `${Math.floor(secs / 60)}m ago`;
      else el.textContent = `${Math.floor(secs / 3600)}h ago`;
    });
  }, 10000);

  // ----- sort select navigates (server-side sort is authoritative) --------
  const sortSelect = document.querySelector('[data-sort-select]');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      const url = new URL(window.location.href);
      url.searchParams.set('sort', sortSelect.value);
      window.location.href = url.toString();
    });
  }

  // ==================================================================
  // P2 — container actions (FR-020…FR-031), row menu (C-13),
  // destructive dialog (§7.6), activity drawer (C-07).
  // ==================================================================

  const stopTimeout = Number((document.querySelector('meta[name="stop-timeout"]') || {}).content) || 10;
  const SELF_REASON = 'Docker Manager cannot control its own container';
  const ACT_LABEL = {
    start: 'Start', stop: 'Stop', restart: 'Restart', kill: 'Kill',
    pause: 'Pause', unpause: 'Unpause', rm: 'Remove'
  };

  function actionCtx(el) {
    const holder = el.closest('[data-id]') || el;
    return {
      id: holder.getAttribute('data-id'),
      name: holder.getAttribute('data-name') || String(holder.getAttribute('data-id') || '').slice(0, 12),
      state: holder.getAttribute('data-state') || '',
      self: holder.getAttribute('data-self') === '1'
    };
  }

  // C-13 rules: routine verbs visible but disabled on self, destructive
  // absent; start reachable whenever the container is not running (FR-030).
  function menuRules(ctx) {
    const running = ctx.state === 'running' || ctx.state === 'restarting';
    const paused = ctx.state === 'paused';
    return {
      start: { hide: false, disable: ctx.self ? SELF_REASON : (running || paused ? 'Already running' : null) },
      restart: { hide: false, disable: ctx.self ? SELF_REASON : null },
      pause: { hide: paused, disable: ctx.self ? SELF_REASON : (!running ? 'Only a running container can be paused' : null) },
      unpause: { hide: !paused, disable: null }, // FR-013: unpause stays on self
      stop: { hide: ctx.self, disable: !(running || paused) ? 'The container is not running' : null },
      kill: { hide: ctx.self, disable: !(running || paused) ? 'The container is not running' : null },
      rm: { hide: ctx.self, disable: null }
    };
  }

  const rowMenu = document.querySelector('[data-row-menu]');
  let menuTrigger = null;
  let menuCtx = null;

  function openMenu(trigger) {
    if (!rowMenu) return;
    const ctx = actionCtx(trigger);
    const rules = menuRules(ctx);
    menuCtx = ctx;
    menuTrigger = trigger;
    rowMenu.querySelectorAll('[data-act]').forEach((item) => {
      const rule = rules[item.getAttribute('data-act')] || { hide: true, disable: null };
      item.hidden = Boolean(rule.hide);
      if (rule.disable) {
        item.setAttribute('aria-disabled', 'true');
        item.title = rule.disable;
      } else {
        item.removeAttribute('aria-disabled');
        item.removeAttribute('title');
      }
    });
    const details = rowMenu.querySelector('[data-menu-details]');
    if (details) details.setAttribute('href', `/containers/${encodeURIComponent(ctx.id)}`);
    const logsLink = rowMenu.querySelector('[data-menu-logs]');
    if (logsLink) logsLink.setAttribute('href', `/containers/${encodeURIComponent(ctx.id)}/logs`);
    rowMenu.hidden = false;
    const r = trigger.getBoundingClientRect();
    const w = 210;
    rowMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    rowMenu.style.top = `${Math.min(window.innerHeight - 48, r.bottom + 4)}px`;
    trigger.setAttribute('aria-expanded', 'true');
    const first = rowMenu.querySelector('[data-act]:not([hidden])');
    if (first) first.focus();
  }

  function closeMenu(refocus) {
    if (!rowMenu || rowMenu.hidden) return;
    rowMenu.hidden = true;
    if (menuTrigger) {
      menuTrigger.setAttribute('aria-expanded', 'false');
      if (refocus) menuTrigger.focus();
    }
    menuTrigger = null;
    menuCtx = null;
  }

  if (rowMenu) {
    rowMenu.addEventListener('keydown', (e) => {
      const items = [...rowMenu.querySelectorAll('[data-menu-details], [data-act]')]
        .filter((el) => !el.hidden && el.getAttribute('aria-disabled') !== 'true');
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(i + 1 + items.length) % items.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length].focus();
      }
    });
  }

  // Capture phase: a click on the ⋮ must never reach the row link beneath.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-menu-trigger]');
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      if (menuTrigger === trigger) closeMenu(true);
      else openMenu(trigger);
      return;
    }
    if (e.target.closest('[data-menu-cancel]')) {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    if (rowMenu && !rowMenu.hidden && !e.target.closest('[data-row-menu]')) closeMenu(false);
  }, true);

  // ----- destructive confirm dialog (FR-026, design §7.6) ---------------
  const confirmBackdrop = document.querySelector('[data-confirm-backdrop]');
  const dlg = {
    title: document.getElementById('confirm-title'),
    consequence: document.querySelector('[data-confirm-consequence]'),
    kept: document.querySelector('[data-confirm-kept]'),
    choice: document.querySelector('[data-confirm-choice]'),
    error: document.querySelector('[data-confirm-error]'),
    errorAction: document.querySelector('[data-confirm-error-action]'),
    errorMessage: document.querySelector('[data-confirm-error-message]'),
    ok: document.querySelector('[data-confirm-ok]'),
    okLabel: document.querySelector('[data-confirm-ok-label]'),
    cancel: document.querySelector('[data-confirm-cancel]'),
    dialog: document.querySelector('[data-confirm-dialog]')
  };
  let confirmCtx = null;
  let confirmVerb = null;
  let confirmInFlight = false;
  let confirmReturn = null;

  // Copy table: design §7.6.2. The "kept" line is fact — remove never
  // passes --volumes and never touches images.
  function confirmCopy(verb, ctx, running) {
    if (verb === 'stop') return {
      title: `Stop “${ctx.name}”?`,
      consequence: `Sends SIGTERM, then SIGKILL after ${stopTimeout} s.`,
      kept: 'The container and its data are kept.',
      ok: 'Stop container', choice: false
    };
    if (verb === 'kill') return {
      title: `Kill “${ctx.name}”?`,
      consequence: 'Sends SIGKILL immediately. The process cannot clean up.',
      kept: 'The container is kept and can be started again.',
      ok: 'Kill container', choice: false
    };
    return running ? {
      title: `Remove “${ctx.name}”?`,
      consequence: 'The container is running.',
      kept: '',
      ok: 'Remove container', choice: true
    } : {
      title: `Remove “${ctx.name}”?`,
      consequence: 'Deletes the container. This cannot be undone.',
      kept: 'The image and volumes are kept.',
      ok: 'Remove container', choice: false
    };
  }

  function openConfirm(verb, ctx, returnTo) {
    const running = ctx.state === 'running' || ctx.state === 'restarting';
    const c = confirmCopy(verb, ctx, running);
    confirmVerb = verb;
    confirmCtx = ctx;
    confirmReturn = returnTo || null;
    dlg.title.textContent = c.title;
    dlg.consequence.textContent = c.consequence;
    dlg.kept.textContent = c.kept;
    dlg.kept.hidden = !c.kept;
    dlg.choice.hidden = !c.choice;
    dlg.error.hidden = true;
    dlg.okLabel.textContent = c.ok;
    dlg.ok.classList.remove('is-busy');
    dlg.ok.disabled = false;
    dlg.cancel.disabled = false;
    confirmInFlight = false;
    confirmBackdrop.hidden = false;
    dlg.cancel.focus(); // Cancel focused on open (§7.6.1)
  }

  function closeConfirm() {
    confirmBackdrop.hidden = true;
    confirmVerb = null;
    confirmCtx = null;
    confirmInFlight = false;
    if (confirmReturn && confirmReturn.focus) confirmReturn.focus();
    confirmReturn = null;
  }

  async function actionRequest(verb, ctx, mode) {
    const id = encodeURIComponent(ctx.id);
    const r = verb === 'rm'
      ? await fetch(`/api/containers/${id}${mode ? `?mode=${mode}` : ''}`, { method: 'DELETE', headers: csrfHeaders() })
      : await fetch(`/api/containers/${id}/actions/${verb}`, { method: 'POST', headers: csrfHeaders() });
    if (!r.ok) {
      let message = `Request failed (${r.status})`;
      try {
        const body = await r.json();
        message = (body.error && body.error.message) || message;
      } catch { /* keep generic */ }
      const err = new Error(message);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  // FR-029: name the container and its new state. The list re-renders from
  // the daemon after every action (P3 SSE replaces the reload).
  function outcome(verb, ctx, payload) {
    const past = {
      start: 'started', stop: 'stopped', restart: 'restarted', kill: 'killed',
      pause: 'paused', unpause: 'unpaused', rm: 'removed'
    };
    const msg = verb === 'rm'
      ? `${ctx.name} removed.`
      : `${ctx.name} ${past[verb]}${payload && payload.state ? ` — now ${payload.state}` : ''}.`;
    try {
      sessionStorage.setItem('dm-focus-row', ctx.id);
      sessionStorage.setItem('dm-toast', msg);
    } catch { /* private mode */ }
    window.location.reload();
  }

  async function runAction(verb, ctx, returnTo) {
    if (verb === 'stop' || verb === 'kill' || verb === 'rm') {
      openConfirm(verb, ctx, returnTo);
      return;
    }
    try {
      const payload = await actionRequest(verb, ctx, null);
      outcome(verb, ctx, payload);
    } catch (err) {
      toast(`${ACT_LABEL[verb]} “${ctx.name}” failed: ${err.message}`, 'error'); // verbatim (NFR-045)
    }
  }

  document.addEventListener('click', (e) => {
    const item = e.target.closest('[data-act]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    if (item.getAttribute('aria-disabled') === 'true') return;
    const inMenu = item.closest('[data-row-menu]');
    const ctx = inMenu && menuCtx ? menuCtx : actionCtx(item);
    const returnTo = inMenu ? menuTrigger : item;
    closeMenu(false);
    runAction(item.getAttribute('data-act'), ctx, returnTo);
  });

  if (dlg.ok) {
    dlg.ok.addEventListener('click', async () => {
      if (!confirmCtx || confirmInFlight) return;
      const verb = confirmVerb;
      const ctx = confirmCtx;
      const radio = dlg.choice.hidden ? null : document.querySelector('input[name="rm-mode"]:checked');
      confirmInFlight = true;
      dlg.ok.disabled = true;
      dlg.cancel.disabled = true;
      dlg.ok.classList.add('is-busy');
      try {
        const payload = await actionRequest(verb, ctx, radio ? radio.value : null);
        closeConfirm();
        outcome(verb, ctx, payload);
      } catch (err) {
        // §7.6.1: the dialog stays open, the daemon message is shown
        // verbatim, and the confirm button becomes "Try again".
        confirmInFlight = false;
        dlg.ok.disabled = false;
        dlg.cancel.disabled = false;
        dlg.ok.classList.remove('is-busy');
        dlg.okLabel.textContent = 'Try again';
        dlg.errorAction.textContent = `Failed: ${ACT_LABEL[verb]} “${ctx.name}”`;
        dlg.errorMessage.textContent = err.message;
        dlg.error.hidden = false;
      }
    });
  }
  if (dlg.cancel) {
    dlg.cancel.addEventListener('click', () => {
      if (!confirmInFlight) closeConfirm();
    });
  }
  if (confirmBackdrop) {
    confirmBackdrop.addEventListener('click', (e) => {
      if (e.target === confirmBackdrop && !confirmInFlight) closeConfirm();
    });
  }
  if (dlg.dialog) {
    dlg.dialog.addEventListener('keydown', (e) => {
      // Enter confirms only when focus is already on the confirm button.
      if (e.key === 'Enter' && e.target !== dlg.ok) e.preventDefault();
    });
  }

  // ----- activity drawer (C-07, FR-031) --------------------------------
  const actShell = document.querySelector('[data-activity]');
  const actList = document.querySelector('[data-activity-list]');

  function fmtTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
  }

  function renderActivity(events) {
    if (!actList) return;
    actList.textContent = '';
    if (!events || !events.length) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'No actions yet in this session. Start, stop or remove a container and it will appear here.';
      actList.appendChild(p);
      return;
    }
    for (const ev of events) {
      const row = document.createElement('div');
      row.className = 'act-row';
      const t = document.createElement('time');
      t.className = 'act-time numeric';
      t.textContent = fmtTime(ev.at);
      const chip = document.createElement('span');
      chip.className = 'act-chip';
      chip.textContent = ACT_LABEL[ev.action] || ev.action;
      const name = document.createElement('span');
      name.className = 'act-name mono';
      name.textContent = ev.container || '';
      row.append(t, chip, name);
      if (ev.result === 'ok') {
        const ok = document.createElement('span');
        ok.className = 'act-result act-ok';
        ok.textContent = '✓ ok';
        row.append(ok);
      } else {
        // Failed rows expand to the daemon message — text only, never HTML.
        const det = document.createElement('details');
        det.className = 'act-detail';
        const sum = document.createElement('summary');
        sum.className = 'act-result act-failed';
        sum.textContent = '✕ failed';
        const msg = document.createElement('p');
        msg.className = 'act-msg mono';
        msg.textContent = ev.message || '';
        det.append(sum, msg);
        row.append(det);
      }
      actList.appendChild(row);
    }
  }

  async function openActivity() {
    if (!actShell || !actList) return;
    actShell.hidden = false;
    actList.textContent = 'Loading…';
    try {
      const r = await fetch('/api/activity');
      const data = await r.json();
      renderActivity(data.events || []);
    } catch {
      actList.textContent = '';
      const p = document.createElement('p');
      p.className = 'act-msg';
      p.textContent = 'Could not load activity.';
      actList.appendChild(p);
    }
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-activity-open]')) {
      e.preventDefault();
      openActivity();
    } else if (e.target.closest('[data-activity-close]')) {
      e.preventDefault();
      if (actShell) actShell.hidden = true;
    } else if (e.target.closest('[data-activity-clear]')) {
      e.preventDefault();
      renderActivity([]); // clear view only — the session ring is untouched
    }
  });

  // §7.6.1: after the post-action reload, focus returns to the acted row's
  // menu trigger; a removed row hands focus to the next row, else the filter.
  const refocusId = sessionStorage.getItem('dm-focus-row');
  if (refocusId) {
    sessionStorage.removeItem('dm-focus-row');
    const esc = (window.CSS && CSS.escape) ? CSS.escape(refocusId) : refocusId;
    const own = document.querySelector(`[data-id="${esc}"] [data-menu-trigger]`);
    const target = own || document.querySelector('[data-menu-trigger]') || filterInput;
    if (target && target.focus) target.focus();
  }
  const bootToastMsg = sessionStorage.getItem('dm-toast');
  if (bootToastMsg) {
    sessionStorage.removeItem('dm-toast');
    toast(bootToastMsg, 'ok');
  }

  // ==================================================================
  // P3 — live event stream, connection indicator, unread badge,
  // browser notifications (FR-002, FR-052-056, FR-105), log view,
  // events page. Event-driven only — no polling.
  // ==================================================================

  const connPill = document.getElementById('conn-pill');
  function setConn(state) {
    if (!connPill) return;
    connPill.classList.remove('conn-live', 'conn-offline', 'conn-reconnecting');
    const text = connPill.querySelector('.conn-text');
    if (state === 'live') {
      connPill.classList.add('conn-live');
      if (text) text.textContent = 'Live';
    } else if (state === 'reconnecting') {
      connPill.classList.add('conn-reconnecting');
      if (text) text.textContent = 'Reconnecting';
    } else {
      connPill.classList.add('conn-offline');
      if (text) text.textContent = 'Offline';
    }
  }

  // ----- unread badge (FR-053) -------------------------------------------
  const eventBell = document.querySelector('[data-event-bell]');
  const eventBadge = document.querySelector('[data-event-badge]');
  let unread = 0;
  const CLEARED_KEY = 'dm-events-cleared-seq';
  let clearedSeq = Number(sessionStorage.getItem(CLEARED_KEY) || '0') || 0;
  let badgeTimer = null;
  let pendingUnread = 0;

  function renderBadge() {
    if (!eventBadge || !eventBell) return;
    const labelCount = unread > 99 ? '99+' : String(unread);
    if (unread <= 0) {
      eventBadge.hidden = true;
      eventBadge.textContent = '0';
      eventBell.setAttribute('aria-label', 'Events, no unread');
    } else {
      eventBadge.hidden = false;
      eventBadge.textContent = labelCount;
      eventBell.setAttribute('aria-label', `Events, ${unread} unread`);
    }
  }

  function bumpUnread() {
    pendingUnread += 1;
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      unread += pendingUnread;
      pendingUnread = 0;
      badgeTimer = null;
      renderBadge();
    }, 2000);
  }
  function _flushUnread() {
    if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; }
    unread += pendingUnread;
    pendingUnread = 0;
    renderBadge();
  }

  // Visiting /events clears the badge (client-side, session-scoped).
  if (window.location.pathname === '/events') {
    // cleared at the latest seq we know after hello; provisional now
    unread = 0;
  }

  // ----- browser notifications (FR-056, C-29) ----------------------------
  const NOTIFY_KEY = 'dm-notify-enabled';
  function notifySupported() { return typeof window.Notification !== 'undefined'; }
  function notifyEnabled() {
    try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch { return false; }
  }
  function setNotifyEnabled(v) {
    try { localStorage.setItem(NOTIFY_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }
  function notifyStatusText() {
    if (!notifySupported()) return 'Not supported by this browser';
    const p = Notification.permission;
    const on = notifyEnabled();
    if (p === 'denied') return 'Off — permission denied in the browser';
    if (p === 'granted' && on) return 'On — die/oom alerts enabled';
    if (p === 'granted' && !on) return 'Off — permission granted, alerts paused';
    return 'Off — permission not requested yet';
  }
  function updateNotifyControls() {
    document.querySelectorAll('[data-notify-control]').forEach((wrap) => {
      const btn = wrap.querySelector('[data-notify-toggle]');
      const status = wrap.querySelector('[data-notify-status]');
      if (!btn || !status) return;
      const sup = notifySupported();
      const p = sup ? Notification.permission : 'denied';
      const on = notifyEnabled() && p === 'granted';
      status.textContent = notifyStatusText();
      btn.disabled = !sup;
      if (!sup) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
      btn.textContent = on ? 'Disable' : 'Enable…';
    });
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-notify-toggle]');
    if (!btn) return;
    e.preventDefault();
    if (!notifySupported()) return;
    if (Notification.permission === 'granted' && notifyEnabled()) {
      setNotifyEnabled(false);
      updateNotifyControls();
      return;
    }
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission(); // only on explicit click
      if (perm === 'granted') setNotifyEnabled(true);
    } else if (Notification.permission === 'granted') {
      setNotifyEnabled(true);
    }
    updateNotifyControls();
  });
  updateNotifyControls();

  function maybeNotify(ev) {
    if (!notifySupported() || Notification.permission !== 'granted' || !notifyEnabled()) return;
    if (document.visibilityState === 'visible') return;
    const act = ev.action;
    if (act !== 'die' && act !== 'oom') return;
    const exit = ev.attributes && ev.attributes.exitCode;
    const body = act === 'oom' ? 'OOM killed' : `Exited with code ${exit !== undefined ? exit : '?'}`;
    try {
      const n = new Notification(ev.name || ev.containerId || 'Container', {
        body,
        tag: `dcm-${ev.containerId || ev.name}`,
        icon: '/assets/icons.svg'
      });
      n.onclick = () => {
        window.focus();
        window.location.href = `/containers/${encodeURIComponent(ev.containerId || '')}`;
      };
    } catch { /* ignore */ }
  }

  // ----- live container list updates (event-driven, no polling) ----------
  const onContainersPage = /^\/containers(\/[^/]+)?$/.test(window.location.pathname);
  function _escAttr(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }
  async function refetchContainers() {
    if (!onContainersPage) return;
    const url = new URL('/api/containers', window.location.origin);
    const sp = new URLSearchParams(window.location.search);
    ['state', 'q', 'sort', 'dir'].forEach((k) => { if (sp.has(k)) url.searchParams.set(k, sp.get(k)); });
    try {
      const r = await fetch(url.toString());
      if (!r.ok) return;
      const data = await r.json();
      updateCounts(data.counts);
      // Event-driven resync: reload preserves server-rendered fidelity.
      if (!document.querySelector('[data-drawer].is-open')) window.location.reload();
    } catch { /* best effort */ }
  }

  function updateCounts(counts) {
    if (!counts) return;
    const sub = document.querySelector('.page-sub');
    if (sub) {
      const parts = [`${counts.all} containers`, `${counts.running} running`, `${counts.stopped} stopped`, `${counts.paused} paused`];
      const m = sub.textContent.match(/·\s*daemon\s+.+$/);
      sub.textContent = parts.join(' · ') + (m ? ' ' + m[0] : '');
    }
    document.querySelectorAll('[data-state-chip]').forEach((chip) => {
      const st = chip.getAttribute('data-state-chip');
      const n = counts[st] !== undefined ? counts[st] : counts.all;
      const countEl = chip.querySelector('.chip-count');
      if (countEl) countEl.textContent = String(n);
    });
  }

  let resyncTimer = null;
  function scheduleResync() {
    if (resyncTimer) return;
    resyncTimer = setTimeout(() => { resyncTimer = null; refetchContainers(); }, 150);
  }

  // ----- /api/stream connection ------------------------------------------
  let streamEs = null;
  let streamWatchdog = null;
  function clearWatchdog() {
    if (streamWatchdog) { clearTimeout(streamWatchdog); streamWatchdog = null; }
  }
  function kickWatchdog() {
    clearWatchdog();
    streamWatchdog = setTimeout(() => setConn('offline'), 45000);
  }

  function connectStream() {
    if (streamEs) try { streamEs.close(); } catch { /* ignore */ }
    streamEs = new EventSource('/api/stream');
    kickWatchdog();

    streamEs.addEventListener('open', () => {
      setConn('live');
      kickWatchdog();
    });

    streamEs.addEventListener('hello', (e) => {
      kickWatchdog();
      try {
        const msg = JSON.parse(e.data);
        const seq = msg.data && msg.data.seq;
        if (window.location.pathname === '/events' && typeof seq === 'number') {
          clearedSeq = seq;
          sessionStorage.setItem(CLEARED_KEY, String(clearedSeq));
          unread = 0; pendingUnread = 0; renderBadge();
        } else if (typeof seq === 'number' && seq <= clearedSeq) {
          unread = 0; renderBadge();
        }
      } catch { /* ignore */ }
    });

    streamEs.addEventListener('docker.event', (e) => {
      kickWatchdog();
      try {
        const msg = JSON.parse(e.data);
        const ev = msg.data || msg;
        if (window.location.pathname !== '/events' && (ev.seq || 0) > clearedSeq) {
          bumpUnread();
        }
        maybeNotify(ev);
        if (window.location.pathname === '/events') {
          appendLiveEvent(ev);
          if (typeof ev.seq === 'number') {
            clearedSeq = ev.seq;
            sessionStorage.setItem(CLEARED_KEY, String(clearedSeq));
          }
        }
      } catch { /* ignore */ }
    });

    const onContainerChange = () => { kickWatchdog(); if (onContainersPage) scheduleResync(); };
    streamEs.addEventListener('container.upsert', onContainerChange);
    streamEs.addEventListener('container.remove', onContainerChange);

    streamEs.addEventListener('resync', () => {
      kickWatchdog();
      if (onContainersPage) scheduleResync();
    });

    streamEs.addEventListener('host.health', (e) => {
      kickWatchdog();
      try {
        const msg = JSON.parse(e.data);
        const st = (msg.data || msg).state;
        if (st === 'reachable') setConn('live');
        else if (st === 'reconnecting' || st === 'connecting') setConn('reconnecting');
        else setConn('offline');
      } catch { /* ignore */ }
    });

    streamEs.addEventListener('error', () => {
      clearWatchdog();
      setConn('reconnecting');
      // EventSource auto-reconnects; we reflect state.
    });
  }

  // Connect stream on pages that benefit from it (all app pages).
  if (document.querySelector('.app-header')) {
    try { connectStream(); } catch { setConn('offline'); }
  }

  // ----- events page live append -----------------------------------------
  function appendLiveEvent(ev) {
    const feed = document.querySelector('[data-event-feed]');
    if (!feed) return;
    const empty = document.querySelector('[data-events-empty]');
    if (empty) empty.hidden = true;
    const d = new Date((ev.at || Date.now() / 1000) * 1000);
    const time = Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
    const act = ev.action || '';
    const warn = (act === 'die' && ev.attributes && Number(ev.attributes.exitCode) !== 0) || act === 'oom' || ev.health === 'unhealthy';
    const tag = act === 'oom' ? 'oom' : (ev.health === 'unhealthy' ? 'unhealthy' : (act === 'die' && ev.attributes && ev.attributes.exitCode ? 'exit ' + ev.attributes.exitCode : ''));
    const summary = act === 'die' ? ('Exited' + (ev.attributes && ev.attributes.exitCode ? ' with code ' + ev.attributes.exitCode : ''))
      : act === 'start' ? 'Started' : act === 'create' ? 'Created' : act === 'restart' ? 'Restarted'
      : act === 'destroy' ? 'Destroyed' : act === 'oom' ? 'OOM killed'
      : ev.health === 'unhealthy' ? 'Became unhealthy' : ev.health === 'healthy' ? 'Became healthy' : (act || 'event');

    const row = document.createElement('article');
    row.className = 'event-row event-new' + (warn ? ' event-warn' : '');
    row.setAttribute('data-event', '');
    row.setAttribute('data-seq', ev.seq || '');
    row.setAttribute('data-action', act);
    row.setAttribute('data-name', ev.name || '');
    row.setAttribute('data-container-id', ev.containerId || '');

    const t = document.createElement('time');
    t.className = 'event-time mono numeric';
    t.textContent = time;
    const chip = document.createElement('span');
    chip.className = 'event-chip event-chip--' + act;
    chip.textContent = act || 'event';
    const name = document.createElement('a');
    name.className = 'event-name mono row-link';
    name.href = '/containers/' + encodeURIComponent(ev.containerId || '');
    name.textContent = ev.name || ev.containerId || '';
    const msg = document.createElement('span');
    msg.className = 'event-msg';
    if (tag) {
      const tg = document.createElement('span');
      tg.className = 'event-tag';
      tg.textContent = tag;
      msg.append(tg, document.createTextNode(' ' + summary));
    } else {
      msg.textContent = summary;
    }
    row.append(t, chip, name, msg);
    feed.prepend(row);
    setTimeout(() => row.classList.remove('event-new'), 700);
  }

  // events page filters
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-event-filter]');
    if (!chip) return;
    document.querySelectorAll('[data-event-filter]').forEach((c) => {
      const on = c === chip;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyEventFilter();
  });
  const eventQ = document.querySelector('[data-event-q]');
  if (eventQ) eventQ.addEventListener('input', applyEventFilter);
  function applyEventFilter() {
    const active = document.querySelector('[data-event-filter].is-active');
    const mode = active ? active.getAttribute('data-event-filter') : 'all';
    const q = eventQ ? eventQ.value.trim().toLowerCase() : '';
    document.querySelectorAll('[data-event]').forEach((row) => {
      const act = row.getAttribute('data-action') || '';
      const name = (row.getAttribute('data-name') || '').toLowerCase();
      const text = row.textContent.toLowerCase();
      let ok = true;
      if (mode === 'health') ok = act === 'health_status';
      else if (mode === 'oom') ok = act === 'oom';
      else if (mode === 'container') ok = act !== 'health_status';
      if (ok && q) ok = name.includes(q) || text.includes(q);
      row.hidden = !ok;
    });
  }

  // ----- log view controller (FR-040…FR-049, §7.3) -----------------------
  const logPage = document.querySelector('[data-log-page]');
  if (logPage) {
    const cid = logPage.getAttribute('data-container-id');
    const cname = logPage.getAttribute('data-container-name') || cid;
    const pane = document.querySelector('[data-log-pane]');
    const stateEl = document.querySelector('[data-log-state]');
    const bufferEl = document.querySelector('[data-log-buffer]');
    const filterEl = document.querySelector('[data-log-filter]');
    const matchEl = document.querySelector('[data-log-match]');
    const pauseBtn = document.querySelector('[data-log-pause]');
    const autoCb = document.querySelector('[data-log-autoscroll]');
    const tsCb = document.querySelector('[data-log-timestamps]');
    const onlyCb = document.querySelector('[data-log-only]');
    const jump = document.querySelector('[data-log-jump]');
    const jumpN = document.querySelector('[data-log-new]');
    let paused = false;
    let autoscroll = autoCb ? autoCb.checked : true;
    let showTs = tsCb ? tsCb.checked : true;
    let buffer = [];
    let lastTs = logPage.getAttribute('data-last-ts') || null;
    let newCount = 0;
    let dropped = 0;

    function updateStatus(text) { if (stateEl) stateEl.textContent = text; }

    // textContent used for log output (no HTML injection).

    function lineEl(l) {
      const div = document.createElement('div');
      div.className = 'log-line log-' + (l.s === 'err' ? 'err' : 'out');
      div.setAttribute('data-stream', l.s || 'out');
      const ts = document.createElement('span');
      ts.className = 'log-ts';
      ts.textContent = showTs && l.ts ? l.ts.replace('T', ' ').replace('Z', '') : '';
      const mk = document.createElement('span');
      mk.className = 'log-s';
      mk.textContent = l.s === 'err' ? 'E' : '';
      const m = document.createElement('span');
      m.className = 'log-m';
      m.textContent = l.m || '';
      div.append(ts, mk, m);
      return div;
    }

    function renderVisible() {
      if (!pane) return;
      const prevScroll = pane.scrollTop;
      const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
      pane.innerHTML = '';
      const start = Math.max(0, buffer.length - 1500);
      for (let i = start; i < buffer.length; i += 1) pane.appendChild(lineEl(buffer[i]));
      if (autoscroll || atBottom) pane.scrollTop = pane.scrollHeight;
      else pane.scrollTop = prevScroll;
    }

    function trimBuffer() {
      while (buffer.length > 5000) { buffer.shift(); dropped += 1; }
      if (bufferEl) bufferEl.textContent = `· ${buffer.length} lines` + (dropped ? ` · ${dropped} dropped` : '');
    }

    function pushLine(l) {
      buffer.push(l);
      if (l.ts) lastTs = l.ts;
      trimBuffer();
      if (paused) {
        newCount += 1;
        return;
      }
      if (!pane) return;
      const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
      if (buffer.length <= 1500 || !atBottom) {
        pane.appendChild(lineEl(l));
        while (pane.children.length > 1500) pane.removeChild(pane.firstChild);
      } else {
        renderVisible();
      }
      if (autoscroll && atBottom) pane.scrollTop = pane.scrollHeight;
      else if (!atBottom) {
        newCount += 1;
        if (jump) { jump.hidden = false; if (jumpN) jumpN.textContent = String(newCount); }
        autoscroll = false;
        if (autoCb) autoCb.checked = false;
      }
    }

    if (pauseBtn) pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? `Resume${newCount ? ` (${newCount} new)` : ''}` : 'Pause';
      updateStatus(paused ? `❚❚ Paused · ${newCount} new lines` : '● Live');
      if (!paused) { renderVisible(); newCount = 0; if (jump) jump.hidden = true; }
    });
    if (autoCb) autoCb.addEventListener('change', () => {
      autoscroll = autoCb.checked;
      if (autoscroll && pane) { pane.scrollTop = pane.scrollHeight; newCount = 0; if (jump) jump.hidden = true; }
    });
    if (tsCb) tsCb.addEventListener('change', () => {
      showTs = tsCb.checked;
      if (pane) pane.classList.toggle('log-pane--no-ts', !showTs);
      renderVisible();
    });
    if (pane) pane.addEventListener('scroll', () => {
      const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
      if (!atBottom && autoscroll) { autoscroll = false; if (autoCb) autoCb.checked = false; }
      if (atBottom) { newCount = 0; if (jump) jump.hidden = true; }
    });
    const jumpBtn = document.querySelector('[data-log-jump] button');
    if (jumpBtn) jumpBtn.addEventListener('click', () => {
      autoscroll = true; if (autoCb) autoCb.checked = true;
      if (pane) pane.scrollTop = pane.scrollHeight;
      newCount = 0; if (jump) jump.hidden = true;
    });
    const clearBtn = document.querySelector('[data-log-clear]');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      buffer = []; dropped = 0; newCount = 0;
      if (pane) pane.innerHTML = '';
      if (bufferEl) bufferEl.textContent = '';
      if (jump) jump.hidden = true;
      toast('View cleared.', 'ok');
    });
    const exportLink = document.querySelector('[data-log-export-link]');
    if (exportLink) exportLink.addEventListener('click', (e) => {
      e.preventDefault();
      const last = buffer.slice(-100);
      if (!last.length) { toast('No lines to export.', 'error'); return; }
      const text = last.map((l) => (l.ts ? l.ts + ' ' : '') + l.m).join('\n') + '\n';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      // eslint-disable-next-line no-control-regex
      const safe = String(cname).replace(/[\x00-\x1f\x7f/\\?%*:|"<>]/g, '-').slice(0, 80) || 'container';
      const st = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
      a.download = `${safe}-${st}.log`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${last.length} lines from ${cname}.`, 'ok');
    });

    // Seed buffer from server-rendered lines
    if (pane) {
      pane.querySelectorAll('.log-line').forEach((el) => {
        const s = el.getAttribute('data-stream') || 'out';
        const ts = (el.querySelector('.log-ts') || {}).textContent || null;
        const m = (el.querySelector('.log-m') || {}).textContent || '';
        buffer.push({ s, ts: ts && ts.trim() ? ts.trim().replace(' ', 'T') + 'Z' : null, m });
      });
      trimBuffer();
    }

    // SSE follow
    let logEs = null;
    function connectLog(afterTs) {
      const u = `/api/containers/${encodeURIComponent(cid)}/logs/stream?tail=0${afterTs ? '&after=' + encodeURIComponent(afterTs) : ''}`;
      logEs = new EventSource(u);
      logEs.addEventListener('line', (e) => {
        try { const d = JSON.parse(e.data); pushLine({ s: d.s, ts: d.ts, m: d.m }); } catch { /* ignore */ }
      });
      logEs.addEventListener('state', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.state === 'live') updateStatus('● Live');
          else if (d.state === 'closed') { updateStatus('Stream closed · ' + (d.reason || 'ended')); if (logEs) logEs.close(); }
          else if (d.state === 'error') {
            updateStatus('Could not stream logs');
            toast(d.message || 'Log stream error', 'error');
          }
        } catch { /* ignore */ }
      });
      logEs.addEventListener('error', () => {
        updateStatus('◌ Reconnecting…');
      });
    }
    // snapshot already rendered; follow from last rendered ts
    const initialAfter = lastTs || buffer.length ? (buffer[buffer.length - 1] && buffer[buffer.length - 1].ts) || lastTs : null;
    try { connectLog(initialAfter); } catch { updateStatus('Could not stream logs'); }

    // Simple regex filter (FR-042) — debounced, view-only highlight/dim
    let filterTimer = null;
    function applyFilter() {
      if (!pane) return;
      const pat = filterEl ? filterEl.value : '';
      const only = onlyCb ? onlyCb.checked : false;
      let re = null;
      let invalid = false;
      if (pat) {
        if (pat.length > 256) { invalid = true; }
        else { try { re = new RegExp(pat, 'i'); } catch { invalid = true; } }
      }
      if (matchEl) matchEl.textContent = invalid ? 'Invalid regular expression' : '';
      let matches = 0;
      pane.querySelectorAll('.log-line').forEach((el) => {
        const m = el.querySelector('.log-m');
        if (!m) return;
        const text = m.textContent || '';
        if (!re || invalid) {
          el.classList.remove('log-dim');
          el.hidden = false;
          // strip marks
          m.textContent = text;
          return;
        }
        const hit = re.test(text.slice(0, 8192));
        if (hit) matches += 1;
        if (only) { el.hidden = !hit; el.classList.remove('log-dim'); }
        else { el.hidden = false; el.classList.toggle('log-dim', !hit); }
        // simple highlight without HTML injection
        m.textContent = text;
      });
      if (matchEl && re && !invalid) matchEl.textContent = `${matches} matches`;
    }
    if (filterEl) filterEl.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(applyFilter, 120); });
    if (onlyCb) onlyCb.addEventListener('change', applyFilter);
  }

  // ----- stats panel (FR-050/FR-051, P4) ---------------------------------
  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n; let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    const d = i === 0 ? 0 : (v >= 100 ? 0 : 1);
    return v.toFixed(d) + ' ' + units[i];
  }
  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toFixed(1) + ' %';
  }

  let statsEs = null;
  function closeStats() {
    if (statsEs) { try { statsEs.close(); } catch { /* ignore */ } statsEs = null; }
  }

  function initStatsPanel() {
    closeStats();
    const panel = document.querySelector('[data-stats-panel]');
    if (!panel) return;
    const cid = panel.getAttribute('data-container-id');
    const cstate = panel.getAttribute('data-container-state');
    const cpuEl = panel.querySelector('[data-stats-cpu]');
    const cpuBar = panel.querySelector('[data-stats-cpu-bar]');
    const memEl = panel.querySelector('[data-stats-mem]');
    const memBar = panel.querySelector('[data-stats-mem-bar]');
    const netEl = panel.querySelector('[data-stats-net]');
    const blockEl = panel.querySelector('[data-stats-block]');
    const pidsEl = panel.querySelector('[data-stats-pids]');
    const updEl = panel.querySelector('[data-stats-updated]');
    const stateEl = panel.querySelector('[data-stats-state]');
    const retryBtn = panel.querySelector('[data-stats-retry]');

    function setState(msg, showRetry) {
      if (stateEl) stateEl.textContent = msg || '';
      if (retryBtn) retryBtn.hidden = !showRetry;
    }
    function renderSample(d) {
      if (cpuEl) cpuEl.textContent = fmtPct(d.cpuPct);
      if (cpuBar) {
        const pct = d.cpuPct != null ? Math.min(100, Math.max(0, d.cpuPct)) : 0;
        cpuBar.style.width = (d.cpuPct == null ? 0 : pct) + '%';
        cpuBar.className = 'stats-bar' + (pct >= 90 ? ' is-hot' : pct >= 70 ? ' is-warn' : '');
      }
      if (memEl) {
        if (d.memUsed == null) memEl.textContent = '—';
        else memEl.textContent = fmtBytes(d.memUsed) + (d.memLimit ? ' / ' + fmtBytes(d.memLimit) : ' / —');
      }
      if (memBar) {
        const pct = (d.memUsed != null && d.memLimit) ? Math.min(100, (d.memUsed / d.memLimit) * 100) : 0;
        memBar.style.width = (d.memUsed != null && d.memLimit ? pct : 0) + '%';
        memBar.className = 'stats-bar' + (pct >= 90 ? ' is-hot' : pct >= 70 ? ' is-warn' : '');
      }
      if (netEl) netEl.textContent = '↓ ' + fmtBytes(d.net && d.net.rx) + '  ↑ ' + fmtBytes(d.net && d.net.tx);
      if (blockEl) blockEl.textContent = 'R ' + fmtBytes(d.block && d.block.read) + '  W ' + fmtBytes(d.block && d.block.write);
      if (pidsEl) pidsEl.textContent = d.pids == null ? '—' : String(d.pids);
      if (updEl) updEl.textContent = 'updated just now';
      setState('', false);
    }

    function connect() {
      if (!cid) return;
      if (cstate !== 'running') { setState('Stopped — stats are not sampled', false); return; }
      closeStats();
      setState('Connecting…', false);
      try {
        statsEs = new EventSource('/api/containers/' + encodeURIComponent(cid) + '/stats/stream');
      } catch {
        setState('Stats paused · Retry', true);
        return;
      }
      statsEs.addEventListener('sample', (e) => {
        try { renderSample(JSON.parse(e.data)); } catch { /* ignore */ }
      });
      statsEs.addEventListener('state', (e) => {
        try {
          const d = JSON.parse(e.data);
          setState(d.message || 'Stopped — stats are not sampled', false);
        } catch { /* ignore */ setState('Stopped — stats are not sampled', false); }
        closeStats();
      });
      statsEs.addEventListener('error', () => {
        // design: client closes on error and shows retry (no silent reconnect)
        if (statsEs) { try { statsEs.close(); } catch { /* ignore */ } statsEs = null; }
        setState('Stats paused · Retry', true);
      });
    }
    if (retryBtn) retryBtn.addEventListener('click', connect);
    // Start only if stats panel is visible now
    if (!panel.closest('[hidden]')) connect();
  }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-drawer-tab="stats"]');
    if (tab) {
      // allow navigation/default to update URL, but init after panel shown
      setTimeout(initStatsPanel, 0);
    }
  });
  // Also init on load if already on stats tab
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initStatsPanel);
  else initStatsPanel();
  window.addEventListener('beforeunload', closeStats);

  // ----- compose (FR-070…FR-078, P4) -------------------------------------
  async function startCompose(projectId, action, confirmMixed) {
    const res = await fetch('/api/compose/run', {
      method: 'POST',
      headers: csrfHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ projectId, action, confirmMixed: !!confirmMixed })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data && data.error ? data.error : { code: 'DOCKER_ERROR', message: 'Compose request failed.' };
      if (err.code === 'COMPOSE_MIXED_PROJECT') return { mixed: true, err };
      throw err;
    }
    return { jobId: data.jobId, streamUrl: data.streamUrl };
  }

  function openComposeRunner(projectId, streamUrl, title) {
    const card = document.querySelector('[data-stack-id="' + CSS.escape(projectId) + '"]') || document.querySelector('[data-runner="' + CSS.escape(projectId) + '"]') && document.querySelector('[data-runner="' + CSS.escape(projectId) + '"]').closest('[data-stack-id]');
    let runner = document.querySelector('[data-runner="' + CSS.escape(projectId) + '"]');
    if (!runner && card) runner = card.querySelector('[data-runner]');
    if (!runner) return;
    runner.hidden = false;
    const out = runner.querySelector('[data-runner-output]');
    const state = runner.querySelector('[data-runner-state]');
    const exitEl = runner.querySelector('[data-runner-exit]');
    const copyBtn = runner.querySelector('[data-runner-copy]');
    const titleEl = runner.querySelector('[data-runner-title]');
    if (titleEl && title) titleEl.textContent = title;
    if (out) out.textContent = '';
    if (exitEl) exitEl.textContent = '';
    if (copyBtn) copyBtn.hidden = true;
    if (state) state.textContent = '● running';

    let es;
    try { es = new EventSource(streamUrl); } catch {
      if (state) state.textContent = 'error';
      if (exitEl) exitEl.textContent = 'Could not open compose stream.';
      return;
    }
    es.addEventListener('out', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!out) return;
        const span = document.createElement('span');
        span.className = d.stream === 'stderr' ? 'out-stderr' : 'out-stdout';
        span.textContent = (d.line || '') + '\n';
        out.appendChild(span);
        out.scrollTop = out.scrollHeight;
      } catch { /* ignore */ }
    });
    function finish(text, ok) {
      if (state) state.textContent = ok ? 'done' : 'failed';
      if (exitEl) exitEl.textContent = text;
      if (copyBtn && out) copyBtn.hidden = false;
      try { es.close(); } catch { /* ignore */ }
    }
    es.addEventListener('exit', (e) => {
      try {
        const d = JSON.parse(e.data);
        const code = d.code;
        const dur = d.durationMs ? ' · ' + (d.durationMs / 1000).toFixed(1) + ' s' : '';
        finish('exit code ' + code + dur, code === 0);
        if (code === 0) toast('Compose finished (exit 0).', 'ok'); else toast('Compose failed (exit ' + code + ').', 'error');
      } catch { finish('finished', false); }
    });
    es.addEventListener('error', (e) => {
      if (e.data) {
        try { const d = JSON.parse(e.data); finish(d.message || 'Compose error', false); return; } catch { /* ignore */ }
      }
      // connection error after possible completion: ignore if already closed
    });
    if (copyBtn) copyBtn.addEventListener('click', () => {
      const text = out ? out.textContent || '' : '';
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Output copied.', 'ok')).catch(() => {});
      else { toast('Copy not available.', 'error'); }
    }, { once: true });
  }

  document.addEventListener('click', async (e) => {
    const up = e.target.closest('[data-compose-up]');
    const down = e.target.closest('[data-compose-down]');
    if (!up && !down) return;
    e.preventDefault();
    const btn = up || down;
    const projectId = btn.getAttribute(up ? 'data-compose-up' : 'data-compose-down');
    const action = up ? 'up' : 'down';
    const card = btn.closest('[data-stack-id]');
    const name = card ? card.getAttribute('data-stack-name') : projectId;

    if (action === 'down') {
      const ok = window.confirm('Run "docker compose down" for "' + name + '"?\nThis stops and removes the project containers. Volumes and images are kept.');
      if (!ok) return;
    }

    btn.disabled = true;
    try {
      let result = await startCompose(projectId, action, false);
      if (result.mixed) {
        const ok = window.confirm('This project contains containers not created by this Compose file.\nDown anyway?');
        if (!ok) { btn.disabled = false; return; }
        result = await startCompose(projectId, action, true);
      }
      if (result.jobId) {
        openComposeRunner(projectId, result.streamUrl, name + ' · ' + action);
        toast('Compose ' + action + ' started for ' + name + '.', 'ok');
      }
    } catch (err) {
      const msg = err && err.message ? err.message : 'Compose request failed.';
      toast(msg, 'error');
    } finally {
      btn.disabled = false;
    }
  });



  // ==================================================================
  // P5 — host switcher (C-03, FR-086/FR-087), settings (C-24, FR-081/101)
  // ==================================================================

  const hostSwitch = document.querySelector('[data-host-switch]');
  if (hostSwitch) {
    const hostTrigger = hostSwitch.querySelector('[data-host-trigger]');
    const hostPop = hostSwitch.querySelector('[data-host-pop]');
    const hostList = hostSwitch.querySelector('[data-host-list]');
    const hostFoot = hostSwitch.querySelector('.host-pop-foot');
    let hostsLoaded = false;
    let hostsBusy = false;

    const HOST_STATE_META = (h) => {
      if (h.state === 'reachable') return h.apiVersion ? 'API ' + h.apiVersion : 'reachable';
      if (h.state === 'too-old') return (h.error && h.error.message) || 'API too old — needs 1.40+';
      if (h.state === 'unreachable' || h.state === 'error') return (h.error && h.error.message) || h.state;
      return 'connecting…';
    };
    const HOST_DOT = (h) => (h.state === 'reachable' ? 'dot-run' : (h.state === 'connecting' ? 'dot-stopped' : 'dot-dead'));

    function closeHostPop() {
      if (!hostPop) return;
      hostPop.hidden = true;
      if (hostTrigger) hostTrigger.setAttribute('aria-expanded', 'false');
    }

    function renderHosts(hosts) {
      if (!hostList) return;
      hostList.textContent = '';
      for (const h of hosts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'host-pop-row' + (h.active ? ' is-active' : '');
        row.setAttribute('role', 'menuitemradio');
        row.setAttribute('aria-checked', h.active ? 'true' : 'false');
        row.disabled = Boolean(h.active);
        const dot = document.createElement('span');
        dot.className = 'dot ' + HOST_DOT(h);
        const name = document.createElement('span');
        name.className = 'host-pop-name';
        name.textContent = h.name;
        const meta = document.createElement('span');
        meta.className = 'host-pop-meta';
        meta.textContent = HOST_STATE_META(h);
        row.append(dot, name, meta);
        row.addEventListener('click', () => activateHost(h));
        hostList.appendChild(row);
      }
      if (hostFoot) {
        hostFoot.textContent = hosts.length > 1 ? 'Edit hosts in config.json' : 'Add hosts in config.json';
      }
    }

    async function loadHosts() {
      if (hostsLoaded) return;
      try {
        const r = await fetch('/api/hosts');
        if (!r.ok) return;
        const hosts = await r.json();
        if (Array.isArray(hosts)) { renderHosts(hosts); hostsLoaded = true; }
      } catch { /* keep the server-rendered fallback row */ }
    }

    async function activateHost(h) {
      if (hostsBusy || h.active) return;
      hostsBusy = true;
      closeHostPop();
      try {
        const r = await fetch('/api/hosts/' + encodeURIComponent(h.id) + '/activate', {
          method: 'POST',
          headers: csrfHeaders({ 'content-type': 'application/json' }),
          body: '{}'
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          toast((data.error && data.error.message) || 'Could not switch host.', 'error');
          return;
        }
        // Full resync: every page re-fetches for the new host (§3.4.5).
        window.location.reload();
      } catch {
        toast('Could not switch host.', 'error');
      } finally {
        hostsBusy = false;
      }
    }

    if (hostTrigger && hostPop) {
      hostTrigger.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!hostPop.hidden) { closeHostPop(); return; }
        hostPop.hidden = false;
        hostTrigger.setAttribute('aria-expanded', 'true');
        await loadHosts();
        const first = hostList && hostList.querySelector('button:not(:disabled)');
        if (first) first.focus();
      });
      document.addEventListener('click', (e) => {
        if (!hostSwitch.contains(e.target)) closeHostPop();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && hostPop && !hostPop.hidden) {
          closeHostPop();
          hostTrigger.focus();
        }
      });
      // Keep the popover in step with the host.health frames.
      window.addEventListener('dm:host-health', () => { hostsLoaded = false; });
    }
  }

  // ----- settings page (C-24, FR-081) -----------------------------------
  const settingsPage = document.querySelector('.settings-page');
  if (settingsPage) {
    const pending = new Map();
    let saveTimer = null;
    let saving = false;

    function showSaved(el) {
      const row = el.closest('.settings-row');
      if (!row) return;
      let tick = row.querySelector('.saved-tick');
      if (!tick) {
        tick = document.createElement('span');
        tick.className = 'saved-tick';
        tick.setAttribute('role', 'status');
        (el.parentElement || row).appendChild(tick);
      }
      tick.textContent = 'Saved';
      window.clearTimeout(tick._t);
      tick._t = window.setTimeout(() => { tick.textContent = ''; }, 2500);
    }

    async function flushSettings() {
      if (!pending.size || saving) return;
      const body = {};
      for (const [k, v] of pending) body[k] = v;
      pending.clear();
      saving = true;
      try {
        const r = await fetch('/api/settings', {
          method: 'PATCH',
          headers: csrfHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          toast((data.error && data.error.message) || 'Could not save settings.', 'error');
          return;
        }
        // The server clamps out-of-range values; reflect what was stored.
        for (const key of Object.keys(body)) {
          const stored = data.settings ? data.settings[key] : undefined;
          const el = settingsPage.querySelector('[data-setting="' + key + '"]');
          if (el && stored !== undefined) {
            if (el.type === 'checkbox') el.checked = Boolean(stored);
            else el.value = String(stored);
            showSaved(el);
          }
        }
      } catch {
        toast('Could not save settings.', 'error');
      } finally {
        saving = false;
        if (pending.size) flushSettings();
      }
    }

    settingsPage.addEventListener('change', (e) => {
      const el = e.target.closest('[data-setting]');
      if (!el) return;
      const key = el.getAttribute('data-setting');
      const type = el.getAttribute('data-setting-type');
      let value;
      if (type === 'bool') value = el.checked;
      else if (type === 'int') {
        value = Number.parseInt(el.value, 10);
        if (!Number.isFinite(value)) return;
      } else value = el.value;
      pending.set(key, value);
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(flushSettings, 400); // 400 ms debounce (C-24)
    });

    const pruneBtn = settingsPage.querySelector('[data-notes-prune]');
    if (pruneBtn) {
      pruneBtn.addEventListener('click', async () => {
        let names = [];
        try { names = JSON.parse(pruneBtn.getAttribute('data-names') || '[]'); } catch { names = []; }
        if (!names.length) return;
        const ok = window.confirm('Remove ' + names.length + ' stale note' + (names.length === 1 ? '' : 's') + '?\nThis cannot be undone.');
        if (!ok) return;
        pruneBtn.disabled = true;
        try {
          const r = await fetch('/api/notes/prune', {
            method: 'POST',
            headers: csrfHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ names })
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast((data.error && data.error.message) || 'Could not remove notes.', 'error');
            pruneBtn.disabled = false;
            return;
          }
          toast('Removed ' + (data.removed || 0) + ' note' + ((data.removed || 0) === 1 ? '' : 's') + '.', 'ok');
          window.location.reload();
        } catch {
          toast('Could not remove notes.', 'error');
          pruneBtn.disabled = false;
        }
      });
    }
  }

})();

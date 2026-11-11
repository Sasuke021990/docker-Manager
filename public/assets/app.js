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
    const wrap = document.querySelector('[data-toasts]');
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
    document.querySelectorAll('[data-updated-ago]').forEach((el) => {
      const then = Number(el.getAttribute('data-updated-ago'));
      if (!then) return;
      const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
      el.textContent = `updated ${secs}s ago`;
    });
  }, 1000);

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
})();

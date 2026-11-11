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
    if (e.key === 'Escape') closeDrawer();
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
})();

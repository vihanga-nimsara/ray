'use strict';

(function () {
  const ray = window.ray;
  const els = {
    panel: document.getElementById('spotPanel'),
    input: document.getElementById('spotInput'),
    scroll: document.getElementById('spotScroll'),
    list: document.getElementById('spotList'),
    empty: document.getElementById('spotEmpty'),
    emptyTitle: document.getElementById('spotEmptyTitle'),
    skeleton: document.getElementById('spotSkeleton'),
    skel: document.getElementById('spotSkel'),
    settings: document.getElementById('spotSettings'),
  };

  const state = {
    apps: [],
    meta: { refreshing: true },
    usage: {},
    settings: { recentCount: 5, maxResults: 10 },
    results: [],
    active: 0,
    query: '',
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let panelOpen = false;
  let closing = false;
  let closeTimer = null;
  let fitFrame = null;
  let inputFrame = null;
  let lastHeight = 0;
  let skeletonState = 'hidden';
  let revealTimer = null;

  function fuzzyScore(text, query) {
    let position = 0;
    let gap = 0;
    let streak = 0;
    let bonus = 0;
    for (const character of query) {
      const index = text.indexOf(character, position);
      if (index === -1) return null;
      if (index === position) {
        streak += 1;
        bonus += Math.min(streak, 4) * 4;
      } else {
        gap += index - position;
        streak = 0;
      }
      position = index + 1;
    }
    return 240 - gap * 3 + bonus;
  }

  function fuzzyFromWordStart(lower, query) {
    let best = null;
    for (let index = 0; index < lower.length; index += 1) {
      if (lower[index] !== query[0]) continue;
      if (index !== 0 && !/[\s._\-/]/.test(lower[index - 1])) continue;
      const score = fuzzyScore(lower.slice(index), query);
      if (score !== null && (best === null || score > best)) best = score;
    }
    return best;
  }

  function scoreApp(app, query) {
    const lower = app.name.toLowerCase();
    let score = null;

    if (lower === query) score = 1400;
    else if (lower.startsWith(query)) score = 1000 - lower.length;
    else {
      const index = lower.indexOf(query);
      if (index > 0) {
        const boundary = /[\s._\-/]/.test(lower[index - 1]);
        score = (boundary ? 860 : 720) - index * 2 - lower.length * 0.2;
      }
    }

    if (score === null) {
      const fuzzy = fuzzyFromWordStart(lower, query);
      if (fuzzy === null) return null;
      score = 380 + fuzzy;
    }

    const usage = state.usage[app.id];
    if (usage) {
      score += Math.min(usage.count || 0, 40) * 1.5;
      const age = Date.now() - (usage.lastUsed || 0);
      if (age < 24 * 60 * 60 * 1000) score += 24;
      else if (age < 7 * 24 * 60 * 60 * 1000) score += 12;
      else if (age < 30 * 24 * 60 * 60 * 1000) score += 4;
    }
    return score;
  }

  function suggestions() {
    const count = Math.max(1, Math.min(10, Math.round(Number(state.settings.recentCount) || 5)));
    const recents = state.apps
      .filter((app) => state.usage[app.id] && state.usage[app.id].lastUsed)
      .sort((a, b) => (state.usage[b.id]?.lastUsed || 0) - (state.usage[a.id]?.lastUsed || 0))
      .slice(0, count);

    if (recents.length >= count) return recents;

    // Do not let the last opened app become the entire suggestion list.
    // Recent apps stay first; the rest of the slots use frequent apps, then
    // the alphabetical remainder.
    const seen = new Set(recents.map((app) => app.id));
    const fillers = state.apps
      .filter((app) => !seen.has(app.id))
      .sort((a, b) => {
        const countA = state.usage[a.id]?.count || 0;
        const countB = state.usage[b.id]?.count || 0;
        if (countB !== countA) return countB - countA;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      })
      .slice(0, count - recents.length);

    return [...recents, ...fillers];
  }

  function computeResults() {
    const query = state.query.trim().toLowerCase();
    if (!query) {
      state.results = suggestions();
      return;
    }

    const scored = [];
    for (const app of state.apps) {
      const score = scoreApp(app, query);
      if (score !== null) scored.push({ app, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.app.name.localeCompare(b.app.name, undefined, { sensitivity: 'base' }),
    );
    const limit = Math.max(5, Math.min(10, Math.round(Number(state.settings.maxResults) || 10)));
    state.results = scored.slice(0, limit).map((entry) => entry.app);
  }

  function matchIndices(text, query) {
    const lower = text.toLowerCase();
    const direct = lower.indexOf(query);
    if (direct !== -1) {
      return Array.from({ length: query.length }, (_value, index) => direct + index);
    }
    const indices = [];
    let position = 0;
    for (const character of query) {
      const index = lower.indexOf(character, position);
      if (index === -1) return [];
      indices.push(index);
      position = index + 1;
    }
    return indices;
  }

  function highlighted(text, query) {
    const fragment = document.createDocumentFragment();
    if (!query) {
      fragment.append(document.createTextNode(text));
      return fragment;
    }
    const indices = matchIndices(text, query);
    if (!indices.length) {
      fragment.append(document.createTextNode(text));
      return fragment;
    }
    const marked = new Set(indices);
    let buffer = '';
    let active = false;

    const flush = () => {
      if (!buffer) return;
      if (active) {
        const mark = document.createElement('mark');
        mark.textContent = buffer;
        fragment.append(mark);
      } else {
        fragment.append(document.createTextNode(buffer));
      }
      buffer = '';
    };

    for (let index = 0; index < text.length; index += 1) {
      const next = marked.has(index);
      if (next !== active) {
        flush();
        active = next;
      }
      buffer += text[index];
    }
    flush();
    return fragment;
  }

  function monogram(app) {
    const span = document.createElement('span');
    span.className = 'monogram';
    const chars = Array.from(app.name);
    span.textContent = (chars[0] || '?').toUpperCase();
    return span;
  }

  function makeIcon(app) {
    const host = document.createElement('span');
    host.className = 'spot-row-icon';
    if (app.icon) {
      const img = new Image();
      img.src = app.icon;
      img.alt = '';
      img.draggable = false;
      img.addEventListener(
        'error',
        () => {
          host.replaceChildren(monogram(app));
        },
        { once: true },
      );
      host.append(img);
    } else {
      host.append(monogram(app));
    }
    return host;
  }

  function makeRow(app, index) {
    const row = document.createElement('button');
    row.type = 'button';
    row.id = `spot-opt-${index}`;
    row.className = 'spot-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', index === state.active ? 'true' : 'false');
    row.tabIndex = -1;
    if (index === state.active) row.classList.add('is-active');

    const name = document.createElement('span');
    name.className = 'spot-row-name';
    name.append(highlighted(app.name, state.query.trim().toLowerCase()));

    row.append(makeIcon(app), name);
    row.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse') setActive(index, false);
    });
    row.addEventListener('click', () => launchAt(index));
    return row;
  }

  function renderResults() {
    computeResults();
    if (!state.results.length) state.active = -1;
    else state.active = Math.min(state.active, state.results.length - 1);

    const fragment = document.createDocumentFragment();
    state.results.forEach((app, index) => fragment.append(makeRow(app, index)));
    els.list.replaceChildren(fragment);

    const hasResults = state.results.length > 0;
    els.list.hidden = !hasResults;
    els.empty.hidden = hasResults;
    if (!hasResults) {
      els.emptyTitle.textContent =
        !state.apps.length && state.meta.refreshing ? 'Loading apps…' : 'No apps found';
    }

    els.input.setAttribute(
      'aria-activedescendant',
      hasResults && state.active >= 0 ? `spot-opt-${state.active}` : '',
    );
    els.scroll.scrollTop = 0;
    setActive(state.active, false);
    syncSkeleton(!state.apps.length && Boolean(state.meta.refreshing));
    if (panelOpen) fit();
  }

  function setActive(index, scroll = true) {
    if (index < 0 || !state.results.length) {
      state.active = -1;
      for (const row of els.list.children) {
        row.classList.remove('is-active');
        row.setAttribute('aria-selected', 'false');
      }
      els.input.setAttribute('aria-activedescendant', '');
      return;
    }
    state.active = Math.max(0, Math.min(state.results.length - 1, index));
    const rows = Array.from(els.list.children);
    rows.forEach((row, rowIndex) => {
      const active = rowIndex === state.active;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    els.input.setAttribute('aria-activedescendant', `spot-opt-${state.active}`);
    if (scroll && rows[state.active]) {
      rows[state.active].scrollIntoView({ block: 'nearest' });
    }
  }

  async function launchAt(index, reveal = false) {
    const app = state.results[index];
    if (!app) return;
    if (reveal) {
      const result = await ray.reveal(app.id);
      if (result && result.ok) hidePanel();
      return;
    }
    const result = await ray.launch(app.id);
    if (result && result.ok) {
      // Always leave the next open with a clean field and fresh suggestions.
      state.query = '';
      state.active = -1;
      els.input.value = '';
      hidePanel();
    }
  }

  function syncSkeleton(loading) {
    if (!els.skel) return;

    if (loading) {
      clearTimeout(revealTimer);
      revealTimer = null;
      skeletonState = 'loading';
      els.panel.setAttribute('aria-busy', 'true');
      els.skel.classList.add('is-loading');
      els.skel.classList.remove('is-revealed');
      return;
    }

    els.panel.removeAttribute('aria-busy');
    if (skeletonState !== 'loading') return;

    skeletonState = 'revealing';
    els.skel.classList.add('is-revealed');
    const duration = reducedMotion.matches
      ? 0
      : parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--reveal-dur'),
        ) || 400;
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      revealTimer = null;
      skeletonState = 'hidden';
      els.skel.classList.remove('is-loading', 'is-revealed');
      if (panelOpen) fit();
    }, duration);
  }

  function desiredHeight() {
    // Measure the list's natural height, not the panel's clamped height.
    // Otherwise the panel can never grow past the current window size.
    // While the index is loading, reserve the skeleton's height instead.
    const inputRow = els.panel.querySelector('.spot-input-row');
    const content = els.skel.classList.contains('is-loading')
      ? els.skel.offsetHeight
      : state.results.length
        ? els.list.offsetHeight
        : els.empty.offsetHeight;
    return inputRow.offsetHeight + 1 + content + 12 + 2;
  }

  function fit() {
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      if (!panelOpen) return;
      const height = desiredHeight();
      if (Math.abs(height - lastHeight) < 1) return;
      lastHeight = height;
      ray.resizeSpotlight(height);
    });
  }

  function openPanel() {
    if (!els.panel) return;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    closing = false;
    panelOpen = true;
    lastHeight = 0;
    if (inputFrame) {
      cancelAnimationFrame(inputFrame);
      inputFrame = null;
    }
    clearTimeout(revealTimer);
    revealTimer = null;
    skeletonState = 'hidden';
    els.skel.classList.remove('is-loading', 'is-revealed');
    state.query = '';
    state.active = -1;
    els.input.value = '';
    renderResults();
    els.panel.classList.remove('is-open', 'is-closing');
    void els.panel.offsetWidth;
    requestAnimationFrame(() => {
      els.panel.classList.add('is-open');
      fit();
    });
    els.scroll.scrollTop = 0;
    requestAnimationFrame(() => {
      if (!closing) {
        els.input.focus();
        els.input.select();
      }
    });
  }

  function hidePanel() {
    if (!panelOpen || closing) return;
    closing = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    els.panel.classList.remove('is-open');
    els.panel.classList.add('is-closing');
    const duration = reducedMotion.matches
      ? 0
      : parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur'),
        ) || 150;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      els.panel.classList.remove('is-closing');
      closing = false;
      panelOpen = false;
      ray.spotlightHidden();
    }, duration);
  }

  function applyIndex(snapshot) {
    if (!snapshot) return;
    state.apps = Array.isArray(snapshot.apps) ? snapshot.apps : state.apps;
    state.meta = snapshot.meta || state.meta;
    if (panelOpen) renderResults();
  }

  function applyState(payload) {
    if (!payload) return;
    state.usage = payload.usage || state.usage;
    if (panelOpen) renderResults();
  }

  function applyBootstrap(data) {
    state.apps = Array.isArray(data.apps) ? data.apps : [];
    state.meta = data.meta || state.meta;
    state.usage = data.usage || {};
    state.settings = data.settings || state.settings;
    if (panelOpen) renderResults();
  }

  function bind() {
    els.settings.addEventListener('click', () => ray.openSettings());

    els.input.addEventListener('input', () => {
      state.query = els.input.value;
      state.active = els.input.value.trim() ? 0 : -1;
      els.scroll.scrollTop = 0;
      // Coalesce fast typing into one render per frame.
      if (inputFrame) cancelAnimationFrame(inputFrame);
      inputFrame = requestAnimationFrame(() => {
        inputFrame = null;
        renderResults();
      });
    });

    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (state.results.length) {
          setActive(state.active < 0 ? 0 : (state.active + 1) % state.results.length);
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (state.results.length) {
          setActive(
            state.active < 0
              ? state.results.length - 1
              : (state.active - 1 + state.results.length) % state.results.length,
          );
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        launchAt(state.active, event.ctrlKey || event.metaKey);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hidePanel();
      }
    });

    document.addEventListener('pointerdown', (event) => {
      if (!els.panel.contains(event.target)) hidePanel();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.target === els.input) return;
      event.preventDefault();
      hidePanel();
    });
  }

  async function init() {
    bind();

    let booted = false;
    let pendingIndex = null;
    let pendingState = null;

    ray.onIndex((snapshot) => {
      if (!booted) {
        pendingIndex = snapshot;
        return;
      }
      applyIndex(snapshot);
    });
    ray.onState((payload) => {
      if (!booted) {
        pendingState = payload;
        return;
      }
      applyState(payload);
    });
    ray.onSettings((payload) => {
      if (!payload) return;
      state.settings = { ...state.settings, ...payload };
      if (panelOpen) renderResults();
    });
    ray.onRefit(() => {
      lastHeight = 0;
      if (panelOpen) fit();
    });
    ray.onSpotlightOpen(openPanel);
    ray.onSpotlightClose(hidePanel);

    try {
      const data = await ray.bootstrap();
      applyBootstrap(data);
    } catch (error) {
      console.error('[ray] spotlight bootstrap failed', error);
    }
    booted = true;
    if (pendingState) applyState(pendingState);
    if (pendingIndex) applyIndex(pendingIndex);
  }

  init();
})();

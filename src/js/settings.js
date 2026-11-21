'use strict';

(function () {
  const ray = window.ray;
  const els = {
    enabledSwitch: document.getElementById('enabledSwitch'),
    barStatus: document.getElementById('barStatus'),
    shortcutKeys: document.getElementById('shortcutKeys'),
    showBar: document.getElementById('showBar'),
    scaleGroup: document.getElementById('scaleGroup'),
    recentValue: document.getElementById('recentValue'),
    resultsValue: document.getElementById('resultsValue'),
    loginSwitch: document.getElementById('loginSwitch'),
    loginDesc: document.getElementById('loginDesc'),
    indexCount: document.getElementById('indexCount'),
    indexStatus: document.getElementById('indexStatus'),
    rebuild: document.getElementById('rebuild'),
    version: document.getElementById('version'),
    reset: document.getElementById('reset'),
    quit: document.getElementById('quit'),
    minimize: document.getElementById('minimize'),
    close: document.getElementById('close'),
  };

  const state = { data: null };
  let pendingIndex = null;

  const BOUNDS = {
    recentCount: [1, 5],
    maxResults: [5, 10],
  };

  function renderShortcut(label) {
    els.shortcutKeys.replaceChildren();
    const parts = (label || 'Ctrl + Space').split(/\s*\+\s*/).filter(Boolean);
    for (const part of parts) {
      const kbd = document.createElement('kbd');
      kbd.textContent = part;
      els.shortcutKeys.append(kbd);
    }
  }

  function renderIndex() {
    if (!state.data) return;
    const index = state.data.index || {};
    const count = Number(index.count) || 0;
    els.indexCount.textContent = `${count} app${count === 1 ? '' : 's'} indexed`;
    if (index.refreshing) {
      els.indexStatus.textContent = 'Indexing…';
      els.rebuild.disabled = true;
    } else if (index.error) {
      els.indexStatus.textContent = 'Index error';
      els.rebuild.disabled = false;
    } else {
      els.indexStatus.textContent = 'Index ready';
      els.rebuild.disabled = false;
    }
  }

  function apply(data) {
    if (!data) return;
    state.data = data;
    const enabled = Boolean(data.enabled);

    els.enabledSwitch.setAttribute('aria-checked', String(enabled));
    els.shortcutKeys.classList.toggle('is-off', !enabled);
    els.showBar.disabled = !enabled;

    if (!enabled) {
      els.barStatus.textContent = 'Floating bar is off';
    } else if (!data.shortcutRegistered) {
      els.barStatus.textContent = 'Shortcut unavailable — open Ray from the tray';
    } else {
      els.barStatus.textContent = `${data.shortcutLabel} anywhere in Windows`;
    }
    renderShortcut(data.shortcutLabel);

    els.scaleGroup.querySelectorAll('[data-scale]').forEach((button) => {
      const active = Math.abs(Number(button.dataset.scale) - Number(data.scale)) < 0.001;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    els.recentValue.textContent = String(data.recentCount);
    els.resultsValue.textContent = String(data.maxResults);
    document.querySelectorAll('.stepper').forEach((stepper) => {
      const key = stepper.dataset.setting;
      const value = Number(data[key]);
      const [min, max] = BOUNDS[key] || [0, 10];
      stepper.querySelectorAll('button').forEach((button) => {
        const delta = Number(button.dataset.step);
        button.disabled = (delta < 0 && value <= min) || (delta > 0 && value >= max);
      });
    });

    const loginAvailable = Boolean(data.packaged) && !data.portable;
    els.loginSwitch.setAttribute('aria-checked', String(Boolean(data.launchAtLogin)));
    els.loginSwitch.disabled = !loginAvailable;
    els.loginDesc.textContent = loginAvailable
      ? 'Start Ray silently when you sign in.'
      : 'Available in the installed app.';

    els.version.textContent = data.version || '0.1.0';
    renderIndex();
    if (pendingIndex) {
      state.data.index = { ...state.data.index, ...pendingIndex };
      pendingIndex = null;
      renderIndex();
    }
  }

  async function update(key, value) {
    const data = await ray.updateSetting(key, value);
    if (data) apply(data);
  }

  function bind() {
    els.enabledSwitch.addEventListener('click', () => {
      if (!state.data) return;
      update('enabled', !state.data.enabled);
    });

    els.showBar.addEventListener('click', () => ray.showBar());

    els.scaleGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-scale]');
      if (button) update('scale', Number(button.dataset.scale));
    });

    document.querySelectorAll('.stepper').forEach((stepper) => {
      stepper.addEventListener('click', (event) => {
        const button = event.target.closest('[data-step]');
        if (!button || !state.data) return;
        const key = stepper.dataset.setting;
        const [min, max] = BOUNDS[key] || [0, 10];
        const delta = Number(button.dataset.step);
        const next = Math.max(min, Math.min(max, Number(state.data[key]) + delta));
        if (next !== Number(state.data[key])) update(key, next);
      });
    });

    els.loginSwitch.addEventListener('click', () => {
      if (!state.data || els.loginSwitch.disabled) return;
      update('launchAtLogin', !state.data.launchAtLogin);
    });

    els.rebuild.addEventListener('click', () => {
      els.rebuild.disabled = true;
      els.indexStatus.textContent = 'Indexing…';
      ray.rebuildIndex();
    });

    els.reset.addEventListener('click', async () => {
      const data = await ray.resetSettings();
      if (data) apply(data);
    });

    els.quit.addEventListener('click', () => ray.quit());
    els.minimize.addEventListener('click', () => ray.minimizeSettings());
    els.close.addEventListener('click', () => ray.closeSettings());

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') ray.closeSettings();
    });
  }

  async function init() {
    bind();
    ray.onSettings(apply);
    ray.onIndexStatus((meta) => {
      if (!meta) return;
      if (!state.data) {
        pendingIndex = meta;
        return;
      }
      state.data.index = { ...state.data.index, ...meta };
      renderIndex();
    });

    try {
      const data = await ray.getSettings();
      apply(data);
    } catch (error) {
      console.error('[ray] settings bootstrap failed', error);
    }
  }

  init();
})();

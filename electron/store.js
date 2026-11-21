'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCALES = [0.7, 0.8, 0.9, 1, 1.1, 1.2];
const DEFAULT_SETTINGS = {
  enabled: true,
  scale: 1,
  recentCount: 5,
  maxResults: 10,
};

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const scale = Number(source.scale);
  return {
    enabled: source.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(source.enabled),
    scale: SCALES.includes(scale) ? scale : DEFAULT_SETTINGS.scale,
    recentCount: clampInt(source.recentCount, 1, 5, DEFAULT_SETTINGS.recentCount),
    maxResults: clampInt(source.maxResults, 5, 10, DEFAULT_SETTINGS.maxResults),
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'ray-state.json');
    this.data = { usage: {}, settings: { ...DEFAULT_SETTINGS } };
    this.timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.usage && typeof raw.usage === 'object') {
        this.data.usage = raw.usage;
      }
      this.data.settings = normalizeSettings(raw && raw.settings);
    } catch {
      this.data.settings = { ...DEFAULT_SETTINGS };
    }
    return this.data;
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[ray] could not save state:', error.message);
    }
  }

  touch(id) {
    const usage = this.data.usage[id] || { count: 0, lastUsed: 0 };
    usage.count += 1;
    usage.lastUsed = Date.now();
    this.data.usage[id] = usage;
    this.saveSoon();
  }

  updateSetting(key, value) {
    const current = this.data.settings;
    if (key === 'enabled') current.enabled = Boolean(value);
    else if (key === 'scale') {
      const scale = Number(value);
      if (SCALES.includes(scale)) current.scale = scale;
    } else if (key === 'recentCount') {
      current.recentCount = clampInt(value, 1, 5, current.recentCount);
    } else if (key === 'maxResults') {
      current.maxResults = clampInt(value, 5, 10, current.maxResults);
    }
    this.saveSoon();
    return this.data.settings;
  }

  resetSettings() {
    this.data.settings = { ...DEFAULT_SETTINGS };
    this.saveSoon();
    return this.data.settings;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, SCALES };

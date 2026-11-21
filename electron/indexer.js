'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const CACHE_VERSION = 3;
const UWP_TTL = 7 * 24 * 60 * 60 * 1000;
const PS_SCRIPT = path.join(__dirname, 'scripts', 'list-start-apps.ps1');
const RESOLVE_SCRIPT = path.join(__dirname, 'scripts', 'resolve-shortcuts.ps1');

const EXCLUDE = [
  /(^|\s)uninstall(er)?(\s|$)/i,
  /^about\s/i,
  /^readme\b/i,
  /^release notes\b/i,
  /^changelog\b/i,
  /^documentation\b/i,
  /^manual\b/i,
  /\bmanual\b/i,
  /^website\b/i,
  /^homepage\b/i,
  /^support\b/i,
  /\bcheck for updates?\b/i,
  /\bon the web\b/i,
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function cleanName(value) {
  return String(value || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeKey(name) {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLetter(name) {
  const chars = Array.from(name.trim());
  return (chars[0] || '?').toUpperCase();
}

function makeId(kind, key) {
  return `${kind}_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

function isExcluded(name) {
  return !name || EXCLUDE.some((pattern) => pattern.test(name));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function startMenuRoots() {
  const roots = [];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  if (process.env.ProgramData) {
    roots.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  return roots;
}

async function walkShortcuts(root) {
  const found = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^startup$/i.test(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.lnk' || ext === '.appref-ms') {
          found.push({
            path: full,
            name: cleanName(path.basename(entry.name, path.extname(entry.name)).replace(/\s+-\s+shortcut$/i, '')),
            kind: ext === '.appref-ms' ? 'clickonce' : 'start-menu',
          });
        }
      }
    }
  }
  await visit(root);
  return found;
}

function detailForShortcut(filePath) {
  const folder = path.basename(path.dirname(filePath));
  if (/^(programs|start menu)$/i.test(folder)) return 'Start menu';
  return `Start menu · ${folder}`;
}

function cleanIconLocation(value) {
  let location = String(value || '').trim();
  if (!location) return '';
  if (location.startsWith('"')) {
    const end = location.indexOf('"', 1);
    return end > 0 ? location.slice(1, end) : '';
  }
  location = location.replace(/,-?\d+\s*$/, '').trim();
  return location;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function iconSourceFor(link, resolved) {
  if (!resolved) return null;
  const candidates = [];
  if (resolved.target) candidates.push(resolved.target);
  const iconFile = cleanIconLocation(resolved.icon);
  if (iconFile && iconFile !== resolved.target) candidates.push(iconFile);

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const extension = path.extname(candidate).toLowerCase();
    if (['.exe', '.com', '.dll', '.ico', '.cpl', '.scr', '.msc'].includes(extension)) {
      return candidate;
    }
  }
  return null;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('PowerShell timed out'));
    }, 30000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      const text = stdout.replace(/^\uFEFF/, '').trim();
      if (!text) {
        finish(reject, new Error(stderr.trim() || `PowerShell exited with ${code}`));
        return;
      }
      try {
        finish(resolve, JSON.parse(text));
      } catch {
        finish(reject, new Error('Could not parse the app list from PowerShell'));
      }
    });
  });
}

async function readLogo(file) {
  if (!file) return null;
  try {
    const info = await fsp.stat(file);
    if (!info.isFile() || info.size < 200 || info.size > 600000) return null;
    const buffer = await fsp.readFile(file);
    if (buffer.length < 8 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

class AppIndexer {
  constructor({ dataDir, getFileIcon, onUpdate }) {
    this.dataDir = dataDir;
    this.cacheFile = path.join(dataDir, 'index-cache.json');
    this.getFileIcon = getFileIcon;
    this.onUpdate = onUpdate;
    this.apps = [];
    this.uwp = { scannedAt: 0, apps: [] };
    this.meta = {
      count: 0,
      startMenuCount: 0,
      storeCount: 0,
      sources: 0,
      builtAt: 0,
      durationMs: 0,
      refreshing: false,
      error: null,
      uwpError: null,
    };
    this.refreshPromise = null;
  }

  snapshot() {
    return { apps: this.apps, meta: this.meta };
  }

  find(id) {
    return this.apps.find((app) => app.id === id) || null;
  }

  async loadCache() {
    try {
      const data = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'));
      if (data.version !== CACHE_VERSION || !Array.isArray(data.apps)) return;
      this.apps = data.apps.filter((app) => app && typeof app.id === 'string' && typeof app.name === 'string');
      if (data.uwp && Array.isArray(data.uwp.apps)) this.uwp = data.uwp;
      if (data.meta) {
        this.meta = {
          ...this.meta,
          ...data.meta,
          count: this.apps.length,
          storeCount: this.apps.filter((app) => app.source === 'store').length,
          refreshing: false,
          error: null,
        };
      }
    } catch {
      // First run: there is no cache yet.
    }
  }

  refresh({ force = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(force).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  emit() {
    try {
      this.onUpdate(this.snapshot());
    } catch (error) {
      console.error('[ray] index update failed:', error.message);
    }
  }

  async doRefresh(force) {
    const started = Date.now();
    this.meta = { ...this.meta, refreshing: true, error: null };
    this.emit();

    try {
      const uwpPromise = this.getUwp(force);
      const resolvedPromise = this.resolveShortcuts();
      const links = await this.collectLinks();
      const oldByPath = new Map();
      const oldIconsBySource = new Map();
      for (const app of this.apps) {
        if (app.path) oldByPath.set(app.path.toLowerCase(), app);
        if (app.icon && app.iconSource) oldIconsBySource.set(app.iconSource.toLowerCase(), app.icon);
      }

      const resolvedMap = await resolvedPromise;
      const iconPromises = new Map();
      const iconForSource = (source) => {
        const key = source.toLowerCase();
        if (!iconPromises.has(key)) iconPromises.set(key, this.iconFor(source));
        return iconPromises.get(key);
      };

      const startApps = (await mapLimit(links, 6, async (link) => {
        const old = oldByPath.get(link.path.toLowerCase());
        const resolved = resolvedMap.get(link.path.toLowerCase());
        const iconSource = iconSourceFor(link, resolved);
        let icon = null;
        if (iconSource) {
          if (
            old &&
            old.icon &&
            old.iconSource &&
            old.iconSource.toLowerCase() === iconSource.toLowerCase()
          ) {
            icon = old.icon;
          } else {
            icon = oldIconsBySource.get(iconSource.toLowerCase());
            if (!icon) icon = await iconForSource(iconSource);
          }
        } else if (old && old.icon && old.iconSource) {
          icon = old.icon;
        }
        return {
          id: makeId(link.kind === 'clickonce' ? 'once' : 'app', link.path.toLowerCase()),
          name: link.name,
          path: link.path,
          appId: null,
          source: link.kind,
          sourceLabel: link.kind === 'clickonce' ? 'ClickOnce' : 'Start menu',
          detail: detailForShortcut(link.path),
          icon,
          iconSource,
          letter: firstLetter(link.name),
          mtimeMs: link.mtimeMs,
        };
      })).filter(Boolean);

      startApps.sort((a, b) => collator.compare(a.name, b.name));

      if (!this.apps.length && startApps.length) {
        this.apps = startApps.slice();
        this.meta = {
          ...this.meta,
          count: startApps.length,
          startMenuCount: startApps.length,
          storeCount: 0,
          sources: 1,
          refreshing: true,
        };
        this.emit();
      }

      let uwp = { scannedAt: 0, apps: [], error: null };
      try {
        uwp = await uwpPromise;
      } catch (error) {
        console.warn('[ray] Store app scan failed:', error.message);
        uwp = this.uwp.apps.length ? this.uwp : { scannedAt: 0, apps: [], error: error.message };
      }
      this.uwp = { scannedAt: uwp.scannedAt || this.uwp.scannedAt, apps: uwp.apps || this.uwp.apps };

      const merged = [];
      const seen = new Set();
      for (const app of [...startApps, ...this.uwp.apps]) {
        const key = dedupeKey(app.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(app);
      }

      this.apps = merged;
      this.meta = {
        count: merged.length,
        startMenuCount: startApps.length,
        storeCount: this.uwp.apps.length,
        sources: (startApps.length ? 1 : 0) + (this.uwp.apps.length ? 1 : 0),
        builtAt: Date.now(),
        durationMs: Date.now() - started,
        refreshing: false,
        error: null,
        uwpError: uwp.error || null,
      };
      this.emit();
      await this.writeCache();
    } catch (error) {
      console.error('[ray] index refresh failed:', error);
      this.meta = {
        ...this.meta,
        refreshing: false,
        error: error.message || 'Indexing failed',
        builtAt: this.meta.builtAt || Date.now(),
      };
      this.emit();
    }
  }

  async collectLinks() {
    const links = [];
    const seen = new Set();
    for (const root of startMenuRoots()) {
      try {
        const stat = await fsp.stat(root);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const found = await walkShortcuts(root);
      for (const link of found) {
        if (isExcluded(link.name)) continue;
        const key = path.resolve(link.path).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const stat = await fsp.stat(link.path);
          links.push({ ...link, mtimeMs: stat.mtimeMs });
        } catch {
          // A shortcut disappeared while we were scanning.
        }
      }
    }
    return links;
  }

  async resolveShortcuts() {
    try {
      const parsed = await runPowerShell(RESOLVE_SCRIPT);
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const map = new Map();
      for (const row of rows) {
        if (!row || !row.path) continue;
        map.set(path.resolve(String(row.path)).toLowerCase(), {
          target: String(row.target || '').trim(),
          icon: String(row.icon || '').trim(),
        });
      }
      return map;
    } catch (error) {
      console.warn('[ray] shortcut resolution failed:', error.message);
      return new Map();
    }
  }

  async iconFor(filePath) {
    try {
      const image = await this.getFileIcon(filePath);
      if (!image || image.isEmpty()) return null;
      const size = image.getSize();
      const output = size.width > 40 ? image.resize({ width: 32, height: 32, quality: 'best' }) : image;
      const data = output.toDataURL();
      return data && data.length > 100 ? data : null;
    } catch {
      return null;
    }
  }

  async getUwp(force) {
    if (!force && this.uwp.apps.length && Date.now() - this.uwp.scannedAt < UWP_TTL) {
      return { ...this.uwp, error: null };
    }

    try {
      const parsed = await runPowerShell(PS_SCRIPT);
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const apps = [];
      const seen = new Set();
      for (const row of rows) {
        const name = cleanName(row && row.name);
        const appId = String((row && row.appId) || '').trim();
        if (!name || !appId || !appId.includes('!') || isExcluded(name)) continue;
        const key = dedupeKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const icon = await readLogo(String(row.logo || ''));
        apps.push({
          id: makeId('store', appId),
          name,
          path: null,
          appId,
          source: 'store',
          sourceLabel: 'Microsoft Store',
          detail: 'Microsoft Store app',
          icon,
          letter: firstLetter(name),
          mtimeMs: 0,
        });
      }
      apps.sort((a, b) => collator.compare(a.name, b.name));
      return { scannedAt: Date.now(), apps, error: null };
    } catch (error) {
      if (this.uwp.apps.length) return { ...this.uwp, error: error.message };
      throw error;
    }
  }

  async writeCache() {
    try {
      await fsp.mkdir(this.dataDir, { recursive: true });
      const payload = {
        version: CACHE_VERSION,
        savedAt: Date.now(),
        apps: this.apps,
        uwp: this.uwp,
        meta: this.meta,
      };
      const tmp = `${this.cacheFile}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload));
      await fsp.rename(tmp, this.cacheFile);
    } catch (error) {
      console.warn('[ray] could not write the index cache:', error.message);
    }
  }
}

module.exports = { AppIndexer };

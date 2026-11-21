'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AppIndexer } = require('./indexer');
const { Store } = require('./store');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'preload.js');
const SPOTLIGHT_WIDTH = 728;
const SPOTLIGHT_PADDING = 48;
const DEFAULT_CONTENT_HEIGHT = 367;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('dev.ray.launcher');

let spotlightWindow = null;
let spotlightReady = null;
let spotlightClosing = false;
let spotlightHideFallback = null;
let spotlightContentHeight = 0;
let settingsWindow = null;
let tray = null;
let store = null;
let indexer = null;
let activeShortcut = null;
let quitting = false;
let screenshotMode = false;
let spotlightMoved = false;

const debug = Boolean(process.env.RAY_DEBUG);
const silentStart = process.argv.includes('--silent');
const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);

// capturePage is unreliable with the GPU compositor on some Windows setups.
// Screenshot mode is only used for documentation, so render it in software.
if (process.env.RAY_SHOT) {
  app.disableHardwareAcceleration();
}

function log(...args) {
  if (debug) console.log('[ray]', ...args);
}

function prettyAccelerator(accelerator) {
  if (!accelerator) return null;
  return accelerator.replace(/CommandOrControl|Control/g, 'Ctrl').replace(/\+/g, ' + ');
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function broadcastState() {
  broadcast('ray:state', { usage: store.data.usage });
}

function attachConsole(win, label) {
  if (!debug) return;
  win.webContents.on('console-message', (event) => {
    console.log(`[${label}] ${event.message}`);
  });
}

function spotlightScale() {
  return store && store.data.settings ? store.data.settings.scale : 1;
}

function computeSpotlightBounds(area, contentHeight, preferredY) {
  const scale = spotlightScale();
  const width = Math.min(Math.round(SPOTLIGHT_WIDTH * scale), Math.max(420, area.width - 24));
  const desiredHeight = Math.round(((contentHeight || DEFAULT_CONTENT_HEIGHT) + SPOTLIGHT_PADDING) * scale);
  const maxBottom = area.y + area.height - 8;
  let y =
    typeof preferredY === 'number'
      ? preferredY
      : Math.round(area.y + Math.max(36, area.height * 0.16));
  if (y + desiredHeight > maxBottom) y = Math.max(area.y + 8, maxBottom - desiredHeight);
  const height = Math.max(120, Math.min(desiredHeight, maxBottom - y));
  const x = Math.round(area.x + (area.width - width) / 2);
  return { x, y, width, height };
}

function createSpotlightWindow() {
  const scale = spotlightScale();
  const win = new BrowserWindow({
    width: Math.round(SPOTLIGHT_WIDTH * scale),
    height: Math.round(420 * scale),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    title: 'Ray',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  spotlightReady = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => {
      log('spotlight ready');
      resolve();
    });
  });

  win.loadFile(path.join(ROOT, 'src', 'spotlight.html'));
  attachConsole(win, 'spotlight');

  win.on('will-move', () => {
    spotlightMoved = true;
  });

  win.on('blur', () => {
    if (screenshotMode) return;
    if (!win.isVisible() || win.webContents.isDevToolsOpened()) return;
    hideSpotlight();
  });

  // Alt+F4 should hide the bar, not destroy the background app.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideSpotlight();
  });

  win.on('closed', () => {
    spotlightWindow = null;
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  return win;
}

function positionSpotlight() {
  if (!spotlightWindow) return;
  const current = spotlightWindow.getBounds();
  const display = spotlightMoved
    ? screen.getDisplayMatching(current)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  let next = computeSpotlightBounds(area, spotlightContentHeight);

  if (spotlightMoved) {
    next = {
      ...next,
      x: Math.min(Math.max(area.x + 8, current.x), Math.max(area.x + 8, area.x + area.width - next.width - 8)),
      y: Math.min(Math.max(area.y + 8, current.y), Math.max(area.y + 8, area.y + area.height - next.height - 8)),
    };
  }

  spotlightWindow.setBounds(next, false);
}

function applySpotlightZoom() {
  if (!spotlightWindow || spotlightWindow.isDestroyed()) return;
  spotlightWindow.webContents.setZoomFactor(spotlightScale());
  if (spotlightWindow.isVisible()) {
    spotlightWindow.webContents.send('spotlight:refit');
    resizeSpotlight(spotlightContentHeight || DEFAULT_CONTENT_HEIGHT);
  }
}

function resizeSpotlight(height) {
  if (!spotlightWindow || spotlightWindow.isDestroyed()) return;
  const value = Number(height);
  if (!Number.isFinite(value)) return;
  spotlightContentHeight = Math.max(60, Math.round(value));
  const bounds = spotlightWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const next = computeSpotlightBounds(area, spotlightContentHeight, bounds.y);
  if (spotlightMoved) {
    next.x = Math.min(Math.max(area.x + 8, bounds.x), Math.max(area.x + 8, area.x + area.width - next.width - 8));
  }
  spotlightWindow.setBounds(next, false);
}

async function showSpotlight() {
  if (!spotlightWindow || !store.data.settings.enabled) return;
  if (spotlightWindow.isVisible() && !spotlightClosing) {
    spotlightWindow.focus();
    spotlightWindow.webContents.focus();
    return;
  }
  if (spotlightHideFallback) {
    clearTimeout(spotlightHideFallback);
    spotlightHideFallback = null;
  }
  spotlightClosing = false;
  spotlightWindow.webContents.setZoomFactor(spotlightScale());
  positionSpotlight();
  spotlightWindow.show();
  spotlightWindow.focus();
  spotlightWindow.webContents.focus();
  if (spotlightReady) await spotlightReady;
  if (!spotlightWindow || spotlightWindow.isDestroyed()) return;
  spotlightWindow.webContents.send('spotlight:open');
  log('spotlight shown');
}

function finishSpotlightHide() {
  if (spotlightHideFallback) {
    clearTimeout(spotlightHideFallback);
    spotlightHideFallback = null;
  }
  spotlightClosing = false;
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    spotlightWindow.hide();
  }
}

function hideSpotlight() {
  if (!spotlightWindow || spotlightWindow.isDestroyed() || !spotlightWindow.isVisible()) return;
  if (spotlightClosing) return;
  spotlightClosing = true;
  spotlightWindow.webContents.send('spotlight:close');
  spotlightHideFallback = setTimeout(finishSpotlightHide, 420);
}

function toggleSpotlight() {
  if (!spotlightWindow || !store.data.settings.enabled) return;
  if (spotlightWindow.isVisible() && !spotlightClosing) hideSpotlight();
  else showSpotlight();
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  activeShortcut = null;
  if (!store.data.settings.enabled) return;

  const candidates = ['Control+Space', 'Control+Alt+Space', 'Control+Shift+Space'];
  for (const accelerator of candidates) {
    try {
      if (globalShortcut.register(accelerator, toggleSpotlight)) {
        activeShortcut = accelerator;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }
  if (!activeShortcut) console.warn('[ray] could not register a global shortcut');
  log('shortcut:', activeShortcut);
}

function loginAtStartup() {
  try {
    return app.getLoginItemSettings({ args: ['--silent'] }).openAtLogin;
  } catch {
    return false;
  }
}

function setLoginAtLogin(value) {
  if (!app.isPackaged || isPortable) return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(value),
    path: process.execPath,
    args: ['--silent'],
  });
  updateTray();
  broadcastSettings();
}

function getSettingsPayload() {
  const settings = store.data.settings;
  return {
    ...settings,
    shortcutLabel: prettyAccelerator(activeShortcut) || 'Ctrl + Space',
    shortcutRegistered: Boolean(activeShortcut),
    launchAtLogin: app.isPackaged && !isPortable ? loginAtStartup() : false,
    packaged: app.isPackaged,
    portable: isPortable,
    version: app.getVersion(),
    index: {
      count: indexer ? indexer.apps.length : 0,
      refreshing: indexer ? Boolean(indexer.meta.refreshing) : false,
      builtAt: indexer ? indexer.meta.builtAt || 0 : 0,
      error: indexer ? indexer.meta.error || null : null,
    },
  };
}

function broadcastSettings() {
  broadcast('ray:settings', getSettingsPayload());
}

function buildTrayMenu() {
  const settings = store.data.settings;
  const label = prettyAccelerator(activeShortcut) || 'Ctrl + Space';
  return Menu.buildFromTemplate([
    {
      label: 'Settings…',
      click: openSettings,
    },
    { type: 'separator' },
    {
      label: settings.enabled ? `Search apps   ${label}` : 'Search apps (bar off)',
      enabled: settings.enabled,
      click: showSpotlight,
    },
    {
      label: 'Floating bar',
      type: 'checkbox',
      checked: settings.enabled,
      click: (item) => updateSetting('enabled', item.checked),
    },
    { type: 'separator' },
    {
      label: 'Rebuild app index',
      click: () => indexer && indexer.refresh({ force: true }),
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: app.isPackaged && !isPortable ? loginAtStartup() : false,
      enabled: app.isPackaged && !isPortable,
      click: (item) => setLoginAtLogin(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Quit Ray',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function updateTray() {
  if (!tray) return;
  const settings = store.data.settings;
  const label = prettyAccelerator(activeShortcut) || 'Ctrl + Space';
  tray.setToolTip(
    settings.enabled ? `Ray — ${label} to search` : 'Ray — floating bar off',
  );
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  updateTray();
  tray.on('click', () => {
    if (store.data.settings.enabled) showSpotlight();
    else openSettings();
  });
}

function createSettingsWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 520,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#0c0c0c',
    title: 'Ray Settings',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    roundedCorners: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  win.setPosition(
    Math.round(area.x + (area.width - 560) / 2),
    Math.round(area.y + Math.max(24, (area.height - 680) / 2)),
  );

  win.loadFile(path.join(ROOT, 'src', 'settings.html'));
  attachConsole(win, 'settings');

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    settingsWindow = null;
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  settingsWindow = win;
  return win;
}

function openSettings() {
  if (!store) return;
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  createSettingsWindow();
}

function closeSettings() {
  if (settingsWindow) settingsWindow.close();
}

function applySettingsChange(previous) {
  const current = store.data.settings;
  if (previous.enabled !== current.enabled) {
    if (!current.enabled) hideSpotlight();
    registerShortcuts();
  }
  if (previous.scale !== current.scale) applySpotlightZoom();
  updateTray();
  broadcastSettings();
}

function updateSetting(key, value) {
  if (key === 'launchAtLogin') {
    setLoginAtLogin(Boolean(value));
    return getSettingsPayload();
  }
  const previous = { ...store.data.settings };
  store.updateSetting(key, value);
  applySettingsChange(previous);
  return getSettingsPayload();
}

function resetSettings() {
  const previous = { ...store.data.settings };
  store.resetSettings();
  applySettingsChange(previous);
  return getSettingsPayload();
}

async function launchApp(id) {
  const target = indexer.find(id);
  if (!target) return { ok: false, error: 'That app is no longer in the index.' };

  try {
    if (target.source === 'store') {
      if (!target.appId) return { ok: false, error: 'This app has no launch target.' };
      spawn('explorer.exe', [`shell:AppsFolder\\${target.appId}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      if (!target.path) return { ok: false, error: 'This app has no launch target.' };
      const error = await shell.openPath(target.path);
      if (error) return { ok: false, error };
    }
    store.touch(id);
    broadcastState();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function registerIpc() {
  ipcMain.handle('ray:bootstrap', () => ({
    apps: indexer.apps,
    meta: indexer.meta,
    usage: store.data.usage,
    settings: store.data.settings,
    shortcut: activeShortcut,
    shortcutLabel: prettyAccelerator(activeShortcut),
    version: app.getVersion(),
  }));

  ipcMain.handle('ray:get-settings', () => getSettingsPayload());
  ipcMain.handle('ray:update-setting', (_event, key, value) => updateSetting(String(key || ''), value));
  ipcMain.handle('ray:reset-settings', () => resetSettings());
  ipcMain.handle('ray:rebuild-index', () => {
    if (indexer) indexer.refresh({ force: true }).catch((error) => console.error('[ray] index failed:', error));
    return { ok: true };
  });

  ipcMain.handle('ray:launch', (_event, id) => launchApp(String(id || '')));
  ipcMain.handle('ray:reveal', (_event, id) => {
    const target = indexer.find(String(id || ''));
    if (!target) return { ok: false, error: 'That app is no longer in the index.' };
    if (target.path) {
      shell.showItemInFolder(target.path);
      return { ok: true };
    }
    spawn('explorer.exe', ['shell:AppsFolder'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true };
  });

  ipcMain.on('spotlight:hide', () => hideSpotlight());
  ipcMain.on('spotlight:hidden', () => finishSpotlightHide());
  ipcMain.on('spotlight:resize', (_event, height) => resizeSpotlight(height));
  ipcMain.on('ray:open-settings', () => openSettings());
  ipcMain.on('settings:close', () => closeSettings());
  ipcMain.on('settings:minimize', () => {
    if (settingsWindow) settingsWindow.minimize();
  });
  ipcMain.on('ray:show-bar', () => showSpotlight());
  ipcMain.on('ray:quit', () => {
    quitting = true;
    app.quit();
  });
}

async function runScreenshotMode() {
  const dir = process.env.RAY_SHOT;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  screenshotMode = true;
  const delay = Number(process.env.RAY_SHOT_DELAY || 10000);
  await wait(delay);

  try {
    await showSpotlight();
    await wait(1200);
    if (spotlightWindow) {
      if (process.env.RAY_SHOT_QUERY) {
        const query = JSON.stringify(process.env.RAY_SHOT_QUERY);
        await spotlightWindow.webContents.executeJavaScript(
          `(() => { const input = document.getElementById('spotInput'); if (input) { input.value = ${query}; input.dispatchEvent(new Event('input', { bubbles: true })); } })();`,
        );
        await wait(600);
      }
      try {
        const image = await spotlightWindow.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'spotlight.png'), image.toPNG());
        log('captured spotlight');
      } catch (error) {
        console.error('[ray] spotlight capture failed:', error.message);
      }
    }
    if (process.env.RAY_SHOT_SETTINGS === '1') {
      openSettings();
      await wait(1500);
      if (settingsWindow) {
        const image = await settingsWindow.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'settings.png'), image.toPNG());
        log('captured settings');
      }
    }
  } catch (error) {
    console.error('[ray] screenshot mode failed:', error);
  }
  if (process.env.RAY_SHOT_HOLD) {
    await wait(Number(process.env.RAY_SHOT_HOLD) || 0);
  }
  quitting = true;
  app.quit();
}

async function start() {
  Menu.setApplicationMenu(null);
  store = new Store(app.getPath('userData'));
  store.load();

  indexer = new AppIndexer({
    dataDir: app.getPath('userData'),
    getFileIcon: (file) => app.getFileIcon(file, { size: 'large' }),
    onUpdate: (snapshot) => {
      if (spotlightWindow && !spotlightWindow.isDestroyed()) {
        spotlightWindow.webContents.send('ray:index', snapshot);
      }
      broadcast('ray:index-status', snapshot.meta);
    },
  });
  await indexer.loadCache();

  registerIpc();
  spotlightWindow = createSpotlightWindow();
  spotlightWindow.webContents.setZoomFactor(spotlightScale());
  registerShortcuts();
  createTray();

  // Never scan on every launch. Cached apps are ready immediately; refresh only
  // when there is no cache, or once a day, well after the bar has opened.
  if (!indexer.apps.length) {
    indexer.refresh().catch((error) => console.error('[ray] index failed:', error));
  } else if (Date.now() - Number(indexer.meta.builtAt || 0) > 24 * 60 * 60 * 1000) {
    const refreshWhenIdle = () => {
      if (spotlightWindow && spotlightWindow.isVisible()) {
        setTimeout(refreshWhenIdle, 30000);
        return;
      }
      indexer.refresh().catch((error) => console.error('[ray] index failed:', error));
    };
    setTimeout(refreshWhenIdle, 60000);
  }

  if (process.env.RAY_SHOT) {
    runScreenshotMode();
  } else if (!silentStart && store.data.settings.enabled) {
    // Ray is a background app; show the bar once so it is discoverable.
    setTimeout(() => showSpotlight(), 900);
  }

  log('index on boot:', indexer.apps.length);
}

app.whenReady().then(start);

app.on('second-instance', () => {
  if (store && store.data.settings.enabled) showSpotlight();
  else openSettings();
});

app.on('activate', () => {
  if (store && store.data.settings.enabled) showSpotlight();
  else openSettings();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (store) store.saveNow();
});

app.on('window-all-closed', () => {
  // Ray stays alive in the tray.
});

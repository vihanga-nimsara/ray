'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ray', {
  bootstrap: () => ipcRenderer.invoke('ray:bootstrap'),
  launch: (id) => ipcRenderer.invoke('ray:launch', id),
  reveal: (id) => ipcRenderer.invoke('ray:reveal', id),

  getSettings: () => ipcRenderer.invoke('ray:get-settings'),
  updateSetting: (key, value) => ipcRenderer.invoke('ray:update-setting', key, value),
  resetSettings: () => ipcRenderer.invoke('ray:reset-settings'),
  rebuildIndex: () => ipcRenderer.invoke('ray:rebuild-index'),
  openSettings: () => ipcRenderer.send('ray:open-settings'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  minimizeSettings: () => ipcRenderer.send('settings:minimize'),
  showBar: () => ipcRenderer.send('ray:show-bar'),
  quit: () => ipcRenderer.send('ray:quit'),

  hideSpotlight: () => ipcRenderer.send('spotlight:hide'),
  spotlightHidden: () => ipcRenderer.send('spotlight:hidden'),
  resizeSpotlight: (height) => ipcRenderer.send('spotlight:resize', height),

  onIndex: (callback) => subscribe('ray:index', callback),
  onIndexStatus: (callback) => subscribe('ray:index-status', callback),
  onState: (callback) => subscribe('ray:state', callback),
  onSettings: (callback) => subscribe('ray:settings', callback),
  onSpotlightOpen: (callback) => subscribe('spotlight:open', callback),
  onSpotlightClose: (callback) => subscribe('spotlight:close', callback),
  onRefit: (callback) => subscribe('spotlight:refit', callback),
});

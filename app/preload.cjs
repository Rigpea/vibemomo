// Preload for the studio window (sandboxed, contextIsolation): exposes a small, read-only
// window.atelierDesktop so the UI can tell it runs in the desktop app and show what powers it,
// plus pickFolder() (the system folder dialog, used by Import a folder).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atelierDesktop', {
  version: ipcRenderer.sendSync('atelier:version'),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  specs: () => ipcRenderer.invoke('atelier:specs'),
  pickFolder: () => ipcRenderer.invoke('atelier:pick-folder'),
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wgc', {
  env: () => ipcRenderer.invoke('env'),
  listTunnels: () => ipcRenderer.invoke('list-tunnels'),
  importConf: paths => ipcRenderer.invoke('import-conf', paths),
  deleteTunnel: f => ipcRenderer.invoke('delete-tunnel', f),
  tunnelState: f => ipcRenderer.invoke('tunnel-state', f),
  tunnelUp: f => ipcRenderer.invoke('tunnel-up', f),
  tunnelDown: f => ipcRenderer.invoke('tunnel-down', f),
  reapply: f => ipcRenderer.invoke('tunnel-reapply', f),
  watch: f => ipcRenderer.invoke('watch-tunnel', f),
  unwatch: f => ipcRenderer.invoke('unwatch-tunnel', f),
  onConfChanged: cb => ipcRenderer.on('conf-changed', (_e, data) => cb(data)),
  winMin: () => ipcRenderer.send('win-min'),
  winMax: () => ipcRenderer.send('win-max'),
  winClose: () => ipcRenderer.send('win-close'),
  openExternal: url => ipcRenderer.send('open-external', url),
});

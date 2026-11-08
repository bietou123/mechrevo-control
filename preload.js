'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  onTelemetry: (cb) => ipcRenderer.on('telemetry', (_e, data) => cb(data)),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  device: () => ipcRenderer.invoke('device:info'),
  getPowerPlan: () => ipcRenderer.invoke('power:get'),
  setPowerPlan: (mode) => ipcRenderer.invoke('power:set', mode),
  getBrightness: () => ipcRenderer.invoke('display:getBrightness'),
  setBrightness: (v) => ipcRenderer.invoke('display:setBrightness', v),
  batteryInfo: () => ipcRenderer.invoke('battery:info'),
  displayModes: () => ipcRenderer.invoke('display:modes'),
  setRefresh: (hz) => ipcRenderer.invoke('display:setRefresh', hz),
});

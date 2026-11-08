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

  // 硬件直控（EC 只读 + 官方控制中心 MQTT）
  hwSnapshot: () => ipcRenderer.invoke('hw:snapshot'),
  hwState: () => ipcRenderer.invoke('hw:state'),
  hwRefresh: () => ipcRenderer.invoke('hw:refresh'),
  getMode: () => ipcRenderer.invoke('hw:getMode'),
  setMode: (mode) => ipcRenderer.invoke('hw:setMode', mode),
  readEc: (addr) => ipcRenderer.invoke('hw:raw', addr),
  setKeyboardLevel: (level) => ipcRenderer.invoke('hw:setKeyboard', level),
  setChargeLimit: (up, down) => ipcRenderer.invoke('hw:setCharge', up, down),
});

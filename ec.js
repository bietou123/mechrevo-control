'use strict';
// EC 直读通道：通过官方 ACPIDriverDll.dll（用户态 DeviceIoControl 到 \\.\ACPIDriver）
// 只声明 ReadEC —— 本项目不做任何 EC 写入，绝不刷 EC、不改动 UWACPIDriver.sys
const fs = require('fs');
const path = require('path');

let koffi = null;
let ReadEC = null;
let dllPath = null;
let lastError = null;

const ROOTS = [
  'C:/Program Files/OEM',
  'C:/Program Files (x86)/OEM',
  'C:/Program Files/机械革命电竞控制台',
];

function findDllIn(root, depth) {
  if (depth > 6) return null;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    if (e.isFile() && e.name.toLowerCase() === 'acpidriverdll.dll') return path.join(root, e.name);
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const hit = findDllIn(path.join(root, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

function locate() {
  const env = process.env.MECHREVO_EC_DLL;
  if (env && fs.existsSync(env)) return env;
  for (const r of ROOTS) {
    if (!fs.existsSync(r)) continue;
    const hit = findDllIn(r, 0);
    if (hit) return hit;
  }
  return null;
}

function init() {  // eslint-disable-line consistent-return
  if (ReadEC) return true;
  if (lastError) return false;
  try {
    dllPath = locate();
    if (!dllPath) { lastError = 'ACPIDriverDll.dll 未找到（官方控制中心未安装？）'; return false; }
    koffi = require('koffi');
    // DLL 依赖同目录组件，先把所在目录塞进 PATH
    process.env.PATH = path.dirname(dllPath) + ';' + process.env.PATH;
    const lib = koffi.load(dllPath);
    ReadEC = lib.func('uint8_t ReadEC(uint32_t addr)');
    return true;
  } catch (e) {
    lastError = e.message || String(e);
    return false;
  }
}

function status() {
  return { ok: !!ReadEC, dllPath, error: lastError };
}

function readEC(addr) {
  if (!ReadEC) return null;
  try { return ReadEC(addr) & 0xff; } catch { return null; }
}

function readWord(hiAddr, loAddr) {
  const lo = readEC(loAddr), hi = readEC(hiAddr);
  if (lo == null || hi == null) return null;
  return (hi << 8) | lo;
}

const REG = {
  // 实测判定：高字节是 1124 / 1132（两把风扇同为 0x11=17），低字节是 1125 / 1131
  // 17<<8|216 = 4568 RPM（主扇），17<<8|75 = 4427 RPM（副扇）
  FAN1_HI: 1124, FAN1_LO: 1125,
  FAN2_HI: 1132, FAN2_LO: 1131,
  DUTY1: 1883, DUTY2: 1884,
  PL1: 1923, PL2: 1924, PL4: 1925,
  KB_LIGHT: 1932,
  KB_L1: 1897, KB_L2: 1898, KB_L3: 1899,
  CHG_LIMIT_UP: 1977, CHG_LIMIT_DOWN: 2000,
};

function snapshot() {
  if (!ReadEC) return null;
  const g = (a) => readEC(a);
  return {
    fan1: (g(REG.FAN1_HI) << 8) | g(REG.FAN1_LO),
    fan2: (g(REG.FAN2_HI) << 8) | g(REG.FAN2_LO),
    duty1: g(REG.DUTY1),
    duty2: g(REG.DUTY2),
    pl1: g(REG.PL1), pl2: g(REG.PL2), pl4: g(REG.PL4),
    kbLight: g(REG.KB_LIGHT),
    kb: [g(REG.KB_L1), g(REG.KB_L2), g(REG.KB_L3)],
    chg: [g(REG.CHG_LIMIT_UP), g(REG.CHG_LIMIT_DOWN)],
  };
}

module.exports = { init, status, readEC, readWord, snapshot, REG };

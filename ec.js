'use strict';
// EC 读写通道：通过官方 ACPIDriverDll.dll（用户态 DeviceIoControl 到 \\.\ACPIDriver）
//
// 安全边界（本文件是唯一允许写 EC 的地方）：
//   * 只写白名单里的单个寄存器（键盘背光档位、充电上限/恢复阈值），绝不刷写 EC 固件
//   * 不替换、不修改 UWACPIDriver.sys，不做驱动提权，全部是官方导出的用户态调用
//   * 每次写入都「读原值 → 写 → 立即读回」，与目标不符就自动写回原值并报告失败
//   * 写入地址来自厂商自己的 Define.ECSpec 符号表（ADDR_SINGLEKBL_ENABLE、
//     ADDR_BATTERY_CHARGE_LIMIT_UP/DOWN），不是猜的
const fs = require('fs');
const path = require('path');

let koffi = null;
let ReadEC = null;
let WriteEC = null;
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
    // 反汇编确证：WriteEC(ecx=地址, edx=值)，DeviceIoControl IOCTL 0x9C40A48C（METHOD_BUFFERED）
    WriteEC = lib.func('void WriteEC(uint32_t addr, uint32_t value)');
    return true;
  } catch (e) {
    lastError = e.message || String(e);
    return false;
  }
}

function status() {
  return { ok: !!ReadEC, writable: !!WriteEC, dllPath, error: lastError };
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

/* 唯一的安全写入封装：读原值 → 写 → 读回校验 → 不符立即回滚。
   任何调用方都只能通过它写单字节，不做批量/连续写。 */
function writeEC(addr, value) {
  if (!WriteEC) return { ok: false, addr, error: '写入通道未就绪（WriteEC 未加载）' };
  const want = value & 0xff;
  const orig = readEC(addr);
  if (orig == null) return { ok: false, addr, want, error: '读取原值失败，已放弃写入' };
  if (orig === want) return { ok: true, addr, want, orig, after: orig, unchanged: true };
  try {
    WriteEC(addr, want);
  } catch (e) {
    return { ok: false, addr, want, orig, error: e.message || String(e) };
  }
  const after = readEC(addr);
  if (after === want) return { ok: true, addr, want, orig, after };
  // 读回不一致：写回原值，避免把 EC 留在未知状态
  let rolledBack = null;
  try {
    WriteEC(addr, orig);
    rolledBack = readEC(addr);
  } catch { /* 回滚也失败时如实上报 */ }
  return {
    ok: false, addr, want, orig, after, rolledBack,
    error: `写入后读回 ${after}，与目标 ${want} 不符，已回滚至 ${rolledBack}`,
  };
}

const REG = {
  // 实测判定：高字节是 1124 / 1132（两把风扇同为 0x11=17），低字节是 1125 / 1131
  // 17<<8|216 = 4568 RPM（主扇），17<<8|75 = 4427 RPM（副扇）
  FAN1_HI: 1124, FAN1_LO: 1125,
  FAN2_HI: 1132, FAN2_LO: 1131,
  DUTY1: 1883, DUTY2: 1884,
  PL1: 1923, PL2: 1924, PL4: 1925,
  PROJECT_ID: 1856,
  KB_LIGHT: 1932,      // ADDR_SINGLEKBL_ENABLE：0x80 | 档位（0 关 / 1 低 / 2 高）
  KB_SUPPORT: 1934,    // ADDR_SINGLEKBL_SUPPORTPOWER
  KB_L1: 1897, KB_L2: 1898, KB_L3: 1899,   // RGB 三色级别（本机单色，不用）
  CHG_LIMIT_UP: 1977,  // ADDR_BATTERY_CHARGE_LIMIT_UP：充电上限百分比，100 = 不限
  CHG_LIMIT_DOWN: 2000, // ADDR_BATTERY_CHARGE_LIMIT_DOWN：恢复充电的下限
};

/* 键盘背光：厂商 SingleColorKeyboard.BacklightLevel_Min=0 / Max=2 / Default=2，
   EC 值 = 0x80 | 档位（0x80 关 / 0x81 低 / 0x82 高），本机实测 0x82 为出厂值。 */
const KB_BASE = 0x80;
const KB_MAX_LEVEL = 2;
const KB_NAMES = ['关', '低', '高'];

function kbLevelOf(raw) {
  if (raw == null) return null;
  const lv = raw & 0x7f;
  return lv <= KB_MAX_LEVEL ? lv : null;
}

function setKeyboardLevel(level) {
  const lv = Math.max(0, Math.min(KB_MAX_LEVEL, Math.round(Number(level) || 0)));
  const r = writeEC(REG.KB_LIGHT, KB_BASE | lv);
  return { ...r, level: r.ok ? lv : null, name: KB_NAMES[lv] };
}

/* 充电阈值：厂商 Define.BatteryLifeExtension CHARGING_LIMIT_MIN=0 / MAX=100 / DEFAULT=100，
   100（或 0，均等同未启用）表示不限。2000 是恢复充电的下限，跟着上限留 5% 回差。 */
const CHG_UNLIMITED = 100;
const CHG_HYST = 5;

function normalizeChargeLimit(up) {
  const v = Number(up);
  if (!Number.isFinite(v) || v <= 0 || v >= CHG_UNLIMITED) return CHG_UNLIMITED;
  return Math.round(v);
}

function setChargeLimit(up, down) {
  const limit = normalizeChargeLimit(up);
  const enabled = limit < CHG_UNLIMITED;
  const lower = enabled
    ? Math.max(0, Math.min(limit - 1, Math.round(down == null ? limit - CHG_HYST : Number(down))))
    : 0;
  // 先写恢复下限、再写上限：万一中途失败，EC 不会先卡在一个没有配套下限的上限上
  const rDown = writeEC(REG.CHG_LIMIT_DOWN, lower);
  const rUp = rDown.ok ? writeEC(REG.CHG_LIMIT_UP, limit) : null;
  const ok = rDown.ok && !!rUp && rUp.ok;
  return {
    ok, limit, lower, enabled,
    writes: [rDown, rUp].filter(Boolean),
    error: ok ? undefined : (rDown.error || (rUp && rUp.error)),
  };
}

function snapshot() {
  if (!ReadEC) return null;
  const g = (a) => readEC(a);
  const kbRaw = g(REG.KB_LIGHT);
  const chgUp = g(REG.CHG_LIMIT_UP);
  const chgDown = g(REG.CHG_LIMIT_DOWN);
  const limit = normalizeChargeLimit(chgUp);
  return {
    fan1: (g(REG.FAN1_HI) << 8) | g(REG.FAN1_LO),
    fan2: (g(REG.FAN2_HI) << 8) | g(REG.FAN2_LO),
    duty1: g(REG.DUTY1),
    duty2: g(REG.DUTY2),
    pl1: g(REG.PL1), pl2: g(REG.PL2), pl4: g(REG.PL4),
    kbLight: kbRaw,
    kbLevel: kbLevelOf(kbRaw),
    kbSupported: g(REG.KB_SUPPORT),
    kb: [g(REG.KB_L1), g(REG.KB_L2), g(REG.KB_L3)],
    chg: [chgUp, chgDown],
    chargeLimit: limit,
    chargeEnabled: limit < CHG_UNLIMITED,
  };
}

module.exports = {
  init, status, readEC, readWord, writeEC, snapshot, REG,
  setKeyboardLevel, setChargeLimit, kbLevelOf,
  CHG_UNLIMITED, KB_MAX_LEVEL, KB_NAMES,
};

'use strict';

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const ec = require('./ec.js');
const { GcuClient } = require('./mqtt.js');

let win = null;
let tray = null;
let quitting = false;
let gpu = { ok: false };
let battery = null;
let device = null;
let lastCpu = null;
let hw = null;            // 最近一次 EC 快照
let gcu = null;           // 官方控制中心 MQTT 客户端
let hwInited = false;

// 自动化测试钩子：MECHREVO_TEST=1 时窗口不显示、可连 CDP，不影响正常使用
const TEST_MODE = process.env.MECHREVO_TEST === '1';
if (TEST_MODE) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.MECHREVO_TEST_PORT || '9411');
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

/* ---------------- 工具 ---------------- */

const GBK = new TextDecoder('gbk');

function run(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderrOut) => {
      if (err && TEST_MODE) console.error('[run fail]', file, (err.message || '').slice(0, 300), GBK.decode(stderrOut || Buffer.alloc(0)).slice(0, 300));
      resolve(err ? null : GBK.decode(stdout || Buffer.alloc(0)));
    });
  });
}

function runShell(cmd, timeout = 6000) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], timeout);
}

// 读取一次静态设备信息（用 PowerShell 的 CIM，比 wmic 稳）
async function readDevice() {
  const ps = [
    "$cs=Get-CimInstance Win32_ComputerSystem;",
    "$bb=Get-CimInstance Win32_BaseBoard;",
    "$bios=Get-CimInstance Win32_BIOS;",
    "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1;",
    "$os=Get-CimInstance Win32_OperatingSystem;",
    "$gpu=Get-CimInstance Win32_VideoController | Where-Object {$_.Name -match 'NVIDIA'} | Select-Object -First 1;",
    "$csModel=Get-CimInstance Win32_ComputerSystemProduct;",
    "$disk=Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object -First 1;",
    "$mon=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorID -ErrorAction SilentlyContinue | Select-Object -First 1;",
    "$monName=$(if($mon){(-join [char[]]($mon.UserFriendlyName | Where-Object {$_ -ne 0}))}else{''});",
    "[pscustomobject]@{",
    " system=$cs.Manufacturer+' / '+$cs.Model;",
    " board=$bb.Manufacturer+' / '+$bb.Product;",
    " bios=($bios.Manufacturer+' '+$bios.SMBIOSBIOSVersion).Trim();",
    " biosDate=$bios.ReleaseDate.ToString('yyyy-MM-dd');",
    " cpu=$cpu.Name.Trim();",
    " cores=$cpu.NumberOfCores; threads=$cpu.NumberOfLogicalProcessors;",
    " maxClock=$cpu.MaxClockSpeed;",
    " ramGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1);",
    " os=$os.Caption+' '+$os.Version;",
    " host=$cs.Name;",
    " gpu=$gpu.Name;",
    " gpuDriver=$gpu.DriverVersion;",
    " diskTotal=$(if($disk){[math]::Round($disk.Size/1GB,1)}else{$null});",
    " diskFree=$(if($disk){[math]::Round($disk.FreeSpace/1GB,1)}else{$null});",
    " screenW=$gpu.CurrentHorizontalResolution; screenH=$gpu.CurrentVerticalResolution;",
    " refresh=$gpu.CurrentRefreshRate; panel=$monName",
    "} | ConvertTo-Json -Compress",
  ].join(' ');
  const out = await runShell(ps);
  if (!out) return null;
  try { return JSON.parse(out.trim()); } catch { return null; }
}

async function readGpu() {
  const out = await run(
    'nvidia-smi',
    ['--query-gpu=temperature.gpu,utilization.gpu,clocks.sm,power.draw,memory.used,memory.total,fan.speed',
      '--format=csv,noheader,nounits'],
    8000
  );
  if (!out) return { ok: false };
  const [temp, util, clock, power, memUsed, memTotal, fan] = out.trim().split(',').map(s => s.trim());
  const num = (v) => (v === '' || v === '[N/A]' || v === 'N/A' ? null : Number(v));
  return {
    ok: true,
    temp: num(temp),
    util: num(util),
    clock: num(clock),
    power: num(power),
    memUsed: num(memUsed),
    memTotal: num(memTotal),
    fan: num(fan),
  };
}

async function readBattery() {
  const out = await runShell(
    "$b=Get-CimInstance Win32_Battery | Select-Object -First 1; " +
    "if($b){[pscustomobject]@{charge=$b.EstimatedChargeRemaining;status=$b.BatteryStatus}|ConvertTo-Json -Compress}",
    4000
  );
  if (!out) return null;
  try { return JSON.parse(out.trim()); } catch { return null; }
}

/* 电池设计容量 / 满充容量 / 循环次数：powercfg 电池报告（真实数据） */
let batteryInfo = null;
async function readBatteryInfo() {
  const ps = [
    "$p=Join-Path $env:TEMP 'mechrevo-batt.xml';",
    "powercfg /batteryreport /xml /output $p | Out-Null;",
    "if(-not (Test-Path $p)){'';exit};",
    "[xml]$x=Get-Content $p -Raw;",
    "$ns=New-Object System.Xml.XmlNamespaceManager($x.NameTable);",
    "$ns.AddNamespace('b','http://schemas.microsoft.com/battery/2012');",
    "$b=$x.SelectSingleNode('//b:Batteries/b:Battery',$ns);",
    "if($b){[pscustomobject]@{design=[int]$b.DesignCapacity;full=[int]$b.FullChargeCapacity;cycles=[int]$b.CycleCount;chemistry=$b.Chemistry}|ConvertTo-Json -Compress}",
  ].join(' ');
  const out = await runShell(ps, 15000);
  if (!out) return null;
  try { return JSON.parse(out.trim()); } catch { return null; }
}

/* ---------------- 真实控制：电源方案 / 屏幕亮度 ---------------- */

// 用 GUID 而不是 SCHEME_MIN/MAX 别名：中文系统别名解析不稳定，GUID 才可靠
const POWER_GUID = {
  quiet: 'a1841308-3541-4fab-bc81-f71556f20b4a',      // 节能
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',   // 平衡
  turbo: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',      // 高性能
};

async function readPowerPlan() {
  const out = await run('powercfg.exe', ['/getactivescheme'], 3000);
  if (!out) return { ok: false };
  const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\(([^)]*)\)/i);
  if (!m) return { ok: false };
  return { ok: true, guid: m[1].toLowerCase(), name: m[2] };
}

async function setPowerPlan(mode) {
  const guid = POWER_GUID[mode];
  if (!guid) return { ok: false, error: 'unknown mode' };
  await run('powercfg.exe', ['/setactive', guid], 5000);
  const now = await readPowerPlan();
  return { ok: now.ok && now.guid === guid, plan: now };
}

async function readBrightness() {
  const out = await runShell(
    "try{(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness}catch{}",
    4000
  );
  const v = out ? parseInt(out.trim(), 10) : NaN;
  return Number.isFinite(v) ? v : null;
}

async function setBrightness(level) {
  const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  await runShell(
    "try{(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1).WmiSetBrightness(1," +
    v + ")}catch{}",
    4000
  );
  return readBrightness();
}

/* ---------------- 真实控制：刷新率 ---------------- */

const DISP_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MCDisp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet=CharSet.Ansi)]
  static extern bool EnumDisplaySettings(string dev, int num, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Ansi)]
  static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  public static string Modes() {
    var sb = new StringBuilder(); var seen = new System.Collections.Generic.HashSet<string>();
    for (int i = 0; i < 500; i++) {
      DEVMODE d = new DEVMODE();
      d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(null, i, ref d)) break;
      string k = d.dmPelsWidth + "x" + d.dmPelsHeight + "@" + d.dmDisplayFrequency;
      if (seen.Add(k)) sb.Append(k + "\\n");
    }
    return sb.ToString();
  }
  public static string Current() {
    DEVMODE d = new DEVMODE();
    d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref d)) return "";
    return d.dmPelsWidth + "x" + d.dmPelsHeight + "@" + d.dmDisplayFrequency;
  }
  public static int SetMode(int w, int h, int f) {
    DEVMODE d = new DEVMODE();
    d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref d)) return -1;
    d.dmPelsWidth = w; d.dmPelsHeight = h; d.dmDisplayFrequency = f;
    d.dmFields = 0x580000;
    return ChangeDisplaySettings(ref d, 0);
  }
}`;

let dispLoaded = false;
let dispFile = null;
function ensureDispFile() {
  if (dispFile) return dispFile;
  dispFile = path.join(os.tmpdir(), 'mechrevo-disp.cs');
  fs.writeFileSync(dispFile, DISP_CS, 'utf8');
  return dispFile;
}
async function psDisp(action, timeout = 12000) {
  const file = ensureDispFile();
  return runShell(`Add-Type -Path '${file}' -ErrorAction Stop; ${action}`, timeout);
}

async function displayModes() {
  const out = await psDisp(`[MCDisp]::Modes() + '|' + [MCDisp]::Current()`);
  if (!out) return { ok: false };
  const [list, cur] = out.trim().split('|');
  const modes = (list || '').split(/\r?\n/).filter(Boolean).map(s => {
    const m = s.match(/^(\d+)x(\d+)@(\d+)$/);
    return m ? { w: +m[1], h: +m[2], hz: +m[3] } : null;
  }).filter(Boolean);
  const cm = (cur || '').match(/^(\d+)x(\d+)@(\d+)$/);
  return {
    ok: !!cm,
    current: cm ? { w: +cm[1], h: +cm[2], hz: +cm[3] } : null,
    modes,
  };
}

async function setRefresh(hz) {
  const info = await displayModes();
  if (!info.ok) return { ok: false };
  const { w, h } = info.current;
  const target = info.modes.find(m => m.w === w && m.h === h && m.hz === +hz);
  if (!target) return { ok: false, error: 'unsupported' };
  const out = await psDisp(`[MCDisp]::SetMode(${w},${h},${target.hz})`);
  const code = out ? parseInt(out.trim(), 10) : -1;
  return { ok: code === 0, code };
}


function cpuUsage() {
  const now = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  if (!lastCpu) { lastCpu = now; return 0; }
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] || { idle: c.idle, total: c.total };
    idle += c.idle - p.idle;
    total += c.total - p.total;
  });
  lastCpu = now;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

function cpuClock() {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  return Math.round(cpus.reduce((a, c) => a + c.speed, 0) / cpus.length);
}

function pushTelemetry() {
  if (!win || win.isDestroyed()) return;
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  win.webContents.send('telemetry', {
    t: Date.now(),
    cpu: { usage: cpuUsage(), clock: cpuClock() },
    mem: { used: memTotal - memFree, total: memTotal },
    gpu,
    battery,
    hw,
    gcu: { connected: !!(gcu && gcu.connected) },
  });
}

/* ---------------- 真实控制：风扇 / 性能档 / 键盘灯（官方控制中心通道） ---------------- */

// 官方 GCUService 的档位动作词，大小写必须完全一致（实测只有全大写 GETSTATUS 有响应）
const MODE_TO_ACTION = {
  quiet: 'OPERATING_OFFICE_MODE',
  balanced: 'OPERATING_GAMING_MODE',
  turbo: 'OPERATING_TURBO_MODE',
};
const OM_TO_MODE = { 0: 'quiet', 1: 'balanced', 2: 'turbo' };

function initHardware() {
  const ecOk = ec.init();
  if (TEST_MODE) console.log('[EC]', JSON.stringify(ec.status()));
  hw = ecOk ? ec.snapshot() : null;
  if (ecOk) {
    const t = setInterval(() => { hw = ec.snapshot(); }, 1500);
    if (t.unref) t.unref();
  }

  gcu = new GcuClient();
  gcu.on('connect', () => {
    if (TEST_MODE) console.log('[GCU] connected');
    for (const topic of ['Fan/Control', 'Keyboard/Ctrl', 'Setting/Control']) {
      gcu.publish(topic, { Action: 'GETSTATUS' });
    }
  });
  gcu.on('status', (topic, payload) => {
    if (TEST_MODE) console.log('[GCU]', topic, payload.length + 'B');
  });
  gcu.connect();
}

function profileState() {
  const fan = gcu ? gcu.get('Fan/Status') : null;
  const om = fan ? Number(fan.OperatingMode) : null;
  return {
    operatingMode: Number.isFinite(om) ? om : null,
    mode: Number.isFinite(om) ? OM_TO_MODE[om] || null : null,
    pl1: fan ? fan.CPU_PL1 : null,
    pl2: fan ? fan.CPU_PL2 : null,
    pl4: fan ? fan.CPU_PL4 : null,
    powerMode: fan ? fan.PowerMode : null,
  };
}

async function setOperatingMode(mode) {
  const action = MODE_TO_ACTION[mode];
  if (!action) return { ok: false, error: 'unknown mode' };
  if (!gcu || !gcu.connected) return { ok: false, error: '官方控制中心服务未运行（GCUBridge 未连接）' };

  const before = profileState();
  gcu.publish('Fan/Control', { Action: action });
  // 等 EC 真正切过去，再回读确认
  await new Promise((r) => setTimeout(r, 700));
  gcu.publish('Fan/Control', { Action: 'GETSTATUS' });
  await new Promise((r) => setTimeout(r, 500));
  const after = profileState();
  hw = ec.status().ok ? ec.snapshot() : hw;

  // Windows 电源方案顺带对齐（失败不影响硬件档位）
  const plan = await setPowerPlan(mode);

  return {
    ok: after.mode === mode,
    mode: after.mode,
    before: before.mode,
    profile: after,
    plan: plan.plan || null,
    ec: hw,
  };
}

function keyboardState() {
  const kb = gcu ? gcu.get('Keyboard/Status') : null;
  const level = hw ? hw.kbLevel : null;
  const writable = !!(ec.status && ec.status().writable);
  return {
    // EC 通道可用即可写；官方 MQTT 的 Keyboard/Status 只是补充信息
    available: level != null || writable,
    writable,
    level,
    name: level != null ? ec.KB_NAMES[level] : null,
    levels: ec.KB_NAMES,
    solution: kb && kb.solution,
    type: kb && kb.type,
    powerStatus: kb && kb.powerStatus,
    brightness: kb && kb.brightNess,
    acBrightness: kb && kb.ACBrightness,
    dcBrightness: kb && kb.DCBrightness,
    singleZonePowerSupport: kb && kb.SingleZonePowerSupport,
    ecLevel: hw ? hw.kbLight : null,
    note: '单色键盘：写 EC 1932 = 0x80 | 档位（0 关 / 1 低 / 2 高），写后立即读回校验',
  };
}

function chargeState() {
  const fan = gcu ? gcu.get('Fan/Status') : null;
  const up = hw ? hw.chg[0] : null;
  const down = hw ? hw.chg[1] : null;
  const limit = hw ? hw.chargeLimit : null;
  return {
    available: up != null,
    writable: !!(ec.status && ec.status().writable),
    ecUp: up,
    ecDown: down,
    limit,
    enabled: !!(hw && hw.chargeEnabled),
    fanHasField: !!(fan && 'BatteryChargingLimit' in fan),
    note: 'EC 1977 = 充电上限（100 或 0 = 不限），2000 = 恢复阈值（比上限低 5%）',
  };
}

/* ---------------- 窗口 ---------------- */

function createTray() {
  if (TEST_MODE || tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    tray = new Tray(icon);
    const toggle = () => {
      if (!win) return;
      if (win.isVisible() && !win.isMinimized()) win.hide();
      else { win.show(); win.focus(); }
    };
    tray.setToolTip('MECHREVO 电竞控制台');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => { if (win) { win.show(); win.focus(); } } },
      { label: '隐藏主界面', click: () => { if (win) win.hide(); } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', toggle);
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  } catch (e) {
    tray = null;
    console.error('托盘创建失败:', e && e.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    x: TEST_MODE ? -3200 : undefined,
    y: TEST_MODE ? -3200 : undefined,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#f4f0e8',
    title: 'MECHREVO Control',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => { if (!TEST_MODE) win.show(); });
  if (TEST_MODE) {
    win.webContents.on('did-finish-load', () => { win.showInactive(); });
  }

  const notifyMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', notifyMax);
  win.on('unmaximize', notifyMax);

  // 关闭按钮 = 收进托盘（右键托盘图标可真正退出），测试模式保持原样
  win.on('close', (e) => {
    if (TEST_MODE || quitting) return;
    e.preventDefault();
    win.hide();
  });

  // 外部链接交给系统浏览器，禁止应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!hwInited) { hwInited = true; initHardware(); }

  // 轮询：遥测 2 秒，电池 15 秒
  let tick = 0;
  setInterval(async () => {
    gpu = await readGpu();
    if (tick % 8 === 0) battery = await readBattery();
    tick++;
    pushTelemetry();
  }, 2000);

  setTimeout(async () => {
    if (!device) device = await readDevice();
  }, 300);
}

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));
ipcMain.handle('device:info', async () => {
  if (!device) device = await readDevice();
  return device;
});

/* 真实控制系统接口 */
ipcMain.handle('power:get', () => readPowerPlan());
ipcMain.handle('power:set', (_e, mode) => setPowerPlan(mode));
ipcMain.handle('display:getBrightness', () => readBrightness());
ipcMain.handle('display:setBrightness', (_e, v) => setBrightness(v));
ipcMain.handle('battery:info', async () => {
  if (!batteryInfo) batteryInfo = await readBatteryInfo();
  return batteryInfo;
});
ipcMain.handle('display:modes', () => displayModes());
ipcMain.handle('display:setRefresh', (_e, hz) => setRefresh(hz));

/* 硬件直控接口：风扇 / 性能档 / 键盘灯 / 充电阈值（全部只读或走官方 MQTT） */
ipcMain.handle('hw:snapshot', () => (hw || (ec.init() ? (hw = ec.snapshot()) : null)));
ipcMain.handle('hw:state', () => ({
  ec: ec.status(),
  gcu: { connected: !!(gcu && gcu.connected) },
  hw,
  profile: profileState(),
  keyboard: keyboardState(),
  charge: chargeState(),
}));
ipcMain.handle('hw:getMode', () => profileState());
ipcMain.handle('hw:setMode', (_e, mode) => setOperatingMode(mode));
ipcMain.handle('hw:raw', (_e, addr) => ec.readEC(Number(addr) || 0));
ipcMain.handle('hw:setKeyboard', (_e, level) => {
  const r = ec.setKeyboardLevel(level);
  if (ec.status().ok) hw = ec.snapshot();
  return { ...r, keyboard: keyboardState() };
});
ipcMain.handle('hw:setCharge', (_e, up, down) => {
  const r = ec.setChargeLimit(up, down == null ? undefined : Number(down));
  if (ec.status().ok) hw = ec.snapshot();
  return { ...r, charge: chargeState() };
});
ipcMain.handle('hw:refresh', () => {
  if (gcu && gcu.connected) {
    gcu.publish('Fan/Control', { Action: 'GETSTATUS' });
    gcu.publish('Keyboard/Ctrl', { Action: 'GETSTATUS' });
  }
  if (ec.status().ok) hw = ec.snapshot();
  return { hw, profile: profileState() };
});

app.whenReady().then(() => { createWindow(); createTray(); });
app.on('before-quit', () => { quitting = true; if (gcu) gcu.close(); if (tray) { tray.destroy(); tray = null; } });
app.on('window-all-closed', () => { if (TEST_MODE) app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win) { win.show(); win.focus(); }
});

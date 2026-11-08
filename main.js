'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

let win = null;
let gpu = { ok: false };
let battery = null;
let device = null;
let lastCpu = null;

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

const POWER_ALIAS = { quiet: 'SCHEME_MAX', balanced: 'SCHEME_BALANCED', turbo: 'SCHEME_MIN' };

async function readPowerPlan() {
  const out = await run('powercfg.exe', ['/getactivescheme'], 3000);
  if (!out) return { ok: false };
  const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\(([^)]*)\)/i);
  if (!m) return { ok: false };
  return { ok: true, guid: m[1], name: m[2] };
}

async function setPowerPlan(mode) {
  const alias = POWER_ALIAS[mode];
  if (!alias) return { ok: false, error: 'unknown mode' };
  await run('powercfg.exe', ['/setactive', alias], 5000);
  const now = await readPowerPlan();
  return { ok: now.ok, plan: now };
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
  });
}

/* ---------------- 窗口 ---------------- */

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
    backgroundColor: '#070605',
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

  // 外部链接交给系统浏览器，禁止应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ============================================================
   MECHREVO 电竞控制台 · 交互与模拟遥测
   ============================================================ */

(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const desktop = window.desktop || null;
  const showTemp = v => (v == null || !Number.isFinite(v)) ? '—' : `${Math.round(v)}°C`;
  const showNum = (v, suffix = '') => (v == null || !Number.isFinite(v)) ? '—' : `${Math.round(v)}${suffix}`;
  const gib = bytes => bytes / 1073741824;

  /* ------------------------------------------------------------
     状态
     ------------------------------------------------------------ */
  const MODES = {
    quiet:    { name: '安静', cpu: 22, gpu: 12, tempOff: -4, power: 0.7 },
    balanced: { name: '均衡', cpu: 38, gpu: 27, tempOff: 0,  power: 1.0 },
    turbo:    { name: '狂暴', cpu: 74, gpu: 64, tempOff: 9,  power: 1.45 }
  };

  const state = {
    mode: 'balanced',
    cpu: 38, gpu: 27, mem: 30.6,
    memGB: 9.8, memTotalGB: 32,
    cpuTemp: 62, gpuTemp: 54,
    fan: 2340, power: 45,
    battery: null,
    real: !!desktop,
    gpuClock: null, cpuClock: null,
    series: {
      cpu: [], gpu: [], fan: [], mem: []
    },
    lighting: {
      on: true, effect: 'static', color: '#d4af6a', brightness: 70
    }
  };

  /* 初始化 60 个历史点（仅浏览器预览的模拟模式） */
  (function seedSeries() {
    if (desktop) return;
    const m = MODES[state.mode];
    let c = m.cpu, g = m.gpu, f = 2300, mem = 30;
    for (let i = 0; i < 60; i++) {
      c  = clamp(c  + (Math.random() - 0.5) * 14 + (m.cpu - c) * 0.15, 3, 99);
      g  = clamp(g  + (Math.random() - 0.5) * 10 + (m.gpu - g) * 0.15, 2, 99);
      f  = clamp(f  + (Math.random() - 0.5) * 120 + (2300 - f) * 0.1, 1200, 5200);
      mem = clamp(mem + (Math.random() - 0.5) * 1.2, 22, 46);
      state.series.cpu.push(c);
      state.series.gpu.push(g);
      state.series.fan.push(f);
      state.series.mem.push(mem);
    }
  })();

  /* ------------------------------------------------------------
     提示条
     ------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ------------------------------------------------------------
     视图切换
     ------------------------------------------------------------ */
  const navItems = $$('.nav-item');
  const views = $$('.view');
  navItems.forEach(n => {
    if (n.classList.contains('active')) n.setAttribute('aria-current', 'page');
  });

  function switchView(name, opts = {}) {
    const target = $(`#view-${name}`);
    if (!target) return;
    views.forEach(v => v.classList.toggle('active', v === target));
    navItems.forEach(n => {
      const active = n.dataset.view === name;
      n.classList.toggle('active', active);
      if (active) n.setAttribute('aria-current', 'page');
      else n.removeAttribute('aria-current');
    });
    if (!opts.keepScroll) $('#main').scrollTop = 0;
    if (opts.focus) $('#main')?.focus({ preventScroll: true });
    requestAnimationFrame(() => { drawAll(); });
  }

  navItems.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $$('.fcard').forEach(card => {
    card.addEventListener('click', () => {
      if (card.closest('.dimmed')) return;
      switchView(card.dataset.view);
    });
  });

  /* ------------------------------------------------------------
     Canvas 工具
     ------------------------------------------------------------ */
  function prepare(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  function smoothPath(ctx, pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const xc = (pts[i][0] + pts[i + 1][0]) / 2;
      const yc = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }

  function plotSeries(ctx, series, w, h, color, opts = {}) {
    const max = opts.max || 100;
    const min = opts.min || 0;
    const padTop = opts.padTop ?? 6;
    const padBottom = opts.padBottom ?? 2;
    const innerH = h - padTop - padBottom;
    const pts = series.map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = padTop + innerH - (clamp(v, min, max) - min) / (max - min) * innerH;
      return [x, y];
    });
    if (pts.length < 2) return;

    if (opts.fill) {
      smoothPath(ctx, pts);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, opts.fill);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fill();
    }

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = opts.glow ?? 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.width ?? 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    smoothPath(ctx, pts);
    ctx.stroke();
    ctx.restore();

    if (opts.endDot) {
      const [x, y] = pts[pts.length - 1];
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x - 1, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return pts;
  }

  function drawSpark(canvas, series, color, range = {}) {
    const p = prepare(canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    ctx.clearRect(0, 0, w, h);
    plotSeries(ctx, series, w, h, color, {
      min: range.min ?? 0,
      max: range.max ?? 100,
      padTop: 8, padBottom: 6,
      fill: color.replace('rgb', 'rgba').replace(')', ',.15)'),
      glow: 6, width: 1.4
    });
  }

  function drawMain(canvas) {
    const p = prepare(canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    ctx.clearRect(0, 0, w, h);

    /* 网格 */
    ctx.strokeStyle = 'rgba(214,186,138,.055)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = (h / 5) * i;
      ctx.beginPath();
      ctx.moveTo(0, y + .5);
      ctx.lineTo(w, y + .5);
      ctx.stroke();
    }

    /* 竖向刻度 */
    ctx.strokeStyle = 'rgba(214,186,138,.03)';
    for (let i = 1; i <= 6; i++) {
      const x = (w / 7) * i;
      ctx.beginPath();
      ctx.moveTo(x + .5, 0);
      ctx.lineTo(x + .5, h);
      ctx.stroke();
    }

    plotSeries(ctx, state.series.cpu, w, h, '#d4af6a', {
      min: 0, max: 100, padTop: 12, padBottom: 8,
      fill: 'rgba(212,175,106,.16)', glow: 12, width: 1.8, endDot: true
    });
    plotSeries(ctx, state.series.gpu, w, h, '#c05a45', {
      min: 0, max: 100, padTop: 12, padBottom: 8,
      fill: 'rgba(192,90,69,.08)', glow: 10, width: 1.6, endDot: true
    });
  }

  function drawAll() {
    drawSpark($('.spark[data-series="cpu"]'), state.series.cpu, 'rgb(212,175,106)');
    drawSpark($('.spark[data-series="gpu"]'), state.series.gpu, 'rgb(192,90,69)');
    drawSpark($('.spark[data-series="fan"]'), state.series.fan, 'rgb(127,174,138)', { min: 1000, max: 5400 });
    drawSpark($('.spark[data-series="mem"]'), state.series.mem, 'rgb(125,146,184)', { min: 18, max: 48 });

    if ($('#view-dashboard').classList.contains('active')) drawMain($('#mainChart'));
    if ($('#view-performance').classList.contains('active')) drawMain($('#perfChart'));
  }

  /* ------------------------------------------------------------
     遥测模拟
     ------------------------------------------------------------ */
  function tick() {
    if (desktop) return; // 桌面版由真实遥测驱动
    const m = MODES[state.mode];

    state.cpu = clamp(state.cpu + (m.cpu - state.cpu) * 0.14 + (Math.random() - 0.5) * 9, 2, 99);
    state.gpu = clamp(state.gpu + (m.gpu - state.gpu) * 0.14 + (Math.random() - 0.5) * 7, 1, 99);
    state.mem = clamp(state.mem + (Math.random() - 0.5) * 1.1, 24, 44);

    state.cpuTemp = clamp(40 + state.cpu * 0.62 + m.tempOff + (Math.random() - 0.5) * 2.2, 32, 98);
    state.gpuTemp = clamp(38 + state.gpu * 0.58 + m.tempOff + (Math.random() - 0.5) * 2, 30, 95);

    state.fan = clamp(900 + (state.cpuTemp - 40) * 52 + (Math.random() - 0.5) * 60, 1100, 5400);
    state.power = 18 + state.cpu * 0.95 * m.power + (Math.random() - 0.5) * 4;

    state.series.cpu.push(state.cpu);
    state.series.gpu.push(state.gpu);
    state.series.fan.push(state.fan);
    state.series.mem.push(state.mem);
    for (const k in state.series) {
      while (state.series[k].length > 60) state.series[k].shift();
    }

    render();
  }

  function render() {
    /* 指标卡 */
    $('#cpuNum').textContent = Math.round(state.cpu);
    $('#gpuNum').textContent = Math.round(state.gpu);
    $('#fanNum').textContent = state.fan == null ? '—' : fmt(state.fan);
    $('#memNum').textContent = state.memGB.toFixed(1);

    $('#cpuTempChip').textContent = showTemp(state.cpuTemp);
    $('#gpuTempChip').textContent = showTemp(state.gpuTemp);
    $('#memChip').textContent = `${Math.round(state.mem)}%`;
    if ($('#cpuClock')) $('#cpuClock').textContent = state.cpuClock ? `${(state.cpuClock / 1000).toFixed(2)} GHz` : '—';
    if ($('#gpuClock')) $('#gpuClock').textContent = state.gpuClock ? `${state.gpuClock} MHz` : '—';
    if ($('#memTotal')) $('#memTotal').textContent = `${Math.round(state.memTotalGB)} GB`;

    /* 侧栏 */
    $('#miniCpu').textContent = state.cpuTemp == null ? '—' : `${Math.round(state.cpuTemp)}°`;
    $('#miniGpu').textContent = state.gpuTemp == null ? '—' : `${Math.round(state.gpuTemp)}°`;
    $('#miniFan').textContent = state.fan == null ? '—' : fmt(state.fan);

    /* 性能面板底栏 */
    $('#pfFan').textContent = state.fan == null ? '—' : fmt(state.fan);
    $('#pfPower').textContent = state.power == null ? '—' : Math.round(state.power);
    const head = state.cpuTemp == null ? '未知' : state.cpuTemp < 72 ? '充足' : state.cpuTemp < 83 ? '适中' : '紧张';
    $('#pfHeadroom').textContent = head;
    $('#pfHeadroom').classList.toggle('ok', head === '充足');
    $('#pfHeadroom').style.color = head === '充足' ? 'var(--jade)' : head === '适中' ? 'var(--gold)' : head === '未知' ? 'var(--faint)' : 'var(--cinnabar)';

    /* 性能页温度条 */
    if ($('#tempCpu')) {
      $('#tempCpu').textContent = showTemp(state.cpuTemp);
      $('#tempGpu').textContent = showTemp(state.gpuTemp);
      $('#barCpu').style.width = `${state.cpuTemp ?? 0}%`;
      $('#barGpu').style.width = `${state.gpuTemp ?? 0}%`;
    }

    /* 设备页监控 */
    if ($('#monCpu')) {
      $('#monCpu').textContent = showTemp(state.cpuTemp);
      $('#monGpu').textContent = showTemp(state.gpuTemp);
      $('#monCpuBar').style.width = `${state.cpuTemp ?? 0}%`;
      $('#monGpuBar').style.width = `${state.gpuTemp ?? 0}%`;
      if ($('#monMem')) {
        $('#monMem').textContent = `${state.memGB.toFixed(1)} / ${Math.round(state.memTotalGB)} GB`;
        $('#monMemBar').style.width = `${Math.round(state.mem)}%`;
      }
    }

    const perfFoot = $('#cardPerf');
    if (perfFoot) perfFoot.textContent = `CPU ${showTemp(state.cpuTemp)} · GPU ${showTemp(state.gpuTemp)}`;

    drawAll();
  }

  /* ------------------------------------------------------------
     桌面版：真实遥测
     ------------------------------------------------------------ */
  function pushSeries(key, value) {
    const s = state.series[key];
    if (!s) return;
    if (value == null || !Number.isFinite(value)) return;
    s.push(value);
    while (s.length > 60) s.shift();
  }

  function applyTelemetry(d) {
    if (!d) return;
    if (d.cpu) {
      state.cpu = d.cpu.usage;
      state.cpuClock = d.cpu.clock;
    }
    if (d.mem) {
      const totalGB = gib(d.mem.total);
      state.memTotalGB = totalGB;
      state.memGB = gib(d.mem.used);
      state.mem = (d.mem.used / d.mem.total) * 100;
    }
    if (d.gpu && d.gpu.ok) {
      state.gpu = d.gpu.util ?? 0;
      state.gpuTemp = d.gpu.temp ?? null;
      state.gpuClock = d.gpu.clock ?? null;
      state.power = d.gpu.power ?? null;
    }
    if (d.battery) {
      state.battery = d.battery;
      applyBattery(d.battery.charge);
    }
    pushSeries('cpu', state.cpu);
    pushSeries('gpu', state.gpu);
    pushSeries('mem', state.mem);
    pushSeries('fan', state.fan);
    render();
  }

  let realInfo = null;
  let realBattInfo = null;

  function applyDevice(info) {
    if (!info) {
      const sub = $('#pageSub');
      if (sub) sub.textContent = '无法读取设备信息';
      return;
    }
    realInfo = info;
    const model = (info.system || '').replace(/^MECHREVO\s*\/\s*/i, '');
    const nameEl = $('#deviceName');
    if (nameEl) nameEl.textContent = model.replace(/\s+Series.*$/i, '') || 'MECHREVO';
    const sub = $('#pageSub');
    if (sub) sub.textContent = `${model} · ${info.cpu?.replace(/\(R\)|\(TM\)|CPU @.*$/g, '').trim()} · ${info.gpu || '—'}`;
    const set = (id, v) => { const el = $(`#${id}`); if (el) el.textContent = v || '—'; };
    set('devTitle', info.system);
    set('devModel', info.system);
    set('devCPU', `${info.cpu} · ${info.cores} 核 ${info.threads} 线程`);
    set('devGPU', info.gpu);
    set('devRAM', `${info.ramGB} GB · 双通道`);
    set('devBios', `${info.bios} · ${info.biosDate}`);
    set('devBoard', info.board);
    set('devOS', info.os);
    set('drvGpu', info.gpuDriver);
    if (info.diskTotal) {
      const used = info.diskTotal - (info.diskFree || 0);
      set('devStorage', `${used.toFixed(0)} / ${Math.round(info.diskTotal)} GB 已用`);
      const monDisk = $('#monDisk');
      if (monDisk) {
        monDisk.textContent = `${used.toFixed(0)} / ${Math.round(info.diskTotal)} GB`;
        $('#monDiskBar').style.width = `${Math.round(used / info.diskTotal * 100)}%`;
      }
    }
    /* 真实屏幕参数 */
    const dispSub = $('#view-display .page-sub');
    if (dispSub && info.screenW) {
      const inch = info.screenW >= 3000 ? '超清' : info.screenW >= 2560 ? '2.5K' : info.screenW >= 1920 ? 'FHD' : '标准';
      dispSub.textContent = `${inch} ${info.screenW}×${info.screenH} · ${info.refresh}Hz${info.panel ? ' · ' + info.panel : ''}`;
    }
    const dispChip = $('#dispChip');
    if (dispChip) dispChip.textContent = info.refresh ? `${info.refresh}Hz 当前` : '—';

    /* 首页卡片：同样接真实值，不写死 */
    set('cardDevChip', info.bios ? '已识别' : '—');
    set('cardDevSub', info.bios ? `BIOS ${(info.bios.match(/\S+$/) || ['—'])[0]}` : '—');
    if (info.refresh) set('cardDispHz', `${info.refresh}Hz`);
    if (info.screenW) set('cardDispSub', `${info.screenW}×${info.screenH}${info.panel ? ' · ' + info.panel : ''}`);
  }

  function applyBattery(charge, info) {
    const pct = charge == null ? null : Math.round(charge);
    const pctEl = $('#battPct');
    if (pctEl && pct != null) pctEl.textContent = pct;
    if (pct != null) {
      const ring = $('#ringFill');
      if (ring) ring.style.strokeDashoffset = `${518 - 518 * (pct / 100)}`;
    }
    /* 首页电池卡 */
    if (pct != null) {
      const cc = $('#cardBattPct');
      if (cc) cc.textContent = `${pct}%`;
      const cb = $('#cardBattBar');
      if (cb) cb.style.width = `${pct}%`;
    }
    if (info) {
      realBattInfo = info;
      const design = info.design; // mWh
      const full = info.full;
      if (design && full) {
        const health = Math.round(full / design * 100);
        $('#battHealth').textContent = `${health}%`;
        $('#battDesign').textContent = `${(design / 1000).toFixed(1)} Wh`;
        $('#battFull').textContent = `${(full / 1000).toFixed(1)} Wh`;
        $('#battSub').textContent = health < 80 ? '容量衰减明显' : '电池状态正常';
        const cf = $('#cardBattFoot');
        if (cf) cf.textContent = `健康度 ${health}% · 设计 ${(design / 1000).toFixed(0)}Wh`;
      }
      $('#battCycles').textContent = info.cycles ? `${info.cycles} 次` : '未上报';
    }
    if (charge == null) {
      $('#battSub').textContent = '本机无电池或未上报';
    } else if (state.battery && state.battery.status) {
      const onAC = state.battery.status !== 1;
      const chip = $('#view-battery .page-head .mini-chip');
      if (chip) chip.textContent = onAC ? '已接入电源' : '使用电池';
    }
  }

  /* 桌面版：锁定本机无法实现的控件（诚实标注，不假装生效） */
  function markLocked() {
    $$('[data-lock]').forEach(el => {
      el.classList.add('vendor-locked');
      const head = el.querySelector('.panel-head') || el.querySelector('.page-head');
      if (head && !head.querySelector('.lock-chip')) {
        const chip = document.createElement('span');
        chip.className = 'mini-chip lock-chip';
        chip.textContent = `需厂商驱动 · ${el.dataset.lock}`;
        chip.title = '本机未安装机械革命控制中心；该功能依赖 EC / WMI 厂商接口，第三方程序无法直接控制。';
        head.appendChild(chip);
      }
    });
    $$('[data-demo]').forEach(el => el.remove());
  }

  /* 窗口控制（仅桌面版显示） */
  if (desktop) {
    const wc = $('#winControls');
    if (wc) {
      wc.hidden = false;
      wc.querySelector('[data-win="min"]')?.addEventListener('click', () => desktop.minimize());
      wc.querySelector('[data-win="max"]')?.addEventListener('click', () => desktop.toggleMaximize());
      wc.querySelector('[data-win="close"]')?.addEventListener('click', () => desktop.close());
    }
    desktop.onTelemetry(applyTelemetry);
    desktop.device().then(info => { applyDevice(info); }).catch(() => {});

    /* 电池真实容量 */
    desktop.batteryInfo().then(info => {
      if (info) applyBattery(state.battery ? state.battery.charge : null, info);
    }).catch(() => {});

    /* 屏幕亮度：读取当前值并接入真实控制 */
    const brightInput = $('#displayBright');
    let brightTimer = null;
    desktop.getBrightness().then(v => {
      if (v == null || !brightInput) return;
      brightInput.value = v;
      brightInput.style.setProperty('--p', `${v}%`);
      $('#brightDisplayLabel').textContent = `${v}%`;
    }).catch(() => {});
    brightInput?.addEventListener('input', e => {
      const v = +e.target.value;
      $('#brightDisplayLabel').textContent = `${v}%`;
      clearTimeout(brightTimer);
      brightTimer = setTimeout(() => desktop.setBrightness(v).catch(() => {}), 120);
    });

    /* 电源方案：读取当前实际方案并同步 UI */
    desktop.getPowerPlan().then(r => {
      if (!r || !r.ok) return;
      const map = {
        'a1841308-3541-4fab-bc81-f71556f20b4a': 'quiet',
        '381b4222-f694-41f0-9685-ff5bb260df2e': 'balanced',
        '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'turbo',
      };
      const mode = map[(r.guid || '').toLowerCase()];
      if (mode) setMode(mode, true);
      const pf = $('#pfMode');
      if (pf && !mode) pf.textContent = r.name || '—';
    }).catch(() => {});

    markLocked();

    /* 被锁面板里的滑杆直接禁用，避免看起来能调实际无效 */
    $$('[data-lock] input[type="range"]').forEach(inp => { inp.disabled = true; });

    /* 色温需要显卡驱动级校色（ICC / 厂商工具），本应用不改系统色彩配置 */
    const ct = $('#colorTemp');
    if (ct) {
      ct.disabled = true;
      const lab = ct.closest('.slider-row')?.querySelector('label');
      if (lab && !lab.querySelector('.na-tag')) {
        lab.insertAdjacentHTML('beforeend', ' <span class="na-tag">需校色驱动</span>');
      }
    }

    /* 刷新率：用本机真实支持的模式重建选项 */
    desktop.displayModes().then(r => {
      const seg = $('#refreshSeg');
      if (!seg) return;
      if (!r || !r.ok) { seg.innerHTML = '<span class="na-tag">无法读取显示模式</span>'; return; }
      const freqs = [...new Set(
        r.modes.filter(m => m.w === r.current.w && m.h === r.current.h).map(m => m.hz)
      )].sort((a, b) => a - b);
      if (!freqs.length) { seg.innerHTML = '<span class="na-tag">无可用模式</span>'; return; }
      seg.innerHTML = freqs
        .map(hz => `<button data-hz="${hz}"${hz === r.current.hz ? ' class="active"' : ''}>${hz}Hz</button>`)
        .join('');
    }).catch(() => {
      const seg = $('#refreshSeg');
      if (seg) seg.innerHTML = '<span class="na-tag">无法读取显示模式</span>';
    });

    $('#miniFan')?.setAttribute('title', '需要厂商 EC 或 LibreHardwareMonitor 才能读取风扇转速');
  }

  /* ------------------------------------------------------------
     模式切换
     ------------------------------------------------------------ */
  const modeSegs = [$('#modeSeg'), $('#modeSeg2')].filter(Boolean);

  function setMode(mode, silent = false) {
    if (!MODES[mode]) return;
    state.mode = mode;
    modeSegs.forEach(seg => {
      $$('button', seg).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    });
    $('#pfMode').textContent = MODES[mode].name;
    $('#cardMode').textContent = MODES[mode].name;

    /* 快速切换联动 */
    const quickMap = { quiet: 'office', balanced: 'balanced', turbo: 'game' };
    $$('.quick-card').forEach(c => c.classList.toggle('active', c.dataset.quick === quickMap[mode]));

    if (silent) return;

    if (desktop) {
      /* 桌面版：真的切换 Windows 电源方案 */
      desktop.setPowerPlan(mode).then(r => {
        if (r && r.ok) toast(`已切换至${MODES[mode].name}模式 · 电源方案：${r.plan.name}`);
        else toast('电源方案切换失败，请检查系统权限');
      }).catch(() => toast('电源方案切换失败'));
      return;
    }
    toast(`已切换至${MODES[mode].name}模式`);
  }

  modeSegs.forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      setMode(b.dataset.mode);
    });
  });

  $('#boostBtn').addEventListener('click', () => {
    setMode('turbo');
    if (!desktop) toast('一键狂暴：功耗墙已解除，散热已全速');
  });

  /* 本机无法通过第三方接口实现的功能：诚实提示，不假装生效 */
  const VENDOR_MSG = '本机未安装厂商控制中心，键盘灯 / 风扇 / 充电阈值需要 EC 驱动，当前无法控制';
  function vendorOnly(label) {
    if (desktop) toast(`${label}需要厂商 EC 驱动，本机不可用`);
    else toast(`${label}为演示项`);
  }

  $$('.quick-card').forEach(card => {
    card.addEventListener('click', () => {
      const map = { office: 'quiet', balanced: 'balanced', game: 'turbo' };
      setMode(map[card.dataset.quick]);
      $$('.quick-card').forEach(c => c.classList.toggle('active', c === card));
    });
  });

  /* ------------------------------------------------------------
     开关
     ------------------------------------------------------------ */
  $$('[data-switch]').forEach(sw => {
    sw.addEventListener('click', e => {
      e.stopPropagation();
      const locked = sw.closest('[data-lock]');
      if (desktop && locked) {
        toast(`${locked.dataset.lock}需要厂商 EC 驱动，本机不可用`);
        return;
      }
      sw.classList.toggle('on');
      if (sw.id === 'lightMaster') {
        state.lighting.on = sw.classList.contains('on');
        applyKeyboard();
        toast(state.lighting.on ? '键盘背光已开启' : '键盘背光已关闭');
      }
    });
  });

  /* ------------------------------------------------------------
     滑块
     ------------------------------------------------------------ */
  function syncRange(input) {
    const min = +input.min || 0, max = +input.max || 100;
    const p = ((+input.value - min) / (max - min)) * 100;
    input.style.setProperty('--p', `${p}%`);
  }
  $$('input[type="range"]').forEach(inp => {
    syncRange(inp);
    inp.addEventListener('input', () => syncRange(inp));
  });

  $('#chargeLimit').addEventListener('input', e => {
    if (desktop) { toast('充电阈值需要厂商 EC 驱动，本机不可用'); return; }
    $('#limitLabel').textContent = `${e.target.value}%`;
    const on = +e.target.value < 100;
    $('#chargeLimitSwitch').classList.toggle('on', on);
  });

  $('#chargeLimitSwitch').addEventListener('click', () => {
    if (desktop) { toast('充电阈值需要厂商 EC 驱动，本机不可用'); return; }
    const on = $('#chargeLimitSwitch').classList.contains('on');
    const range = $('#chargeLimit');
    range.value = on ? 80 : 100;
    syncRange(range);
    $('#limitLabel').textContent = `${range.value}%`;
  });

  $('#brightRange').addEventListener('input', e => {
    state.lighting.brightness = +e.target.value;
    $('#kbBrightLabel').textContent = `${e.target.value}%`;
    applyKeyboard();
  });

  $('#displayBright').addEventListener('input', e => {
    $('#brightDisplayLabel').textContent = `${e.target.value}%`;
  });

  const TEMP_NAMES = v => v < 5800 ? '暖' : v <= 7000 ? '标准' : '冷';
  $('#colorTemp')?.addEventListener('input', e => {
    let v = +e.target.value;
    v = Math.round(v / 50) * 50;
    $('#tempLabel').textContent = `${TEMP_NAMES(v)} ${v}K`;
  });
  /* ------------------------------------------------------------
     刷新率 / 色彩模式
     ------------------------------------------------------------ */
  $('#refreshSeg')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-hz]');
    if (!b) return;
    if (desktop) {
      const hz = +b.dataset.hz;
      desktop.setRefresh(hz).then(r => {
        if (r && r.ok) {
          $$('#refreshSeg button').forEach(x => x.classList.toggle('active', x === b));
          toast(`刷新率已切换为 ${hz}Hz（已生效）`);
          const chip = $('#dispChip');
          if (chip) chip.textContent = `${hz}Hz 当前`;
        } else {
          toast(`本机当前分辨率不支持 ${hz}Hz`);
        }
      }).catch(() => toast('刷新率切换失败'));
      return;
    }
    $$('#refreshSeg button').forEach(x => x.classList.toggle('active', x === b));
    $$('.fcard[data-view="display"] .mini-chip').forEach(c => c.textContent = `${b.dataset.hz}Hz`);
    toast(`刷新率已切换为 ${b.dataset.hz}Hz`);
  });

  $('#colorModes')?.addEventListener('click', e => {
    const b = e.target.closest('.mode-card');
    if (!b) return;
    if (desktop) { toast('色彩模式需要厂商显示驱动，本机不可用'); return; }
    $$('#colorModes .mode-card').forEach(x => x.classList.toggle('active', x === b));
    toast(`色彩模式：${b.querySelector('b').textContent}`);
  });

  /* ------------------------------------------------------------
     色彩校正
     ------------------------------------------------------------ */
  const CC_BASE = ['#e3cba4', '#c58f6d', '#cf6b52', '#7fae8a', '#7d92b8', '#e8e2d4'].map(hex => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  const ccInputs = { r: $('#ccR'), g: $('#ccG'), b: $('#ccB') };

  function updateColorCorrect() {
    if (!ccInputs.r) return;
    const gain = {
      r: +ccInputs.r.value / 100,
      g: +ccInputs.g.value / 100,
      b: +ccInputs.b.value / 100
    };
    $$('.cc-swatches i').forEach((el, i) => {
      const [r, g, b] = CC_BASE[i];
      el.style.background = `rgb(${clamp(Math.round(r * gain.r), 0, 255)},${clamp(Math.round(g * gain.g), 0, 255)},${clamp(Math.round(b * gain.b), 0, 255)})`;
    });
    $('#ccRLabel').textContent = ccInputs.r.value;
    $('#ccGLabel').textContent = ccInputs.g.value;
    $('#ccBLabel').textContent = ccInputs.b.value;
    const out = $('#ccReadout');
    if (out) out.textContent = `R ${ccInputs.r.value} · G ${ccInputs.g.value} · B ${ccInputs.b.value}`;
  }

  Object.values(ccInputs).forEach(inp => {
    inp?.addEventListener('input', updateColorCorrect);
  });

  $('#colorResetBtn')?.addEventListener('click', () => {
    Object.values(ccInputs).forEach(inp => {
      if (!inp) return;
      inp.value = 100;
      syncRange(inp);
    });
    updateColorCorrect();
    toast('色彩校正已恢复默认');
  });

  updateColorCorrect();

  /* ------------------------------------------------------------
     灯光
     ------------------------------------------------------------ */
  const KB_ROWS = [14, 14, 13, 12, 7];

  function buildKeyboard() {
    const kb = $('#keyboard');
    if (!kb) return;
    kb.innerHTML = '';
    KB_ROWS.forEach((count, r) => {
      const row = document.createElement('div');
      row.className = 'kb-row';
      for (let i = 0; i < count; i++) {
        const key = document.createElement('div');
        key.className = 'kb-key';
        if (r === 4) {
          if (i === 3) key.classList.add('space');
          else if (i === 0 || i === 6) key.classList.add('wide');
        } else if (r === 0 && i === 0) {
          key.classList.add('wide');
        } else if (r === 0 && i === count - 1) {
          key.classList.add('wide');
        } else if (r === 3 && i === count - 1) {
          key.classList.add('wide');
        }
        row.appendChild(key);
      }
      kb.appendChild(row);
    });
    applyKeyboard();
  }

  function applyKeyboard() {
    const keys = $$('.kb-key');
    if (!keys.length) return;
    const { effect, color, brightness, on } = state.lighting;
    const kb = $('#keyboard');
    kb.style.setProperty('--kb-b', on ? brightness / 100 : 0);

    keys.forEach((k, i) => {
      k.className = k.className.replace(/\beff-\w+\b/g, '').trim();
      k.classList.toggle('lit', on);
      k.style.removeProperty('animation-delay');

      if (effect === 'rainbow') {
        const hue = Math.round((i * 360 / keys.length + (Date.now() / 40) % 360)) % 360;
        k.style.setProperty('--glow', `hsl(${hue},58%,60%)`);
      } else {
        k.style.setProperty('--glow', color);
      }

      if (effect !== 'static') {
        k.classList.add(`eff-${effect}`);
        const col = i % 14;
        if (effect === 'wave') k.style.animationDelay = `${col * 0.07}s`;
        if (effect === 'breath') k.style.animationDelay = `${(r3(i))}s`;
        if (effect === 'audio') k.style.animationDelay = `${(i * 0.137) % 1.4}s`;
      }
    });

    $('#effectChip').textContent = {
      static: '静态', breath: '呼吸', wave: '波浪', rainbow: '彩虹', audio: '随声'
    }[effect];

    const foot = $('.fcard[data-view="lighting"] .fcard-foot span');
    if (foot) foot.textContent = `${effect === 'static' ? '静态' : $('#effectChip').textContent} · ${colorName(color)}`;
  }

  function r3(i) {
    /* 呼吸灯错峰延迟 */
    return ((i * 37) % 100) / 100 * 1.2;
  }

  function colorName(hex) {
    const map = {
      '#d4af6a': '暖金', '#c05a45': '朱砂', '#7fae8a': '青玉',
      '#7d92b8': '雾蓝', '#e8e2d4': '月白', '#c9a0dc': '紫藤'
    };
    return map[hex.toLowerCase()] || '自定义';
  }

  $('#effectSeg')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-effect]');
    if (!b) return;
    state.lighting.effect = b.dataset.effect;
    $$('#effectSeg button').forEach(x => x.classList.toggle('active', x === b));
    applyKeyboard();
  });

  $('#swatches')?.addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    state.lighting.color = b.dataset.color;
    $$('#swatches .swatch').forEach(x => x.classList.toggle('active', x === b));
    const ci = $('#customColor');
    if (ci) ci.value = b.dataset.color;
    applyKeyboard();
  });

  $('#customColor')?.addEventListener('input', e => {
    state.lighting.color = e.target.value;
    $$('#swatches .swatch').forEach(x => x.classList.remove('active'));
    applyKeyboard();
  });

  /* 彩虹模式下轻量刷新色相 */
  setInterval(() => {
    if (state.lighting.effect === 'rainbow' && state.lighting.on) applyKeyboard();
  }, 400);

  /* ------------------------------------------------------------
     应用绑定
     ------------------------------------------------------------ */
  const APPS = [
    ['BS', 'BlackSands.exe', '狂暴'],
    ['DL', 'DyingLight.exe', '狂暴'],
    ['AE', 'AfterFX.exe', '均衡'],
    ['VS', 'Code.exe', '均衡'],
    ['MU', 'MuseScore.exe', '安静']
  ];
  let appCursor = 0;

  $('#addBindBtn')?.addEventListener('click', () => {
    if (desktop) { toast('应用绑定需要厂商 EC 驱动，本机不可用'); return; }
    const [ico, name, mode] = APPS[appCursor % APPS.length];
    appCursor++;
    const row = document.createElement('div');
    row.className = 'bind-row';
    row.innerHTML = `<span class="bind-ico">${ico}</span><span class="bind-name">${name}</span><span class="bind-mode">${mode}</span><button class="icon-btn tiny" data-remove>×</button>`;
    $('#bindList').appendChild(row);
    toast(`已添加 ${name} → ${mode}`);
  });

  $('#bindList')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const row = btn.closest('.bind-row');
    const name = row.querySelector('.bind-name')?.textContent || '应用';
    row.remove();
    toast(`已移除 ${name}`);
  });

  /* ------------------------------------------------------------
     电池
     ------------------------------------------------------------ */
  $('#calibrateBtn')?.addEventListener('click', e => {
    if (desktop) {
      toast('电池校准需要厂商 EC 固件与完整充放电流程，本应用不执行');
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '校准中…';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '开始电池校准';
      toast('电池校准完成：容量已重新估算');
    }, 1800);
  });

  /* ------------------------------------------------------------
     设备信息 / 复制
     ------------------------------------------------------------ */
  $('#copyInfoBtn')?.addEventListener('click', async () => {
    const i = realInfo;
    const lines = i ? [
      `机型: ${i.system || '—'}`,
      `主板: ${i.board || '—'}`,
      `CPU: ${i.cpu || '—'} (${i.cores} 核 ${i.threads} 线程)`,
      `GPU: ${i.gpu || '—'} · 驱动 ${i.gpuDriver || '—'}`,
      `内存: ${i.ramGB} GB`,
      `存储: ${i.diskTotal ? `${(i.diskTotal - (i.diskFree || 0)).toFixed(0)} / ${Math.round(i.diskTotal)} GB 已用` : '—'}`,
      `屏幕: ${i.screenW ? `${i.screenW}×${i.screenH} @ ${i.refresh}Hz` : '—'}`,
      `BIOS: ${i.bios || '—'} (${i.biosDate || '—'})`,
      `系统: ${i.os || '—'}`,
      ...(realBattInfo ? [`电池: 设计 ${(realBattInfo.design / 1000).toFixed(1)} Wh · 满充 ${(realBattInfo.full / 1000).toFixed(1)} Wh`] : []),
    ] : [
      'MECHREVO 极光 Pro 16',
      'CPU: Intel Core i9-14900HX',
      'GPU: NVIDIA RTX 4070 Laptop 8GB',
      '内存: 32GB DDR5-5600',
      '存储: 1TB PCIe 4.0 NVMe',
      'BIOS: 1.24',
      '序列号: MR16-2025-08-0412',
      '系统: Windows 11 家庭中文版 23H2'
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast(desktop ? '真实设备信息已复制' : '设备信息已复制');
    } catch {
      toast('复制失败，请检查剪贴板权限');
    }
  });

  $('#checkupBtn')?.addEventListener('click', e => {
    if (desktop) {
      const parts = [];
      if (state.gpuTemp != null) parts.push(`GPU ${Math.round(state.gpuTemp)}°C`);
      if (state.cpu.usage != null) parts.push(`CPU 负载 ${Math.round(state.cpu.usage)}%`);
      if (state.memGB != null) parts.push(`内存 ${state.memGB.toFixed(1)} / ${Math.round(state.memTotalGB)} GB`);
      if (realBattInfo && realBattInfo.design) {
        parts.push(`电池健康 ${Math.round(realBattInfo.full / realBattInfo.design * 100)}%`);
      }
      parts.push('CPU 温度 / 风扇转速本机无法读取');
      toast(`体检：${parts.join(' · ')}`);
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '检测中…';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '一键检测';
      toast(`体检完成：温度 ${Math.round(state.cpuTemp)}°C，风扇 ${fmt(state.fan)} RPM，电池健康 96%`);
    }, 1100);
  });

  $('#optimizeBtn')?.addEventListener('click', e => {
    if (desktop) {
      toast('系统优化需要管理员权限与清理策略，本应用不擅自删除任何文件');
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '优化中…';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = old;
      toast('系统优化完成：已清理 1.8 GB 临时文件');
    }, 1200);
  });

  $('#powerBtn')?.addEventListener('click', () => toast('电源菜单为演示项，未执行任何操作'));

  /* ------------------------------------------------------------
     搜索
     ------------------------------------------------------------ */
  const searchInput = $('#search');
  const searchCount = $('#searchCount');
  const searchKbd = $('#searchKbd');
  const fcards = $$('.fcard');

  function showSearchCount(n) {
    if (!searchCount) return;
    if (n > 0) {
      searchCount.textContent = `${n} 项`;
      searchCount.hidden = false;
      if (searchKbd) searchKbd.hidden = true;
    } else {
      searchCount.hidden = true;
      if (searchKbd) searchKbd.hidden = false;
    }
  }

  function clearSearch() {
    $$('.dimmed').forEach(el => el.classList.remove('dimmed'));
    $$('.match').forEach(el => el.classList.remove('match'));
    $$('.hit').forEach(el => el.classList.remove('hit'));
    showSearchCount(0);
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { clearSearch(); return; }
    const activeView = $('.view.active');
    let hits = 0;

    navItems.forEach(n => {
      const hit = n.textContent.toLowerCase().includes(q);
      if (hit) hits++;
      n.classList.toggle('dimmed', !hit);
      n.classList.toggle('hit', hit);
    });
    fcards.forEach(c => {
      const hit = c.textContent.toLowerCase().includes(q);
      if (hit) hits++;
      c.classList.toggle('dimmed', !hit);
      c.classList.toggle('hit', hit);
    });
    $$('.panel', activeView).forEach(p => {
      const hit = p.textContent.toLowerCase().includes(q);
      if (hit) hits++;
      p.classList.toggle('dimmed', !hit);
      p.classList.toggle('hit', hit);
    });
    showSearchCount(hits);
  }

  function searchJump() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return;
    const navHit = navItems.find(n => n.textContent.toLowerCase().includes(q));
    if (navHit) {
      switchView(navHit.dataset.view);
      clearSearch();
      searchInput.blur();
      return;
    }
    for (const v of views) {
      const panel = [...v.querySelectorAll('.panel')].find(p => p.textContent.toLowerCase().includes(q));
      if (panel) {
        switchView(v.id.replace('view-', ''));
        clearSearch();
        requestAnimationFrame(() => {
          panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
          panel.classList.add('match');
          setTimeout(() => panel.classList.remove('match'), 1900);
        });
        searchInput.blur();
        return;
      }
    }
    toast(`未找到与「${searchInput.value.trim()}」相关的内容`);
  }

  searchInput?.addEventListener('input', e => runSearch(e.target.value));
  searchInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchJump();
    if (e.key === 'Escape') { searchInput.value = ''; clearSearch(); searchInput.blur(); }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    }
    if (e.key === 'Escape' && document.activeElement === searchInput) {
      searchInput.value = '';
      clearSearch();
      searchInput.blur();
    }
  });

  /* ------------------------------------------------------------
     窗口尺寸变化
     ------------------------------------------------------------ */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawAll, 160);
  });

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  buildKeyboard();
  setMode('balanced', true);
  render();
  tick();
  setInterval(tick, 1000);
  setTimeout(drawAll, 120);

  /* 电池环形：87% → dashoffset */
  const ring = $('#ringFill');
  if (ring) {
    const C = 2 * Math.PI * 82;
    ring.style.strokeDasharray = `${C}`;
    ring.style.strokeDashoffset = `${C * (1 - 0.87)}`;
  }
})();

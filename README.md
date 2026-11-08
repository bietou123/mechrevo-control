# MECHREVO 电竞控制台 · 暗金重设计

对「机械革命电竞控制台」官方界面的一次高保真重设计概念稿：把原本拥挤、灰白的控制面板，改造成一套**暗色墨金风格**的电竞控制台。

网页版是纯前端实现，**零依赖、零构建**，双击 `index.html` 即可打开，不需要联网、不需要安装任何东西。

桌面版（Electron，v1.2.0 起）在此之上接入本机真实硬件：CPU / GPU 负载与温度、内存、电池、屏幕亮度与刷新率，并通过官方控制中心的本地 MQTT 服务（127.0.0.1:13688）切换**安静 / 均衡 / 狂暴**三档，用官方 `ACPIDriverDll.dll` 读 EC 拿真实风扇转速（实测 4568 / 4427 RPM）与 PL1/PL2/PL4 功耗墙。v1.3.0 起，键盘背光三档与充电上限也经同一官方 DLL 写入 EC——只写白名单里的单个寄存器，写后立即读回校验，不符自动回滚（见「安全边界」）。做不到的能力会如实标注「只读 · 不可用」，绝不伪造成功。

> ⚠️ 本项目是独立的第三方客户端，与机械革命（MECHREVO）官方无关。网页版的数据为**前端模拟**；桌面版展示本机实测值，但只覆盖下表所列能力。

### 桌面版实测能力

| 功能 | 状态 | 通道 |
|---|---|---|
| 性能 / 功耗档 | ✅ 可控制 | `Fan/Control` → `OPERATING_*_MODE`，实测 PL1 = 35 / 60 / 75 W，同时切换 Windows 电源计划 |
| 风扇转速 | ✅ 可读取 | 只读 EC 寄存器 `1124/1125`、`1132/1131`，实时刷新 |
| 充电阈值 | ✅ 可设置 | 写 EC `1977`（充电上限，`100` = 不限）与 `2000`（恢复阈值，比上限低 5%），写后读回校验 |
| 键盘背光 | ✅ 可设置 | 单色三档，写 EC `1932` = `0x80 \| 档位`（`0` 关 / `1` 低 / `2` 高），写后读回校验 |

写入能力只在官方 `ACPIDriverDll.dll` 的 `WriteEC` 可用时开放；通道不可用时界面显示锁定并说明原因，不会伪造成功。RGB 分区灯效、自定义风扇曲线本机没有对应寄存器，仍为不可用。

---

## 下载

| 版本 | 说明 | 下载 |
|---|---|---|
| 桌面版 v1.3.0 | Windows 便携版，免安装，双击即用（键盘背光三档 + 充电上限真实写入） | [MECHREVO-Control-1.3.0.exe](https://github.com/bietou123/mechrevo-control/releases/download/v1.3.0/MECHREVO-Control-1.3.0.exe) |
| 桌面版 v1.2.0 | 上一版：档位切换 + 风扇/功耗墙只读 | [MECHREVO-Control-1.2.0.exe](https://github.com/bietou123/mechrevo-control/releases/download/v1.2.0/MECHREVO-Control-1.2.0.exe) |
| 网页版 | 零依赖纯前端，克隆仓库后双击 `index.html` | [全部发布](https://github.com/bietou123/mechrevo-control/releases) |

> 便携版未做代码签名，Windows SmartScreen 可能提示「未知发布者」，选择「更多信息 → 仍要运行」即可。

---

## 预览

**控制台总览** — 实时负载曲线、四大核心指标卡、快捷入口

![控制台总览](docs/preview/dashboard.png)

| 性能 | 灯光 |
|---|---|
| ![性能](docs/preview/performance.png) | ![灯光](docs/preview/lighting.png) |

**电池** — 电量环、健康度、充电保护、近 7 日续航

![电池](docs/preview/battery.png)

其余视图：

| 视图 | 内容 |
|---|---|
| 显示 | 分辨率 / 刷新率 / HDR / 逐通道色彩校正 |
| 设备信息 | 系统信息、实时监控、驱动状态 |
| 常规设置 | 启动行为、快速切换、快捷键说明 |
| 关于 | 版本、更新日志、开源声明 |

## 桌面版（Electron）

```bash
npm install          # Electron、electron-builder 与 koffi（用户态调用 DLL）
npm start            # 开发运行（需本机已安装机械革命电竞控制台）
npm run dist         # 打便携版 release/MECHREVO-Control-<version>.exe
```

- `main.js` 是主进程：窗口控制、遥测推送、电源计划、亮度与显示模式、硬件控制 IPC。
- `ec.js` 用 `koffi` 加载官方 `ACPIDriverDll.dll`，声明 `ReadEC` 与受控的 `WriteEC`：读提供风扇转速 / 功耗墙 / 键盘灯 / 充电阈值的快照；写只走 `writeEC()` 一个封装——读原值 → 写 → 立即读回 → 不符就写回原值，且只接受键盘背光与充电阈值三个白名单地址。
- `mqtt.js` 是手写的 MQTT 3.1.1 最小客户端，连本机 `GCUBridge.exe`（127.0.0.1:13688），向 `Fan/Control` 发 `OPERATING_OFFICE_MODE` / `OPERATING_GAMING_MODE` / `OPERATING_TURBO_MODE` 切换档位，订阅 `Fan/Status`、`Keyboard/Status` 等状态主题。
- `preload.js` 只通过 `contextBridge` 暴露上述接口，渲染进程无 Node 权限。
- 未安装官方控制中心时，`ec.init()` 与 MQTT 都会失败，界面自动降级为只读展示并说明原因，不崩溃、不伪造。
- `npm run dist` 直接复用 `node_modules/electron/dist` 打包（`-c.electronDist`），不再次从 GitHub 下载 Electron；网络受限时也能离线出包。`koffi` 的原生 `.node` 通过 `asarUnpack` 解包到 `app.asar.unpacked`，否则运行时加载失败。产物在 `release/`，已被 `.gitignore` 忽略。
- 页面用 `window.desktop` 判断运行环境：有该对象时走真实数据，没有时保持网页版的模拟数据。
- 自动化测试可设 `MECHREVO_TEST=1` 隐藏窗口并开 CDP 调试端口（默认 9411），配合 `node cdp-eval.cjs "<表达式>"` 在屏外取值。
- 已验证：v1.2.0 dev 版、`win-unpacked` 版与便携 exe 本体三种形态，均在 Windows 11 + RTX 3060 上以隐藏窗口启动，EC 直读 `fan1=4568 / fan2=4427`、`PL1=75`，档位双向切换实测 `quiet → PL1 35 / 节能`、`turbo → PL1 75 / 高性能`。

### 安全边界

本项目的 EC 写入范围被刻意压到最小：

1. 只通过官方 DLL 的用户态 `WriteEC` 写**单个字节**，不批量、不连续写；
2. 只接受三个白名单地址——`1932`（键盘背光 `0x80 | 档位`）、`1977`（充电上限）、`2000`（恢复阈值）。地址取自厂商自己的 `Define.ECSpec` 符号表（`ADDR_SINGLEKBL_ENABLE`、`ADDR_BATTERY_CHARGE_LIMIT_UP/DOWN`），不是猜的；
3. 每次写入都「读原值 → 写 → 立即读回」，读回与目标不符就自动写回原值并如实报告失败；
4. 重启不会保留任何自定义状态：写入只改 EC 当前值，本应用不装服务、不写启动项、不常驻。

**从不刷写 EC 固件**，不替换或修改 `UWACPIDriver.sys`，不做驱动提权。风扇曲线、RGB 分区等需要写其他寄存器或非官方协议的能力一律不实现。官方 MQTT 通道仍用于三档功耗模式切换，与官方 UI 走同一条路径，风险边界与官方控制台一致。


> 以下功能清单按**网页版**（纯前端演示）描述。桌面版在此基础上接入真实硬件，可用能力以上方「桌面版实测能力」表为准；表里没列出、本机也没有对应寄存器的能力（RGB 分区灯效、自定义风扇曲线等）会显示锁定并说明原因。

**控制台**
- CPU / GPU / 风扇 / 内存 四张指标卡，带 60 秒滚动迷你曲线
- 性能实时监控大图（CPU 负载 + GPU 负载双曲线，二次曲线平滑 + 发光）
- 安静 / 均衡 / 狂暴三档模式，切换后遥测基准同步变化
- 系统体检、一键狂暴

**性能**
- 三档性能模式 + 自定义，每档展示功耗墙与风扇策略
- 负载曲线、温度、风扇三块实时图表
- SPC 设置与应用性能配置绑定（增删应用规则）

**灯光**
- 键区预览，支持静态 / 呼吸 / 波浪 / 彩虹 / 随声五种灯效
- 亮度滑杆、分区控制，灯效实时反映在键盘预览上

**电池**
- 电量环 + 预计续航、健康度 / 循环次数 / 设计容量 / 当前容量
- 充电保护（充电上限滑杆、智能充电、低电量自动省电、校准提醒）
- 近 7 日续航柱状图，今日高亮

**显示**
- 分辨率 / 刷新率 / 缩放、HDR、护眼模式
- 色彩模式切换
- 色彩校正：RGB 三通道独立增益 + 标准色板实时预览，可一键恢复默认

**设备信息**
- 基本信息表（处理器、显卡、内存、存储、BIOS、系统版本）
- 实时监控（CPU/GPU 温度、内存占用、磁盘空间）
- 驱动状态（最新 / 可更新标记）
- 一键复制设备信息

**全局**
- 全局搜索：`Ctrl + K` 唤起，命中项金色高亮，`Enter` 跳转，`Esc` 收起
- 侧栏 8 个视图切换，悬停浮起 + 光晕
- 所有开关、滑杆、按钮都有过渡动画与 toast 反馈

## 设计语言

| 元素 | 取值 |
|---|---|
| 墨黑底 | `#070605` |
| 香槟金 | `#d4af6a` |
| 朱砂 | `#c05a45` |
| 青玉 | `#82ab8b` |
| 字体 | 标题衬线 + 正文无衬线 + 数字等宽 |

- 玻璃质感卡片 + 细金线边框
- 径向暖光背景 + 细网格纹理
- 金色渐变标题、悬停浮起与发光
- Canvas 图表 HiDPI 适配、平滑曲线、端点亮斑

## 快速开始

```bash
git clone https://github.com/bietou123/mechrevo-control.git
cd mechrevo-control
```

直接用浏览器打开 `index.html` 即可。

想用本地服务器（可选）：

```bash
python -m http.server 8080
# 访问 http://localhost:8080
```

## 文件结构

```
mechrevo-control/
├── index.html        # 页面结构与文案
├── style.css         # 全部视觉样式与动画
├── app.js            # 视图切换、搜索、图表、遥测（网页版模拟 / 桌面版真实）
├── main.js           # Electron 主进程：窗口、遥测、电源计划、亮度、刷新率、硬件 IPC
├── ec.js             # koffi 加载 ACPIDriverDll.dll（ReadEC + 白名单 WriteEC）
├── mqtt.js           # 手写 MQTT 3.1.1 最小客户端，连官方 GCUBridge
├── preload.js        # contextBridge 暴露 window.desktop 接口
├── cdp-eval.cjs      # 屏外 CDP 取值脚本（开发调试用）
├── assets/           # 应用图标
├── docs/preview/     # README 预览截图
├── LICENSE
└── README.md
```

## 快捷键

| 按键 | 作用 |
|---|---|
| `Ctrl + K` | 聚焦搜索框 |
| `Enter` | 跳转到第一个搜索结果 |
| `Esc` | 清空搜索 / 收起 |

## 技术说明

- 原生 HTML + CSS + JavaScript，无任何第三方运行时依赖
- 图表为手写 Canvas 绘制，支持 DPR ≤ 2 的高清渲染
- 遥测数据由模式基准 + 随机游走模拟生成：温度跟随负载、风扇跟随温度、功耗跟随 CPU
- 响应式：≤ 860px 切换为单列布局，≤ 520px 适配手机

## 许可

[MIT](LICENSE)

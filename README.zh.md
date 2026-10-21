# Bambulab Screen

[English](./README.md) | [简体中文](./README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Build](https://github.com/genomeic/bambulab-screen/actions/workflows/npm-build.yml/badge.svg)](https://github.com/genomeic/bambulab-screen/actions/workflows/npm-build.yml)
[![Android Build](https://github.com/genomeic/bambulab-screen/actions/workflows/android-build.yml/badge.svg)](https://github.com/genomeic/bambulab-screen/actions/workflows/android-build.yml)

拓竹 P1 系列控制屏软件 **P1Screen** 的个人深度定制版。

基于 [0x5e/bambulab-p1screen](https://github.com/0x5e/bambulab-p1screen) 开发，针对我自己的打印机车队（P1S ×2、H2D、A1，全部云连接）增加了一系列功能。

## 与上游的差异

### 耗材余量管理
- **手动录入余量** — 给任意 AMS 槽位或外挂料盘录入剩余克数，料盘上直接显示「ABS · 340g」（材质与克数上下两行）
- **打印后自动扣减** — 打印正常完成后，按云端任务记录的耗料量自动减少对应料盘的剩余量（需登录拓竹账号）。**打印失败的任务不会扣减**——失败任务的重量数据不代表真实用量
- 设置页有全局开关

### 自动续料
- 新增**自动续料**页（耗材页 → 右下角扳手菜单）：提供 AMS 自动续料开关，并可视化续料链——品牌、类型、颜色、温度完全相同的槽位自动链接（如 `A3 → A4`）

### 助手（HMS 报错）
- **清空报错**按钮 — 通过官方 `clean_print_error` 指令清空打印机的报错列表，用于清理取消打印后残留的过期报错

### 稳定性
- **MQTT 推送合并** — 打印机状态推送可达每秒几十次，UI 现在将纯数据推送按 250ms 合并渲染（打印状态变化仍然实时响应），解决了耗材页严重卡顿的问题
- **车队切换修复** — 从设备弹窗/添加/编辑页切换设备不再导致总览页丢设备
- 料盘数据内存缓存，避免每次渲染同步解析 localStorage

### 打印拦截（printGate）
- 云连接的 P1/P1S 固件 01.08 以上会拒绝未签名的打印指令。App 会提前检测并弹窗引导，而不是默默失败（历史任务重印、跳过对象等场景）

## 预览图

基础 UI（继承自上游）：

<img src="./screenshot/home-idle.png" alt="主页（空闲）" width="45%" />
<img src="./screenshot/filament.png" alt="耗材" width="45%" />
<img src="./screenshot/control.png" alt="控制" width="45%" />
<img src="./screenshot/setting.png" alt="设置" width="45%" />

## 安装

### 安卓 App（推荐）

到仓库的 **Actions** 页 → 最新一次 *Android Build* 运行 → Artifacts 下载 APK。
也可以自己构建（见下方[构建](#构建)）。

### 网页版

在与打印机同一局域网的设备上部署后端服务（主要是 MQTT 转发）：

```bash
npm install
npm run build
npm run start
```

然后在手机浏览器打开 `http://<服务器地址>:8888/`，添加全屏主屏快捷方式即可。

## 构建

```bash
# 前端
cd frontend
npm install
npm run build

# 安卓（产物：android/app/build/outputs/apk/debug/app-debug.apk）
cd ../android
./gradlew assembleDebug
```

也可以直接推送到 `main`，让 GitHub Actions 在云端打包 APK
（`Android Build` 工作流，支持手动触发）。

## 已知限制

- 云连接的 P1/P1P/P1S 固件 01.08 以上会对 MQTT 指令做**签名校验**，未签名的第三方指令会被拒绝（`err_code 84033543`）。受影响场景：开始/重印打印、跳过对象、部分 AMS 设置开关。App 已对常见场景做了检测和引导，其余需在打印机屏幕或 Bambu Handy 上操作。
- 自动扣减需要登录拓竹账号（拉取云端任务的耗料数据）。

## 致谢

- [0x5e/bambulab-p1screen](https://github.com/0x5e/bambulab-p1screen) — 基础项目，绝大部分核心 UI/UX 都是上游的作品
- [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI/) — 局域网协议文档
- [Bambu Lab](https://bambulab.com) — 打印机本身，以及足够开放的 MQTT 协议

## 许可证

[MIT](./LICENSE)

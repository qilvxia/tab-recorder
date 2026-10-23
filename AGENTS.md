# AGENTS.md — tab-recorder v2 项目上下文

> 本文件供 ZCode 在本目录打开时自动读取。v2.0 是在 v1（归档于 `legacy-v1/`）基础上按里程碑重建的版本：**保存层以「锚点直存」为唯一路径**（用户 Chrome 14x 实测 100% 正确命名），交互以「面板 + 徽章」为唯一状态面。v1 踩坑实录全部有效，是 v2 的设计约束来源。

## 项目是什么

Chrome 商店级「标签页录制器」浏览器扩展（MV3）：录制**当前标签页**的画面与声音，支持连播课程**自动按课时分节保存**，文件以课时标题命名、平铺保存在浏览器下载目录。背景：用户是路飞学城付费学员（保利威加密无法下载，见 legacy-v1/docs），采用浏览器内录制方案。

## 硬性红线

- 扩展零数据收集；权限最小化（tabCapture / offscreen / downloads / storage / scripting / activeTab，无 host 权限；activeTab 仅用户点击扩展时临时授权）
- 录制仅限用户有权观看的内容，商店描述保留"遵守网站服务条款"提示
- **保存层只走锚点通道**（offscreen 内 File + `<a download>`），禁止重新引入 downloads.download(filename) 探测/降级链——用户的 Chrome(14x) 会整体丢弃该参数（踩坑⑩），那是 v1 后期全部竞态 bug 的根源
- **不自动弹出任何窗口**（windows.create 即便 focused:false 也可能使弹窗失焦，v1.1.9-v1.1.11 面板秒关的头号嫌疑）；状态面 = 弹窗 + 徽章

## 架构（MV3 三件套）

- popup → SW `tabCapture.getMediaStreamId` → offscreen（USER_MEDIA，无时限）→ `getUserMedia({chromeMediaSource:'tab'})` → MediaRecorder
- **tabCapture 会切断标签页原声**：offscreen 里 AudioContext 回环接回扬声器
- **保存**：offscreen 停止 → `File([blob], name)` → `<a download=name>` 点击 → SW `track-anchor` 按名轮询 downloads 至 complete → 回执 → offscreen 收齐后关文档（防大文件截断）。文件平铺下载根目录，重名由 Chrome 自动加 " (n)"
- **区域裁剪**（M3）：tab 视频轨 → video → canvas（setInterval 绘制，offscreen 不可见 rAF 不运行）→ captureStream 合原音频轨。**letterbox 定律**：帧按视口宽缩放，纵横比不一致时垂直居中补黑边（offset=(videoH-viewportH×scale)/2），尺寸向下取偶
- **自动分节**（M2）：一条流上切 recorder（同流零丢帧）；三重信号去抖合并：video ended / URL 变化 / 静默
- **播放标题识别**：七级级联（mediaSession → 选择器 → 高亮目录项 → 播放中标签 → video 属性 → video 附近标题 → document.title 剥尾巴），逐级剔 UUID/长十六进制/长纯数字；**必须 allFrames 注入 + 失败重试 + detect-config 强制上报**（复录同一页面无变化也要上报）
- MP4 直录 duration=0 是 Chrome 已知行为（ffmpeg -c copy 可修）

## 已知限制与环境事实（v1 踩坑实录，v2 全部适用）

1. **Chrome 稳定版（≥M137）禁用 `--load-extension`**：自动化用 Edge 或 CfT（**本机只有 CfT 131 能跑**，139/148 秒退 code=3；装在 `.cft/chrome-win64/`）。/json/list 会混入浏览器组件扩展，必须按 manifest 名称匹配
2. **测试脚本路径一律正斜杠**——反斜杠经某些命令行层 `\t` 变 TAB（Edge 弹「清单文件丢失」）
3. **`.ps1` 必须纯 ASCII**——UTF-8 中文注释被 PowerShell 5.1 按 GBK 误读破坏语法
4. **MV3 SW 空闲约 30 秒停转**，从 CDP /json/list 消失；发现前 `PUT /json/new` 开标签页唤醒
5. **测试 profile 一次性耗材**，启动前 shutil.rmtree 重建
6. **activeTab 必须显式写进 manifest**，executeScript 才会在用户点击扩展时授予；自动化授予手段 = manifest `_execute_action` 快捷键（Ctrl+Shift+Y）+ 真实键盘事件；`action.openPopup()` 编程调用不算用户调用
7. **用户 Chrome(14x) 丢弃 downloads.download 的 filename 参数**（文件落根目录、名 blob GUID）；Edge 与 CfT 131 正常；139/148 本机无法运行未定位分界版本
8. **offscreen 没有 chrome.downloads API**；自动化环境 blob 下载易 0 字节僵死，取字节走"扩展页消费流 + CDP 回传"
9. **downloads.cancel 不删已完成下载的盘上文件**（removeFile 才删，erase 只清历史）；弃用下载要循环核验到彻底消失
10. **下载完成回执有竞态**：挂完 onChanged 监听必须补查一次当前状态（幂等）
11. **executeScript allFrames 只注入已存在的帧**：懒加载播放器 iframe 需周期性补注入（挂 keepalive 心跳约 6s，脚本首行守卫防重复）
12. **content-detect 只在页面变化时上报**：复录同一页面新 offscreen 收不到初始状态，detect-config 必须触发强制上报；快速连测时页面加载中初始注入会失败，需自动重试
13. 窗口被完全遮挡/最小化 → 画面冻结、声音正常（浏览器省电机制）；配套 legacy-v1/启动录制专用Chrome.bat（--disable-features=CalculateNativeWinOcclusion）
14. 本机网络：pypi/github 直连被重置，pip 用清华镜像，代理 127.0.0.1:7897
15. 用户信息：pip 可用（Python 3.11）、node 24 可用；ffmpeg 在 C:\Users\Admin\ffmpeg.exe；用户真实浏览器为 Chrome（14x），自动化测试用 Edge

## 当前状态（2026-10-23 · v2.0.1）

- ✅ M0：v1 归档 legacy-v1/ + git 仓库 + v2 骨架
- ✅ M1：单段录制核心（延时 + 录制 + 锚点命名保存 + 徽章 + 识别级联）——**用户 Chrome 156 验收：文件命名、单文件均通过，锚点通道在其浏览器上 100% 可靠**
- ✅ v2.0.1（捕获后移）：**预约式启动**——点开始只 ensureOffscreen + 计划（几乎无动作），倒计时归零时 offscreen 才向 SW 请求 streamId + 注入检测器 + getUserMedia 开录。动机：用户 Chrome 156.0.8078.48（自动升级的新版本）在捕获开始时指示 UI 抢激活焦点导致弹窗关闭（平台设计，无 API 可抑制；公开渠道无该回归的条目；CfT 156 本机亦无法运行——139/148/156 均 exit-3，仅 131 可跑）；捕获后移使弹窗全程稳定显示倒计时，用户可在页面上从容点播放，归零自动开录。倒计期间导航到其它源会使 activeTab 失效 → 启动失败并在面板明示，重新点开始即可
- ⏳ **待用户 Chrome 验收 v2.0.1**：点开始 → 弹窗全程显示倒计时期去播放页点播放 → 归零自动开录（弹窗此时可能关闭，属捕获指示焦点行为）→ 文件正确命名
- ⏳ M2 自动分节+命名 → M3 区域裁剪 → M4 手填文件名 + 自动停止三件
- ⏳ 上架流程未开始

## 开发与测试

```bash
python -c "import json;json.load(open('extension/manifest.json',encoding='utf-8'))"
node --check extension/*.js   # 逐个
python scripts/smoke_test.py  # Edge 冒烟
powershell -File scripts/kill_test_chrome.ps1  # 清理测试进程
```

## 文件地图

- `extension/` — v2 扩展本体（上架 zip 内容）
  - `manifest.json` MV3 清单（权限集同 v1，无 host 权限）
  - `background.js` SW：streamId 签发、检测注入（重试）、锚点落定检测、徽章
  - `offscreen.html/js` 录制引擎：取流、回环、延时、MediaRecorder、File+锚点保存
  - `content-detect.js` 按需注入（allFrames + 重试）：播放标题七级级联、播完事件
  - `popup.html/css/js` 控制面板（延时/开始/停止/状态；M2 加回模式切换）
- `scripts/` — smoke_test.py（Edge 冒烟）、kill_test_chrome.ps1、make_icons.py
- `legacy-v1/` — v1.1.11 完整归档（含降级链/状态窗/自定义目录等全部历史与文档）
- `.cft/chrome-win64/` — Chrome for Testing 131（命名/下载行为实测用）

# tab-recorder 技术设计文档（TDD）

| | |
|---|---|
| 文档版本 | 1.0（对齐参考实现 v2.8.14） |
| 日期 | 2026-11-03 |
| 读者 | 承担重写任务的 AI 编码助手（假设零上下文，本文档自包含） |
| 配套文档 | 同目录《产品需求文档（PRD）》——行为规格与验收标准 |
| 参考实现 | `E:\ZCodeProjects\tab-recorder\extension\`（v1→v2 共 50+ 版本踩坑沉淀的已验收实现；本文档所有数字与前提均摘自它） |

> **文档定位**：重写采取「行为对齐 + 参考设计」策略——PRD 的行为规格与验收标准不可妥协；本文档给出**已验证的参考设计**与**必守约束**。实现者可以更换内部组织方式（模块划分、函数命名、状态对象化），但第 2 章红线一条不可违背、第 3 章平台事实必须逐条应对、第 9/10 章的语义与「看似怪但不得不然」的设计**不得简化或删除**——它们每一项都是真实事故换来的（对应章节标注了事故实锤）。

---

## 1. 文档阅读方式（给重写者）

按顺序读，不要跳章：

1. **第 2 章红线** → 划定不可行空间（任何设计方案先过这道筛）；
2. **第 3 章平台事实** → Chrome/扩展平台的客观行为，不能靠"试一下"重新发现；
3. **第 4-7 章** → 架构与模块参考设计（可换内部结构，不可换外沿）；
4. **第 8-10 章** → 状态机、竞争语义、事故对照——**重写最容易丢的部分**，功能清单上看不出来，丢一条就是一个上线后才爆的回归；
5. **第 12-13 章** → 验收方法与实施顺序（对齐历史已验证路径，勿并发铺开）。

写作约定：代码标识符/消息名保留英文；「实锤」指参考实现中由真实用户复验或自动化诊断捕获的事故证据。

---

## 2. 硬性红线（R1-R6，不可违背，逐条带历史代价）

**R1 保存层只走锚点通道，禁止 `downloads.download(filename)`**。
offscreen 内 `File([blob], name)` + `<a download=name>` 点击 → background 按文件名轮询 `chrome.downloads.search` 做落定回执。历史代价：用户的 Chrome（14x 稳定版）会**整体丢弃** `downloads.download` 的 `filename` 参数（文件落根目录、名字是 blob GUID），v1 后期全部竞态 bug 的根源；Edge 等环境该 API 正常，极易在开发环境"测着没问题"。任何"降级链/探测链"都不许重新引入。

**R2 权限集锁定：六项，无 host 权限，零数据收集**。
`tabCapture, offscreen, downloads, storage, scripting, activeTab`。manifest 不得出现 `host_permissions`、不得加 `content_scripts` 静态声明（全部动态注入）。activeTab 仅用户点击扩展时临时授予当前页。任何联网请求、analytics、第三方运行时均禁止。

**R3 不自动弹出任何窗口**。
状态面只有弹窗+徽章。历史代价：`windows.create` 即使 `focused:false` 也可能使弹窗失焦，v1.1.9-v1.1.11「面板秒关」的头号嫌疑。

**R4 tabCapture 会切断标签页原声，必须 AudioContext 回环接回扬声器**。
offscreen 里把捕获流的音频轨接 MediaStreamSource → destination。仅视频模式（不录音频）时**回环仍要接**——用户不能因为录制而听不到课。

**R5 一条捕获流上切 recorder，节间不重新捕获**。
切节 = 停当前 recorder → 保存 → （节间等待）→ 同一条 MediaStream 上开新 recorder。禁止节间 stop 掉 tracks 再重新 `getUserMedia`：二次捕获需要重新走 streamId 签发与手势授权，存在失败与弹窗失焦风险，且必然丢帧。

**R6 offscreen 文档的生命周期与锚点回执绑定**。
最终收尾必须等全部锚点落定（或 5 分钟 deadline）才关 offscreen 文档；切节进节间的收尾**不等**锚点确认（offscreen 文档不关，下载由浏览器异步完成）——等确认会让续录晚几秒，吞掉新节开头。

---

## 3. 平台事实与陷阱清单（P1-P14，逐条：现象 → 设计对策）

| # | 平台事实（现象） | 设计对策 |
|---|---|---|
| P1 | Chrome 稳定版 ≥M137 禁用 `--load-extension`；自动化测试只能用 Edge 或 Chrome for Test（参考环境：Edge） | 测试 harness 基于 Edge（见第 12 章）；用户真实浏览器验收是最终门槛 |
| P2 | MV3 Service Worker 空闲约 30 秒停转（CDP 目标消失） | 录制期间 offscreen 每 2 秒发 `keepalive` 心跳顶住 SW；SW 收到任何消息即唤醒 |
| P3 | `activeTab` 必须显式写入 manifest 且**真实用户手势**才授予；`action.openPopup()` 编程调用不算用户调用 | 自动化授予用 `_execute_action` 快捷键（Ctrl+Shift+Y）+ 真实键盘事件；产品交互全部经弹窗（R3 的另一面） |
| P4 | `executeScript` 的 `allFrames` 必须放在 `target` 里（顶层放法 MV3 参数校验直接报错）；Promise 形式返回 **InjectionResult[]**（解构成单对象=后续 `.filter` 崩）；失败的帧静默缺席；懒加载 iframe 只注入**已存在**的帧 | 注入封装统一形态 `{target:{tabId, allFrames:true}}`；结果按 `frameId` 对齐不按索引；keepalive 周期补注入（约 6 秒）覆盖后出现的 iframe |
| P5 | `chrome.storage.session` 默认**不对 content script 开放**（untrusted 上下文），Promise 直接 reject | 默认策略：content script 不直接读 session，一切会话态查询走 SW 消息；SW 启动时若开放需 `setAccessLevel({accessLevel:"TRUSTED_AND_UNTRUSTED_CONTEXTS"})`。铁律：**任何 Promise 链的 catch 不得静默吞掉主流程**（实锤：冷却查询被吞 → 点击分支永不执行 → 连播全灭） |
| P6 | 内容脚本只在「值变化」时上报会丢初始状态：复录同一页面，新 offscreen 收不到任何数据 | `detect-config` 消息必须触发强制上报（forceReport）；playing=true 期间**每轮心跳上报**（见第 10 章对照表 #7） |
| P7 | tabCapture 的 getUserMedia **无视宽高约束**（`{ideal}` 对象与数字直填都被忽略）；窗口化（非最大化）录制时帧取**整屏逻辑尺寸**且内容**非等比拉伸**填满（实测：150% 缩放 3360×2100 屏 → 帧 2240×1400，横向缩放 1.5365 vs 纵向 1.559）；最大化时帧≈视口、等比 | 裁剪映射做**双模型自适应**：横纵比例偏差 ≥1% → 拉伸模型（横纵独立换算）；<1% → 黑边模型（等比+垂直居中补黑边）。帧尺寸以 `videoWidth` 为真值。残余偏移场景（YouTube 窗口化）按 PRD 已知限制放弃 |
| P8 | tabCapture 启动即切断标签页原声 | R4 回环。另：窗口被完全遮挡/最小化时画面冻结、声音正常（浏览器省电机制 CalculateNativeWinOcclusion）——产品文档需告知用户保持窗口可见 |
| P9 | Chrome 直录 MP4 的 `duration=0`（已知行为） | 不在扩展内修；需要时长时外部 ffmpeg `-c copy` 修复 |
| P10 | 下载重名时 Chrome 自动加 " (n)" 后缀 | 锚点轮询匹配放宽：`base === name || base.startsWith(name + " (")` |
| P11 | `downloads.cancel` 不删已完成下载的盘上文件（`removeFile` 才删）；「停止不保存」只允许丢**当前未保存**的缓冲段，已落盘历史节永不触碰 | 丢弃路径只 finalize 前拦截；不引入 removeFile |
| P12 | 站点可能有 console.clear 反调试，控制台日志不可靠 | 诊断信息一律走扩展消息通道（advanceLog/识别诊断剪贴板 JSON），不依赖 console |
| P13 | 页面 may use `javascript:` 伪协议链接、Vue 委托事件（元素非 a/button）、播放器自定义事件（人工 dispatchEvent 的 ended，此时 `video.ended` 属性仍 false） | 点击用完整鼠标事件序列（pointerdown→mousedown→mouseup→click，bubbles）；播完判定用**事件标志**而非属性快照（与信号源同源，见第 10 章 #6） |
| P14 | iframe 的 location.href 常为 about:blank（预创建组件容器），混入 URL 信号会与顶层地址交替覆盖 → 周期性碎切（YouTube 实锤 ~12.5s 一个碎片） | url/playing/入口/视口信号**只认顶层帧**（`window.top === window`）；offscreen 对 about:blank 二次防御忽略 |

---

## 4. 架构总览

四组件 + 两个按需注入的内容脚本，全部消息经 background 中转：

```
┌────────────┐  start/stop/pause/resume/status   ┌──────────────────┐
│  popup     │ ────────────────────────────────► │  background (SW) │
│  (弹窗面板) │ ◄──────────────────────────────── │  消息路由/注入/   │
└────────────┘        status 回执(1s 轮询)          │  锚点轮询/徽章    │
                                                   └───┬────────┬─────┘
                       offscreen-schedule / offscreen-* │        │ tabs.onUpdated(url)
                       request-capture / anchor-landed  │        ▼
                              ▼                         │  ┌──────────────┐
                   ┌────────────────────┐               │  │content-detect│←─(allFrames 动态注入
                   │  offscreen 文档    │               │  │(每帧一份实例) │   + token 守卫 + keepalive
                   │  USER_MEDIA        │               ▼  └──────┬───────┘
                   │  getUserMedia(tab) │        content-report / │ 700ms 轮询上报
                   │  MediaRecorder     │ ───────────────────────►│ lesson/url/playing/
                   │  裁剪 canvas 管线  │      try-advance 广播    │ advanceEntry/advanceExit
                   │  AudioContext 回环 │                          ▼
                   └────────────────────┘                   ┌──────────────┐
                          │ File+<a download>                │content-crop  │
                          ▼                                  │(框选浮层,按需)│
                   浏览器下载 → downloads.search 轮询回执 ─────┴──────────────┘
```

- **popup**：唯一交互面。组装启动 payload（含 capture/viewport 观测数字）、轮询状态渲染、设置持久化。
- **background（SW）**：无业务状态的状态路由器——签发 streamId、注入检测脚本、锚点落定轮询、徽章、tab 事件监听。
- **offscreen**：录制引擎（状态机+信号裁决+保存）。业务大脑。
- **content-detect**：页面信号采集（课时名/URL/播放/弹窗入口）+ 连播点击执行。每帧一份实例，顶层帧限定强信号。
- **content-crop**：框选浮层（Shadow DOM），仅在用户点「框选区域」时注入。

启动链：popup `start` → SW 写 session + `offscreen-schedule`（预约式，此刻不取流）→ 倒计时归零 offscreen 发 `request-capture` → SW `tabCapture.getMediaStreamId({targetTabId})` + 注入 detector → offscreen `getUserMedia({chromeMediaSource:'tab', streamId})` → beginCapture → startSegment。

---

## 5. 模块设计（参考设计）

### 5.1 manifest.json

- `manifest_version: 3`；`minimum_chrome_version: "116"`；`background: {service_worker}`（非 module）。
- `permissions`：六项（R2）。`commands`: `_execute_action` Ctrl+Shift+Y（自动化授予 activeTab 用，P3）。
- `action.default_popup`；图标 16/48/128。无 content_scripts / host_permissions。

### 5.2 popup

UI 结构（id 即契约，重写可换名但交互语义不变）：

| 区 | 元素 | 要点 |
|---|---|---|
| 待机区 | 模式按钮对（单段/自动分节）；课程名输入；自动连播勾选（默认开）；URL 模式勾选（默认关）；单段文件名输入；内容三选胶囊（音视频/仅视频/仅音频）；高级折叠区（码率 4/帧率 30/音频 128）；裁剪行（框选/清除/状态）；定时停止胶囊（不限/自定义 HH:MM:SS）；收工秒数（0-600，默认 60，0=关）；延时 0-60（默认 0）；格式摘要；开始按钮；**识别诊断按钮** | 浏览器内建页（chrome:// 等）拒绝开始/框选/诊断 |
| 录制区 | 课时名+识别来源、节序、四格统计（节数/总时长/总大小/本节时长）、暂停继续、停止保存、停止不保存（二次确认 3s）、收工状态独立行、诊断提示行、底部上次结果 | 全部状态字段见 6.2 status 回执 |

- 设置持久化：`chrome.storage.local` 单键 `settings` merge 保存；`presetTime` 存原样字符串，启动时严格校验（`HH:MM:SS`，分秒 ≤59，非法拒绝启动）。
- 课程名按站点：`courseNameByHost[hostname(剥 www.)]`，恢复当前站点上次值，无记录预填域名本身。
- payload 组装：`executeScript` 读目标页 `{w,h}` = `innerWidth×dpr`（capture 约束尝试）与 css 视口 `{w,h}`（裁剪映射基准），读取失败不阻断。
- 识别诊断：executeScript allFrames 两轮（间隔 2s）currentTime 双采样，按 frameId 对齐（P4），输出 JSON 进剪贴板。

### 5.3 background（SW）

- **消息路由**：见第 6 章协议字典。`content-report` 必须校验 `sender.tab.id === 录制 tab`（放行扩展自身页面——测试页直载场景），防历史注入页串扰。
- **detector 注入链（token 机制）**：session 维护 `detectorInstanceId`（扩展重载→session 清空→新 id；SW 空闲重启→session 保留→同 id）。注入前先跑清理 func（allFrames）：`window.__tabRecDetTok !== tok` → `delete window.__tabRecDetector` + 写新 token（清死实例守卫）；token 一致 → 幂等跳过。然后 files 注入 `content-detect.js`（重试 3 次×700ms），成功后发 `detect-config {lessonSelector:'h1', lessonPrefix:'', autoNext}`。**效果：扩展重载后页面无需刷新**。
- **补注入时机**：keepalive 每 3 次（≈6s）+ `tabs.onUpdated` URL 变化即刻（跳转后重注入从 6s 压到即刻）。
- **锚点轮询** `trackAnchor(name)`：700ms `downloads.search({filenameRegex})`，上限 5 分钟；匹配放宽（P10）；complete/interrupted → `anchor-landed {ok, name}`。
- **徽章**：offscreen 驱动（经 `badge` 消息，仅变化时发送）：倒计时数字 / `‖` / `REC` / `II` / `···` / 清空；底色 `#e5484d`。
- **事件**：`tabs.onUpdated`（录制 tab 的 url → `offscreen-url` + 补注入）；`tabs.onRemoved`（录制 tab 关闭 → `offscreen-tab-closed`）；`recording-finished`（写 lastSummary、清 session 录制键、清徽章、`offscreen.closeDocument()`）。
- **重入守卫**：session.recording 为真时拒绝二次 start（防 status 轮询失败误显空闲时双开录制）。

### 5.4 offscreen（录制引擎）

状态机、SEG 常量、信号体系、收工分档、保存链、裁剪数学：见第 8 章（状态机）与下文小节。

**SEG 常量表**（全部为对齐值，不得擅改）：

| 常量 | 值 | 用途 |
|---|---|---|
| debounceMs | 1500 | 切节信号去抖排队 |
| silenceSec | 5000 | 停播静默判定 / 单段 ended 锁存窗 |
| urlStableMs | 3000 | URL 变化稳定期（进度参数永不稳定→不切） |
| urlInstantMinMs | 500 | URL 模式即刻切分最小等待（滤同帧抖动） |
| silenceGapMs | 30000 | 两次停播切节最小间隔 |
| minSplitGapMs | 10000 | 全局最小切节间隔（启动静默期 = 初值 now() 实现开录 10s 内不切） |
| lessonStableMs | 2000 | 课时名同源变化稳定期 |
| entryStableMs | 3000 | 连播入口持续可见确认期 |
| betweenTimeoutMs | 30000 | 节间超时自动续录 |
| takeoverStableMs | 2000 | 降级识别源接管稳定期 |
| stretchEpsilon | 0.01 | 裁剪拉伸模型判定阈值（≥1%） |
| advanceFallbackMs | 45000 | 连播兜底广播间隔 |
| finishDeadlineMs | 300000 | 锚点落定上限 5 分钟 |
| idleDiscardBytes | 2×1024² | 切节/停录的内容硬前提（小段丢弃阈值） |
| minLessonSplitBytes | 4×1024² | 课时名切节前提（约 8 秒内容） |

主循环 tick 500ms 依序跑：`presetTimeCheck → singleEndedCheck → idleWrapCheck → stoppedPlayingCheck → entryVisibleCheck → checkPendingSplits`（挂起结算/节间恢复）→ 兜底广播检查。

**保存链（R1/R6）**：`finalizeSegment` → Blob→`File([blob], name)`→`URL.createObjectURL`→`<a download=name>` 点击 → `pendingAnchors` 记账 + 发 `track-anchor`；`anchor-landed` 回执销账 + revoke URL。`pendingFinalize` 计数防 maybeFinish 抢跑。收尾：节间去向不等锚点；最终去向等 `pendingAnchors` 空或超 deadline → `recording-finished{mode, segments, last}` + 销毁管线（裁剪/AudioContext/停流）。

**命名 `buildSegName`**：
- sanitize：去 `\ / : * ? " < > |` 与控制符、RTL 覆盖符（U+202A-202E）、折叠空白、去尾点/空格、截 120、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加 `_` 前缀。
- 剥课时前缀 `^正在播放[:：]\s*`；junk 判定（空/UUID/十六进制≥20/纯数字≥10/杂音词表——与 content-detect 的过滤同表同语义，PRD F3）。
- 单段：手填 > 识别标题（非 junk）> `录制_YYYYMMDD-HHMMSS`。
- 分节：课程前缀（截 40）非空 → `前缀_两位节序-课时名或第N节`；空 → `两位节序-课时名`。

**裁剪 `buildCropStream`（P7）**：基准视口 = payload.viewport（开录时刻）否则框选快照，双无效回退帧自身（scale=1）。`sxScale=vw/vp.w, syScale=vh/vp.h`；`|syScale/sxScale−1| ≥ 0.01` → 拉伸模型（横纵独立换算），否则黑边模型（`scale=sxScale`，`letterbox=max(0,(vh−vp.h×scale)/2)` 垂直居中）。宽高向下取偶；<16px 抛错降级全画面（cropError 面板可见）。canvas `setInterval(draw, max(1000/fps, 8ms))` 绘制（offscreen 无 rAF，P4 同因），`captureStream(fps)` 视频轨 + 原音频轨合成。getUserMedia 宽高约束：legacy mandatory 数字直填，抛错删约束降级重试（P7：反正多半被无视）。makeRecorder 按 recordKind 过滤轨道（回环不受影响，R4）。

### 5.5 content-detect

- 700ms 轮询。上报字段：`{lesson, lessonSrc, lessonAlt, url, ended, playing, viewport}`；独立变化沿消息 `advanceEntry`（入口不可见→可见）/ `advanceExit`（可见→不可见）。`url/playing/入口/视口` 仅顶层帧（P14）。
- 上报触发：`forceReport || 视口变化 || playing 翻转 || lesson/alt/url 变化`；**playing 期间每轮心跳上报**（第 10 章 #7）。
- 课时名级联（六级 SRC_RANK）+ 备选通道 lessonAlt（主源非 active-item 时总是并行采集）——识别与过滤规则见 PRD F3；ACTIVE_SELS 13 项**逐个查询**（不合并——逗号合并按文档序返回，弱标记会抢跑，B 站实锤）：`[aria-current="true" i]`、`[aria-current="page" i]`、`li[class*="active" i] a`、`a[class*="active" i]`、`li[class*="current" i] a`、`a[class*="current" i]`、`li[class~="on"] a`、`[class*="playing" i]:not(video)`、`dd[class*="active" i]`、`[class~="active" i]`、`[class*="active" i]`、`[selected]:not(option)`、`[aria-selected="true" i]:not(option)`。命中项过滤：可见、不在 nav/header/footer、不在播放器控件容器（class 含 ctrl/control/menu 或 role=menu）、容器型跳过（含 ≥2 个可见 li/a/dd 子条目）、title 类子元素优先、整项文本兜底剥时长。
- 连播点击 `attemptAdvance` 守卫链：① `anyPlaying()` 真 → 不点；② 纯暂停守卫（帧内有 video、全部 `paused && !ended`、`!endedArmed`、`playingSeen`）→ 跳过（30s 节流日志）；③ 帧内冷却 15s；④ 跨帧冷却经 `advance-cooldown` 消息查 SW（**查询同步抛 = 旧实例死透 → 清全部定时器彻底放弃，不降级点击**防跳课；查询 reject 才降级直接点击）。点击三方式依序：文本词表 → class 启发式 → 高亮项下一项；`activateEl` 完整鼠标事件序列（P13）。九轮定时 `[2,4,6,8,12,16,20,25,30]s`，playing 事件取消全部。
- 生命周期：video 绑定 ended（armed）/playing（disarm+取消连播定时）事件（P13：事件标志非属性快照）；`ctxDead()`（扩展重载）→ 停轮询、清定时器、`delete window.__tabRecDetector`（让补注入重建）。诊断暴露 `window.__tabRecDiag = {playing, lesson, anyPlaying, at}` 每轮更新。

---

## 6. 消息协议字典

### 6.1 popup → SW

| 消息 | 字段 | 语义 |
|---|---|---|
| `start` | payload{mode, courseFolder, fileName, presetSeconds, startDelaySeconds, tabUrl, crop?, capture?{w,h}, viewport?{w,h}} | 预约式启动（不取流）；重入守卫 |
| `stop` / `stop-discard` / `pause` / `resume` | — | 转发 offscreen |
| `status` | — | offscreen 存活 → `offscreen-status`+advanceLog；否则 idle+lastSummary |
| `select-crop-region` | — | 注入 content-crop |

### 6.2 SW ↔ offscreen

| 消息 | 方向 | 字段/语义 |
|---|---|---|
| `offscreen-schedule` | SW→off | settings 全量 + payload + tabId；进入 countdown |
| `request-capture` | off→SW | 倒计时归零；回 streamId；SW 同时注入 detector + 清残留裁剪浮层 |
| `offscreen-stop` / `offscreen-stop-discard` / `offscreen-pause` / `offscreen-resume` | SW→off | 停止保存 / 丢弃当前段 / 暂停 / 继续 |
| `offscreen-status` | SW→off | 回执见下 |
| `offscreen-content` | SW→off | content-report 数据转发 |
| `offscreen-url` | SW→off | tabs.onUpdated 的 URL（SW 侧兜底源） |
| `offscreen-advance-clicked` | SW→off | 连播点击成功（确定性切分点） |
| `offscreen-tab-closed` | SW→off | 录制 tab 关闭 → stopAll("tab-closed") |
| `anchor-landed` | SW→off | {ok, name} 销账；stopping 态触发 maybeFinish |
| `broadcast-advance` | off→SW | 播完/切段 → 向录制 tab 全帧广播 try-advance |
| `track-anchor` / `badge` / `keepalive` | off→SW | 锚点记账 / 徽章（变化时）/ 2s 心跳 |

`offscreen-status` 回执结构（面板渲染的数据源，也是诊断观测面）：
`{state, mode, mime, ext, countdown, lesson:{name,src}, seq, segMs, totalMs, bytes, segCount, lastSplit:{reason,at}, signals:{hasPlayed, playingAgo}, crop, cropError, captureSize, curViewport, viewportDrift, urlLog(末2条), error, dbg:{currentLessonSrc, pendingLesson, pendingLowerRank, prevHighRank, hasPlayedEver, endedReportedEver, endedSeen, wrapStatus}}`

### 6.3 content → SW（→ off）

| 消息 | 语义 |
|---|---|
| `content-report` | 快照 {lesson, lessonSrc, lessonAlt, url, ended, playing, viewport}；ended=true 时 SW 另向全帧广播 try-advance |
| `advanceEntry` / `advanceExit` | 入口可见性变化沿（独立消息，快照不携带——防 forceReport 把常驻入口误当新弹窗） |
| `advance-clicked` | 点击成功（同步回报早于导航） |
| `advance-result` | 连播尝试结果（面板直显，留 5 条） |
| `advance-cooldown` | 点击冷却查询（SW 查 session 回 {ok, ts}） |
| `crop-region-selected` | 框选结果 {rect, viewportW, viewportH}，绑 sender.tab.id |

---

## 7. 存储设计

**storage.local**（键 `settings`，merge 保存）：`format:"mp4"`、`videoBitrate:4000000`、`frameRate:30`、`audioBitrate:128000`、`startDelaySeconds:0`、`autoNext:true`、`segUrlMode:false`、`silenceWrapSeconds:60`、`recordKind:"av"`、`lessonSelector:"h1"`、`lessonPrefix:"^正在播放[:：]\\s*"`（以上为默认值表）；UI 记忆键：`uiMode`、`courseNameByHost{}`、`lastFileName`、`presetMode`、`presetTime`（原样字符串）。

**storage.session**（会话级 9 键）：`recording`、`tabId`、`mode`、`startedAt`、`detectorInstanceId`、`cropRegion{rect,viewportW,viewportH,tabId,at}`、`lastAdvanceClick`（点击冷却）、`advanceLog`（≤5 条）、`lastSummary`。注意 P5：session 默认不对 content script 开放。

---

## 8. 状态机与关键时序

### 8.1 状态机（offscreen）

`state ∈ { idle, countdown, recording, between, paused, stopping }`

| 转移 | 触发 |
|---|---|
| idle→countdown | offscreen-schedule（延时 >0 时 200ms interval 等归零） |
| countdown→recording | requestCapture 成功（失败回 idle + recording-finished{error}） |
| countdown→idle | 预约期取消（summary {cancelled:true}） |
| recording→paused | 手动暂停（同时解 URL 刹车） |
| paused→recording | 继续（必要时补开新段） |
| recording→stopping | stopAll(reason)；reason ∈ manual / discard / video-stopped / video-ended / preset / idle-wrap / advance-pause / stream-ended / tab-closed（自动类写入 lastSplitInfo 面板可见） |
| stopping→between | 切节收尾（pauseAfterStop；不等锚点，R6） |
| between→recording | resumeCapture（五路恢复源，见 8.2） |
| stopping→idle | 锚点齐/超 deadline → recording-finished |
| between→idle | between 态停止（正常收尾，已录节全保留） |

`hasPlayed`（本段开始后播过，between 重置——恢复后重新收敛）与 `hasPlayedEver`（整场播过，黑白名单分档依据）双标志并存，**不可合并**。

### 8.2 between 五路恢复源（先到先得）

① `offscreen-advance-clicked`（between 态立即续录）；② `advanceExit`（弹窗消失反沿，含手动点掉）；③ playing 心跳恢复；④ pendingUrl 稳定 3s（URL 稳定兜底）；⑤ betweenStartAt 起 30s 超时。`resumeCapture`：清 currentLesson（等新节识别补写段名）、清 pendingEntryAt、`resumeTs=now()`、startSegment。

### 8.3 五种切节信号与生效前提（全部语义判定，逐条前提不可省）

| 信号 | 触发 | 生效前提（不满足时的行为） |
|---|---|---|
| lesson-change | pendingLesson 同源稳定 2s | 段 <4MB → 只改名不切（且 `p===currentLesson` 才写，防过时值覆盖接管结果）；URL 联动确认（segStartAt 后 URL 变过才认真换课）；URL 未变但段名与识别值不一致 → 只改名不切 |
| url-change | URL 指纹变化（剥进度参数+hash） | 稳定 3s 路径：识别到位（currentLesson && cur.name）+ 课时名否决（智能模式：段开始时的课时名与现值相同 → 否决）；即刻切路径（URL 模式）：≥500ms + 全局闸 + 本段播过（lastPlayingTs > segStartAt）+ 段 ≥2MB；**URL 刹车**：指纹变化瞬间 recorder.pause()，旧节尾部零污染 |
| advance-pause | 停播 ≥5s | 本段播过（lastPlayingTs > segStartAt——重注入延迟期不启用）+ 距上次停播切 ≥30s；单段模式 → stopAll("video-stopped") |
| entry-visible | 弹窗入口变化沿挂起 3s | 前提 `endedSeen || !endedReportedEver`（盲区豁免：从不会报 ended 的站点跳过前提；会报的站点要求先见过 ended——暂停时控制栏按钮不算播完；作废后 ended 3s 内迟到可重臂）；段 ≥2MB（不足保留挂起不清零） |
| advance-clicked | 连播点击成功 | between → 立即续录；stopping → 置续录标志；recording：段 ≥2MB **且本段播过**（暂停态点击链是自持循环燃料，第 10 章 #5） |

公共尾 `finishSegmentForAdvance`：占全局闸（lastSplitAt=now）→ lastSplitInfo → 清 pendingEntryAt → autoNext 开则立即广播连播 → stopAll(reason, 去向 between)。

### 8.4 收工与自动停止（idleWrapCheck 黑白名单，v2.8.14 定稿）

```
silenceWrapSeconds ≤ 0 / 非 recording → wrapStatus = null（面板无显示）
hasPlayedEver = true（白名单/信号可见）:
    lastPlayingTs ≥ resumeTs → blocked「页面在播」（浮层预览小窗不算：anyPlaying 主视频化）
    否则倒计时 wrapSec − (now − resumeTs) → 归零 stopAll("idle-wrap")
hasPlayedEver = false（黑名单/盲区站）:
    恒 blocked「信号盲区：播放/暂停不可检测，请手动停止（可改用定时停止）」
    ——时间型收工整段退役，任何固定窗口都会误杀（第 10 章 #2，v2.8.9 数学论证）
```

### 8.5 典型时序（路飞式连播，全流程）

```
开录 → 识别收敛(课时名补写) → 播放中(心跳) → 课播完
 → 弹窗浮现 3s(entry-visible) → 停录保存旧节 → between
 → 广播连播 → 弹窗被点(advance-clicked) → 立即续录(新节开头零丢失)
 → 新节识别补写段名 → …… 循环 …… → 课程放完(同样弹窗/点击无效)
 → 节间 30s 超时恢复 → 盲区站：永不停，面板提示手停；可见站：收工倒计时到点停
```

---

## 9. 竞争与防回归语义（重写最易丢失，逐条给「为什么」）

1. **课时名来源竞争**（applyLessonReport）：同名上报忽略（高阶心跳同值反复上报不得清掉低阶接管的计时——v2.7.0 拉锯 bug 实锤）；降级 → 挂起 pendingLowerRank，稳定 2s 且高阶值未变 → 接管命名+源切换；升级 → 仅当与现有段名**互不包含才不改写**（高 rank 不代表粒度细：B 站 mediasession=合集总标题 vs 分集名互不包含）；接管记 prevHighRank，**高阶源的恒值心跳不得周期夺回**（恒值回归防护）。
2. **挂起不清除、执行点清除**：全局闸未到 → 信号挂起重试（丢弃=下一节内容并入上一节文件，实锤）；pendingLesson 在 doSplit 执行点清而非排队点（去抖窗内被 stopAll/pause 打断时挂起保留，下轮 tick 重排）。
3. **变化沿+心跳双轨上报**：持续播放期间如果只靠变化沿，lastPlayingTs 冻结在开播时刻，5s 停播闸在开播 5s 后恒真 → 每约 30s 误切一段（实锤）。playing=true 期间每轮心跳。
4. **入口信号独立沿 + 首轮建基线**：注入时常驻可见入口不算「新出现」（防 forceReport 全量上报误触发）；入口消失反沿也是信号（弹窗被手动点掉 → between 立即续录）。
5. **全局闸挂起重试 + 内容硬前提双保险**：时间闸（10s）防碎切风暴；内容闸（≥2MB）防识别期/抖动期小段；两者都过才有资格切。
6. **切分点确定性**：advance-clicked 是唯一「点击瞬间停录」的信号——其余信号都有稳定期，页面快慢赛跑会造成旧节尾部吸进新节开头。

---

## 10. 「看似怪但不得不然」对照表（每项=真实事故，重写不得"简化"掉）

| # | 设计 | 看似怪之处 | 不这样做的实锤事故 |
|---|---|---|---|
| 1 | 锚点直存（R1） | 绕开 downloads API，"多此一举" | 用户 Chrome 14x 丢弃 filename 参数；v1 全部竞态 bug 根源 |
| 2 | 盲区站收工整段退役 | "设了收工却永不自动停" | 盲区站「下一节正常播放」与「暂停/卡死」在其可见信号上**数学不可区分**；且切节链路必然把计时基准刷新到活动时间戳之后，"无活动满 N 秒"护栏对切节成功**结构性恒死**——v2.8.4~v2.8.12 每个窗口版本都在切下一节后误杀正常播放（用户复验实锤：切节后倒计时出现、≈设定秒数停止） |
| 3 | URL 指纹剥进度参数 | "URL 变了就是换内容" | YouTube 播放中每 ~10s 更新 `&t=` → 10s 碎片（实锤 20 节/3.5 分钟） |
| 4 | URL/播放/入口/视口只认顶层帧 | "iframe 里的地址也算" | about:blank 空 iframe 与顶层地址交替覆盖 → 周期性碎切（实锤 ~12.5s） |
| 5 | advance-clicked 本段播过前提 | "点击成功就该切" | 暂停页控制栏「下一集」按钮常驻可见 → 切段→广播→冷却期满又点→又切段，16s/个自持循环（B 站实锤 advance-clicked×7）；YouTube 45s 兜底重启=47s 周期 |
| 6 | 播完判定用事件标志（endedArmed）不用属性快照 | "读 video.ended 就行" | 人工 dispatchEvent(ended) 时属性仍 false → 守卫误杀测试页连播（实锤后修正：守卫判定必须与信号源同源） |
| 7 | playing 心跳（持播每轮上报） | "变化沿上报就够" | lastPlayingTs 冻结在开播时刻 → 每约 30s 误切一段（实锤 3 分钟 8 段） |
| 8 | 入口信号不含 close 词、要求 endedSeen（可豁免） | "弹窗类元素都算" | 暂停时控制栏按钮可见 → 暂停碎片循环（B 站 15s/YouTube 47s 实锤）；豁免开关按「本场是否曾报过 ended」自动分档（endedReportedEver） |
| 9 | detect-config 强制上报 | "注入了就会上报" | content script 只报变化沿 → 复录同一页面新会话收不到任何状态（识别/连播全灭） |
| 10 | 连播广播初值=开录时刻（开录不广播） | "开录就广播一次无妨" | 开录首轮广播的九轮定时器把刚出现的弹窗抢在 3s 稳定期前点掉 → 跳课（实锤） |
| 11 | between 收尾不等锚点确认 | "保存确认了再继续" | 等确认让续录晚几秒，吞新节开头（v2.3.3 每节丢开头 5s 实锤） |
| 12 | 冷却查询同步抛=彻底放弃不降级点击 | "查询失败就绕过冷却直接点" | 旧死实例的定时器还在跑，绕过冷却会真跳课；storage.session 默认对 content script reject（实锤连播全灭） |
| 13 | 主动补注入（token 清死守卫） | "守卫防重复注入就好" | 扩展重载后旧实例守卫残留，新注入被静默挡掉 → 识别+连播全链死亡且永不自愈（用户连报 9 版的根因） |
| 14 | 裁剪双模型（拉伸/黑边自适应） | "帧=视口等比+黑边一条公式" | Chrome 窗口化帧取整屏逻辑尺寸且非等比拉伸（1.5% 变形）→ 单模型必然错位（数字实锤见 P7） |

---

## 11. 内部瑕疵清单（重写时**不必复刻**，属参考实现的已知债务）

1. `offscreen-audible` 消息为历史空协议：仅应答无逻辑，且 case 出现两次（第二处不可达）——直接不实现。
2. offscreen 模块级散落状态变量（15+ 个 let）可对象化收敛（历史 Q1 债务；重写时建议按「会话级/段级/竞争级」分组对象化，但**语义与重置时机必须逐一对齐**第 9 章与 resetContestState 的清单一一对应——漏重置是事故高发模式）。
3. 个别长函数（idleWrapCheck/onUrlChange/attemptAdvance 之外的识别与切节主函数偏长）可拆；拆分时不得改变信号前提的求值顺序与挂起语义。
4. 裁剪映射数学与判定可抽纯函数便于单测。
5. v2.8.14 已清理的项（重写自然不会带入）：everBetween 死标志、idleWrapCheck 过期重复注释块。

---

## 12. 测试与验收策略

### 12.1 harness 概念（可从参考仓库 `scripts/` 直接移植）

- **环境**：Edge（P1）+ `--remote-debugging-port` + 一次性 profile（每次 shutil.rmtree 重建）+ 真实扩展加载；跑前必须清残留测试浏览器进程（按 cmdline 特征杀，不误伤日常浏览器——残留进程会持续干扰焦点链路）。
- **焦点授予**：activeTab 经真实键盘事件触发 `_execute_action` 快捷键；授予后必须 executeScript 真实验证（popup 检测成功≠已授予目标 tab，历史间歇失败根因）。
- **测试页**（extension/ 内，上架包排除）：`e2e-test.html`+`e2e-page.js`——三节循环（30s 有声视频+播完弹窗+委托按钮+节内 15s hash 探针模拟进度参数）；锚点变体 `#blind`（视频恒暂停+噪声 canvas 保码率+8s 弹窗+点击不续播=盲区站形态）、`#blind2`（双源多课：h1 恒定+active 列表项延迟 8s 改名+SPA 无 URL 变化）、`#blind3`（点击无效不关弹窗=连播挂）。
- 采样走 CDP：每 2s 读 offscreen-status（state/segCount/lastSplit/dbg）+ 页面探针 + downloads 列表，输出时间线人工判定。

### 12.2 判定基线（对齐参考实现，重写后必须复现）

| 变体 | 判定 |
|---|---|
| 默认分节 | 三节三文件、命名与节号一致、切节原因合理、hash 探针零切段 |
| --blind（wrap=20s） | **零 idle-wrap**、录满采样窗不截断、面板盲区提示在显（黑白名单回归测试） |
| --blind2（wrap=40s） | 三段全名（1.1/1.2/1.3）、竞争链正常、零误杀 |
| --blind3（wrap=90s） | 不自动收工、盲区提示在显（手停语义） |
| --single / --preset | 播完 5s 自动停（video-stopped/video-ended 双通道）、手填名生效、定时停按时长 |
| B 站暂停诊断（wrap=60s） | 零碎片、守卫日志「暂停中跳过连播点击」、收工 = 节间超时恢复点 + 60s **单倍**精确（参考基线 96.2s = 36.1 + 60） |
| 冒烟 | 扩展加载零异常、关键 DOM 存在、offscreen 文档创建/关闭链路通 |
| 裁剪诊断 | 中心 50% 选区四参照线误差 ≤2px |

### 12.3 用户真实 Chrome 验收（最终门槛，PRD A8）

路飞整门课连录零干预+命名正确；路飞暂停/放完手停且连录切节后永不自动停；B 站多 P 分节命名（分集名非合集标题）；B 站/YouTube 暂停 ≈95s 收工；设置记忆跨面板重开保持。诊断手段：面板「识别诊断」剪贴板 JSON（不依赖 console，P12）。

---

## 13. 建议实施顺序（对齐历史已验证路径，串行推进）

| 里程碑 | 内容 | 验收门槛（对应 PRD） |
|---|---|---|
| M0 单段核心 | 面板+取流+录制+锚点保存+暂停继续+停止不保存 | 手填名文件正确落盘；回环有声（R4） |
| M1 捕获后移+自动停 | 预约式启动/延时倒计时+停播/ended 双通道+定时停止 | A5 |
| M2 分节架构 | 节间停止-恢复（R5/R6）+识别命名（级联+竞争语义第 9 章）+切节信号与前提 | A1（自动化测试页三节） |
| M3 区域裁剪 | 框选浮层+双模型映射+降级链 | A6 |
| M4 连播+盲区语义 | 入口三方式+冷却+兜底广播+黑白名单收工（第 8.4 节原样实现） | A1-A4 |
| M5 防回归+上架 | 第 10 章对照表逐条自查+诊断按钮+设置记忆+打包排除清单 | A7+A8（用户 Chrome 实录） |

**警告**：跳过 M2 的信号前提直接做 M4 连播，会精确复现历史上的暂停碎片自持循环（第 10 章 #5）与命名卡死；盲区语义（8.4）必须与 M4 同批落地，任何"固定窗口收工"都会在切下一节后误杀正常播放（#2）。

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
12. **content-detect 只在页面变化时上报**：复录同一页面新 offscreen 收不到初始状态，detect-config 必须触发强制上报；快速连测时页面加载中初始注入会失败，需自动重试。**例外（v2.3.2）：playing=true 期间每轮心跳上报**——offscreen 停播判定依赖 lastPlayingTs 持续刷新，变化沿上报会使其冻结在开播时刻（每约 30s 误切一段的根因）
13. 窗口被完全遮挡/最小化 → 画面冻结、声音正常（浏览器省电机制）；配套 legacy-v1/启动录制专用Chrome.bat（--disable-features=CalculateNativeWinOcclusion）
14. 本机网络：pypi/github 直连被重置，pip 用清华镜像，代理 127.0.0.1:7897
15. 用户信息：pip 可用（Python 3.11）、node 24 可用；ffmpeg 在 C:\Users\Admin\ffmpeg.exe；用户真实浏览器为 Chrome（14x），自动化测试用 Edge

## 当前状态（2026-10-25 · v2.3.2）

- ✅ M0/M1/M2：v1 归档 + 单段核心（**Chrome 156 验收通过**）+ 捕获后移（弹窗倒计时稳定，验收过）+ 自动分节平铺命名（**验收通过**）
- ✅ v2.2.0：自动连播（文本按钮+列表下一项，仅分节模式）——初版引入切节风暴暴露（非其过错，见 v2.2.1）
- ✅ v2.2.1（信号层修复第一轮）：URL 切节稳定期 3 秒 + 同课时名不切 + 静默间隔 30s + ended 强信号直切——**用户复验切节风暴依旧**，排除 URL 信号为唯一根因
- ✅ v2.2.2（第二轮：可见化 + 全面收紧 + 委托点击）：① **切节原因可见化**——lastSplitInfo{reason,at} 上面板（「上次切节：xxx HH:MM:SS」），用户复验直接读原因，免开 F12；② 全局最小切节间隔 10s（requestSplit/doSplit 双闸，风暴信号被丢弃并打日志；同源多重信号丢弃无害）；③ lesson-change 加 2 秒稳定期（弹窗期识别源抖动嫌疑）；④ 静默切节后 15s 冷却（期间 audible=true 不重新武装，防抖动绕过 30s 间隔）；⑤ **连播扫描扩展到全部可见叶子元素**（原只扫 a/button/[role]/[onclick]，事件委托的 div/span 入口扫不到——「放弃评价观看下一节」大概率属此类），click() 冒泡触发委托
- ⏳ **待用户 Chrome 验收 v2.2.2**：①面板「上次切节」显示的原因（无论是否修好都要反馈，一击定位）②弹窗 2-8s 内被点掉 ③无碎片段
- ✅ v2.2.3（连播跨帧广播 + 结果面板化）：用户反馈①切节原因样本（lesson-change 开录几秒/silence-gap 弹窗后/url-change 弹窗后——按用户指示本轮不碰切节）②**站点有 console.clear 反调试**（控制台日志不可靠）③弹窗仍未关闭。连播失效根因=架构级：ended 在播放器帧（可能 iframe），弹窗入口在顶层文档，互不可见。修复：**SW 收到 ended 上报后向该 tab 所有帧广播 try-advance**（各帧各自找入口点击，顶层/iframe 双保险）；连播尝试结果上报 session.advanceLog（绕过 console.clear）并在**面板显示**（已点击/未找到入口/未启用 三态直达结论）
- ✅ v2.2.4（连播触发源改造）：切段原因驱动——播完/静默切段时广播连播指令（不再依赖加密播放器的 ended 事件）——**用户实测连播生效，弹窗自动关闭进下一节**
- ✅ v2.2.5（切节风暴收尾，采纳用户"语义判定优于时间滤波"方案）：① **课时名信号语义化**——SRC_RANK 来源优先级（媒体元数据6/选择器5/目录高亮4/播放中标签3/视频属性2/页面标题1）：未知→首次识别、来源升级=识别收敛（只补/改段名不切）；来源降级=忽略（弹窗期元数据被清不误切）；**同源值变化=真换课**（走 2s 稳定期）；② 全局 10s 闸改为**挂起重试**（原丢弃会导致连播后整节录进上一节文件）；③ 节间黑屏小段丢弃：播完/静默切段后首个 URL 稳定切段，若当前段 <2MB → 清缓冲丢弃（recorder 不断流、段号不跳、cur.name 保留旧值让课时名信号自然切段）；④ popup 移除测试显示（切节原因/连播日志行）
- ✅ v2.2.6（两坏消息修复）：① 开录 4s 碎片段——点播放使播放器给 URL 加参数，而"同课时名不切"闸在段名未识别时失效；修：**URL 稳定切段加 currentLesson 非空前置**（未识别时 URL 变化一律不切，识别到位后段名自然补写）；② 连播卡弹窗——`javascript:` 伪协议 href 的 `<a>` 走 location.href 分支等于没点；修：**activateEl 统一点击策略**（http(s) 链接强制同页跳转含 _blank 防断录制；javascript:/空/非 a 一律 el.click() 冒泡）
- ✅ v2.2.8（用户提供弹窗 DOM 实锤 + 多方式并存原则）：**入口实锤 = `<p class="next-section">放弃评价观看下一节 »</p>`（Vue 组件，非 a 非 button）**。① **activateEl 完整鼠标事件序列**（pointerdown→mousedown→mouseup→click 全 bubbles，覆盖 click/mousedown/pointerdown 型监听；http(s) 链接仍同页跳转）——原 el.click() 的 click 包含在序列中（增强非替换）；② **class 启发式入口**新增（[class*=next/skip/close/continue] 可见元素）与文本词表、列表下一项**三种方式并存**（通用扩展原则：多方式叠加不替换）；③ 切节闸补漏：URL 切段前置扩展 `!currentLesson || !cur.name`；lesson-change 加 **URL 联动确认**（segStartAt 基准，本段开始后 URL 变过才是真换课，纯名字变化不切）；doSplit 后 currentLessonSrc=""（mediasession 残留不挡下一节识别）；④ 切节原因恢复面板显示（诊断 4s 碎片段用途）
- ✅ v2.2.8：弹窗 DOM 实锤（入口=`<p class="next-section">` Vue 元素）→ **activateEl 完整鼠标事件序列**（pointerdown→mousedown→mouseup→click，覆盖多事件型监听）+ **class 启发式入口**（next/skip/close/continue）与文本词表、列表下一项**三方式并存**（用户原则：通用扩展多方式叠加不替换）+ 切节闸补漏（URL 前置扩展段名未定不切 / lesson URL 联动 / 切段后识别重置）——**用户实测：连播功能实现（6 节连续自动录制）**
- ✅ v2.2.9（4s 碎片段收尾，面板实锤 lesson-change）：**lesson 切节加实质内容前提**——当前段 <4MB（约 8 秒内容）时课时名变化**只改名**（小段并入后续内容），段有实质内容才切。覆盖：开录识别收敛/连播丢弃清缓冲后改名（不产生碎片段）/正常换课中途（段已录数分钟正常切）/极短课时 <8s 并入下一节（可接受）
- ✅ v2.2.9：lesson 切节实质内容前提（段 <4MB 只改名）——**未根治**，4s 碎片段仍在且连播转好转坏随机
- ✅ v2.2.10：启动静默期恢复 + doSplit 段内容硬前提（<2MB 不切不分流）——**用户复验：碎片段消失 ✓，连播仍失败**（3 分钟视频 90MB，内容前提不可能误杀——静默切段/广播正常，断点在点击层或信号缺失）
- ✅ v2.2.11（连播触发源体系重建，端到端诊断 diag_e2e.py 驱动）：① **停播静默替代 audible**——content-detect 轮询上报 playing 状态，offscreen 端"曾播过 + 停播 ≥5s"才静默切节（tab.audible 在部分 Chrome tabCapture 下不可靠，弃用；音频 Analyser 方案测的是音源非扬声器输出，作废）；② **连播定时兜底**——分节模式每 45s 广播一次连播指令（跨域 iframe 播放器的 ended/playing 信号全部缺失时，弹窗类入口最迟 1 分钟被点掉）；③ e2e 验证：点击层 PASS（javascript: 伪协议+委托按钮点击成功）、切段+落盘 PASS（video-ended 驱动）、上游 ended→广播 PASS
- ✅ v2.2.12（连播点击冷却）：连播广播到达多帧（顶层/iframe）+ 九轮尝试在页面跳转完成前重复执行 → 「下一节」被点两次跳课。修：**点击冷却 15s 跨帧共享**（session.lastAdvanceClick + 帧内快速路径），冷却过期后下一节播完可正常再次连播——**e2e 验证：两节各点一次不跳课**
- ✅ v2.2.13（连播点击冷却失效根因）：**chrome.storage.session 默认不对 content script 开放**（untrusted 上下文）——v2.2.12 把冷却检查（storage.session.get）放进 content script，Promise 必 reject 被 catch 吞 → 点击分支永不执行 → 连播死（v2.2.11 无此调用故连播成功，版本差异吻合）。修：① SW 启动时 `setAccessLevel({accessLevel:"TRUSTED_AND_UNTRUSTED_CONTEXTS"})`；② attemptAdvance 的冷却检查失败**降级直接点击**（doClick 提取）。**教训：content script 里用 chrome.storage.session 前必须 setAccessLevel，且任何 Promise 链的 catch 不得静默吞掉主流程**
- ✅ v2.2.13：连播点击冷却失效根因（storage.session 默认不对 content script 开放）——修后用户实测：**连播工作，弹窗自动关闭顺序播下一节**；但偶发"两节合并一个文件"
- ✅ v2.2.14（两节合并根因）：连播跳转后页面重载、detector 等 6s 心跳才重注入 → 窗口内 playing 未上报 → 停播静默的 fired 锁不被播放信号重置 → 下一节播完不切；兜底 URL 切节被"课时名未变"闸拦 → 合并。修：① doSplit 后 silenceSplitFired=false（切段即重新武装，30s 间隔防碎切）；② 停播静默启用收紧 `lastPlayingTs > segStartAt`（重注入延迟期不启用，交 URL 兜底）；③ **tabs.onUpdated URL 变化时立即补注入 detector**（重注入从 6s 压到跳转即刻）；④ 删"课时名未变"闸（URL 稳定 3s 已滤抖动，detector 缺失时 URL 切节兜底）
- ✅ v2.3.0（**节间停止-恢复架构**，用户提议）：停播 5s 确认 → **停止 recorder 并保存当前节**（黑屏期不录，废段问题从设计上消失）→ tabCapture 流与回环**保持活跃**，state="between" → 连播广播点弹窗 → 恢复触发（**播放恢复 playing 或 URL 稳定**，双源）→ **同流开新 recorder 续录**（零丢帧、无二次捕获风险、无 activeTab 失效风险、seq 与识别延续）。e2e 端到端验证：三节循环三文件、between/续录/点击全部工作。e2e 文件命名时序错位为测试页 h1 更新时序特性（真实站点 h1 与当前节同步）。弹出期 badge="‖"、面板「等待下一节」
- ✅ v2.3.1（分片假 ended 根因修复）：路飞播放器**分片播放**——每个媒体分片结束都触发 video ended → 「ended 立即停录保存」把一节课切成 8 段（每分片一段，弹窗未现连播点击"未找到入口"）。修：**ended 挂起，停播 5 秒统一切节**——分片假 ended 后视频 5 秒内恢复播放 → lastPlayingTs 刷新计数重置不切；真播完持续无播放 ≥5s → 停录保存+广播点击弹窗。**时长守卫方案作废**（用户正确指出录制时长 vs 总时长受开录时点/网络/暂停干扰）。video-ended 不再作为切节信号（正常）
- ⏳ ~~待用户 Chrome 验收 v2.3.1~~ → **用户复验：一个视频仍被分成 N 段**
- ✅ v2.3.2（**N 段真正根因：playing 上报是变化沿触发，停播判定必然误切**）：content-detect 轮询只在值变化时上报 → 持续播放期间 playing 恒 true **永不雪再上报** → offscreen lastPlayingTs 冻结在开播时刻 → stoppedPlayingCheck 的 5s 闸在开播 5s 后每轮 tick 都满足 → 唯一刷新源是 keepalive 补注入的 forceReport（约 6s 一次）但 6s > 5s 必先误切 → 30s 静默间隔把节奏定为**每约 30 秒误切一段**（3 分钟 ≈ 8 段，与历次复验吻合）。v2.3.1 挂起 ended 后该路径成唯一活跃切段源故"N 段依旧"；e2e 未抓到是因测试页每节仅 8s + `lastPlayingTs > segStartAt` 严格大于恰好挡住节内首查。修：① **playing=true 心跳**——700ms 轮询在播期间每轮上报（5s 闸获 7 倍安全余量；录制期 SW 本被 keepalive 顶活跃，消息量无碍）；② stoppedPlayingCheck 补 `lastSplitInfo={reason:"advance-pause"}`（此前 stopAll 路径不更新面板「上次切节」，真因不可见）；③ 停播切段即广播连播（此前依赖 content ended 事件转发，跨域 iframe 缺失时只剩 45s 兜底）；④ 死代码清理：lastSplitWasIdle（恒 false）及其派生分支（黑屏小段丢弃——between 架构下弹窗期已不录，场景消失）、SEG.silenceCooldownMs（从未使用）
- ⏳ **待用户 Chrome 验收 v2.3.2**：路飞站分节连播录 3 节以上——每节一个文件、无周期性碎段、弹窗点掉、序号连续命名正确；若仍有异常，面板「上次切节」现在能如实显示 advance-pause（一击定位）
- ⏳ M3 区域裁剪 → M4 手填文件名 + 自动停止三件
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

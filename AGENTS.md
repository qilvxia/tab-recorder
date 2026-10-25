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

## 当前状态（2026-10-26 · v2.4.9）

- ✅ M0/M1/M2/M3：v1 归档 + 单段核心（**Chrome 156 验收通过**）+ 捕获后移（弹窗倒计时稳定，验收过）+ 自动分节平铺命名（**验收通过**）+ **区域裁剪迁移（v1 方案照搬，diag_crop 实测 PASS）**
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
- ⏳ ~~待用户 Chrome 验收 v2.3.2~~ → **用户复验三个新证据**：①仍 N 段且「上次切节」**全是 url-change**；②一节末尾几十秒+下一节合并成一个文件；③该文件命名为下一节
- ✅ v2.3.3（三根因修复）：**主根因=路飞站（保利威）播放器的 playing/ended 信号对 content script 不可见（playing 从未上报 → hasPlayed 恒 false → 停播判定整条死路径——v2.3.2 的心跳修复在真实站点从未启用过，e2e 修复成立但真实站点不适用）+ 站点 URL 播放中周期变化（分片/token/进度参数）**。① **URL 切节「课时名未变否决」**：startSegment 快照 segLessonAtStart，URL 稳定切段前 `!segLessonAtStart || currentLesson === segLessonAtStart` → 否决（同课参数/杂音变化；段开始未识别、段内才识别出=识别收敛同样否决）——v2.2.14 删"课时名未变闸"释放了 url-change 周期切段（N 段从 v2.3.0 验收出现的时序完全吻合），现以语义化版本恢复；真换课由 lesson-change 通道（2s 稳定+URL 联动）承担，识别延迟由 onUpdated 立即补注入覆盖；② **修 isSourceUpgrade 误判**：`!!currentLessonSrc && rank > curRank`——切段后 src 清空，空源参与升级判定使下一次上报必误判升级并改写已有段名（合并段命名成下一节的根因）；空源=首次/重识别，只补空名；③ **入口可见型播完停录**（信号缺失站点的播完主通道）：content-detect class 启发式（next/skip/continue 可见元素，close 不进此信号）**变化沿事件化**上报 advanceEntry（独立消息，快照 report 不携带——防 forceReport 全量上报把常驻入口误当弹窗；首轮建基线，注入时常驻可见入口不算新出现，重注入重建基线）→ offscreen 挂起 pendingEntryAt，稳定 3s + 段 ≥2MB → finishSegmentForAdvance("entry-visible") 停录进 between；播放中浮现的贴片「跳过」类误报由 playing 心跳作废挂起；④ **between 30s 超时自动恢复**（入口误报无跳转/加载过慢兜底）；⑤ 面板「播放信号：✓/✗」显示（复验一击定位信号可达性）。三种播完信号并存：停播 5s（playing 型）/入口可见（entry 型）/45s 定时兜底。e2e 探针升级：弹窗按钮补 class="next-section"（对齐路飞 DOM）+ 节内每 15s 变 hash（模拟分片参数）——验证：hash 探针零切段、url-change 切段消失、三文件命名与节号一致（上一轮的时序错位命名消失=isSourceUpgrade 修复直接证据）
- ⏳ ~~待用户 Chrome 验收 v2.3.3~~ → **用户验收通过：分节自动播放、录制、每小节一文件全部实现**；新缺陷：除第一小节外每小节丢失开头约 5s
- ✅ v2.3.4（开头 5s 丢失修复——between 恢复时机提前）：路飞站 playing 信号不可见 → between 恢复只能靠「URL 稳定 3s」→ 连播点击（t0）后新节视频 t0+2~4s 自动开播，URL 稳定在 t0+4~6s 才续录 → 开头 2~5s 已播未录（第一小节不丢：开录时录制先于用户点播放）。修（恢复源多方式并存，先到先得）：① **连播点击成功即续录（主）**——doClick 成功处发 `advance-clicked`（同步回报早于导航）→ SW 转发 `offscreen-advance-clicked` → offscreen between 态 resumeCapture；续录从点击瞬间起，新节零丢失，开头多 1~3s 加载画面（内容完整优先）；resume 后段名空由识别补写，lesson-change 的 <4MB 只改名逻辑保证识别期不产生碎段；② **弹窗入口消失反沿即续录（辅）**——entry 可见性 true→false 发 advanceExit（走 content-report 转发），覆盖手动点掉弹窗场景；控制栏按钮淡出类误报后果=提前恢复录旧页静止至跳转，无害。URL 稳定 3s 与 30s 超时兜底保留。e2e（信号可达路径）：三文件大小 7.3/8.3/7.2MB 接近理论值（±8%）量化验证零丢失；点击后 playing 心跳把 entry 挂起正确作废（信号可达站点 playing 优先、entry 只在信号缺失站点承担）；节内 hash 探针零切段、命名与节号一致维持
- ⏳ ~~待用户 Chrome 复验 v2.3.4~~ → **用户反馈：有时候后一节前几秒录到前一节**（问"两节中间暂停+sleep 能否解决"）
- ✅ v2.3.5（点击=确定性切分点）：污染路径有二——①弹窗停录有 3s 稳定期，但连播点击（播完 ended 广播的 2s 轮）更快，点击→跳转→新节开播若抢在停录前，旧节尾部吸进新节开头；②entry 沿丢失/被 playing 作废时退回连续录，lesson-change（2s 稳定+1.5s 去抖）切得更晚，污染 2~4s。"有时候"=页面快慢决定赛跑结果。用户"暂停+sleep"思路方向对（切节点要停录）但不用 sleep（时长不可定）——改用**确定性语义事件**：① **advance-clicked 录制态到达 → 置 resumeAfterBetween + finishSegmentForAdvance("advance-clicked") 立即停录保存旧节（此刻新节未开播，尾部干净）→ maybeFinish 进 between 时立即 resumeCapture（新段亚秒级起，涵盖导航+新节全程）**；② advanceExit（弹窗消失）录制态且 pendingEntryAt 挂起中 → 同样处理（覆盖手动点掉弹窗；pendingEntryAt 前提防控制栏淡出误报）；③ **maybeFinish 的 between 路径跳过锚点下载确认**（offscreen 不关文档，下载浏览器异步完成，确认只对最终收尾必要——否则停录到续录间秒级空窗照样吞新节开头），最终收尾仍等确认；④ finishSegmentForAdvance/resumeCapture 清 pendingEntryAt（残留挂起会在续录后被 entryVisibleCheck 立即误停录）。e2e：切节原因序列变 advance-clicked×2+advance-pause×1（lesson-change 切段消失=污染消除直接证据）；点击/停录/保存/续录 2s 内完成；第 1 节文件比上轮小 0.9MB（=被消除的尾部污染）；三文件 6.4/8.2/8.3MB（第 2/3 节含导航过渡，内容完整）
- ⏳ ~~待用户 Chrome 复验 v2.3.5~~ → **用户验收通过：路飞学城连续录制效果实现（分节/连播/命名全部满意）**
- ✅ v2.4.0（**M3 区域裁剪迁移完成**，用户决策：全按推荐、照搬 v1 已验收实现）：① content-crop.js 原样拷入（Shadow DOM 框选浮层：拖拽/比例锁定 自由与16:9与4:3与1:1/双击确认/Esc 取消/最小 40×30/防重复注入）；② SW 三接线：select-crop-region（注入浮层）/crop-region-selected（session 存 cropRegion 绑 tabId）/request-capture 里兜底 crop-selector-cancel 拆残留浮层（v2 真取流时刻，对齐 v1 start 时拆的意图）；③ offscreen：buildCropStream（tab 视频轨→video→canvas setInterval 绘制→captureStream 合原音频轨；letterbox 定律：帧按视口宽缩放、垂直居中补黑边、尺寸向下取偶、<16px 抛错）+ makeRecorder 改录 recStream + beginCapture 失败降级全画面（cropError 面板提示）+ destroyExtra 加 destroyCropPipe + status 返回 crop/cropError；④ popup：裁剪行（框选/清除/状态标签）+ getCropRegion（tabId 绑定校验，换 tab 失效）+ payload.crop 三字段 + tips 显示裁剪状态；⑤ 选区持久化沿用 session+tabId（连播跳转 tabId 不变，天然兼容 between 架构——canvas 管线跨切段复用不重建）。裁剪单段/分节两模式通用。验证：diag_crop 实测 PASS（中心 50% 选区四参照线误差 0.6px ≤2px 判据；顺手移植 diag_e2e 的健壮版焦点授予，旧版 3 轮 assert 在前台被占时必败）；smoke PASS；e2e 回归无 crop 时零变化（切节原因/文件大小与 v2.3.5 基线一致）。已知限制（沿用 v1）：选区固定视口坐标，窗口 resize/缩放/换屏后漂移，需重新框选
- ⏳ ~~待用户 Chrome 验收 v2.4.0~~ → **M3 裁剪验收待反馈；用户报 B 站多 P 新场景：6 首歌合并一个文件**
- ✅ ~~v2.4.1（视频时长变化=内容更换信号）~~ **方案作废回滚**（用户正确指出：两首歌时长完全一致并不罕见——时长是概率信号非确定性语义，等长视频必漏切；只按 URL 切又会让路飞 N 段回归）
- ✅ v2.4.1 重做（**面板「分节方式」选项**，用户方案——站点差异由用户标注）：① **回滚**时长信号全部代码（content-detect mainVideoDuration/videoDur 上报、offscreen 三变量与 content-change 分支），回到 v2.4.0 切节逻辑；② popup courseRow 新增勾选「URL 变化即切节（B 站多 P 等同页换集站点用）」→ settings.segUrlMode（默认 false）；③ offscreen 的 URL「课时名未变否决」闸按模式生效——segUrlMode 为真时跳过否决（URL 稳定 3s + 段 ≥2MB + 全局闸即切），其余全部信号（lesson-change/advance-pause/entry/点击切分架构）两模式共用，**选项只放开 URL 闸不替换任何信号**（叠加不替换）。默认不勾 = v2.4.0 行为（路飞零变化）。B 站多 P 时序：勾选 → 切 P URL p=N 变化稳定 3s → 立即切段（doSplit 连续录，节尾部可能含下一首开头几秒——该站无弹窗无法提前停录，接受）。验证：残留检查零命中、e2e 回归零变化、smoke PASS
- ⏳ ~~待用户 Chrome 复验 v2.4.1 重做~~ → **用户先测路飞（未勾选 URL 模式）：识别失效（文件名「01-第1节」）+ 连播失效（弹窗不关）+ 课程名 placeholder 显示不全**
- ✅ v2.4.2（**detector 死守卫加固**——重载扩展后免刷新）：先验证 v2.4.1 重做回滚完整性：content-detect.js 与 v2.4.0 **零 diff**、offscreen.js 唯一差异是 segUrlMode 闸（不勾选等价）——代码层面路飞零变化、e2e 全绿，排除代码回归。用户两个症状（识别失效+连播失效）同源=content-detect 全链路死亡。根因：**扩展重载后页面未刷新**——旧 detector 已随扩展失效（runtime 死），但页面 window 的 `__tabRecDetector` 守卫残留 → 新注入被首行守卫静默挡掉，死实例占坑。v1 起就有此守卫，测试环境每次新页面未暴露；**上架场景致命**（扩展更新后用户页面不会自动刷新）。修：**实例 token 机制**——SW 经 chrome.storage.session 维护 detectorInstanceId（重载 session 清空→新 id；SW 空闲重启 session 保留→同 id 不误判），injectDetector 改两步注入：① executeScript(func) 检查各帧 `window.__tabRecDetTok`，与当前实例 id 不一致 → delete 守卫 + 写新 token；② 正常 files 注入（守卫已清则重建实例；token 一致=存活则幂等跳过）。**重载扩展后无需刷新页面**，下次 keepalive/开录注入自动重建。content-detect.js 不改（func/files 同 ISOLATED world 共享 window 自定义属性）。顺带：课程名 placeholder 按用户要求简化为「留空 = 自动命名」（原文案超出 popup 宽度显示不全）。验证：语法/smoke/e2e 回归零变化
- ⏳ ~~待用户 Chrome 复验 v2.4.2~~ → **用户 grilling 验收：①路飞分节理想不动 ②B 站 URL 模式可分节，瑕疵=文件名「第N节」未带集名 + 后一节前几秒录进前一节 ③M3 裁剪验收通过（附 B 站分集列表 DOM 实锤：.video-pod__item.active > .title-txt）**
- ✅ v2.4.3（B 站命名诊断驱动修复 + URL 模式即刻切分，用户决策全按推荐）：**diag_bili.py 新诊断**（CfT 打开 B 站多 P 页面，页面上下文采样级联各源）事实：①**active-item 级联在 B 站页面能命中**——`[class*="active" i]` 首个命中即 .video-pod__item.active（"01. 爱江山更爱美人 05:20"，可见、不在 nav），选择器顺序无问题；②mediaSession 空、docTitle/h1 恒为视频总标题（不随 P 变化）→「第N节」现象的前提是当时 detector 全链路未上报——**B 站页面同样死于死守卫**（v2.4.2 已修；URL 模式切段走 SW tabs.onUpdated 不依赖 content-detect，故"分节成功但命名失败"自洽）；③列表项整项 innerText 带尾部时长（"01. xxx 05:20"）——文件名会带时长尾巴，真代码问题。修：① **pickActiveListItem：命中项优先内部 [class*=title] 子元素**（.title-txt 纯集名），整项文本兜底并剥尾部时长（mm:ss / h:mm:ss）——diag_bili 复测确认输出「01. 爱江山更爱美人」；② **segUrlMode 即刻切分**：URL 变化不等 3s 稳定期（SPA 切换快，稳定期内新内容开播吸进旧节尾部=B 站污染几秒的根因）——节流前提（距上次切节 ≥10s + recording + 段 ≥2MB）满足 → resumeAfterBetween + finishSegmentForAdvance("url-change")（旧节尾部截止 URL 变化瞬间干净，新内容加载期起完整续录零丢失）；未到节流间隔退回稳定期路径；③ **finishSegmentForAdvance 补 lastSplitAt=now()**（停录切段计入全局 10s 闸——语义修正，此前 stopAll 路径不占闸）。文件名保留集序号（「05. 仕和遙」自然排序）。验证：diag_bili 复测 title-child 路径命中纯集名、语法/smoke PASS、e2e 回归零变化（默认模式即刻切分支不触发）
- ⏳ ~~待用户 Chrome 复验 v2.4.3~~ → **用户 grilling 反馈：B 站分节基本合格（个别尾部污染，记录不深究）；准备测 YouTube——附播放列表 DOM 实锤（ytd-playlist-panel-video-renderer[selected] > span#video-title，aria-label 带时长尾巴）**
- ✅ v2.4.4（**标题识别通用化**——不逐站适配，补通用信号覆盖面）：① ACTIVE_SEL 追加 `[selected]` / `[aria-selected="true" i]`（YouTube 播放列表与 ARIA 组件库的通用"当前项"标记，与 class/aria-current 类叠加并存）；② 标题子元素提取扩 `[id*='title' i]`（YouTube span#video-title 命中；B 站 .title-txt 走 class 路径不变）；③ 现有通用源在 YouTube 的自然覆盖无需改码：mediaSession（rank 6 最高，若播放器设置则自动纯标题）+ doc-title（「歌名 - YouTube」随视频变，pickDocTitle 分割已取歌名）；多源竞争语义正确（mediasession 优先、doc-title 在其存在时降级忽略不误切）。**YouTube 使用指引**：勾选「URL 变化即切节」+ 开站点自带连播（切视频=URL v 参数变化，与 B 站同模式）；**连播点击层维持中文词表不加英文**——英文大站自带连播，我们再点会双推进跳课，attemptAdvance 播放中前置+15s 冷却已尽量规避。**diag_bili.py 增强**：URL 参数化（域名匹配）+ 代理支持（--proxy-server）——CfT 131 无法渲染 2026 年的 YouTube（docTitle 只有壳、面板不渲染），诊断环境硬限制，YouTube 适配靠用户真实 Chrome 复验；B 站采样不受影响。验证：语法/smoke PASS、e2e 回归零变化
- ⏳ ~~待用户 Chrome 复验 v2.4.4~~ → **用户反馈：①重载扩展后 B 站页面 Uncaught Error: "Extension context invalidated"（截图：content-detect.js:135 chrome.storage.session.get 同步抛）；②URL 模式勾选文案不易懂**
- ✅ v2.4.5（**旧实例停摆加固** + 文案重写）：报错根因——扩展重载后旧检测脚本的**定时器还在跑**（连播九轮尝试的 setTimeout），attemptAdvance 里 `chrome.storage.session.get(...)` 在调用本身**同步抛**（`then().catch()` 只兜 Promise 链内部错误，兜不住同步抛错）→ 冒成 Uncaught。v2.4.2 守卫加固解决了"新注入被挡"，旧实例定时器仍存活报错。修：① **attemptAdvance 的 storage get 包 try/catch**——同步抛错（上下文失效）时清空全部连播定时器并 return（**彻底停摆而非降级**：旧实例仍能操作页面 DOM，降级点击会真的跳课；新实例已由守卫 token 重建接管）；Promise 内失败（session 未开放）维持原降级 doClick 语义；② 700ms 轮询入口加上下文存活自检（chrome.runtime.getURL try/catch）——失效即 clearInterval 自停；③ 文案：URL 模式勾选改为「网址一变就切下一节（B 站多 P 等同页换集的网站勾选；不勾 = 按页面课时名智能切节）」。验证：语法/smoke PASS、e2e 回归零变化
- ⏳ ~~待用户 Chrome 复验 v2.4.5~~ → **用户测 YouTube（勾选 URL 模式）：全是 ~10s 碎片视频**（面板证据：识别正常=媒体元数据已出歌名、20 节/3.5 分钟、切节原因全 url-change）
- ✅ v2.4.6（**URL 指纹规范化**——进度参数剥除，修 YouTube 10s 碎片）：根因——**YouTube 播放中每 ~10s history.replaceState 更新 `&t=` 进度参数**，勾选的「网址一变就切」把每次进度更新当换集信号，10s 全局节流与 t 更新周期同频，每次恰好过闸 → 10s 碎片。B 站 p（换集才变）与 YouTube t（持续变）的 URL 变化模式不同，「网址一变就切」须先剥进度再比较。修（URL 信号单点收口）：**urlFingerprint** = 剥进度类参数（t/t2/time/start/progress/at/ts/timestamp）+ hash 后的 origin+pathname+search；onUrlChange 指纹未变 → 只更新 lastUrl 不进切节挂起；指纹变 → 正常挂起（即刻切/稳定期）。schedule 初始化 lastUrlFp。副作用修正：t 类变化不再污染 lastUrlChangeAt——lesson-change 的 URL 联动判定更准。各场景：YouTube URL 模式 t 忽略/v 即刻切 ✓、智能模式 mediasession→lesson-change ✓（面板已证识别正常）、B 站 p 保留不变 ✓、e2e hash 探针被剥 ✓。node 单测四场景全过（t 变同指纹/v 变异指纹/p 变异指纹/hash 变同指纹）。验证：语法/smoke PASS、e2e 回归零变化
- ⏳ ~~待用户 Chrome 复验 v2.4.6~~ → **用户复验：YouTube 仍 ~10s 一个视频**——指纹剥除基于「&t= 记进度」的既有认知（2023-2024），真实变化模式与假设不符
- ✅ v2.4.7（**URL 变化观测面**——拿真实 URL 流定位，停止盲猜参数名）：① offscreen `urlLog`（最近 5 条）：onUrlChange **每次调用**（含被指纹忽略的）记录 `{u: 原样URL截断120字符, changed: 指纹是否判定为内容变化, at}`；status 返回最近 2 条；schedule 清空；② popup 录制中 tips 显示「最近网址变化：<URL>（内容标识变化 | 仅进度参数）」——changed 标志直接回答指纹判定认不认为它是换内容：显示「内容标识变化」却仍同视频 → 剥除名单缺参数（URL 样本到手即补）；显示「仅进度参数」却仍被切 → 切节路径另有其人（结合「上次切节」定位）。验证：语法/smoke PASS、e2e 回归零变化
- ⏳ ~~待用户复验 v2.4.7（观测轮）~~ → **用户面板截图实锤：「最近网址变化：about:blank（内容标识变化）」+ 已保存 4 节/总时长 00:50（~12.5s 周期）+ 播放信号 ✗（between 窗口采样）+ 识别标题（未知来源）**
- ✅ v2.4.8（**URL 信号只认顶层帧**——观测面定位的真根因，修 YouTube 周期性碎切）：观测数据实锤——检测脚本注入**所有帧**，每帧上报自己的 location.href；**YouTube 页面存在 src=about:blank 的空 iframe**（预创建组件容器，常见），与顶层地址**交替覆盖** offscreen 的 lastUrl/指纹——每次交替（顶层 watch?v=X ↔ iframe about:blank）都判为"内容标识变化" → 切节挂起 → 即刻切 → 周期性碎切。**这同时解释 v2.4.6 剥 t 参数无效：真正变化源是多帧 URL 交替，不是 t**。辅助证据自洽：「播放信号 ✗」= 即刻切循环的 between 窗口恰被采样到（hasPlayed 重置态）；「未知来源」= url-change 切段清空识别源的显示残留（值仍是切段前 mediasession 歌名）。修（语义收窄：只有顶层页面的地址构成切节信号）：① **content-detect 轮询 url 改 `window.top === window ? location.href : ""`**——iframe 帧不上报 url（lesson/playing/course 照报，它们的切节语义与 iframe 地址无关）；② offscreen onUrlChange 防御忽略 about:blank（SW tabs.onUpdated 路径兜底）；③ popup「识别标题（未知来源）」显示修正：src 空时不显示来源括号。各场景：YouTube about:blank iframe 不再上报 → 同视频零切节、v 变化即切 ✓；B 站/路飞切集换课都是顶层导航，iframe url 本就无关 → 行为不变；e2e 单页无 iframe 零影响。验证：语法/smoke PASS、e2e 回归零变化
- ⏳ ~~待用户 Chrome 复验 v2.4.8~~ → **用户反馈：YouTube 裁剪有偏移（路飞/B 站正确）。grilling 澄清：无全屏、普通布局、形态=内容缩放错位（内容被放大/缩小且位置不对）**
- ✅ v2.4.9（**捕获帧/视口观测面**——缩放错位用数字定位，不改变任何行为）：三站共用同一套映射数学（diag_crop 验收），偏移根源=scale 两端之一失真（候选：YouTube 站点缩放记忆/多屏 DPI/捕获帧与视口关系异常），数字当前不可见。① content-detect 顶层帧上报实时视口 `{w: innerWidth, h: innerHeight, dpr}`（变化沿 + forceReport 携带，与 url 同顶层判定）；② offscreen：cropOut 扩展 `{w,h,vw,vh,scale,letterbox,viewportW,viewportH}`（映射参数入面板）、beginCapture 读视频轨 getSettings 存 captureSize（无裁剪也可见）、curViewport 落地 + **viewportDrift 检测**（当前视口 ≠ 框选快照 → 面板警告「建议重新框选」，仅提示不阻断——v2.4.0 决策暂缓的漂移检测，YouTube 场景令其变成实际需求）；③ popup 录制中显示「捕获帧 W×H，当前视口 W×H·dpr N」+ 漂移警告。**判读表**（复验对照）：帧宽/视口宽≈dpr → 定律成立；≠dpr 且偏差固定 → 捕获缩放异常；快照≠当前视口 → 框选后基准变了；帧高−视口高×scale → 黑边量对照偏移方向。**对照实验**：Ctrl+0 重置缩放重录、确认同显示器（多屏 DPI）、框参照物看偏移方向。验证：语法/smoke PASS、e2e 回归零变化
- ⏳ **待用户复验 v2.4.9（观测轮）**：YouTube 重录后展开面板——「捕获帧/当前视口」数字行 + 漂移警告是否出现 + 判读表对照；顺带 Ctrl+0 重置缩放/同显示器对照实验
- ✅ M3 区域裁剪（v2.4.0 迁移完成，**用户验收通过**）→ ⏳ M4 手填文件名 + 自动停止三件
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

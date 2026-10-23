# AGENTS.md — tab-recorder 项目上下文

> 本文件供 ZCode 在本目录打开时自动读取。任何会话开始前先读完这里，避免重新摸索。

## 项目是什么

Chrome 商店级「标签页录制器」浏览器扩展（MV3）：录制**当前标签页**的画面与声音，支持连播课程**自动按课时分节保存**。诞生背景：用户是路飞学城付费学员，需要离线学习，但课程视频用保利威私有加密无法下载（详见 `docs/luffycity-recon.md`），故转向"浏览器内录制"方案。目标上架 Chrome Web Store。

## 硬性红线

- 扩展零数据收集；权限最小化（当前权限集：tabCapture / offscreen / downloads / storage / scripting / activeTab，无 host 权限；activeTab 仅用户点击扩展时临时授权当前标签页，非 host 权限）
- 录制仅限用户有权观看的内容，商店描述保留"遵守网站服务条款"提示

## 架构与关键决策（勿推翻）

- 官方范式：SW `tabCapture.getMediaStreamId({targetTabId})` → offscreen 文档（USER_MEDIA，无时限）→ `getUserMedia({chromeMediaSource:'tab'})` → `MediaRecorder`
- **tabCapture 会切断标签页原声**，offscreen 里必须用 AudioContext 回环接回扬声器
- 自动分节 = 一条连续流上切 recorder（同流零丢帧），三重信号去抖合并：video ended（content-detect.js 注入上报）/ URL 变化（tabs.onUpdated）/ 标签页静默（轮询 Tab.audible，覆盖保利威这类 canvas 播放器）
- 保存：offscreen 生成 blob URL → SW `chrome.downloads.download`（saveAs:false）→ 下载完成回执后才 revoke / 关 offscreen 文档（早关会切断大文件下载）。**自定义目录方案已废弃（v1.1.4 用户裁决移除）**：Edge 上 FS Access 授权无法可靠持久化/跨上下文传播（offscreen 无手势、queryPermission 保守），实测始终回退下载目录——保留只会白增复杂度；输出位置=浏览器下载目录，弹窗问题靠用户关闭「下载前询问」设置，面板/设置页已明示
- **区域裁剪**（v1.1.0，v1.1.2 校准）：payload.crop 存在时，视频轨 → video → canvas（setInterval drawImage）→ captureStream 合成原音频轨再录。**offscreen 文档不可见，requestAnimationFrame 不运行，绘制必须用 setInterval**；裁剪尺寸向下取偶（H.264 yuv420）。选区由 content-crop.js 浮层上报视口坐标（session storage，绑 tabId）。**tabCapture 帧映射定律（diag_crop.py 实测固化）**：帧按 视口宽 统一缩放（scale=videoWidth/viewportW）；帧纵横比与视口不一致时**垂直居中、上下补黑边 letterbox**（offset=(videoHeight-viewportH×scale)/2，dpr 无关）——y 方向直接按视口高换算会偏 6%+，必须补偿。判据：参照线误差 ≤2 css px
- MP4 直录 duration=0 是 Chrome 已知行为（README 已说明用 ffmpeg -c copy 修复）；WebM 备选
- **播放标题识别（v1.1.5 七级级联，content-detect.js）**：mediaSession 元数据 → 用户配置选择器（默认 h1）→ 高亮目录项启发式（active/current/on/playing 类名，跳过 nav/header/footer、排除通用词）→「正在播放：」式文字标签 → video 属性 → video 祖先 5 层内标题元素 → document.title 剥尾巴。逐级剔除 UUID/长十六进制/长纯数字垃圾名；**必须 allFrames:true 注入**（保利威等播放器在 iframe 里，顶层 mediaSession 恒空）；多帧各自上报、offscreen 取最新非空；**识别过程面板全程可见**（status().lesson{name,src}，popup 实时显示"来源+标题"或常驻"未识别到"，summary.title 供上次结果回显）；单段命名优先级 = 手填文件名 > 识别标题 > 模板；分节名垃圾名兜底「第N节」

## 已知限制与环境事实

- **Chrome 稳定版（≥M137）已禁用 `--load-extension`**：自动化加载扩展必须用 **Edge**（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，已验证可用）或 Chrome for Testing（npmmirror 镜像可下；**本机只有 CfT 131 能跑**，139/148 秒退 code=3；已装在 `.cft/chrome-win64/`，`scripts/diag_chrome_name.py` 依赖它）。测试时注意 /json/list 里会混入浏览器组件扩展（Google Network Speech / Hangouts），**必须按 manifest 名称匹配我们的扩展**（名称含"标签页录制器"，SW 文件是 background.js）
- 窗口被完全遮挡/最小化 → Chrome 停止渲染 → 录制画面冻结、声音正常。产品内提示 + 配套 `启动录制专用Chrome.bat`（--disable-features=CalculateNativeWinOcclusion 等参数的独立实例）
- **测试脚本踩坑（v1.1.0 调试实录，均已修复进脚本）**：① 传给浏览器的路径必须用**正斜杠**——反斜杠路径经某些命令行处理层会把 `\t` 变成 TAB（`tab-recorder` → `<TAB>ab-recorder`），Edge 弹「清单文件丢失」；② `.ps1` 脚本必须**纯 ASCII**——UTF-8 无 BOM 中文注释被 PowerShell 5.1 按 GBK 误读会破坏语法（kill_test_chrome.ps1 曾因此静默失灵）；③ MV3 SW 空闲约 30 秒停转并从 CDP /json/list 消失，发现前先用 `PUT /json/new` 开标签页唤醒；④ 测试 profile 一次性耗材，脚本启动前 `shutil.rmtree` 重建，强杀残留的脏 profile 会让扩展子系统根本不启动
- **扩展侧踩坑（v1.1.1/v1.1.2 验收实录）**：⑤ `activeTab` 必须**显式写进 manifest permissions** 才会在用户点击扩展时授予——漏声明时无 host 权限的 `scripting.executeScript` 恒报 "Cannot access contents of the page"（content-detect.js 曾因此静默失败一个月）；且 `executeScript` 连扩展自身页面也要求 host 授权，自动化无法绕过；⑥ 浏览器「下载前询问每个文件的保存位置」设置对 `chrome.downloads.download` 生效且扩展无法覆盖（saveAs:false 也压不住）；⑦ **offscreen 文档没有 chrome.downloads API**（仅开放部分 API），blob URL 只能由 SW 发起下载；自动化环境（CDP 驱动、无真人交互）里该 blob 下载极易 0 字节僵死（首个下载常能完成、后续僵死），**用户真实环境未复现**——测试需取录制字节时走 `scripts/diag_crop.py` 的"扩展页内消费流 + CDP 回传"路径，别依赖 downloads；⑧ 自动化里给 tab 授 activeTab 的手段：manifest 绑 `_execute_action` 快捷键（现 Ctrl+Shift+Y）+ 真实键盘事件（SendKeys），`chrome.action.openPopup()` 编程调用**不算**用户调用、不授予；⑨ **executeScript allFrames 只注入注入时刻已存在的帧**——SPA 懒加载的播放器 iframe 注入时尚不存在就永远收不到脚本（v1.1.5 分节识别全空、单段正常的根因），须周期性补注入（现挂在 keepalive 心跳上约 6s 一次，脚本首行守卫使已有帧空操作）；⑩ **用户的 Chrome（14x）会整体丢弃 downloads.download 的 filename 参数**（文件落下载根目录、名为 blob GUID），Edge 与 CfT 131 实测正常——疑似 14x 行为变化，139/148 在本机无法运行（秒退 code=3）未能定位分界版本；对策 = SW 保存命名降级链（完整路径→仅文件名→offscreen `<a download>` 锚点→接受 GUID 并面板明示），每级落地后用 downloads.search 核验实际文件名。注意 blob 用 octet-stream 类型实测扩展名会被改 .txt，产品用 video/mp4 无此问题；⑪ **downloads.cancel 不删已完成下载的盘上文件**——弃用已完成的下载必须 `removeFile`（erase 只清历史记录）；⑫ **下载完成回执有竞态**——onChanged 监听挂上之前小文件就可能已完成，挂完监听必须补查一次当前状态（幂等触发），否则 offscreen 干等回执到死线；⑬ **Chrome 下载气泡会抢焦点关掉扩展 popup，且无 API 可靠抑制**（setShelfEnabled 对 14x 气泡无效）——根治 = 独立状态窗（chrome.windows.create 普通窗口，焦点被抢不关闭）；⑭ **SW 生命周期内变量跨不了录制场次**——SW 空闲 30s 被杀，跨场次状态（通道记忆/窗口 id）必须持久化到 chrome.storage.session；⑮ **content-detect 只在页面变化时上报**——复录同一页面（无变化）时新 offscreen 永远收不到初始状态，detect-config 必须触发强制上报；⑯ abandon 清理须等下载脱离 in_progress 再操作，cancel 未落定就 erase 会留下"已取消/已删除"历史残迹
- **自定义目录授权（方案已废弃，留档防重蹈）**：FS 授权是会话存储态非一次性消耗，但 offscreen 文档**没有 chrome.downloads API**、`showDirectoryPicker` 授权在 Edge 扩展上无法跨会话持久、offscreen 的 queryPermission 保守返回 prompt——v1.1.2/v1.1.3 两轮修复（picker id 持久化、popup 搭乘开始点击、撤闸门直接试写）均无法让文件真正落进自定义目录，v1.1.4 用户裁决整体移除。若未来重做：唯一可靠路径是原生消息宿主（native messaging），需权衡权限面
- 本机网络：pypi/github.io 直连被重置，pip 用清华镜像，外网走本地代理 127.0.0.1:7897；bash curl 直连部分站点会 TLS 失败（需带浏览器 UA 或走代理）
- 用户信息：pip 可用（Python 3.11），node 24 可用；用户自己装了 yt-dlp/ffmpeg 在 C:\Users\Admin\

## 当前状态（2026-10-22 · v1.1.11）

- ✅ v1.1.0-v1.1.10：自动分节、区域裁剪（已验收）、00:00:00 自动停止、延时开始（已验收）、标题识别、保存命名降级链、通道持久化/复录强制上报/独立状态窗（不抢焦点）、心跳补注入弹窗守护 + heartbeatInject 开关
- ✅ v1.1.11（十轮验收修复）：① **abandon 清理竞态**——cancel 生效前一瞬下载完成会把文件留盘（用户截图 GUID 与正确文件同尺寸成对）；改为循环核验到下载彻底消失（complete→removeFile+erase / in_progress→cancel 后重查 / interrupted→erase）；② **autoLiveWindow 设置项**（默认开，可关）——windows.create 即便 focused:false 在 Windows 上仍可能使弹窗失焦，状态窗自动弹出列为秒关新头号嫌疑，面板底部加「状态窗」手动入口；③ **初始注入重试**——快速连测时页面加载中注入会失败且无重试（用户关掉补注入排查时暴露），start 时失败自动重试 3 次；④ **pendingFinalize 守卫**——切段收尾未注册完就判"全部落盘"会提前关引擎（偶发丢段），计数守卫 + doSplit/stopAll 路径都链 maybeFinish
- ⏳ **待用户复验**：Chrome 重载 → 快速连测数段：只产出正确命名文件（会话首次保存的探测条目几秒内自动消失）→ 面板秒关是否随「自动打开状态窗」关闭而消失 → 标题识别稳定性
- ⏳ 上架流程未开始（checklist 在 README 第七节：zip 打包、$5 开发者账号、隐私声明模板已写好）

## 开发与测试

```bash
# 语法/清单校验
python -c "import json;json.load(open('extension/manifest.json',encoding='utf-8'))"
node --check extension/*.js   # 逐个
# 冒烟测试（用 Edge，见 scripts/smoke_test.py 顶部说明）
python scripts/smoke_test.py
# 重新生成图标
python scripts/make_icons.py
# 测试残留清理
powershell -File scripts/kill_test_chrome.ps1
```

## 文件地图

- `extension/` — 扩展本体（上架 zip 的内容就是这层目录内容）
  - `background.js` SW：streamId 签发、落盘、URL/静默/关闭信号、选区注入与上报路由
  - `offscreen.js` 录制引擎：取流、区域裁剪（canvas 合成流）、回环、分节、自动停、暂停恢复、双路保存（downloads / 自定义目录）
  - `content-detect.js` 按需注入（allFrames 全帧）：播放标题七级级联识别、课程名提取（可配选择器）、video ended 上报
  - `content-crop.js` 按需注入：录制区域框选浮层（Shadow DOM，比例锁定，视口坐标上报）
  - `popup.*` 控制面板（录制区域行/延时开始/文件名/输出位置提示）；`options.*` 设置页（全部参数可配）
- `scripts/smoke_test.py` — Edge + CDP 冒烟测试（含扩展身份强校验、SW 唤醒、profile 自清理）
- `scripts/verify_v11.py` — v1.1.0 新链路验证（选区上报链路 / options 控件 / offscreen fsdir）
- `docs/luffycity-recon.md` — 路飞学城私有加密技术侦察全文（为什么走录制方案）

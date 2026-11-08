// offscreen.js — 录制引擎：tabCapture 取流、音频回环、单段/自动分节、锚点直存
// 错误处理约定：消息/异步链用 .catch()；content-detect 侧用 try/catch 包同步调用
//（内容脚本上下文失效会同步抛，.catch 兜不住）。
// 生命周期独立于 popup 和 service worker（USER_MEDIA reason 无时限）。

(() => {
  let state = "idle"; // idle | countdown | recording | between | paused | stopping
  let mode = "single"; // single | segment
  let settings = {};
  let payload = {};
  let stream = null;
  let recStream = null; // 实际进 MediaRecorder 的流：裁剪时=canvas 合成流，否则原 tabCapture 流
  let cropPipe = null; // 裁剪管线 {video, canvasStream, timer}
  let crop = null; // {rect, viewportW, viewportH}（schedule 时从 payload 解析）
  let cropOut = null; // 实际输出尺寸 {w,h} 与映射参数 {vw,vh,scale,offsetX,offsetY}
  let cropError = "";
  let cropMismatch = null; // 框选快照 vs 开录实测错配（v2.8.15 换屏防呆，popup 侧算好传入）
  let captureSize = null; // 捕获帧尺寸 {w,h}（视频轨 getSettings，无裁剪时也可见）
  let curViewport = null; // 页面实时视口 {w,h,dpr}（顶层帧上报，变化沿）
  let viewportDrift = false; // 当前视口与框选快照不一致（裁剪位置可能偏移，面板警告）
  let audioCtx = null;
  let recorder = null;
  let mime = "";
  let ext = "mp4";

  let bytes = 0; // 当前段字节
  let activeBaseSeg = 0; // 当前段计时（暂停不计入）
  let activeBaseTotal = 0; // 总计时
  let resumeTs = null;
  const now = () => Date.now();

  // 分节（segment 模式）：同一条流上换 recorder，零丢帧
  let seq = 0;
  let cur = null; // {seq, name, chunks, bytes}
  let segmentsDone = []; // {seq, name, bytes, filename}
  let courseFolder = "";
  let lastUrl = "";
  let lastUrlFp = ""; // URL 指纹（剥进度参数与 hash）——判定变化是否构成内容切换
  let silenceSplitFired = false;
  let splitTimer = null;
  let lastSplitAt = 0;
  let pendingFinalize = 0; // 正在收尾（blob→锚点注册）的段数：防"未注册先判完成"
  let stopPending = 0; // [recorder.stop(), onstop) 异步窗口计数（审计 M1 v2.8.21）：
  //   窗口内 maybeFinish（tick/anchor-landed 触发）会提前结算→resumeCapture 替换
  //   cur→悬挂 onstop 的 finalizeSegment(cur) 落在空新段→整段静默丢失
  const SEG = {
    debounceMs: 1500, silenceSec: 5,
    urlStableMs: 3000, // URL 变化需稳定这么久才切节：进度/token 类参数会持续变化，永不稳定→不切
    urlInstantMinMs: 500, // URL 即刻切（segUrlMode）的最小等待：滤同帧抖动的瞬间变化
    silenceGapMs: 30000, // 两次静默切节的最小间隔（防 audible 抖动）
    minSplitGapMs: 10000, // 全局最小切节间隔：未到间隔时挂起信号保留重试（不丢弃）
    lessonStableMs: 2000, // 课时名同源变化需稳定这么久才切节（滤网络抖动；语义判定见下）
    entryStableMs: 3000, // 连播入口（播完弹窗）持续可见这么久才停录：滤动画/闪现误报
    betweenTimeoutMs: 30000, // 节间等待超时：无恢复信号也自动续录（入口误报/加载过慢兜底）
    takeoverStableMs: 2000, // 降级识别源稳定这么久且高 rank 值未变 → 接管命名
    advanceFallbackMs: 45000, // 连播定时兜底广播间隔
    finishDeadlineMs: 300000, // 大文件锚点落定上限 5 分钟
    idleDiscardBytes: 2 * 1024 * 1024, // 节间黑屏小段丢弃阈值（连播点击前弹窗期录到的部分）
    minLessonSplitBytes: 4 * 1024 * 1024, // lesson 切节前提：当前段 ≥ 此量（约 8 秒内容）才值得单独成文件，否则只改名并入后续
  };
  // 课时名来源优先级：高优源（播放器元数据/用户选择器）比低优源（页面标题等）可靠。
  // 语义判定（v2.2.5）：未知→首次识别=识别收敛（只补段名不切）；来源升级=识别收敛（不切）；
  // 来源降级=忽略（保持原值）；同源值变化=真换课（走稳定期切节）。时间窗只用于"等变化停止"。
  const SRC_RANK = { mediasession: 6, selector: 5, "active-item": 4, "playing-label": 3, "video-title": 2, "doc-title": 1 };
  // URL/课时名稳定期状态：变化先挂起，稳定后才切
  let pendingUrl = "";
  let lastUrlChangeAt = 0;
  let pendingLesson = "";
  let pendingLessonAt = 0;
  let pendingStartAfterResume = false; // 切节收尾毫秒窗内恰好 pause：resume 后补开新段
  let prevHighRank = null; // 降级接管时被替代的高 rank 值 {name,src}——恒值回归防护（M-e）
  let entryDismissedAt = 0; // 入口挂起因"无 ended"被作废的时刻——ended 迟到时重臂（M-c）
  let lastSilenceSplitAt = 0;
  let segStartAt = 0; // 当前段开始时刻（lesson-change 的 URL 联动确认基准）
  let segLessonAtStart = ""; // 本段开始时的课时名快照（URL 切节的「课时名未变否决」基准）
  let pendingEntryAt = 0; // 连播入口（播完弹窗）可见挂起时刻：稳定期满停录进节间
  let betweenStartAt = 0; // 进入 between 的时刻（超时自动恢复用）
  let resumeAfterBetween = false; // 点击成功触发的停录：between 就绪后立即续录（跳转加载期连续录，新节零丢失）
  let lastSplitInfo = null; // {reason, at}——切节原因（面板临时显示，诊断用）
  let lastPlayingTs = 0; // 最近一次"页面有视频在播"的上报时刻
  let hasPlayed = false; // 本场录制是否出现过播放（停播静默判定的启用开关；between 重置=恢复后重新收敛）
  let hasPlayedEver = false; // 本场是否**曾经**收到过 playing（between 不重置）——
  //   playing 盲区站（路飞 hasPlayedEver 恒 false）据此豁免自动收工，防误伤
  let lastAdvanceBroadcast = 0; // 最近一次连播广播时刻（定时兜底用）
  let endedLatchTs = 0; // 单段模式 ended 事件锁存时刻（5s 无 playing 恢复 = 真播完）
  let endedStopFired = false; // 单段 ended 停止一次性锁（停过不再重复触发）
  let endedSeen = false; // 最近一次 ended 后未再播放——弹窗入口信号的"播完"前提：
  //   暂停时播放器控制栏的「下一集」按钮可见（class 启发式命中），若仅凭可见就
  //   停录会碎片循环（暂停→停录→节间恢复→又停录…，B 站 ~15s/YouTube ~47s 一个
  //   碎片，且每次恢复重置收工计时）。ended 事件到达且未再播 = 真播完才认弹窗。
  let endedReportedEver = false; // 本场是否收到过 ended 上报（站点能力探测，段间保留）：
  //   ended 信号盲区站（保利威类，playing/ended 对 content script 均不可见）永远
  //   到不了 endedSeen——若无豁免，弹窗入口切节通道（其播完主通道）被整场锁死
  //   （路飞连播回归根因）。会报 ended 的站点防护照旧，从不报的站点跳过前提。

  // 识别标题（content-detect 级联上报）
  let currentLesson = "";
  let currentLessonSrc = "";

  // 锚点保存对账（多段并发落定）
  let anchorName = ""; // 最近一段文件名（展示用）
  const pendingAnchors = new Set();
  const anchorURLs = new Map(); // 文件名 → objectURL（anchor-landed 回执时 revoke）
  let finishDeadline = 0;

  // 捕获后移：倒计时期不取流（点开始瞬间几乎无动作，弹窗不会被顶掉），
  // 归零时才向 SW 要 streamId 开始捕获
  let pauseAfterStop = false; // 停止后进入 between（节间等待）而非完全结束
  let pendingSettings = null;
  let pendingPayload = null;
  let pendingTabId = null;
  let captureRequested = false;
  let startError = "";
  let cancelledReported = false; // 本场「预约期取消」是否已上报（防 requestCapture 失败/取消路径二次覆盖 lastSummary）

  let countdownTimer = null;
  let countEndTs = 0;
  let lastBadge = "";

  function updateBadge() {
    let text = "";
    if (state === "countdown") text = String(Math.max(0, Math.ceil((countEndTs - now()) / 1000)));
    else if (state === "between") text = "‖";
    else if (state === "recording") text = "REC";
    else if (state === "paused") text = "II";
    else if (state === "stopping") text = "···";
    if (text !== lastBadge) {
      lastBadge = text;
      chrome.runtime.sendMessage({ type: "badge", text }).catch(() => {});
    }
  }

  const DEFAULTS = { lessonPrefix: "^正在播放[:：]\\s*" };

  function sanitize(s, max = 120) {
    s = String(s || "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
      .replace(/[\u202a-\u202e]/g, "") // RTL 覆盖/隔离符：视觉欺骗文件名（审计安全低项）
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "");
    s = s.slice(0, max);
    // Windows 保留设备名（CON/PRN/AUX/NUL/COM1../LPT1..）加前缀防整名失效
    if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(?=\.|$)/i.test(s)) s = "_" + s;
    return s;
  }

  function stripLessonPrefix(raw) {
    const p = settings.lessonPrefix || DEFAULTS.lessonPrefix;
    try {
      return String(raw || "").replace(new RegExp(p), "").trim();
    } catch {
      return String(raw || "").trim();
    }
  }

  const NOISE_PATTERNS = [
    /-{2,}|—{2,}|~{2,}/,              // 连续分隔符堆叠：多段拼接文案特征
    /\d+\s*个(课时|课程|视频|节)/,      // 目录统计（共 N 个课时）
    /已学习|总时长|课程大纲|正在加载|请稍后|加载中/,
  ];
  function isJunkName(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    if (/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(t)
      || /^[0-9a-f]{20,}$/i.test(t)
      || /^\d{10,}$/.test(t)) return true;
    // 杂音特征与 content-detect 的 okName 保持一致判定（审计 Q2——两侧已分叉：
    // 文件名兜底也应拦「课程大纲/共N个课时」类加载文案）
    return NOISE_PATTERNS.some((re) => re.test(t));
  }

  function pickMime(want) {
    const mp4s = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
    const webms = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (const m of want === "webm" ? [...webms, ...mp4s] : [...mp4s, ...webms]) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  function buildSegName(seg) {
    const seq2 = String(seg.seq).padStart(2, "0");
    if (mode === "single") {
      // 单段优先级：手填文件名 > 识别标题 > 时间戳（v1 语义；不做模板变量）
      const manual = sanitize(payload.fileName || "", 120);
      if (manual) return manual;
      const lesson = sanitize(stripLessonPrefix(seg.name));
      if (lesson && !isJunkName(lesson)) return lesson;
      const d = new Date();
      const p2 = (v) => String(v).padStart(2, "0");
      return `录制_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    }
    const prefix = sanitize(courseFolder, 40);
    const lesson = sanitize(stripLessonPrefix(seg.name));
    const base = lesson && !isJunkName(lesson) ? lesson : `第${seg.seq}节`;
    return prefix ? `${prefix}_${seq2}-${base}` : `${seq2}-${base}`;
  }

  const segActiveMs = () => activeBaseSeg + (resumeTs ? now() - resumeTs : 0);
  const totalActiveMs = () => activeBaseTotal + (resumeTs ? now() - resumeTs : 0);

  // 区域裁剪：tab 视频轨 → video → canvas（定时 drawImage 裁剪）→ captureStream
  // offscreen 文档不可见，requestAnimationFrame 不运行，因此用 setInterval 按目标帧率绘制。
  async function buildCropStream(srcStream) {
    const fps = Number(settings.frameRate) > 0 ? Number(settings.frameRate) : 30;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream(srcStream.getVideoTracks());
    await video.play().catch(() => {});
    if (!video.videoWidth) {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("视频流迟迟无画面")), 5000);
        video.onloadedmetadata = () => { clearTimeout(to); resolve(); };
      });
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    // 帧几何定律（v2.8.16 定稿，用户面板数字实锤）：Chrome 对 tabCapture 的宽高
    // 约束一律无视（平台行为），窗口化录制时帧取**整屏逻辑尺寸**，窗口画面
    // **等比缩放 + 居中补黑边**放进帧里（按帧/视口较小比值缩放，剩余维度居中）。
    // 映射必须反算黑边 offset，否则采样窗把黑边当内容（窗口化场景上下各多吞
    // ~120px，用户实测）。历史注记：v2.5.3 的「拉伸模型」是对当年 ~10px 黑边
    // 场景的误判（两模型不可区分）；真正治好当时问题的是映射基准改用开录实时
    // 视口（payload.viewport，本版保留）；最大化窗口黑边=0 两模型等价，故验证
    // 一直未暴露。v2.4 时代 diag_crop 验证的原始定律即本定律。
    // 映射基准 = 开录时刻实时视口，框选视口兜底；双基准均无效（w=0/undefined）
    // 时回退帧自身（scale=1 零 offset）——防 NaN 沿 Math.min/max 静默扩散（审计低项）
    const vpRaw = (pendingPayload && pendingPayload.viewport && pendingPayload.viewport.w > 0)
      ? pendingPayload.viewport
      : { w: crop.viewportW, h: crop.viewportH };
    const vp = vpRaw.w > 0 && vpRaw.h > 0 ? vpRaw : { w: vw, h: vh };
    const map = cropMapRect(crop.rect, vw, vh, vp.w, vp.h);
    const { sx, sy, sw, sh } = map;

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, sw, sh);
    const draw = () => {
      if (!cropPipe) return;
      try {
        if (video.readyState >= 2) ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      } catch (e) { /* 单帧失败忽略 */ }
    };
    const timer = setInterval(draw, Math.max(1000 / fps, 8));
    const canvasStream = canvas.captureStream(fps);
    cropPipe = { video, canvasStream, timer };
    cropOut = { w: sw, h: sh, vw, vh, scale: map.scale, offsetX: map.offsetX, offsetY: map.offsetY, viewportW: crop.viewportW, viewportH: crop.viewportH }; // 映射参数入面板：缩放错位时对照两端数字
    return new MediaStream([
      canvasStream.getVideoTracks()[0],
      ...srcStream.getAudioTracks(),
    ]);
  }

  // 裁剪映射纯函数（广义黑边定律，node 单测覆盖）：帧内容区 = 视口等比缩放 +
  // 双向居中；scale 取帧/视口两比值中较小者（小者决定内容装得下），另一维度
  // 的差值即黑边。纵横比一致时双 offset=0（最大化窗口），行为与既往一致。
  function cropMapRect(rect, vw, vh, vpW, vpH) {
    const scale = Math.min(vw / vpW, vh / vpH);
    const offsetX = (vw - vpW * scale) / 2;
    const offsetY = (vh - vpH * scale) / 2;
    let sx = Math.min(Math.max(0, Math.floor(rect.x * scale + offsetX)), vw - 2);
    let sy = Math.min(Math.max(0, Math.floor(rect.y * scale + offsetY)), vh - 2);
    let sw = Math.min(vw - sx, Math.floor(rect.w * scale));
    let sh = Math.min(vh - sy, Math.floor(rect.h * scale));
    sw -= sw % 2; sh -= sh % 2; // H.264 yuv420 要求偶数尺寸
    if (sw < 16 || sh < 16) throw new Error("裁剪区域换算后过小");
    return { sx, sy, sw, sh, scale, offsetX, offsetY };
  }

  function destroyCropPipe() {
    if (!cropPipe) return;
    try { clearInterval(cropPipe.timer); } catch (e) {}
    try { cropPipe.canvasStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { cropPipe.video.srcObject = null; } catch (e) {}
    cropPipe = null;
  }

  function makeRecorder() {
    // 录制内容过滤（裁剪流之后）：仅音频=音频轨、仅视频=视频轨（回环仍接原流，仅视频时扬声器照常出声）
    let rs = recStream || stream;
    if (settings.recordKind === "audio") rs = new MediaStream(rs.getAudioTracks());
    else if (settings.recordKind === "video") rs = new MediaStream(rs.getVideoTracks());
    const r = new MediaRecorder(rs, {
      mimeType: mime,
      videoBitsPerSecond: Number(settings.videoBitrate) || 4000000,
      audioBitsPerSecond: Number(settings.audioBitrate) || 128000,
    });
    r.ondataavailable = (e) => {
      if (e.data && e.data.size && cur) {
        cur.chunks.push(e.data);
        cur.bytes += e.data.size;
        bytes += e.data.size;
      }
    };
    return r;
  }

  // 解除 URL 刹车（否决切分的路径调用，防录制卡在暂停）
  function releaseUrlBrake() {
    if (!urlBrakeApplied) return;
    urlBrakeApplied = false;
    try { recorder && recorder.state === "paused" && recorder.resume(); } catch (e) {}
  }

  // 识别竞争状态重置（审计 Q1 痛点：挂起/竞争类标志集中在此，防散置漏重置）
  function resetContestState() {
    pendingLesson = "";
    pendingLessonAt = 0;
    pendingLowerRank = null;
    prevHighRank = null;
    pendingEntryAt = 0;
    entryDismissedAt = 0;
    silenceSplitFired = false;
    urlBrakeApplied = false;
    pendingStartAfterResume = false;
  }

  function startSegment() {
    seq += 1;
    cur = { seq, name: currentLesson || "", chunks: [], bytes: 0 };
    activeBaseSeg = 0;
    segStartAt = now(); // lesson-change 的 URL 联动确认基准：本段开始后 URL 变过才算真换课
    segLessonAtStart = currentLesson || ""; // URL 切节「课时名未变否决」的基准（见 checkPendingSplits）
    endedSeen = false; // 新段从"未播完"开始（弹窗入口前提重新收敛）
    resetContestState(); // 竞争与挂起重新收敛（prevHighRank 残留会误挡新节首报）
    if (resumeTs === null) resumeTs = now();
    recorder = makeRecorder();
    recorder.start(1000);
  }

  function beginRecording() {
    if (state !== "recording") return;
    resumeTs = now();
    state = "recording";
    startSegment();
  }

  // 倒计时归零 → 向 SW 要 streamId → 真正开始捕获与录制
  // 节间等待 → 播放恢复/跳转成功 → 同流开新 recorder 续录（零丢帧，无二次捕获风险）
  function resumeCapture() {
    if (state !== "between") return;
    console.info("[rec] 节间恢复：续录");
    state = "recording";
    currentLesson = ""; // 重置：等新节识别补写段名（between 期 detector 可能已上报新节名）
    betweenStartAt = 0;
    pendingEntryAt = 0; // 残留挂起会在续录后被 entryVisibleCheck 立即误停录，必须清
    resumeTs = now();
    startSegment();
    updateBadge();
  }

  async function requestCapture() {
    if (state !== "countdown" || captureRequested) return;
    captureRequested = true;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "request-capture",
        tabId: pendingTabId,
        settings: pendingSettings,
        mode,
      });
      if (!resp || !resp.ok || !resp.streamId) throw new Error((resp && resp.error) || "未获得捕获授权");
      await beginCapture(resp.streamId);
    } catch (e) {
      startError = String(e && e.message || e);
      if (cancelledReported) return; // 取消已由 stopAll 上报，失败路径不覆盖 lastSummary（审计低项）
      state = "idle";
      wrapStatus = null;
      stopLoops();
      destroyExtra();
      updateBadge();
      chrome.runtime.sendMessage({
        type: "recording-finished",
        summary: { error: startError },
      }).catch(() => {});
    }
  }

  async function beginCapture(streamId) {
    if (state !== "countdown") return; // 用户已在预约期取消
    const videoMandatory = { chromeMediaSource: "tab", chromeMediaSourceId: streamId };
    const fps = Number(pendingSettings.frameRate);
    if (fps > 0) videoMandatory.maxFrameRate = fps;
    // 帧尺寸约束：视口物理尺寸。legacy mandatory 语法**不支持 {ideal} 对象**
    //（v2.5.1 被静默忽略）——数字直填（精确语义）。Chrome 的 tabCapture 帧协商
    // 疑似以屏为准而非窗口视口（实测帧=显示器逻辑整屏 2240×1400 而窗口更小），
    // 帧与视口内容非等比 → 裁剪映射变形（YouTube「内容缩放错位」）。
    const cap = pendingPayload && pendingPayload.capture;
    if (cap && cap.w > 0 && cap.h > 0) {
      videoMandatory.width = cap.w;
      videoMandatory.height = cap.h;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: { mandatory: videoMandatory },
      });
    } catch (e) {
      if (!cap) throw e; // 未加约束时的失败与本机制无关，原样抛出
      // 过约束（Chrome 给不了精确尺寸/不接受宽高）：删约束降级重试，录制不失败
      delete videoMandatory.width;
      delete videoMandatory.height;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: { mandatory: videoMandatory },
      });
    }
    try {
      const vs = stream.getVideoTracks()[0].getSettings();
      captureSize = { w: vs.width || 0, h: vs.height || 0 };
    } catch (e) { captureSize = null; }

    stream.getVideoTracks()[0].addEventListener("ended", () => stopAll("stream-ended"));

    if (state !== "countdown") {
      // getUserMedia 期间被取消（取消上报已由 stopAll 完成，不重发——审计低项）
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      return;
    }

    // 回环：tabCapture 后原标签页静音，必须把音频接回扬声器才能边录边听。
    // （静默检测的信号源是 content-detect 上报的 playing，不在此音频路径上）
    // 创建在取消检查之后（审计低项）：取消路径不再创建 audioCtx，免泄漏兜底
    try {
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(audioCtx.destination);
      audioCtx.resume().catch(() => {});
    } catch (e) { console.warn("loopback failed", e); }
    // 区域裁剪：构建 canvas 合成流（失败自动降级全画面，不阻塞录制）
    recStream = stream;
    if (crop) {
      try {
        recStream = await buildCropStream(stream);
      } catch (e) {
        cropError = String(e && e.message || e);
        crop = null;
        recStream = stream;
        console.warn("[rec] 裁剪降级全画面:", cropError);
      }
    }
    state = "recording";
    beginRecording();
  }

  // 预约式启动：点开始只做计划（取流推迟到倒计时归零，弹窗全程稳定）
  function schedule(msg) {
    settings = msg.settings || {};
    payload = msg.payload || {};
    pendingSettings = settings;
    pendingPayload = payload;
    pendingTabId = msg.tabId;
    mode = payload.mode === "segment" ? "segment" : "single";
    courseFolder = sanitize(payload.courseFolder || "", 40);
    crop = payload.crop && payload.crop.rect ? payload.crop : null;
    cropMismatch = payload.cropMismatch || null; // 换屏/改窗错配（popup 开录前置校验，v2.8.15）——面板常显警告

    // 仅音频输出 webm（MP4 直录不支持纯音轨容器）；仅视频保持所选格式
    mime = settings.recordKind === "audio"
      ? pickMime("webm")
      : pickMime(settings.format === "webm" ? "webm" : "mp4");
    ext = mime.startsWith("video/mp4") ? "mp4" : "webm";

    seq = 0;
    cur = null;
    segmentsDone = [];
    bytes = 0;
    currentLesson = "";
    currentLessonSrc = "";
    lastUrl = payload.tabUrl || "";
    lastUrlFp = urlFingerprint(lastUrl);
    urlLog = [];
    pendingUrl = "";
    lastUrlChangeAt = 0;
    lastSilenceSplitAt = 0;
    segStartAt = 0;
    segLessonAtStart = "";
    betweenStartAt = 0;
    resumeAfterBetween = false;
    lastSplitInfo = null;
    lastPlayingTs = 0;
    hasPlayed = false;
    hasPlayedEver = false;
    lastAdvanceBroadcast = now(); // 开录即视为刚广播过：否则 tick 兜底（now-0≥45s 恒真）
    // 首轮就广播连播点击——开录时内容刚开始播，点「下一节」是跳课事故
    //（盲区 e2e 实锤：九轮定时器把 15s 后才出现的弹窗在 1s 内点掉，
    // entry-visible 的 3s 稳定期被抢跑）。真播完才广播（stoppedPlaying/entry）
    endedLatchTs = 0;
    endedStopFired = false;
    endedSeen = false;
    endedReportedEver = false; // 站点能力探测按场重置（新一场重新探测 ended 可达性）
    lastSplitAt = now(); // 启动静默期：开录 10 秒内不切节（v1 验证过的设计，v2 重写时丢失
                         // 导致全局闸从开录起失效——开录静默误切节、占闸挤掉真播完信号）
    resetContestState(); // 竞争/挂起类集中重置（含 prevHighRank/entryDismissedAt 等）
    captureRequested = false;
    startError = "";
    cancelledReported = false; // 取消上报状态按场重置
    wrapStatus = null;
    recStream = null;
    cropOut = null;
    cropError = "";
    captureSize = null;
    curViewport = null;
    viewportDrift = false;
    pendingAnchors.clear(); // 上一场未落定的锚点残留会让本场 maybeFinish 卡到 deadline
    for (const u of anchorURLs.values()) { try { URL.revokeObjectURL(u); } catch (e) {} }
    anchorURLs.clear(); // 上一场未确认锚点的 blob URL 不带入本场（审计低项：防滞留至文档关闭）
    anchorName = "";
    activeBaseSeg = 0;
    activeBaseTotal = 0;
    state = "countdown";
    startLoops();
    const delaySec = Math.min(60, Math.max(0, Number(payload.startDelaySeconds) || 0));
    if (delaySec > 0) {
      countEndTs = now() + delaySec * 1000;
      countdownTimer = setInterval(() => {
        if (state === "countdown" && now() >= countEndTs) requestCapture();
      }, 200);
    } else {
      requestCapture();
    }
    return { ok: true, mime, delay: delaySec };
  }

  function pause() {
    if (state !== "recording") return { ok: false };
    const t = now();
    activeBaseSeg += t - resumeTs;
    activeBaseTotal += t - resumeTs;
    resumeTs = null;
    state = "paused";
    // 用户手动暂停时解除 URL 刹车（审计 M-b）：刹车标志若残留，恢复后同段后续
    // URL 变化因"已施加"判断不再刹车，旧节尾部污染回潮
    releaseUrlBrake();
    try { recorder && recorder.state !== "inactive" && recorder.pause(); } catch (e) {}
    return { ok: true };
  }

  function resume() {
    if (state !== "paused") return { ok: false };
    resumeTs = now();
    state = "recording";
    // 切节收尾毫秒窗内被 pause 打断的新段在此补开（doSplit 的 onstop 置位）
    if (pendingStartAfterResume) {
      pendingStartAfterResume = false;
      startSegment();
    }
    try { recorder && recorder.state !== "inactive" && recorder.resume(); } catch (e) {}
    return { ok: true };
  }

  function stopAll(reason, keepOffscreen, discard) {
    if (state === "stopping") return { ok: true };
    if (state === "idle") {
      // 审计 M2 v2.8.21：offscreen 异常消亡后被 stop 重建的 idle 文档必须回发
      // recording-finished——否则 background 的 session.recording 旗标永不清除，
      // 用户被「已有录制进行中」锁死到重载扩展。处理器幂等，重复发送无害
      chrome.runtime.sendMessage({
        type: "recording-finished",
        summary: { mode, segments: [], last: "" },
      }).catch(() => {});
      return { ok: true };
    }
    // 自动停止类原因面板可见（复验免开 F12 一击定位；manual 等不占"切节"语义）
    if (["video-stopped", "video-ended", "preset", "idle-wrap"].includes(reason)) {
      lastSplitInfo = { reason, at: now() };
    }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (state === "between") {
      // 节间等待中停止（手动/定时到点/收工）：已录节全部落盘，正常收尾上报
      //（原 cancelled:true 会丢失"已保存 N 节"信息）
      state = "idle";
      wrapStatus = null; // 收工判定状态不残留到空闲（观测面污染，审计低项）
      stopLoops();
      updateBadge();
      chrome.runtime.sendMessage({
        type: "recording-finished",
        summary: { mode, segments: segmentsDone, last: anchorName },
      }).catch(() => {});
      return { ok: true };
    }
    if (state === "countdown" && !captureRequested) {
      // 预约期取消：尚未取流，干净退出、无任何文件
      state = "idle";
      wrapStatus = null;
      cancelledReported = true; // requestCapture/beginCapture 的取消路径不再二次上报（审计低项：防 lastSummary 被覆盖）
      stopLoops();
      updateBadge();
      chrome.runtime.sendMessage({ type: "recording-finished", summary: { cancelled: true } }).catch(() => {});
      return { ok: true };
    }
    pauseAfterStop = !!keepOffscreen;
    state = "stopping";
    if (splitTimer) { clearTimeout(splitTimer); splitTimer = null; }
    const deadline = now() + SEG.finishDeadlineMs; // 大文件落定上限 5 分钟
    if (resumeTs !== null) { const t = now(); activeBaseSeg += t - resumeTs; activeBaseTotal += t - resumeTs; resumeTs = null; }
    if (recorder && recorder.state !== "inactive") {
      const seg = cur; // 先捕获段引用（审计 M1）：onstop 异步派发，窗口内 cur 可能已被换段
      stopPending++; // stop→onstop 窗口禁 maybeFinish 抢跑
      recorder.onstop = discard
        ? () => { stopPending--; console.info("[rec] 丢弃当前段（停止不保存）:", seg && seg.bytes, "bytes"); maybeFinish(); }
        : () => { stopPending--; finalizeSegment(seg).then(maybeFinish); };
      try { recorder.stop(); } catch (e) { stopPending--; maybeFinish(); }
    } else {
      maybeFinish();
    }
    finishDeadline = deadline;
    return { ok: true };
  }

  // 锚点直存：File（带名字）+ <a download>——用户 Chrome 实测唯一 100% 正确命名的通道
  async function finalizeSegment(seg) {
    if (!seg || !seg.chunks.length) return;
    pendingFinalize += 1; // 同步段先计数：maybeFinish 不会在锚点注册前抢跑
    try {
      const blob = new Blob(seg.chunks, { type: mime });
      seg.chunks = [];
      const name = `${buildSegName(seg)}.${ext}`;
      const url = URL.createObjectURL(new File([blob], name, { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      pendingAnchors.add(name);
      anchorURLs.set(name, url); // 落定回执时 revoke（长录多段防 blob 内存驻留）
      anchorName = name;
      chrome.runtime.sendMessage({ type: "track-anchor", name }).catch(() => {});
      segmentsDone.push({ seq: seg.seq, name: seg.name, bytes: blob.size, filename: name });
    } finally {
      pendingFinalize -= 1;
    }
  }

  function maybeFinish() {
    if (state !== "stopping") return;
    if (stopPending > 0) return; // stop→onstop 异步窗口内不结算（审计 M1）
    if (pendingFinalize > 0) return; // 还有段的收尾没走完，等它把锚点注册进来
    if (pauseAfterStop) {
      // 切节进 between：不等锚点下载确认——offscreen 文档不关闭，下载由浏览器
      // 异步完成，确认只对最终收尾必要；等确认会让续录晚几秒，新节开头又丢
      pauseAfterStop = false;
      state = "between";
      betweenStartAt = now();
      hasPlayed = false; // 恢复后重新从 playing 上报收敛
      lastAdvanceBroadcast = now();
      if (resumeAfterBetween) {
        // 点击成功触发的停录：旧节已保存、页面尚未跳转完成——立即续录，
        // 新段从点击后亚秒级起，涵盖导航与新节全程（零丢失零污染）
        resumeAfterBetween = false;
        resumeCapture();
        return;
      }
      updateBadge();
      return;
    }
    if (pendingAnchors.size === 0 || now() > finishDeadline) {
      state = "idle";
      wrapStatus = null;
      stopLoops();
      destroyExtra();
      chrome.runtime.sendMessage({
        type: "recording-finished",
        summary: { mode, segments: segmentsDone, last: anchorName },
      }).catch(() => {});
    }
  }

  function destroyExtra() {
    destroyCropPipe();
    try { audioCtx && audioCtx.close(); } catch (e) {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  }

  function status() {
    return {
      state, mode, mime, ext,
      countdown: state === "countdown" ? Math.max(0, Math.ceil((countEndTs - now()) / 1000)) : 0,
      lesson: { name: currentLesson, src: currentLessonSrc },
      seq: cur ? cur.seq : 0,
      segMs: segActiveMs(),
      totalMs: totalActiveMs(),
      bytes,
      segCount: segmentsDone.length,
      lastSplit: lastSplitInfo,
      signals: { hasPlayed, playingAgo: lastPlayingTs ? now() - lastPlayingTs : -1 },
      crop: cropOut,
      cropError,
      cropMismatch,
      captureSize,
      curViewport,
      viewportDrift,
      urlLog: urlLog.slice(-2),
      error: startError,
      // 竞争/收工内部量（观测面：面板与诊断脚本直接读数定位命名与收工问题，
      // 免开 F12——路飞双盲区站自动化进不去，用户 Chrome 一场复验即可定位）
      dbg: {
        currentLessonSrc,
        pendingLesson,
        pendingLowerRank: pendingLowerRank && { name: pendingLowerRank.name, src: pendingLowerRank.src },
        prevHighRank,
        hasPlayedEver,
        endedReportedEver,
        endedSeen,
        wrapStatus, // {left:ms}|{blocked:原因}|null——与 idleWrapCheck 判定同源
      },
    };
  }

  // ---- 分节信号 ----
  // 返回 true = 已接受（排队/执行）；false = 被全局间隔拒绝（调用方可保留挂起重试）
  let pendingSplitReason = ""; // 去抖窗内合并信号时记最新原因（审计低项：防 lastSplitInfo 记首因误导诊断）
  function requestSplit(reason) {
    if (state !== "recording" || mode !== "segment") return false;
    if (now() - lastSplitAt < SEG.minSplitGapMs) {
      console.info("[rec] split 推迟（全局间隔未到）:", reason);
      return false;
    }
    if (splitTimer) { pendingSplitReason = reason; return true; } // 已在排队，去抖合并（记最新原因）
    console.info("[rec] split signal:", reason);
    pendingSplitReason = reason;
    splitTimer = setTimeout(() => {
      splitTimer = null;
      doSplit(pendingSplitReason);
    }, SEG.debounceMs);
    return true;
  }

  function doSplit(reason) {
    if (state !== "recording" || mode !== "segment") return;
    if (now() - lastSplitAt < SEG.minSplitGapMs) {
      console.info("[rec] split rejected (全局间隔):", reason);
      return;
    }
    // 内容硬前提：当前段没有实质内容（开录初期未点播放等）时任何信号都不切段、
    // 不触发连播广播——空段切出去就是碎片段，还会错位占用全局间隔
    if (cur && cur.bytes < SEG.idleDiscardBytes) {
      console.info("[rec] split rejected (段内容不足):", reason, cur.bytes, "bytes");
      releaseUrlBrake(); // 拒绝切分：刹车必须解除，否则录制卡在暂停
      return;
    }
    lastSplitAt = now();
    pendingLesson = ""; // 信号使命完成（在执行点清除而非排队点——去抖窗内被
    // stopAll/pause 打断时挂起保留，下轮 tick 重新排队，防换课信号丢失）
    // 切节后识别状态重置：mediasession 等高优源的残留值不再挡住下一节识别
    //（下一节的首个识别值从任意源接受，随后来源升级继续收敛）
    currentLessonSrc = "";
    // 切段即重新武装停播静默（30s 间隔仍防碎切）——若跳转后新节 playing 上报
    // 因 detector 重注入延迟而丢失，此处重置可避免下一节播完时被锁不切
    silenceSplitFired = false;
    lastSplitInfo = { reason, at: now() };
    // url-change/lesson-change 切段 = 页面已自行跳转（连播关闭或用户手点），
    // 不广播连播；播完/静默类切段的广播在 stoppedPlayingCheck 里做
    const old = recorder;
    const seg = cur;
    // 不置 recorder=null（审计 H1）：置 null 后 stopAll 见"无活跃 recorder"直接
    // 收尾关文档，悬挂的本 onstop/finalizeSegment 被杀——最后一段数据丢失。
    // 保留引用让 stopAll 走 recorder.stop() 正常路径（stop 对 inactive 幂等）。
    if (!old || old.state === "inactive") { startSegment(); return; }
    stopPending++; // stop→onstop 窗口禁 maybeFinish 抢跑（审计 M1：手动 stop 命中窗口时 stopAll 直调 maybeFinish 的同族路径）
    old.onstop = () => {
      stopPending--;
      finalizeSegment(seg).then(maybeFinish); // 停止恰发生在切节收尾期间时，也要补完成判定
      // 仅 recording 开新段；paused（stop→onstop 毫秒窗内恰好 pause）延迟到
      // resume 再开，防"新段实录而计时按暂停"的错位
      if (state === "recording") startSegment();
      else if (state === "paused") pendingStartAfterResume = true;
    };
    try { old.stop(); } catch (e) { stopPending--; console.warn(e); startSegment(); }
  }

  // URL 变化统一入口：只挂起不切节，等稳定期由 tick 判定（content 与 SW 两条路径都走这里）
  // 进度类参数：播放位置追踪（YouTube 播放中每 ~10s replaceState 更新 t），它们的
  // 变化不代表换内容——URL 模式（segUrlMode）按 URL 变化切节时必须先剥掉，否则
  // YouTube 全是 ~10s 碎片（t 变化周期恰与全局 10s 节流同频）。B 站 p、YouTube
  // v/list/index 等课时标识参数不在名单，变化正常生效。
  const PROGRESS_PARAM_KEYS = ["t", "t2", "time", "start", "progress", "at", "ts", "timestamp"];
  let urlBrakeApplied = false; // URL 刹车已施加（编码器已暂停，等待切分/恢复）
  // URL 变化观测日志：记录每次变化的原样 URL 与指纹判定结果——「网址一变就切」
  // 的剥除名单基于假设（YouTube 用 &t= 记进度），真实变化模式以观测为准
  let urlLog = []; // 最近 5 条 {u, changed, at}

  function urlFingerprint(url) {
    try {
      const u = new URL(url);
      PROGRESS_PARAM_KEYS.forEach((k) => u.searchParams.delete(k));
      u.hash = ""; // hash 是页面内状态（进度锚点等），不构成内容切换
      return u.origin + u.pathname + u.search;
    } catch (e) { return url; }
  }

  function onUrlChange(url) {
    if (!url || url === lastUrl) return;
    if (/^about:blank/i.test(url)) return; // 防御：空 iframe 地址不是内容切换（顶层帧判定已在 content 侧收口）
    const fp = urlFingerprint(url);
    const changed = fp !== lastUrlFp;
    urlLog.push({ u: String(url).slice(0, 120), changed, at: now() });
    if (urlLog.length > 5) urlLog.shift();
    if (!changed) {
      lastUrl = url; // 记录原样 URL（后续比较用），但指纹未变 = 进度/hash 更新，非内容切换
      return;
    }
    lastUrl = url;
    lastUrlFp = fp;
    pendingUrl = url;
    lastUrlChangeAt = now();
    // URL 刹车（segUrlMode）：内容标识变化**瞬间**暂停编码器——从这一刻起旧节
    // 不再吸收任何帧，尾部干净无污染（后续 tick 走即刻切分完成停录+续录；检测
    // 延迟不再影响旧节内容）。极端场景（10s 节流期内连续切 P）保持暂停到节流
    // 期满再切，损失新内容开头几秒而不是污染旧节——与"录了再扔不如不录"一致。
    if (settings.segUrlMode && state === "recording" && mode === "segment"
        && recorder && recorder.state === "recording" && !urlBrakeApplied) {
      try { recorder.pause(); urlBrakeApplied = true; } catch (e) {}
    }
  }

  // tick 周期检查：URL/课时名挂起变化的稳定期判定（被全局闸拒绝时保留挂起，下轮重试）
  function checkPendingSplits() {
    // 降级挂起到期结算（接管不再依赖下一次同值上报——上报周期 6s 会让接管
    // 落后于切节落盘，blind2 取证实锤第 3 段名卡主值）。挂起期间高 rank 值
    // 一旦真变化，applyLessonReport 正常路径会撤挂起（L935），此处只结算
    // 「稳定 2s 且未变」的挂起——与原语义一致
    if (pendingLowerRank && now() - pendingLowerRank.at >= SEG.takeoverStableMs) {
      console.info("[rec] 降级源稳定接管（到期结算）:", pendingLowerRank.src, pendingLowerRank.name);
      const lk = pendingLowerRank;
      pendingLowerRank = null;
      prevHighRank = { name: currentLesson, src: currentLessonSrc }; // 记被替代值：恒值回归防护
      currentLesson = lk.name;
      currentLessonSrc = lk.src;
      if (state === "recording" && mode === "segment" && cur && cur.name !== lk.name) cur.name = lk.name;
    }
    if (state === "between") {
      // 节间等待：跳转成功（URL 稳定）→ 重新捕获续录（seq 与识别延续）
      if (pendingUrl && now() - lastUrlChangeAt >= SEG.urlStableMs) {
        pendingUrl = "";
        resumeCapture();
      } else if (betweenStartAt && now() - betweenStartAt >= SEG.betweenTimeoutMs) {
        // 超时兜底：入口误报进 between 但无跳转（浮层点不掉）、或新页加载过慢——
        // 直接续录本流。宁可录进当前段也不无限空等（段名未识别时 URL 前置挡误切）
        console.info("[rec] 节间等待超时，自动恢复续录");
        resumeCapture();
      }
      return;
    }
    if (state !== "recording" || mode !== "segment") { pendingUrl = ""; pendingLesson = ""; return; }
    // segUrlMode（面板勾选「URL 变化即切节」= 用户标注该站 URL 可信）：
    // URL 变化**不等稳定期**即刻停录+续录——SPA 切换快，稳定期内新内容可能
    // 已开播吸进旧节尾部（B 站多 P 实测污染几秒）。即刻切 = 旧节尾部截止
    // URL 变化瞬间（新内容未开播，干净），新内容从加载期起完整续录零丢失。
    // 10s 节流防 URL 抖动碎切：未到间隔退回稳定期路径（挂起保留重试）。
    if (settings.segUrlMode && pendingUrl && now() - lastUrlChangeAt >= SEG.urlInstantMinMs
        && state === "recording" && now() - lastSplitAt >= SEG.minSplitGapMs
        && lastPlayingTs > segStartAt // 本段播过才认 URL 变化为换内容：真换集（切 P）
        // 时旧内容在播恒成立；静止段的 URL 变化（diag_pause_page 实测暂停态
        // 顶层 URL 零变化，此前提主要防识别/恢复边缘期的杂音）不构成切分依据
        && cur && cur.bytes >= SEG.idleDiscardBytes) {
      pendingUrl = "";
      resumeAfterBetween = true;
      finishSegmentForAdvance("url-change");
      return;
    }
    if (pendingUrl && now() - lastUrlChangeAt >= SEG.urlStableMs) {
      // 前置：课时名/段名未识别时 URL 变化一律不切段（切了也无法正确命名；识别到位后段名自然补写）。
      // 开录后点播放常使播放器给 URL 加参数——这条前置拦住由此产生的开录碎片段
      if (!currentLesson || !cur || !cur.name) {
        pendingUrl = "";
        releaseUrlBrake(); // 否决切分：刹车必须解除，否则录制卡在暂停
        return;
      }
      // 课时名语义否决（N 段根因修复）：本段开始时已识别且至今同名，或段开始时
      // 未识别、段内才识别出——都是"同课的 URL 参数/杂音变化"（分片 token、进度、
      // 播放器 iframe 轮询），不切。真换课由 lesson-change 通道完成（识别收敛后
      // 2s 稳定 + URL 联动确认）；URL 切节只在课时名于本段内真变过时兜底。
      // segUrlMode（面板勾选「URL 变化即切节」）= 用户标注该站点 URL 可信
      //（B 站多 P 等同页换集、课时名信号不可用）：跳过否决，URL 稳定即切。
      if (!settings.segUrlMode && (!segLessonAtStart || currentLesson === segLessonAtStart)) {
        console.info("[rec] url-change 否决（本段课时名未变）:", currentLesson);
        pendingUrl = "";
        return;
      }
      if (requestSplit("url-change")) {
        pendingUrl = "";
      }
    }
    if (pendingLesson && now() - pendingLessonAt >= SEG.lessonStableMs) {
      const p = pendingLesson;
      // 稳定后仍是新值（未被抖回/再变）才切；与本段同名说明只是同课重复上报。
      // 实质内容前提：当前段太小（开录识别收敛、连播丢弃清缓冲后）不值得单独成
      // 文件——只更新段名，小段并入后续内容；段已有实质内容才真正切段。
      // p===currentLesson 前提（blind2 dbg 实锤）：p 过时（接管已把 currentLesson
      // 更新为低优源新值，挂起里还是旧主值）时写回会覆盖接管结果——段名卡主值
      if (cur && cur.bytes < SEG.minLessonSplitBytes) {
        if (p === currentLesson && cur.name !== p) { console.info("[rec] 段内容不足，lesson 变化只改名:", p); cur.name = p; }
        pendingLesson = "";
        return;
      }
      // URL 联动确认：真换课 = 课时名与本段开始后的 URL 都变过；纯名字变化
      //（开录识别收敛、弹窗期抖动）不切。
      const urlChangedSinceSeg = segStartAt > 0 && lastUrlChangeAt > segStartAt;
      if (p === currentLesson && !(cur && cur.name === p && cur.bytes > 0) && urlChangedSinceSeg) {
      // 排队成功不在此时清 pendingLesson——清除移至 doSplit 执行点（审计 M-d）：
      // 去抖 1.5s 窗内若被 stopAll（清 splitTimer）/ pause（doSplit 拒绝）打断，
      // 挂起保留由下轮 tick 重新排队，防换课信号丢失致两课并一文件
      if (requestSplit("lesson-change")) { /* 挂起保留，doSplit 成功时清 */ }
      } else if (p === currentLesson && cur && cur.name && cur.name !== p) {
        // 段名滞后于识别（blind2 复现实锤）：SPA 无 URL 变化的换课上，旧值先经
        // 快照填进段名，新课名沿被 applyLessonReport 的段名改写前提挡住只挂起，
        // 到这里又被 URL 联动闸丢弃 → 段名永久卡在场内首个识别值（路飞 5 课
        // 全名第一课）。同源识别值序列=同一内容粒度（p===currentLesson 即
        // applyLessonReport 已裁决接受的新值）→ 只改名**不切节**：URL 联动闸
        // 仍守切节，名字不再被丢
        console.info("[rec] 段名滞后于识别，只改名（URL 未变不切节）:", p);
        cur.name = p;
        pendingLesson = "";
      } else {
        pendingLesson = "";
      }
    }
  }

  // ---- 信号处理 ----
  // 多源竞争的两个修正语义（B 站实测驱动，路飞时序已推演兼容）：
  // ① 升级改写相关性前提：高 rank 值与已立段名互不包含（两个源在说不同的事，
  //    B 站 mediasession=合集总标题 vs active-item=分集名）→ 不改写段名——rank
  //    高不代表粒度细；有包含关系（路飞 doc-title 剥尾巴≈mediasession 课时名）
  //    才是同一内容的识别收敛，正常改写。
  // ② 降级挂起稳定接管：高 rank 源的值可能不随内容变化（B 站 mediasession 恒为
  //    合集标题），永久压制会变化的低 rank 分集名——降级值挂起观察，稳定 2s 且
  //    高 rank 值未变（变化会走正常路径并清挂起）→ 高 rank 源不反映内容粒度，
  //    接管命名（src 一并切换，高 rank 后续真变化仍可升级夺回）。
  let pendingLowerRank = null; // {name, src, at}

  const nameRelated = (a, b) => {
    const x = String(a || "").replace(/\s+/g, ""), y = String(b || "").replace(/\s+/g, "");
    return !x || !y || x === y || x.includes(y) || y.includes(x);
  };

  function applyLessonReport(name, src) {
    // 同名上报不影响竞争状态——曾在此撤降级挂起，但主值每 700ms 心跳同值上报
    // 会把备选源的接管计时反复清零，2s 稳定永不到达（B 站文件名恒合集标题）
    if (!name || name === currentLesson) return;
    const rank = SRC_RANK[src] || 0;
    const curRank = SRC_RANK[currentLessonSrc] || 0;
    if (currentLesson && rank < curRank) {
      // 来源降级：挂起观察（见函数头②）——稳定 2s 且高 rank 未变则接管。
      // **接管结算在 checkPendingSplits 的到期检查**（tick 每 500ms）——原实现
      // 依赖「下一次同值上报」结算，而 alt 沿消费后只剩 6s 周期的 forceReport，
      // 接管落后于切节落盘（blind2 实锤：第 3 段落盘名仍是主值）
      if (!(pendingLowerRank && pendingLowerRank.name === name && pendingLowerRank.src === src)) {
        pendingLowerRank = { name, src, at: now() };
      }
      return;
    }
    // 恒值回归防护（审计 M-e）：接管后高 rank 源每 700ms 心跳报回**同一个旧值**
    //（B 站 mediasession 合集标题），不是真变化——不夺回 currentLesson，消除
    // 接管/夺回的周期震荡。真换课时高 rank 值必与新值不同，正常通行
    if (prevHighRank && src === prevHighRank.src && name === prevHighRank.name) return;
    pendingLowerRank = null; // 正常路径到达 = 高 rank 值在变化，撤降级挂起
    // 来源升级仅限「识别源非空且优先级更高」。切段后 src 被清空，若空源也算
    // 升级，下一节首个上报就会误判升级并改写已有段名——合并段被命名成下一节
    // 的根因。空源 = 首次识别/重识别：只补空段名，不动已有段名。
    const isSourceUpgrade = !!currentLessonSrc && rank > curRank;
    currentLesson = name;
    currentLessonSrc = src;
    if (state === "recording" && mode === "segment") {
      // 升级改写加相关性前提（见函数头①）：无关值不覆盖已立段名
      if (cur && (!cur.name || (isSourceUpgrade && nameRelated(cur.name, name)))) cur.name = name;
      if (isSourceUpgrade) {
        console.info("[rec] 识别来源升级:", src, name); // 识别收敛，不切节
      } else if (cur) {
        // 同源值变化 = 真换课，挂起走稳定期
        pendingLesson = name;
        pendingLessonAt = now();
      }
    }
  }

  function onContent(data) {
    if (!data) return;
    if (data.lesson) applyLessonReport(stripLessonPrefix(data.lesson), String(data.lessonSrc || ""));
    // 帧内备选（active-item）：与主值并行竞争（B 站 mediaSession=合集总标题，
    // 分集名只能从这条通道到 offscreen——经降级挂起接管语义裁决）
    if (data.lessonAlt) applyLessonReport(stripLessonPrefix(data.lessonAlt), String(data.lessonAltSrc || "active-item"));
    if (data.url) onUrlChange(data.url);
    if (data.viewport && data.viewport.w > 0) {
      curViewport = data.viewport;
      // 视口漂移检测：与框选时快照不一致 = 选区坐标系变了（缩放/窗口调整/换
      // 显示器/全屏等），rect 是框选时刻视口坐标，映射必然错位——仅提示不阻断
      //（映射基准实际取开录时实时视口优先、框选快照兜底，见 buildCropStream）。
      // dpr 参与（v2.8.15）：换显示器窗口 CSS 尺寸恰好相同但 dpr 变也该提示；
      // 旧快照无 dpr（=0）不参与比较，不误报
      if (crop) {
        const sizeDrift = !(curViewport.w === crop.viewportW && curViewport.h === crop.viewportH);
        const dprDrift = !!(crop.dpr > 0 && curViewport.dpr > 0 && curViewport.dpr !== crop.dpr);
        viewportDrift = sizeDrift || dprDrift;
      }
    }
    if (data.playing) {
      // 任一帧有视频在播：刷新"最后在播"时刻（停播静默判定的基准）
      lastPlayingTs = now();
      hasPlayed = true;
      hasPlayedEver = true;
      endedLatchTs = 0; // 单段 ended 锁存解除（分片播放的分片间隙恢复，v2.3.1 同款语义）
      endedSeen = false; // 重新在播：弹窗入口的"播完"前提失效（暂停期控制栏按钮不算）
      silenceSplitFired = false;
      pendingEntryAt = 0; // 播放恢复：入口可见信号作废（播放中浮现的贴片「跳过」类误报）
      if (state === "between") resumeCapture(); // 播放恢复：立即续录（不等 URL 稳定）
    }
    if (data.advanceEntry) {
      // 连播入口（播完弹窗类）新出现：挂起待稳定确认。这是 playing/ended 信号
      // 不可见站点（保利威类加密播放器，video 对查询不可见）唯一的播完证据——
      // 播完弹窗出现即停录保存，末尾不再空录到连播点击跳转。
      if (state === "recording" && mode === "segment") pendingEntryAt = now();
    }
    if (data.advanceExit) {
      // 弹窗入口消失（被点掉）：between 态 = 立即续录（手动场景无点击回报）；
      // 录制态且曾有挂起 = 弹窗出现过又被点掉（点击早于 3s 稳定期）——立即停录
      // 保存旧节 + 续录，防止跳转后新节开播的画面吸进旧节尾部。pendingEntryAt
      // 前提防控制栏按钮淡出类误报（没挂起过就不动作）。
      if (state === "between") {
        resumeCapture();
      } else if (state === "recording" && mode === "segment" && pendingEntryAt
                 && cur && cur.bytes >= SEG.idleDiscardBytes) {
        resumeAfterBetween = true;
        finishSegmentForAdvance("advance-exit");
      }
    }
    if (data.ended) {
      endedSeen = true; // 弹窗入口信号的"播完"前提（暂停时控制栏按钮可见但 ended 未到）
      endedReportedEver = true; // 本站会报 ended——entryVisibleCheck 的盲区豁免据此关闭
      // ended 迟到重臂（审计 M-c）：入口挂起刚因"无 ended"被作废且作废未超过
      // 稳定期——入口仍可见（变化沿不会重发），从作废时刻起重算稳定期
      if (entryDismissedAt && now() - entryDismissedAt < SEG.entryStableMs
          && state === "recording" && mode === "segment") {
        pendingEntryAt = entryDismissedAt;
      }
      entryDismissedAt = 0;
      // 分节模式：ended 不直接动作（分片播放每分片都触发，v2.3.1——由停播/入口
      // 判定驱动切节）。单段模式：ended 锁存（5s 内 playing 恢复会清锁存 = 分片
      // 假信号）→ 自动停止整场——playing 信号盲区站（路飞类 iframe）的播完通道。
      if (mode === "single") endedLatchTs = now();
    }
  }

  // ---- 定时循环 ----
  let tickTimer = null, keepaliveTimer = null;
  function startLoops() {
    stopLoops();
    tickTimer = setInterval(tick, 500);
    keepaliveTimer = setInterval(() => {
      chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {});
    }, 2000);
    tick();
  }
  function stopLoops() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  }

  // 播完类停录公共尾（停播确认/入口可见/点击成功/URL 即刻切共用）：更新面板
  // 原因 + 占用全局切节间隔 + 立即广播连播 + 停录进节间
  function finishSegmentForAdvance(reason) {
    lastSplitAt = now(); // 停录切段也计入全局间隔（与 doSplit 同闸，防碎切）
    lastSplitInfo = { reason, at: now() }; // 面板「上次切节」可见（stopAll 路径此前不更新，真因不可见）
    pendingEntryAt = 0; // 停录即失效（续录后残留挂起会被 entryVisibleCheck 立即误停录）
    // 立即广播连播：停录 = 内容播完 = 弹窗正在出现。此前依赖 content 的 ended
    // 事件转发广播，跨域 iframe 信号缺失时只剩 45s 兜底，点击弹窗太慢。
    if (settings.autoNext !== false) {
      lastAdvanceBroadcast = now();
      chrome.runtime.sendMessage({ type: "broadcast-advance" }).catch(() => {});
    }
    // 停录保存当前节并进入节间等待（弹窗期不录制，跳转成功自动续录）
    stopAll("advance-pause", true);
  }

  // 停播静默：页面侧上报的"视频在播"信号（playing）消失 ≥5 秒 → 视为换节间隙。
  // 语义比音频/audible 更准：切节的本意就是"内容播完了"。曾播过（hasPlayed）才启用，
  // 开录初期未点播放时不会误切。
  function stoppedPlayingCheck() {
    if (state !== "recording") return;
    if (!hasPlayed) return; // 本场还没播过任何内容
    if (!(lastPlayingTs > segStartAt)) return; // 本段开始后未观察到过播放（重注入延迟期不启用）
    if (now() - lastPlayingTs < SEG.silenceSec * 1000) return;
    if (mode === "single") {
      // 单段模式：停播 5s = 视频播完/页面静止 → 结束整场（双通道之一，信号可见站）
      stopAll("video-stopped");
      return;
    }
    if (mode !== "segment") return;
    if (silenceSplitFired || now() - lastSilenceSplitAt < SEG.silenceGapMs) return;
    silenceSplitFired = true;
    lastSilenceSplitAt = now();
    finishSegmentForAdvance("advance-pause");
  }

  // 单段 ended 锁存停止：playing 盲区站（路飞类 iframe）的播完通道——ended 事件
  // 锁存 5s，分片间隙的 playing 恢复会清锁存（分片假信号不误停，v2.3.1 同款语义）
  function singleEndedCheck() {
    if (mode !== "single" || state !== "recording") return;
    if (!endedLatchTs || endedStopFired) return;
    if (now() - endedLatchTs < SEG.silenceSec * 1000) return;
    endedStopFired = true;
    stopAll("video-ended");
  }

  // 定时停止：有效录制时长（暂停/节间不计入）达到预设 → 结束整场（各状态通吃：
  // recording 停录保存当前段；between 干净结束——已录节全保留）
  function presetTimeCheck() {
    const presetSec = Number(payload.presetSeconds) > 0 ? Number(payload.presetSeconds) : 0;
    if (!presetSec) return;
    if (state !== "recording" && state !== "between") return;
    if (totalActiveMs() >= presetSec * 1000) stopAll("preset");
  }

  // 分节静默收工：恢复续录后持续无播放超过阈值 → 结束整场（补 between 循环
  // 永不结束的缺口）。按 hasPlayedEver 自动分档（用户建议的黑白名单制）：
  // playing 可见站走时间窗收工；盲区站（路飞）不适用，见 idleWrapCheck 内说明。
  let wrapStatus = null; // 收工判定真实状态（观测对齐 v2.8.6：面板倒计时与判定
  //   同源——{left:ms} 计时中 | {blocked:原因} 被挡 | null 未启用/已触发）
  function idleWrapCheck() {
    const wrapSec = Number(settings.silenceWrapSeconds) > 0 ? Number(settings.silenceWrapSeconds) : 0;
    if (!wrapSec || mode !== "segment" || state !== "recording" || !resumeTs) { wrapStatus = null; return; }
    if (hasPlayedEver) {
      // playing 可见站：续录后从未在播 → 收工（playing 已主视频化——暂停页的
      // 推荐浮层预览小窗自动播不再产生心跳，用户实锤的收工失效主因之一）
      if (lastPlayingTs >= resumeTs) { wrapStatus = { blocked: "页面在播" }; return; }
      const left = wrapSec * 1000 - (now() - resumeTs);
      if (left > 0) { wrapStatus = { left }; return; }
      wrapStatus = null;
      stopAll("idle-wrap");
      return;
    }
    // playing 盲区站（路飞 hasPlayedEver 恒 false）：路飞实锤（v2.8.11 诊断采集）——
    // 播放器 video 是空壳（paused=true/currentTime=0/尺寸 0x0），加密画面不经它
    // 渲染，「播放中 vs 暂停/卡死」在当前权限集（无 host 权限红线）内无信号可测，
    // 任何固定窗口必误杀其一。时间型收工整段退役（v2.8.14，用户拍板）：护栏
    // `lastUrlChangeAt>=resumeTs || lastSplitAt>=resumeTs` 结构性恒死——切节链路
    // 必把 resumeTs 刷新到两个时间戳之后（resumeCapture:356），v2.8.4~v2.8.12
    // 的每个窗口版本都因此在切下一节后误杀正常播放（本轮用户复验实锤；v2.8.9
    // 注释早已承认）。定稿：盲区站零时间型收工——连录永不被误杀；暂停/课程
    // 放完/弹窗卡死由面板提示手动停止，需自动停用「定时停止」（不依赖播放信号）
    wrapStatus = { blocked: "信号盲区：播放/暂停不可检测，请手动停止（可改用定时停止）" };
  }

  // 连播入口可见确认：播完弹窗类入口持续可见 → 内容已播完 → 停录进节间。
  // playing/ended 信号不可见站点（保利威类）的播完判定主通道；信号可达站点
  // 上 stopPlayingCheck 通常更快触发，两条路径先到先得，重复触发有状态锁互斥。
  function entryVisibleCheck() {
    if (state !== "recording" || mode !== "segment") return;
    if (!pendingEntryAt) return;
    if (!endedSeen && endedReportedEver) {
      // 播完前提：暂停时播放器控制栏的「下一集」按钮也可见，但 ended 未到——
      // 不是播完弹窗，不停录（否则暂停期间碎片循环）。记作废时刻：ended 若在
      // 3s 内迟到（content 事件与轮询的时序差）重臂挂起，防双盲站点通道失效。
      // 盲区豁免（endedReportedEver=false）：ended 信号不可见站点（保利威类）
      // 的弹窗入口是其唯一播完证据，不能要求 ended——否则播完主通道整场锁死
      //（路飞连播回归：弹窗挂着不切节、点击又被暂停守卫拦）
      pendingEntryAt = 0;
      entryDismissedAt = now();
      return;
    }
    if (now() - pendingEntryAt < SEG.entryStableMs) return;
    // 段内容前提：不足时**保留挂起**（blind2 取证实锤）——原实现清挂起后弹窗
    // 常驻可见不再有变化沿，通道死到 45s 兜底（切节多等半分钟）；保留挂起等
    // bytes 攒够后下一轮直接切，防误切前提（变化沿+稳定期）不变
    if (cur && cur.bytes < SEG.idleDiscardBytes) return;
    pendingEntryAt = 0;
    console.info("[rec] 连播入口持续可见 → 停录进节间");
    finishSegmentForAdvance("entry-visible");
  }

  function tick() {
    updateBadge();
    if (state === "stopping") { maybeFinish(); return; }
    presetTimeCheck();
    singleEndedCheck();
    idleWrapCheck();
    stoppedPlayingCheck();
    entryVisibleCheck();
    checkPendingSplits();
    // 连播定时兜底：播放器信号（ended/playing 上报）可能因跨域 iframe 全部缺失，
    // 分节模式下每 45 秒广播一次连播指令，保证弹窗类入口最迟一分钟内被点掉
    if (state === "recording" && mode === "segment" && settings.autoNext !== false
        && now() - lastAdvanceBroadcast >= SEG.advanceFallbackMs) {
      lastAdvanceBroadcast = now();
      chrome.runtime.sendMessage({ type: "broadcast-advance" }).catch(() => {});
    }
  }

  // ---- 消息入口 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 入口纵深防御（审计低项 v2.8.22）：本组件只接受扩展自身上下文（SW/popup/
    // 扩展页）的消息——正常链路全部如此（内容脚本经 SW 转发），异常来源直接拒
    if (sender.url && !String(sender.url).startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "untrusted sender" });
      return;
    }
    switch (msg && msg.type) {
      case "offscreen-schedule":
        try {
          sendResponse(schedule(msg));
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      case "offscreen-stop": sendResponse(stopAll("manual")); break;
      case "offscreen-stop-discard":
        // 停止不保存：丢弃当前未保存段（不 finalize），已落盘历史节保留
        sendResponse(stopAll("discard", false, true));
        break;
      case "offscreen-pause": sendResponse(pause()); break;
      case "offscreen-resume": sendResponse(resume()); break;
      case "offscreen-status": sendResponse(status()); break;
      case "offscreen-content": onContent(msg.data); sendResponse({ ok: true }); break;
      case "offscreen-url":
        onUrlChange(msg.url);
        sendResponse({ ok: true });
        break;
      case "offscreen-advance-clicked":
        // 连播点击成功 = 确定性切分点：
        // between 态 → 立即续录（早于 URL 稳定 3s 兜底，新节零丢失）；
        // 录制态 → 点击先于弹窗停录的 3s 稳定期（点击快/页面快）→ 立即停录保存
        // 旧节（此刻新节尚未开播，尾部干净）+ between 就绪后立即续录——否则
        // 停录/切段晚于新节开播，新节开头几秒会录进上一节文件
        if (state === "between") {
          resumeCapture();
        } else if (state === "stopping") {
          // 收尾期到达：若收尾去向是 between（advance-pause 类），就绪后立即续录
          //（原直接丢弃会退化为 30s 超时恢复，新节开头多等半分钟——审计低项）
          if (pauseAfterStop) resumeAfterBetween = true;
        } else if (state === "recording" && mode === "segment"
                   && cur && cur.bytes >= SEG.idleDiscardBytes
                   // 本段播过才认连播完成点击（暂停碎片根因，diag_pause 实锤）：
                   // 暂停态页面 URL 零变化、playing 静止，唯一的切段源是连播
                   // 点击链自持循环（切段→广播→冷却期满点暂停控制栏的 next 按钮
                   // →advance-clicked→又切段），周期 ≈ 点击冷却 15s+1s（B 站实测
                   // 16.0s 一个静止画面碎片）。真连播点击发生时旧节在播，本前提
                   // 恒成立；静止段的点击不构成「播完换内容」的切分依据。
                   //（v2.8.4 曾加 `|| !hasPlayedEver` 盲区豁免，v2.8.6 删除：doClick
                   // 的"成功"只代表找到可见元素（点击无导航效果也回报），盲区站
                   // 信任点击=循环燃料（用户 Chrome 实锤 advance-clicked 每 ~15s
                   // 切一个静止碎片）。盲区站连播恢复不依赖点击切分——走 between
                   // 态 resumeCapture（entry-visible 切节→between→广播→点击→恢复，
                   // v2.8.4 blind e2e 验证过的链路）
                   && lastPlayingTs > segStartAt) {
          resumeAfterBetween = true;
          finishSegmentForAdvance("advance-clicked");
        }
        sendResponse({ ok: true });
        break;
      case "offscreen-tab-closed": sendResponse(stopAll("tab-closed")); break;
      case "anchor-landed": {
        pendingAnchors.delete(msg.name);
        {
          const u = anchorURLs.get(msg.name);
          if (u) { anchorURLs.delete(msg.name); try { URL.revokeObjectURL(u); } catch (e) {} }
        }
        if (!msg.ok) console.warn("anchor save interrupted:", msg.name, msg.error || "");
        if (state === "stopping") maybeFinish();
        sendResponse({ ok: true });
        break;
      }
    }
  });
})();

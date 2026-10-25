// offscreen.js — 录制引擎：tabCapture 取流、音频回环、单段/自动分节、锚点直存
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
  let cropOut = null; // 实际输出尺寸 {w,h} 与映射参数 {vw,vh,scale,letterbox}
  let cropError = "";
  let captureSize = null; // 捕获帧尺寸 {w,h}（视频轨 getSettings，无裁剪时也可见）
  let curViewport = null; // 页面实时视口 {w,h,dpr}（顶层帧上报，变化沿）
  let viewportDrift = false; // 当前视口与框选快照不一致（裁剪位置可能偏移，面板警告）
  let audioCtx = null;
  let recorder = null;
  let mime = "";
  let ext = "mp4";

  let chunks = []; // 当前段
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
  const SEG = {
    debounceMs: 1500, silenceSec: 5,
    urlStableMs: 3000, // URL 变化需稳定这么久才切节：进度/token 类参数会持续变化，永不稳定→不切
    silenceGapMs: 30000, // 两次静默切节的最小间隔（防 audible 抖动）
    minSplitGapMs: 10000, // 全局最小切节间隔：未到间隔时挂起信号保留重试（不丢弃）
    lessonStableMs: 2000, // 课时名同源变化需稳定这么久才切节（滤网络抖动；语义判定见下）
    entryStableMs: 3000, // 连播入口（播完弹窗）持续可见这么久才停录：滤动画/闪现误报
    betweenTimeoutMs: 30000, // 节间等待超时：无恢复信号也自动续录（入口误报/加载过慢兜底）
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
  let lastSilenceSplitAt = 0;
  let segStartAt = 0; // 当前段开始时刻（lesson-change 的 URL 联动确认基准）
  let segLessonAtStart = ""; // 本段开始时的课时名快照（URL 切节的「课时名未变否决」基准）
  let pendingEntryAt = 0; // 连播入口（播完弹窗）可见挂起时刻：稳定期满停录进节间
  let betweenStartAt = 0; // 进入 between 的时刻（超时自动恢复用）
  let resumeAfterBetween = false; // 点击成功触发的停录：between 就绪后立即续录（跳转加载期连续录，新节零丢失）
  let lastSplitInfo = null; // {reason, at}——切节原因（面板临时显示，诊断用）
  let lastPlayingTs = 0; // 最近一次"页面有视频在播"的上报时刻
  let hasPlayed = false; // 本场录制是否出现过播放（停播静默判定的启用开关）
  let lastAdvanceBroadcast = 0; // 最近一次连播广播时刻（定时兜底用）

  // 识别标题（content-detect 级联上报）
  let currentLesson = "";
  let currentLessonSrc = "";

  // 锚点保存对账（多段并发落定）
  let anchorName = ""; // 最近一段文件名（展示用）
  const pendingAnchors = new Set();
  let finishDeadline = 0;

  // 捕获后移：倒计时期不取流（点开始瞬间几乎无动作，弹窗不会被顶掉），
  // 归零时才向 SW 要 streamId 开始捕获
  let pauseAfterStop = false; // 停止后进入 between（节间等待）而非完全结束
  let pendingSettings = null;
  let pendingPayload = null;
  let pendingTabId = null;
  let captureRequested = false;
  let startError = "";

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
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "");
    return s.slice(0, max);
  }

  function stripLessonPrefix(raw) {
    const p = settings.lessonPrefix || DEFAULTS.lessonPrefix;
    try {
      return String(raw || "").replace(new RegExp(p), "").trim();
    } catch {
      return String(raw || "").trim();
    }
  }

  function isJunkName(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(t)
      || /^[0-9a-f]{20,}$/i.test(t)
      || /^\d{10,}$/.test(t);
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
    const prefix = sanitize(courseFolder, 40);
    const lesson = sanitize(stripLessonPrefix(seg.name));
    const base = lesson && !isJunkName(lesson) ? lesson : `第${seg.seq}节`;
    const seq2 = String(seg.seq).padStart(2, "0");
    return prefix ? `${prefix}_${seq2}-${base}` : `${seq2}-${base}`;
  }

  function buildSingleName() {
    const d = new Date();
    const p2 = (v) => String(v).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const lesson = sanitize(stripLessonPrefix(currentLesson));
    if (lesson && !isJunkName(lesson)) return lesson;
    return `录制_${stamp}`;
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
    // 实测定律（diag_crop.py）：tabCapture 帧按 视口宽 统一缩放；当帧纵横比与视口
    // 不一致时垂直居中、上下补黑边（letterbox）。无黑边时 offset 自然为 0。
    const scale = crop.viewportW > 0 ? vw / crop.viewportW : 1;
    const letterbox = Math.max(0, (vh - crop.viewportH * scale) / 2);
    const r = crop.rect;
    const sx = Math.min(Math.max(0, Math.floor(r.x * scale)), vw - 2);
    const sy = Math.min(Math.max(0, Math.floor(r.y * scale + letterbox)), vh - 2);
    let sw = Math.min(vw - sx, Math.floor(r.w * scale));
    let sh = Math.min(vh - sy, Math.floor(r.h * scale));
    sw -= sw % 2; sh -= sh % 2; // H.264 yuv420 要求偶数尺寸
    if (sw < 16 || sh < 16) throw new Error("裁剪区域换算后过小");

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
    cropOut = { w: sw, h: sh, vw, vh, scale, letterbox, viewportW: crop.viewportW, viewportH: crop.viewportH }; // 映射参数入面板：缩放错位时对照两端数字
    return new MediaStream([
      canvasStream.getVideoTracks()[0],
      ...srcStream.getAudioTracks(),
    ]);
  }

  function destroyCropPipe() {
    if (!cropPipe) return;
    try { clearInterval(cropPipe.timer); } catch (e) {}
    try { cropPipe.canvasStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { cropPipe.video.srcObject = null; } catch (e) {}
    cropPipe = null;
  }

  function makeRecorder() {
    const r = new MediaRecorder(recStream, {
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

  function startSegment() {
    seq += 1;
    cur = { seq, name: currentLesson || "", chunks: [], bytes: 0 };
    activeBaseSeg = 0;
    segStartAt = now(); // lesson-change 的 URL 联动确认基准：本段开始后 URL 变过才算真换课
    segLessonAtStart = currentLesson || ""; // URL 切节「课时名未变否决」的基准（见 checkPendingSplits）
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
      state = "idle";
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
    // 帧尺寸约束：视口物理尺寸（ideal 语义，Chrome 按最接近档位给帧且内容等比
    // 渲染）——帧尺寸不约束时 Chrome 自行协商且会话间会漂（漂到非等比档位时
    // 裁剪映射变形，YouTube 实测「内容缩放错位」）
    const cap = pendingPayload && pendingPayload.capture;
    if (cap && cap.w > 0 && cap.h > 0) {
      videoMandatory.width = { ideal: cap.w };
      videoMandatory.height = { ideal: cap.h };
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: { mandatory: videoMandatory },
    });
    try {
      const vs = stream.getVideoTracks()[0].getSettings();
      captureSize = { w: vs.width || 0, h: vs.height || 0 };
    } catch (e) { captureSize = null; }

    // 回环：tabCapture 后原标签页静音，必须把音频接回扬声器才能边录边听。
    // 同时挂 AnalyserNode 实测音量——静默检测的信号源（tab.audible 在部分
    // Chrome 版本的 tabCapture 下不可靠，改用音频流直接分析）
    try {
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(audioCtx.destination);
      audioCtx.resume().catch(() => {});
    } catch (e) { console.warn("loopback failed", e); }

    stream.getVideoTracks()[0].addEventListener("ended", () => stopAll("stream-ended"));

    if (state !== "countdown") {
      // getUserMedia 期间被取消
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      chrome.runtime.sendMessage({ type: "recording-finished", summary: { cancelled: true } }).catch(() => {});
      return;
    }
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

    mime = pickMime(settings.format === "webm" ? "webm" : "mp4");
    ext = mime.startsWith("video/mp4") ? "mp4" : "webm";

    seq = 0;
    cur = null;
    segmentsDone = [];
    chunks = [];
    bytes = 0;
    currentLesson = "";
    currentLessonSrc = "";
    lastUrl = payload.tabUrl || "";
    lastUrlFp = urlFingerprint(lastUrl);
    urlLog = [];
    pendingUrl = "";
    lastUrlChangeAt = 0;
    pendingLesson = "";
    pendingLessonAt = 0;
    lastSilenceSplitAt = 0;
    segStartAt = 0;
    segLessonAtStart = "";
    pendingEntryAt = 0;
    betweenStartAt = 0;
    resumeAfterBetween = false;
    lastSplitInfo = null;
    lastPlayingTs = 0;
    hasPlayed = false;
    lastAdvanceBroadcast = 0;
    lastSplitAt = now(); // 启动静默期：开录 10 秒内不切节（v1 验证过的设计，v2 重写时丢失
                         // 导致全局闸从开录起失效——开录静默误切段、占闸挤掉真播完信号）
    silenceSplitFired = false;
    captureRequested = false;
    startError = "";
    recStream = null;
    cropOut = null;
    cropError = "";
    captureSize = null;
    curViewport = null;
    viewportDrift = false;
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
    try { recorder && recorder.state !== "inactive" && recorder.pause(); } catch (e) {}
    return { ok: true };
  }

  function resume() {
    if (state !== "paused") return { ok: false };
    resumeTs = now();
    state = "recording";
    try { recorder && recorder.state !== "inactive" && recorder.resume(); } catch (e) {}
    return { ok: true };
  }

  function stopAll(reason, keepOffscreen) {
    if (state === "stopping" || state === "idle") return { ok: true };
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (state === "between") {
      // 节间等待中手动停止：无未保存内容，干净结束整场
      state = "idle";
      stopLoops();
      updateBadge();
      chrome.runtime.sendMessage({ type: "recording-finished", summary: { cancelled: true } }).catch(() => {});
      return { ok: true };
    }
    if (state === "countdown" && !captureRequested) {
      // 预约期取消：尚未取流，干净退出、无任何文件
      state = "idle";
      stopLoops();
      updateBadge();
      chrome.runtime.sendMessage({ type: "recording-finished", summary: { cancelled: true } }).catch(() => {});
      return { ok: true };
    }
    pauseAfterStop = !!keepOffscreen;
    state = "stopping";
    if (splitTimer) { clearTimeout(splitTimer); splitTimer = null; }
    const deadline = now() + 300000; // 大文件落定上限 5 分钟
    if (resumeTs !== null) { const t = now(); activeBaseSeg += t - resumeTs; activeBaseTotal += t - resumeTs; resumeTs = null; }
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = () => finalizeSegment(cur).then(maybeFinish);
      try { recorder.stop(); } catch (e) { maybeFinish(); }
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
      anchorName = name;
      chrome.runtime.sendMessage({ type: "track-anchor", name }).catch(() => {});
      segmentsDone.push({ seq: seg.seq, name: seg.name, bytes: blob.size, filename: name });
    } finally {
      pendingFinalize -= 1;
    }
  }

  function maybeFinish() {
    if (state !== "stopping") return;
    if (pendingFinalize > 0) return; // 还有段的收尾没走完，等它把锚点注册进来
    if (pauseAfterStop) {
      // 切段进 between：不等锚点下载确认——offscreen 文档不关闭，下载由浏览器
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
      captureSize,
      curViewport,
      viewportDrift,
      urlLog: urlLog.slice(-2),
      error: startError,
    };
  }

  // ---- 分节信号 ----
  // 返回 true = 已接受（排队/执行）；false = 被全局间隔拒绝（调用方可保留挂起重试）
  function requestSplit(reason) {
    if (state !== "recording" || mode !== "segment") return false;
    if (now() - lastSplitAt < SEG.minSplitGapMs) {
      console.info("[rec] split 推迟（全局间隔未到）:", reason);
      return false;
    }
    if (splitTimer) return true; // 已在排队，去抖合并
    console.info("[rec] split signal:", reason);
    splitTimer = setTimeout(() => {
      splitTimer = null;
      doSplit(reason);
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
      return;
    }
    lastSplitAt = now();
    // 切段后识别状态重置：mediasession 等高优源的残留值不再挡住下一节识别
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
    recorder = null;
    if (!old || old.state === "inactive") { startSegment(); return; }
    old.onstop = () => {
      finalizeSegment(seg).then(maybeFinish); // 停止恰发生在切段收尾期间时，也要补完成判定
      if (state === "recording" || state === "paused") startSegment();
    };
    try { old.stop(); } catch (e) { console.warn(e); startSegment(); }
  }

  // URL 变化统一入口：只挂起不切节，等稳定期由 tick 判定（content 与 SW 两条路径都走这里）
  // 进度类参数：播放位置追踪（YouTube 播放中每 ~10s replaceState 更新 t），它们的
  // 变化不代表换内容——URL 模式（segUrlMode）按 URL 变化切节时必须先剥掉，否则
  // YouTube 全是 ~10s 碎片（t 变化周期恰与全局 10s 节流同频）。B 站 p、YouTube
  // v/list/index 等课时标识参数不在名单，变化正常生效。
  const PROGRESS_PARAM_KEYS = ["t", "t2", "time", "start", "progress", "at", "ts", "timestamp"];
  function urlFingerprint(url) {
    try {
      const u = new URL(url);
      PROGRESS_PARAM_KEYS.forEach((k) => u.searchParams.delete(k));
      u.hash = ""; // hash 是页面内状态（进度锚点等），不构成内容切换
      return u.origin + u.pathname + u.search;
    } catch (e) { return url; }
  }

  // URL 变化观测日志：记录每次变化的原样 URL 与指纹判定结果——「网址一变就切」
  // 的剥除名单基于假设（YouTube 用 &t= 记进度），真实变化模式以观测为准
  let urlLog = []; // 最近 5 条 {u, changed, at}

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
  }

  // tick 周期检查：URL/课时名挂起变化的稳定期判定（被全局闸拒绝时保留挂起，下轮重试）
  function checkPendingSplits() {
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
    if (settings.segUrlMode && pendingUrl && now() - lastUrlChangeAt >= 500
        && state === "recording" && now() - lastSplitAt >= SEG.minSplitGapMs
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
      if (cur && cur.bytes < SEG.minLessonSplitBytes) {
        if (cur.name !== p) { console.info("[rec] 段内容不足，lesson 变化只改名:", p); cur.name = p; }
        pendingLesson = "";
        return;
      }
      // URL 联动确认：真换课 = 课时名与本段开始后的 URL 都变过；纯名字变化
      //（开录识别收敛、弹窗期抖动）不切。
      const urlChangedSinceSeg = segStartAt > 0 && lastUrlChangeAt > segStartAt;
      if (p === currentLesson && !(cur && cur.name === p && cur.bytes > 0) && urlChangedSinceSeg) {
        if (requestSplit("lesson-change")) pendingLesson = "";
      } else {
        pendingLesson = "";
      }
    }
  }

  // ---- 信号处理 ----
  function onContent(data) {
    if (!data) return;
    if (data.lesson) {
      const name = stripLessonPrefix(data.lesson);
      const src = String(data.lessonSrc || "");
      if (name && name !== currentLesson) {
        const rank = SRC_RANK[src] || 0;
        const curRank = SRC_RANK[currentLessonSrc] || 0;
        if (currentLesson && rank < curRank) {
          // 来源降级（如播完弹窗期媒体元数据被清、跌到页面标题）：忽略，保持原值
          return;
        }
        // 来源升级仅限「识别源非空且优先级更高」。切段后 src 被清空，若空源也算
        // 升级，下一节首个上报就会误判升级并改写已有段名——合并段被命名成下一节
        // 的根因。空源 = 首次识别/重识别：只补空段名，不动已有段名。
        const isSourceUpgrade = !!currentLessonSrc && rank > curRank;
        currentLesson = name;
        currentLessonSrc = src;
        if (state === "recording" && mode === "segment") {
          if (cur && (!cur.name || isSourceUpgrade)) cur.name = name; // 未知段名补写 / 来源升级改写
          if (isSourceUpgrade) {
            console.info("[rec] 识别来源升级:", src, name); // 识别收敛，不切节
          } else if (cur) {
            // 同源值变化 = 真换课，挂起走稳定期
            pendingLesson = name;
            pendingLessonAt = now();
          }
        }
      }
    }
    if (data.course && !courseFolder) courseFolder = sanitize(data.course, 40);
    if (data.url) onUrlChange(data.url);
    if (data.viewport && data.viewport.w > 0) {
      curViewport = data.viewport;
      // 视口漂移检测：与框选时快照不一致 = 裁剪映射基准变了（缩放/窗口调整/
      // 全屏等），选区位置可能偏移——仅提示不阻断（映射仍按框选快照，行为可预期）
      if (crop) viewportDrift = !(curViewport.w === crop.viewportW && curViewport.h === crop.viewportH);
    }
    if (data.playing) {
      // 任一帧有视频在播：刷新"最后在播"时刻（停播静默判定的基准）
      lastPlayingTs = now();
      hasPlayed = true;
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
      // 播完信号挂起：不立即停录——加密播放器（分片播放）的每个分片结束都会触发
      // ended，直接停录会把一节课切成碎片段。统一交给停播判定：视频 5 秒内恢复
      // 播放 = 分片假信号（计数重置不切）；持续无播放 ≥5 秒 = 真播完 → 停录保存
      // + 广播连播（stoppedPlayingCheck 驱动）。ended 本身不再产生切节。
    }
  }

  function onAudible(audible) {
    // tab.audible 在部分 Chrome 的 tabCapture 下不可靠，静默检测已改用
    // offscreen 内 AnalyserNode 实测音量（tick 里），本消息仅保留协议兼容
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
    if (state !== "recording" || mode !== "segment") return;
    if (!hasPlayed) return; // 本场还没播过任何内容
    if (!(lastPlayingTs > segStartAt)) return; // 本段开始后未观察到过播放（重注入延迟期不启用）
    if (now() - lastPlayingTs < SEG.silenceSec * 1000) return;
    if (silenceSplitFired || now() - lastSilenceSplitAt < SEG.silenceGapMs) return;
    silenceSplitFired = true;
    lastSilenceSplitAt = now();
    finishSegmentForAdvance("advance-pause");
  }

  // 连播入口可见确认：播完弹窗类入口持续可见 → 内容已播完 → 停录进节间。
  // playing/ended 信号不可见站点（保利威类）的播完判定主通道；信号可达站点
  // 上 stopPlayingCheck 通常更快触发，两条路径先到先得，重复触发有状态锁互斥。
  function entryVisibleCheck() {
    if (state !== "recording" || mode !== "segment") return;
    if (!pendingEntryAt) return;
    if (now() - pendingEntryAt < SEG.entryStableMs) return;
    pendingEntryAt = 0;
    if (cur && cur.bytes < SEG.idleDiscardBytes) return; // 段无实质内容（开录初期常驻元素首报）不停录
    console.info("[rec] 连播入口持续可见 → 停录进节间");
    finishSegmentForAdvance("entry-visible");
  }

  function tick() {
    updateBadge();
    if (state === "stopping") { maybeFinish(); return; }
    stoppedPlayingCheck();
    entryVisibleCheck();
    checkPendingSplits();
    // 连播定时兜底：播放器信号（ended/playing 上报）可能因跨域 iframe 全部缺失，
    // 分节模式下每 45 秒广播一次连播指令，保证弹窗类入口最迟一分钟内被点掉
    if (state === "recording" && mode === "segment" && settings.autoNext !== false
        && now() - lastAdvanceBroadcast >= 45000) {
      lastAdvanceBroadcast = now();
      chrome.runtime.sendMessage({ type: "broadcast-advance" }).catch(() => {});
    }
  }

  // ---- 消息入口 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "offscreen-schedule":
        try {
          sendResponse(schedule(msg));
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      case "offscreen-stop": sendResponse(stopAll("manual")); break;
      case "offscreen-pause": sendResponse(pause()); break;
      case "offscreen-resume": sendResponse(resume()); break;
      case "offscreen-status": sendResponse(status()); break;
      case "offscreen-content": onContent(msg.data); sendResponse({ ok: true }); break;
      case "offscreen-url":
        onUrlChange(msg.url);
        sendResponse({ ok: true });
        break;
      case "offscreen-audible": onAudible(!!msg.audible); sendResponse({ ok: true }); break;
      case "offscreen-advance-clicked":
        // 连播点击成功 = 确定性切分点：
        // between 态 → 立即续录（早于 URL 稳定 3s 兜底，新节零丢失）；
        // 录制态 → 点击先于弹窗停录的 3s 稳定期（点击快/页面快）→ 立即停录保存
        // 旧节（此刻新节尚未开播，尾部干净）+ between 就绪后立即续录——否则
        // 停录/切段晚于新节开播，新节开头几秒会录进上一节文件
        if (state === "between") {
          resumeCapture();
        } else if (state === "recording" && mode === "segment"
                   && cur && cur.bytes >= SEG.idleDiscardBytes) {
          resumeAfterBetween = true;
          finishSegmentForAdvance("advance-clicked");
        }
        sendResponse({ ok: true });
        break;
      case "offscreen-tab-closed": sendResponse(stopAll("tab-closed")); break;
      case "anchor-landed": {
        pendingAnchors.delete(msg.name);
        if (!msg.ok) console.warn("anchor save interrupted:", msg.name, msg.error || "");
        if (state === "stopping") maybeFinish();
        sendResponse({ ok: true });
        break;
      }
      case "keepalive": {
        sendResponse({ ok: true });
        break;
      }
    }
  });
})();

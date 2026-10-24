// offscreen.js — 录制引擎：tabCapture 取流、音频回环、单段/自动分节、锚点直存
// 生命周期独立于 popup 和 service worker（USER_MEDIA reason 无时限）。

(() => {
  let state = "idle"; // idle | countdown | recording | paused | stopping
  let mode = "single"; // single | segment
  let settings = {};
  let payload = {};
  let stream = null;
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
  let silenceSince = null;
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
    silenceCooldownMs: 15000, // 静默切节后的冷却：期间 audible=true 不重新武装静默信号
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
  let lastSplitWasIdle = false; // 上次切段是否播完/静默类（此后首个 URL 稳定切段的黑屏小段应丢弃）
  let segStartAt = 0; // 当前段开始时刻（lesson-change 的 URL 联动确认基准）
  let lastSplitInfo = null; // {reason, at}——切节原因（面板临时显示，诊断用）

  // 识别标题（content-detect 级联上报）
  let currentLesson = "";
  let currentLessonSrc = "";

  // 锚点保存对账（多段并发落定）
  let anchorName = ""; // 最近一段文件名（展示用）
  const pendingAnchors = new Set();
  let finishDeadline = 0;

  // 捕获后移：倒计时期不取流（点开始瞬间几乎无动作，弹窗不会被顶掉），
  // 归零时才向 SW 要 streamId 开始捕获
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

  function makeRecorder() {
    const r = new MediaRecorder(stream, {
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
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: { mandatory: videoMandatory },
    });

    // 回环：tabCapture 后原标签页静音，必须把音频接回扬声器才能边录边听
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
    pendingUrl = "";
    lastUrlChangeAt = 0;
    pendingLesson = "";
    pendingLessonAt = 0;
    lastSilenceSplitAt = 0;
    lastSplitWasIdle = false;
    segStartAt = 0;
    lastSplitInfo = null;
    lastSplitAt = now(); // 启动静默期：开录 10 秒内不切节（v1 验证过的设计，v2 重写时丢失
                         // 导致全局闸从开录起失效——开录静默误切段、占闸挤掉真播完信号）
    silenceSince = null;
    silenceSplitFired = false;
    captureRequested = false;
    startError = "";
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

  function stopAll(reason) {
    if (state === "stopping" || state === "idle") return { ok: true };
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (state === "countdown" && !captureRequested) {
      // 预约期取消：尚未取流，干净退出、无任何文件
      state = "idle";
      stopLoops();
      updateBadge();
      chrome.runtime.sendMessage({ type: "recording-finished", summary: { cancelled: true } }).catch(() => {});
      return { ok: true };
    }
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
    lastSplitWasIdle = reason === "silence-gap" || reason === "video-ended";
    // 切段后识别状态重置：mediasession 等高优源的残留值不再挡住下一节识别
    //（下一节的首个识别值从任意源接受，随后来源升级继续收敛）
    currentLessonSrc = "";
    lastSplitInfo = { reason, at: now() };
    // 播完/静默类切段 = 页面正停在「等待人工点下一节」的状态 → 触发自动连播。
    // url-change 切段说明页面已自行跳转，再点会跳过一节，不广播。
    // 不依赖 video ended 事件：加密播放器（保利威类）不一定触发它。
    if (lastSplitWasIdle && settings.autoNext !== false) {
      chrome.runtime.sendMessage({ type: "broadcast-advance" }).catch(() => {});
    }
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
  function onUrlChange(url) {
    if (!url || url === lastUrl) return;
    lastUrl = url;
    pendingUrl = url;
    lastUrlChangeAt = now();
  }

  // tick 周期检查：URL/课时名挂起变化的稳定期判定（被全局闸拒绝时保留挂起，下轮重试）
  function checkPendingSplits() {
    if (state !== "recording" || mode !== "segment") { pendingUrl = ""; pendingLesson = ""; return; }
    if (pendingUrl && now() - lastUrlChangeAt >= SEG.urlStableMs) {
      // 前置：课时名/段名未识别时 URL 变化一律不切段（切了也无法正确命名；识别到位后段名自然补写）。
      // 开录后点播放常使播放器给 URL 加参数——这条前置拦住由此产生的开录碎片段
      if (!currentLesson || !cur || !cur.name) {
        pendingUrl = "";
        return;
      }
      // 第二道闸：换课必换标题——课时名与当前段相同且本段已有数据，视为同课误报
      if (cur && cur.name && cur.name === currentLesson && cur.bytes > 0) {
        console.info("[rec] url 稳定但课时名未变，不切节");
        pendingUrl = "";
      } else if (lastSplitWasIdle && cur && cur.bytes > 0 && cur.bytes < SEG.idleDiscardBytes) {
        // 连播点击进下一节：当前段是弹窗期黑屏小段 → 清空缓冲丢弃（recorder 不断流、
        // 段号不跳；cur.name 保留旧值，让课时名信号自然完成下一次切段）
        console.info("[rec] 丢弃节间黑屏小段:", cur.bytes, "bytes");
        bytes -= cur.bytes;
        cur.chunks = [];
        cur.bytes = 0;
        cur.name = currentLesson; // 新节内容直接用已识别的新课时名
        activeBaseSeg = 0;
        lastSplitWasIdle = false;
        pendingUrl = "";
      } else if (requestSplit("url-change")) {
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
        const isSourceUpgrade = currentLesson && rank > curRank;
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
    if (data.ended && state === "recording" && mode === "segment") {
      requestSplit("video-ended"); // 播完是强信号，不受稳定期约束
    }
  }

  function onAudible(audible) {
    if (audible) {
      // 静默切节后的冷却期内不重新武装（audible 抖动无法借此绕过 30s 间隔）
      if (now() - lastSilenceSplitAt >= SEG.silenceCooldownMs) {
        silenceSince = null;
        silenceSplitFired = false;
      }
    } else if (state === "recording" && mode === "segment") {
      if (silenceSince === null) silenceSince = now();
      if (!silenceSplitFired && now() - silenceSince >= SEG.silenceSec * 1000
          && now() - lastSilenceSplitAt >= SEG.silenceGapMs) {
        silenceSplitFired = true;
        lastSilenceSplitAt = now();
        requestSplit("silence-gap");
      }
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

  function tick() {
    updateBadge();
    if (state === "stopping") { maybeFinish(); return; }
    checkPendingSplits();
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

// offscreen.js — 录制引擎：tabCapture 取流、音频回环、MediaRecorder、锚点直存
// 生命周期独立于 popup 和 service worker（USER_MEDIA reason 无时限）。

(() => {
  let state = "idle"; // idle | countdown | recording | paused | stopping
  let settings = {};
  let payload = {};
  let stream = null;
  let audioCtx = null;
  let recorder = null;
  let mime = "";
  let ext = "mp4";

  let chunks = [];
  let bytes = 0;
  let activeBase = 0; // 录制计时（暂停不计入）
  let resumeTs = null;
  const now = () => Date.now();

  // 识别标题（content-detect 级联上报，单段命名用）
  let currentLesson = "";
  let currentLessonSrc = "";

  // 锚点保存对账
  let anchorName = "";
  let anchorPending = false;
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

  function buildName() {
    const d = new Date();
    const p2 = (v) => String(v).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const lesson = sanitize(stripLessonPrefix(currentLesson));
    if (lesson && !isJunkName(lesson)) return lesson;
    return `录制_${stamp}`;
  }

  function makeRecorder() {
    const r = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Number(settings.videoBitrate) || 4000000,
      audioBitsPerSecond: Number(settings.audioBitrate) || 128000,
    });
    r.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunks.push(e.data);
        bytes += e.data.size;
      }
    };
    return r;
  }

  function beginRecording() {
    if (state !== "recording") return;
    resumeTs = now();
    recorder = makeRecorder();
    recorder.start(1000);
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

    mime = pickMime(settings.format === "webm" ? "webm" : "mp4");
    ext = mime.startsWith("video/mp4") ? "mp4" : "webm";

    chunks = [];
    bytes = 0;
    currentLesson = "";
    currentLessonSrc = "";
    captureRequested = false;
    startError = "";
    activeBase = 0;
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
    activeBase += t - resumeTs;
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
    if (state === "countdown" && !captureStarted) {
      // 预约期取消：尚未取流，干净退出、无任何文件
      state = "idle";
      stopLoops();
      updateBadge();
      chrome.runtime.sendMessage({ type: "recording-finished", summary: { cancelled: true } }).catch(() => {});
      return { ok: true };
    }
    state = "stopping";
    finishDeadline = now() + 300000; // 大文件落定上限 5 分钟
    if (resumeTs !== null) { const t = now(); activeBase += t - resumeTs; resumeTs = null; }
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = () => finalize().then(maybeFinish);
      try { recorder.stop(); } catch (e) { maybeFinish(); }
    } else {
      maybeFinish();
    }
    return { ok: true };
  }

  // 锚点直存：File（带名字）+ <a download>——用户 Chrome 实测唯一 100% 正确命名的通道
  async function finalize() {
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    anchorName = `${buildName()}.${ext}`;
    const url = URL.createObjectURL(new File([blob], anchorName, { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = anchorName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    anchorPending = true;
    chrome.runtime.sendMessage({ type: "track-anchor", name: anchorName }).catch(() => {});
    return;
  }

  function maybeFinish() {
    if (state !== "stopping") return;
    if (anchorPending && now() <= finishDeadline) return;
    state = "idle";
    stopLoops();
    destroyExtra();
    chrome.runtime.sendMessage({
      type: "recording-finished",
      summary: { name: anchorName, bytes, saveErrors: [] },
    }).catch(() => {});
  }

  function destroyExtra() {
    try { audioCtx && audioCtx.close(); } catch (e) {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  }

  function status() {
    return {
      state, mime, ext,
      countdown: state === "countdown" ? Math.max(0, Math.ceil((countEndTs - now()) / 1000)) : 0,
      lesson: { name: currentLesson, src: currentLessonSrc },
      bytes,
      activeMs: activeBase + (resumeTs ? now() - resumeTs : 0),
      anchorName: anchorPending ? anchorName : "",
      error: startError,
    };
  }

  // ---- 信号处理 ----
  function onContent(data) {
    if (!data) return;
    if (data.lesson) {
      const name = stripLessonPrefix(data.lesson);
      if (name && name !== currentLesson) {
        currentLesson = name;
        currentLessonSrc = String(data.lessonSrc || "");
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
      case "offscreen-tab-closed": sendResponse(stopAll("tab-closed")); break;
      case "anchor-landed": {
        anchorPending = false;
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

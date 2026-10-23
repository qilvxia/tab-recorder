// offscreen.js — 录制引擎：tabCapture 取流、音频回环、按课时分节、自动停止、分文件落盘
// 生命周期独立于 popup 和 service worker（USER_MEDIA reason 无时限），多 GB blob 由浏览器自动落盘。

(() => {
  let state = "idle"; // idle | countdown | recording | paused | stopping
  let mode = "single"; // single | segment
  let settings = {};
  let payload = {};
  let stream = null;
  let audioCtx = null;
  let recorder = null;
  let mime = "";
  let ext = "webm";

  // 延时开始：取流/回环/裁剪管线先就绪，倒计时结束才建 recorder 开录（不计入时长）
  let countdownTimer = null;
  let countEndTs = 0;

  // 区域裁剪：recStream 为真正交给 MediaRecorder 的流（裁剪时是 canvas 合成流）
  let crop = null; // {rect:{x,y,w,h}, viewportW, viewportH}
  let cropOut = null; // 实际裁剪输出尺寸 {w,h}
  let cropError = "";
  let cropPipe = null; // {video, canvas, canvasStream, timer}
  let recStream = null;

  // 当前段与已完成段
  let cur = null; // {seq, name, chunks[], bytes, filename}
  let seq = 0;
  let segmentsDone = []; // {seq, name, bytes, filename}

  // 计时（暂停不计入）
  let activeBaseSeg = 0, activeBaseTotal = 0, resumeTs = null;
  const now = () => Date.now();
  const segActiveMs = () => activeBaseSeg + (resumeTs ? now() - resumeTs : 0);
  const totalActiveMs = () => activeBaseTotal + (resumeTs ? now() - resumeTs : 0);

  // 分节信号
  let currentLesson = "";
  let currentLessonSrc = "";
  let courseFolder = "";
  let lastUrl = "";
  let endedLatchTs = 0;
  let endedStopFired = false;
  let lastSplitAt = 0;
  let splitTimer = null;
  let silentSince = null;
  let silenceSplitFired = false;

  // 落盘对账
  let pendingSaves = new Map(); // token -> url
  let saveToken = 0;
  let saveErrors = [];
  let saveNotices = []; // 非致命提示（如浏览器忽略指定文件名的降级说明）
  let renameNoticed = false;
  let finishDeadline = 0;
  let pendingFinalize = 0; // 正在收尾（blob→保存注册）的段数：防止"未注册先判完成"的竞态

  const DEFAULTS = {
    segOnEnded: true, segOnUrl: true, segOnSilence: true,
    segSilenceSeconds: 5, segDebounceMs: 1500,
    lessonPrefix: "^正在播放[:：]\\s*",
  };

  function sanitize(s, max = 80) {
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

  function pickMime(want) {
    const mp4s = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
    const webms = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (const m of want === "webm" ? [...webms, ...mp4s] : [...mp4s, ...webms]) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  // 站点把播放器内部 ID 当页面标题时，产出的是这类无意义名字——识别出来换兜底名
  function isJunkName(s) {
    const t = String(s || "");
    if (!t) return true;
    return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(t)
      || /^[0-9a-f]{20,}$/i.test(t)
      || /^\d{10,}$/.test(t);
  }

  function buildFilename(seg) {
    const base = String(settings.saveSubdir || "").split(/[\\/]/).map((s) => sanitize(s, 60)).filter(Boolean).join("/");
    const pre = base ? base + "/" : "";
    if (mode === "segment") {
      const folder = sanitize(courseFolder, 60) || "课程";
      const rawName = sanitize(seg.name, 80);
      // 识别出的名字本身是 UUID 之类垃圾时，退回序号名，保证分节可区分
      const name = rawName && !isJunkName(rawName) ? rawName : `第${seg.seq}节`;
      return `${pre}${folder}/${String(seg.seq).padStart(2, "0")}-${name}.${ext}`;
    }
    const tpl = settings.filenameTemplate || "{title}_{date}-{time}";
    const d = new Date();
    const p2 = (v) => String(v).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const title = sanitize(payload.tabTitle, 60) || "录制";
    // 优先级：手填文件名 > 识别到的播放标题 > 模板；最终名统一过垃圾名兜底
    let s = payload.fileName ? sanitize(payload.fileName, 120) : "";
    if (!s) {
      const lesson = sanitize(currentLesson, 120);
      if (lesson && !isJunkName(lesson)) s = lesson;
    }
    if (!s) {
      s = tpl
        .replace(/\{title\}/g, title)
        .replace(/\{date\}/g, `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`)
        .replace(/\{time\}/g, `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`)
        .replace(/\{seq\}/g, String(seg.seq).padStart(2, "0"));
    }
    if (isJunkName(s)) s = `录制_${stamp}`; // 任何路径都不允许产出 UUID 式乱码文件名
    return `${pre}${sanitize(s, 150) || "录制"}.${ext}`;
  }

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
    cropOut = { w: sw, h: sh };
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
      }
    };
    return r;
  }

  function beginRecording() {
    if (state !== "countdown") return;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    resumeTs = now();
    state = "recording";
    console.info("[rec] begin");
    startSegment();
  }

  function startSegment() {
    seq += 1;
    cur = { seq, name: currentLesson || "", chunks: [], bytes: 0 };
    activeBaseSeg = 0;
    if (resumeTs === null) resumeTs = now();
    recorder = makeRecorder();
    recorder.start(1000);
  }

  async function finalizeSegment(seg) {
    if (!seg || !seg.chunks.length) return;
    pendingFinalize += 1; // 同步段先计数：stopAll 的 maybeFinish 不会在保存注册前抢跑
    try {
      const blob = new Blob(seg.chunks, { type: mime });
      seg.chunks = [];
      const filename = buildFilename(seg);
      seg.filename = filename;
      const url = URL.createObjectURL(blob);
      const token = ++saveToken;
      pendingSaves.set(token, url);
      try {
        const resp = await chrome.runtime.sendMessage({ type: "save", url, filename, token });
        if (!resp || !resp.ok) {
          pendingSaves.delete(token);
          URL.revokeObjectURL(url);
          saveErrors.push(filename + ((resp && resp.error) ? `（${resp.error}）` : ""));
        }
      } catch (e) {
        pendingSaves.delete(token);
        URL.revokeObjectURL(url);
        saveErrors.push(filename);
      }
      segmentsDone.push({ seq: seg.seq, name: seg.name, bytes: blob.size, filename });
    } finally {
      pendingFinalize -= 1;
    }
  }

  function requestSplit(reason) {
    if (state !== "recording" || mode !== "segment") return;
    const debounce = Number(settings.segDebounceMs) || DEFAULTS.segDebounceMs;
    if (now() - lastSplitAt < debounce || splitTimer) return;
    console.info("[rec] split signal:", reason);
    splitTimer = setTimeout(() => {
      splitTimer = null;
      doSplit();
    }, debounce);
  }

  function doSplit() {
    if (state !== "recording" || mode !== "segment") return;
    lastSplitAt = now();
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

  async function start(msg) {
    settings = Object.assign({}, DEFAULTS, msg.settings || {});
    payload = msg.payload || {};
    mode = payload.mode === "segment" ? "segment" : "single";
    courseFolder = sanitize(payload.courseFolder || "", 60);

    mime = pickMime(settings.format === "webm" ? "webm" : "mp4");
    ext = mime.startsWith("video/mp4") ? "mp4" : "webm";

    const videoMandatory = { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId };
    const fps = Number(settings.frameRate);
    if (fps > 0) videoMandatory.maxFrameRate = fps;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } },
      video: { mandatory: videoMandatory },
    });

    // 区域裁剪（可选）：构建 canvas 合成流，失败自动回退全画面
    crop = payload.crop && payload.crop.rect ? payload.crop : null;
    cropError = "";
    cropOut = null;
    recStream = stream;
    if (crop) {
      try {
        recStream = await buildCropStream(stream);
      } catch (e) {
        crop = null;
        cropError = String(e && e.message || e);
        recStream = stream;
      }
    }

    // 回环：tabCapture 后原标签页静音，必须把音频接回扬声器才能边录边听
    try {
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(audioCtx.destination);
      audioCtx.resume().catch(() => {});
    } catch (e) { console.warn("loopback failed", e); }

    stream.getVideoTracks()[0].addEventListener("ended", () => stopAll("stream-ended"));

    seq = 0;
    segmentsDone = [];
    saveErrors = [];
    saveNotices = [];
    renameNoticed = false;
    pendingSaves = new Map();
    currentLesson = "";
    currentLessonSrc = "";
    lastUrl = payload.tabUrl || "";
    endedLatchTs = 0;
    endedStopFired = false;
    silentSince = null;
    silenceSplitFired = false;
    lastSplitAt = now(); // 启动静默期：吞掉首个课时名/首屏信号
    activeBaseTotal = 0;
    state = "countdown";
    startLoops();
    const delaySec = Math.min(60, Math.max(0, Number(payload.startDelaySeconds) || 0));
    if (delaySec > 0) {
      countEndTs = now() + delaySec * 1000;
      countdownTimer = setInterval(() => {
        if (state === "countdown" && now() >= countEndTs) beginRecording();
      }, 200);
      console.info("[rec] countdown:", delaySec, "s");
    } else {
      beginRecording();
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

  let finishTimer = null;
  function stopAll(reason) {
    if (state === "stopping" || state === "idle") return { ok: true };
    console.info("[rec] stopping:", reason);
    if (splitTimer) { clearTimeout(splitTimer); splitTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    state = "stopping";
    finishDeadline = now() + 300000; // 下载回执最迟 5 分钟（锚点通道大文件可能较慢），否则放弃等待
    const old = recorder;
    const seg = cur;
    recorder = null;
    if (resumeTs !== null) { const t = now(); activeBaseSeg += t - resumeTs; activeBaseTotal += t - resumeTs; resumeTs = null; }
    if (old && old.state !== "inactive") {
      old.onstop = () => {
        finalizeSegment(seg).then(maybeFinish);
      };
      try { old.stop(); } catch (e) { maybeFinish(); }
    } else {
      maybeFinish();
    }
    return { ok: true };
  }

  function maybeFinish() {
    if (state !== "stopping") return;
    if (pendingFinalize > 0) return; // 还有段的收尾没走完，等它把保存注册进来
    if (pendingSaves.size === 0 || now() > finishDeadline) {
      state = "idle";
      stopLoops();
      destroyCropPipe();
      try { audioCtx && audioCtx.close(); } catch (e) {}
      try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      chrome.runtime.sendMessage({
        type: "recording-finished",
        summary: { mode, segments: segmentsDone, saveErrors, saveNotices, title: { name: currentLesson, src: currentLessonSrc } },
      }).catch(() => {});
    }
  }

  function status() {
    return {
      state, mode, mime, ext,
      countdown: state === "countdown" ? Math.max(0, Math.ceil((countEndTs - now()) / 1000)) : 0,
      lesson: { name: currentLesson, src: currentLessonSrc },
      courseFolder: courseFolder || sanitize(payload.courseFolder || "", 60),
      current: cur ? { seq: cur.seq, name: cur.name, activeMs: segActiveMs(), bytes: cur.bytes } : null,
      segmentsDone,
      totalActiveMs: totalActiveMs(),
      pendingSaves: pendingSaves.size,
      saveErrors,
      saveNotices,
      crop: cropOut,
      cropError,
      splitArmed: !!splitTimer,
    };
  }

  // ---- 信号处理 ----
  function onContent(data) {
    if (!data) return;
    if (data.lesson) {
      const name = stripLessonPrefix(data.lesson);
      if (name && name !== currentLesson) {
        const isFirst = !currentLesson;
        currentLesson = name;
        currentLessonSrc = String(data.lessonSrc || "");
        if (state === "recording" && mode === "segment") {
          if (cur && !cur.name) cur.name = name; // 段名为空随时可补写——晚到的标题也能命名本段
          if (!isFirst && settings.segOnUrl !== false) requestSplit("lesson-change");
        }
      }
    }
    if (data.course && !courseFolder) courseFolder = sanitize(data.course, 60);
    if (data.url && data.url !== lastUrl) {
      const isFirstUrl = !lastUrl;
      lastUrl = data.url;
      if (!isFirstUrl && state === "recording" && mode === "segment" && settings.segOnUrl !== false) {
        requestSplit("url-change");
      }
    }
    if (data.ended) {
      endedLatchTs = now();
      if (state === "recording") {
        if (mode === "single" && settings.stopOnVideoEnd !== false) {
          // 停止交给 tick 里 1.2s 确认，避免误触发
        } else if (mode === "segment" && settings.segOnEnded !== false) {
          requestSplit("video-ended");
        }
      }
    }
  }

  function onAudible(audible) {
    if (audible) {
      silentSince = null;
      silenceSplitFired = false;
    } else {
      if (silentSince === null) silentSince = now();
      const silentFor = now() - silentSince;
      if (state === "recording" && mode === "segment" && settings.segOnSilence !== false && !silenceSplitFired) {
        const th = (Number(settings.segSilenceSeconds) || DEFAULTS.segSilenceSeconds) * 1000;
        if (silentFor >= th) { silenceSplitFired = true; requestSplit("silence-gap"); }
      }
    }
  }

  // ---- 定时循环 ----
  let tickTimer = null, keepaliveTimer = null;
  let lastBadge = "";
  // 面板可能被关（下载气泡抢焦点等），徽章上始终能看到倒计时/录制状态
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
  function startLoops() {
    stopLoops();
    tickTimer = setInterval(tick, 500);
    keepaliveTimer = setInterval(() => {
      // 心跳保活 SW，SW 回报标签页 audible
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
    if (state !== "recording") return;
    const total = totalActiveMs();
    const presetSec = Number(payload.presetSeconds) > 0
      ? Number(payload.presetSeconds)
      : (Number(payload.presetMinutes) || 0) * 60; // 旧版字段回退
    if (presetSec > 0 && total >= presetSec * 1000) return void stopAll("preset");
    const maxMs = (Number(settings.maxDurationMinutes) || 0) * 60000;
    if (maxMs > 0 && total >= maxMs) return void stopAll("max-duration");
    const stopSec = Number(settings.silenceStopSeconds) || 0;
    if (stopSec > 0 && silentSince !== null && now() - silentSince >= stopSec * 1000) {
      return void stopAll("silence-stop");
    }
    if (mode === "single" && settings.stopOnVideoEnd !== false && !endedStopFired &&
        endedLatchTs && now() - endedLatchTs >= 1200) {
      endedStopFired = true;
      return void stopAll("video-ended");
    }
  }

  // ---- 消息入口 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "offscreen-start":
        start(msg).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
      case "offscreen-stop": sendResponse(stopAll("manual")); break;
      case "offscreen-pause": sendResponse(pause()); break;
      case "offscreen-resume": sendResponse(resume()); break;
      case "offscreen-status": sendResponse(status()); break;
      case "offscreen-content": onContent(msg.data); sendResponse({ ok: true }); break;
      case "offscreen-url":
        if (msg.url && msg.url !== lastUrl) {
          const first = !lastUrl;
          lastUrl = msg.url;
          if (!first && state === "recording" && mode === "segment" && settings.segOnUrl !== false) requestSplit("url-change(sw)");
        }
        sendResponse({ ok: true });
        break;
      case "offscreen-audible": onAudible(!!msg.audible); sendResponse({ ok: true }); break;
      case "offscreen-tab-closed": sendResponse(stopAll("tab-closed")); break;
      case "download-complete": {
        const url = pendingSaves.get(msg.token);
        if (url) {
          pendingSaves.delete(msg.token);
          URL.revokeObjectURL(url);
          if (!msg.ok) saveErrors.push("下载中断");
        }
        if (msg.renamed && !renameNoticed) {
          renameNoticed = true;
          saveNotices.push(`浏览器忽略了扩展指定的文件名，已保存为「${msg.savedName || "浏览器默认名"}」（内容完整；建议更新浏览器版本）`);
        }
        if (state === "stopping") maybeFinish();
        sendResponse({ ok: true });
        break;
      }
      case "anchor-save": {
        // SW 命名降级链的最后手段：<a download> 走导航层命名路径
        try {
          const a = document.createElement("a");
          a.href = msg.url;
          a.download = msg.name || "";
          document.body.appendChild(a);
          a.click();
          a.remove();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
    }
  });
})();

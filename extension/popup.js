// popup.js — 控制面板：开始/暂停/停止、模式与预设、状态轮询
const $ = (id) => document.getElementById(id);
const DEFAULT_SETTINGS = {
  format: "mp4", videoBitrate: 4000000, frameRate: 30, audioBitrate: 128000,
  stopOnVideoEnd: true, silenceStopSeconds: 0, maxDurationMinutes: 360,
  segOnEnded: true, segOnUrl: true, segOnSilence: true, segSilenceSeconds: 5, segDebounceMs: 1500,
  lessonSelector: "h1", lessonPrefix: "^正在播放[:：]\\s*", courseSelector: "",
  startDelaySeconds: 0, heartbeatInject: true, autoLiveWindow: true,
  saveSubdir: "TabRecorder", filenameTemplate: "{title}_{date}-{time}",
};

let uiMode = "single";
let presetMode = "off"; // off | custom
let tabInfo = null;
let pollTimer = null;

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (v) => String(v).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}
function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

const SRC_LABEL = {
  mediasession: "媒体元数据",
  selector: "选择器",
  "active-item": "目录高亮",
  "playing-label": "播放中标签",
  "video-title": "视频属性",
  "doc-title": "页面标题",
};

// "HH:MM:SS"（时可为 1-3 位）→ 秒；格式非法返回 -1
function parseDuration(text) {
  const m = /^(\d{1,3}):([0-5]?\d):([0-5]?\d)$/.exec(String(text || "").trim());
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function loadSettings() {
  const st = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, st.settings || {});
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabInfo = tab ? { id: tab.id, title: tab.title || "录制", url: tab.url || "" } : null;

  const s = await loadSettings();
  const mbps = (s.videoBitrate / 1e6).toFixed(s.videoBitrate % 1e6 ? 1 : 0);
  $("fmtHint").textContent = `${s.format === "webm" ? "WebM (VP9)" : "MP4 (H.264)"} · ${mbps} Mbps · ${s.frameRate}fps（可在设置中修改）`;

  // 预填课程目录名：用站点域名，用户可改
  try {
    const host = new URL(tabInfo.url).hostname.replace(/^www\./, "");
    $("courseFolder").value = host;
  } catch (e) { $("courseFolder").value = ""; }

  setMode("single");
  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  render(st && st.state !== "idle" ? st : null);

  $("modeSingle").onclick = () => setMode("single");
  $("modeSegment").onclick = () => setMode("segment");
  $("presetChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chipBtn");
    if (!b) return;
    presetMode = b.dataset.mode === "custom" ? "custom" : "off";
    [...$("presetChips").children].forEach((x) => x.classList.toggle("active", x === b));
    $("presetTime").classList.toggle("hidden", presetMode !== "custom");
    if (presetMode === "custom") $("presetTime").focus();
    else $("presetTime").value = "";
  });
  $("presetChips").children[0].classList.add("active");

  $("startDelay").value = Math.min(60, Math.max(0, Number(s.startDelaySeconds) || 0));
  $("startDelay").onchange = async () => {
    const v = Math.min(60, Math.max(0, Math.round(Number($("startDelay").value) || 0)));
    $("startDelay").value = v;
    const cur = await loadSettings();
    cur.startDelaySeconds = v;
    await chrome.storage.local.set({ settings: cur });
  };

  $("startBtn").onclick = startRecording;
  $("cropPickBtn").onclick = pickCropRegion;
  $("cropClearBtn").onclick = async () => {
    await chrome.storage.session.remove("cropRegion").catch(() => {});
    refreshCropRow();
  };
  // 选区浮层确认后（popup 可能仍开着）实时刷新状态
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.cropRegion) refreshCropRow();
  });
  refreshCropRow();
  $("stopBtn").onclick = async () => {
    $("stopBtn").disabled = true;
    await chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
    pollSoon(300);
  };
  $("pauseBtn").onclick = async () => {
    const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
    const t = st && st.state === "paused" ? "resume" : "pause";
    await chrome.runtime.sendMessage({ type: t }).catch(() => {});
    pollSoon(200);
  };
  $("optionsLink").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  $("liveLink").onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "open-live" }).catch(() => {}); };
  $("helpLink").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://developer.chrome.com/docs/extensions/reference/api/tabCapture" });
  };
}

function setMode(m) {
  uiMode = m;
  $("modeSingle").classList.toggle("active", m === "single");
  $("modeSegment").classList.toggle("active", m === "segment");
  $("courseRow").classList.toggle("hidden", m !== "segment");
  $("fileRow").classList.toggle("hidden", m !== "single");
}

// ---- 录制区域（会话级：绑定标签页，跨录制保留） ----
async function getCropRegion() {
  const st = await chrome.storage.session.get("cropRegion").catch(() => ({}));
  const cr = st.cropRegion;
  return cr && cr.rect && cr.tabId === (tabInfo && tabInfo.id) ? cr : null;
}

async function refreshCropRow() {
  const cr = await getCropRegion();
  $("cropLabel").textContent = cr ? `已选 ${cr.rect.w}×${cr.rect.h} px` : "全画面";
  $("cropClearBtn").classList.toggle("hidden", !cr);
}

async function pickCropRegion() {
  if (!tabInfo || tabInfo.id == null) return;
  if (tabInfo.url && /^(chrome|edge|about|chrome-extension):/i.test(tabInfo.url)) {
    showErr("浏览器内置页面（chrome:// 等）无法注入选区浮层。");
    return;
  }
  const resp = await chrome.runtime.sendMessage({ type: "select-crop-region", tabId: tabInfo.id })
    .catch((e) => ({ ok: false, error: String(e) }));
  if (!resp || !resp.ok) {
    showErr("无法注入选区浮层：" + ((resp && resp.error) || "未知错误"));
  }
  // 注入成功后用户会点击页面画框，popup 失焦关闭属正常
}

async function startRecording() {
  if (!tabInfo || tabInfo.id == null) return;
  if (tabInfo.url && /^(chrome|edge|about|chrome-extension):/i.test(tabInfo.url)) {
    showErr("浏览器内置页面（chrome:// 等）无法录制，请切到普通网页。");
    return;
  }
  let presetSeconds = 0;
  if (presetMode === "custom") {
    presetSeconds = parseDuration($("presetTime").value);
    if (!(presetSeconds > 0)) {
      showErr("自定义时长格式应为 00:00:00（时:分:秒），且不能为 0。");
      return;
    }
  }
  const settings = await loadSettings();
  const payload = {
    mode: uiMode,
    courseFolder: uiMode === "segment" ? $("courseFolder").value.trim() : "",
    fileName: uiMode === "single" ? $("fileNameInput").value.trim() : "",
    startDelaySeconds: Math.min(60, Math.max(0, Number($("startDelay").value) || 0)),
    presetSeconds,
    tabTitle: tabInfo.title,
    tabUrl: tabInfo.url,
  };
  const cr = await getCropRegion();
  if (cr) payload.crop = { rect: cr.rect, viewportW: cr.viewportW, viewportH: cr.viewportH };
  $("startBtn").disabled = true;
  $("startBtn").textContent = "正在启动…";
  const resp = await chrome.runtime.sendMessage({ type: "start", tabId: tabInfo.id, settings, payload }).catch((e) => ({ ok: false, error: String(e) }));
  if (!resp || !resp.ok) {
    showErr("启动失败：" + ((resp && resp.error) || "未知错误"));
    $("startBtn").disabled = false;
    $("startBtn").textContent = "开始录制当前标签页";
    return;
  }
  pollSoon(250);
}

function showErr(text) {
  let el = document.querySelector(".err");
  if (!el) {
    el = document.createElement("div");
    el.className = "err";
    $("idleBox").appendChild(el);
  }
  el.textContent = text;
}

function pollSoon(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  render(st);
  pollTimer = setTimeout(poll, 1000);
}

function render(st) {
  const recording = st && st.state && st.state !== "idle";
  $("idleBox").classList.toggle("hidden", recording);
  $("recBox").classList.toggle("hidden", !recording);
  if (!recording) {
    $("stateChip").className = "chip idle";
    $("stateChip").textContent = "空闲";
    if (st && st.last) {
      const n = (st.last.segments || []).length;
      const errs = (st.last.saveErrors || []).length;
      const t = st.last.title && st.last.title.name
        ? `，识别标题「${st.last.title.name}」`
        : (n ? "，未识别到标题" : "");
      const notice = (st.last.saveNotices || []).length ? `，${st.last.saveNotices[0]}` : "";
      $("lastResult").textContent = n ? `上次：${n} 个文件${errs ? `，${errs} 个失败` : ""}${t}${notice}` : "";
    }
    return;
  }
  if (pollTimer === null) poll(); // 首次进入录制态启动轮询

  const chip = $("stateChip");
  if (st.state === "countdown") { chip.className = "chip paused"; chip.textContent = `延时中 ${st.countdown || 0}s`; }
  else if (st.state === "paused") { chip.className = "chip paused"; chip.textContent = "已暂停"; }
  else if (st.state === "stopping") { chip.className = "chip saving"; chip.textContent = "保存中"; }
  else { chip.className = "chip rec"; chip.textContent = "录制中"; }

  $("pauseBtn").textContent = st.state === "paused" ? "继续" : "暂停";
  $("pauseBtn").disabled = st.state === "stopping" || st.state === "countdown";
  $("stopBtn").disabled = st.state === "stopping";

  if (st.state === "countdown") {
    $("curLesson").textContent = `${st.countdown || 0} 秒后开始录制…`;
    $("curSeq").textContent = st.mode === "segment" ? "自动分节" : "";
    $("segTime").textContent = "00:00";
    $("detTitle").textContent = "";
  } else if (st.current) {
    const liveLesson = (st.lesson && st.lesson.name) || "";
    $("curLesson").textContent = st.current.name || liveLesson ||
      (st.mode === "segment" ? "正在识别课时名…" : "单段录制中");
    $("curSeq").textContent = st.mode === "segment" ? `第 ${st.current.seq} 节` : "";
    $("segTime").textContent = fmtDur(st.current.activeMs);
    const les = st.lesson || {};
    if (les.name) {
      $("detTitle").textContent = `识别标题（${SRC_LABEL[les.src] || les.src || "未知来源"}）：${les.name}` +
        ($("fileNameInput").value.trim() ? "（已手动指定文件名，将优先使用）" : "");
    } else {
      $("detTitle").textContent = "识别标题：未识别到（各来源均落空；可用 F12 定位课时名元素，把选择器填到设置页）" +
        ($("fileNameInput").value.trim() ? "（已手动指定文件名，将优先使用）" : "");
    }
  }
  $("segCount").textContent = (st.segmentsDone || []).length + " 节";
  $("totalTime").textContent = fmtDur(st.totalActiveMs || 0);
  const totalBytes = (st.current ? st.current.bytes : 0) + (st.segmentsDone || []).reduce((a, b) => a + b.bytes, 0);
  $("totalSize").textContent = fmtMB(totalBytes);
  $("saving").textContent = st.pendingSaves || 0;

  const tips = [];
  if (st.state === "stopping") tips.push("正在保存文件，请勿关闭浏览器…");
  if (st.crop) tips.push(`仅录制所选区域（${st.crop.w}×${st.crop.h}）。`);
  if (st.cropError) tips.push("区域裁剪启动失败，已按全画面录制：" + st.cropError);
  if (st.saveErrors && st.saveErrors.length) tips.push(`有 ${st.saveErrors.length} 个文件保存失败：` + st.saveErrors[0]);
  if (st.saveNotices && st.saveNotices.length) tips.push(st.saveNotices[0]);
  if (st.mime && !st.mime.startsWith("video/mp4")) tips.push("当前浏览器不支持直录 MP4，已自动改用 WebM。");
  $("recTip").textContent = tips.join(" ");
}

document.addEventListener("DOMContentLoaded", init);

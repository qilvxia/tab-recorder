// popup.js — 控制面板：延时开始、开始/暂停/停止、状态轮询
const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  format: "mp4", videoBitrate: 4000000, frameRate: 30, audioBitrate: 128000,
  startDelaySeconds: 0,
  lessonSelector: "h1", lessonPrefix: "^正在播放[:：]\\s*",
};

const SRC_LABEL = {
  mediasession: "媒体元数据",
  selector: "选择器",
  "active-item": "目录高亮",
  "playing-label": "播放中标签",
  "video-title": "视频属性",
  "doc-title": "页面标题",
};

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

async function loadSettings() {
  const st = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, st.settings || {});
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabInfo = tab ? { id: tab.id, title: tab.title || "录制", url: tab.url || "" } : null;

  const s = await loadSettings();
  const mbps = (s.videoBitrate / 1e6).toFixed(s.videoBitrate % 1e6 ? 1 : 0);
  $("fmtHint").textContent = `${s.format === "webm" ? "WebM (VP9)" : "MP4 (H.264)"} · ${mbps} Mbps · ${s.frameRate}fps`;
  $("startDelay").value = Math.min(60, Math.max(0, Number(s.startDelaySeconds) || 0));
  $("startDelay").onchange = async () => {
    const v = Math.min(60, Math.max(0, Math.round(Number($("startDelay").value) || 0)));
    $("startDelay").value = v;
    const cur = await loadSettings();
    cur.startDelaySeconds = v;
    await chrome.storage.local.set({ settings: cur });
  };

  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  render(st && st.state !== "idle" ? st : null);

  $("startBtn").onclick = startRecording;
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
}

async function startRecording() {
  if (!tabInfo || tabInfo.id == null) return;
  if (tabInfo.url && /^(chrome|edge|about|chrome-extension):/i.test(tabInfo.url)) {
    showErr("浏览器内置页面（chrome:// 等）无法录制，请切到普通网页。");
    return;
  }
  const settings = await loadSettings();
  const payload = {
    startDelaySeconds: Math.min(60, Math.max(0, Number($("startDelay").value) || 0)),
    tabTitle: tabInfo.title,
    tabUrl: tabInfo.url,
  };
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
  el.style.color = "#e5484d";
  el.style.fontSize = "11.5px";
  el.style.marginTop = "6px";
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
    $("startBtn").disabled = false;
    $("startBtn").textContent = "开始录制当前标签页";
    if (st && st.last) {
      $("lastResult").textContent = st.last.name
        ? `上次：${st.last.name}（${fmtMB(st.last.bytes)}）`
        : "";
    }
    return;
  }
  if (pollTimer === null) poll();

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
    $("segTime").textContent = "00:00";
    $("detTitle").textContent = "";
  } else {
    const les = st.lesson || {};
    $("curLesson").textContent = les.name || "单段录制中";
    $("segTime").textContent = fmtDur(st.activeMs || 0);
    $("detTitle").textContent = les.name
      ? `识别标题（${SRC_LABEL[les.src] || les.src || "未知来源"}）：${les.name}`
      : "识别标题：未识别到（将用「录制_时间」命名）";
  }
  $("totalTime").textContent = fmtDur(st.activeMs || 0);
  $("totalSize").textContent = fmtMB(st.bytes || 0);

  const tips = [];
  if (st.state === "stopping") tips.push("正在保存文件，请勿关闭浏览器…");
  $("recTip").textContent = tips.join(" ");
}

document.addEventListener("DOMContentLoaded", init);

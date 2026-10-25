// popup.js — 控制面板：延时开始、开始/暂停/停止、状态轮询
const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  format: "mp4", videoBitrate: 4000000, frameRate: 30, audioBitrate: 128000,
  startDelaySeconds: 0, autoNext: true, segUrlMode: false,
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
let uiMode = "single"; // single | segment

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

  $("modeSingle").onclick = () => setMode("single");
  $("modeSegment").onclick = () => setMode("segment");
  setMode("single");

  // 课程名默认预填站点域名，可改
  try {
    const host = new URL(tabInfo.url).hostname.replace(/^www\./, "");
    $("courseFolder").value = host;
  } catch (e) { $("courseFolder").value = ""; }
  $("autoNext").checked = s.autoNext !== false;
  $("autoNext").onchange = async () => {
    const cur = await loadSettings();
    cur.autoNext = $("autoNext").checked;
    await chrome.storage.local.set({ settings: cur });
  };
  $("segUrlMode").checked = s.segUrlMode === true;
  $("segUrlMode").onchange = async () => {
    const cur = await loadSettings();
    cur.segUrlMode = $("segUrlMode").checked;
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
}

function setMode(m) {
  uiMode = m;
  $("modeSingle").classList.toggle("active", m === "single");
  $("modeSegment").classList.toggle("active", m === "segment");
  $("courseRow").classList.toggle("hidden", m !== "segment");
}

// ---- 录制区域（会话级：绑定标签页，跨录制保留；换 tab 失效） ----
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
  const settings = await loadSettings();
  const payload = {
    mode: uiMode,
    courseFolder: uiMode === "segment" ? $("courseFolder").value.trim() : "",
    startDelaySeconds: Math.min(60, Math.max(0, Number($("startDelay").value) || 0)),
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
      if (st.last.error) {
        $("lastResult").textContent = "启动失败：" + st.last.error + "（请在播放页重新点开始）";
      } else if (st.last.cancelled) {
        $("lastResult").textContent = "已取消，未录制任何内容。";
      } else if ((st.last.segments || []).length > 1) {
        $("lastResult").textContent = `上次：${st.last.segments.length} 个文件`;
      } else if ((st.last.segments || []).length === 1) {
        const s = st.last.segments[0];
        $("lastResult").textContent = `上次：${s.filename}（${fmtMB(s.bytes)}）`;
      } else {
        $("lastResult").textContent = "";
      }
    }
    return;
  }
  if (pollTimer === null) poll();

  const chip = $("stateChip");
  if (st.state === "countdown") { chip.className = "chip paused"; chip.textContent = `延时中 ${st.countdown || 0}s`; }
  else if (st.state === "between") { chip.className = "chip paused"; chip.textContent = "等待下一节"; }
  else if (st.state === "paused") { chip.className = "chip paused"; chip.textContent = "已暂停"; }
  else if (st.state === "stopping") { chip.className = "chip saving"; chip.textContent = "保存中"; }
  else { chip.className = "chip rec"; chip.textContent = "录制中"; }

  $("pauseBtn").textContent = st.state === "paused" ? "继续" : "暂停";
  $("pauseBtn").disabled = st.state === "stopping" || st.state === "countdown" || st.state === "between";
  $("stopBtn").disabled = st.state === "stopping";

  if (st.state === "countdown") {
    $("curLesson").textContent = `${st.countdown || 0} 秒后开始录制…`;
    $("curSeq").textContent = st.mode === "segment" ? "自动分节" : "";
    $("detTitle").textContent = "";
  } else if (st.state === "between") {
    const les = st.lesson || {};
    $("curLesson").textContent = `已保存第 ${st.seq} 节，等待下一节开始…`;
    $("curSeq").textContent = st.mode === "segment" ? "自动分节" : "";
    $("detTitle").textContent = les.name ? `识别标题：${les.name}` : "";
    $("segCount").textContent = (st.segCount || 0) + " 节";
    $("totalTime").textContent = fmtDur(st.totalMs || 0);
    $("totalSize").textContent = fmtMB(st.bytes || 0);
    const tips2 = [];
    if (st.error) tips2.push("节间恢复失败：" + st.error);
    $("recTip").textContent = tips2.join(" ");
    return;
  } else {
    const les = st.lesson || {};
    $("curLesson").textContent = les.name || (st.mode === "segment" ? "正在识别课时名…" : "单段录制中");
    $("curSeq").textContent = st.mode === "segment" ? `第 ${st.seq} 节` : "";
    const les2 = les.name
      ? `识别标题（${SRC_LABEL[les.src] || les.src || "未知来源"}）：${les.name}`
      : "识别标题：未识别到（该节将命名为「第N节」）";
    $("detTitle").textContent = les2;
  }
  $("segCount").textContent = (st.segCount || 0) + " 节";
  $("segTime").textContent = fmtDur(st.segMs || 0);
  $("totalTime").textContent = fmtDur(st.totalMs || 0);
  $("totalSize").textContent = fmtMB(st.bytes || 0);

  const tips = [];
  if (st.state === "stopping") tips.push("正在保存文件，请勿关闭浏览器…");
  if (st.crop) tips.push(`仅录制所选区域（${st.crop.w}×${st.crop.h}）。`);
  if (st.cropError) tips.push("区域裁剪启动失败，已按全画面录制：" + st.cropError);
  if (st.signals) {
    tips.push(`播放信号：${st.signals.hasPlayed ? "✓ 已到达" : "✗ 未收到（停播判定不启用，播完靠弹窗入口信号）"}`);
  }
  if (st.lastSplit) {
    const d = new Date(st.lastSplit.at);
    const p2 = (v) => String(v).padStart(2, "0");
    tips.push(`上次切节：${st.lastSplit.reason}（${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}）`);
  }
  $("recTip").textContent = tips.join(" ");
}

document.addEventListener("DOMContentLoaded", init);

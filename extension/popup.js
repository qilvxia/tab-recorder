// popup.js — 控制面板：延时开始、开始/暂停/停止、状态轮询
const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  format: "mp4", videoBitrate: 4000000, frameRate: 30, audioBitrate: 128000,
  startDelaySeconds: 0, autoNext: true, segUrlMode: false, silenceWrapSeconds: 60,
  recordKind: "av",
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
let presetMode = "off"; // off | custom

// 00:00:00（时:分:秒）→ 秒；非法返回 -1
function parseDuration(s) {
  const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(String(s || "").trim());
  if (!m) return -1;
  const h = +m[1], mi = +m[2], se = +m[3];
  if (mi > 59 || se > 59) return -1;
  return h * 3600 + mi * 60 + se;
}

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

async function saveSetting(key, value) {
  const cur = await loadSettings();
  cur[key] = value;
  await chrome.storage.local.set({ settings: cur });
}

const isBrowserPage = (url) => !!(url && /^(chrome|edge|about|chrome-extension):/i.test(url));

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
    await saveSetting("startDelaySeconds", v);
  };

  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  render(st && st.state !== "idle" ? st : null);

  $("modeSingle").onclick = () => { setMode("single"); saveSetting("uiMode", "single"); };
  $("modeSegment").onclick = () => { setMode("segment"); saveSetting("uiMode", "segment"); };
  setMode(s.uiMode === "segment" ? "segment" : "single");

  // 课程名：同一站点恢复上次填写的名称（跨站点仍预填域名）
  let courseHost = "";
  try { courseHost = new URL(tabInfo.url).hostname.replace(/^www\./, ""); } catch (e) {}
  const savedNames = s.courseNameByHost || {};
  $("courseFolder").value = savedNames[courseHost] || courseHost;
  $("courseFolder").onchange = async () => {
    if (!courseHost) return;
    const names = ((await loadSettings()).courseNameByHost) || {};
    names[courseHost] = $("courseFolder").value.trim();
    await saveSetting("courseNameByHost", names);
  };
  $("autoNext").checked = s.autoNext !== false;
  $("autoNext").onchange = async () => {
    await saveSetting("autoNext", $("autoNext").checked);
  };
  $("segUrlMode").checked = s.segUrlMode === true;
  $("segUrlMode").onchange = async () => {
    await saveSetting("segUrlMode", $("segUrlMode").checked);
  };
  $("silenceWrap").value = Math.min(600, Math.max(0, Number(s.silenceWrapSeconds ?? 60) || 0));
  $("silenceWrap").onchange = async () => {
    const v = Math.min(600, Math.max(0, Math.round(Number($("silenceWrap").value) || 0)));
    $("silenceWrap").value = v;
    await saveSetting("silenceWrapSeconds", v);
  };
  // 定时停止 chips：恢复上次选择（不限/自定义 + 时长；时长存原样字符串，
  // 启动时 parseDuration 仍严格校验，存了非法串不影响安全）
  presetMode = s.presetMode === "custom" ? "custom" : "off";
  $("presetChips").querySelectorAll(".chipBtn").forEach((b) => b.classList.toggle("active", b.dataset.mode === presetMode));
  $("presetTime").classList.toggle("hidden", presetMode !== "custom");
  $("presetTime").value = s.presetTime || "00:00:00";
  $("presetChips").querySelectorAll(".chipBtn").forEach((btn) => {
    btn.onclick = () => {
      presetMode = btn.dataset.mode;
      saveSetting("presetMode", presetMode);
      $("presetChips").querySelectorAll(".chipBtn").forEach((b) => b.classList.toggle("active", b === btn));
      $("presetTime").classList.toggle("hidden", presetMode !== "custom");
      if (presetMode === "custom") $("presetTime").focus();
    };
  });
  $("presetTime").onchange = () => saveSetting("presetTime", $("presetTime").value.trim());
  // 录制内容三选（音视频/仅视频/仅音频——仅音频输出 webm）
  $("kindChips").querySelectorAll(".chipBtn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.kind === (s.recordKind || "av"));
    btn.onclick = async () => {
      $("kindChips").querySelectorAll(".chipBtn").forEach((b) => b.classList.toggle("active", b === btn));
      await saveSetting("recordKind", btn.dataset.kind);
    };
  });
  // 高级设置（v1 默认值：4Mbps / 30fps / 128kbps）
  $("videoBitrate").value = (s.videoBitrate || 4000000) / 1e6;
  $("frameRate").value = s.frameRate || 30;
  $("audioBitrate").value = s.audioBitrate || 128000;
  for (const [id, key, mul] of [["videoBitrate", "videoBitrate", 1e6], ["frameRate", "frameRate", 1], ["audioBitrate", "audioBitrate", 1]]) {
    $(id).onchange = async () => {
      await saveSetting(key, Math.max(1, Number($(id).value) || 0) * mul);
    };
  }
  // 单段手填文件名：恢复上次填写（一次性名字，全局单值）
  $("fileNameInput").value = s.lastFileName || "";
  $("fileNameInput").onchange = () => saveSetting("lastFileName", $("fileNameInput").value.trim());

  $("startBtn").onclick = startRecording;
  $("diagBtn").onclick = runRecognitionDiag;
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
  // 停止不保存：二次确认（点击变「确认丢弃？」3 秒未点恢复）——误触直接丢整段不可接受
  let discardArmed = 0;
  $("discardBtn").onclick = async () => {
    const btn = $("discardBtn");
    if (!discardArmed) {
      discardArmed = setTimeout(() => {
        discardArmed = 0;
        btn.textContent = "停止不保存";
        btn.classList.remove("armed");
      }, 3000);
      btn.textContent = "确认丢弃？";
      btn.classList.add("armed");
      return;
    }
    clearTimeout(discardArmed);
    discardArmed = 0;
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: "stop-discard" }).catch(() => {});
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
  $("fileRow").classList.toggle("hidden", m !== "single");
  $("wrapRow").classList.toggle("hidden", m !== "segment");
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
  if (isBrowserPage(tabInfo.url)) {
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
  if (isBrowserPage(tabInfo.url)) {
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
    presetSeconds,
    startDelaySeconds: Math.min(60, Math.max(0, Number($("startDelay").value) || 0)),
    tabUrl: tabInfo.url,
  };
  const cr = await getCropRegion();
  if (cr) payload.crop = { rect: cr.rect, viewportW: cr.viewportW, viewportH: cr.viewportH };
  // 捕获帧尺寸约束（物理像素）：Chrome 对 tabCapture 的帧尺寸自行协商且会话间
  // 会漂（实测漂到 16:10 档位 2240×1400 而窗口视口非等比）→ 内容非等比拉伸进帧，
  // 裁剪映射变形。显式请求「视口×dpr」让帧与视口内容等比，映射恢复成立。
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabInfo.id },
      func: () => ({
        w: Math.round(window.innerWidth * window.devicePixelRatio),
        h: Math.round(window.innerHeight * window.devicePixelRatio),
        cw: window.innerWidth, ch: window.innerHeight,
      }),
    });
    const cap = res && res.result;
    if (cap && cap.w > 0 && cap.h > 0) payload.capture = cap;
    // 开录时刻的视口（css）：帧与视口非等比时（Chrome 窗口化把画面拉伸进整屏帧）
    // 裁剪映射按此横纵独立换算的基准
    if (cap && cap.cw > 0 && cap.ch > 0) payload.viewport = { w: cap.cw, h: cap.ch };
  } catch (e) { /* 读不到视口（受限页等）就不约束，维持 Chrome 默认协商 */ }
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

// 识别诊断 v2（v2.8.9）：全帧采集播放状态——每帧 video 清单 + currentTime
// 双采样推进检测（事件可被站点绕过，currentTime 属性推进是播放铁证）+
// 顶层 mediaSession.playbackState + 播放器控制按钮 aria。数据走 executeScript
//（扩展消息通道），console.clear 反调试管不着；结果复制到剪贴板
async function runRecognitionDiag() {
  if (!tabInfo || tabInfo.id == null) return;
  if (isBrowserPage(tabInfo.url)) {
    showErr("浏览器内置页面（chrome:// 等）无法采集。");
    return;
  }
  const btn = $("diagBtn");
  btn.disabled = true;
  btn.textContent = "采集中…（约 3 秒）";
  try {
    const frameProbe = () => {
      const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const clsChain = (el) => {
        const out = [];
        for (let p = el, i = 0; p && p !== document.body && i < 5; i++, p = p.parentElement) {
          const c = typeof p.className === "string" ? p.className : (p.className && p.className.baseVal) || "";
          out.push(p.tagName.toLowerCase() + (c ? "." + c.split(/\s+/).slice(0, 3).join(".") : ""));
        }
        return out.join(" < ");
      };
      const videos = [...document.querySelectorAll("video")].map((v) => ({
        paused: v.paused, ended: v.ended,
        t: +v.currentTime.toFixed(2), dur: +((v.duration || 0).toFixed(1)),
        size: v.videoWidth + "x" + v.videoHeight,
        cls: clsChain(v),
      }));
      // 播放器控制按钮：video 祖先容器附近的 button/[role=button]，label 含 播放/暂停/play/pause
      const btns = [];
      const v0 = document.querySelector("video");
      if (v0 && v0.parentElement) {
        let scope = v0.parentElement;
        for (let i = 0; i < 4 && scope && btns.length < 8; i++, scope = scope.parentElement) {
          for (const b of scope.querySelectorAll('button,[role="button"],.bpui-button,[class*="ctrl" i]')) {
            const label = clean(b.getAttribute("aria-label") || b.title || b.getAttribute("data-title") || "");
            if (/播放|暂停|play|pause/i.test(label) && btns.length < 8) {
              btns.push({ label: label.slice(0, 30), cls: (typeof b.className === "string" ? b.className : "").slice(0, 50) });
            }
          }
        }
      }
      return { url: location.href.slice(0, 100), videos, btns, playbackState: (navigator.mediaSession && navigator.mediaSession.playbackState) || "" };
    };
    // executeScript Promise 形式返回 InjectionResult[]（v2.8.11 修：曾误用
    // const [res] 解构成单个对象，后续 .filter 抛 TypeError）
    const res = await chrome.scripting.executeScript({ target: { tabId: tabInfo.id, allFrames: true }, func: frameProbe });
    const injResults = (res || []).filter((f) => f.result);
    // currentTime 双采样：间隔 2s 再采一轮，标注每帧每 video 是否推进（播放铁证）
    await new Promise((r) => setTimeout(r, 2000));
    const res2 = await chrome.scripting.executeScript({ target: { tabId: tabInfo.id, allFrames: true }, func: frameProbe });
    // 按 frameId 对齐两轮采样（帧顺序理论可变，不依赖数组索引）
    const res2ByFrame = new Map(((res2 || [])).filter((f) => f.result).map((f) => [f.frameId, f.result]));
    const report = injResults.map((inj) => {
      const fr = inj.result;
      const fr2 = res2ByFrame.get(inj.frameId) || {};
      const videos = (fr.videos || []).map((v, j) => {
        const v2 = (fr2.videos || [])[j] || {};
        return { ...v, advanced: typeof v2.t === "number" && v2.t > v.t ? `推进 ${v.t}→${v2.t}` : `未推进 ${v.t}→${v2.t ?? "?"}` };
      });
      return { frame: fr.url, videos, playerButtons: (fr.btns || []).slice(0, 4), playbackState: fr.playbackState };
    });
    const json = JSON.stringify(report);
    await navigator.clipboard.writeText(json).catch(() => {});
    showErr("已复制到剪贴板（" + json.length + " 字符），粘贴给开发者即可。" + json.slice(0, 260));
  } catch (e) {
    showErr("采集失败：" + String(e && e.message || e).slice(0, 120));
  }
  btn.disabled = false;
  btn.textContent = "识别诊断（采集本页播放/标题识别状态，复制到剪贴板）";
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
      ? `识别标题${les.src ? `（${SRC_LABEL[les.src] || les.src}）` : ""}：${les.name}`
      : "识别标题：未识别到（该节将命名为「第N节」）";
    $("detTitle").textContent = les2;
  }
  $("segCount").textContent = (st.segCount || 0) + " 节";
  $("segTime").textContent = fmtDur(st.segMs || 0);
  $("totalTime").textContent = fmtDur(st.totalMs || 0);
  $("totalSize").textContent = fmtMB(st.bytes || 0);

  // 收工状态独立一行（面板美化：不混入 tips 长串）
  let wrapText = "";
  if (st.dbg && st.dbg.wrapStatus) {
    if (st.dbg.wrapStatus.left != null) wrapText = `无播放收工倒计时：${Math.ceil(st.dbg.wrapStatus.left / 1000)}s`;
    else if (st.dbg.wrapStatus.blocked) wrapText = `收工延迟：${st.dbg.wrapStatus.blocked}`;
  }
  $("wrapTip").textContent = wrapText;

  const tips = [];
  if (st.state === "stopping") tips.push("正在保存文件，请勿关闭浏览器…");
  if (st.crop) tips.push(`仅录制所选区域（${st.crop.w}×${st.crop.h}）。`);
  if (st.cropError) tips.push("区域裁剪启动失败，已按全画面录制：" + st.cropError);
  if (st.crop && st.crop.vw) {
    const map = st.crop.stretch
      ? `拉伸 x${st.crop.sxScale.toFixed(3)}/y${st.crop.syScale.toFixed(3)}`
      : `scale ${st.crop.scale.toFixed(3)} · 黑边 ${Math.round(st.crop.letterbox)}px`;
    tips.push(`裁剪帧 ${st.crop.vw}×${st.crop.vh} · ${map}（框选视口 ${st.crop.viewportW}×${st.crop.viewportH}）`);
  }
  if (st.captureSize && st.captureSize.w) {
    const cv = st.curViewport ? `，当前视口 ${st.curViewport.w}×${st.curViewport.h}·dpr${st.curViewport.dpr}` : "";
    tips.push(`捕获帧 ${st.captureSize.w}×${st.captureSize.h}${cv}`);
  }
  if (st.viewportDrift && st.crop) {
    tips.push(`⚠ 窗口/页面大小已变化（框选时 ${st.crop.viewportW}×${st.crop.viewportH}），裁剪位置可能偏移——建议停止后重新框选`);
  }
  if (st.urlLog && st.urlLog.length) {
    const last = st.urlLog[st.urlLog.length - 1];
    tips.push(`最近网址变化：${last.u}${last.changed ? "（内容标识变化）" : "（仅进度参数）"}`);
  }
  if (st.signals) {
    tips.push(`播放信号：${st.signals.hasPlayed ? "✓ 已到达" : "✗ 未收到（停播判定不启用，播完靠弹窗入口信号）"}`);
  }
  if (st.dbg && st.dbg.pendingLesson) tips.push(`待确认课时名：${st.dbg.pendingLesson}`);
  if (st.lastSplit) {
    const d = new Date(st.lastSplit.at);
    const p2 = (v) => String(v).padStart(2, "0");
    tips.push(`上次切节：${st.lastSplit.reason}（${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}）`);
  }
  $("recTip").textContent = tips.join(" ");
}

document.addEventListener("DOMContentLoaded", init);

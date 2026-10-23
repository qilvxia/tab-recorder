// live.js — 独立状态窗：普通窗口不受下载气泡抢焦点影响，录制全程可见
const $ = (id) => document.getElementById(id);

const SRC_LABEL = {
  mediasession: "媒体元数据",
  selector: "选择器",
  "active-item": "目录高亮",
  "playing-label": "播放中标签",
  "video-title": "视频属性",
  "doc-title": "页面标题",
};

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (v) => String(v).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}
function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

async function poll() {
  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  render(st);
  setTimeout(poll, 1000);
}

function render(st) {
  const recording = st && st.state && st.state !== "idle";
  $("recBox").classList.toggle("hidden", !recording);
  $("idleBox").classList.toggle("hidden", recording);
  if (!recording) {
    $("stateChip").className = "chip idle";
    $("stateChip").textContent = "空闲";
    if (st && st.last) {
      const n = (st.last.segments || []).length;
      const errs = (st.last.saveErrors || []).length;
      const t = st.last.title && st.last.title.name ? `，识别标题「${st.last.title.name}」` : "";
      const notice = (st.last.saveNotices || []).length ? `，${st.last.saveNotices[0]}` : "";
      $("idleHint").textContent = "本次录制已结束。";
      $("lastResult").textContent = n ? `${n} 个文件${errs ? `（${errs} 个失败）` : ""}${t}${notice}。文件在浏览器下载目录。` : "";
    } else {
      $("idleHint").textContent = "没有正在进行的录制，本窗口可关闭。";
    }
    return;
  }

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
    $("detTitle").textContent = les.name
      ? `识别标题（${SRC_LABEL[les.src] || les.src || "未知来源"}）：${les.name}`
      : "识别标题：未识别到（各来源均落空）";
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
  $("recTip").textContent = tips.join(" ");
}

document.addEventListener("DOMContentLoaded", () => {
  $("pauseBtn").onclick = async () => {
    const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
    const t = st && st.state === "paused" ? "resume" : "pause";
    await chrome.runtime.sendMessage({ type: t }).catch(() => {});
  };
  $("stopBtn").onclick = async () => {
    $("stopBtn").disabled = true;
    await chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
  };
  $("closeBtn").onclick = () => window.close();
  poll();
});

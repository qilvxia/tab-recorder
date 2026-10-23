// options.js — 设置读写
const DEFAULTS = {
  format: "mp4", videoBitrate: 4000000, frameRate: 30, audioBitrate: 128000,
  startDelaySeconds: 0, heartbeatInject: true, autoLiveWindow: true,
  stopOnVideoEnd: true, silenceStopSeconds: 0, maxDurationMinutes: 360,
  segOnEnded: true, segOnUrl: true, segOnSilence: true, segSilenceSeconds: 5, segDebounceMs: 1500,
  lessonSelector: "h1", lessonPrefix: "^正在播放[:：]\\s*", courseSelector: "",
  saveSubdir: "TabRecorder", filenameTemplate: "{title}_{date}-{time}",
};
const KEYS = Object.keys(DEFAULTS);
const NUM_KEYS = new Set([
  "videoBitrate", "frameRate", "audioBitrate", "startDelaySeconds", "silenceStopSeconds", "maxDurationMinutes",
  "segSilenceSeconds", "segDebounceMs",
]);
const BOOL_KEYS = new Set(["stopOnVideoEnd", "segOnEnded", "segOnUrl", "segOnSilence", "heartbeatInject", "autoLiveWindow"]);

const $ = (id) => document.getElementById(id);

function fill(s) {
  for (const k of KEYS) {
    const el = $(k);
    if (!el) continue;
    if (BOOL_KEYS.has(k)) el.checked = !!s[k];
    else el.value = String(s[k]);
  }
}

async function load() {
  const st = await chrome.storage.local.get("settings");
  fill(Object.assign({}, DEFAULTS, st.settings || {}));
}

async function save() {
  const s = Object.assign({}, DEFAULTS);
  for (const k of KEYS) {
    const el = $(k);
    if (!el) continue;
    if (BOOL_KEYS.has(k)) s[k] = el.checked;
    else if (NUM_KEYS.has(k)) s[k] = Math.max(0, Number(el.value) || 0);
    else s[k] = el.value.trim();
  }
  await chrome.storage.local.set({ settings: s });
  toast("已保存 ✓");
}

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("saveBtn").onclick = save;
  $("resetBtn").onclick = async () => {
    fill(DEFAULTS);
    await chrome.storage.local.set({ settings: DEFAULTS });
    toast("已恢复默认 ✓");
  };
});

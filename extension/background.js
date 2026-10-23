// background.js — Service Worker：streamId 签发、检测注入、锚点落定检测、徽章

const OFFSCREEN_URL = "offscreen.html";
let keepaliveCount = 0;

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "在后台文档中运行 MediaRecorder，录制标签页音视频，弹窗关闭后录制不中断",
  });
}

// 向 offscreen 发消息（带就绪重试，规避刚创建文档时监听器未注册的竞态）
async function sendOffscreen(msg, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (!String(e.message || e).includes("Receiving end does not exist")) throw e;
      await ensureOffscreen();
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("offscreen 文档未就绪");
}

async function getSession() {
  return (await chrome.storage.session.get(["recording", "tabId"])) || {};
}

function setBadge(text, color) {
  if (text) chrome.action.setBadgeBackgroundColor({ color: color || "#e5484d" });
  chrome.action.setBadgeText({ text });
}

async function injectDetector(tabId, settings) {
  // 注入失败自动重试（快速连测时页面常处于加载中），与其它逻辑解耦
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content-detect.js"] });
      chrome.tabs.sendMessage(tabId, {
        type: "detect-config",
        cfg: { lessonSelector: (settings && settings.lessonSelector) || "h1", lessonPrefix: (settings && settings.lessonPrefix) || "" },
      }).catch(() => {});
      return true;
    } catch (e) {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 700));
    }
  }
  return false; // 注入受限页面（如 chrome://）——少了标题识别，不影响录制
}

// 锚点落定检测：offscreen 点击 <a download> 后按文件名轮询 downloads，
// complete/interrupted 后回执（offscreen 收齐回执才会关文档，防大文件截断）
async function trackAnchor(name) {
  const base = (p) => String(p || "").split(/[\\/]/).pop();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const deadline = Date.now() + 300000; // 大文件上限 5 分钟
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    let items = [];
    try {
      items = await chrome.downloads.search({ filenameRegex: esc });
    } catch (e) {
      continue;
    }
    const it = items.map((d) => ({ state: d.state, base: base(d.filename) })).find((d) => d.base === name);
    if (!it) continue;
    if (it.state === "complete" || it.state === "interrupted") {
      chrome.runtime.sendMessage({ type: "anchor-landed", ok: it.state === "complete", name }).catch(() => {});
      return;
    }
  }
  chrome.runtime.sendMessage({ type: "anchor-landed", ok: false, name, error: "等待下载落定超时" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "start": {
        // 预约式启动：此刻不取流（捕获推迟到倒计时归零，弹窗全程稳定）
        try {
          const { tabId, settings, payload } = msg;
          await ensureOffscreen();
          await chrome.storage.session.set({ recording: true, tabId, startedAt: Date.now() });
          const resp = await sendOffscreen({ type: "offscreen-schedule", settings, payload, tabId });
          sendResponse(resp || { ok: true });
        } catch (e) {
          await chrome.storage.session.remove(["recording", "tabId", "startedAt"]);
          setBadge("", "");
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "request-capture": {
        // 倒计时归零，offscreen 请求真正开始捕获：此时才签发 streamId + 注入检测器
        try {
          const streamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId }, (id) => {
              const err = chrome.runtime.lastError;
              if (err || !id) reject(new Error((err && err.message) || "getMediaStreamId 失败"));
              else resolve(id);
            });
          });
          await injectDetector(msg.tabId, msg.settings);
          sendResponse({ ok: true, streamId });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "stop": {
        sendResponse(await sendOffscreen({ type: "offscreen-stop" }).catch((e) => ({ ok: false, error: String(e) })));
        break;
      }
      case "pause":
      case "resume": {
        sendResponse(await sendOffscreen({ type: "offscreen-" + msg.type }).catch(() => ({})));
        break;
      }
      case "status": {
        if (await hasOffscreen()) {
          try {
            sendResponse(await chrome.runtime.sendMessage({ type: "offscreen-status" }));
          } catch {
            sendResponse({ state: "idle" });
          }
        } else {
          sendResponse({ state: "idle", last: (await chrome.storage.session.get("lastSummary")).lastSummary });
        }
        break;
      }
      case "content-report": {
        if (await hasOffscreen()) chrome.runtime.sendMessage({ type: "offscreen-content", data: msg.data }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "track-anchor": {
        trackAnchor(msg.name);
        sendResponse({ ok: true });
        break;
      }
      case "badge": {
        setBadge(String(msg.text || ""), "#e5484d");
        sendResponse({ ok: true });
        break;
      }
      case "keepalive": {
        // offscreen 每 2 秒心跳；顺带上报标签页 audible（静默检测信号，M2 用）
        const st = await getSession();
        if (st.recording && st.tabId != null) {
          keepaliveCount += 1;
          try {
            const tab = await chrome.tabs.get(st.tabId);
            chrome.runtime.sendMessage({ type: "offscreen-audible", audible: !!tab.audible }).catch(() => {});
          } catch (e) { /* 标签页已关闭 */ }
          // 每 3 次心跳（约 6 秒）补注入检测器：覆盖晚出现的播放器 iframe
          // （脚本首行守卫使已有帧为空操作；弹窗打开期间跳过，避免任何潜在焦点干扰）
          if (keepaliveCount % 3 === 0) {
            let skip = false;
            try {
              const popups = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
              skip = popups.length > 0;
            } catch (e) {}
            if (!skip) {
              try {
                await chrome.scripting.executeScript({ target: { tabId: st.tabId, allFrames: true }, files: ["content-detect.js"] });
              } catch (e) { /* 受限页/帧忽略 */ }
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message " + (msg && msg.type) });
    }
  })();
  return true; // 异步 sendResponse
});

// 标签页关闭 → 结束录制（offscreen 会妥善保存已录内容）
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getSession();
  if (st.recording && tabId === st.tabId) {
    chrome.runtime.sendMessage({ type: "offscreen-tab-closed" }).catch(() => {});
  }
});

// 录制全部落盘完成 → 清理状态并关闭 offscreen 文档
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "recording-finished") {
    (async () => {
      await chrome.storage.session.set({ lastSummary: msg.summary || null });
      await chrome.storage.session.remove(["recording", "tabId", "startedAt"]);
      setBadge("", "");
      if (await hasOffscreen()) {
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    })();
  }
});

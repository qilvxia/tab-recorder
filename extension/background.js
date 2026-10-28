// background.js — Service Worker：streamId 签发、检测注入、锚点落定检测、徽章

const OFFSCREEN_URL = "offscreen.html";
let keepaliveCount = 0;

// storage.session 保持默认 TRUSTED_ONLY（曾全局开放 UNTRUSTED 供内容脚本读
// 冷却戳——审计 S1：allFrames 注入的第三方 iframe 帧内容脚本因此可读全部
// session 键。现冷却查询改走消息（advance-cooldown case），session 不再开放）

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
  return (await chrome.storage.session.get(["recording", "tabId", "mode"])) || {};
}

function setBadge(text, color) {
  if (text) chrome.action.setBadgeBackgroundColor({ color: color || "#e5484d" });
  chrome.action.setBadgeText({ text });
}

// 扩展实例标识：扩展重载时 session 清空→新 id；SW 空闲重启 session 保留→同 id。
// 用于识别页面上残留的死 detector（重载后旧 content script 已失效，但页面 window
// 上的守卫变量还在——新注入会被守卫静默挡掉，识别/连播全失效，用户必须刷新页面）。
let _instanceIdPromise = null;
function getInstanceId() {
  if (!_instanceIdPromise) {
    _instanceIdPromise = (async () => {
      const { detectorInstanceId } = await chrome.storage.session.get("detectorInstanceId");
      if (detectorInstanceId) return detectorInstanceId;
      const id = "det_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await chrome.storage.session.set({ detectorInstanceId: id });
      return id;
    })();
  }
  return _instanceIdPromise;
}

async function injectDetector(tabId, settings, mode) {
  // 先按实例 token 清理死守卫：页面残留的 __tabRecDetector 来自旧扩展实例
  //（重载前注入，runtime 已死）——token 不一致即清掉，本次 files 注入才能
  // 重新初始化；token 一致 = 实例存活，守卫正常拦截重复注入（幂等）
  try {
    const instId = await getInstanceId();
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (tok) => {
        if (window.__tabRecDetTok !== tok) {
          delete window.__tabRecDetector;
          window.__tabRecDetTok = tok;
        }
      },
      args: [instId],
    });
  } catch (e) { /* 受限页/帧忽略，与 files 注入同等容错 */ }
  // 注入失败自动重试（快速连测时页面常处于加载中），与其它逻辑解耦
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content-detect.js"] });
      chrome.tabs.sendMessage(tabId, {
        type: "detect-config",
        cfg: {
          lessonSelector: (settings && settings.lessonSelector) || "h1",
          lessonPrefix: (settings && settings.lessonPrefix) || "",
          autoNext: mode === "segment" && (settings && settings.autoNext !== false),
        },
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
  const deadline = Date.now() + 300000; // 大文件上限 5 分钟（与 offscreen SEG.finishDeadlineMs 同值）
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    let items = [];
    try {
      items = await chrome.downloads.search({ filenameRegex: esc });
    } catch (e) {
      continue;
    }
    // 匹配放宽：Chrome 对重名文件自动加 " (n)" 后缀——base 精确匹配失配会让
    // offscreen 滞留到 5 分钟超时（审计低项）
    const it = items.map((d) => ({ state: d.state, base: base(d.filename) }))
      .find((d) => d.base === name || d.base.startsWith(name + " ("));
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
          // 重入守卫：录制中拒绝二次开始（popup status 轮询失败误显空闲时，
          // 再点开始会重入 schedule——旧流/回环不停、双录制状态错乱）
          const st = await getSession();
          if (st.recording) {
            sendResponse({ ok: false, error: "已有录制进行中，请先停止" });
            break;
          }
          await ensureOffscreen();
          await chrome.storage.session.set({ recording: true, tabId, mode: payload.mode, startedAt: Date.now() });
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
          await injectDetector(msg.tabId, msg.settings, msg.mode);
          // 兜底关闭可能遗留的选区浮层，避免浮层被录进画面（真正取流前的最后时刻）
          chrome.tabs.sendMessage(msg.tabId, { type: "crop-selector-cancel" }).catch(() => {});
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
      case "stop-discard": {
        sendResponse(await sendOffscreen({ type: "offscreen-stop-discard" }).catch((e) => ({ ok: false, error: String(e) })));
        break;
      }
      case "pause":
      case "resume": {
        sendResponse(await sendOffscreen({ type: "offscreen-" + msg.type }).catch(() => ({})));
        break;
      }
      case "status": {
        const { advanceLog } = await chrome.storage.session.get("advanceLog");
        if (await hasOffscreen()) {
          try {
            const st = await chrome.runtime.sendMessage({ type: "offscreen-status" });
            st.advanceLog = advanceLog || [];
            sendResponse(st);
          } catch {
            sendResponse({ state: "idle", advanceLog: advanceLog || [] });
          }
        } else {
          sendResponse({ state: "idle", last: (await chrome.storage.session.get("lastSummary")).lastSummary, advanceLog: advanceLog || [] });
        }
        break;
      }
      case "content-report": {
        // 来源校验（审计 S1）：只接受录制标签页的上报——历史注入到其他标签页的
        // detector 若仍存活，其信号不得影响本场录制（跨页串扰 + 纵深防御）。
        // 扩展自身页面（e2e-test.html 等测试页）sender.tab 为 undefined 但属于
        // 可信上下文——直接加载的检测脚本信号放行（盲区模拟依赖 entry 信号）
        {
          const st = await getSession();
          const fromExtPage = !sender.tab && String(sender.url || "").startsWith(chrome.runtime.getURL(""));
          if (st.recording && !fromExtPage && (!sender.tab || sender.tab.id !== st.tabId)) {
            sendResponse({ ok: true });
            break;
          }
        }
        if (await hasOffscreen()) chrome.runtime.sendMessage({ type: "offscreen-content", data: msg.data }).catch(() => {});
        // 播完事件广播给录制标签页所有帧：ended 可能在 iframe 的视频上，而「下一节」
        // 入口在顶层文档——需要每个帧各自找入口点击（连播）。
        if (msg.data && msg.data.ended) {
          const tabId = sender.tab && sender.tab.id;
          if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "try-advance" }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "broadcast-advance": {
        // offscreen 判定「播完待连播」→ 向录制中标签页所有帧广播连播指令
        const st = await getSession();
        if (st.recording && st.tabId != null) {
          chrome.tabs.sendMessage(st.tabId, { type: "try-advance" }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "select-crop-region": {
        // popup 请求在目标标签页弹出具选浮层（复用 scripting 权限，按需注入）
        try {
          await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["content-crop.js"] });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "crop-region-selected": {
        // 来自选区浮层：视口坐标存会话存储并绑定标签页（换 tab 失效，跨录制保留）
        try {
          await chrome.storage.session.set({
            cropRegion: {
              rect: msg.rect,
              viewportW: msg.viewportW,
              viewportH: msg.viewportH,
              tabId: sender.tab && sender.tab.id,
              at: Date.now(),
            },
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "advance-cooldown": {
        // 连播点击冷却查询（曾由内容脚本直读 session——审计 S1 收紧后改走消息，
        // session 不对 UNTRUSTED 上下文开放）
        try {
          const { lastAdvanceClick } = await chrome.storage.session.get("lastAdvanceClick");
          sendResponse({ ok: true, ts: lastAdvanceClick || 0 });
        } catch (e) {
          sendResponse({ ok: false });
        }
        break;
      }
      case "advance-clicked": {
        // 连播点击成功 → offscreen 从 between 立即续录（新节内容零丢失）
        chrome.runtime.sendMessage({ type: "offscreen-advance-clicked" }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "advance-result": {
        // 连播尝试结果存会话（站点有 console.clear 反调试，控制台日志不可靠，面板直接显示）
        try {
          const { advanceLog } = await chrome.storage.session.get("advanceLog");
          const list = Array.isArray(advanceLog) ? advanceLog : [];
          list.unshift({ at: Date.now(), text: String(msg.text || "").slice(0, 80) });
          await chrome.storage.session.set({ advanceLog: list.slice(0, 5) });
        } catch (e) {}
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
        // offscreen 每 2 秒心跳；顺带核对录制标签页存活
        const st = await getSession();
        if (st.recording && st.tabId != null) {
          keepaliveCount += 1;
          try {
            await chrome.tabs.get(st.tabId);
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
                const s = await chrome.storage.local.get("settings");
                const st2 = await getSession();
                await injectDetector(st.tabId, s.settings || {}, st2.mode);
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

// URL 变化（SPA 切课时路由会变）→ 分节信号 + 立即补注入检测器
// （连播跳转后页面重载，detector 恢复越快，playing 上报越早恢复，切节越可靠）
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  const st = await getSession();
  if (st.recording && tabId === st.tabId && change.url) {
    chrome.runtime.sendMessage({ type: "offscreen-url", url: change.url }).catch(() => {});
    const s = await chrome.storage.local.get("settings");
    injectDetector(tabId, s.settings || {}, st.mode);
  }
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

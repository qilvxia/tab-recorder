// background.js — Service Worker：流转协调、落盘、外部信号（URL 变化 / 标签页静默 / 关闭）

const OFFSCREEN_URL = "offscreen.html";
let keepaliveCount = 0;
let saveViaCache = null; // 保存通道内存缓存；权威值在 chrome.storage.session.saveChannel（SW 会被随时杀掉）

// 独立状态窗：Chrome 下载气泡会抢焦点关掉扩展弹窗，普通窗口不受影响。
// focused:false——绝不主动抢焦点；自动弹出受设置控制（windows.create 在 Windows 上
// 即便 focused:false 也可能让弹窗失焦，v1.1.10 复验仍秒关后默认改为手动/可选）
async function openLiveWindow(focus = false) {
  try {
    const { liveWin } = await chrome.storage.session.get("liveWin");
    if (liveWin != null) {
      const w = await chrome.windows.get(liveWin).catch(() => null);
      if (w) {
        if (focus) await chrome.windows.update(liveWin, { focused: true }).catch(() => {});
        return;
      }
    }
    const win = await chrome.windows.create({ url: "live.html", type: "popup", width: 372, height: 640, focused: !!focus });
    await chrome.storage.session.set({ liveWin: win.id });
  } catch (e) { /* 开窗失败不影响录制 */ }
}

chrome.windows.onRemoved.addListener(async (id) => {
  try {
    const { liveWin } = await chrome.storage.session.get("liveWin");
    if (liveWin === id) await chrome.storage.session.remove("liveWin");
  } catch (e) {}
});

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

function setBadge(recording) {
  chrome.action.setBadgeText({ text: recording ? "REC" : "" });
  if (recording) chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "start": {
        try {
          const { tabId, settings, payload } = msg;
          // 签发一次性 streamId（数秒内有效，须尽快交给 offscreen 消费）
          const streamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
              const err = chrome.runtime.lastError;
              if (err || !id) reject(new Error((err && err.message) || "getMediaStreamId 失败"));
              else resolve(id);
            });
          });
          await ensureOffscreen();
          // 兜底关闭可能遗留的选区浮层，避免浮层被录进画面
          chrome.tabs.sendMessage(tabId, { type: "crop-selector-cancel" }).catch(() => {});
          // 注入页面检测器（activeTab 授权，allFrames 覆盖 iframe 播放器；失败不影响录制）。
          // 快速连测时页面常处于加载中，注入可能失败——自动重试，与心跳开关无关
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content-detect.js"] });
              chrome.tabs.sendMessage(tabId, {
                type: "detect-config",
                cfg: { lessonSelector: settings.lessonSelector, courseSelector: settings.courseSelector },
              }).catch(() => {});
              break;
            } catch (e) {
              if (attempt < 2) await new Promise((r) => setTimeout(r, 700));
            }
          }
          await chrome.storage.session.set({ recording: true, tabId, mode: payload.mode, startedAt: Date.now() });
          setBadge(true);
          // 录制期间静默下载气泡（气泡会抢焦点关掉面板）；新版本可能无效，尽力而为
          try { chrome.downloads.setShelfEnabled(false); } catch (e) {}
          const resp = await sendOffscreen({ type: "offscreen-start", streamId, settings, payload, tabId });
          if (resp && resp.ok) {
            const s = await chrome.storage.local.get("settings");
            if ((s.settings || {}).autoLiveWindow !== false) openLiveWindow();
          }
          sendResponse(resp || { ok: true });
        } catch (e) {
          await chrome.storage.session.remove(["recording", "tabId", "mode", "startedAt"]);
          setBadge(false);
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "stop": {
        sendResponse(await sendOffscreen({ type: "offscreen-stop" }).catch((e) => ({ ok: false, error: String(e) })));
        break;
      }
      case "pause": {
        sendResponse(await sendOffscreen({ type: "offscreen-pause" }).catch(() => ({})));
        break;
      }
      case "resume": {
        sendResponse(await sendOffscreen({ type: "offscreen-resume" }).catch(() => ({})));
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
      case "keepalive": {
        // offscreen 每 2 秒心跳；顺带上报标签页 audible（静默检测信号）+ 补注入检测器
        const st = await getSession();
        if (st.recording && st.tabId != null) {
          try {
            const tab = await chrome.tabs.get(st.tabId);
            chrome.runtime.sendMessage({ type: "offscreen-audible", audible: !!tab.audible }).catch(() => {});
          } catch (e) { /* 标签页已关闭：由 tabs.onRemoved 处理 */ }
          // 每 3 次心跳（约 6 秒）补注入检测器：SPA 懒加载的播放器 iframe 在开始注入时
          // 可能尚不存在，靠周期性补注入覆盖；脚本首行守卫使已有帧为空操作。
          // 弹窗打开期间跳过——executeScript 是 v1.1.6 起"面板秒关"的头号嫌疑，
          // 弹窗开着时用户正盯面板，页面侧检测延迟无实际影响
          keepaliveCount += 1;
          if (keepaliveCount % 3 === 0) {
            let skip = false;
            try {
              const popups = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
              skip = popups.length > 0;
            } catch (e) {}
            if (!skip) {
              const s = await chrome.storage.local.get("settings");
              skip = (s.settings || {}).heartbeatInject === false; // 诊断开关（二分定位用）
            }
            if (!skip) {
              try {
                await chrome.scripting.executeScript({ target: { tabId: st.tabId, allFrames: true }, files: ["content-detect.js"] });
                const s = await chrome.storage.local.get("settings");
                const sv = s.settings || {};
                chrome.tabs.sendMessage(st.tabId, {
                  type: "detect-config",
                  cfg: { lessonSelector: sv.lessonSelector || "h1", courseSelector: sv.courseSelector || "" },
                }).catch(() => {});
              } catch (e) { /* 受限页/帧忽略 */ }
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "save": {
        // offscreen 生成 blob URL 后交给下载器；token 用于回执对账。
        // 部分 Chrome 版本会整体丢弃 downloads.download 的 filename 参数（文件落到下载
        // 根目录、名为 blob GUID）——因此落地后核验名字，不一致时逐级降级重试；
        // 被弃尝试必须连盘上文件一起清理（removeFile），否则每次保存都会残留 GUID 文件。
        (async () => {
          const base = (p) => String(p || "").split(/[\\/]/).pop();
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const startDownload = (filename) => new Promise((res) => {
            const opts = { url: msg.url, saveAs: false, conflictAction: "uniquify" };
            if (filename) opts.filename = filename;
            chrome.downloads.download(opts, (id) => {
              const e = chrome.runtime.lastError;
              res(e || id === undefined ? { err: (e && e.message) || "no id" } : { id });
            });
          });
          const landedName = async (id) => {
            for (let i = 0; i < 5; i++) {
              await sleep(300);
              try {
                const it = (await chrome.downloads.search({ id }))[0];
                if (it && it.filename) return it.filename;
              } catch (e) { /* 查询失败重试 */ }
            }
            return "";
          };
          // 弃用一次尝试：循环到该下载彻底消失为止——cancel 与完成之间存在竞态窗口
          // （取消调用前的一瞬完成 → 文件留盘），必须反复核验：complete→删文件、
          // in_progress→取消、interrupted→清历史
          const abandon = async (id) => {
            for (let i = 0; i < 8; i++) {
              let it = null;
              try { it = (await chrome.downloads.search({ id }))[0]; } catch (e) {}
              if (!it) return;
              if (it.state === "complete") {
                try { await chrome.downloads.removeFile(id); } catch (e) {}
                try { await chrome.downloads.erase({ id }); } catch (e) {}
                return;
              }
              if (it.state === "in_progress") {
                try { await chrome.downloads.cancel(id); } catch (e) {}
                await sleep(400);
              } else {
                try { await chrome.downloads.erase({ id }); } catch (e) {}
                return;
              }
            }
            try { await chrome.downloads.erase({ id }); } catch (e) {}
          };
          const rememberChannel = (v) => {
            saveViaCache = v;
            chrome.storage.session.set({ saveChannel: v }).catch(() => {});
          };
          // 回执：监听挂上后立刻补查一次当前状态——小文件可能在监听挂上之前就已完成，
          // 只靠 onChanged 会丢事件导致 offscreen 干等回执直到超时
          const finish = (kept, via) => {
            let settled = false;
            const sendDone = (ok) => {
              if (settled) return;
              settled = true;
              chrome.downloads.onChanged.removeListener(onDelta);
              chrome.runtime.sendMessage({
                type: "download-complete",
                ok,
                token: msg.token,
                renamed: via !== "api" || undefined,
                savedName: kept.landedBase || undefined,
              }).catch(() => {});
            };
            const onDelta = (delta) => {
              if (delta.id !== kept.id || !delta.state) return;
              const s = delta.state.current;
              if (s === "complete" || s === "interrupted") sendDone(s === "complete");
            };
            chrome.downloads.onChanged.addListener(onDelta);
            chrome.downloads.search({ id: kept.id }).then(([it]) => {
              if (it && it.state !== "in_progress") sendDone(it.state === "complete");
            }).catch(() => {});
            sendResponse({ ok: true, id: kept.id });
          };

          const want = base(msg.filename);
          // 通道记忆（持久化在 session，SW 重启不丢）：一旦发现 API 通道被当前 Chrome
          // 丢弃，本浏览器会话内后续保存直达锚点通道，不再产生被弃下载
          if (saveViaCache == null) {
            const st = await chrome.storage.session.get("saveChannel");
            saveViaCache = st.saveChannel || null;
          }
          if (saveViaCache !== "anchor") {
            // 第 1 级：完整相对路径（子目录+名字）；第 2 级：仅文件名。
            // 落地名查询不到时视作生效（偏向保持现状，不做无谓降级）。
            for (const v of [msg.filename, want]) {
              if (!v) continue;
              const start = await startDownload(v);
              if (start.err) continue;
              const landed = await landedName(start.id);
              if (!landed || base(landed) === want) {
                rememberChannel("api");
                finish({ id: start.id, landedBase: base(landed) || want }, "api");
                return;
              }
              await abandon(start.id);
            }
          }
          // 锚点通道：offscreen 内 <a download>（走另一条命名路径，仅文件名）
          try {
            const before = new Set((await chrome.downloads.search({})).map((d) => d.id));
            const resp = await chrome.runtime.sendMessage({ type: "anchor-save", url: msg.url, name: want });
            if (resp && resp.ok) {
              for (let t = 0; t < 30; t++) {
                await sleep(500);
                const items = await chrome.downloads.search({});
                const fresh = items.filter((d) => !before.has(d.id) && base(d.filename || "") === want);
                if (fresh.length) {
                  const id = fresh[0].id;
                  let st = fresh[0];
                  for (let t2 = 0; t2 < 60 && st.state === "in_progress"; t2++) {
                    await sleep(500);
                    st = (await chrome.downloads.search({ id }))[0] || st;
                  }
                  rememberChannel("anchor");
                  finish({ id, landedBase: base(st.filename || "") }, "anchor");
                  return;
                }
              }
            }
          } catch (e) { /* 锚点通道失败继续兜底 */ }
          // 兜底：接受浏览器默认命名（GUID），面板会明示
          const start = await startDownload("");
          if (start.err) {
            sendResponse({ ok: false, error: start.err });
            return;
          }
          finish({ id: start.id, landedBase: "" }, "guid");
        })();
        break;
      }
      case "open-live": {
        await openLiveWindow(true); // 手动打开：聚焦
        sendResponse({ ok: true });
        break;
      }
      case "badge": {
        // offscreen 上报状态徽章（倒计时秒数/REC/暂停/保存中），面板被关也能看到状态
        try {
          const text = String(msg.text || "");
          if (text) chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
          chrome.action.setBadgeText({ text });
        } catch (e) {}
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
        // 来自选区浮层：视口坐标存会话存储并绑定标签页
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
      default:
        sendResponse({ ok: false, error: "unknown message " + (msg && msg.type) });
    }
  })();
  return true; // 异步 sendResponse
});

// 信号源 1：URL 变化（SPA 切课时路由会变）
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  const st = await getSession();
  if (st.recording && tabId === st.tabId && change.url) {
    chrome.runtime.sendMessage({ type: "offscreen-url", url: change.url }).catch(() => {});
  }
});

// 标签页关闭 → 结束整场录制（offscreen 会妥善保存已录内容）
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getSession();
  if (st.recording && tabId === st.tabId) {
    chrome.runtime.sendMessage({ type: "offscreen-tab-closed" }).catch(() => {});
  }
});

// 录制全部落盘完成 → 清理状态并关闭 offscreen 文档（早关会切断未完成的 blob 下载）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "recording-finished") {
    (async () => {
      await chrome.storage.session.set({ lastSummary: msg.summary || null });
      await chrome.storage.session.remove(["recording", "tabId", "mode", "startedAt"]);
      setBadge(false);
      try { chrome.downloads.setShelfEnabled(true); } catch (e) {}
      openLiveWindow(); // 状态窗就地更新本次结果（不抢焦点）
      if (await hasOffscreen()) {
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    })();
  }
});

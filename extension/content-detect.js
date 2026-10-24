// content-detect.js — 注入页面（activeTab，含 iframe 全帧）：识别播放标题、上报 video 播完事件
// 标题来源按优先级级联（不同网站结构不同，多路兜底），逐级剔除 UUID/长十六进制/长纯数字等垃圾名：
//   ① 播放器媒体元数据 mediaSession（保利威等播放器写在 iframe 里，需全帧注入才取得到）
//   ② 用户配置的课时名选择器（站点定制，人工优先）
//   ③ 高亮列表项启发式（课程目录侧边栏中当前课时）
//   ④ video 元素属性（title / aria-label / data-title）
//   ⑤ video 祖先 5 层内的标题类元素
//   ⑥ document.title 剥站点名尾巴
(() => {
  if (window.__tabRecDetector) return;
  window.__tabRecDetector = true;

  let cfg = { lessonSelector: "h1", courseSelector: "", autoNext: false };
  let last = { lesson: "", lessonSrc: "", course: "", url: "", ended: false, endedAt: 0, playing: false };
  const seenVideos = new Set();

  // ---- 自动连播（分节模式）：播完后尝试点击「下一节」入口 ----
  let advTimers = [];

  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const NEXT_WORDS = ["下一节", "下一课", "下一集", "下一讲", "下一章", "下一个", "继续观看", "观看下一", "播放下一"];
  function okAdvText(t) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (s.length < 2 || s.length > 40) return false;
    if (s.includes("上一") || s.includes("最后")) return false;
    return NEXT_WORDS.some((w) => s.includes(w));
  }

  // 激活元素：http(s) 链接同页跳转（防 _blank 开新页断录制）；其余派发完整鼠标
  // 事件序列 pointerdown→mousedown→mouseup→click（覆盖 click 型、mousedown 型、
  // pointerdown 型监听；事件冒泡给委托容器）。通用扩展需覆盖多种站点事件风格。
  function activateEl(el) {
    if (el.tagName === "A" && el.href && /^https?:/i.test(el.href)) {
      location.href = el.href;
      return;
    }
    const rect = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      const Ev = type === "pointerdown" && window.PointerEvent ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ev(type, base)); } catch (e) { /* 单事件失败继续 */ }
    }
  }

  // 收集 root（含各级 shadowRoot）下全部元素——播放器 web components 的
  // 弹窗按钮常藏在 shadow DOM 里，querySelectorAll 穿不透
  function collectAllElements(root, out) {
    let els = [];
    try { els = root.querySelectorAll("*"); } catch (e) { return; }
    for (const el of els) {
      out.push(el);
      if (el.shadowRoot) collectAllElements(el.shadowRoot, out);
    }
  }

  // 策略①：扫描全部可见元素的叶子文本（覆盖事件委托场景——入口常是
  // 无自身 handler 的 div/span，点击冒泡给委托容器；含 shadow DOM）
  function clickTextNext() {
    const els = [];
    collectAllElements(document, els);
    for (const el of els) {
      if (el.firstElementChild) continue; // 叶子节点：避免拿到整块容器文本
      if (!visible(el)) continue;
      const t = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!okAdvText(t)) continue;
      activateEl(el);
      return `文本「${t.slice(0, 20)}」`;
    }
    return "";
  }

  // 策略②：弹窗交互元素 class 启发式——关闭/跳过按钮的通用 class 命名
  // （有的站点点关闭后自动播下一节，有的 class 即"进入下一节"）
  const CLASS_NEXT_SEL = "[class*='next' i],[class*='skip' i],[class*='close' i],[class*='continue' i]";

  function clickClassHint() {
    let els = [];
    try { els = document.querySelectorAll(CLASS_NEXT_SEL); } catch (e) { return ""; }
    for (const el of els) {
      if (!visible(el)) continue;
      const t = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 60) continue;
      activateEl(el);
      return `class 启发式「${el.className.toString().slice(0, 30)}」`;
    }
    return "";
  }

  // 策略③：课程列表中当前高亮项的下一项
  function clickListNext() {
    let active = null;
    try {
      for (const el of document.querySelectorAll("[class*='active' i],[aria-current]")) {
        if (!visible(el) || el.closest("nav,header,footer")) continue;
        active = el;
        break;
      }
    } catch (e) { return ""; }
    if (!active) return "";
    const li = active.closest("li");
    let nextEl = li ? li.nextElementSibling : null;
    if (!nextEl) {
      const list = active.closest("ul,ol");
      if (list) {
        const items = [...list.querySelectorAll("li")];
        const i = items.findIndex((x) => x.contains(active));
        nextEl = items[i + 1] || null;
      }
    }
    if (!nextEl) return "";
    const target = nextEl.querySelector("a") || nextEl;
    if (!visible(target)) return "";
    activateEl(target);
    return "列表下一项";
  }

  // 尝试结果上报扩展（站点有 console.clear 反调试，控制台日志会被清，面板直显）
  function logAdvance(text) {
    console.info("[tabrec] " + text);
    try { chrome.runtime.sendMessage({ type: "advance-result", text }); } catch (e) {}
  }

  // 点击冷却：连播广播会到达多个帧（顶层/iframe），且九轮尝试在页面跳转完成前
  // 可能重复执行——15 秒内任何帧点过即跳过（跨帧共享 session 状态），防跳课
  let lastClickAt = 0;
  const ADV_CLICK_COOLDOWN = 15000;

  function attemptAdvance() {
    for (const v of document.querySelectorAll("video")) {
      if (!v.paused && !v.ended) return; // 本帧已有视频在播，无需连播
    }
    if (Date.now() - lastClickAt < ADV_CLICK_COOLDOWN) return; // 本帧冷却
    chrome.storage.session.get("lastAdvanceClick").then((s) => {
      if (Date.now() - (s.lastAdvanceClick || 0) < ADV_CLICK_COOLDOWN) {
        advTimers.forEach(clearTimeout);
        advTimers = [];
        logAdvance("自动连播：冷却期内（已有点击），跳过");
        return;
      }
      doClick();
    }).catch(() => doClick()); // 冷却检查失败（如 session 未开放）降级为直接点击
  }

  function doClick() {
    const how = clickTextNext() || clickClassHint() || clickListNext();
    if (how) {
      advTimers.forEach(clearTimeout);
      advTimers = [];
      lastClickAt = Date.now();
      chrome.storage.session.set({ lastAdvanceClick: Date.now() }).catch(() => {});
      logAdvance("自动连播：已点击 " + how);
    } else {
      logAdvance("自动连播：本帧未找到下一节入口");
    }
  }

  function scheduleAdvance() {
    if (!cfg.autoNext) {
      logAdvance("自动连播：未启用（面板开关或不在分节模式）");
      return;
    }
    advTimers.forEach(clearTimeout);
    // 九轮尝试：覆盖弹窗延迟出现、入场动画期间不可见等情况；点击成功即停
    advTimers = [2000, 4000, 6000, 8000, 12000, 16000, 20000, 25000, 30000].map((ms) =>
      setTimeout(attemptAdvance, ms));
  }
  function cancelAdvance() {
    advTimers.forEach(clearTimeout);
    advTimers = [];
  }


  function isJunk(t) {
    const s = String(t || "").trim();
    if (!s) return true;
    return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(s)
      || /^[0-9a-f]{20,}$/i.test(s)
      || /^\d{10,}$/.test(s);
  }

  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const okName = (t) => {
    const s = clean(t);
    return s.length >= 2 && s.length <= 80 && !isJunk(s) ? s : "";
  };

  // 通用界面词不算课时名（目录高亮启发式的误抓防护）
  const GENERIC_WORDS = new Set([
    "首页", "课程", "目录", "简介", "评论", "下载", "分享", "全屏", "播放", "暂停",
    "笔记", "问答", "资料", "讨论", "公告", "讲义", "习题", "测试", "考试", "更多",
  ]);

  function report() {
    try {
      chrome.runtime.sendMessage({
        type: "content-report",
        data: {
          lesson: last.lesson, lessonSrc: last.lessonSrc, course: last.course,
          url: last.url, ended: last.ended, playing: last.playing,
        },
      });
    } catch (e) { /* 扩展上下文失效时静默 */ }
  }

  function pick(sel) {
    if (!sel) return "";
    try {
      const el = document.querySelector(sel);
      return el ? clean(el.textContent) : "";
    } catch (e) { return ""; }
  }

  // ① 播放器为系统媒体控件设置的“正在播放”元数据
  function pickPlayingTitle() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      return md && md.title ? clean(md.title) : "";
    } catch (e) { return ""; }
  }

  // ③ 高亮列表项：课程目录里标记为当前/正在播放的条目
  const ACTIVE_SEL = [
    '[aria-current="true" i]', '[aria-current="page" i]',
    'li[class*="active" i] a', 'a[class*="active" i]',
    'li[class*="current" i] a', 'a[class*="current" i]',
    'li[class*="on"] a', '[class*="playing" i]:not(video)',
    'dd[class*="active" i]', '[class*="active" i]',
  ].join(",");

  function pickActiveListItem() {
    let els;
    try { els = document.querySelectorAll(ACTIVE_SEL); } catch (e) { return ""; }
    for (const el of els) {
      if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) continue;
      if (el.closest("nav,header,footer")) continue; // 导航/页眉页脚里的高亮不是课时
      const t = okName(el.innerText || el.textContent);
      if (t && !GENERIC_WORDS.has(t)) return t;
    }
    return "";
  }

  // 「正在播放：xxx」式文字标签（中文课程站常见）
  function pickPlayingLabel() {
    const RE = /^(?:正在播放|正在学习|正在观看|正在看|当前播放|当前学习)[:：]\s*(.+)$/;
    let els;
    try { els = document.querySelectorAll("span,div,p,h1,h2,h3,h4,b,em,i,dt,dd,li,a"); } catch (e) { return ""; }
    for (const el of els) {
      // 只要叶子文本（自己再无元素子节点），避免拿到整块容器文本
      if (el.firstElementChild) continue;
      if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) continue;
      const m = RE.exec(clean(el.textContent));
      if (m) {
        const t = okName(m[1]);
        if (t) return t;
      }
    }
    return "";
  }

  // ④⑤ video 自身属性与其祖先容器内的标题类元素
  function pickNearVideoTitle() {
    for (const v of document.querySelectorAll("video")) {
      for (const attr of ["title", "aria-label", "data-title"]) {
        const t = okName(v.getAttribute && v.getAttribute(attr));
        if (t) return t;
      }
      let p = v.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        for (const h of p.querySelectorAll("h1,h2,h3,[class*='title' i]")) {
          const t = okName(h.innerText || h.textContent);
          if (t) return t;
        }
        p = p.parentElement;
      }
    }
    return "";
  }

  // ⑥ 页面标题剥站点尾巴（“ - 站点名”）
  function pickDocTitle() {
    const t = clean(document.title);
    if (!t || isJunk(t)) return "";
    for (const part of t.split(/ [-–—|_] /)) {
      const s = okName(part);
      if (s) return s;
    }
    return "";
  }

  function resolveLessonName() {
    const bySel = cfg.lessonSelector ? pick(cfg.lessonSelector) : "";
    const cascade = [
      ["mediasession", pickPlayingTitle()],
      ["selector", okName(bySel)],
      ["active-item", pickActiveListItem()],
      ["playing-label", pickPlayingLabel()],
      ["video-title", pickNearVideoTitle()],
      ["doc-title", pickDocTitle()],
    ];
    for (const [src, val] of cascade) {
      if (val) return { name: val, src };
    }
    return { name: "", src: "" };
  }

  function trackVideos() {
    document.querySelectorAll("video").forEach((v) => {
      if (seenVideos.has(v)) return;
      seenVideos.add(v);
      v.addEventListener("ended", () => {
        last.ended = true;
        last.endedAt = Date.now();
        report();
        scheduleAdvance(); // 分节模式：播完自动尝试播放下一节
      });
      v.addEventListener("playing", () => {
        cancelAdvance(); // 视频恢复播放，无需连播
        if (last.ended) { last.ended = false; report(); }
      });
    });
  }

  // 本帧是否有视频正在播放（供 offscreen 的"停播静默"切节判定）
  function anyPlaying() {
    for (const v of document.querySelectorAll("video")) {
      if (!v.paused && !v.ended) return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "detect-config") {
      cfg = m.cfg || cfg;
      forceReport = true; // 新一场录制（新 offscreen 实例）需要立刻拿到当前状态：
                         // 本脚本平时只在页面变化时上报，页面没变就永远不会发
    } else if (m && m.type === "try-advance") {
      // SW 广播：任一帧的视频播完了——每个帧各自找「下一节」入口
      // （ended 可能在 iframe 的视频上，而弹窗入口在顶层文档）
      scheduleAdvance();
    }
  });

  let forceReport = false;

  setInterval(() => {
    trackVideos();
    const { name, src } = resolveLessonName();
    const course = pick(cfg.courseSelector);
    const url = location.href;
    const playing = anyPlaying();
    if (forceReport || playing !== last.playing || name !== last.lesson || course !== last.course || url !== last.url) {
      forceReport = false;
      last.lesson = name;
      last.lessonSrc = src;
      last.course = course;
      last.url = url;
      last.playing = playing;
      report();
    }
    if (last.ended && Date.now() - last.endedAt > 10000) last.ended = false; // 未收到 playing 的兜底解除
  }, 700);

  trackVideos();
})();

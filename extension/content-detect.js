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

  let cfg = { lessonSelector: "h1", courseSelector: "" };
  let last = { lesson: "", lessonSrc: "", course: "", url: "", ended: false, endedAt: 0 };
  const seenVideos = new Set();

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
          url: last.url, ended: last.ended,
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
      });
      v.addEventListener("playing", () => {
        if (last.ended) { last.ended = false; report(); }
      });
    });
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "detect-config") {
      cfg = m.cfg || cfg;
      forceReport = true; // 新一场录制（新 offscreen 实例）需要立刻拿到当前状态：
                         // 本脚本平时只在页面变化时上报，页面没变就永远不会发
    }
  });

  let forceReport = false;

  setInterval(() => {
    trackVideos();
    const { name, src } = resolveLessonName();
    const course = pick(cfg.courseSelector);
    const url = location.href;
    if (forceReport || name !== last.lesson || course !== last.course || url !== last.url) {
      forceReport = false;
      last.lesson = name;
      last.lessonSrc = src;
      last.course = course;
      last.url = url;
      report();
    }
    if (last.ended && Date.now() - last.endedAt > 10000) last.ended = false; // 未收到 playing 的兜底解除
  }, 700);

  trackVideos();
})();

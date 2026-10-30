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

  let cfg = { lessonSelector: "h1", autoNext: false };
  let last = { lesson: "", lessonSrc: "", lessonAlt: "", url: "", ended: false, endedAt: 0, playing: false, entryVisible: false, viewport: null };
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
  let lastPauseSkipLog = 0; // 暂停守卫日志节流（九轮定时器每轮触发，30s 一条防刷屏）
  // 本帧视频自上次开播以来播完过（ended 事件；播放器人工派发的 ended 也算——
  // video.ended 属性在 srcObject/重置场景不可靠）。播完后的暂停在等连播点击，
  // 不是用户暂停；playing 恢复时清除。无陈旧解除：播完弹窗停留多久都该点
  let endedArmed = false;
  // 本帧曾真的在播过（playing 上报为真）。「用户暂停」的判据——从未在播过的
  // 帧不适用暂停守卫：信号盲区站点（保利威类，video 在跨域 iframe）顶层可能
  // 存在从未播放的壳 video（paused && !ended），若拦它等于拦死弹窗连播点击
  let playingSeen = false;

  function attemptAdvance() {
    const vids = [...document.querySelectorAll("video")];
    if (anyPlaying()) return; // 主视频在播，无需连播（主视频化：浮层预览在播不算——播完场景浮层不挡弹窗点击）
    // 纯暂停守卫（暂停碎片第一道防线，diag_pause 实锤）：本帧存在 video、全部
    // 「已暂停且未播完」、从未播完过（endedArmed）且曾真的在播过（playingSeen）
    // = 用户暂停等待。连播点击只服务「播完去下一节」，暂停态点击 pause 控制
    // 栏常驻的 next 类按钮（点击无导航效果也回报 advance-clicked）会每 15s
    // 冷却期满切一个静止画面碎片（B 站实测 16.0s 自持循环），next 真有效时
    // 还会跳课。playingSeen 前提豁免信号盲区站（壳 video 从未在播，不是暂停）；
    // 帧内无 video 的盲区帧同样不拦——连播兜底点击照常
    if (vids.length && vids.every((v) => v.paused && !v.ended) && !endedArmed && playingSeen) {
      if (Date.now() - lastPauseSkipLog > 30000) {
        lastPauseSkipLog = Date.now();
        logAdvance("自动连播：视频暂停中，跳过连播点击");
      }
      return;
    }
    if (Date.now() - lastClickAt < ADV_CLICK_COOLDOWN) return; // 本帧冷却
    // 冷却查询走消息（session 已不对 UNTRUSTED 上下文开放——审计 S1）；
    // 查询失败（旧实例上下文失效 / SW 未响应）降级为直接点击
    let req;
    try {
      req = chrome.runtime.sendMessage({ type: "advance-cooldown" });
    } catch (e) {
      // 扩展重载后旧实例的 chrome API 在调用本身同步抛（彻底停摆：旧实例仍能
      // 操作页面 DOM，降级点击会真的跳课；新实例已由守卫 token 机制重建接管）
      advTimers.forEach(clearTimeout);
      advTimers = [];
      return;
    }
    Promise.resolve(req).then((r) => {
      if (r && r.ok && Date.now() - r.ts < ADV_CLICK_COOLDOWN) {
        advTimers.forEach(clearTimeout);
        advTimers = [];
        logAdvance("自动连播：冷却期内（已有点击），跳过");
        return;
      }
      doClick();
    }).catch(() => doClick());
  }

  function doClick() {
    const how = clickTextNext() || clickClassHint() || clickListNext();
    if (how) {
      advTimers.forEach(clearTimeout);
      advTimers = [];
      lastClickAt = Date.now();
      chrome.storage.session.set({ lastAdvanceClick: Date.now() }).catch(() => {});
      // 点击成功即时回报：offscreen 收到后从 between 立即续录（早于页面导航），
      // 新节内容零丢失——否则恢复要等 URL 稳定 3s，新节自动开播的头几秒会漏录
      try { chrome.runtime.sendMessage({ type: "advance-clicked" }); } catch (e) {}
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
  // 杂音特征：加载/异常页的拼接文案与目录统计（连播跳转窗口实测「返回 QAQ…共0个
  // 课时…课程大纲」恰好 78 字通过长度校验）——含这些特征的值直接丢弃，等页面
  // 加载完成后的真名。通用防护，非站点特判。
  const NOISE_PATTERNS = [
    /-{2,}|—{2,}|~{2,}/,              // 连续分隔符堆叠：多段拼接文案特征
    /\d+\s*个(课时|课程|视频|节)/,      // 目录统计（共 N 个课时）
    /已学习|总时长|课程大纲|正在加载|请稍后|加载中/,
  ];
  const okName = (t) => {
    const s = clean(t);
    if (!(s.length >= 2 && s.length <= 80) || isJunk(s)) return "";
    if (NOISE_PATTERNS.some((re) => re.test(s))) return "";
    return s;
  };

  // 通用界面词不算课时名（目录高亮启发式的误抓防护）
  const GENERIC_WORDS = new Set([
    "首页", "课程", "目录", "简介", "评论", "下载", "分享", "全屏", "播放", "暂停",
    "笔记", "问答", "资料", "讨论", "公告", "讲义", "习题", "测试", "考试", "更多",
    "课程大纲", "大纲", "返回", "上一节", "下一节",
  ]);

  function report() {
    try {
      chrome.runtime.sendMessage({
        type: "content-report",
        data: {
          lesson: last.lesson, lessonSrc: last.lessonSrc,
          lessonAlt: last.lessonAlt, lessonAltSrc: last.lessonAlt ? "active-item" : "",
          url: last.url, ended: last.ended, playing: last.playing,
          viewport: last.viewport,
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
  // 按**优先级逐个**查询（不是逗号合并一次查——合并查询按文档序返回，页面上
  // 文档序更早的弱标记元素（播放器设置项/option[selected]，常带 aria-selected）
  // 会抢在真正的分集列表项之前返回错值——B 站/路飞识别退化根因）。
  // [selected]/[aria-selected]：YouTube 播放列表（ytd-*-renderer[selected]）与
  // ARIA 组件库的通用标记——排最后兜底且排除 option（下拉框选中项不是课时）
  const ACTIVE_SELS = [
    '[aria-current="true" i]', '[aria-current="page" i]',
    'li[class*="active" i] a', 'a[class*="active" i]',
    'li[class*="current" i] a', 'a[class*="current" i]',
    'li[class~="on"] a', '[class*="playing" i]:not(video)',
    'dd[class*="active" i]', '[class~="active" i]', '[class*="active" i]',
    '[selected]:not(option)', '[aria-selected="true" i]:not(option)',
  ];

  function pickActiveListItem() {
    for (const sel of ACTIVE_SELS) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of els) {
        if (!visible(el)) continue;
        if (el.closest("nav,header,footer")) continue; // 导航/页眉页脚里的高亮不是课时
        // 播放器控件黑名单：清晰度/倍速/选集菜单的"当前项"也带 active 高亮
        //（B 站实测 bpx-player-ctrl-quality-menu-item bpx-state-active 文本
        // "自动(360P 流畅)"，可见时抢在分集列表前返回错值）——控件容器不是课时
        if (el.closest('[class*="ctrl" i],[class*="control" i],[class*="menu" i],[role="menu"]')) continue;
        // 容器型命中跳过（v2.8.7）：命中元素若含 ≥2 个可见且文本非空的 li/a/dd
        // 子条目，它是列表容器而非"当前条目"——容器只会给出第一个子项的文本
        // = 恒第一课（路飞命名恒第一课的机制嫌疑：目录容器 class 含
        // active/current 子串被子串选择器命中）
        let entryCount = 0;
        for (const c of el.querySelectorAll("li,a,dd")) {
          if (visible(c) && clean(c.textContent).length >= 2 && ++entryCount >= 2) break;
        }
        if (entryCount >= 2) continue;
        // 命中项优先取内部标题子元素——分集/目录列表项常为「序号+标题+时长」混排
        //（B 站列表项整项 innerText="01. xxx 05:20"，.title-txt 才是纯集名；
        // YouTube 列表项是 span#video-title——class 或 id 含 title 都认）
        for (const t of el.querySelectorAll("[class*='title' i],[id*='title' i]")) {
          const s = okName(t.textContent);
          if (s && !GENERIC_WORDS.has(s)) return s;
        }
        // 兜底整项文本并剥尾部时长（mm:ss / h:mm:ss）
        let t = okName(el.innerText || el.textContent);
        if (t) {
          t = clean(t.replace(/\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/, ""));
          if (t.length >= 2 && !GENERIC_WORDS.has(t)) return t;
        }
      }
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
        endedArmed = true; // 播完后的暂停不是用户暂停（连播守卫依据，无陈旧解除）
        report();
        scheduleAdvance(); // 分节模式：播完自动尝试播放下一节
      });
      v.addEventListener("playing", () => {
        cancelAdvance(); // 视频恢复播放，无需连播
        endedArmed = false; // 重新开播后的暂停才是真暂停
        if (last.ended) { last.ended = false; report(); }
      });
    });
  }

  // 本帧是否有视频正在播放（供 offscreen 的"停播静默"切节判定）
  function anyPlaying() {
    // 主视频判定（v2.8.6）：取可视面积最大的 video——暂停页的推荐浮层预览
    // 小窗自动播不算"页面在播"（否则 playing 心跳持续，停播切节与无播放收工
    // 被浮层永久阻塞，用户实锤三站收工失效的主因之一）；主视频 paused 即停播
    const vids = document.querySelectorAll("video");
    let main = null, best = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width * r.height > best) {
        best = r.width * r.height;
        main = v;
      }
    }
    return !!main && !main.paused && !main.ended;
  }

  // 连播入口可见性（播完弹窗类信号，offscreen 用于"播完即停录"）：class 启发式
  // 轻量查询，词表扫描留给点击层。只认 next/skip/continue——close 类在播放中
  // 会误命中（关闭按钮），不进此信号。播放中的贴片「跳过」类误报由 playing
  // 心跳在 offscreen 端作废挂起。变化沿上报：常驻目录项不产生新事件。
  function nextEntryVisible() {
    const els = document.querySelectorAll('[class*="next" i],[class*="skip" i],[class*="continue" i]');
    for (const el of els) {
      if (visible(el)) return true;
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
  // 连播入口可见性：变化沿事件化——只有「此前不可见 → 现在可见」才发独立消息
  //（data:{advanceEntry:true}）。首轮建立基线：注入时常驻可见的入口（播放器控制栏
  // 「下一集」按钮等）不算新出现；detector 重注入后重建基线，iframe 重载同理。
  // 快照 report 不携带该状态——forceReport 全量上报会把常驻入口误当弹窗新出现。
  let entryBaselineSet = false;

  // 扩展上下文是否已失效（重载后的旧实例）：调用任一 chrome API 同步抛错即死
  const ctxDead = () => { try { chrome.runtime.getURL(""); return false; } catch (e) { return true; } };

  let pollTimerId = 0;
  pollTimerId = setInterval(() => {
    if (ctxDead()) {
      // 扩展重载后的旧实例：彻底停摆并**清守卫标记**——守卫残留会让同 token 的
      // keepalive 补注入静默空操作（新实例被挡），检测全链路死亡（识别「第N节」
      // + 连播失效）。清除后补注入即可重建实例（token func 不匹配路径本来就会清）
      clearInterval(pollTimerId);
      advTimers.forEach(clearTimeout);
      advTimers = [];
      delete window.__tabRecDetector;
      return;
    }
    trackVideos();
    const { name, src } = resolveLessonName();
    // 帧内备选：高亮列表项与主值并行上报——B 站 mediaSession 恒为合集总标题
    //（级联首位挡死 active-item，分集名从未离开页面=v2.5.5 修复无效的根因），
    // 竞争上移到 offscreen 的多源语义层（降级挂起接管等）裁决
    const altName = src === "active-item" ? "" : pickActiveListItem();
    // url 只报顶层帧：iframe 的 location.href（广告容器/预创建组件常见 about:blank）
    // 与换课无关，混进来会与顶层地址交替覆盖、每次交替都判为内容变化 → 周期性碎切
    //（YouTube 实测 ~10s 碎片根因）
    const url = window.top === window ? location.href : "";
    // 播放/入口信号限顶层帧（与 url 同判定，审计 M-a）：iframe 里的广告/预加载
    // 视频持续在播会不停刷新引擎的"最后在播"时刻——停播切节与自动收工被广告帧
    // 阻塞永不触发；跨帧 next 类元素也会伪造入口信号
    const isTop = window.top === window;
    const playing = isTop ? anyPlaying() : false;
    if (playing) playingSeen = true; // 「用户暂停」判据的前提（见 attemptAdvance 守卫）
    const entryVisible = isTop ? nextEntryVisible() : false;
    if (!entryBaselineSet) {
      entryBaselineSet = true;
    } else if (entryVisible && !last.entryVisible) {
      try {
        chrome.runtime.sendMessage({ type: "content-report", data: { advanceEntry: true } });
      } catch (e) { /* 扩展上下文失效时静默 */ }
    } else if (!entryVisible && last.entryVisible) {
      // 入口消失反沿：弹窗被点掉（自动连播或用户手动）→ offscreen between 态
      // 立即续录，覆盖无点击回报的手动场景；误消失（控制栏淡出）后果是提前
      // 恢复录旧页静止至跳转，本就待恢复，无害
      try {
        chrome.runtime.sendMessage({ type: "content-report", data: { advanceExit: true } });
      } catch (e) { /* 扩展上下文失效时静默 */ }
    }
    last.entryVisible = entryVisible;
    // 实时视口只报顶层帧（裁剪映射的基准观测，缩放/窗口变化即沿上报）
    if (window.top === window) {
      last.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
    }
    const vpChanged = JSON.stringify(last.viewport) !== last.vpJson;
    if (vpChanged) last.vpJson = JSON.stringify(last.viewport);
    if (forceReport || vpChanged || playing !== last.playing || name !== last.lesson || altName !== last.lessonAlt || url !== last.url) {
      forceReport = false;
      last.lesson = name;
      last.lessonSrc = src;
      last.lessonAlt = altName;
      last.url = url;
      last.playing = playing;
      report();
    } else if (playing) {
      // 播放心跳：offscreen 的停播判定（5s 闸）依赖 playing 上报持续刷新
      // lastPlayingTs——变化沿上报会让持续播放期间静默，lastPlayingTs 冻结在
      // 开播时刻，每约 30s 必误切一段（v2.3.1 N 段根因）。在播期间每轮上报。
      report();
    }
    if (last.ended && Date.now() - last.endedAt > 10000) last.ended = false; // 未收到 playing 的兜底解除
  }, 700);

  trackVideos();
})();

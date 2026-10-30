# -*- coding: utf-8 -*-
"""B 站多 P 页面课时名级联诊断：打开多 P 视频页，CDP 在页面上下文采样
resolveLessonName 各源的原始输出与 ACTIVE_SELS 逐选择器命中清单，回答
「active-item 为什么没识别到 B 站分集列表」。

用法：python scripts/diag_bili.py [视频URL] [--edge]
（默认 CfT 131——本体已删，需先重新下载；--edge 用本机 Edge，B 站诊断推荐）
"""
import json
import shutil
import subprocess
import sys
import time
import urllib.request

CHROME_CFT = "E:/ZCodeProjects/tab-recorder/.cft/chrome-win64/chrome.exe"
EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PORT = 9253
PROFILE = "E:/ZCodeProjects/tab-recorder/.diag-bili-profile"
DEFAULT_URL = "https://www.bilibili.com/video/BV15j411H7Zc/"
PROXY = "127.0.0.1:7897"  # 本机代理（访问 YouTube 等外网站点必需；B 站直连不受影响）

# 在页面上下文采样级联各源（与 content-detect 逻辑同源，独立内联不依赖扩展授权）
PROBE_JS = r"""(() => {
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const isJunk = (s) => !s || /^[0-9a-f]{20,}$/i.test(s) || /^\d{10,}$/.test(s);
  const NOISE_PATTERNS = [/-{2,}|—{2,}|~{2,}/, /\d+\s*个(课时|课程|视频|节)/, /已学习|总时长|课程大纲|正在加载|请稍后|加载中/];
  const okName = (t) => { const s = clean(t); return s.length >= 2 && s.length <= 80 && !isJunk(s) && !NOISE_PATTERNS.some((r) => r.test(s)) ? s : ""; };
  const GENERIC = new Set(["首页","课程","目录","简介","评论","下载","分享","全屏","播放","暂停","笔记","问答","资料","讨论","公告","讲义","习题","测试","考试","更多","课程大纲","大纲","返回","上一节","下一节"]);
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // 逐选择器采样（镜像 v2.5.4 ACTIVE_SELS 优先级逐个查询）：每级列出前 5 个命中的
  // class/文本/校验四元组——直接看到「哪一级返回了什么」，断点即现
  const ACTIVE_SELS = ['[aria-current="true" i]','[aria-current="page" i]','li[class*="active" i] a','a[class*="active" i]','li[class*="current" i] a','a[class*="current" i]','li[class~="on"] a','[class*="playing" i]:not(video)','dd[class*="active" i]','[class*="active" i]','[selected]:not(option)','[aria-selected="true" i]:not(option)'];
  const perSel = [];
  for (const sel of ACTIVE_SELS) {
    let hits = [];
    try {
      hits = [...document.querySelectorAll(sel)].slice(0, 5).map((el) => ({
        cls: String(el.className).slice(0, 60),
        text: clean(el.innerText || el.textContent || "").slice(0, 40),
        ok: !!okName(el.innerText || el.textContent),
        vis: visible(el),
        nav: !!el.closest("nav,header,footer"),
      }));
    } catch (e) { hits = [{ err: String(e).slice(0, 60) }]; }
    if (hits.length) perSel.push({ sel, hits });
  }

  // 逐选择器版 pickActiveListItem 模拟（与当前实现一致：含 title 子元素优先 + 播放器控件黑名单）
  const simNewLogic = (() => {
    for (const sel of ACTIVE_SELS) {
      let els; try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of els) {
        if (!visible(el)) continue;
        if (el.closest("nav,header,footer")) continue;
        if (el.closest('[class*="ctrl" i],[class*="control" i],[class*="menu" i],[role="menu"]')) continue;
        for (const t of el.querySelectorAll("[class*='title' i],[id*='title' i]")) {
          const s = okName(t.textContent);
          if (s && !GENERIC.has(s)) return { via: sel + " >title", val: s };
        }
        let t = okName(el.innerText || el.textContent);
        if (t) {
          t = clean(t.replace(/\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s*$/, ""));
          if (t.length >= 2 && !GENERIC.has(t)) return { via: sel, val: t };
        }
      }
    }
    return { via: "none", val: "" };
  })();

  let nearVideo = [];
  try {
    const v = document.querySelector("video");
    if (v) {
      let p = v.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        for (const h of p.querySelectorAll("h1,h2,h3,[class*='title' i]")) {
          nearVideo.push({ tag: h.tagName, cls: String(h.className).slice(0, 40), text: clean(h.textContent).slice(0, 40) });
        }
        p = p.parentElement;
      }
      nearVideo = nearVideo.slice(0, 10);
    }
  } catch (e) { nearVideo = [{ err: String(e) }]; }

  let msTitle = "";
  try { msTitle = (navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.title) || ""; } catch (e) {}

  // 祖先链采样：分集项与播放器高亮控件的 closest class 链（验证控件黑名单不误伤）
  const ancChain = (el) => { let out = []; let p = el; for (let i = 0; i < 8 && p && p !== document.body; i++) { out.push(String(p.className).slice(0, 30)); p = p.parentElement; } return out; };
  const ancestors = {};
  try { const a = document.querySelector(".video-pod__item.active"); if (a) ancestors.podItem = ancChain(a); } catch (e) {}
  try { const q = document.querySelector(".bpx-player-ctrl-quality-menu-item.bpx-state-active, [class*='ctrl-quality']"); if (q) ancestors.qualityItem = ancChain(q); } catch (e) {}

  return JSON.stringify({
    url: location.href,
    docTitle: document.title,
    mediaSession: clean(msTitle),
    h1: clean((document.querySelector("h1") || {}).textContent || ""),
    biliActiveTitleTxt: clean((document.querySelector(".video-pod__item.active .title-txt") || {}).textContent || "(NOT FOUND)"),
    biliActiveFullText: clean((document.querySelector(".video-pod__item.active") || {}).innerText || "(NOT FOUND)").slice(0, 60),
    ytSelectedTitle: clean((document.querySelector("ytd-playlist-panel-video-renderer[selected] #video-title") || {}).textContent || "(NOT FOUND)"),
    // 全级联模拟（对齐真实上报）：主值 = 级联首位非空（B 站=mediasession 合集标题），
    // 备选 lessonAlt = active-item 并行——offscreen 端降级挂起接管的输入
    fullCascade: (() => {
      let msTitle = ""; try { msTitle = (navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.title) || ""; } catch (e) {}
      const h1 = clean((document.querySelector("h1") || {}).textContent || "");
      const main = clean(msTitle) || okName(h1) || simNewLogic.val || "";
      const alt = main === simNewLogic.val ? "" : simNewLogic.val;
      return { main, alt, altSrc: alt ? "active-item" : "" };
    })(),
    simNewLogic,
    nearVideo,
    perSel,
    ancestors,
  });
})()"""


def http_json(path, method="GET"):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), method=method)
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.n = 0

    def cmd(self, method, params=None):
        self.n += 1
        i = self.n
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == i:
                if "error" in m:
                    raise RuntimeError("%s -> %s" % (method, m["error"].get("message")))
                return m.get("result", {})

    def eval(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
        if "exceptionDetails" in r:
            raise RuntimeError("eval 抛错: " + json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")


def main():
    global websocket
    import websocket

    argv = [a for a in sys.argv[1:]]
    use_edge = "--edge" in argv
    if use_edge:
        argv.remove("--edge")
    url = argv[0] if argv else DEFAULT_URL
    host = urllib.request.urlparse(url).hostname or ""
    browser = EDGE if use_edge else CHROME_CFT
    if not use_edge and not shutil.which(browser):
        raise SystemExit("CfT 131 本体已删（需要时重新下载），加 --edge 用本机 Edge")
    # 外网站点（youtube.com 等）走本机代理；bilibili.com 直连不受影响
    args = [
        browser, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--window-size=1400,900", "--window-position=20,20",
        "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--proxy-server=" + PROXY,
        url,
    ]
    shutil.rmtree(PROFILE, ignore_errors=True)
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        for _ in range(30):
            time.sleep(1)
            try:
                http_json("/json/version")
                break
            except Exception:
                pass
        time.sleep(1)
        page = None
        for _ in range(20):
            for t in http_json("/json/list"):
                if t.get("type") == "page" and host in t.get("url", ""):
                    page = t
                    break
            if page:
                break
            time.sleep(1)
        assert page, "目标页面未打开（%s）" % host
        pc = CDP(page["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        time.sleep(15)  # 等页面与播放器初始化（YouTube 慢加载需更久）

        for i in range(3):
            if i:
                time.sleep(3)
            raw = pc.eval(PROBE_JS)
            print("—— 采样 %d ——" % (i + 1))
            print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
    finally:
        proc.kill()


if __name__ == "__main__":
    main()

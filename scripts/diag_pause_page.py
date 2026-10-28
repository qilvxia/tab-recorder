# -*- coding: utf-8 -*-
"""暂停态页面信号流观测（不加载扩展）：回答「暂停 120 秒内页面到底发生什么」——
顶层 URL 是否周期变化（哪个参数、指纹剥进度参数后是否仍判变化）、全部 <video>
的行为（暂停浮层预览是否自动播、ended 事件源）、next/skip/continue 可见元素变化。

碎片根因判别输入：B 站 ~15s / YouTube ~47s 的碎片周期若与某类事件周期吻合即实锤。

用法：python scripts/diag_pause_page.py [视频URL] [--edge]
默认 B 站多 P 合集页；YouTube 传 URL 即可（走本机代理）。
"""
import json
import shutil
import subprocess
import sys
import time
import urllib.request

EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PORT = 9254
PROFILE = "E:/ZCodeProjects/tab-recorder/.diag-pausepage-profile"
DEFAULT_URL = "https://www.bilibili.com/video/BV15j411H7Zc/"
PROXY = "127.0.0.1:7897"

PLAY_SEC = 15      # 先播多少秒再暂停
PAUSE_SEC = 120    # 暂停后观测多少秒

# 常驻观测器：URL 变化流（含指纹判定）/ video 事件与快照 / next 类可见元素变化沿
PROBE_INSTALL = r"""(() => {
  if (window.__pauseProbe) return "already";
  const PROG = ["t","t2","time","start","progress","at","ts","timestamp"];
  const fp = (href) => { try { const u = new URL(href); PROG.forEach(k => u.searchParams.delete(k)); u.hash = ""; return u.origin + u.pathname + u.search; } catch (e) { return href; } };
  const cls = (el) => { const c = el && el.className; return typeof c === "string" ? c : (c && c.baseVal) || ""; };
  const who = (v) => { let p = v; for (let i = 0; i < 4 && p; i++) { const c = cls(p); if (c) return c.slice(0, 50); p = p.parentElement; } return "video#" + (v.id || "anon"); };
  const P = { t0: Date.now(), urlEvents: [], videoEvents: [], entryEvents: [], videoSnap: [] };
  window.__pauseProbe = P;

  let lastHref = location.href, lastFp = fp(location.href);
  const diffKeys = (a, b) => {
    try {
      const ua = new URL(a), ub = new URL(b), out = [];
      const keys = new Set([...ua.searchParams.keys(), ...ub.searchParams.keys()]);
      for (const k of keys) if (ua.searchParams.get(k) !== ub.searchParams.get(k)) out.push(k);
      if (out.length) return out.join(",");
      if (ua.pathname !== ub.pathname) return "path";
      return (ua.hash !== ub.hash) ? "hash" : "?";
    } catch (e) { return "?"; }
  };
  setInterval(() => {
    try {
      const h = location.href;
      if (h !== lastHref) {
        const f = fp(h);
        P.urlEvents.push({ at: Date.now() - P.t0, api: "poll", changed: f !== lastFp, diff: diffKeys(lastHref, h), href: String(h).slice(0, 150) });
        lastHref = h; lastFp = f;
      }
    } catch (e) {}
  }, 400);
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k].bind(history);
    history[k] = function (...a) {
      try { P.urlEvents.push({ at: Date.now() - P.t0, api: k, changed: null, href: String(a[2] || location.href).slice(0, 150) }); } catch (e) {}
      return orig(...a);
    };
  }

  // play/pause/ended 不冒泡，capture 阶段在 document 上捕获全部 video 的事件
  for (const ev of ["play", "pause", "ended", "emptied"]) {
    document.addEventListener(ev, (e) => {
      const v = e.target;
      if (!v || v.tagName !== "VIDEO") return;
      P.videoEvents.push({ at: Date.now() - P.t0, ev, who: who(v), paused: v.paused, t: +v.currentTime.toFixed(1) });
    }, true);
  }
  setInterval(() => {
    try {
      P.videoSnap = [...document.querySelectorAll("video")].map((v) => ({
        who: who(v), paused: v.paused, ended: v.ended, t: +v.currentTime.toFixed(1),
        dur: +(v.duration || 0).toFixed(1), size: v.videoWidth + "x" + v.videoHeight,
      }));
    } catch (e) {}
  }, 1000);

  // 模拟 content-detect advanceEntry 源：next/skip/continue 可见元素集合变化沿
  const entrySel = '[class*="next" i],[class*="skip" i],[class*="continue" i]';
  let lastKey = "\x00";
  setInterval(() => {
    try {
      const els = [...document.querySelectorAll(entrySel)].filter((el) => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const key = els.map((el) => cls(el).slice(0, 40)).sort().join("|");
      if (key !== lastKey) {
        P.entryEvents.push({ at: Date.now() - P.t0, count: els.length, sample: els.slice(0, 5).map((el) => cls(el).slice(0, 40)) });
        lastKey = key;
      }
    } catch (e) {}
  }, 700);
  return "installed@ " + location.href.slice(0, 80);
})()"""

FIND_MAIN_VIDEO = r"""(() => {
  const vs = [...document.querySelectorAll("video")];
  if (!vs.length) return JSON.stringify({ err: "no video" });
  const main = vs.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  const p = main.play();
  if (p && p.catch) p.catch((e) => { window.__pauseProbe.playErr = String(e).slice(0, 80); });
  return JSON.stringify({ total: vs.length, mainSize: main.videoWidth + "x" + main.videoHeight, dur: +((main.duration || 0).toFixed(1)) });
})()"""

PAUSE_MAIN = r"""(() => {
  const vs = [...document.querySelectorAll("video")];
  const main = vs.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  if (!main) return "no video";
  main.pause();
  return "paused@ t=" + main.currentTime.toFixed(1);
})()"""

DUMP = r"""JSON.stringify(window.__pauseProbe || { err: "probe missing" })"""


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


def fmt_at(ms):
    return "%6.1fs" % (ms / 1000.0)


def report(data):
    print("\n===== URL 变化流（%d 条）=====" % len(data["urlEvents"]))
    changed_ts = []
    for e in data["urlEvents"]:
        mark = ""
        if e.get("changed"):
            mark = " ←指纹判内容变化"
            changed_ts.append(e["at"])
        print("%s [%s] diff=%s%s %s" % (fmt_at(e["at"]), e.get("api"), e.get("diff"), mark, e["href"][:110]))
    if len(changed_ts) >= 2:
        gaps = [round((b - a) / 1000.0, 1) for a, b in zip(changed_ts, changed_ts[1:])]
        print(">> 指纹判内容变化的间隔序列（秒）: %s" % gaps)
    else:
        print(">> 指纹判内容变化次数: %d" % len(changed_ts))

    print("\n===== video 事件流（%d 条）=====" % len(data["videoEvents"]))
    for e in data["videoEvents"][:80]:
        print("%s %-7s %-40s paused=%s t=%s" % (fmt_at(e["at"]), e["ev"], e["who"][:40], e["paused"], e["t"]))

    print("\n===== next/skip/continue 可见元素变化沿（%d 条）=====" % len(data["entryEvents"]))
    for e in data["entryEvents"][:40]:
        print("%s count=%d %s" % (fmt_at(e["at"]), e["count"], json.dumps(e["sample"], ensure_ascii=False)[:150]))

    print("\n===== 结束时 video 快照 =====")
    for v in data["videoSnap"]:
        print("  %s paused=%s ended=%s t=%s dur=%s size=%s" % (v["who"][:40], v["paused"], v["ended"], v["t"], v["dur"], v["size"]))


def main():
    global websocket
    import websocket

    argv = list(sys.argv[1:])
    use_edge = "--edge" in argv
    if use_edge:
        argv.remove("--edge")
    url = argv[0] if argv else DEFAULT_URL
    host = urllib.request.urlparse(url).hostname or ""
    browser = EDGE if use_edge else EDGE
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
        page = None
        for _ in range(25):
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
        time.sleep(15)  # 等页面与播放器初始化

        print("观测器注入:", pc.eval(PROBE_INSTALL))
        info = json.loads(pc.eval(FIND_MAIN_VIDEO))
        print("主视频:", info)
        assert "err" not in info, "页面无 video"

        print("—— 播放 %ds ——" % PLAY_SEC)
        time.sleep(PLAY_SEC)
        print("—— 暂停 ——")
        print(pc.eval(PAUSE_MAIN))

        last = None
        for _ in range(PAUSE_SEC // 5):
            time.sleep(5)
            last = json.loads(pc.eval(DUMP))
            ue = len(last["urlEvents"])
            ve = len(last["videoEvents"])
            snap = "; ".join("%s p=%s t=%s" % (v["who"][:20], v["paused"], v["t"]) for v in last["videoSnap"][:3])
            print("  [t+%ds] url事件=%d video事件=%d | %s" % (PLAY_SEC + (5 * (_ + 1) - 5), ue, ve, snap))
        report(last)
    finally:
        proc.kill()
        shutil.rmtree(PROFILE, ignore_errors=True)


if __name__ == "__main__":
    main()

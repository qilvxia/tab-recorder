# -*- coding: utf-8 -*-
"""Chrome 文件名丢弃问题实测（Chrome for Testing）：
offscreen 建 blob → SW chrome.downloads.download(filename=变体) → 落地后读实际文件名。
矩阵：① 子目录+中文（现状）② 仅中文名 ③ 纯 ASCII 名 ④ 不传 filename 对照。
用法：python scripts/diag_chrome_name.py [浏览器路径]  （默认 CfT，可传 msedge 对照）
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

CHROME_CFT = "E:/ZCodeProjects/tab-recorder/.cft/chrome-win64/chrome.exe"  # CfT 131（148 在部分机器上秒退 code=3）
CHROME_EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9242
PROFILE = "E:/ZCodeProjects/tab-recorder/.smoke-profile"
EXT_NAME = "标签页录制器"

VARIANTS = [
    ("subdir+中文", "TabRecorder/中文名_abc123.mp4"),
    ("仅中文名", "中文名_abc123.mp4"),
    ("纯ASCII", "abc123.mp4"),
    ("对照-无filename", None),
]


def http_json(path, method="GET"):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), method=method)
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=90, suppress_origin=True)
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


DL_JS = """(async () => {
  const filename = __FN__;
  const opts = {url: __URL__, saveAs: false, conflictAction: 'uniquify'};
  if (filename !== null) opts.filename = filename;
  const r = await new Promise((res) => chrome.downloads.download(opts, (id) => {
    const e = chrome.runtime.lastError;
    res(e ? {err: e.message} : {id});
  }));
  return JSON.stringify(r);
})()"""

STATE_JS = """(async () => {
  const it = (await chrome.downloads.search({id: __ID__}))[0];
  if (!it) return JSON.stringify({state: 'gone'});
  return JSON.stringify({state: it.state, filename: it.filename, got: it.receivedBytes});
})()"""

CLEAN_JS = """(async () => {
  const items = await chrome.downloads.search({});
  for (const it of items) {
    try { if (it.state === 'complete' || it.state === 'interrupted') chrome.downloads.removeFile(it.id); } catch (e) {}
  }
  await chrome.downloads.erase({});
  return 'ok';
})()"""


def main():
    global websocket
    import websocket
    browser = sys.argv[1] if len(sys.argv) > 1 else CHROME_CFT
    tag = "CfT" if browser == CHROME_CFT else "Edge"

    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    proc = subprocess.Popen([
        browser, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--no-first-run", "--no-default-browser-check",
        "--load-extension=" + EXT,
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(30):
            time.sleep(1)
            try:
                http_json("/json/version")
                break
            except Exception:
                pass
        try:
            urllib.request.urlopen(urllib.request.Request(
                "http://127.0.0.1:%d/json/new?about:blank" % PORT, method="PUT"), timeout=8).read()
        except Exception:
            pass
        time.sleep(1.5)
        ours = None
        for _ in range(40):
            time.sleep(1)
            for t in http_json("/json/list"):
                if t.get("type") != "service_worker" or not t.get("webSocketDebuggerUrl"):
                    continue
                try:
                    c = CDP(t["webSocketDebuggerUrl"])
                    if EXT_NAME in str(c.eval("(chrome.runtime.getManifest()||{}).name || ''")):
                        ours = t
                        break
                    c.ws.close()
                except Exception:
                    pass
            if ours:
                break
        assert ours, "未找到扩展 SW"
        sw = CDP(ours["webSocketDebuggerUrl"])
        sw.cmd("Runtime.enable")

        sw.eval("chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'diag'}).catch(()=>{})",
                await_promise=True)
        time.sleep(1.5)
        off = None
        for t in http_json("/json/list"):
            if t.get("url", "").endswith("offscreen.html"):
                off = t
                break
        oc = CDP(off["webSocketDebuggerUrl"])
        oc.cmd("Runtime.enable")

        ua = sw.eval("navigator.userAgent")
        print("浏览器 UA:", ua)
        print("== filename 形态矩阵（%s）==" % tag)
        results = {}
        for name, fn in VARIANTS:
            url = oc.eval("URL.createObjectURL(new Blob([new Uint8Array(512 * 1024).fill(7)]))")
            r = json.loads(sw.eval(DL_JS.replace("__FN__", json.dumps(fn))
                                          .replace("__URL__", json.dumps(url)), await_promise=True))
            landed = None
            deadline = time.time() + 20
            while time.time() < deadline:
                time.sleep(0.8)
                try:
                    st = json.loads(sw.eval(STATE_JS.replace("__ID__", str(r.get("id", -1))), await_promise=True))
                except Exception:
                    continue
                if st.get("state") in ("complete", "interrupted", "gone"):
                    landed = st
                    break
            ok = None
            if landed and fn:
                import re
                base = re.split(r"[\\/]", landed.get("filename", ""))[-1]
                # blob 类型为 octet-stream 时扩展名会被改写（.mp4→.txt），比较主名即可
                stem = re.sub(r"\.[^.]+$", "", base)
                want_stem = re.sub(r"\.[^.]+$", "", os.path.basename(fn))
                ok = (stem == want_stem)
            results[name] = {"start": r, "landed": landed, "name_ok": ok}
            print("  %-14s start=%s | 落地=%s | 名字生效=%s" % (name, r, landed, ok))

        sw.eval(CLEAN_JS, await_promise=True)
        print("\nDIAG-CHROME-NAME(%s):" % tag, json.dumps({k: v["name_ok"] for k, v in results.items()}, ensure_ascii=False))
    finally:
        proc.kill()


if __name__ == "__main__":
    main()

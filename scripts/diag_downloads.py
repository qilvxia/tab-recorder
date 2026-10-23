# -*- coding: utf-8 -*-
"""下载通道对照实验 v2：
  B: offscreen 建 blob URL → SW 发起 downloads.download（现行产品路径）×3 轮
  G: 可见扩展页面（popup.html 窗口）内 自建 blob 下载 ×2 轮
  G2: 可见扩展页面 fetch(offscreen 的 blob URL) → 重建 blob → createObjectURL → 下载 ×3 轮（候选产品链路）
"""
import json
import os
import shutil
import subprocess
import time
import urllib.request

CHROME = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9240
PROFILE = "E:/ZCodeProjects/tab-recorder/.smoke-profile"
EXT_NAME = "标签页录制器"


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


MAKE_BLOB_JS = """(() => {
  window.__diagBlob = new Blob([new Uint8Array(3 * 1024 * 1024).fill(7)], {type: 'application/octet-stream'});
  return window.__diagBlob.size;
})()"""

DOWNLOAD_IN_PAGE_JS = """(async () => {
  const url = URL.createObjectURL(window.__diagBlob);
  const id = await new Promise((res, rej) => chrome.downloads.download(
    {url, filename: 'TabRecorder/__NAME__.bin', saveAs: false, conflictAction: 'uniquify'},
    (i) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(i)));
  const state = await new Promise((res) => {
    const h = (delta) => { if (delta.id === id && delta.state) { chrome.downloads.onChanged.removeListener(h); res(delta.state.current); } };
    chrome.downloads.onChanged.addListener(h);
    setTimeout(() => { chrome.downloads.onChanged.removeListener(h); res('timeout15s'); }, 15000);
  });
  try { URL.revokeObjectURL(url); } catch (e) {}
  return JSON.stringify({id, state});
})()"""

FETCH_PAGE_JS = """(async () => {
  // 页面 fetch offscreen 创建的 blob URL → 重建 blob → 本页 createObjectURL → 下载
  const remote = __REMOTE__;
  const buf = await (await fetch(remote)).arrayBuffer();
  const blob = new Blob([buf], {type: 'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  const id = await new Promise((res, rej) => chrome.downloads.download(
    {url, filename: 'TabRecorder/__NAME__.bin', saveAs: false, conflictAction: 'uniquify'},
    (i) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(i)));
  const state = await new Promise((res) => {
    const h = (delta) => { if (delta.id === id && delta.state) { chrome.downloads.onChanged.removeListener(h); res(delta.state.current); } };
    chrome.downloads.onChanged.addListener(h);
    setTimeout(() => { chrome.downloads.onChanged.removeListener(h); res('timeout15s'); }, 15000);
  });
  try { URL.revokeObjectURL(url); } catch (e) {}
  try { URL.revokeObjectURL(remote); } catch (e) {}
  return JSON.stringify({id, state, bytes: buf.byteLength});
})()"""

SW_DL_JS = """(async () => {
  const id = await new Promise((res, rej) => chrome.downloads.download(
    {url: __URL__, filename: 'TabRecorder/__NAME__.bin', saveAs: false, conflictAction: 'uniquify'},
    (i) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(i)));
  const state = await new Promise((res) => {
    const h = (delta) => { if (delta.id === id && delta.state) { chrome.downloads.onChanged.removeListener(h); res(delta.state.current); } };
    chrome.downloads.onChanged.addListener(h);
    setTimeout(() => { chrome.downloads.onChanged.removeListener(h); res('timeout15s'); }, 15000);
  });
  return JSON.stringify({id, state});
})()"""

CLEAN_JS = """(async () => {
  const items = await chrome.downloads.search({filenameRegex: 'TabRecorder.*'});
  for (const it of items) { try { chrome.downloads.removeFile(it.id); } catch (e) {} }
  await chrome.downloads.erase({filenameRegex: 'TabRecorder.*'});
  return items.length;
})()"""


def wait_state(cdp, name):
    js = """(async () => {
      const it = (await chrome.downloads.search({filenameRegex: 'TabRecorder.*__NAME__.*'}))[0];
      if (!it) return 'no-item';
      if (it.state !== 'in_progress') return it.state + ':' + it.receivedBytes;
      const r = await new Promise((res) => {
        const h = (delta) => { if (delta.id === it.id && delta.state) { chrome.downloads.onChanged.removeListener(h); res(delta.state.current); } };
        chrome.downloads.onChanged.addListener(h);
        setTimeout(() => { chrome.downloads.onChanged.removeListener(h); res('still-in_progress:' + it.receivedBytes); }, 12000);
      });
      return r;
    })()""".replace("__NAME__", name)
    return cdp.eval(js, await_promise=True)


def main():
    global websocket
    import websocket
    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    proc = subprocess.Popen([
        CHROME, "--remote-debugging-port=%d" % PORT,
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

        # 打开一个可见扩展页面窗口（用 options.html，比 popup.html 干净：无轮询逻辑）
        win = json.loads(sw.eval(
            "chrome.windows.create({url: chrome.runtime.getURL('options.html'), type:'popup', width:420, height:300, focused:false}).then(w => JSON.stringify({id: w.id, tabs: w.tabs.map(t=>t.id)}))",
            await_promise=True))
        page_tab = win["tabs"][0]
        pg = None
        for _ in range(20):
            time.sleep(0.5)
            for t in http_json("/json/list"):
                if t.get("type") == "page" and t.get("url", "").endswith("options.html"):
                    pg = t
                    break
            if pg:
                break
        pc = CDP(pg["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        time.sleep(1)

        print("== B: offscreen blob → SW 下载（现行产品路径）×3 ==")
        for rnd in range(3):
            url = oc.eval("URL.createObjectURL(new Blob([new Uint8Array(3*1024*1024).fill(7)]))")
            r = sw.eval(SW_DL_JS.replace("__URL__", json.dumps(url))
                              .replace("__NAME__", "b%d" % rnd), await_promise=True)
            st = wait_state(sw, "b%d" % rnd)
            print("  B%d: %s | 终态 %s" % (rnd, r, st))

        print("== G: 可见扩展页面自建 blob 下载 ×2 ==")
        for rnd in range(2):
            pc.eval(MAKE_BLOB_JS)
            r = pc.eval(DOWNLOAD_IN_PAGE_JS.replace("__NAME__", "g%d" % rnd), await_promise=True)
            print("  G%d: %s" % (rnd, r))

        print("== G2: 页面 fetch(offscreen blob) 中转下载 ×3 ==")
        for rnd in range(3):
            url = oc.eval("URL.createObjectURL(new Blob([new Uint8Array(3*1024*1024).fill(7)]))")
            r = pc.eval(FETCH_PAGE_JS.replace("__REMOTE__", json.dumps(url))
                                    .replace("__NAME__", "h%d" % rnd), await_promise=True)
            st = wait_state(sw, "h%d" % rnd)
            print("  H%d: %s | 终态 %s" % (rnd, r, st))

        sw.eval(CLEAN_JS, await_promise=True)
        sw.eval("chrome.windows.remove(%d).catch(()=>{})" % win["id"])
    finally:
        proc.kill()


if __name__ == "__main__":
    main()

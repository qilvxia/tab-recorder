# -*- coding: utf-8 -*-
"""allFrames 调用形态验证：SW 级执行 executeScript({target:{tabId, allFrames:true}, func})
对 e2e-test.html tab 采集 video 清单——验证 v2.8.10 修复后的调用形态有效
（v2.8.9 把 allFrames 放顶层被 Chrome 参数校验拒绝）。跑完即退，不录制。

用法：python scripts/check_allframes.py
"""
import json
import os
import shutil
import subprocess
import time
import urllib.request

BROWSER = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9257
PROFILE = "E:/ZCodeProjects/tab-recorder/.diag-tmp/allframes-profile"
EXT_NAME = "标签页录制器"


def http_json(path):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path))
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


class CDP:
    def __init__(self, ws_url):
        import websocket
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self.n = 0

    def cmd(self, method, params=None):
        self.n += 1
        i = self.n
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == i:
                if "error" in m:
                    raise RuntimeError(m["error"].get("message"))
                return m.get("result", {})

    def eval(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")


def main():
    global websocket
    import websocket

    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    proc = subprocess.Popen([
        BROWSER, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--window-size=1200,800", "--no-first-run", "--no-default-browser-check",
        "--load-extension=" + EXT, "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(30):
            time.sleep(1)
            try:
                http_json("/json/version")
                break
            except Exception:
                pass
        ours = None
        for _ in range(30):
            for t in http_json("/json/list"):
                if t.get("type") != "service_worker" or not t.get("webSocketDebuggerUrl"):
                    continue
                try:
                    c = CDP(t["webSocketDebuggerUrl"])
                    if EXT_NAME in str(c.eval("(chrome.runtime.getManifest()||{}).name || ''")):
                        ours = c
                        break
                    c.ws.close()
                except Exception:
                    pass
            if ours:
                break
            time.sleep(1)
        assert ours, "未找到扩展 SW"
        tab_id = ours.eval("chrome.tabs.create({url:chrome.runtime.getURL('e2e-test.html'), active:true}).then(t=>t.id)",
                           await_promise=True)
        time.sleep(3)
        # v2.8.10 修复后的调用形态：allFrames 在 target 内
        expr = ("new Promise(r=>chrome.scripting.executeScript("
                "{target:{tabId:%d,allFrames:true},func:()=>({url:location.href.slice(0,60),n:document.querySelectorAll('video').length})},"
                "(res)=>r({err:chrome.runtime.lastError?String(chrome.runtime.lastError.message):null,"
                "frames:(res||[]).map(x=>x.result)})))" % tab_id)
        out = ours.eval(expr, await_promise=True)
        print("allFrames 调用结果:", json.dumps(out, ensure_ascii=False))
        if out.get("err"):
            # 无用户手势（SW 直调）时 activeTab 未授予 → host 权限拒绝 = 预期；
            # 只要不是 "Error in invocation"（参数校验失败）即证明调用形态有效
            assert "invocation" not in out["err"], "参数校验失败: %s" % out["err"]
            print("验证 PASS：调用形态有效（host 权限拒绝 = 无手势的预期，用户场景 popup 点击已授予 activeTab）")
        else:
            assert out.get("frames"), "无帧返回"
            print("验证 PASS：调用形态有效，返回 %d 帧" % len(out["frames"]))
    finally:
        proc.kill()
        shutil.rmtree(PROFILE, ignore_errors=True)


if __name__ == "__main__":
    main()

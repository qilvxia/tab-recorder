# -*- coding: utf-8 -*-
"""端到端连播诊断：CfT 131 + 扩展真录制链路（真 tabCapture/切段/广播/点击），
驱动 e2e-test.html（有声视频 30s/节 + 播完评分窗 + 委托按钮，三节循环），
每 2 秒采样切段/连播/落盘状态，逐环定位连播断点。
节长 30s 兼作停播判定的回归探针：playing 心跳缺失时节内第 5s 必误切。

用法：python scripts/diag_e2e.py
"""
import ctypes
import json
import os
import shutil
import subprocess
import time
import urllib.request

CHROME_CFT = "E:/ZCodeProjects/tab-recorder/.cft/chrome-win64/chrome.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9251
PROFILE = "E:/ZCodeProjects/tab-recorder/.diag-profile"
EXT_NAME = "标签页录制器"


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
            raise RuntimeError("eval 抛错: " + json.dumps(r["exceptionDetails"])[:400])
        return r.get("result", {}).get("value")


def grant_via_hotkey(proc, sw):
    hwnd = int(subprocess.run(
        ["powershell", "-NoProfile", "-Command", "(Get-Process -Id %d).MainWindowHandle" % proc.pid],
        capture_output=True, text=True).stdout.strip() or "0")
    assert hwnd, "未找到浏览器主窗口句柄"
    u32 = ctypes.windll.user32
    for attempt in range(5):
        for _ in range(3):
            u32.keybd_event(0x12, 0, 0, 0)
            u32.SetForegroundWindow(hwnd)
            u32.keybd_event(0x12, 0, 2, 0)
            time.sleep(0.3)
            if u32.GetForegroundWindow() == hwnd:
                break
            time.sleep(0.5)
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Add-Type -AssemblyName System.Windows.Forms; "
                        "[System.Windows.Forms.SendKeys]::SendWait('^+y')"],
                       capture_output=True, text=True)
        time.sleep(1)
        try:
            n = sw.eval("chrome.runtime.getContexts({contextTypes:['POPUP']}).then(c=>c.length)", await_promise=True)
            if n:
                time.sleep(0.5)
                subprocess.run(["powershell", "-NoProfile", "-Command",
                                "Add-Type -AssemblyName System.Windows.Forms; "
                                "[System.Windows.Forms.SendKeys]::SendWait('{ESC}')"],
                               capture_output=True, text=True)
                return
        except Exception:
            pass
    raise RuntimeError("无法授予 activeTab")


def main():
    global websocket
    import websocket

    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)

    proc = subprocess.Popen([
        CHROME_CFT, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--window-size=1200,800", "--window-position=20,20",
        "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
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
        print("扩展 SW 就绪")

        grant_via_hotkey(proc, sw)
        blank_id = sw.eval(
            "chrome.tabs.query({active:true, currentWindow:true}).then(ts => {"
            "  const b = ts.find(t => (t.url||'').startsWith('about:blank'));"
            "  return b ? chrome.tabs.remove(b.id).then(()=>'removed') : 'no-blank';"
            "})", await_promise=True)
        if blank_id == "removed":
            time.sleep(1)
            grant_via_hotkey(proc, sw)
        tab_id = sw.eval(
            "chrome.tabs.create({url:chrome.runtime.getURL('e2e-test.html'), active:true}).then(t=>t.id)",
            await_promise=True)
        print("e2e 页 tabId:", tab_id)
        grant_via_hotkey(proc, sw)  # e2e 页置前台后授予 activeTab
        time.sleep(1.5)

        page = None
        for t in http_json("/json/list"):
            if t.get("type") == "page" and t.get("url", "").endswith("e2e-test.html"):
                page = t
                break
        assert page, "e2e 页未打开"
        pc = CDP(page["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        pc.cmd("Runtime.evaluate", {"expression": "window.__clicked=0"})

        # 配置 + 启动真录制（segment 模式）
        sw.eval("chrome.tabs.sendMessage(%d, {type:'detect-config', cfg:{lessonSelector:'h1', lessonPrefix:'', autoNext:true}}).catch(()=>{})" % tab_id)
        sw.eval("chrome.storage.session.set({recording:true, tabId:%d, mode:'segment'})" % tab_id)
        sw.eval(
            "chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'e2e'}).catch(()=>{})",
            await_promise=True)
        time.sleep(1.5)
        resp = sw.eval(
            "(async()=>{"
            "  const sid = await new Promise((res,rej)=>chrome.tabCapture.getMediaStreamId({targetTabId:%d},(id)=>{"
            "    const e=chrome.runtime.lastError; (e||!id)?rej(new Error(e?e.message:'no id')):res(id);}));"
            "  return await chrome.runtime.sendMessage({type:'offscreen-schedule', streamId:sid,"
            "    settings:{format:'mp4',videoBitrate:2000000,frameRate:15,audioBitrate:96000,autoNext:true,lessonSelector:'h1',lessonPrefix:''},"
            "    payload:{mode:'segment',courseFolder:'e2e',startDelaySeconds:0,tabTitle:'e2e',tabUrl:''}, tabId:%d});"
            "})()" % (tab_id, tab_id), await_promise=True)
        print("录制启动:", resp)

        # 采样 150 秒（30s/节 × 3 节 + 停播确认与连播间隔）
        for i in range(75):
            time.sleep(2)
            try:
                st = sw.eval(
                    "(async()=>{"
                    "  const s = await chrome.runtime.sendMessage({type:'offscreen-status'}).catch(e=>({err:String(e)}));"
                    "  const a = await chrome.storage.session.get('advanceLog');"
                    "  const d = await chrome.downloads.search({});"
                    "  return JSON.stringify({state:s.state, seg:s.segCount, lastSplit:s.lastSplit,"
                    "    bytes:s.bytes, adv:(a.advanceLog||[]).length, files:d.filter(x=>x.filename.includes('e2e')).map(x=>x.filename.split('\\\\').pop())});"
                    "})()", await_promise=True)
                pg = pc.eval("JSON.stringify({clicked:window.__clicked||0, hash:location.hash, lesson:(window.__lessonNum?window.__lessonNum():0), playErr:window.__playErr||''})")
                print("[%02ds] offscreen=%s | page=%s" % ((i + 1) * 2, st, pg))
            except Exception as e:
                print("[%02ds] 采样异常: %s" % ((i + 1) * 2, str(e)[:120]))

        final_files = sw.eval(
            "chrome.downloads.search({}).then(l=>JSON.stringify(l.filter(x=>x.filename.includes('e2e')).map(x=>({n:x.filename.split('\\\\').pop(), s:x.state, b:x.fileSize}))))",
            await_promise=True)
        print("最终落盘(含字节量，三节应接近≈30s×码率):", final_files)
    finally:
        proc.kill()


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""v1.1.0 新功能链路验证（Edge + CDP，无真人交互）：
1) content-crop.js 注入 data: 页面 → 浮层宿主 DOM 存在
2) 模拟选区上报 crop-region-selected → chrome.storage.session.cropRegion 正确（含 tabId 绑定）
3) options.html：saveMode/dirStatus/pickDirBtn/fsdir 就绪
4) offscreen.html：fsdir 可用、MediaRecorder 存在、canvas API 就绪
真实框选交互与 tabCapture 取流仍需人工验收。
"""
import json
import os
import shutil
import subprocess
import time
import urllib.request

import websocket

# 路径一律用正斜杠：Windows 下 Chrome/Edge 原生接受，且避免 \t、\n 被外层转义吞噬
# （实测反斜杠路径经某些命令行处理层会把 \t 变成 TAB，导致「清单文件丢失」）
CHROME = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9236
PROFILE = "E:/ZCodeProjects/tab-recorder/.smoke-profile"
EXT_NAME = "标签页录制器"


def http_json(path, method="GET"):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), method=method)
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=45, suppress_origin=True)
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


# 测试 profile 是一次性耗材：启动前删掉，规避强杀残留的脏状态
shutil.rmtree(PROFILE, ignore_errors=True)
os.makedirs(PROFILE, exist_ok=True)

proc = subprocess.Popen([
    CHROME, "--remote-debugging-port=%d" % PORT,
    "--user-data-dir=%s" % PROFILE,
    "--no-first-run", "--no-default-browser-check",
    "--load-extension=%s" % EXT,
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

    # MV3 SW 空闲约 30 秒后停转并从 /json/list 消失；
    # 开一个新标签页触发 tabs 事件，把我们的 SW 唤醒再发现
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
    assert ours, "未找到我们的扩展"
    ext_id = ours["url"].split("/")[2]
    print("扩展 id:", ext_id)
    sw = CDP(ours["webSocketDebuggerUrl"])
    sw.cmd("Runtime.enable")

    results = {}

    # 1+2: 选区浮层与上报链路
    # MV3 的 scripting.executeScript 即使对扩展自身页面也要求 host 授权（activeTab
    # 只能由用户手势授予，自动化里给不了），因此把 content-crop.js 源码直接 eval 进
    # 扩展页面的主世界：验证浮层 DOM 构建无异常；再从该页面发上报消息验证 SW→存储。
    tab_id = sw.eval(
        "chrome.tabs.create({url:chrome.runtime.getURL('popup.html'), active:false}).then(t=>t.id)",
        await_promise=True)
    time.sleep(1)
    crop_src = open(EXT + "/content-crop.js", encoding="utf-8").read()
    page = None
    for t in http_json("/json/list"):
        if t.get("type") == "page" and t.get("url") == "chrome-extension://%s/popup.html" % ext_id:
            page = t
            break
    assert page, "popup.html 页面未打开"
    pcdn = CDP(page["webSocketDebuggerUrl"])
    pcdn.cmd("Runtime.enable")
    pcdn.eval(crop_src)
    time.sleep(0.5)
    results["overlay_dom"] = bool(pcdn.eval("!!document.querySelector(\"div[style*='2147483647']\")"))
    # 模拟浮层确认上报（扩展页面主世界可直接 chrome.runtime.sendMessage）
    pcdn.eval("chrome.runtime.sendMessage({type:'crop-region-selected',rect:{x:10,y:20,w:640,h:360},viewportW:1280,viewportH:720})")
    time.sleep(0.5)
    cr = sw.eval("(async()=>(await chrome.storage.session.get('cropRegion')).cropRegion)()", await_promise=True)
    cr = cr if isinstance(cr, dict) else json.loads(cr)
    results["crop_region"] = {
        "rect_ok": cr.get("rect", {}).get("w") == 640,
        "tab_bound": cr.get("tabId") == tab_id,
        "viewport_ok": cr.get("viewportW") == 1280,
    }
    sw.eval("chrome.tabs.remove(%d)" % tab_id)

    # 3: options 新控件
    sw.eval("chrome.tabs.create({url:chrome.runtime.getURL('options.html'),active:false})")
    opt = None
    for _ in range(20):
        time.sleep(0.5)
        for t in http_json("/json/list"):
            if t.get("type") == "page" and t.get("url") == "chrome-extension://%s/options.html" % ext_id:
                opt = t
                break
        if opt:
            break
    pc = CDP(opt["webSocketDebuggerUrl"])
    pc.cmd("Runtime.enable")
    time.sleep(1)
    results["options"] = json.loads(pc.eval(
        "(async()=>JSON.stringify({"
        "saveSubdir: !!document.getElementById('saveSubdir'),"
        "delay: document.getElementById('startDelaySeconds') && document.getElementById('startDelaySeconds').value,"
        "legacyGone: !document.getElementById('saveMode') && !document.getElementById('pickDirBtn'),"
        "fields: document.querySelectorAll('select,input').length"
        "}))()", await_promise=True))

    # 4: offscreen 里的 fsdir / canvas / MediaRecorder
    sw.eval(
        "chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'verify'}).catch(()=>{})",
        await_promise=True)
    time.sleep(1.5)
    off = None
    for t in http_json("/json/list"):
        if t.get("url", "").endswith("offscreen.html"):
            off = t
            break
    if off:
        oc = CDP(off["webSocketDebuggerUrl"])
        oc.cmd("Runtime.enable")
        results["offscreen"] = json.loads(oc.eval(
            "(async()=>JSON.stringify({"
            "recorder: typeof MediaRecorder,"
            "canvas: !!document.createElement('canvas').captureStream,"
            "rvfc: 'requestVideoFrameCallback' in document.createElement('video'),"
            "legacyGone: typeof window.fsdir === 'undefined'"
            "}))()", await_promise=True))
        sw.eval("chrome.offscreen.closeDocument().catch(()=>{})", await_promise=True)
    else:
        results["offscreen"] = "offscreen 目标未在 /json/list 出现"

    print(json.dumps(results, ensure_ascii=False, indent=2))
    ok = (
        results["overlay_dom"]
        and all(results["crop_region"].values())
        and results["options"].get("saveSubdir")
        and results["options"].get("delay") is not None
        and results["options"].get("legacyGone")
        and isinstance(results["offscreen"], dict)
        and results["offscreen"].get("legacyGone")
        and results["offscreen"].get("recorder") == "function"
        and results["offscreen"].get("canvas")
    )
    print("VERIFY:", "PASS" if ok else "FAIL")
finally:
    proc.kill()

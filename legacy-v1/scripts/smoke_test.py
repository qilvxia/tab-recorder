# -*- coding: utf-8 -*-
"""扩展冒烟测试（Edge，--load-extension 可用）：
1) 加载扩展 → 找到我们的 SW（按 manifest 名称强校验，排除浏览器组件扩展）
2) 由 SW 自己 chrome.tabs.create 打开 popup / options
3) 页面自触发 reload 捕获加载期异常，断言关键 DOM 存在
4) 额外验证 offscreen 文档创建/关闭链路（不发真实取流）
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
PORT = 9235
PROFILE = "E:/ZCodeProjects/tab-recorder/.smoke-profile"
EXT_NAME = "标签页录制器"


def http_json(path, method="GET"):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), method=method)
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=45, suppress_origin=True)
        self.n = 0
        self.events = []

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
            if "method" in m:
                self.events.append(m)

    def eval(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
        if "exceptionDetails" in r:
            raise RuntimeError("eval 抛错: " + json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")

    def drain(self, seconds):
        self.ws.settimeout(seconds)
        try:
            while True:
                m = json.loads(self.ws.recv())
                if "method" in m:
                    self.events.append(m)
        except Exception:
            pass
        self.ws.settimeout(45)

    def exceptions(self):
        out = []
        for m in self.events:
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                out.append(d.get("text", "") + " " + str((d.get("exception") or {}).get("description", ""))[:200])
        return out


# 测试 profile 是一次性耗材：启动前删掉，规避强杀残留的脏状态（卡恢复弹窗、扩展被禁用等）
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

    # MV3 SW 空闲约 30 秒后停转并从 /json/list 消失（复用 profile 时尤其明显）；
    # 开一个新标签页触发 tabs 事件，把我们的 SW 唤醒再发现
    try:
        urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:%d/json/new?about:blank" % PORT, method="PUT"), timeout=8).read()
    except Exception:
        pass
    time.sleep(1.5)

    # 找到「我们的」SW：逐个检查 service_worker 目标的 manifest 名称
    ours = None
    for _ in range(40):
        time.sleep(1)
        for t in http_json("/json/list"):
            if t.get("type") != "service_worker" or not t.get("webSocketDebuggerUrl"):
                continue
            try:
                c = CDP(t["webSocketDebuggerUrl"])
                name = c.eval("(chrome.runtime.getManifest()||{}).name || ''")
                if EXT_NAME in str(name):
                    ours = t
                    break
                c.ws.close()
            except Exception:
                pass
        if ours:
            break
    assert ours, "未找到我们的扩展（--load-extension 失效或扩展加载失败）"
    ext_id = ours["url"].split("/")[2]
    print("我们的扩展 id:", ext_id)
    swc = CDP(ours["webSocketDebuggerUrl"])
    swc.cmd("Runtime.enable")

    ok_all = True
    for name, expr in [
        ("popup.html",
         "JSON.stringify({startBtn: !!document.getElementById('startBtn'), "
         "modeBtns: document.querySelectorAll('.modeBtn').length, "
         "stateChip: (document.getElementById('stateChip')||{textContent:''}).textContent, "
         "recBoxHidden: (document.getElementById('recBox')||{classList:{contains:()=>null}}).classList.contains('hidden')})"),
        ("options.html",
         "JSON.stringify({saveBtn: !!document.getElementById('saveBtn'), "
         "fields: document.querySelectorAll('select,input').length})"),
    ]:
        swc.eval("chrome.tabs.create({url: chrome.runtime.getURL('%s'), active: false}).then(t=>t.id)" % name, await_promise=True)
        page = None
        for _ in range(20):
            time.sleep(0.5)
            for t in http_json("/json/list"):
                if t.get("type") == "page" and t.get("url") == "chrome-extension://%s/%s" % (ext_id, name):
                    page = t
                    break
            if page:
                break
        assert page, "%s 页面未打开" % name
        pc = CDP(page["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        pc.cmd("Runtime.evaluate", {"expression": "location.reload()"})
        time.sleep(3)
        pc.drain(1.5)
        info = json.loads(pc.eval(expr))
        exc = pc.exceptions()
        print("%-12s -> %s | exceptions: %s" % (name, info, exc or "无 ✓"))
        ok_all = ok_all and not exc and info.get("startBtn", info.get("saveBtn"))
        pc.ws.close()

    # offscreen 创建/关闭链路（不取流，仅验证 API 可用）
    try:
        r = swc.eval(
            "(async()=>{"
            "const has=()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c=>c.length>0);"
            "if(!(await has())) await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'smoke'});"
            "const created=await has();"
            "await chrome.offscreen.closeDocument();"
            "const closed=!(await has());"
            "return JSON.stringify({created, closed});"
            "})()", await_promise=True)
        print("offscreen   ->", r, "| exceptions: 无 ✓" if json.loads(r)["created"] else "| 创建失败")
        ok_all = ok_all and json.loads(r)["created"] and json.loads(r)["closed"]
    except Exception as e:
        print("offscreen   -> 失败:", str(e)[:200])
        ok_all = False

    print("SMOKE:", "PASS" if ok_all else "FAIL")
finally:
    proc.kill()

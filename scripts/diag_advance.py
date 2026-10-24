# -*- coding: utf-8 -*-
"""连播链路决定性诊断（v2）：用扩展自带测试页（advance-test.html，上下文天然有
chrome.runtime，绕开 executeScript 挂起问题），驱动真实 content-detect 代码：

  段1（下游点击层）：SW 广播 try-advance → content-detect scheduleAdvance →
       attemptAdvance → activateEl 点击「放弃评价观看下一节」→ 页面 __clicked
  段2（上游触发层）：SW 发 content-report{ended}（模拟内容脚本上报）→
       SW 应广播 try-advance → 同上点击

判定：advanceLog 有记录 + 页面 __clicked > 0。
"""
import json
import os
import shutil
import subprocess
import time
import urllib.request

CHROME_CFT = "E:/ZCodeProjects/tab-recorder/.cft/chrome-win64/chrome.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9247
PROFILE = "E:/ZCodeProjects/tab-recorder/.diag-profile"
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
            raise RuntimeError("eval 抛错: " + json.dumps(r["exceptionDetails"])[:400])
        return r.get("result", {}).get("value")


def main():
    global websocket
    import websocket

    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)

    test_url = "chrome-extension://PLACEHOLDER/advance-test.html"
    proc = subprocess.Popen([
        CHROME_CFT, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--window-size=1200,800", "--window-position=20,20",
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
        ext_id = None
        for _ in range(40):
            time.sleep(1)
            for t in http_json("/json/list"):
                if t.get("type") != "service_worker" or not t.get("webSocketDebuggerUrl"):
                    continue
                try:
                    c = CDP(t["webSocketDebuggerUrl"])
                    if EXT_NAME in str(c.eval("(chrome.runtime.getManifest()||{}).name || ''")):
                        ours = t
                        ext_id = t["url"].split("/")[2]
                        break
                    c.ws.close()
                except Exception:
                    pass
            if ours:
                break
        assert ours, "未找到扩展 SW"
        sw = CDP(ours["webSocketDebuggerUrl"])
        sw.cmd("Runtime.enable")
        print("扩展 SW 就绪:", ext_id)

        # 打开扩展测试页（active）
        tab_id = sw.eval(
            "chrome.tabs.create({url:chrome.runtime.getURL('advance-test.html'), active:true}).then(t=>t.id)",
            await_promise=True)
        print("测试页 tabId:", tab_id)
        time.sleep(1.5)

        page = None
        for t in http_json("/json/list"):
            if t.get("type") == "page" and t.get("url", "").endswith("advance-test.html"):
                page = t
                break
        assert page, "测试页 CDP 目标未出现"
        pc = CDP(page["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        time.sleep(0.5)

        # 模拟录制中状态 + 下发 autoNext 配置（与产品 injectDetector 一致）
        sw.eval("chrome.storage.session.set({recording:true, tabId:%d, mode:'segment'})" % tab_id,
                await_promise=True)
        cfg_send = sw.eval(
            "chrome.tabs.sendMessage(%d, {type:'detect-config', cfg:{lessonSelector:'h1', lessonPrefix:'', autoNext:true}}).then(()=>true).catch(e=>'ERR:'+String(e))" % tab_id,
            await_promise=True)
        print("detect-config 下发:", cfg_send)
        time.sleep(0.5)

        # 段1：SW 广播 try-advance → 点击层（先显示弹窗，模拟播完弹出的评分窗）
        pc.eval("document.getElementById('modal').style.display='block'")
        print("\n== 段 1: SW 广播 try-advance（下游点击层）==")
        sw.eval("chrome.tabs.sendMessage(%d, {type:'try-advance'}).then(()=>true).catch(e=>'SEND-ERR:'+String(e))" % tab_id,
                await_promise=True)
        time.sleep(11)  # scheduleAdvance 2/5/8s 全轮
        alog = sw.eval("chrome.storage.session.get('advanceLog').then(s=>JSON.stringify(s.advanceLog||[]))",
                       await_promise=True)
        clicked = pc.eval("JSON.stringify({clicked: window.__clicked||0, hash: location.hash, modal: document.getElementById('modal').style.display})")
        print("  advanceLog:", alog)
        print("  页面状态:", clicked)
        seg1_ok = len(json.loads(alog or "[]")) > 0 and json.loads(clicked)["clicked"] > 0

        # 段2：SW 发 content-report{ended}（模拟内容脚本上报）→ 应广播 → 再次点击
        print("\n== 段 2: content-report{ended} → SW 广播（上游触发层）==")
        before = len(json.loads(alog or "[]"))
        sw.eval(
            "(chrome.runtime.onMessage.hasOwnProperty('addListener') ? null : null),"
            "(chrome.runtime.sendMessage({type:'content-report', data:{ended:true, lesson:'今日内容概述', lessonSrc:'selector', url:location.href}}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+String(e)))",
            await_promise=True)
        time.sleep(11)
        alog2 = sw.eval("chrome.storage.session.get('advanceLog').then(s=>JSON.stringify(s.advanceLog||[]))",
                        await_promise=True)
        clicked2 = pc.eval("JSON.stringify({clicked: window.__clicked||0})")
        print("  advanceLog:", alog2)
        print("  页面状态:", clicked2)
        seg2_ok = len(json.loads(alog2 or "[]")) > before and json.loads(clicked2)["clicked"] > 1

        print("\n段1 下游点击层:", "PASS" if seg1_ok else "FAIL")
        print("段2 上游触发层:", "PASS" if seg2_ok else "FAIL")
        print("DIAG-ADVANCE:", "PASS" if (seg1_ok and seg2_ok) else "FAIL")
    finally:
        proc.kill()


if __name__ == "__main__":
    main()

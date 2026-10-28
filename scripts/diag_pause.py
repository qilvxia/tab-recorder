# -*- coding: utf-8 -*-
"""暂停碎片扩展全链路复现：真站点（B 站默认/YouTube 传 URL）+ 真扩展录制链路
（tabCapture/分节/segUrlMode/连播广播），播放 15s 后暂停，采样 150s 切节状态。

判别表（按 lastSplit.reason 时间线归因）：
- 周期 advance-clicked（~16s）→ 45s 兜底/切段广播 × 点击链自持循环（冷却 15s+1s）
- 周期 advance-clicked（~47s）→ 45s 兜底广播驱动（自持链断、靠兜底重启）
- 周期 url-change → URL 切节路径（阶段 1 已证暂停态 URL 零变化，出现即意外）
- entry-visible / lesson-change → 对应信号路径
- 无碎片 + 60s 后 idle-wrap → 已修复/未复现

用法：python scripts/diag_pause.py [视频URL]
"""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

BROWSER = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9255
PROFILE = "E:/ZCodeProjects/tab-recorder/.diag-pause-profile"
EXT_NAME = "标签页录制器"
DEFAULT_URL = "https://www.bilibili.com/video/BV15j411H7Zc/"
PROXY = "127.0.0.1:7897"

PLAY_SEC = 15
SAMPLE_SEC = 150

FIND_MAIN_VIDEO = r"""(() => {
  const vs = [...document.querySelectorAll("video")];
  if (!vs.length) return JSON.stringify({ err: "no video" });
  const main = vs.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  const p = main.play();
  if (p && p.catch) p.catch(() => {});
  return JSON.stringify({ total: vs.length, dur: +((main.duration || 0).toFixed(1)) });
})()"""

PAUSE_MAIN = r"""(() => {
  const vs = [...document.querySelectorAll("video")];
  const main = vs.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  if (!main) return "no video";
  main.pause();
  return "paused@ t=" + main.currentTime.toFixed(1);
})()"""


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


def grant_via_hotkey(proc, sw, tab_id=None):
    # 焦点授予是间歇性链路（SetForegroundWindow 受前台锁限制）：popup 检测成功
    # 不等于 activeTab 已授予目标 tab——用 executeScript 真实验证，失败整轮重试
    u32 = ctypes.windll.user32
    hwnd = int(subprocess.run(
        ["powershell", "-NoProfile", "-Command", "(Get-Process -Id %d).MainWindowHandle" % proc.pid],
        capture_output=True, text=True, encoding="gbk", errors="ignore").stdout.strip() or "0")
    assert hwnd, "未找到浏览器主窗口句柄"
    for attempt in range(8):
        if tab_id is not None:
            try:
                sw.eval("chrome.tabs.update(%d, {active:true}).then(()=>1)" % tab_id, await_promise=True)
            except Exception:
                pass
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
                       capture_output=True, text=True, encoding="gbk", errors="ignore")
        time.sleep(1)
        try:
            n = sw.eval("chrome.runtime.getContexts({contextTypes:['POPUP']}).then(c=>c.length)", await_promise=True)
        except Exception:
            n = 0
        if n:
            time.sleep(0.5)
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            "Add-Type -AssemblyName System.Windows.Forms; "
                            "[System.Windows.Forms.SendKeys]::SendWait('{ESC}')"],
                           capture_output=True, text=True, encoding="gbk", errors="ignore")
        if tab_id is not None:
            try:
                ok = sw.eval(
                    "new Promise(r=>chrome.scripting.executeScript({target:{tabId:%d},func:()=>1},"
                    "()=>r(chrome.runtime.lastError?String(chrome.runtime.lastError.message):'ok')))" % tab_id,
                    await_promise=True)
                if ok == "ok":
                    return
                print("  授权验证失败(第%d次): %s" % (attempt + 1, str(ok)[:80]))
            except Exception as e:
                print("  授权验证异常(第%d次): %s" % (attempt + 1, str(e)[:80]))
    raise RuntimeError("无法授予 activeTab")


def main():
    global websocket
    import websocket

    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    host = urllib.request.urlparse(url).hostname or ""

    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    proc = subprocess.Popen([
        BROWSER, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--window-size=1400,900", "--window-position=20,20",
        "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--proxy-server=" + PROXY,
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
        ours = None
        for _ in range(40):
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
            time.sleep(1)
        assert ours, "未找到扩展 SW"
        sw = CDP(ours["webSocketDebuggerUrl"])
        sw.cmd("Runtime.enable")
        print("扩展 SW 就绪")

        tab_id = sw.eval("chrome.tabs.create({url:%r, active:true}).then(t=>t.id)" % url, await_promise=True)
        print("目标页 tabId:", tab_id)
        time.sleep(15)  # 等页面与播放器初始化
        grant_via_hotkey(proc, sw, tab_id)  # 目标页置前台后授予 activeTab

        page = None
        for t in http_json("/json/list"):
            if t.get("type") == "page" and host in t.get("url", ""):
                page = t
                break
        assert page, "目标页面未打开"
        pc = CDP(page["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        time.sleep(8)  # keepalive 补注入 detector（6s 心跳）

        sw.eval("chrome.storage.session.set({recording:true, tabId:%d, mode:'segment'})" % tab_id)
        sw.eval(
            "chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'diag'}).catch(()=>{})",
            await_promise=True)
        time.sleep(1.5)
        resp = sw.eval(
            "(async()=>{"
            "  const sid = await new Promise((res,rej)=>chrome.tabCapture.getMediaStreamId({targetTabId:%d},(id)=>{"
            "    const e=chrome.runtime.lastError; (e||!id)?rej(new Error(e?e.message:'no id')):res(id);}));"
            "  return await chrome.runtime.sendMessage({type:'offscreen-schedule', streamId:sid,"
            "    settings:{format:'mp4',videoBitrate:4000000,frameRate:30,audioBitrate:128000,"
            "              segUrlMode:true,autoNext:true,silenceWrapSeconds:60},"
            "    payload:{mode:'segment',startDelaySeconds:0,tabTitle:'diag'}, tabId:%d});"
            "})()" % (tab_id, tab_id), await_promise=True)
        print("录制启动:", resp)
        time.sleep(5)  # 倒计时/取流稳定

        print("—— 播放 %ds ——" % PLAY_SEC)
        print("主视频:", pc.eval(FIND_MAIN_VIDEO))
        time.sleep(PLAY_SEC)
        print("—— 暂停 ——")
        print(pc.eval(PAUSE_MAIN))

        t0 = time.time()
        events = []
        last_key = None
        for _ in range(SAMPLE_SEC):
            time.sleep(1)
            try:
                st = json.loads(sw.eval(
                    "(async()=>{"
                    "  const s = await chrome.runtime.sendMessage({type:'offscreen-status'}).catch(e=>({err:String(e)}));"
                    "  const a = await chrome.storage.session.get('advanceLog');"
                    "  return JSON.stringify({state:s.state, seq:s.seq, seg:s.segCount, lastSplit:s.lastSplit,"
                    "    playingAgo:(s.signals||{}).playingAgo, urlLog:s.urlLog||[], adv:(a.advanceLog||[])});"
                    "})()", await_promise=True))
                key = (st["state"], st["seq"], st["seg"], json.dumps(st["lastSplit"]))
                if key != last_key:
                    at = time.time() - t0
                    events.append((at, st["state"], st["seq"], st["seg"],
                                   (st["lastSplit"] or {}).get("reason"),
                                   (st["lastSplit"] or {}).get("at"),
                                   st["playingAgo"]))
                    print("[%5.1fs] state=%s seq=%s segCount=%s lastSplit=%s/%s playingAgo=%s"
                          % (at, st["state"], st["seq"], st["seg"],
                             (st["lastSplit"] or {}).get("reason"), (st["lastSplit"] or {}).get("at"), st["playingAgo"]))
                    last_key = key
                last_full = st
            except Exception as e:
                print("  采样异常: %s" % str(e)[:120])

        print("\n===== 切节原因时间线（暂停后）=====")
        reasons = [(at, r) for at, _, _, _, r, _, _ in events if r]
        for at, r in reasons:
            print("  %6.1fs %s" % (at, r))
        gaps = [round(b - a, 1) for (a, _), (b, _) in zip(reasons, reasons[1:])]
        print("切节间隔序列（秒）:", gaps)

        print("\n===== 连播点击日志（advanceLog 全量）=====")
        for e in (last_full or {}).get("adv", []):
            print(" ", json.dumps(e, ensure_ascii=False)[:160])

        print("\n===== urlLog（扩展视角 URL 变化）=====")
        for e in (last_full or {}).get("urlLog", []):
            print(" ", json.dumps(e, ensure_ascii=False)[:180])
    finally:
        proc.kill()
        shutil.rmtree(PROFILE, ignore_errors=True)


if __name__ == "__main__":
    main()

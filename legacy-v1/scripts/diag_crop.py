# -*- coding: utf-8 -*-
"""裁剪映射实测 v2：不经保存环节，字节走 CDP 回传。
链路：Ctrl+Shift+Y 授予 activeTab → SW 签发 streamId → popup.html(标签页) 内
getUserMedia 消费 tab 流 → ①基线直录 / ②按 offscreen.js 同款数学裁剪录 →
MediaRecorder(mp4) → base64 回传 → ffmpeg 抽帧 → PIL 分析参照线位置。

参照物：青线@25vw、品红@75vw、橙线@25vh、粉线@75vh。
判据：裁剪输出中四条线应落在四边（css 误差 ≤ 2px）。
"""
import base64
import ctypes
import json
import os
import shutil
import subprocess
import time
import urllib.parse
import urllib.request

from PIL import Image

CHROME = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
FFMPEG = "C:/Users/Admin/ffmpeg.exe"
EXT = "E:/ZCodeProjects/tab-recorder/extension"
PORT = 9241
PROFILE = "E:/ZCodeProjects/tab-recorder/.smoke-profile"
TMP = "E:/ZCodeProjects/tab-recorder/.diag-tmp"
EXT_NAME = "标签页录制器"

REF_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>tabrec-diag</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#000}
.v{position:absolute;top:0;bottom:0;width:3px}
.h{position:absolute;left:0;right:0;height:3px}
#c1{left:25vw;background:#00E5FF}
#c2{left:75vw;background:#E500E5}
#r1{top:25vh;background:#FF8C00}
#r2{top:75vh;background:#FF69B4}
#dot{position:absolute;left:calc(50vw - 4px);top:calc(50vh - 4px);width:8px;height:8px;background:#fff}
</style></head><body>
<div class="v" id="c1"></div><div class="v" id="c2"></div>
<div class="h" id="r1"></div><div class="h" id="r2"></div>
<div id="dot"></div>
</body></html>"""


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


def grant_via_hotkey(proc, swc):
    hwnd = int(subprocess.run(
        ["powershell", "-NoProfile", "-Command", "(Get-Process -Id %d).MainWindowHandle" % proc.pid],
        capture_output=True, text=True).stdout.strip() or "0")
    assert hwnd, "未找到 Edge 主窗口句柄"
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
            # 授予成功的判据：扩展 action 弹窗打开（activeTab 已授予）
            n = swc.eval("chrome.runtime.getContexts({contextTypes:['POPUP']}).then(c=>c.length)", await_promise=True)
            if n:
                time.sleep(0.5)
                subprocess.run(["powershell", "-NoProfile", "-Command",
                                "Add-Type -AssemblyName System.Windows.Forms; "
                                "[System.Windows.Forms.SendKeys]::SendWait('{ESC}')"],
                               capture_output=True, text=True)
                return
        except Exception:
            pass
    raise RuntimeError("无法授予 activeTab（Edge 未能置前台）")


# 消费 tab 流并录制（crop 数学与 extension/offscreen.js buildCropStream 完全一致）
CONSUME_JS = """(async () => {
  const streamId = __SID__;
  const crop = __CROP__;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: streamId}},
    video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30}}
  });
  const vt = stream.getVideoTracks()[0];
  const st = vt.getSettings ? (vt.getSettings() || {}) : {};
  let recStream = stream;
  let cropInfo = null;
  if (crop) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true;
    v.srcObject = new MediaStream([vt]);
    await v.play().catch(() => {});
    await new Promise((r) => { if (v.videoWidth) return r(); v.onloadedmetadata = r; });
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = crop.viewportW > 0 ? vw / crop.viewportW : 1;
    const letterbox = Math.max(0, (vh - crop.viewportH * scale) / 2);
    const r0 = crop.rect;
    const sx = Math.min(Math.max(0, Math.floor(r0.x * scale)), vw - 2);
    const sy = Math.min(Math.max(0, Math.floor(r0.y * scale + letterbox)), vh - 2);
    let sw = Math.min(vw - sx, Math.floor(r0.w * scale));
    let sh = Math.min(vh - sy, Math.floor(r0.h * scale));
    sw -= sw % 2; sh -= sh % 2;
    const cv = document.createElement('canvas');
    cv.width = sw; cv.height = sh;
    const ctx = cv.getContext('2d', {alpha: false});
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, sw, sh);
    const timer = setInterval(() => {
      try { if (v.readyState >= 2) ctx.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh); } catch (e) {}
    }, 33);
    const cs = cv.captureStream(30);
    cropInfo = {videoW: vw, videoH: vh, sx, sy, sw, sh};
    recStream = new MediaStream([cs.getVideoTracks()[0], ...stream.getAudioTracks()]);
  }
  const chunks = [];
  const rec = new MediaRecorder(recStream, {mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', videoBitsPerSecond: 1500000});
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start(1000);
  await new Promise((r) => setTimeout(r, 3000));
  rec.stop();
  await done;
  try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  const blob = new Blob(chunks, {type: 'video/mp4'});
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return JSON.stringify({b64: btoa(bin), track: {w: st.width || 0, h: st.height || 0}, crop: cropInfo});
})()"""


def record_cdp(pc, sid, crop):
    js = (CONSUME_JS.replace("__SID__", json.dumps(sid))
                    .replace("__CROP__", json.dumps(crop)))
    out = json.loads(pc.eval(js, await_promise=True))
    mp4 = os.path.join(TMP, ("crop" if crop else "base") + ".mp4")
    data = base64.b64decode(out["b64"])
    with open(mp4, "wb") as f:
        f.write(data)
    print("  录得 %d bytes（track=%s）" % (len(data), out.get("track")))
    return mp4, out.get("track"), out.get("crop")


def analyze(png):
    im = Image.open(png).convert("RGB")
    W, H = im.size
    px = im.load()
    vx = {"cyan": [], "magenta": []}
    hy = {"orange": [], "pink": []}
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            r, g, b = px[x, y]
            if r < 100 and g > 180 and b > 200:
                vx["cyan"].append(x)
            elif r > 180 and g < 100 and b > 180:
                vx["magenta"].append(x)
            elif r > 220 and 100 < g < 190 and b < 60:
                hy["orange"].append(y)
            elif r > 220 and 60 < g < 160 and b > 140:
                hy["pink"].append(y)
    def mid(v):
        return (min(v) + max(v)) / 2 if v else None
    return W, H, {k: mid(v) for k, v in vx.items()}, {k: mid(v) for k, v in hy.items()}


def frame_of(video, tag):
    out = os.path.join(TMP, tag + ".png")
    size = os.path.getsize(video) if os.path.exists(video) else -1
    for vf in ("select=eq(n\\,10)", "select=eq(n\\,3)", "select=eq(n\\,0)"):
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", video,
                        "-vf", vf, "-vframes", "1", out], check=True)
        if os.path.exists(out):
            return out
    raise RuntimeError("抽帧失败: %s (%d bytes)" % (video, size))


def main():
    global websocket
    import websocket
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)

    ref_url = "data:text/html;charset=utf-8," + urllib.parse.quote(REF_HTML)
    proc = subprocess.Popen([
        CHROME, "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + PROFILE,
        "--window-size=1400,900", "--window-position=20,20",
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
        print("扩展 SW 就绪")

        # 消费页面：popup.html 开成标签页（扩展页可 getUserMedia tab 流）
        sw.eval("chrome.tabs.create({url: chrome.runtime.getURL('popup.html'), active: false}).then(t => t.id)",
                await_promise=True)
        consumer = None
        for _ in range(20):
            time.sleep(0.5)
            for t in http_json("/json/list"):
                if t.get("type") == "page" and t.get("url", "").endswith("popup.html"):
                    consumer = t
                    break
            if consumer:
                break
        assert consumer, "消费页未打开"
        pc = CDP(consumer["webSocketDebuggerUrl"])
        pc.cmd("Runtime.enable")
        time.sleep(1)

        # 参照页标签（active，避免后台节流）
        tab_id = sw.eval(
            "chrome.tabs.create({url: %s, active: true}).then(t => t.id)" % json.dumps(ref_url),
            await_promise=True)
        time.sleep(1.5)

        # activeTab 授权 → streamId
        grant_via_hotkey(proc, sw)
        sid = sw.eval(
            "new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({targetTabId: %d}, (id) => { const e = chrome.runtime.lastError; (e || !id) ? rej(new Error(e ? e.message : 'no id')) : res(id); }))" % tab_id,
            await_promise=True)
        print("streamId 就绪")

        # ① 基线
        base_mp4, track, _ = record_cdp(pc, sid, None)
        print("基线: track=%s 文件=%s" % (track, base_mp4))

        # 视口尺寸（从参照页读）
        refpage = None
        for t in http_json("/json/list"):
            if t.get("type") == "page" and t.get("url", "").startswith("data:text/html"):
                refpage = t
                break
        rc = CDP(refpage["webSocketDebuggerUrl"])
        rc.cmd("Runtime.enable")
        dims = json.loads(rc.eval("JSON.stringify({iw:innerWidth, ih:innerHeight, dpr:devicePixelRatio})"))
        iw, ih, dpr = dims["iw"], dims["ih"], dims["dpr"]
        print("视口: %dx%d css, dpr=%s" % (iw, ih, dpr))

        # ② 裁剪（中心 50%），streamId 一次性，重新签发
        sid2 = sw.eval(
            "new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({targetTabId: %d}, (id) => { const e = chrome.runtime.lastError; (e || !id) ? rej(new Error(e ? e.message : 'no id')) : res(id); }))" % tab_id,
            await_promise=True)
        crop = {"rect": {"x": round(iw * 0.25), "y": round(ih * 0.25),
                         "w": round(iw * 0.5), "h": round(ih * 0.5)},
                "viewportW": iw, "viewportH": ih}
        crop_mp4, _, cinfo = record_cdp(pc, sid2, crop)
        print("裁剪: 内部信息=%s" % cinfo)

        # 分析
        for tag, f, trackd in (("base", base_mp4, track), ("crop", crop_mp4, cinfo)):
            png = frame_of(f, tag)
            W, H, vx, hy = analyze(png)
            print("[%s] 帧 %dx%d | 青=%s 品红=%s | 橙=%s 粉=%s" %
                  (tag, W, H, vx["cyan"], vx["magenta"], hy["orange"], hy["pink"]))
            if tag == "base":
                globals()["base"] = (W, H, vx, hy)
            else:
                globals()["cropped"] = (W, H, vx, hy)

        bW, bH, bvx, bhy = globals()["base"]
        cW, cH, cvx, chy = globals()["cropped"]
        print("\n—— 基线映射 ——")
        if bvx["cyan"]:
            print("青线位置比例: %.4f（全出血理论 0.25）| 帧尺寸比 x=%.4f y=%.4f" %
                  (bvx["cyan"] / bW, bW / iw, bH / ih))
        if bvx["magenta"]:
            print("品线位置比例: %.4f（理论 0.75）" % (bvx["magenta"] / bW))

        print("\n—— 裁剪段误差（css px，判据 ≤2px）——")
        ok = True
        sel = crop["rect"]
        checks = []
        if cvx["cyan"] is not None:
            checks.append(("cyan→左边", cvx["cyan"] / cW * sel["w"]))
        if cvx["magenta"] is not None:
            checks.append(("magenta→右边", (1 - cvx["magenta"] / cW) * sel["w"]))
        if chy["orange"] is not None:
            checks.append(("orange→顶边", chy["orange"] / cH * sel["h"]))
        if chy["pink"] is not None:
            checks.append(("pink→底边", (1 - chy["pink"] / cH) * sel["h"]))
        for name, v in checks:
            flag = "✓" if v <= 2 else "✗"
            ok = ok and v <= 2
            print("  %s %s: %.1f px" % (flag, name, v))

        # 反推真实映射
        if cvx["cyan"] is not None and cvx["magenta"] is not None:
            a = (cvx["magenta"] - cvx["cyan"]) / (0.5 * iw)
            bb = cvx["cyan"] - a * 0.25 * iw
            print("\n真实映射: frame_x = %.4f*css_x %+.2f（理想: %.4f*(css_x-%.1f), 偏移0）" %
                  (a, bb, cW / sel["w"], sel["x"]))
        if chy["orange"] is not None and chy["pink"] is not None:
            a = (chy["pink"] - chy["orange"]) / (0.5 * ih)
            bb = chy["orange"] - a * 0.25 * ih
            print("真实映射: frame_y = %.4f*css_y %+.2f（理想: %.4f*(css_y-%.1f), 偏移0）" %
                  (a, bb, cH / sel["h"], sel["y"]))

        print("\nDIAG-CROP:", "PASS" if ok else "FAIL")
    finally:
        proc.kill()
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()

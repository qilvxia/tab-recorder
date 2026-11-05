// content-crop.js — 注入页面（activeTab）：录制区域框选浮层
// 确认后上报视口坐标（CSS px），offscreen 按 视频尺寸/视口宽 换算成视频像素裁剪。
(() => {
  if (window.__tabRecCropSelector) return;
  window.__tabRecCropSelector = true;

  const Z = 2147483647;
  const MIN_W = 40, MIN_H = 30;

  const host = document.createElement("div");
  host.style.cssText = `all:initial; position:fixed; inset:0; z-index:${Z};`;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif; }
      .stage { position: fixed; inset: 0; cursor: crosshair; touch-action: none; }
      .box {
        position: fixed; display: none; cursor: move;
        border: 2px solid #4f8cff; background: rgba(79,140,255,.08);
        box-shadow: 0 0 0 100000px rgba(0,0,0,.45);
      }
      /* 微调句柄（v2.8.17）：四角双向 + 四边单向，压在边框上、角向外溢出便于抓取 */
      .hn { position: absolute; background: transparent; }
      .hn[data-h=n], .hn[data-h=s] {
        left: 16px; right: 16px; height: 12px; margin-top: -6px; cursor: ns-resize;
      }
      .hn[data-h=n] { top: 0; }
      .hn[data-h=s] { bottom: 0; }
      .hn[data-h=e], .hn[data-h=w] {
        top: 16px; bottom: 16px; width: 12px; margin-left: -6px; cursor: ew-resize;
      }
      .hn[data-h=e] { right: 0; }
      .hn[data-h=w] { left: 0; }
      .hn[data-h=nw], .hn[data-h=ne], .hn[data-h=sw], .hn[data-h=se] {
        width: 16px; height: 16px;
      }
      .hn[data-h=nw] { left: -8px; top: -8px; cursor: nwse-resize; }
      .hn[data-h=ne] { right: -8px; top: -8px; cursor: nesw-resize; }
      .hn[data-h=sw] { left: -8px; bottom: -8px; cursor: nesw-resize; }
      .hn[data-h=se] { right: -8px; bottom: -8px; cursor: nwse-resize; }
      .size {
        position: absolute; left: 0; top: -26px; white-space: nowrap;
        background: rgba(20,24,32,.9); color: #fff; font-size: 12px;
        padding: 2px 8px; border-radius: 6px; pointer-events: none;
      }
      .bar {
        position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center;
        background: rgba(20,24,32,.92); color: #dfe5ee;
        padding: 8px 12px; border-radius: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.35);
      }
      .bar b { font-size: 12.5px; margin-right: 2px; }
      .r {
        padding: 3px 10px; font-size: 12px; cursor: pointer; border-radius: 999px;
        border: 1px solid rgba(255,255,255,.25); background: transparent; color: #dfe5ee;
      }
      .r.active { background: #4f8cff; border-color: #4f8cff; color: #fff; }
      .sep { width: 1px; height: 18px; background: rgba(255,255,255,.22); margin: 0 2px; }
      .op {
        padding: 4px 14px; font-size: 12.5px; cursor: pointer; border-radius: 8px;
        border: 1px solid rgba(255,255,255,.25); background: transparent; color: #dfe5ee;
      }
      .op.ok { background: #2f9e5f; border-color: #2f9e5f; color: #fff; font-weight: 600; }
      .op.ok:disabled { opacity: .45; cursor: not-allowed; }
      .hint { font-size: 11.5px; color: #9aa7b8; width: 100%; text-align: center; }
    </style>
    <div class="stage"></div>
    <div class="box">
      <span class="size"></span>
      <div class="hn" data-h="n"></div><div class="hn" data-h="s"></div>
      <div class="hn" data-h="e"></div><div class="hn" data-h="w"></div>
      <div class="hn" data-h="nw"></div><div class="hn" data-h="ne"></div>
      <div class="hn" data-h="sw"></div><div class="hn" data-h="se"></div>
    </div>
    <div class="bar">
      <b>录制区域</b>
      <button class="r active" data-r="0">自由</button>
      <button class="r" data-r="1.7777778">16:9</button>
      <button class="r" data-r="1.3333333">4:3</button>
      <button class="r" data-r="1">1:1</button>
      <span class="sep"></span>
      <button class="op ok" disabled>确认</button>
      <button class="op cancel">取消</button>
      <span class="hint">拖拽框选 · 拖边/角微调 · 框内移动 · 双击或回车确认 · Esc 取消</span>
    </div>
  `;

  const stage = root.querySelector(".stage");
  const box = root.querySelector(".box");
  const size = root.querySelector(".size");
  const okBtn = root.querySelector(".op.ok");
  const bar = root.querySelector(".bar");

  let ratio = 0; // 0 = 自由，否则为 宽/高
  let drag = null; // {mode:"draw"|"move"|句柄名, x0, y0, rect0?}
  let rect = null; // {x, y, w, h}
  let done = false;

  function clampRect(r) {
    const W = innerWidth, H = innerHeight;
    const w = Math.min(Math.max(0, r.w), W), h = Math.min(Math.max(0, r.h), H);
    return {
      x: Math.min(Math.max(0, r.x), W - w),
      y: Math.min(Math.max(0, r.y), H - h),
      w, h,
    };
  }

  // 微调拖拽纯函数（v2.8.17，node 单测覆盖）：按句柄模式把位移增量作用到起始
  // 快照上。四边只动自己的轴；四角双向；比例锁定时——四角对角锚定等比（宽由
  // 水平位移驱动、高=宽/比例，锚在对面角），四边另一维跟随（e/w 锚 y、n/s 锚
  // x）。下限 40×30 与视口越界全程钳制（下限优先于比例：极小时比例暂时让位）。
  function applyDrag(mode, start, dx, dy, ratio, W, H) {
    if (mode === "move") {
      const r = { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
      const w = Math.min(Math.max(0, r.w), W), h = Math.min(Math.max(0, r.h), H);
      return {
        x: Math.min(Math.max(0, r.x), W - w),
        y: Math.min(Math.max(0, r.y), H - h),
        w, h,
      };
    }
    let x = start.x, y = start.y, w = start.w, h = start.h;
    const hasE = mode.includes("e"), hasW = mode.includes("w");
    const hasN = mode.includes("n"), hasS = mode.includes("s");
    const corner = (hasE || hasW) && (hasN || hasS);
    if (corner && ratio) {
      if (hasE) w = Math.max(MIN_W, start.w + dx);
      else w = Math.max(MIN_W, start.w - dx);
      h = w / ratio;
      if (h < MIN_H) { h = MIN_H; w = h * ratio; }
      if (hasW) x = start.x + start.w - w;
      if (hasN) y = start.y + start.h - h;
    } else {
      if (hasE) w = Math.max(MIN_W, start.w + dx);
      else if (hasW) { w = Math.max(MIN_W, start.w - dx); x = start.x + start.w - w; }
      if (hasS) h = Math.max(MIN_H, start.h + dy);
      else if (hasN) { h = Math.max(MIN_H, start.h - dy); y = start.y + start.h - h; }
      if (ratio) {
        if (hasE || hasW) { h = w / ratio; if (h < MIN_H) h = MIN_H; }
        else { w = h * ratio; if (w < MIN_W) w = MIN_W; }
      }
    }
    const cw = Math.min(Math.max(0, w), W), ch = Math.min(Math.max(0, h), H);
    return {
      x: Math.min(Math.max(0, x), W - cw),
      y: Math.min(Math.max(0, y), H - ch),
      w: cw, h: ch,
    };
  }

  function render() {
    if (!rect) return;
    box.style.display = "block";
    box.style.left = rect.x + "px";
    box.style.top = rect.y + "px";
    box.style.width = rect.w + "px";
    box.style.height = rect.h + "px";
    size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)} px`;
    size.style.left = rect.w < 90 ? "0" : "6px";
    size.style.top = rect.y < 30 ? rect.h + 4 + "px" : "-26px";
    okBtn.disabled = !(rect.w >= MIN_W && rect.h >= MIN_H);
  }

  function setRectFrom(dragTo) {
    let w = dragTo.x - drag.x0, h = dragTo.y - drag.y0;
    if (ratio) {
      if (Math.abs(w) >= Math.abs(h) * ratio) h = Math.sign(h || 1) * Math.abs(w) / ratio;
      else w = Math.sign(w || 1) * Math.abs(h) * ratio;
    }
    let x = w >= 0 ? drag.x0 : drag.x0 + w;
    let y = h >= 0 ? drag.y0 : drag.y0 + h;
    rect = clampRect({ x, y, w: Math.abs(w), h: Math.abs(h) });
    render();
  }

  stage.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted) return; // 合成事件不可作为选区确认依据
    if (e.target !== stage || e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    drag = { mode: "draw", x0: e.clientX, y0: e.clientY };
    rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    render();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.mode === "draw") {
      setRectFrom({ x: e.clientX, y: e.clientY });
    } else {
      rect = applyDrag(drag.mode, drag.rect0, e.clientX - drag.x0, e.clientY - drag.y0, ratio, innerWidth, innerHeight);
      render();
    }
  });
  stage.addEventListener("pointerup", () => { drag = null; });

  box.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || e.button !== 0 || !rect) return;
    // 句柄=边/角微调；框内（非句柄）=整体移动（v2.8.17）；双击=确认；
    // 重拉新框仍在框外空白处按下
    const hn = e.target.closest && e.target.closest("[data-h]");
    stage.setPointerCapture(e.pointerId);
    drag = { mode: hn ? hn.dataset.h : "move", x0: e.clientX, y0: e.clientY, rect0: { ...rect } };
  });
  box.addEventListener("pointerup", () => { drag = null; });
  box.addEventListener("dblclick", () => confirm());

  root.querySelectorAll(".r").forEach((b) => {
    b.addEventListener("click", () => {
      ratio = Number(b.dataset.r) || 0;
      root.querySelectorAll(".r").forEach((x) => x.classList.toggle("active", x === b));
      if (rect && rect.w) {
        if (ratio) rect = clampRect({ ...rect, h: rect.w / ratio });
        render();
      }
    });
  });

  function teardown() {
    if (done) return;
    done = true;
    host.remove();
    delete window.__tabRecCropSelector;
  }

  function confirm() {
    if (done || !rect || rect.w < MIN_W || rect.h < MIN_H) return;
    rect = clampRect({
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    });
    try {
      chrome.runtime.sendMessage({
        type: "crop-region-selected",
        rect,
        viewportW: innerWidth,
        viewportH: innerHeight,
        dpr: window.devicePixelRatio, // 换屏检测（v2.8.15）：dpr 变=显示器变，开录前置校验与 drift 判定用
      });
    } catch (e) { /* 扩展上下文失效时静默 */ }
    teardown();
  }

  okBtn.addEventListener("click", confirm);
  root.querySelector(".op.cancel").addEventListener("click", teardown);
  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.key === "Escape") teardown();
    else if (e.key === "Enter" && rect && rect.w >= MIN_W && rect.h >= MIN_H) confirm();
  }, true);

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "crop-selector-cancel") teardown();
  });

  document.documentElement.appendChild(host);
})();

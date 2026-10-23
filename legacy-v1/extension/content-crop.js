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
    <div class="box"><span class="size"></span></div>
    <div class="bar">
      <b>录制区域</b>
      <button class="r active" data-r="0">自由</button>
      <button class="r" data-r="1.7777778">16:9</button>
      <button class="r" data-r="1.3333333">4:3</button>
      <button class="r" data-r="1">1:1</button>
      <span class="sep"></span>
      <button class="op ok" disabled>确认</button>
      <button class="op cancel">取消</button>
      <span class="hint">拖拽框选区域 · 双击框内或回车确认 · Esc 取消</span>
    </div>
  `;

  const stage = root.querySelector(".stage");
  const box = root.querySelector(".box");
  const size = root.querySelector(".size");
  const okBtn = root.querySelector(".op.ok");
  const bar = root.querySelector(".bar");

  let ratio = 0; // 0 = 自由，否则为 宽/高
  let drag = null; // {x0, y0}
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
    if (e.target !== stage || e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, y0: e.clientY };
    rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    render();
  });
  stage.addEventListener("pointermove", (e) => {
    if (drag) setRectFrom({ x: e.clientX, y: e.clientY });
  });
  stage.addEventListener("pointerup", () => { drag = null; });

  box.addEventListener("pointerdown", (e) => {
    // 框上按下=重新框选（从当前位置起拖可微调），双击=确认
    if (e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, y0: e.clientY };
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
      });
    } catch (e) { /* 扩展上下文失效时静默 */ }
    teardown();
  }

  okBtn.addEventListener("click", confirm);
  root.querySelector(".op.cancel").addEventListener("click", teardown);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") teardown();
    else if (e.key === "Enter" && rect && rect.w >= MIN_W && rect.h >= MIN_H) confirm();
  }, true);

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "crop-selector-cancel") teardown();
  });

  document.documentElement.appendChild(host);
})();

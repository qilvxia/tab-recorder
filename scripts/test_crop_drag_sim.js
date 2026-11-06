// test_crop_drag_sim.js — 框选浮层拖拽状态机事件流模拟（v2.8.18 基准复现/回归）
// 用法：node scripts/test_crop_drag_sim.js
// 从 extension/content-crop.js 加载真实脚本（DOM stub + 强制可观测），驱动
// pointer 事件序列，断言：
//   A. 正常拖拽/微调路径尺寸正确（回归保护）
//   B. pointercancel/blur 后 buttons=0 的纯移动不得再改尺寸（卡死自愈）
//   C. 正常拖拽期 buttons=1 的移动照常工作（守卫不误伤）
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "content-crop.js"), "utf8");

function makeEl() {
  const el = {
    style: {}, dataset: {}, handlers: {},
    addEventListener(t, f) { (el.handlers[t] = el.handlers[t] || []).push(f); },
    setPointerCapture() {}, appendChild() {}, remove() {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector: () => null, querySelectorAll: () => [],
    attachShadow: () => root, textContent: "", innerHTML: "", disabled: false,
  };
  return el;
}
const stage = makeEl(), box = makeEl(), size = makeEl(), okBtn = makeEl(), cancelBtn = makeEl(), bar = makeEl();
const root = Object.assign(makeEl(), {
  querySelector: (s) => ({ ".stage": stage, ".box": box, ".size": size, ".op.ok": okBtn, ".op.cancel": cancelBtn, ".bar": bar }[s] || null),
});
const handle = { dataset: { h: "se" } }; handle.closest = () => handle;
const documentStub = Object.assign(makeEl(), {
  createElement: () => { const el = makeEl(); el.attachShadow = () => root; return el; },
  documentElement: makeEl(),
});
const chromeStub = { runtime: { sendMessage() {}, onMessage: { addListener() {} } } };
const windowStub = makeEl(); // addEventListener 可记录（blur 用例）
global.window = windowStub;
global.requestAnimationFrame = (f) => f(); // 同步执行（render rAF 合并不影响断言语义）
new Function("window", "document", "chrome", "innerWidth", "innerHeight", "requestAnimationFrame", src)(
  windowStub, documentStub, chromeStub, 1280, 800, global.requestAnimationFrame);

const fire = (el, type, ev) => (el.handlers[type] || []).forEach((f) => f(ev));
const E = (o) => Object.assign({ isTrusted: true, button: 0, buttons: 1, pointerId: 1, target: stage, clientX: 0, clientY: 0 }, o);
const dims = () => ({ w: box.style.width, h: box.style.height, x: box.style.left, y: box.style.top });

let fail = 0;
const t = (name, cond, extra) => {
  if (cond) console.log("PASS:", name);
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

// A. 正常路径
fire(stage, "pointerdown", E({ clientX: 300, clientY: 300 }));
fire(stage, "pointermove", E({ clientX: 700, clientY: 500 }));
fire(stage, "pointerup", E({}));
t("A1 拖拽 400×200", box.style.width === "400px" && box.style.height === "200px", dims());
fire(box, "pointerdown", E({ clientX: 700, clientY: 500, target: handle }));
fire(stage, "pointermove", E({ clientX: 730, clientY: 520 }));
fire(stage, "pointerup", E({}));
t("A2 se 微调 430×220", box.style.width === "430px" && box.style.height === "220px", dims());

// B. 卡死自愈：pointercancel / blur 后 buttons=0 纯移动不得改尺寸
for (const cancelEvt of ["pointercancel", "lostpointercapture"]) {
  fire(box, "pointerdown", E({ clientX: 730, clientY: 520, target: handle }));
  fire(stage, cancelEvt, E({}));
  const before = dims();
  for (const [x, y] of [[760, 550], [800, 600], [850, 650]]) {
    fire(stage, "pointermove", E({ clientX: x, clientY: y, buttons: 0, button: -1 }));
  }
  const after = dims();
  t("B " + cancelEvt + " 后纯移动零变化", JSON.stringify(before) === JSON.stringify(after), { before, after });
}
fire(box, "pointerdown", E({ clientX: 730, clientY: 520, target: handle }));
fire(windowStub, "blur", E({}));
let before = dims();
for (const [x, y] of [[770, 570], [820, 620]]) {
  fire(stage, "pointermove", E({ clientX: x, clientY: y, buttons: 0, button: -1 }));
}
t("B blur 后纯移动零变化", JSON.stringify(before) === JSON.stringify(dims()), { before, after: dims() });

// C. 守卫不误伤：buttons=1 的拖拽照常
fire(box, "pointerdown", E({ clientX: 730, clientY: 520, target: handle }));
fire(stage, "pointermove", E({ clientX: 760, clientY: 560 }));
fire(stage, "pointerup", E({}));
t("C 按住拖拽照常（460×260）", box.style.width === "460px" && box.style.height === "260px", dims());

// D. buttons=0 首次移动即清 drag（自愈后不残留）
const d0 = dims();
fire(stage, "pointermove", E({ clientX: 900, clientY: 700, buttons: 0, button: -1 }));
t("D 无拖拽时纯移动零副作用", JSON.stringify(d0) === JSON.stringify(dims()));

console.log(fail ? "RESULT: FAIL (" + fail + ")" : "RESULT: PASS");
process.exit(fail ? 1 : 0);

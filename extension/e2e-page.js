// e2e-page.js — 端到端诊断测试页：有声视频（canvas 视频轨 + oscillator 音轨）
// 播放 30 秒 → pause + 派发 ended → 弹评分窗 → 点击「放弃评价观看下一节」后
// 弹窗关闭、视频重播（模拟下一节自动连播），hash 递增供观测。
// 节长 30s（原 8s）：验证停播判定不会在长播节内误切——playing 心跳缺失时
// 节内第 5s 必误切（v2.3.1 N 段根因的回归探针）。

var lessonNum = 1;
var BLIND = location.hash === "#blind"; // 盲区站模拟（见下方 BLIND 分支注释）
var canvas = document.createElement("canvas");
canvas.width = 640; canvas.height = 360;
var ctx2d = canvas.getContext("2d");
// 随机噪声画面：高熵内容使 tabCapture 编码数据量大（验证切段的内容前提）
var noiseTimer = setInterval(function () {
  var img = ctx2d.createImageData(canvas.width, canvas.height);
  var d = img.data;
  for (var i = 0; i < d.length; i += 4) {
    d[i] = Math.random() * 256; d[i + 1] = Math.random() * 256; d[i + 2] = Math.random() * 256; d[i + 3] = 255;
  }
  ctx2d.putImageData(img, 0, 0);
  ctx2d.fillStyle = "#fff";
  ctx2d.font = "30px sans-serif";
  ctx2d.fillText("lesson " + lessonNum, 20, 40);
}, 66);

var ac = new AudioContext();
var osc = ac.createOscillator();
osc.frequency.value = 440;
var dest = ac.createMediaStreamDestination();
osc.connect(dest);
osc.start();

var videoTrack = canvas.captureStream(15).getVideoTracks()[0];
var audioTrack = dest.stream.getAudioTracks()[0];
var v = document.getElementById("v");
v.srcObject = new MediaStream([videoTrack, audioTrack]);
v.muted = false;
if (BLIND) {
  // 盲区站模拟（保利威形态）：视频保持暂停——playing/ended 对检测器从不可见；
  // 噪声 canvas 直接贴到页面（tab 画面持续活动=码率正常，真实盲区站画面在播、
  // 只是信号不可见）；15s 后弹「播完弹窗」（等段内容攒够 2MB 切节前提），
  // 点击后关闭弹窗但**不续播**——验证 offscreen 盲区豁免闭环：entry-visible
  // 切节（endedReportedEver=false 豁免）→ 点击进 between 续录（playingSeen=false
  // 不拦）→ 弹窗不再出现、无 URL 变化 → everBetween+wrapSec 收工
  v.pause();
  canvas.style.cssText = "position:fixed;left:0;bottom:0;width:200px;z-index:0;";
  document.body.appendChild(canvas);
  setTimeout(function () { document.getElementById("modal").style.display = "block"; }, 15000);
} else {
  v.play().catch(function (e) { window.__playErr = String(e); });
}

function endLesson() {
  try { v.pause(); } catch (e) {}
  v.dispatchEvent(new Event("ended"));
  setTimeout(function () {
    if (lessonNum >= 3) return; // 两节循环后停止
    document.getElementById("modal").style.display = "block";
  }, 800);
}
if (!BLIND) {
  v.addEventListener("ended", endLesson);
  setTimeout(endLesson, 30000); // 无 srcObject ended 的兜底：30 秒强制进入播完流程
}

document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("#nextBtn");
  if (!t) return;
  window.__clicked = (window.__clicked || 0) + 1;
  if (BLIND) {
    // 盲区模式：点击只关弹窗（模拟弹窗点掉但站点无自动连播——连播已挂场景）
    document.getElementById("modal").style.display = "none";
    return;
  }
  lessonNum += 1;
  location.hash = "#lesson-" + lessonNum;
  document.getElementById("lessonTitle").textContent = "第" + lessonNum + "节 诊断课程";
  document.getElementById("modal").style.display = "none";
  v.play().catch(function (e2) {});
  setTimeout(endLesson, 30000);
});
window.__lessonNum = function () { return lessonNum; };

// 节内模拟周期 URL 变化（分片/token/进度参数，15s 一次保证每节内至少一次）：
// 修复前必触发 url-change 周期切段（一节 N 段的根因），修复后应被
// 「课时名未变否决」拦住——本探针验证节内零切段。
setInterval(function () { location.hash = "#t=" + Math.floor(Date.now() / 1000); }, 15000);

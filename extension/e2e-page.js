// e2e-page.js — 端到端诊断测试页：有声视频（canvas 视频轨 + oscillator 音轨）
// 播放 30 秒 → pause + 派发 ended → 弹评分窗 → 点击「放弃评价观看下一节」后
// 弹窗关闭、视频重播（模拟下一节自动连播），hash 递增供观测。
// 节长 30s（原 8s）：验证停播判定不会在长播节内误切——playing 心跳缺失时
// 节内第 5s 必误切（v2.3.1 N 段根因的回归探针）。

var lessonNum = 1;
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
v.play().catch(function (e) { window.__playErr = String(e); });

function endLesson() {
  try { v.pause(); } catch (e) {}
  v.dispatchEvent(new Event("ended"));
  setTimeout(function () {
    if (lessonNum >= 3) return; // 两节循环后停止
    document.getElementById("modal").style.display = "block";
  }, 800);
}
v.addEventListener("ended", endLesson);
setTimeout(endLesson, 30000); // 无 srcObject ended 的兜底：30 秒强制进入播完流程

document.addEventListener("click", function (e) {
  var t = e.target.closest && e.target.closest("#nextBtn");
  if (!t) return;
  lessonNum += 1;
  window.__clicked = (window.__clicked || 0) + 1;
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

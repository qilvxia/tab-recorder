// advance-test-page.js — 诊断测试页逻辑（外部文件：扩展页面 CSP 禁止内联脚本）
document.addEventListener('click', function (e) {
  var t = e.target.closest && e.target.closest('#nextBtn');
  if (t) { window.__clicked = (window.__clicked || 0) + 1; location.hash = '#next-lesson'; }
});
var v = document.getElementById('v');
v.addEventListener('ended', function () {
  setTimeout(function () { document.getElementById('modal').style.display = 'block'; }, 300);
});

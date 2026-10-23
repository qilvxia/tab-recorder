@echo off
chcp 65001 >nul
title 录制专用 Chrome

rem ============================================================
rem  录制专用 Chrome 启动器
rem  - 关闭窗口遮挡检测：录制时窗口可以被任意遮挡/盖住，画面不冻结
rem  - 独立配置目录（luffy-rec-chrome）：不影响日常浏览器
rem
rem  ★ 首次使用（只做一次）：
rem    1. 启动后打开 chrome://extensions
rem    2. 右上角开启"开发者模式"
rem    3. "加载已解压的扩展程序" → 选择 E:\ZCodeProjects\tab-recorder\extension
rem    4. 登录一次路飞学城
rem    （Chrome 稳定版已禁止命令行自动加载扩展，手动加载后配置会一直保留）
rem
rem  注意：仍请避免点"最小化"，用其他窗口盖住它即可
rem ============================================================

set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe

start "" "%CHROME%" ^
  --disable-features=CalculateNativeWinOcclusion ^
  --disable-backgrounding-occluded-windows ^
  --disable-background-timer-throttling ^
  --user-data-dir="C:\Users\Admin\luffy-rec-chrome" ^
  --no-first-run --no-default-browser-check ^
  "chrome://extensions/"

echo 录制专用 Chrome 已启动。
echo 若首次使用：请按扩展页提示加载 tab-recorder 扩展并登录课程网站。
timeout /t 5 >nul

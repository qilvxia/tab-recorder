# Kill leftover test Chrome/Edge instances (matched by cmdline signature, never the daily browser).
Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
  Where-Object { $_.CommandLine -match 'luffy_tmp|ext-test|remote-debugging-port=92' } |
  ForEach-Object {
    Write-Host ("kill " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Write-Host "done"

# restart_bridge.ps1 — Para, limpa e reinicia o ProfitBridge de forma limpa
Write-Host "=== Parando servico ===" -ForegroundColor Yellow
Stop-Service ProfitBridgeSvc -Force -ErrorAction SilentlyContinue
Start-Sleep 2

Write-Host "=== Matando processos Python ===" -ForegroundColor Yellow
taskkill /F /IM python3.exe /T 2>$null
taskkill /F /IM python.exe /T 2>$null
Start-Sleep 2

Write-Host "=== Removendo lock ===" -ForegroundColor Yellow
Remove-Item C:\ProfitBridge\bridge.lock -ErrorAction SilentlyContinue

Write-Host "=== Verificando .env ===" -ForegroundColor Yellow
Get-Content C:\ProfitBridge\.env

Write-Host "=== Subindo servico ===" -ForegroundColor Green
Start-Service ProfitBridgeSvc
Start-Sleep 6

Write-Host "=== Status ===" -ForegroundColor Green
Get-Service ProfitBridgeSvc

Write-Host "=== Log (ultimas linhas) ===" -ForegroundColor Green
Get-Content C:\ProfitBridge\logs\bridge.log -Tail 20

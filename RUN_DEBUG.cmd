@echo off
setlocal
cd /d "%~dp0"
title DomainManager V10.3.1 DEBUG
echo Thu muc hien tai:
cd
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "& { try { [void][scriptblock]::Create((Get-Content -Raw -LiteralPath '.\Start.ps1')); Write-Host 'KIEM TRA CU PHAP: OK' -ForegroundColor Green } catch { Write-Host 'KIEM TRA CU PHAP: LOI' -ForegroundColor Red; Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 } }"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
echo Dang chay Start.ps1...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\Start.ps1"
echo.
echo Start.ps1 da ket thuc.
pause

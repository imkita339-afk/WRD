@echo off
chcp 65001 >nul
rem Запуск Steam-бота WHO RUINED? — окно должно оставаться открытым
cd /d "%~dp0"
if not exist node_modules (
  echo Устанавливаю зависимости...
  call npm.cmd install --no-audit --no-fund
)
node src\main.js %*
pause

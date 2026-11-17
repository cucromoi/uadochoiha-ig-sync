@echo off
rem Chay dong bo Instagram -> site, co log ra data\sync.log de doi chay lich xem lai
cd /d "%~dp0"
echo ===== %date% %time% ===== >> data\sync.log
node sync.js >> data\sync.log 2>&1

@echo off
rem Chay dong bo Instagram -> site, co log ra data\sync.log de doi chay lich xem lai
cd /d "%~dp0"
echo ===== %date% %time% ===== >> data\sync.log
node sync.js >> data\sync.log 2>&1

rem make-pages.js (sync.js goi tu dong) chi ghi file local -> can commit push de Google Pages doc duoc
git -C D:\uadochoiha add -A p "sitemap*.xml" >> data\sync.log 2>&1
git -C D:\uadochoiha commit -q -m "chi muc tu dong %date% %time%" >> data\sync.log 2>&1 && (git -C D:\uadochoiha pull --rebase --autostash -q origin main >> data\sync.log 2>&1 & git -C D:\uadochoiha push -q origin HEAD >> data\sync.log 2>&1 || echo LOI PUSH chi muc >> data\sync.log)

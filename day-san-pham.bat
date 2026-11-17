@echo off
chcp 65001 >nul
title Day san pham Instagram - uadochoiha
cd /d "D:\autosync"

echo ==========================================================
echo   ĐẨY SẢN PHẨM MỚI: Instagram @uadochoiha  --^>  web
echo   Quét 20 bài gần nhất, bài chưa có trên web thì đẩy thật.
echo ==========================================================
echo.

if not exist "sync.js" (
  echo LỖI: không thấy D:\autosync\sync.js — thư mục dự án đã bị đổi chỗ?
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo LỖI: máy chưa có Node.js. Cài ở https://nodejs.org rồi chạy lại.
  echo.
  pause
  exit /b 1
)

node sync.js %*
set "RC=%errorlevel%"

echo.
echo ==========================================================
if "%RC%"=="0" (
  echo   XONG. Bài mới nếu có đã lên web ngay, không cần commit/push.
  echo   Mở: https://cucromoi.github.io/uadochoiha/
) else (
  echo   CHẠY LỖI — mã %RC%. Đọc dòng "LỖI:" phía trên.
  echo   - "0 bài" = Instagram đang chặn phiên cào, KHÔNG phải hết bài mới.
  echo     Cách sửa: chạy  node sync.js --login  rồi đăng nhập lại.
  echo   - "Sai mật khẩu admin" = file .uad-password bị đổi hoặc thiếu.
)
echo ==========================================================
echo.
echo Bấm phím bất kỳ để đóng cửa sổ.
pause >nul

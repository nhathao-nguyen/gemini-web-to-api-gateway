@echo off
title Gemini Gateway Desktop
echo ====================================================
echo   Khoi dong Gemini Gateway Desktop
echo   Database: SQLite trong thu muc userData cua app
echo ====================================================
cd /d "%~dp0"
call npm run build
if errorlevel 1 (
  echo BUILD THAT BAI. Kiem tra loi o tren.
  pause
  exit /b 1
)
call npm run dev:electron
pause

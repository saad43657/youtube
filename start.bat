@echo off
title YTDrop — YouTube Downloader
echo.
echo  ╔══════════════════════════════╗
echo  ║       YTDrop Launcher        ║
echo  ║      by SAAD KHAN            ║
echo  ╚══════════════════════════════╝
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo  [!] First run — installing dependencies...
    npm install
    echo.
)

:: Check if yt-dlp.exe exists
if not exist "yt-dlp.exe" (
    echo  [!] yt-dlp.exe not found!
    echo  [!] Download from: https://github.com/yt-dlp/yt-dlp/releases/latest
    echo  [!] Place yt-dlp.exe in this folder, then run again.
    echo.
    pause
    exit /b
)

echo  [+] Starting YTDrop...
echo  [+] Open browser: http://localhost:3000
echo.
start "" http://localhost:3000
node server.js
pause

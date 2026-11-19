@echo off
chcp 65001 >nul
title NOVA telepites
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Telepites.ps1"
echo.
pause

@echo off
title Forex Master Pro v7 — Desktop
echo.
echo  ============================================
echo   Forex Master Pro v7 — Versao Desktop
echo  ============================================
echo.

cd /d "%~dp0"

echo  [1/2] A instalar dependencias (primeira vez)...
call npm install --silent 2>nul

echo  [2/2] A construir e abrir app desktop...
echo.
call npm run electron:pack
start "" "dist-electron\win-unpacked\Forex Master Pro.exe"

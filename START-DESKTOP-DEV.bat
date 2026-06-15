@echo off
title Forex Master Pro v7 — Desktop Dev
echo.
echo  Abrindo Forex Master Pro em modo desktop (dev)...
echo  Nota: O servidor React precisa estar a correr (npm run all)
echo.
cd /d "%~dp0"
npx electron .

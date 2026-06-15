@echo off
echo.
echo  ============================================
echo   Forex Master Pro v7 — A iniciar...
echo  ============================================
echo.
if not exist .env (
  echo  [ERRO] Ficheiro .env nao encontrado!
  echo  Copia .env.example para .env e coloca a tua API key.
  pause & exit /b 1
)
echo  [1/3] Dependencias do servidor...
call npm install --silent
echo  [2/3] Dependencias do cliente React...
cd client & call npm install --silent & cd ..
echo  [3/3] A arrancar...
echo.
echo  Servidor:  http://localhost:3001
echo  Interface: http://localhost:3000
echo.
call npm run all

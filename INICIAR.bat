@echo off
setlocal
cd /d "%~dp0"
docker info >nul 2>&1
if errorlevel 1 (
  echo Abra o Docker Desktop e aguarde o mecanismo ficar pronto ^(Engine running^).
  pause
  exit /b 1
)
echo Iniciando o Alagora. Na primeira vez o Docker baixa as imagens e instala as dependencias:
echo isso leva alguns minutos, conforme a internet. Nas proximas vezes sobe em segundos.
echo.
docker compose up --build -d --wait
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar. Se a mensagem citar a porta 8080, outro programa a esta usando:
  echo crie um arquivo .env com a linha APP_PORT=8081 ^(veja .env.example^) e execute de novo.
  echo Para ver detalhes: docker compose logs
  pause
  exit /b 1
)
set PORTA=8080
if exist .env for /f "tokens=1,2 delims==" %%a in (.env) do if /i "%%a"=="APP_PORT" set PORTA=%%b
echo.
echo Alagora disponivel em http://localhost:%PORTA%
echo Contas de teste: demo@alagora.local / Demo@12345  e  admin@alagora.local / Admin@12345
echo No celular ^(mesma rede Wi-Fi^): http://IP-DO-COMPUTADOR:%PORTA%
start "" "http://localhost:%PORTA%"
pause

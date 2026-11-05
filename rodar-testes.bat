@echo off
setlocal
cd /d "%~dp0"
echo Rodando os testes automaticos e subindo o Alagora. Detalhes em testes-log.txt.
echo INICIO %date% %time% > testes-log.txt
docker info >nul 2>&1
if errorlevel 1 (
  echo Abra o Docker Desktop e aguarde ficar pronto.
  pause
  exit /b 1
)
echo ===== TESTES DA API %time% >> testes-log.txt
docker run --rm -v "%cd%\server:/src:ro" node:24-alpine sh -c "cp -r /src /app && cd /app && rm -rf node_modules && npm ci --no-audit --no-fund && npm test" >> testes-log.txt 2>&1
if errorlevel 1 (echo TESTES: FALHARAM - veja testes-log.txt) else (echo TESTES: todos passaram)
echo ===== SUBIDA %time% >> testes-log.txt
docker compose --progress plain up --build -d --wait >> testes-log.txt 2>&1
if errorlevel 1 (echo SUBIDA: falhou - veja testes-log.txt. Se a porta 8080 estiver em uso, defina APP_PORT no arquivo .env) else (echo SUBIDA: ok - http://localhost:8080)
docker compose ps >> testes-log.txt 2>&1
echo FIM %date% %time% >> testes-log.txt
pause

@echo off
setlocal
cd /d "%~dp0"
docker info >nul 2>&1
if errorlevel 1 (
  echo Abra o Docker Desktop e aguarde ficar pronto.
  pause
  exit /b 1
)
echo Subindo o sistema e medindo as falhas. Leva cerca de 4 minutos.
echo Durante a medicao a ferramenta para e religa uma replica da API, o coletor e o banco.
echo INICIO %date% %time% > medir-log.txt
rem A medicao acessa o app por dentro da rede do Docker; usa outra porta no Windows para nao
rem conflitar com outro programa que esteja usando a 8080.
set APP_PORT=8091
docker compose up --build -d --wait >> medir-log.txt 2>&1
if errorlevel 1 (
  echo Nao foi possivel subir o sistema. Veja medir-log.txt
  pause
  exit /b 1
)
docker run --rm --network alagora_default -v /var/run/docker.sock:/var/run/docker.sock -v "%cd%\ferramentas:/f:ro" -v "%cd%\docs:/saida/docs" node:24-alpine node /f/medir-falhas.mjs >> medir-log.txt 2>&1
if errorlevel 1 (echo A medicao falhou - veja medir-log.txt) else (echo Pronto. Resultados em docs\RESULTADOS-FALHAS.md)
echo Durante a medicao o app ficou na porta 8091. Para voltar a 8080, rode INICIAR.bat.
echo FIM %date% %time% >> medir-log.txt
pause

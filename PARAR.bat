@echo off
setlocal
cd /d "%~dp0"
docker compose down
echo Os dados foram mantidos no volume do banco.
pause

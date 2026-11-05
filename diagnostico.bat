@echo off
cd /d "%~dp0"
echo ===== PS > diag-log.txt
docker compose ps -a >> diag-log.txt 2>&1
echo ===== APP >> diag-log.txt
docker compose logs --tail 60 app >> diag-log.txt 2>&1
echo ===== NGINX -T >> diag-log.txt
docker compose run --rm --no-deps --entrypoint nginx app -t >> diag-log.txt 2>&1
echo FIM >> diag-log.txt

@echo off
chcp 65001 >nul
title RF Issue DB (Docker 시험) - http://localhost:7332
cd /d "%~dp0"

rem PC 의 Docker Desktop 에서 NAS 와 같은 컨테이너를 띄워 시험한다.
rem   docker-dev.bat          빌드하고 실행 (창을 닫거나 Ctrl+C 로 종료)
rem   docker-dev.bat down     컨테이너 지우기
rem   docker-dev.bat logs     기록 보기

where docker >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [오류] Docker Desktop 이 없습니다. https://www.docker.com/products/docker-desktop/
  echo.
  pause
  exit /b 1
)

if not exist "docker.env" (
  echo   [오류] docker.env 가 없습니다. docker.env.example 을 복사해 채워 주세요.
  pause
  exit /b 1
)
if not exist "config.docker.json" (
  echo   [오류] config.docker.json 이 없습니다. config.docker.example.json 을 복사해 채워 주세요.
  pause
  exit /b 1
)

rem 처음이면 PC 의 data 를 시험용으로 복사 (원본 data 는 건드리지 않는다)
if not exist ".docker-data" (
  echo   시험용 데이터 폴더를 만듭니다 ^(.docker-data ^<- data 복사^)
  xcopy /e /i /q "data" ".docker-data" >nul
)

set COMPOSE=docker compose --env-file docker.env -f compose.dev.yaml

if /i "%1"=="down" ( %COMPOSE% down -v & goto :eof )
if /i "%1"=="logs" ( %COMPOSE% logs -f & goto :eof )

echo.
echo   빌드 후 실행합니다. 브라우저에서 http://localhost:7332
echo.
%COMPOSE% up --build
pause

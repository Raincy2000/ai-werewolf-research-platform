@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ================================================
echo   AI模拟狼人杀研究平台 - 桌面客户端 一键安装
echo ================================================
echo.

REM ===== 1. 检测或准备 Node.js =====
where node >nul 2>nul
if %errorlevel%==0 (
  echo [OK] 检测到系统 Node.js：
  node --version
  echo.
  goto build
)

echo [提示] 未检测到 Node.js，将自动下载便携版 Node.js（免安装，仅首次约 28MB）...
echo.

set "NODE_VER=v20.18.0"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
set "NODE_DIR=%~dp0.portable-node"
set "NODE_ZIP=%TEMP%\node-%NODE_VER%-win-x64.zip"

if not exist "%NODE_DIR%\node.exe" (
  echo 正在下载 Node.js %NODE_VER% ...
  curl -L -o "%NODE_ZIP%" "%NODE_URL%"
  if errorlevel 1 (
    echo.
    echo [错误] 下载失败，请检查网络后重试；也可手动到 https://nodejs.org 安装 LTS 版。
    pause
    exit /b 1
  )
  echo 正在解压...
  if not exist "%NODE_DIR%" mkdir "%NODE_DIR%"
  tar -xf "%NODE_ZIP%" -C "%NODE_DIR%" --strip-components=1
  if errorlevel 1 (
    echo [错误] 解压失败（需 Windows 10 1803 或更高版本）。
    pause
    exit /b 1
  )
  del "%NODE_ZIP%" 2>nul
)

set "PATH=%NODE_DIR%;%PATH%"
echo [OK] 便携 Node 就绪：
node --version
echo.

:build
REM ===== 2. 安装依赖 =====
echo [1/4] 安装依赖（前端 + 后端）...
call npm install
if errorlevel 1 goto error

echo [2/4] 安装依赖（桌面端 Electron）...
cd desktop
call npm install
if errorlevel 1 goto error
cd ..

REM ===== 3. 构建 =====
echo [3/4] 构建产物（前端 + 后端）...
call npm run build
if errorlevel 1 goto error

REM ===== 4. 打包 =====
echo [4/4] 打包安装程序（NSIS 安装版 + 便携版）...
call npm run app:dist
if errorlevel 1 goto error

echo.
echo ================================================
echo   打包完成！
echo.
echo   安装版（可自选安装目录）：
echo     desktop\release\WerewolfAI-*-setup.exe
echo   便携版（免安装，双击即用）：
echo     desktop\release\WerewolfAI-*-portable.exe
echo.
echo   即将打开 release 目录...
echo ================================================
start "" "%~dp0desktop\release"
pause
exit /b 0

:error
echo.
echo [错误] 构建失败，请查看上方错误信息。
pause
exit /b 1

@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ================================================
echo   AI模拟狼人杀研究平台 - 桌面客户端 一键安装
echo ================================================
echo.

REM ===== 0. 国内镜像加速 npm =====
set "npm_config_registry=https://registry.npmmirror.com"

REM ===== 1. 准备 Node.js（需 v22+，支持 require ESM）=====
set "NODE_VER=v22.12.0"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"
set "NODE_DIR=%~dp0.portable-node-22"
set "NODE_ZIP=%TEMP%\node-%NODE_VER%-win-x64.zip"

where node >nul 2>nul
if %errorlevel% neq 0 goto need_portable

set "NODE_MAJOR=0"
for /f "tokens=1 delims=v." %%i in ('node -v 2^>nul') do set "NODE_MAJOR=%%i"
if %NODE_MAJOR% GEQ 22 goto node_ok
echo [提示] 系统 node 版本过低（v%NODE_MAJOR%），改用便携 v22...

:need_portable
if not exist "%NODE_DIR%\node.exe" (
  echo 正在下载 Node.js %NODE_VER%（约 33MB，仅首次）...
  curl -L --retry 3 --retry-delay 2 -o "%NODE_ZIP%" "%NODE_URL%"
  if errorlevel 1 (
    echo.
    echo [错误] 下载 Node 失败，请检查网络后重试。
    pause
    exit /b 1
  )
  echo 正在解压...
  if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
  mkdir "%NODE_DIR%"
  tar -xf "%NODE_ZIP%" -C "%NODE_DIR%" --strip-components=1
  if errorlevel 1 (
    echo [错误] 解压失败。
    pause
    exit /b 1
  )
  del "%NODE_ZIP%" 2>nul
)
set "PATH=%NODE_DIR%;%PATH%"

:node_ok
echo [OK] Node 就绪：
node --version
echo.

:build
REM ===== 2. 安装依赖 =====
echo [1/5] 安装依赖（前端 + 后端）...
call npm install
if errorlevel 1 goto error1

echo [2/5] 安装依赖（桌面端 Electron）...
cd desktop
call npm install
if errorlevel 1 goto error2
cd ..

REM ===== 3. 构建 =====
echo [3/5] 构建产物（前端 + 后端）...
call node node_modules\vite\bin\vite.js build
if errorlevel 1 goto error3
call node build-backend.mjs
if errorlevel 1 goto error3

REM ===== 4. 准备 Electron =====
if not exist "desktop\electron-dist\electron.exe" (
  echo [4/5] 正在下载 Electron（约 138MB，仅首次）...
  curl -L --retry 3 --retry-delay 2 -o "%TEMP%\electron.zip" "https://npmmirror.com/mirrors/electron/43.2.0/electron-v43.2.0-win32-x64.zip"
  if errorlevel 1 (
    echo 镜像失败，改用 GitHub 官方源...
    curl -L --retry 3 --retry-delay 2 -o "%TEMP%\electron.zip" "https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-win32-x64.zip"
  )
  if errorlevel 1 (
    echo.
    echo [错误] Electron 下载失败。
    pause
    exit /b 1
  )
  echo 正在解压 Electron...
  if exist "desktop\electron-dist" rmdir /s /q "desktop\electron-dist"
  mkdir "desktop\electron-dist"
  tar -xf "%TEMP%\electron.zip" -C "desktop\electron-dist"
  if errorlevel 1 (
    echo [错误] Electron 解压失败。
    pause
    exit /b 1
  )
  del "%TEMP%\electron.zip" 2>nul
  echo [OK] Electron 就绪。
) else (
  echo [4/5] Electron 已存在，跳过下载。
)
echo.

REM ===== 5. 打包 =====
echo [5/5] 打包安装程序（NSIS 安装版 + 便携版）...
cd desktop
call node pack.mjs
if errorlevel 1 goto error5
cd ..

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

:error1
echo.
echo [错误] 第 1 步失败：安装前端/后端依赖失败。
pause
exit /b 1

:error2
cd ..
echo.
echo [错误] 第 2 步失败：安装桌面端依赖失败。
pause
exit /b 1

:error3
echo.
echo [错误] 第 3 步失败：构建产物失败。
pause
exit /b 1

:error5
cd ..
echo.
echo [错误] 第 5 步失败：打包失败。
pause
exit /b 1

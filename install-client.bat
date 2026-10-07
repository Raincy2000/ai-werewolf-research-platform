@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ================================================
echo   AI模拟狼人杀研究平台 - 桌面客户端 一键安装
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo        请先安装 Node.js 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo [OK] 检测到 Node.js：
node --version
echo.

echo [1/4] 安装依赖（前端 + 后端）...
call npm install
if errorlevel 1 goto error

echo [2/4] 安装依赖（桌面端 Electron）...
cd desktop
call npm install
if errorlevel 1 goto error
cd ..

echo [3/4] 构建产物（前端 + 后端）...
call npm run build
if errorlevel 1 goto error

echo [4/4] 打包安装程序（NSIS 安装版 + 便携版）...
call npm run app:dist
if errorlevel 1 goto error

echo.
echo ================================================
echo   打包完成！
echo.
echo   安装版（可自选安装目录）：
echo     desktop\release\AI狼人杀研究平台-*-setup.exe
echo   便携版（免安装，双击即用）：
echo     desktop\release\AI狼人杀研究平台-*-portable.exe
echo.
echo   即将打开 release 目录，双击 setup.exe 即可安装。
echo ================================================
start "" "%~dp0desktop\release"
pause
exit /b 0

:error
echo.
echo [错误] 安装失败，请查看上方错误信息。
echo        常见原因：网络问题（npm 安装失败）或 Node 版本过低。
echo.
pause
exit /b 1

@echo off
setlocal EnableExtensions
chcp 65001 >nul
title SWPanel

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem ---- 随包 Python（含 pywin32 / pypdfium2 等依赖）优先于系统 Python ----
set "PATH=%ROOT%\python;%ROOT%\python\Scripts;%PATH%"

rem ---- 数据目录与端口（可在运行前设置同名环境变量覆盖）----
if not defined SWPANEL_DATA_ROOT set "SWPANEL_DATA_ROOT=%LOCALAPPDATA%\SWPanel\data"
if not defined PORT set "PORT=3001"
if not defined HOST set "HOST=127.0.0.1"
set "SWPANEL_WEB_ROOT=%ROOT%\app\apps\desktop\dist\renderer"

echo ============================================================
echo  SWPanel
echo  数据目录: %SWPANEL_DATA_ROOT%
echo ============================================================

rem ---- Codex CLI：必须是真正的 codex.exe（不能是 npm 的 .cmd 脚本）----
if not defined SWPANEL_LIVE_CODEX_EXECUTABLE for /f "delims=" %%i in ('where codex.exe 2^>nul') do if not defined SWPANEL_LIVE_CODEX_EXECUTABLE set "SWPANEL_LIVE_CODEX_EXECUTABLE=%%i"
if not defined SWPANEL_LIVE_CODEX_EXECUTABLE if exist "%APPDATA%\npm\node_modules\@openai\codex" for /f "delims=" %%i in ('dir /s /b "%APPDATA%\npm\node_modules\@openai\codex\codex.exe" 2^>nul') do if not defined SWPANEL_LIVE_CODEX_EXECUTABLE set "SWPANEL_LIVE_CODEX_EXECUTABLE=%%i"
if defined SWPANEL_LIVE_CODEX_EXECUTABLE (
  echo [OK] Codex CLI: %SWPANEL_LIVE_CODEX_EXECUTABLE%
) else (
  echo [提示] 未找到 codex.exe：网页可正常使用，但自动建模不可用。
  echo        请先安装 Codex CLI 并运行 codex login，然后重新启动本程序。
)

rem ---- 自动建模技能：Codex 只会发现自己的技能目录，所以首次运行时安装到用户目录 ----
if not defined SWPANEL_LIVE_CODEX_SKILL_PATH call :install_skill
if not defined SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT set "SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT=true"

echo.
echo 服务启动后会自动打开浏览器：http://127.0.0.1:%PORT%/
echo 关闭此窗口即可停止服务。
echo.
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://127.0.0.1:%PORT%/"

"%ROOT%\node\node.exe" "%ROOT%\app\apps\runner\dist\start-server.js"
echo.
echo 服务已退出（退出码 %ERRORLEVEL%）。如有报错请截图反馈。
pause
exit /b %ERRORLEVEL%

:install_skill
set "SKILL_SRC=%ROOT%\app\skills\solidworks-autobuild"
set "SKILL_DST=%USERPROFILE%\.agents\skills\solidworks-autobuild"
set "BUNDLE_ID="
set "INSTALLED_ID="
if exist "%SKILL_SRC%\.swpanel-bundle-id" set /p BUNDLE_ID=<"%SKILL_SRC%\.swpanel-bundle-id"
if exist "%SKILL_DST%\.swpanel-bundle-id" set /p INSTALLED_ID=<"%SKILL_DST%\.swpanel-bundle-id"
if not exist "%SKILL_DST%\SKILL.md" goto :copy_skill
if not defined INSTALLED_ID goto :keep_skill
if "%INSTALLED_ID%"=="%BUNDLE_ID%" goto :skill_ready
rmdir /s /q "%SKILL_DST%"
:copy_skill
echo 正在安装 SolidWorks 技能到 %SKILL_DST%
xcopy /e /i /y /q "%SKILL_SRC%" "%SKILL_DST%" >nul
goto :skill_ready
:keep_skill
echo [提示] 检测到您自己安装的同名技能，将直接使用，不会覆盖。
:skill_ready
set "SWPANEL_LIVE_CODEX_SKILL_PATH=%SKILL_DST%"
exit /b 0

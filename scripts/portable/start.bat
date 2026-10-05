@echo off
setlocal EnableExtensions
chcp 65001 >nul
title SWPanel

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem ---- Bundled Python (pywin32, pypdfium2, ...) takes priority over system Python ----
set "PATH=%ROOT%\python;%ROOT%\python\Scripts;%PATH%"

rem ---- Data dir and port (override by setting the same env vars before running) ----
if not defined SWPANEL_DATA_ROOT set "SWPANEL_DATA_ROOT=%LOCALAPPDATA%\SWPanel\data"
if not defined PORT set "PORT=3001"
if not defined HOST set "HOST=127.0.0.1"
set "SWPANEL_WEB_ROOT=%ROOT%\app\apps\desktop\dist\renderer"

echo ============================================================
echo  SWPanel
echo  Data dir: %SWPANEL_DATA_ROOT%
echo ============================================================

rem ---- Codex CLI: must be the real codex.exe (not the npm .cmd shim) ----
if not defined SWPANEL_LIVE_CODEX_EXECUTABLE for /f "delims=" %%i in ('where codex.exe 2^>nul') do if not defined SWPANEL_LIVE_CODEX_EXECUTABLE set "SWPANEL_LIVE_CODEX_EXECUTABLE=%%i"
if not defined SWPANEL_LIVE_CODEX_EXECUTABLE if exist "%APPDATA%\npm\node_modules\@openai\codex" for /f "delims=" %%i in ('dir /s /b "%APPDATA%\npm\node_modules\@openai\codex\codex.exe" 2^>nul') do if not defined SWPANEL_LIVE_CODEX_EXECUTABLE set "SWPANEL_LIVE_CODEX_EXECUTABLE=%%i"
if defined SWPANEL_LIVE_CODEX_EXECUTABLE (
  echo [OK] Codex CLI: %SWPANEL_LIVE_CODEX_EXECUTABLE%
) else (
  echo [WARN] codex.exe not found: the web UI works, but auto-modeling is unavailable.
  echo        Install Codex CLI and run codex login, or set SWPANEL_LIVE_CODEX_EXECUTABLE, then restart.
)

rem ---- Skill: Codex only discovers skills in its own folders, so install into the user dir on first run ----
if not defined SWPANEL_LIVE_CODEX_SKILL_PATH call :install_skill
if not defined SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT set "SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT=true"

echo.
echo Address: http://127.0.0.1:%PORT%/
echo Close this window to stop the service.
echo.
echo Starting up (checking SolidWorks can take up to a minute; the browser opens when ready)...
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 240;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%)).Close();Start-Process 'http://127.0.0.1:%PORT%/';break}catch{Start-Sleep 1}}"

"%ROOT%\node\node.exe" "%ROOT%\app\apps\runner\dist\start-server.js"
echo.
echo Service exited (code %ERRORLEVEL%). Please screenshot any errors.
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
echo Installing SolidWorks skill to %SKILL_DST%
xcopy /e /i /y /q "%SKILL_SRC%" "%SKILL_DST%" >nul
goto :skill_ready
:keep_skill
echo [INFO] Found a user-installed skill with the same name; using it as is.
:skill_ready
set "SWPANEL_LIVE_CODEX_SKILL_PATH=%SKILL_DST%"
exit /b 0

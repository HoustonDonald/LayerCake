@echo off
rem LayerCake desktop launcher.
rem
rem Runs from its own directory rather than the caller's, so a Start Menu
rem shortcut, a double-click from Explorer, or a call from anywhere on the
rem filesystem all resolve scripts\launch.js the same way. pushd is used
rem instead of cd because it also copes with a UNC path by mapping a
rem temporary drive letter. Quoted throughout for paths with spaces.

setlocal
pushd "%~dp0" || (
  echo Could not enter the LayerCake directory: %~dp0
  exit /b 1
)

rem "< nul" is what keeps Ctrl+C from stranding this window.
rem
rem Ctrl+C reaches every process on the console, so node stops the server and
rem cmd asks "Terminate batch job (Y/N)?" at the same time. With the console as
rem its input that question waits forever on a user who thought they had just
rem closed the app. Reading it from nul answers it immediately, so the prompt
rem flashes past and the batch runs on to its own exit. The redirection is
rem scoped to this call, so the pause below still reads the keyboard.
call :run %* < nul
set "LAYERCAKE_EXIT=%ERRORLEVEL%"

popd

rem Hold the window open on failure only. Launched from a shortcut there is no
rem console to read afterwards, so an error that closes instantly is an error
rem nobody sees. A clean exit and Ctrl+C both return 0 and close immediately.
if not "%LAYERCAKE_EXIT%"=="0" pause

endlocal & exit /b %LAYERCAKE_EXIT%

:run
node "%~dp0scripts\launch.js" %*
exit /b %ERRORLEVEL%

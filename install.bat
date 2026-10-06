@echo off
rem Creates desktop + Start menu shortcuts. Double-click once after unzipping.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause

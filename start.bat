@echo off
rem Run without installing shortcuts (no Python needed).
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"

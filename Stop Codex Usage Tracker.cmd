@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-background.ps1"
if errorlevel 1 pause

@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-background.ps1"
if errorlevel 1 pause

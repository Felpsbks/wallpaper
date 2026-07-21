@echo off
set wait_count=0
:wait
tasklist /FI "PID eq 8448" /FO CSV /NH 2>NUL | findstr /B /C:"\"" >nul
if errorlevel 1 goto swap
set /a wait_count+=1
if %wait_count% GEQ 30 goto swap
echo ainda esperando, tentativa %wait_count%
timeout /t 1 /nobreak >nul
goto wait
:swap
echo CHEGOU NO SWAP - processo nao encontrado mais
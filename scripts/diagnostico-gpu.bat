@echo off
title Diagnostico Engine Wallpaper
echo Rodando diagnostico, aguarde...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostico-gpu.ps1"
echo.
echo Pronto! O arquivo diagnostico-engine-wallpaper.txt foi criado na Area de Trabalho e deve ter aberto no Bloco de Notas.
echo Me manda o conteudo desse arquivo.
pause

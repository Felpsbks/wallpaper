@echo off
title Diagnostico Lively Wallpaper
echo Certifique-se que o Lively esta aberto e com um wallpaper de video tocando ANTES de continuar.
pause
echo Rodando diagnostico, aguarde...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostico-lively.ps1"
echo.
echo Pronto! O arquivo diagnostico-lively.txt foi criado na Area de Trabalho e deve ter aberto no Bloco de Notas.
echo Me manda o conteudo desse arquivo.
pause

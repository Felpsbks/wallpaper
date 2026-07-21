# Auto-updater ficava preso pra sempre — corrigido com testes reais (2026-07-20)

## O bug real

Usuário aplicou a atualização v1.0.1→v1.0.2 e o `.bat` que troca o `app.asar` e reabre o app **ficou preso pra sempre** — janela cmd (que devia ficar escondida, `windowsHide` não é 100% confiável) visível e parada, app nunca reabriu. Sem nenhum rastro no log (o processo já tinha fechado o app antes do `.bat` travar).

## Causa

O script de espera original:
```bat
:wait
tasklist /FI "PID eq %pid%" /NH | findstr /I "%pid%" >nul
if not errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait )
```
Dois problemas: (1) `findstr /I "%pid%"` faz busca por **substring**, não igualdade exata — um PID que aparece como pedaço de outro número na saída do tasklist geraria falso positivo pra sempre; (2) **nenhum limite de tempo** — se a detecção falhar por qualquer motivo, espera pra sempre, sem chance de recuperação.

## Fix — testado empiricamente, não só no papel

Depois de uma tentativa inicial com `findstr /C:"\""` que **quebrou de verdade** (`FINDSTR: não foi possível abrir >nul`, confirmado testando contra um processo real vivo e um inexistente via `Start-Process`/`cmd.exe` de verdade, não só lendo o código), a abordagem que funcionou:

```bat
for /f %%i in ('tasklist /FI "PID eq %pid%" /FO CSV /NH 2^>NUL ^| find /C /V ""') do set proc_count=%%i
if not "%proc_count%"=="1" goto swap
```
Conta linhas da saída (`find /C /V ""`) em vez de tentar casar aspas — processo vivo sempre devolve exatamente 1 linha CSV, processo morto nunca devolve exatamente 1 (confirmado: 2 linhas no Windows em português). Mais um contador de segurança: nunca espera mais de 30 tentativas (~30s) — depois disso, segue em frente mesmo assim (reabrir com a troca talvez incompleta é recuperável; ficar preso escondido pra sempre não é).

**Validado com um teste completo, de ponta a ponta**, arquivo `.bat` real gerado pela mesma lógica exata do código, rodado via `cmd.exe` de verdade (não simulado): confirmei processo vivo → `proc_count=1` em 29 tentativas seguidas; processo morto → detecta na hora, copia o arquivo, cria o marcador de "reaberto", e o próprio `.bat` se autoapaga no final. Essa disciplina de testar contra um processo real (não só ler o código) foi o que pegou o bug do `findstr` quebrado, que passaria despercebido só lendo.

## Bônus: log persistente do processo

Como o app fecha ENQUANTO o `.bat` roda, a aba Log normal (em memória) nunca mostrava nada sobre esse processo, mesmo quando dava certo. Agora o `.bat` escreve seu próprio log (`apply-log.txt`, com timestamp por etapa) na pasta temporária de update, e o próximo boot do app lê esse arquivo, joga o conteúdo na aba Log de verdade, e apaga — assim qualquer travamento futuro deixa rastro.

## Publicado

v1.0.3, `Felpsbks/fynix-connect`. `node --check` limpo. Lógica do `.bat` testada empiricamente contra processos reais antes de publicar (não só teoria).

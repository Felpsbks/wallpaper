# Correções de update + polish de UI — 2026-07-20

Três ajustes pequenos, mesma sessão, depois do compilador de shaders/puppet.

---

## Crash "Invalid package ...app.asar" ao aplicar update

### O bug

Ao clicar "Atualizar agora", o processo principal quebrava com `Error: Invalid package ...\engine-wallpaper-update\app.asar`, apontando pra dentro de `asar_bundle`/`WriteStream._construct`.

### Causa

O Electron faz patch global no `fs` do Node pra interceptar **qualquer** caminho que contenha `.asar` e tentar interpretá-lo como pacote ASAR — inclusive um arquivo que ainda nem existe, só está sendo *criado*. O handler `apply-update` baixava o update pra um caminho literalmente chamado `app.asar` (`%TEMP%\engine-wallpaper-update\app.asar`), e o próprio `fs.createWriteStream` no meio da escrita já disparava essa interceptação.

### Fix (`main.js`, handler `apply-update`)

Baixa pra um nome sem `.asar` no meio — `app-update.download` — e só usa o nome literal `app.asar` no passo final, dentro do `.bat` descartável (que roda via `cmd.exe`, fora do `fs` do Node, então não sofre o patch):

```
copy /Y "app-update.download" "app.asar"   (dentro do .bat, dir final = process.resourcesPath)
```

### Versão desalinhada (bug irmão)

`package.json` ainda estava em `1.0.0` enquanto a release do GitHub já estava taggeada `v1.0.1` — ou seja, mesmo um update bem-sucedido continuaria se autodenunciando como "1.0.0" e reaplicando o mesmo update pra sempre. Corrigido subindo `package.json` pra `1.0.1` e reempacotando.

**Pendente do lado do usuário:** subir o `bin\resources\app.asar` reempacotado (com o fix + versão 1.0.1) como asset da release `v1.0.1` no GitHub, substituindo o asset antigo com bug.

---

## Versão visível no topo da sidebar

Antes só aparecia enterrada em Configurações → Sobre. Adicionado `<div class="sidebar-version">v<span id="sidebar-version-text">--</span></div>` logo abaixo do logo (`ui/index.html`), preenchido em `ui/app.js` a partir do mesmo `package.json` version que já alimentava a tela de Sobre — sem duplicar lógica, só um segundo elemento sendo populado pela mesma variável (`appVersion`).

---

## Modal de confirmação estilizado (substituindo `confirm()` nativo)

### Por quê

`confirm()`/`alert()` nativos do Electron renderizam como diálogo do SO, genérico, sem estilo, com o nome interno do app no título — destoava do resto da UI.

### Fix

Novo modal reutilizável em `ui/index.html` (`#modal-confirm`, segue o mesmo padrão visual dos outros modais do app — `.modal-backdrop`/`.modal`) e uma função `showConfirm(message, title)` em `ui/app.js` que devolve uma Promise, resolvida `true`/`false` conforme o botão clicado:

```js
function showConfirm(message, title) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-title').textContent = title || 'Confirmar';
    document.getElementById('modal-confirm-message').textContent = message;
    const finish = (result) => { closeModal('modal-confirm'); resolve(result); };
    document.getElementById('btn-confirm-ok').onclick = () => finish(true);
    document.getElementById('btn-confirm-cancel').onclick = () => finish(false);
    modal.classList.add('open');
  });
}
```

Substituiu os 3 usos de `confirm()` nativo (todos já dentro de funções `async`, só trocou `if (!confirm(...))` por `if (!await showConfirm(...))`): remover wallpaper da biblioteca, excluir playlist, excluir rotina.

### Bônus: fundo desfocado nos modais

`.modal-backdrop` ganhou `backdrop-filter: blur(6px)` (e o `-webkit-` equivalente) e a opacidade do preto caiu de `.75` pra `.55` — o conteúdo atrás fica desfocado em vez de só escurecido.

**Validado:** `node --check ui/app.js` limpo; classes CSS (`.modal-actions`, `.btn-secondary`) já existiam e reaproveitadas sem alteração. Confirmação visual ao vivo ainda não feita pelo usuário.

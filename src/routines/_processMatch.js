// Relocado de main.js (antigo getRunningProcesses(), usado só pelo loop de
// App Rules) — agora compartilhado por qualquer rotina que precise saber
// quais processos estão rodando (Jogo e Aplicativo), sem duplicar a lógica
// de exec/parse do "tasklist" em cada módulo.
function getRunningProcesses() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('tasklist /FO CSV /NH', (err, stdout) => {
      if (err) return resolve([]);
      const processes = stdout.split('\n')
        .map(line => line.split(',')[0])
        .map(name => name.replace(/"/g, '').trim().toLowerCase())
        .filter(name => name.length > 0);
      resolve(processes);
    });
  });
}

function matchesProcess(config, context) {
  return !!(context.runningProcesses && config && config.exe &&
    context.runningProcesses.includes(String(config.exe).toLowerCase()));
}

module.exports = { getRunningProcesses, matchesProcess };

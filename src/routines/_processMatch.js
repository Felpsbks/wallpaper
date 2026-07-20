// Relocado de main.js (antigo getRunningProcesses(), usado só pelo loop de
// App Rules) — agora compartilhado por qualquer rotina que precise saber
// quais processos estão rodando (Jogo e Aplicativo), sem duplicar a lógica
// de exec/parse do "tasklist" em cada módulo.
function getRunningProcesses() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // windowsHide: sem isso o Windows pisca uma janela de console real toda
    // vez que isso roda — e com o motor novo isso executa a cada ~2s (bem
    // mais frequente que o timer antigo de 3s), então o pisca-pisca fica
    // muito mais visível/incômodo se não travar isso.
    exec('tasklist /FO CSV /NH', { windowsHide: true }, (err, stdout) => {
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

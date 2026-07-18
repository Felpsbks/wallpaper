// Registro de todos os tipos de rotina disponíveis. Adicionar um tipo novo
// no futuro (Aleatório, Por Monitor, Clima, Bateria...) é: criar o arquivo
// seguindo a mesma interface (type/label/defaultPriority/evaluate) e
// acrescentar uma linha aqui — o RoutineEngine não muda.
module.exports = {
  time: require('./time'),
  weekly: require('./weekly'),
  monthly: require('./monthly'),
  interval: require('./interval'),
  game: require('./game'),
  application: require('./application'),
};

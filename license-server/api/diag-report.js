const { saveDiagReport } = require('../store');
const { isRateLimited } = require('../rate-limit');

// Campos mantidos pequenos de propósito — isso é diagnóstico de erro
// pontual, não telemetria ampla. Trunca qualquer string longa (stack trace)
// pra não deixar o Redis crescer sem controle nem vazar dado grande demais.
const MAX_FIELD_LEN = 4000;
function truncate(v) {
  if (typeof v !== 'string') return v;
  return v.length > MAX_FIELD_LEN ? v.slice(0, MAX_FIELD_LEN) + '…(truncado)' : v;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (await isRateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

  const body = req.body || {};
  if (!body.message) return res.status(400).json({ error: 'missing_message' });

  const report = {
    source: truncate(String(body.source || 'unknown')),
    level: truncate(String(body.level || 'error')),
    message: truncate(String(body.message)),
    appVersion: truncate(String(body.appVersion || '')),
    machineId: truncate(String(body.machineId || '')),
    extra: body.extra ? truncate(JSON.stringify(body.extra)) : null,
  };

  try {
    const id = await saveDiagReport(report);
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('[diag-report]', err.message);
    // Nunca deve travar o app que está reportando um erro — falha aberta.
    return res.status(200).json({ ok: false });
  }
};

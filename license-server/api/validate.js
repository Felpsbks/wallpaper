const { validateKey } = require('../store');
const { isRateLimited } = require('../rate-limit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (await isRateLimited(ip)) return res.status(429).json({ valid: false, reason: 'rate_limited' });

  const { key, machineId } = req.body || {};
  if (!key || !machineId) return res.status(400).json({ valid: false, reason: 'missing_fields' });

  const result = await validateKey(key, machineId);
  return res.status(result.valid ? 200 : 403).json(result);
};

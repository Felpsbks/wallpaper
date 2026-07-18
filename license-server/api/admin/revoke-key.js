const { revokeKey } = require('../../store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!req.body?.key) return res.status(400).json({ error: 'missing_key' });
  const revoked = await revokeKey(req.body.key);
  return res.status(revoked ? 200 : 404).json({ revoked });
};

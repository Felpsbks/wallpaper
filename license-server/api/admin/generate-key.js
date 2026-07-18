const { generateKey } = require('../../store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const days = req.body?.days ? Number(req.body.days) : null;
  const key = await generateKey({ days });
  return res.status(200).json({ key });
};

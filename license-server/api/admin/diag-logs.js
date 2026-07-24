const { listDiagReports } = require('../../store');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limit = req.query?.limit ? Math.min(Number(req.query.limit), 200) : 50;
  const reports = await listDiagReports(limit);
  return res.status(200).json({ reports });
};

const crypto = require('crypto');
const { createClient } = require('redis');

let client = null;

// Test-only seam: lets tests inject an in-memory fake without needing a real
// Redis connection. Not used by production code paths.
function _setClientForTesting(fakeClient) {
  client = fakeClient;
  client.isOpen = true; // skip the connect() step for fakes
}

async function getClient() {
  if (!client) {
    if (!process.env.REDIS_URL) {
      throw new Error('Missing REDIS_URL — connect a Redis database to this Vercel project (Storage tab).');
    }
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('[redis]', err.message));
  }
  if (!client.isOpen) await client.connect();
  return client;
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function readRecord(hash) {
  const c = await getClient();
  const raw = await c.get(`license:${hash}`);
  return raw ? JSON.parse(raw) : null;
}

async function writeRecord(hash, record) {
  const c = await getClient();
  await c.set(`license:${hash}`, JSON.stringify(record));
}

async function generateKey({ days = null } = {}) {
  const raw = crypto.randomBytes(10).toString('hex').toUpperCase(); // 20 hex chars
  const key = `EW-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
  const now = new Date();
  const record = {
    status: 'active',
    createdAt: now.toISOString(),
    expiresAt: days ? new Date(now.getTime() + days * 86400000).toISOString() : null,
    machineId: null,
    lastValidatedAt: null,
  };
  await writeRecord(hashKey(key), record);
  return key;
}

async function revokeKey(key) {
  const hash = hashKey(key);
  const record = await readRecord(hash);
  if (!record) return false;
  record.status = 'revoked';
  await writeRecord(hash, record);
  return true;
}

// Returns { valid, reason?, expiresAt? } and persists machine binding / lastValidatedAt as a side effect.
async function validateKey(key, machineId) {
  const hash = hashKey(key);
  const record = await readRecord(hash);

  if (!record) return { valid: false, reason: 'not_found' };
  if (record.status === 'revoked') return { valid: false, reason: 'revoked' };
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: 'expired' };
  }
  if (!record.machineId) {
    record.machineId = machineId;
  } else if (record.machineId !== machineId) {
    return { valid: false, reason: 'machine_mismatch' };
  }

  record.lastValidatedAt = new Date().toISOString();
  await writeRecord(hash, record);

  return { valid: true, expiresAt: record.expiresAt };
}

// Diagnóstico remoto (ver project_webview2_compat_mode / project_update_checker
// nas memórias) — o app (main.js ou WallpaperHost.exe, via main.js) manda um
// relatório curto aqui quando um erro fatal acontece, em vez de depender de
// print-e-cola manual do usuário. Lista com tamanho travado (LTRIM) em vez de
// uma chave por relatório — não precisa de índice/expiração separada, e nunca
// cresce sem limite mesmo se algo entrar em loop mandando relatórios.
const MAX_DIAG_REPORTS = 200;

async function saveDiagReport(report) {
  const c = await getClient();
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const entry = { id, receivedAt: new Date().toISOString(), ...report };
  await c.lPush('diag:reports', JSON.stringify(entry));
  await c.lTrim('diag:reports', 0, MAX_DIAG_REPORTS - 1);
  return id;
}

async function listDiagReports(limit = 50) {
  const c = await getClient();
  const raw = await c.lRange('diag:reports', 0, Math.max(0, limit - 1));
  return raw.map((r) => JSON.parse(r));
}

module.exports = { generateKey, revokeKey, validateKey, hashKey, saveDiagReport, listDiagReports, _setClientForTesting };

const crypto = require('crypto');

// Deployed on Vercel — see license-server/README.md. Override with the
// LICENSE_SERVER_URL env var to point at `vercel dev` (localhost:3000) for
// local testing instead.
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://wallpaperengine-jet.vercel.app';

const RECHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // re-hit the server at most every 3 days
const MAX_OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // allow up to 30 days without a successful server contact

// ID estável do PC: hash do MachineGuid do Windows (não muda enquanto o
// Windows não for reinstalado). Antes era um UUID aleatório guardado só no
// config.json — se o arquivo sumia/resetava, o app gerava outro ID e a
// própria chave do usuário passava a ser recusada como "em uso em outro
// computador" (caso real, 2026-10-16). IDs já salvos continuam valendo, pra
// não quebrar vínculos existentes; o derivado só entra quando falta um.
function stableMachineId() {
  if (process.platform !== 'win32') return null;
  try {
    const out = require('child_process').execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(out);
    if (!m) return null;
    const h = crypto.createHash('sha256').update('engine-wallpaper:' + m[1].toLowerCase()).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  } catch {
    return null;
  }
}

function getMachineId(store) {
  let id = store.get('machineId');
  if (!id) {
    id = stableMachineId() || crypto.randomUUID();
    store.set('machineId', id);
  }
  return id;
}

async function callValidate(key, machineId) {
  const res = await fetch(`${LICENSE_SERVER_URL}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, machineId }),
  });
  return res.json();
}

// Called from the activation screen with a freshly entered key.
async function activate(store, key) {
  const machineId = getMachineId(store);
  let result;
  try {
    result = await callValidate(key, machineId);
  } catch (_) {
    return { ok: false, reason: 'network_error' };
  }
  if (!result.valid) return { ok: false, reason: result.reason || 'invalid' };

  store.set('license', {
    key,
    expiresAt: result.expiresAt,
    lastCheckedAt: new Date().toISOString(),
  });
  return { ok: true };
}

// Refreshes a stale cached license in the background; never blocks the caller.
async function refreshInBackground(store, license) {
  const machineId = getMachineId(store);
  try {
    const result = await callValidate(license.key, machineId);
    if (result.valid) {
      store.set('license', { key: license.key, expiresAt: result.expiresAt, lastCheckedAt: new Date().toISOString() });
    } else {
      store.set('license', { ...license, revoked: true, revokedReason: result.reason });
    }
  } catch (_) {
    // offline — leave the cache as-is, the grace window in checkLicense() covers this
  }
}

// Resolves whether the app is allowed to boot without network access.
// Returns { ok: true } or { ok: false, needsActivation: true }. Never throws.
async function checkLicense(store) {
  const license = store.get('license');
  if (!license || !license.key) return { ok: false, needsActivation: true };
  if (license.revoked) return { ok: false, needsActivation: true };

  const now = Date.now();
  const lastChecked = new Date(license.lastCheckedAt).getTime();
  const locallyExpired = license.expiresAt && new Date(license.expiresAt).getTime() < now;
  if (locallyExpired) return { ok: false, needsActivation: true };

  if (now - lastChecked < RECHECK_INTERVAL_MS) {
    return { ok: true }; // cache still fresh, no network needed
  }

  // Cache is stale: kick off a re-check but don't block boot on it — the
  // wallpaper keeps running on the last good cache within the grace window
  // (see project_workerw_fragility / feedback_lightweight_priority memories
  // for why staying up beats a strict online check here).
  refreshInBackground(store, license);

  if (now - lastChecked < MAX_OFFLINE_GRACE_MS) {
    return { ok: true };
  }
  return { ok: false, needsActivation: true };
}

module.exports = { checkLicense, activate, getMachineId, LICENSE_SERVER_URL };

const { createClient } = require('redis');

let client = null;

function _setClientForTesting(fakeClient) {
  client = fakeClient;
  client.isOpen = true;
}

async function getClient() {
  if (!client) {
    if (!process.env.REDIS_URL) return null; // fail open if Redis isn't configured yet
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('[redis]', err.message));
  }
  if (!client.isOpen) await client.connect();
  return client;
}

// max 20 requests/min per IP — counter lives in Redis since serverless
// invocations don't share in-memory state.
async function isRateLimited(ip) {
  const c = await getClient();
  if (!c) return false;
  const key = `ratelimit:${ip}`;
  const count = await c.incr(key);
  if (count === 1) await c.expire(key, 60);
  return count > 20;
}

module.exports = { isRateLimited, _setClientForTesting };

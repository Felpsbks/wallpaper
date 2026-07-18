// CLI: node generate-key.js [--days 365]
// Talks to Redis directly (same store.js the API functions use), so it needs
// the same env vars set locally — run `vercel env pull .env.local` first,
// or export KV_REST_API_URL/KV_REST_API_TOKEN yourself.
const { generateKey } = require('./store');

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
const days = daysIndex !== -1 ? Number(args[daysIndex + 1]) : null;

(async () => {
  const key = await generateKey({ days });
  console.log('Generated key:');
  console.log(key);
  if (days) console.log(`Expires in ${days} day(s).`);
  else console.log('No expiration.');
})();

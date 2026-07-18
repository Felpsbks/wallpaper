# license-server

Serviço de validação de license key para o EngineWallpaper. Roda como Vercel Functions (`api/`), separado do app Electron (não afeta o footprint dele). Armazena as keys em Redis — sem sistema de arquivos, então funciona no runtime serverless do Vercel.

**Deployado em produção:** `https://wallpaperengine-jet.vercel.app` (projeto `wallpaperengine`, time `ferepetido-1887s-projects`).

## Infra atual

- Redis: integração "Redis" do Marketplace (Redis Cloud, plano free — High Availability = None), conectada ao projeto. Injeta `REDIS_URL` (connection string TCP padrão, usada via o pacote `redis` no `store.js`/`rate-limit.js`) — **não** é Upstash/REST, então não use `@upstash/redis` aqui.
- `ADMIN_SECRET`: já configurado nas envs Production/Preview do projeto.

## Rodar localmente

```
cd license-server
npm install
npx vercel link          # associa esta pasta ao projeto Vercel (uma vez)
npx vercel env pull .env.local
npx vercel dev
```

Sobe em `http://localhost:3000` (padrão do `vercel dev`).

## Gerar uma key

Precisa das credenciais do Redis no ambiente (`vercel env pull .env.local` resolve isso — carregue o `.env.local` antes, ex: `node -r dotenv/config generate-key.js`, ou exporte `REDIS_URL` manualmente):

```
node generate-key.js               # sem expiração
node generate-key.js --days 365    # expira em 1 ano
```

A key é impressa uma única vez — guarde-a, só o hash fica salvo no Redis.

Alternativa sem rodar nada localmente — via API admin (precisa do `ADMIN_SECRET`):

```
curl -X POST https://wallpaperengine-jet.vercel.app/api/admin/generate-key ^
  -H "x-admin-secret: SEU_ADMIN_SECRET" ^
  -H "Content-Type: application/json" ^
  -d "{\"days\":365}"
```

## Revogar uma key

```
curl -X POST https://wallpaperengine-jet.vercel.app/api/admin/revoke-key ^
  -H "x-admin-secret: SEU_ADMIN_SECRET" ^
  -H "Content-Type: application/json" ^
  -d "{\"key\":\"EW-XXXXX-XXXXX-XXXXX-XXXXX\"}"
```

## Endpoint que o app usa

```
POST /api/validate
{ "key": "EW-...", "machineId": "..." }
```

Retorna `{ valid, expiresAt }` ou `{ valid: false, reason }` (`not_found` | `revoked` | `expired` | `machine_mismatch` | `rate_limited`).
A key é vinculada ao primeiro `machineId` que validar com sucesso — depois disso, outro `machineId` com a mesma key recebe `machine_mismatch`.

Testado de ponta a ponta em produção (gerar → validar/vincular → mismatch em outra máquina → revalidar → revogar → confirmar revogada) — todos os casos passaram.

## Redeploy

Depois de qualquer mudança em `license-server/`:

```
cd license-server
npx vercel --prod --yes
```

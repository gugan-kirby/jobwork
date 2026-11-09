# F-CW.0 spike

Measures whether a Worker on the free plan can reach Supabase Postgres (through Hyperdrive) and Supabase Storage, and how much CPU each call uses ([ADR-0009](../../../docs/adr/0009-cloudflare-workers-supabase-demo.md), [plan](../../../docs/build-plan/f-cw-cloudflare-workers.md)). Throwaway: deleted once F-CW.7 deploys the real Workers.

Run every command in your own Terminal app, not in a chat, so that keys and passwords stay on your machine. Start from `fresh-start/infra/cloudflare/spike`.

## 1. Supabase project

1. Sign in at <https://supabase.com/dashboard> and choose **New project**. Region: **South Asia (Mumbai)**. Generate a database password and keep it in your password manager.
2. **Storage → New bucket**: create `jobwork-quarantine` and `jobwork-clean`. Leave **Public bucket** off for both.
3. **Project Settings → Storage → S3 Connection**: turn on **Enable connection via S3 protocol**. Copy the **Endpoint**. Under **S3 Access Keys** choose **New access key** and copy the access key ID and secret.
4. Choose **Connect** at the top of the project. Under **Session pooler**, copy the URI and put your database password in it.

## 2. Cloudflare account

1. Sign up at <https://dash.cloudflare.com/sign-up>. The free plan needs no card.
2. Log in from this folder:

   ```sh
   pnpm exec wrangler login
   ```

## 3. Hyperdrive

```sh
pnpm exec wrangler hyperdrive create jobwork-demo --caching-disabled \
  --connection-string='<session pooler URI from step 1.4>'
```

Copy the printed `id` into `wrangler.jsonc` in place of the zeros. Caching stays off: a read must see the write before it.

## 4. Secrets and deploy

```sh
openssl rand -hex 24                                        # copy the output; it is SPIKE_TOKEN
pnpm exec wrangler secret put SPIKE_TOKEN                   # paste it
pnpm exec wrangler secret put OBJECT_STORE_ENDPOINT         # the S3 endpoint from step 1.3
pnpm exec wrangler secret put OBJECT_STORE_ACCESS_KEY
pnpm exec wrangler secret put OBJECT_STORE_SECRET_KEY
pnpm run deploy
```

`deploy` prints the address, `https://jobwork-spike.<your-subdomain>.workers.dev`.

## 5. Probe

```sh
URL=https://jobwork-spike.<your-subdomain>.workers.dev
TOKEN=<SPIKE_TOKEN>
curl -s -H "authorization: Bearer $TOKEN" $URL/db
curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"password":"correct horse battery staple"}' $URL/hash
curl -s -H "authorization: Bearer $TOKEN" $URL/storage
```

Run each one three times. The first call of a fresh Worker is a cold start.

## 6. Read the CPU

Cloudflare dashboard → **Workers & Pages → jobwork-spike → Logs**. Each request shows **CPU time**. Paste the three JSON replies and the CPU times into the chat. They contain no secrets.

| Probe | Passes when |
|---|---|
| `/db` | `ok: true`; CPU ≤ 5 ms |
| `/hash` | `ok: true`, `hashPrefix` starts `$2a$10$`; CPU ≤ 10 ms |
| `/storage` | `presignedPut` 200, `tamperedPutRefused` true, `checksumReturned` true, `presignedGet` 200, `bytesMatch` true |

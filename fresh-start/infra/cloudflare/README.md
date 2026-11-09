# Free demo on Cloudflare Workers and Supabase

Four Workers and one Supabase project, no domain, no spend ([ADR-0009](../../docs/adr/0009-cloudflare-workers-supabase-demo.md), [plan](../../docs/build-plan/f-cw-cloudflare-workers.md)). Made-up data only: the free plans keep no backups.

| Worker | Address | Does |
|---|---|---|
| `jobwork-api` | none (service bindings only) | The API |
| `jobwork-worker` | none | Outbox, sweeps, scans, mail: once a minute |
| `jobwork-portal` | `https://jobwork-portal.<subdomain>.workers.dev` | Customers and suppliers |
| `jobwork-operations` | `https://jobwork-operations.<subdomain>.workers.dev` | JobWork staff |

Run every command in your own Terminal app, from `fresh-start/`, so that passwords and keys stay on your machine. No step needs a server running on your Mac.

## 1. Supabase

In your Supabase project:

1. **Storage → New bucket**: create `jobwork-quarantine` and `jobwork-clean`. Leave **Public bucket** off for both.
2. **Project Settings → Storage → S3 Connection**: turn on **Enable connection via S3 protocol**. Note the **Endpoint** and **Region**. Under **S3 Access Keys** choose **New access key** and keep the key ID and secret in your password manager.
3. **Connect** (top of the project) → **Session pooler**: copy the URI and put your database password in it. Below it is called `<pooler URI>`.

## 2. Database tables

```sh
pnpm install && pnpm -r build
DATABASE_URL='<pooler URI>' pnpm migrate
```

Never run `pnpm seed` against Supabase: its accounts use passwords published in this repository.

## 3. Cloudflare login

```sh
cd apps/api && pnpm exec wrangler login && cd ../..
```

Your subdomain is in the Cloudflare dashboard: **Workers & Pages → Overview**, right side, **Subdomain** (the part before `.workers.dev`).

## 4. Hyperdrive

```sh
cd apps/api
pnpm exec wrangler hyperdrive create jobwork-demo --caching-disabled \
  --connection-string='<pooler URI>'
cd ../..
```

Copy the printed `id` into `apps/api/wrangler.jsonc` and `apps/worker/wrangler.jsonc` in place of the zeros. The id is not a secret; commit it. Caching stays off: a page must see the change you just made.

## 5. Deploy

```sh
WORKERS_SUBDOMAIN=<subdomain> \
OBJECT_STORE_ENDPOINT='<S3 endpoint from step 1.2>' \
OBJECT_STORE_REGION=<region from step 1.2> \
bash infra/cloudflare/deploy.sh
```

It builds everything, then deploys the API, the cron worker and the two web apps, and prints the two addresses.

## 6. Secrets

```sh
bash infra/cloudflare/secrets.sh
```

It asks for the Supabase S3 key ID and secret, generates the rest, and gives them straight to Cloudflare. Nothing is written to disk. Run it once; running it again replaces every secret and signs everyone out.

## 7. First admin

```sh
DATABASE_URL='<pooler URI>' PASSWORD_HASHER=pgcrypto-bcrypt \
ADMIN_EMAIL='you@example.com' ADMIN_PASSWORD='<12+ characters>' ADMIN_NAME='Your Name' \
HUB_ADDRESS='<receiving hub street>' HUB_CITY=Chennai HUB_STATE='Tamil Nadu' HUB_POSTAL_CODE='<PIN>' \
HUB_CONTACT_NAME='<name>' HUB_CONTACT_PHONE='<phone>' \
node database/dist/cli.js bootstrap-admin
```

`PASSWORD_HASHER=pgcrypto-bcrypt` matters: the API on Workers can only check bcrypt.

## 8. Try it

1. Open the operations address, sign in as the first admin, and enrol MFA in your profile.
2. Open the portal address and register a customer.
3. Back in operations: **Operations health → Mail → Read the mail**. The verification mail arrives within a minute; open its link.

## 9. The red check on pull requests

The repository is connected to a Cloudflare project named `jobwork` (**Workers Builds**), which tries to deploy the repository root on every pull request and fails. These Workers are deployed with `deploy.sh` instead. Remove it: **Workers & Pages → jobwork → Settings → Builds → Disconnect**, then delete the `jobwork` Worker.

## Updating

`git pull`, then step 5 again. Run `pnpm migrate` against Supabase first (step 2) when a pull brings new migrations.

## Known limits

| Limit | Effect |
|---|---|
| 10 ms CPU per request (Workers Free) | Fine for normal pages. If a request is ever refused with error 1102, **Workers & Pages → the Worker → Logs** shows its CPU time |
| 100,000 requests a day | Shared by the four Workers |
| Uploads above 8 MiB | Refused by the scan (fail-closed) |
| Supabase pauses after 7 idle days | The cron worker queries every minute, so it stays awake while the Workers run |
| No mail leaves | Read it on the operations Mail page |
| Payments, carrier, malware scanning | Development adapters (`T-03`, `T-05`, `T-06`); an online payment cannot complete |

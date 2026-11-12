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

## 2. The private file

Create `infra/cloudflare/.env.deploy` (git ignores `.env.*`; `chmod 600`) with the five values from step 1:

```
DATABASE_URL=<session pooler URI, with the password>
OBJECT_STORE_ENDPOINT=<S3 endpoint>
OBJECT_STORE_REGION=<S3 region>
OBJECT_STORE_ACCESS_KEY=<access key ID>
OBJECT_STORE_SECRET_KEY=<secret access key>
```

Never run `pnpm seed` against Supabase: its accounts use passwords published in this repository.

## 3. Cloudflare login

```sh
cd apps/api && pnpm exec wrangler login && cd ../..
```

The account needs a `workers.dev` subdomain (**Workers & Pages → Overview**, right side).

## 4. Go live

```sh
bash infra/cloudflare/go-live.sh
```

One run does everything, reading only `.env.deploy`: installs and builds; applies the migrations to Supabase; creates the Hyperdrive configuration `jobwork-demo` (caching off, so a page sees the change you just made) and writes its id into `apps/api/wrangler.jsonc` and `apps/worker/wrangler.jsonc` (commit them); deploys `jobwork-api`, `jobwork-worker`, `jobwork-portal` and `jobwork-operations` with this account's addresses; generates the secrets and gives them to the API and the worker. It prints the two addresses at the end.

Later: `bash infra/cloudflare/go-live.sh deploy` after a `git pull` (run the migrations first if the pull brought any: `DATABASE_URL='<pooler URI>' node database/dist/cli.js up`), and `bash infra/cloudflare/go-live.sh secrets` to replace every secret, which signs everyone out.

## 5. First admin

```sh
DATABASE_URL='<pooler URI>' PASSWORD_HASHER=pgcrypto-bcrypt \
ADMIN_EMAIL='you@example.com' ADMIN_PASSWORD='<12+ characters>' ADMIN_NAME='Your Name' \
HUB_ADDRESS='<receiving hub street>' HUB_CITY=Chennai HUB_STATE='Tamil Nadu' HUB_POSTAL_CODE='<PIN>' \
HUB_CONTACT_NAME='<name>' HUB_CONTACT_PHONE='<phone>' \
node database/dist/cli.js bootstrap-admin
```

`PASSWORD_HASHER=pgcrypto-bcrypt` matters: the API on Workers can only check bcrypt.

## 6. Staff roles

The first admin holds the administrator roles only; the operational screens (intake, sourcing, sales, quality, logistics, support, finance) refuse it with `NOT_AUTHORIZED` until it holds their roles. `add-staff` grants internal roles, audited, and creates the account when it does not exist. Separation of duties applies: finance may not sit with sales or quality, so a demo run by one person keeps finance on a second login.

```sh
# the owner: every operational role but finance
DATABASE_URL='<pooler URI>' STAFF_EMAIL='you@example.com' STAFF_NAME='Your Name' \
STAFF_ROLES='jobwork_sourcing,jobwork_engineering,jobwork_sales,jobwork_quality,jobwork_logistics,jobwork_incoming,jobwork_receiving,jobwork_stock,jobwork_quarantine,jobwork_vehicle,jobwork_to_customer,jobwork_to_supplier,jobwork_support' \
node database/dist/cli.js add-staff

# a finance login
DATABASE_URL='<pooler URI>' PASSWORD_HASHER=pgcrypto-bcrypt STAFF_EMAIL='finance@example.com' STAFF_NAME='Finance' \
STAFF_ROLES='jobwork_finance' STAFF_PASSWORD='<12+ characters>' node database/dist/cli.js add-staff
```

Sign out and in again after a grant: a session carries the roles it was issued with.

## 7. Try it

1. Open the operations address, sign in as the first admin, and enrol MFA in your profile.
2. Open the portal address and register a customer.
3. Back in operations: **Operations health → Mail → Read the mail**. The verification mail arrives within a minute; open its link.

## The `jobwork` Worker and the check on pull requests

Cloudflare Workers Builds is connected to this repository (dashboard, 2026-11-05) as a Worker named `jobwork`: on every push it runs `npx wrangler deploy` in the repository root, with no build step. The root `wrangler.jsonc` makes that deploy the demo's front door, `https://jobwork.<subdomain>.workers.dev`, a static page in `site/` linking to the two applications. The applications are never built there; they come from `go-live.sh`.

## Updating

`git pull`, then `bash infra/cloudflare/go-live.sh deploy` (migrations first when the pull brought any; step 4).

## Known limits

| Limit | Effect |
|---|---|
| 10 ms CPU per request (Workers Free) | Fine for normal pages. If a request is ever refused with error 1102, **Workers & Pages → the Worker → Logs** shows its CPU time |
| 100,000 requests a day | Shared by the four Workers |
| Uploads above 8 MiB | Refused by the scan (fail-closed) |
| Supabase pauses after 7 idle days | The cron worker queries every minute, so it stays awake while the Workers run |
| No mail leaves | Read it on the operations Mail page |
| Payments, carrier, malware scanning | Development adapters (`T-03`, `T-05`, `T-06`); an online payment cannot complete |

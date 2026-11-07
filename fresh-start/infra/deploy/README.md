# Free staging deployment

One Oracle Always Free VM runs everything, with no domain and no spend ([ADR-0008](../../docs/adr/0008-free-single-vm-staging.md)). Synthetic data only: there are no managed backups. Commands run on the VM unless stated.

## 1. Create the VM (Oracle Cloud)

1. Sign up at <https://www.oracle.com/cloud/free/>. Choose **India South (Hyderabad)** as home region; it cannot be changed later. A real credit or debit card is needed for verification; prepaid and virtual cards are refused.
2. **Compute → Instances → Create instance**.
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Ampere → VM.Standard.A1.Flex**, 2 OCPUs, 12 GB.
   - Networking: create a new VCN with a public subnet and a public IPv4 address.
   - SSH keys: **Generate a key pair**, and download the private key.
   - Boot volume: 100 GB.
3. On "Out of host capacity", try another availability domain, or retry later.
4. Copy the **Public IP address** from the instance page.

Open the ports: **Networking → Virtual cloud networks → your VCN → Security → Default Security List → Add Ingress Rules**, source `0.0.0.0/0`, IP protocol TCP, destination port `80`. Add a second rule for `443`.

## 2. Create the hostnames (DuckDNS)

Sign in at <https://www.duckdns.org>. Add three names, for example `jobwork-app`, `jobwork-ops`, `jobwork-files`; each must be unused. Put the VM's public IP in each **current ip** box and press **update ip**.

## 3. Create the mail password (Google)

1. Use a dedicated Gmail account. Turn on 2-Step Verification at <https://myaccount.google.com/security>.
2. Open <https://myaccount.google.com/apppasswords>, name it `JobWork`, and copy the 16 letters.

## 4. Get the code onto the VM

From your Mac:

```sh
chmod 400 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<public-ip>
```

On the VM:

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

In GitHub: **repository → Settings → Deploy keys → Add deploy key**, paste the line, leave write access off.

```sh
git clone git@github.com:gugan-kirby/jobwork.git
cd jobwork/fresh-start/infra/deploy
bash vm-setup.sh
exit
```

Log in again so Docker works without sudo, then `cd jobwork/fresh-start/infra/deploy`.

## 5. Create the env file

```sh
bash setup-env.sh
```

It asks for the three DuckDNS names, the Gmail address, and the app password, then generates everything else into `.env`. Back that file up privately. Never commit it, and never change its secrets after first start.

| Key | Value comes from |
|---|---|
| `PORTAL_HOST`, `OPERATIONS_HOST`, `FILES_HOST` | Your DuckDNS names |
| `ACME_EMAIL` | Your Gmail; Let's Encrypt uses it for certificate notices |
| `SMTP_URL` | Built from your Gmail and app password |
| `SMTP_FROM` | Built from your Gmail |
| `POSTGRES_PASSWORD`, `FILES_SECRET_KEY`, `SESSION_SECRET`, `SERVICE_TOKEN_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `CARRIER_WEBHOOK_SECRET` | Generated: `openssl rand -hex 32` |
| `FILES_ACCESS_KEY` | Generated: `jw` + `openssl rand -hex 10` |

## 6. Start

```sh
docker compose up -d --build
docker compose ps
```

The first build takes a while. `api`, `worker`, `portal`, `operations`, and `caddy` should be running; `migrate` and `files-init` exit by design.

## 7. Create the first admin

```sh
bash create-admin.sh
```

Works once. Sign in at `https://<operations-host>`, enrol MFA in your profile, and invite staff from there. Customers register at `https://<portal-host>`. **Never run the dev seed here**: its accounts use passwords published in this repository.

## Everyday commands

| Task | Command |
|---|---|
| See logs | `docker compose logs -f api worker` |
| Update | `git pull && docker compose up -d --build` |
| Back up the database | `docker compose exec -T postgres pg_dump -U jobwork jobwork \| gzip > ~/jobwork-$(date +%F).sql.gz` |
| Stop | `docker compose down` (data stays; never add `-v`) |

## Known limits

- Online payment cannot complete: production turns off the simulated gateway (`T-03`).
- Carrier is simulated (`T-05`), and file scanning checks signatures and structure only (`T-06`).
- Oracle may stop an idle instance. Restart it from the console; the data stays.

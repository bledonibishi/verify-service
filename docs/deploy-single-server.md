# Deploying on one small server (pilot)

The cheapest way to run verify-service on the internet over HTTPS: one Amazon Lightsail server in Frankfurt running the service, Postgres and Caddy (free, automatic HTTPS), with the photos in your existing S3 bucket and keys in your existing KMS key. About $12 a month for the 2 GB server plus a domain (prices change; check the [Lightsail pricing page](https://aws.amazon.com/lightsail/pricing/)).

**For a pilot, not for scale.** One machine is one point of failure, and backups are yours to keep (section 8). It has **not been run on a real server yet**: follow it once with fake data (section 9) before any real person uses it, and tell me where a step is wrong.

You need: an AWS account (the bucket, KMS key and IAM users from before), a domain name you can edit DNS for, and an SSH key.

## 1. Create the server

Lightsail console → **Create instance**.

- **Region:** Europe (Frankfurt), `eu-central-1`. If it is not offered, use an EC2 `t4g.small` in `eu-central-1` instead and keep the rest.
- **Platform / blueprint:** Linux/Unix → **OS only → Ubuntu 24.04 LTS**.
- **Plan:** at least **2 GB RAM** (building the app needs more than the 0.5 and 1 GB plans have).
- Name it `verify-service`. Create.
- **Networking tab:** create and attach a **static IP** (free while attached). Note it.
- **Firewall (IPv4):** keep **SSH 22** (restrict to your own IP), **HTTP 80** and **HTTPS 443**. Delete everything else. Port 4100 must **not** be open: only Caddy talks to the service, on the same machine.
- **Snapshots tab:** turn on **automatic daily snapshots**. This is your main backup of the whole server including the database.

## 2. DNS

At your domain provider add an **A record**: `verify.yourdomain.com` → the static IP. Wait until `nslookup verify.yourdomain.com` shows it. (Caddy cannot get a certificate before this works.)

## 3. Install what the service needs

```sh
ssh ubuntu@<static-ip>          # or the key and user Lightsail shows
sudo apt update && sudo apt -y upgrade
sudo apt -y install git tesseract-ocr postgresql caddy unattended-upgrades
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm install -g pnpm@12.5.1
node --version     # must be 20.12 or newer
tesseract --version
```

Postgres from `apt` listens on `localhost` only, which is what you want.

## 4. The database

```sh
sudo -u postgres psql
```

then, in psql (pick your own long random password, e.g. from `openssl rand -base64 24`, and keep it for section 5):

```sql
CREATE USER verify_app WITH PASSWORD 'PASTE-A-LONG-RANDOM-PASSWORD';
CREATE DATABASE verify OWNER verify_app;
\q
```

## 5. The application

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin verify
sudo mkdir -p /opt/verify-service && sudo chown verify:verify /opt/verify-service
sudo -u verify git clone https://github.com/bledonibishi/verify-service.git /opt/verify-service
cd /opt/verify-service
sudo -u verify pnpm install --frozen-lockfile
sudo -u verify pnpm build
```

Create the settings file. It holds secrets: only root reads it, and it never goes in the repository or a chat.

```sh
sudo nano /etc/verify-service.env
sudo chmod 600 /etc/verify-service.env
sudo chown root:root /etc/verify-service.env
```

Contents (replace the values; the variable names are explained in `.env.example`):

```
PORT=4100
DATABASE_URL=postgresql://verify_app:PASTE-THE-DB-PASSWORD@127.0.0.1:5432/verify
PUBLIC_BASE_URL=https://verify.yourdomain.com
TRUST_PROXY=1

STORAGE_DRIVER=s3
S3_BUCKET=<full bucket name>
S3_REGION=eu-central-1
S3_ACCESS_KEY_ID=<storage user key id>
S3_SECRET_ACCESS_KEY=<storage user secret>

STORAGE_KEY_PROVIDER=kms
KMS_KEY_ID=<key ARN or alias>
KMS_REGION=eu-central-1

OCR_PROVIDER=tesseract
LIVENESS_PROVIDER=none

# Face matching (sends the ID front and selfie to AWS Rekognition in eu-central-1). Use "none" to leave it off.
FACE_PROVIDER=rekognition
AWS_REGION=eu-central-1
AWS_ACCESS_KEY_ID=<face-match user key id>
AWS_SECRET_ACCESS_KEY=<face-match user secret>
```

Type the values in by hand on the server (or copy the file with `scp`); do not paste them into a chat. `TRUST_PROXY=1` is required: without it every visitor shares Caddy's address and the login rate limit applies to everyone at once.

Create the tables:

```sh
cd /opt/verify-service
sudo bash -c 'set -a; . /etc/verify-service.env; set +a; sudo -E -u verify pnpm prisma migrate deploy'
```

Run the service as a system service that restarts itself:

```sh
sudo tee /etc/systemd/system/verify-service.service >/dev/null <<'UNIT'
[Unit]
Description=verify-service
After=network.target postgresql.service

[Service]
User=verify
WorkingDirectory=/opt/verify-service
EnvironmentFile=/etc/verify-service.env
ExecStart=/usr/bin/node dist/src/main
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now verify-service
sudo systemctl status verify-service      # "active (running)"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4100/verify    # 200
```

Logs: `sudo journalctl -u verify-service -f`. They contain error classes and ids, no personal data.

## 6. HTTPS with Caddy

```sh
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
verify.yourdomain.com {
    encode zstd gzip
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:4100
}
CADDY
sudo systemctl reload caddy
```

Caddy gets a free certificate from Let's Encrypt on its own and renews it. Open `https://verify.yourdomain.com/verify` in a browser: the capture page with a padlock. `http://` is redirected to `https://` automatically.

## 7. First tenant and reviewer

```sh
cd /opt/verify-service
sudo bash -c 'set -a; . /etc/verify-service.env; set +a; sudo -E -u verify pnpm tenant:create "pharmacy" https://pharmacy.example/webhooks/verify'
```

This prints the API key and webhook secret once: store them in the pharmacy software's secret store and nowhere else. Then a reviewer account for each pharmacist (the password is shown once):

```sh
sudo bash -c 'set -a; . /etc/verify-service.env; set +a; sudo -E -u verify pnpm reviewer create <tenantId> pharmacist@example.com "Name"'
sudo bash -c 'set -a; . /etc/verify-service.env; set +a; sudo -E -u verify pnpm tenant:update <tenantId> --require-reviewer-2fa'
```

The reviewers sign in at `https://verify.yourdomain.com/review` and set up their authenticator app.

## 8. Backups and updates

- **Snapshots:** the automatic Lightsail snapshots from section 1 cover the whole machine.
- **A database dump as well** (restoring a dump is easier than a whole snapshot):
  ```sh
  sudo mkdir -p /var/backups/verify && sudo chmod 700 /var/backups/verify
  echo '30 2 * * * root sudo -u postgres pg_dump verify | gzip > /var/backups/verify/verify-$(date +\%F).sql.gz && find /var/backups/verify -mtime +7 -delete' | sudo tee /etc/cron.d/verify-backup
  ```
  The dump holds results and the names and birth dates tenants supplied, no photos. Treat it like the database. Test a restore once.
- **The photos** live in S3 (encrypted, with KMS); they are not on the server.
- **Updating:**
  ```sh
  cd /opt/verify-service
  sudo -u verify git pull
  sudo -u verify pnpm install --frozen-lockfile
  sudo -u verify pnpm build
  sudo bash -c 'set -a; . /etc/verify-service.env; set +a; sudo -E -u verify pnpm prisma migrate deploy'
  sudo systemctl restart verify-service
  ```
- Security updates install themselves (`unattended-upgrades`). Reboot when `sudo apt list --upgradable` shows a kernel.

## 9. Check it end to end, with fake data

1. `sudo bash -c 'set -a; . /etc/verify-service.env; set +a; sudo -E -u verify pnpm storage:check'` → all checks pass (needs the `s3:GetBucketVersioning` permission, see [storage](storage.md)).
2. Create a session with the API key (`curl` as in [safe-testing](safe-testing.md), but with `https://verify.yourdomain.com`), open the `hostedUrl` **on a phone** and upload fake photos, then sign in at `/review` and decide the case.
3. Confirm the webhook arrived at the pharmacy test endpoint, and `GET /v1/sessions/<id>` shows the final status.
4. Open `https://verify.yourdomain.com/review` and `/verify` in a browser's developer tools: no mixed-content warnings.
5. Only now give the pharmacy the real base URL, API key and webhook secret ([pharmacy-integration](pharmacy-integration.md)).

## 10. Before real customers (not covered by this guide)

SSH by key only (Lightsail does this by default) and your IP only on port 22; the CloudWatch alarms on KMS `Decrypt` and `AccessDenied`; an AWS budget alert; the data processing agreement and DPIA ([dpia](dpia.md)); the breach plan drilled ([breach-response](breach-response.md)); a penetration test. For more than a pilot move the database to a managed one (Lightsail or RDS) and run two instances behind a load balancer.

## If something goes wrong

| Symptom | Check |
| --- | --- |
| `https://…` does not load / certificate error | DNS A record points at the static IP; ports 80 and 443 open in the Lightsail firewall; `sudo journalctl -u caddy` |
| `502 Bad Gateway` | the service is down: `sudo systemctl status verify-service`, `sudo journalctl -u verify-service -n 50` |
| Service fails at start naming `AWS_ACCESS_KEY_ID` | when `AWS_ACCESS_KEY_ID` is set, the dedicated `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (and for KMS the S3 pair or `KMS_*`) must be set too |
| Everyone gets `429` on the sign-in | `TRUST_PROXY=1` is missing; restart after setting it |
| `ENOENT tesseract` / `OCR_UNAVAILABLE` | `sudo apt install tesseract-ocr`, then `sudo systemctl restart verify-service` |
| Build runs out of memory | use the 2 GB plan or larger |

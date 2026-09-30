# Putting ExamGuard online at invigilator.bakwenasa.co.za

This guide puts the two websites on your domains.co.za hosting and the API where it can run. The layout:

| Address | What it is | Where it runs |
|---|---|---|
| `https://invigilator.bakwenasa.co.za/` | Candidate website | Your web hosting (static files) |
| `https://invigilator.bakwenasa.co.za/admin/` | Staff portal (administrators, invigilators, markers) | Your web hosting (static files) |
| `https://api.bakwenasa.co.za` | The API, which both websites talk to | A place that can run Node.js and PostgreSQL |

The websites are only files, so ordinary web hosting is enough for them. The API is a running program with a database, and that is the part to decide first.

## Step 1: where will the API run?

Look in your domains.co.za control panel (cPanel). Two things decide it:

1. **Is there a "Setup Node.js App" (or "Node.js Selector") icon?** It must offer Node.js 22 or newer.
2. **Is there a "PostgreSQL Databases" icon?** MySQL is not enough: the API needs PostgreSQL 16.

Also needed: the API keeps recordings on disk unless you point it at S3 storage, so check your disk space.

* **Both icons present, Node 22 or newer:** the API can run on the same hosting. Follow "Running the API on cPanel" below.
* **Anything missing (common on shared plans):** put the API on a small server (a VPS) from any provider. A South African provider keeps the data close, for example a domains.co.za or Xneelo VPS, or a cloud region in Johannesburg or Cape Town. 2 CPU cores and 4 GB of memory suit a first deployment; see `OPERATIONS.md` for larger exams. Follow "Running the API on a server" below.

Either way the API needs its own address, `api.bakwenasa.co.za`, with https. Create the `api` subdomain in your DNS and point it at wherever the API runs.

## Step 2: build the two websites

On any computer with Node.js 22 and Git:

```bash
git clone https://github.com/kevinlebepe/kev.git
cd kev
git checkout claude/new-session-kbmcc6      # until the pull request is merged
API_URL=https://api.bakwenasa.co.za SITE_URL=https://invigilator.bakwenasa.co.za deploy/build-bundle.sh
```

This produces `deploy/bundle/`. It holds the candidate website, the `admin/` folder with the staff portal, and a hidden file called `.htaccess` that sends candidate addresses to the app, forces https and adds security headers.

## Step 3: upload the websites

In cPanel open **File Manager**, go to `/domains/bakwenasa.co.za/public_html/invigilator` (the folder you already made), turn on **Show Hidden Files** in Settings, and upload the contents of `deploy/bundle/` so that these sit directly inside `invigilator`:

```
invigilator/
  .htaccess
  index.html
  assets/
  admin/
    index.html
    assets/
```

Do not upload the `bundle` folder itself. If File Manager is awkward, zip the contents on your computer, upload the zip and use **Extract**.

Make sure the `invigilator.bakwenasa.co.za` subdomain has a certificate: in cPanel, **SSL/TLS Status**, then **Run AutoSSL**.

Whenever you rebuild, upload again and replace the files.

## Step 4: the API's settings

Whichever way it runs, the API reads these settings (see `api/.env.example` for all of them):

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | The PostgreSQL connection string |
| `JWT_SECRET` | A long random text: `openssl rand -base64 48` |
| `EXAM_SIGNING_PRIVATE_KEY` | `openssl genpkey -algorithm ed25519` (the whole PEM) |
| `EXAM_SIGNING_KEY_ID` | Any label, for example `2026-1` |
| `PUBLIC_BASE_URL` | `https://invigilator.bakwenasa.co.za` |
| `PORTAL_BASE_URL` | `https://invigilator.bakwenasa.co.za/admin` |
| `CORS_ORIGINS` | `https://invigilator.bakwenasa.co.za` (lets the websites call the API) |
| `SSO_CALLBACK_URL` | `https://api.bakwenasa.co.za/auth/sso/callback` (only if you use single sign on) |
| `SMTP_URL`, `MAIL_FROM` | Your email account, for example `smtps://user:password@mail.bakwenasa.co.za:465` and `ExamGuard <no-reply@bakwenasa.co.za>` |
| `TRUST_PROXY` | The proxy's address, if a proxy sits in front (usually needed on cPanel) |
| `RECORDING_DIR` or `S3_*` | Where recordings are kept |
| `METRICS_TOKEN` | A random text, if you monitor the API |

Keep the signing key and `JWT_SECRET` somewhere safe outside the server. Losing the signing key means exams already published cannot be verified by new keys; losing `JWT_SECRET` signs everyone out.

Then create the tables and the first administrator once:

```bash
cd api
npm ci && npm run build
NODE_ENV=production npm run migrate
SUPER_ADMIN_EMAIL=you@bakwenasa.co.za SUPER_ADMIN_PASSWORD='a long password' npm run seed
```

The platform administrator you create here has no organisation of its own: its only job is to create organisations. The staff portal is for the people inside an organisation, so create yours once with these two commands:

```bash
TOKEN=$(curl -s https://api.bakwenasa.co.za/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@bakwenasa.co.za","password":"a long password"}' | sed 's/.*"accessToken":"\([^"]*\)".*/\1/')
curl -s https://api.bakwenasa.co.za/platform/organisations -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"bakwena","name":"Bakwena SA","mode":"employer","owner":{"email":"you@bakwenasa.co.za","displayName":"Your Name"}}'
```

The owner gets an email to choose a password (when `SMTP_URL` is set). Then sign in at `https://invigilator.bakwenasa.co.za/admin/` with the organisation code `bakwena`.

## Running the API on cPanel

1. **Setup Node.js App**, then **Create Application**: Node.js 22 or newer, mode Production, application root `examguard-api` (a folder outside `public_html`), application URL `api.bakwenasa.co.za`, startup file `dist/server.js`.
2. Upload the `api` folder's files to that application root (without `node_modules`). Use the app's **Run NPM Install**, and build on your own computer first (`npm ci && npm run build`) so that `dist/` is uploaded too.
3. Add the settings from Step 4 under **Environment variables**.
4. Under **PostgreSQL Databases** create a database, a user and a strong password, and add the user to the database with all privileges. Use them in `DATABASE_URL` (the host is usually `localhost`).
5. Run the migrations and the seed (Step 4) from the app's terminal, or with the **Execute run script** feature.
6. Restart the application, then open `https://api.bakwenasa.co.za/health`. It should say `{"status":"ok"}`.

If the panel cannot run long lived programs reliably, or offers no PostgreSQL, use a server instead.

## Running the API on a server

On a fresh Ubuntu 24.04 server, as a user with sudo:

```bash
sudo apt update && sudo apt install -y postgresql caddy git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# Database
sudo -u postgres psql -c "CREATE USER examguard WITH PASSWORD 'choose-a-strong-password';"
sudo -u postgres psql -c "CREATE DATABASE examguard OWNER examguard;"

# The API
sudo useradd --system --create-home --shell /usr/sbin/nologin examguard
sudo -u examguard git clone --branch claude/new-session-kbmcc6 https://github.com/kevinlebepe/kev.git /home/examguard/app
cd /home/examguard/app/api && sudo -u examguard npm ci && sudo -u examguard npm run build
```

Write the Step 4 settings to `/etc/examguard.env` (mode 600, readable only by root), then create `/etc/systemd/system/examguard.service`:

```ini
[Unit]
Description=ExamGuard API
After=network.target postgresql.service

[Service]
User=examguard
WorkingDirectory=/home/examguard/app/api
EnvironmentFile=/etc/examguard.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/examguard/app/api/recordings

[Install]
WantedBy=multi-user.target
```

Run the migrations and the seed with the same settings loaded, then start it:

```bash
cd /home/examguard/app/api
sudo bash -c 'set -a; . /etc/examguard.env; set +a; sudo -E -u examguard env NODE_ENV=production npm run migrate'
sudo bash -c 'set -a; . /etc/examguard.env; set +a; sudo -E -u examguard env SUPER_ADMIN_EMAIL=you@bakwenasa.co.za SUPER_ADMIN_PASSWORD="a long password" npm run seed'
sudo systemctl enable --now examguard
```

Caddy gives the API a certificate and forwards to it. `/etc/caddy/Caddyfile`:

```
api.bakwenasa.co.za {
  reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
curl https://api.bakwenasa.co.za/health
```

Set `TRUST_PROXY=127.0.0.1` in `/etc/examguard.env` so sign in limits see real visitors. Back up the database every day (`pg_dump`), and the recordings folder unless you use S3 storage. `OPERATIONS.md` explains backups and monitoring.

To update later: `git pull`, `npm ci && npm run build`, `npm run migrate`, `sudo systemctl restart examguard`, then rebuild and re-upload the websites.

## Step 5: check it works

1. Open `https://invigilator.bakwenasa.co.za/status`. Every line should say Working.
2. Open `https://invigilator.bakwenasa.co.za/admin/` and sign in as the organisation owner.
3. In the portal, invite yourself as a candidate (Candidates, Invite a candidate), open the email, accept, approve yourself, create a small exam and session, and sit it from the candidate website.
4. Try the device check on the machines candidates will use. Camera and microphone need https, which the steps above provide.

## The desktop app

Locked exams on laptops and desktops need the desktop app. Set the repository variable `EXAMGUARD_APP_URL` to `https://invigilator.bakwenasa.co.za` on GitHub (Settings, Secrets and variables, Actions, Variables) before running the **Desktop installers** workflow, so the installers open your site. They are not yet signed; `IMPLEMENTATION.md` explains the warnings candidates will see.

## What stays with you

* Keep `.env` files, the signing key and database passwords out of the repository and out of email.
* Test a restore of the database before your first real exam.
* Use the checklist on each session page, and read `OPERATIONS.md` before an exam day.

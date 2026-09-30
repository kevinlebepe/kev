# Putting ExamGuard online with Render

Render runs the whole system from this GitHub repository: the database, the API and the two websites. The file `render.yaml` at the top of the repository describes all of it, so Render sets it up in one go.

What you end up with:

| Address | What it is |
|---|---|
| `https://invigilator.bakwenasa.co.za/` | Candidate website |
| `https://invigilator.bakwenasa.co.za/admin/` | Staff portal (administrators, invigilators, markers) |
| `https://api.bakwenasa.co.za` | The API, which both websites talk to |

## Before you start

1. **Merge the pull request** on GitHub, so the code is on the main branch. (Or tell Render to use the branch `claude/new-session-kbmcc6`.)
2. **Make the exam signing key** on any computer with OpenSSL (a Mac has it):

   ```bash
   openssl genpkey -algorithm ed25519
   ```

   Copy everything it prints, including the `BEGIN` and `END` lines. Keep a copy somewhere safe outside Render: it signs every exam and receipt.

3. **Choose the first administrator's email and a password** of 12 characters or more.
4. **Your email account for sending**, if you want invitations and reminders to go out: an address like `smtps://no-reply%40bakwenasa.co.za:PASSWORD@mail.bakwenasa.co.za:465`. Your domains.co.za email settings show the server name. (`%40` stands for the `@` in the user name.)

## Step 1: create everything from the blueprint

1. In Render, choose **New**, then **Blueprint**.
2. Connect GitHub if asked, and choose the repository `kevinlebepe/kev`.
3. Render reads `render.yaml` and lists three things: `examguard-db`, `examguard-api` and `examguard-websites`.
4. It asks for the values marked secret. Fill in:
   * `EXAM_SIGNING_PRIVATE_KEY`: the key from above.
   * `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`: the first administrator.
   * `SMTP_URL`: your email account, or leave it empty for now.
5. Choose **Apply**.

Render builds for a few minutes. The API's first deploy creates all the tables and the administrator by itself.

The blueprint uses paid plans for the database and the API on purpose: a free database is deleted after a while, and a free API goes to sleep, which would break an exam in progress. You can change plans in the Render dashboard. If Render says a plan name in `render.yaml` is not available, pick the nearest plan in the dashboard.

## Step 2: your addresses

1. In Render, open **examguard-websites**, then **Settings**, **Custom Domains**, and add `invigilator.bakwenasa.co.za`.
2. Open **examguard-api**, the same place, and add `api.bakwenasa.co.za`.
3. Render shows a DNS record for each (a CNAME pointing at an address ending in `onrender.com`). In your domains.co.za DirectAdmin, open **Account Manager**, then **DNS Management**, and add the two CNAME records exactly as Render shows them.
4. Remove the `invigilator` subdomain from DirectAdmin (under Account Manager, Subdomain Management), or DirectAdmin's own record for it will clash with Render's. The folder can stay; it is no longer used.
5. Wait until Render shows both domains as verified with a certificate. That can take from a few minutes to an hour.

If you use different addresses, change the places marked `CHANGE` in `render.yaml` first, and push the change.

## Step 3: create your organisation

The administrator from Step 1 only creates organisations. Create yours once, from a terminal (a Mac has one):

```bash
TOKEN=$(curl -s https://api.bakwenasa.co.za/auth/login -H 'content-type: application/json' \
  -d '{"email":"YOUR ADMIN EMAIL","password":"YOUR ADMIN PASSWORD"}' | sed 's/.*"accessToken":"\([^"]*\)".*/\1/')

curl -s https://api.bakwenasa.co.za/platform/organisations -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"bakwena","name":"Bakwena SA","mode":"employer","owner":{"email":"YOUR EMAIL","displayName":"YOUR NAME","password":"A LONG PASSWORD"}}'
```

Then sign in at `https://invigilator.bakwenasa.co.za/admin/` with the organisation code `bakwena`, your email and that password.

## Step 4: check it works

1. Open `https://invigilator.bakwenasa.co.za/status`. Live video shows "Slower or limited" until a TURN relay is set up, and Email does too while `SMTP_URL` is empty. Everything else should say Working.
2. In the portal, invite yourself as a candidate, accept the email, approve yourself, create a small exam and session, and sit it from the candidate website.
3. On the portal overview, **System health** shows the same checks in more detail.

## Updating

Every push to the branch Render watches rebuilds and redeploys by itself. The API runs any new migrations before the new version starts. Nothing else to do.

## Good to know

* **Recordings** are kept on the API's 20 GB disk. That suits a first deployment with one API instance. For more instances or more space, set up S3 compatible storage and add the `S3_` settings (see `api/.env.example`).
* **Backups:** Render backs up paid databases every day. Test a restore before your first real exam (see `OPERATIONS.md`).
* **Monitoring:** `METRICS_TOKEN` was generated for you; find it under the API's Environment settings if you add monitoring.
* **Live video on strict networks** needs a TURN relay in `ICE_SERVERS`.
* **The desktop app:** set the GitHub repository variable `EXAMGUARD_APP_URL` to `https://invigilator.bakwenasa.co.za` before building installers, so they open your site.
* Your DirectAdmin hosting keeps your main website and email. Render only takes the `invigilator` and `api` addresses.

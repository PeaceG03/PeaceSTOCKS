# Private site (stocks.jjpeace.com)

A read-only status page for the scanner, for one person, on phone or computer.

## What it shows
- **Health**: the latest health check headline and its per-part lines.
- **Catch-up**: the day the scanner has collected through and, if the last scan ran out of time,
  how many market days are still to collect.
- **Latest check-ins**: each part's newest check-in (scan, daily 10-minute step, history chain,
  backfill, gap refill).
- **Picks**: the latest session's prediction sets by symbol, only if any exist. Otherwise it says
  **Predictions off**.
- **Recent sessions**: the newest 20 run reports: session, status, valid/expected, and the first
  few issues.

`/scanner/health`, `/scanner/latest`, `/scanner/latest-success`, `/scanner/last-failure` and
`/scanner/provider-health` still answer JSON behind the same login.

## How it is protected
1. A Cloudflare Access self-hosted app on `stocks.jjpeace.com` with one allow policy whose only rule
   is one email (one-time code by email). The deploy creates or updates both and reads them back; if
   that fails, nothing is deployed.
2. The Worker checks the `Cf-Access-Jwt-Assertion` header on every request (signature against the
   team's Access certs, issuer, AUD, expiry, and the email). No valid token: 403. Missing settings:
   503. Nothing is read from storage before the check passes.
3. No `workers.dev` or preview URL, so the custom domain is the only way in.
4. Storage is read through R2's S3 API with a **read-only** R2 key pair. There is no R2 binding.
   The client refuses every method except GET and HEAD.

## Deploy
Actions → **Site deploy** → Run workflow (`.github/workflows/site-deploy.yml`, manual only).
Input `team_domain` (optional): the Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`.
When blank, it is read from the Access organization (that lookup needs the token permission
Access: Organizations, Identity Providers, and Groups → Read; without it, pass the input).

Repository secrets it needs:
| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account: Workers Scripts Edit, Access: Apps and Policies Edit. Zone jjpeace.com: Workers Routes Edit, DNS Edit |
| `PEACESTOCKS_R2_ACCOUNT_ID` | Cloudflare account id (already used by the scanner) |
| `PEACESTOCKS_R2_BUCKET` | Bucket name (already used by the scanner) |
| `PEACESTOCKS_R2_READ_ACCESS_KEY_ID` | Read-only R2 key (R2 API token with Object Read only) |
| `PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY` | Its secret |
| `PEACESTOCKS_SITE_ALLOWED_EMAIL` | The one email allowed to sign in |

Before the first run, Zero Trust must be set up on the account (a team name), with the
**One-time PIN** login method enabled.

Steps, in order: secret check → site tests → Access app + policy (read back) → `wrangler deploy`
with `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` → Worker secrets → confirm the page redirects to the
Access login and never answers 200 without one.

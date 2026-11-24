# Private site (stocks.jjpeace.com)

A read-only status page for the scanner, for one person, on phone or computer.

## What it shows
- **Health**: the latest health check headline and its per-part lines.
  Under it, **Nightly scan**: the newest scan health record (finished before the open, picks frozen
  on time, names covered, names left out by the eligibility floor and the split guard).
- **Catch-up**: the day the scanner has collected through and, if the last scan ran out of time,
  how many market days are still to collect.
- **Latest check-ins**: each part's newest check-in (scan, daily 10-minute step, history chain,
  backfill, gap refill).
- **Picks**: the latest session's prediction sets by symbol, only if any exist. Otherwise it says
  **Predictions off**. A list stored as unavailable (for example FASTEST_IMPROVING without enough
  price history) says "unavailable" instead of showing an empty list.
  When picks are shown, a note above them and an "experimental" tag on each list say: "Experimental:
  back-tests on held-out data show no reliable edge over random picks. Not investment advice."
  (held-out evaluation in PR #124; see docs/SCANNER.md).
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
Actions → **Site deploy** → Run workflow on **main** (`.github/workflows/site-deploy.yml`, manual only).
- The deploy job runs only when `github.ref` is `refs/heads/main`; from any other branch it is skipped.
- It runs in the GitHub environment **`site`**. GitHub creates the environment on the first run if it
  does not exist yet, with no protection rules ("Running a workflow that references an environment
  that does not exist will create an environment with the referenced name", GitHub Docs, *Managing
  environments for deployment*). Create it yourself first instead, with the main-only rule and the
  secrets in it: see *Before the first run* below.
- Input `team_domain` (required, not secret): defaults to `blue-leaf-13b3.cloudflareaccess.com`. The team
  domain is always passed in, never looked up, so the token needs no Access: Organizations permission.

### Before the first run: the `site` environment (repository admin, once)
Do this before dispatching the deploy, so the deploy secrets are only given to the `site` job on main:
1. Settings → Environments → **New environment** → name it `site` → Configure environment.
2. **Deployment branches and tags** → *Selected branches and tags* → **Add deployment branch rule** →
   Ref type *Branch*, pattern `main`. No other rule. (Optionally also add yourself under
   *Required reviewers*.)
3. Under **Environment secrets**, add these 6, with the same names the workflow reads:
   | Environment secret | Then, at repository level |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | **delete** the repository secret (only site-deploy.yml uses it) |
   | `PEACESTOCKS_SITE_ALLOWED_EMAIL` | **delete** the repository secret (only site-deploy.yml uses it) |
   | `PEACESTOCKS_R2_READ_ACCESS_KEY_ID` | **delete** the repository secret (only site-deploy.yml uses it) |
   | `PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY` | **delete** the repository secret (only site-deploy.yml uses it) |
   | `PEACESTOCKS_R2_ACCOUNT_ID` | **keep** the repository secret: scanner.yml, gap-refill.yml, health.yml, net-rerun.yml and oct2024-tenmin.yml read it |
   | `PEACESTOCKS_R2_BUCKET` | **keep** the repository secret: the same scanner workflows read it |

   So the four site-only secrets are moved into `site`, and the two shared ones are copied into it.
   Moving the shared two would break the live scanner. An environment secret takes precedence over a
   repository secret with the same name for jobs in that environment.
4. For `PEACESTOCKS_R2_READ_ACCESS_KEY_ID` / `PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY`, use a **fresh
   site-only R2 API token: Object Read only, on the `peacestocks` bucket only**. Create it in R2 → Manage
   API tokens. Do not reuse the box's `R2_READ_*` pair (its scope is unverified), and never use the writer key.

### Cloudflare API token (`CLOUDFLARE_API_TOKEN`)
Needed:
| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | upload and deploy the Worker, set its secrets |
| Account | Access: Apps and Policies: Edit | create/update the Access app and its policy |
| Zone jjpeace.com | Workers Routes: Edit | attach the `stocks.jjpeace.com` custom domain |

- **Access: Apps and Policies: Edit is account-wide Zero Trust write.** It can create, change or delete
  *any* Access application and policy on the account, not just this site's. The setup needs it because
  the protection is itself an Access application plus an allow policy, and the deploy creates or
  updates them and reads them back before the Worker is deployed. Treat the token accordingly: it
  lives only in this repository secret and is used only by this manual job on main.
- **DNS: Edit is not needed.** Cloudflare's Workers docs say adding or changing a Custom Domain needs
  Editor on the Worker plus Zone → Workers Routes → Write for the zone ("API tokens need Zone >
  Workers Routes > Write, scoped to each affected zone", *Workers roles and permissions*, Routes and
  Custom Domains), and that Cloudflare creates the DNS record for the custom domain itself
  (*Custom Domains*: "After you have added the domain or subdomain, Cloudflare will create a new DNS
  record for you"). The token in use today also has DNS Edit on jjpeace.com; it can be removed.
- **Creating the Worker the first time** may need more than Edit: the same page says creating a new
  Worker needs product-level Workers Admin, while Editor (what Workers Scripts Edit maps to) "cannot
  create or delete Workers". Legacy Workers Scripts Edit tokens are documented as still working as
  before. If the first deploy fails creating `peacestocks-read`, give the token Workers Admin (or
  create the Worker once in the dashboard), then run again.

### Read-only R2 key (`PEACESTOCKS_R2_READ_ACCESS_KEY_ID` / `PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY`)
Use a **dedicated R2 API token with Object Read only, scoped to the `peacestocks` bucket**. Never the
scanner's writer key (`PEACESTOCKS_R2_ACCESS_KEY_ID` / `PEACESTOCKS_R2_SECRET_ACCESS_KEY`).
Right now the repository secrets hold the box's `R2_READ_*` pair, **whose scope has not been
verified** (it may be broader than one bucket or not read-only). The pair put into the `site`
environment must be a **fresh site-only Object Read token on the `peacestocks` bucket**, used for
nothing else. The Worker also refuses to send anything but GET/HEAD, but the key's own scope is the
real limit.

### All secrets it reads (environment `site`, see above)
| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token above |
| `PEACESTOCKS_R2_ACCOUNT_ID` | Cloudflare account id (already used by the scanner) |
| `PEACESTOCKS_R2_BUCKET` | bucket name (already used by the scanner) |
| `PEACESTOCKS_R2_READ_ACCESS_KEY_ID` | read-only R2 key, see above |
| `PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY` | its secret |
| `PEACESTOCKS_SITE_ALLOWED_EMAIL` | the one email allowed to sign in |

Before the first run, Zero Trust must be set up on the account (team `blue-leaf-13b3`), with the
**One-time PIN** login method enabled.

Steps, in order: secret check → site tests → Access app + policy (read back) → `wrangler deploy`
with `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` → Worker secrets → confirm the page redirects to the
Access login and never answers 200 without one.

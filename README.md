# Andrew's Work

Project tracker (kanban, activity log, time clock, notebook) plus a
GA4-backed "Tool Performance" analytics page, served from a single
Cloudflare Worker with two pages: `/` (Tasks) and `/analytics`.

Deploying via this repo (rather than pasting into the Cloudflare dashboard's
web editor) avoids the editor silently corrupting the long base64 profile
image string.

## 1. Install

```bash
npm install
npx wrangler login
```

## 2. Create the two KV namespaces

```bash
npx wrangler kv namespace create SITE_DATA
npx wrangler kv namespace create TOKEN_CACHE
```

Each command prints an `id`. Open `wrangler.jsonc` and paste those ids into
the matching `kv_namespaces` entries.

## 3. Set secrets

These are set directly on Cloudflare (never committed to the repo):

```bash
npx wrangler secret put ADMIN_PASSCODE
npx wrangler secret put TEAM_PASSCODE
npx wrangler secret put GA4_SERVICE_ACCOUNT_KEY
npx wrangler secret put OPENAI_API_KEY
```

- `ADMIN_PASSCODE` / `TEAM_PASSCODE` — the 4-digit PINs for the Tasks page.
  Owner passcode vs. team (view-only) passcode.
- `GA4_SERVICE_ACCOUNT_KEY` — paste the **entire contents** of your GA4
  service account JSON key file as one value.
- `OPENAI_API_KEY` — used only when someone clicks "Analyze with AI" on the
  Analytics page.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in
real values there instead (already gitignored).

## 4. Non-secret config

In `wrangler.jsonc`:

- `vars.GA4_PROPERTY_ID` — your GA4 property ID (not sensitive, fine as a
  plain var).
- `vars.TOOL_LAUNCH_DATE` — the date the Write with Us tool launched
  (`YYYY-MM-DD`), used to draw the launch marker and before/after comparison.
- `routes` — set this to your real domain once it's on Cloudflare. Remove
  the block if you want to test on the `*.workers.dev` URL first, but note
  Cloudflare Access (step 6) can't protect that URL — only a custom domain.

## 5. Deploy

```bash
npm run deploy
```

Visit `/` — you should see the profile landing page. Triple-tap spacebar
(or the touch swipe gesture) to reveal the unlock prompt, enter your admin
passcode.

## 6. Protect `/analytics` with Cloudflare Access

The Analytics page has no passcode of its own — it relies entirely on
Cloudflare Access sitting in front of it. Without this step, `/analytics`
will show an "Access required" message and never load data.

1. Cloudflare dashboard → **Zero Trust** → (pick a team name if this is
   your first time).
2. **Access → Applications → Add an application → Self-hosted.**
3. Add **two** path rules under the same application (or two separate
   applications) on your real domain:
   - `yourdomain.com/analytics*`
   - `yourdomain.com/api/analytics*`
4. Add a policy: **Action: Allow**, **Include: Emails** — list the exact
   addresses allowed in (or **Email domain** for something like
   `@elon.edu`). Leave the identity provider as **One-time PIN** unless you
   want to wire up Google/Microsoft login instead.
5. Save, then test in an incognito window at `yourdomain.com/analytics` —
   you should hit Cloudflare's login screen before the page ever loads.

## Notes

- The Tasks page (`/`) login is rate-limited to 3 attempts per 4 hours per
  IP, and tokens expire after 30 days.
- The Analytics page trusts the `Cf-Access-Authenticated-User-Email` header
  Cloudflare adds after a successful Access login. If that header is
  missing, the API refuses to serve data — this is what stops someone from
  bypassing Access via a direct URL.

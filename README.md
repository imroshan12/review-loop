# ReviewLoop

One inbox for App Store and Google Play reviews. AI drafts replies in the developer's voice. Reviews reporting the same bug are grouped into **issues**, ranked by the stars they cost. When a fix ships, ReviewLoop drafts a follow-up for every reviewer in the issue, so they can update their rating, and it counts every rating that goes up.

What sets it apart from other review tools:

- **Issues ranked by stars lost**, with a recovery forecast based on how often followed-up reviewers actually raised their rating.
- **Follow-ups triggered by releases**: the moment a version ships, everyone its fixes affect gets a drafted follow-up.
- **Drafts that learn from outcomes**: the AI sees the developer's past replies that led to a raised rating.
- **Release Guard**: an alert when a release sets off a wave of 1–2★ reviews, while there's still time to halt the rollout.
- **Promise tracker**: a reminder when reviewers were told a fix is coming and it hasn't shipped.
- **Public fix log and README badge** per app ("fixed from reviews: 12 fixed"), which every user's README links back to.
- **Peer benchmarks** that unlock as more apps join, so the product gets more useful with scale.

- **Stack:** Cloudflare Workers + D1 (SQLite) + Cron Triggers, [Hono](https://hono.dev) with server-rendered JSX, a small vanilla JS file. No build step for the frontend.
- **Sign-in:** GitHub OAuth.
- **Payments:** [Dodo Payments](https://dodopayments.com) (merchant of record, works for sellers in India, pays out to an Indian bank account).
- **AI:** Claude via the official Anthropic SDK.

## What it costs to run

| Item | Cost |
| --- | --- |
| Cloudflare Workers, D1, cron | Free tier to start. Move to Workers Paid ($5/month) once you have paying users (see Limits). |
| Domain | Optional. Start on `reviewloop.<you>.workers.dev`; a domain is roughly ₹800–1,000/year. |
| GitHub sign-in | Free |
| Claude API | Pay per use. With `claude-opus-5` at low effort a draft costs roughly $0.01–0.02 (about ₹1). Setting `AI_MODEL` to `claude-haiku-4-5` cuts that about 5x (test a few drafts after switching). Daily caps bound the bill: with the defaults, free users can't cost more than about ₹3,000 a month. |
| Dodo Payments | On international cards, 6% + 40¢ per payment (4% + 40¢, +1.5% international card, +0.5% subscription): about 14% of a $5 Plus payment and 10% of a $10 Pro payment. No monthly fee. |
| Email alerts (optional) | Resend free tier: 3,000 emails/month. |

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then set ENCRYPTION_KEY (openssl rand -base64 32) and keep DEV_LOGIN=true
npm run db:migrate:local
npm run dev
```

Open http://localhost:8787, click **Start free**, then **Continue as the local dev account**. With `DEV_LOGIN=true` that signs you in as a local test user, with no GitHub app needed. Click **Try with sample reviews** to walk through the whole loop:

1. Reply to a review (sample apps don't post anywhere).
2. On the "Timer stops when I lock my phone" review, open **Mark fix pending**, add a note and a version like 2.3.1, and save. That starts an issue.
3. Two other reviews report the same bug: their **Mark fix pending** form already suggests the issue. Or open the issue from **Issues** and use **Add to issue** under "Similar reviews".
4. On **Releases**, mark 2.3.1 as shipped. Every reviewer in the issue gets a drafted follow-up, and a "What's New" draft appears.
5. Send them, then click **Check for new reviews**. The sample reviewers raise their rating and the win appears on the inbox.

Public fix logs only work for real store apps, so the sample apps can't publish one.

AI drafts need `ANTHROPIC_API_KEY` in `.dev.vars`; without it the button explains what's missing.

To test the cron job locally: `npx wrangler dev --test-scheduled`, then open http://localhost:8787/__scheduled.

## Deploy

1. Log in and create the database:

   ```bash
   npx wrangler login
   npx wrangler d1 create reviewloop
   ```

   Put the printed `database_id` into `wrangler.jsonc`, then apply the schema (all files in `migrations/`, in order; run it again after every update):

   ```bash
   npm run db:migrate:remote
   ```

2. In `wrangler.jsonc`, set:
   - `APP_URL` to your public URL, for example `https://reviewloop.<you>.workers.dev`;
   - `SUPPORT_EMAIL`;
   - `ADMIN_GITHUB_LOGINS` to your GitHub username, which opens the founder dashboard at `/admin`. After your first sign-in, the dashboard shows your numeric GitHub id: put it in `ADMIN_GITHUB_IDS` and redeploy. Ids can't be taken over the way a renamed username can.

   Leave `DEV_LOGIN` as `"false"`. Dev login only works on `http://localhost`, even if the flag is set. All settings are listed under **Settings reference**.

   The `ratelimits` block uses Cloudflare's rate limiting binding. If `wrangler deploy` rejects it on your plan, delete the block: the app falls back to a per-instance limiter, which is weaker because each Cloudflare location counts separately.

3. Create a GitHub OAuth app at github.com/settings/developers. Homepage URL is your `APP_URL`; callback URL is `<APP_URL>/auth/github/callback`.

4. In Dodo Payments:
   - Create two subscription products: "ReviewLoop Plus" at $5/month and "ReviewLoop Pro" at $10/month.
   - Create an API key.
   - Add a webhook pointing to `<APP_URL>/webhooks/dodo` with the `subscription.*` events.
   - Start with `DODO_MODE: "test"`, then switch it to `"live"` once test payments work.

5. Set the secrets, one command each:

   ```bash
   npx wrangler secret put ENCRYPTION_KEY        # openssl rand -base64 32. Keep a copy in your password manager.
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put DODO_API_KEY
   npx wrangler secret put DODO_WEBHOOK_SECRET
   npx wrangler secret put DODO_PLUS_PRODUCT_ID  # the Plus product's id
   npx wrangler secret put DODO_PRO_PRODUCT_ID   # the Pro product's id
   # optional email alerts
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put EMAIL_FROM            # "ReviewLoop <alerts@yourdomain.com>"
   ```

6. Deploy:

   ```bash
   npm run deploy
   ```

7. Before taking real money, edit the Privacy, Terms and Refunds pages in `src/views/legal.tsx` with your name or business details. Dodo checks these pages when approving your account.

### Rotating the encryption key

Do this if `ENCRYPTION_KEY` may have leaked, or once a year as routine. Nothing goes offline.

1. `npx wrangler secret put ENCRYPTION_KEY_PREVIOUS` with the **current** key.
2. `npx wrangler secret put ENCRYPTION_KEY` with a new one (`openssl rand -base64 32`).
3. Every 30 minutes the cron job re-encrypts a batch of store keys and webhook URLs with the new key. The founder dashboard shows how many are left.
4. When it says the rotation is finished: `npx wrangler secret delete ENCRYPTION_KEY_PREVIOUS`.

If the key leaked, also ask users to create new store keys: the old ciphertext may have been copied along with it.

## How it works

| Piece | Where |
| --- | --- |
| Routes, security middleware, cron entry point | `src/index.tsx` |
| Sessions, GitHub OAuth, fresh sign-in checks | `src/auth.ts` |
| App Store Connect client (ES256 JWT, reviews, responses, live version) | `src/stores/apple.ts` |
| Google Play client (service account JWT, reviews, replies) | `src/stores/google.ts` |
| Sync, release detection, follow-ups, replies, cron work | `src/services/reviews.ts` |
| Issues: grouping, similar reviews, recovery forecast, release notes | `src/services/issues.ts`, `src/queries/issues.ts` |
| Insights and peer benchmarks | `src/services/insights.ts`, `src/queries/insights.ts` |
| Release Guard and promise tracker | `src/services/guard.ts` |
| Public fix log slugs and badge | `src/services/publiclog.ts` |
| Encryption key rotation | `src/services/rotation.ts`, `src/lib/secrets.ts` |
| Rate limits, headers, reply safety check, text similarity | `src/lib/ratelimit.ts`, `src/lib/security.ts`, `src/lib/safety.ts`, `src/lib/similarity.ts` |
| Security log | `src/queries/audit.ts` |
| Connecting stores, sample workspace | `src/services/connect.ts` |
| Claude drafts (structured output, refusal handling) | `src/services/ai.ts` |
| Dodo checkout, portal, webhooks | `src/services/billing.ts` |
| Schema | `migrations/*.sql` |

- **Release detection.** App Store versions come from App Store Connect, when the key's role can read them. Google Play versions are inferred from the app version reviewers are on. You can always mark a release by hand.
- **Issues.** "Mark fix pending" puts a review into an issue: a new one, or an open one from the same app (the most similar is preselected, using keyword overlap, so it costs nothing and works in any language). An issue ships as a unit when a release reaches its target version, or with the next release if it has none.
- **Plans.** Free, Plus and Pro limits live in one place, `planDetails` in `src/env.ts`. Each store listing counts as one app, so Plus (2 apps) covers one app on both stores. Subscribers switch plans on their existing subscription, never a second one: upgrades start at once and charge the difference (and don't happen if that payment fails); downgrades are booked for the next billing date, shown in Settings with a **Keep** button. The Dodo webhook maps the subscription's product to a plan, ignores products it doesn't know, never lets an old subscription's ending cancel a newer one, and flags a duplicate subscription in the security log.
- **Follow-ups.** A release turns every review in a shipped issue into a follow-up. The cron job then upgrades the template text to an AI draft within the user's monthly quota. Follow-ups wait for approval unless a Pro user turns on automatic sending, and even then any draft with a link, email address, phone number or rating request is held for a person to read.
- **Release Guard.** For 72 hours after each release, the cron job compares the share of new 1–2★ reviews with the two weeks before. At least 5 low ratings and twice the usual share sends one alert per release.
- **Promise tracker.** If reviewers were told a fix is coming (replied to and in an issue) more than `PROMISE_DAYS` ago and it hasn't shipped, the developer gets one reminder.
- **Public fix log.** Opt-in per real store app: `/fixed/<slug>` lists shipped issues with counts, and `/badge/<slug>.svg` is a README badge. Slugs carry a random suffix, so pages can't be enumerated.
- **Benchmarks.** Once a day the cron job computes reply rates and rating-raise rates across all real stores. They stay hidden until `BENCHMARK_MIN_APPS` apps contribute, so no single app can be identified.
- **Wins.** When a reviewer we replied to raises their rating, the review records `rating_before` and `rating_raised_at`, and the inbox shows the total.
- **Setup guides.** `/guide/app-store` and `/guide/google-play` walk through creating each key, with illustrations (`public/guides/*.svg`) and fixes for common errors. They're public, so they also work as search-friendly content. To use real screenshots instead, replace the SVG files; the pages reference them by name. When a connection breaks, the same guide opens in update mode (`?connection=<id>`), which swaps the key and keeps apps, reviews and replies.
- **Broken keys.** Failing connections back off instead of retrying every run. Problems the user must fix (revoked key, missing permission, unknown app) start at 6 hours; outages start at 30 minutes. Both cap at a day. The user is alerted once, right away for key problems and after about a day of outages. Manual "Check for new reviews" ignores the backoff.
- **AI spending cap.** Every draft first reserves a slot in today's counters (`ai_daily`), atomically, and gives it back if the call fails. Free users share `FREE_AI_DAILY_CAP`; everyone shares `AI_DAILY_CAP`. Real token usage is recorded for the dashboard's cost estimate.
- **Founder dashboard.** `/admin` shows paying developers against the ₹10,000 goal, the signup funnel, activity on real stores, AI usage and cost, failing connections, key rotation progress and recent signups. It returns 404 for everyone except the admins, and asks for a fresh sign-in if the session is older than 12 hours.
- **Housekeeping.** The cron job deletes expired sessions, webhook records older than 90 days, security log entries older than 180 days, and AI usage rows older than about 13 months.

AI requests use `claude-opus-5` with `fallbacks: "default"` (server-side refusal fallback), low effort and a JSON schema. Refusals and truncated output become a readable message instead of a broken draft.

## Design

- **Tokens** live at the top of `public/app.css`: zinc neutrals with one accent, star amber, in light and dark (the page follows the visitor's system setting). Use `--accent` for fills and `--accent-text` for amber text; the plain accent is too light for text on white. One radius scale: 10px for controls, 16px for containers, fully round for chips.
- **Type** is Geist and Geist Mono, self-hosted from `public/fonts` (SIL Open Font License, included). Fonts are cached for a year, so give a new font file a new name.
- **Icons** come from Phosphor. Add a name to the list in `scripts/icons.mjs` and run `npm run icons`, then use `<Icon name="..." />`. Don't draw icons by hand.
- **Product screenshots** on the landing page are real captures of the app, in both themes, made by `npm run screenshots` with the dev server running (`DEV_LOGIN=true`). It uses an installed Chromium browser (Brave by default; set `CHROME_PATH` for Chrome). Set the sample workspace up to show what each shot needs first; the list of shots and what they show is at the top of `scripts/screenshots.mjs`. Phones get the half-size `-1x.webp` copies through `srcset`.
- **Motion** is CSS only: the hero enters in reading order, and sections fade in with scroll-driven animations where the browser supports them. Everything is still for visitors who turn on reduced motion.

## Settings reference

Plain settings live in `vars` in `wrangler.jsonc`; secrets are set with `npx wrangler secret put`. For local development, `.dev.vars` overrides both.

| Setting | Default | What it does |
| --- | --- | --- |
| `APP_URL` | `http://localhost:8787` | Public URL, used in links, emails and OAuth callbacks |
| `SUPPORT_EMAIL` | `support@example.com` | Shown on the legal pages and the footer |
| `ADMIN_GITHUB_IDS` | empty | Numeric GitHub ids (comma-separated) that can open `/admin`. When set, usernames are ignored |
| `ADMIN_GITHUB_LOGINS` | empty | GitHub usernames that can open `/admin`, used only while `ADMIN_GITHUB_IDS` is empty |
| `BENCHMARK_MIN_APPS` | `10` | Apps that must contribute before peer benchmarks are shown |
| `PROMISE_DAYS` | `14` | Days after telling reviewers about a fix before the promise tracker reminds you |
| `AI_MODEL` | `claude-opus-5` | Model for drafts. `claude-haiku-4-5` is about 5x cheaper |
| `FREE_AI_DRAFTS_PER_MONTH` | `20` | Monthly drafts per free user |
| `PLUS_AI_DRAFTS_PER_MONTH` | `100` | Monthly drafts per Plus user |
| `PRO_AI_DRAFTS_PER_MONTH` | `500` | Monthly drafts per Pro user |
| `FREE_AI_DAILY_CAP` | `100` | Drafts per UTC day across all free users. `0` turns free drafts off |
| `AI_DAILY_CAP` | `1000` | Drafts per UTC day across everyone, as a safety limit |
| `FREE_APP_LIMIT` | `1` | Store listings a free user can track |
| `PLUS_APP_LIMIT` | `2` | Store listings a Plus user can track (one app on both stores). Pro is unlimited |
| `PLUS_PRICE_LABEL` / `PLUS_PRICE_USD` | `$5/month` / `5` | Plus price shown on pages / used for the dashboard's revenue. The price charged is set on the Dodo product |
| `PRO_PRICE_LABEL` / `PRO_PRICE_USD` | `$10/month` / `10` | Same for Pro |
| `DODO_PLUS_PRODUCT_ID` / `DODO_PRO_PRODUCT_ID` (secrets) | unset | Dodo product ids. Comma-separate several to recognize, say, a launch-price product too; the first is sold at checkout |
| `DODO_MODE` | `test` | `test` or `live` Dodo Payments environment |
| `DEV_LOGIN` | `false` | Local-only test sign-in; ignored unless the app runs on `http://localhost` |
| `ENCRYPTION_KEY_PREVIOUS` (secret) | unset | Only during a key rotation: the old key, still used to read data until it's re-encrypted |

## Security

What's in place:

- **Secrets at rest.** Store keys and webhook URLs are encrypted with AES-256-GCM before they reach the database. Each value records which key sealed it, so the key can be rotated without downtime (see **Rotating the encryption key**).
- **Sessions.** Random 256-bit tokens, stored only as SHA-256 hashes. Cookies are HttpOnly, SameSite=Lax, and `__Host-` prefixed on https, so a sibling subdomain can't plant one. Every sign-in replaces the browser's previous session. Users can sign out everywhere from Settings.
- **Sign-in.** GitHub OAuth with a state cookie; there are no passwords to steal. After sign-in, only same-site paths are followed (no open redirects). Settings warns users whose GitHub account has no two-factor authentication.
- **Sensitive actions.** The founder dashboard and account deletion need a sign-in from the last 12 hours. This re-runs GitHub sign-in: it proves a live GitHub session in the browser, not a fresh password entry (GitHub skips the prompt for apps you've already authorized).
- **Request forgery.** Every state-changing request must come from the app's own origin, the JSON API only accepts `application/json`, and bodies over 64 KB are refused.
- **Rate limits.** Per network: sign-in 20/min, writes 60/min, pages 120/min, webhooks 60/min; per account: AI drafts 12/min.
- **Headers.** A strict Content-Security-Policy (no inline scripts, no framing), HSTS on https, COOP/CORP, `nosniff`, Permissions-Policy. Signed-in pages are `no-store` and `noindex`. Badges are sandboxed SVGs. `/.well-known/security.txt` tells researchers where to report problems.
- **Security log.** Sign-ins, sign-outs, store key changes, alert webhook changes, public log changes, plan changes and dashboard visits are recorded per account with device, country and a keyed hash of the IP (never the IP itself), and shown in Settings.
- **Untrusted text.** Review text is fenced off in AI prompts, and quoted reviews are made inert in Slack (escaped) and Discord (markdown escaped, mentions disabled).
- **Webhooks.** Dodo webhooks are verified with Standard Webhooks signatures and de-duplicated.

What no code can promise: that it can't be hacked. The biggest remaining risks are outside this codebase: a compromised GitHub account of the founder, a leaked `wrangler` login or Cloudflare account, and a leaked `ENCRYPTION_KEY`. Turn on two-factor authentication for GitHub, Cloudflare and Dodo, lock `/admin` to your numeric GitHub id, and run `npm audit` before each deploy.

## Tests

```bash
npm test          # store clients and signing, encryption and key rotation, security headers, CSRF, rate limits,
                  # open redirects, alert escaping, reply safety, issue grouping, Release Guard, forecasts, badges
npm run typecheck
```

## Limits and scaling

The Workers free plan allows 50 outbound requests and 10 ms CPU per invocation. The cron job processes up to 10 connections per run within a 40-request budget, and syncs the least recently checked first. That's comfortable for your first few dozen users. Once people are paying:

- move to Workers Paid ($5/month) for 1,000 subrequests and 30 s CPU per invocation;
- raise `CRON_CONNECTIONS` and `CRON_REQUEST_BUDGET` in `src/services/reviews.ts`, or run the cron every 15 minutes.

## Ideas for later

Ideas users will ask for:
- Telegram alerts
- Reply templates
- Translation of reviews
- Team seats
- An iOS widget for new low-star reviews
- A "reply to all praise" batch action
- Weekly email digest with ratings trend

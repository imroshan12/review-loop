import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  devLogin,
  endSession,
  finishGithubLogin,
  githubAuthorizeUrl,
  githubConfigured,
  isRecentSignIn,
  loadSession,
  SignInError,
  startSession,
  takeNextPath,
  type AppContext,
  type AppVariables,
} from "./auth";
import * as db from "./db";
import type { Bindings, InboxReview, UserRow } from "./env";
import { guidePath, isAdmin, planDetails, userPlan } from "./env";
import { allowRequest, type Bucket } from "./lib/ratelimit";
import { encryptOptional } from "./lib/secrets";
import { contentSecurityPolicy, describeUserAgent, hashIp, safeNextPath } from "./lib/security";
import { currentMonth } from "./lib/util";
import { logEvent, recentEvents, type AuditEvent } from "./queries/audit";
import { appLoopMetrics } from "./queries/insights";
import * as issuesDb from "./queries/issues";
import { estimateCostUsd } from "./services/ai";
import {
  billingConfigured,
  cancelScheduledChange,
  changePlan,
  createCheckout,
  createPortalLink,
  handleBillingWebhook,
  isPaidPlan,
} from "./services/billing";
import { connectApple, connectDemo, connectGoogle, syncNow, type ConnectResult } from "./services/connect";
import { cachedBenchmarks, forecastBasisFor, refreshBenchmarksIfStale, summarize } from "./services/insights";
import { addReviewsToIssue, linkReviewToIssue, similarReviews, unlinkReview, VERSION_PATTERN, whatsNewText } from "./services/issues";
import { badgeSvg, makeSlug, SLUG_PATTERN } from "./services/publiclog";
import { rotationStatus } from "./services/rotation";
import {
  appLimitFor,
  dailyAiCaps,
  draftForReview,
  draftLimitFor,
  handleRelease,
  runScheduledWork,
  sendAllFollowups,
  sendReply,
  UserFacingError,
} from "./services/reviews";
import { AdminPage } from "./views/admin";
import { AppsPage } from "./views/apps";
import { ConnectPage } from "./views/connect";
import { AppStoreGuide, GooglePlayGuide } from "./views/guides";
import { InboxPage, PAGE_SIZE } from "./views/inbox";
import { InsightsPage } from "./views/insights";
import { IssueDetailPage, IssuesPage } from "./views/issues";
import { LandingPage } from "./views/landing";
import type { Flash } from "./views/layout";
import { MessagePage, PrivacyPage, RefundsPage, TermsPage } from "./views/legal";
import { PublicFixLogPage } from "./views/public";
import { ReleasesPage } from "./views/releases";
import { ReviewCard, type IssueOption } from "./views/review-card";
import { SettingsPage } from "./views/settings";
import { SignupPage } from "./views/signup";

type AppEnv = { Bindings: Bindings; Variables: AppVariables };

const app = new Hono<AppEnv>();

const DAY = 24 * 3600 * 1000;

// ---------- middleware ----------

// Security headers on every response, including errors and rate-limit replies.
app.use("*", async (c, next) => {
  await next();
  const https = new URL(c.req.url).protocol === "https:";
  // Badges are embedded by other sites, so they may be loaded cross-origin, but can't run or load anything.
  const badge = c.req.path.startsWith("/badge/");
  c.header("Content-Security-Policy", badge ? "default-src 'none'; sandbox" : contentSecurityPolicy(https));
  c.header("Cross-Origin-Resource-Policy", badge ? "cross-origin" : "same-origin");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (https) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  const user = c.get("user");
  // Signed-in pages, API answers and anything setting a cookie must never be kept by a browser or proxy cache.
  if ((user || c.req.path.startsWith("/api/") || c.res.headers.has("Set-Cookie")) && !c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "private, no-store");
  }
  if (user) c.header("X-Robots-Tag", "noindex");
});

function clientIp(c: AppContext): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

function bucketFor(method: string, path: string): Bucket {
  if (path.startsWith("/webhooks/")) return "webhook";
  if (path.startsWith("/auth/") || path === "/login" || path === "/signup") return "auth";
  return method === "GET" || method === "HEAD" ? "public" : "write";
}

function tooManyRequests(c: AppContext) {
  c.header("Retry-After", "60");
  const path = c.req.path;
  if (path.startsWith("/api/")) return c.json({ error: "Too many requests. Wait a minute, then try again." }, 429);
  if (path.startsWith("/webhooks/") || path.startsWith("/badge/")) return c.body(null, 429);
  return c.html(
    <MessagePage
      env={c.env}
      user={null}
      title="Slow down a little"
      message="Too many requests came from your network. Wait a minute, then try again."
    />,
    429,
  );
}

// Per-network limits run before anything touches the database.
app.use("*", async (c, next) => {
  if (!(await allowRequest(c.env, bucketFor(c.req.method, c.req.path), clientIp(c)))) return tooManyRequests(c);
  await next();
});

// Nothing legitimate is bigger than a few kilobytes (the largest is a Google service-account key).
app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("That request is too large.", 413) }));

// Cookie-authenticated writes must come from our own pages.
app.use("*", async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && !c.req.path.startsWith("/webhooks/")) {
    const expected = new URL(c.req.url).origin;
    const origin = c.req.header("Origin") ?? originOf(c.req.header("Referer"));
    if (origin !== expected) return c.text("Cross-site request blocked.", 403);
  }
  await next();
});

// The JSON API only accepts JSON, which another site can't send without a CORS preflight (never granted).
app.use("/api/*", async (c, next) => {
  if (c.req.method === "POST" && !/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) {
    return c.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
});

// Public and machine endpoints never read the session cookie.
const SESSIONLESS = ["/webhooks/", "/badge/", "/fixed/"];

app.use("*", async (c, next) => {
  const session = SESSIONLESS.some((prefix) => c.req.path.startsWith(prefix)) ? null : await loadSession(c);
  c.set("user", session?.user ?? null);
  c.set("sessionCreatedAt", session?.sessionCreatedAt ?? null);
  await next();
});

// AI drafts cost money on every call, so each account gets its own tighter limit.
const aiLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user && !(await allowRequest(c.env, "ai", user.id))) return tooManyRequests(c);
  await next();
};
app.use("/api/reviews/:id/draft", aiLimit);
app.use("/api/reviews/:id/followup-draft", aiLimit);

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// ---------- helpers ----------

/** Only shows flash text after our own redirects, so crafted links can't put words on the page. */
function flashFrom(c: AppContext): Flash | null {
  if (originOf(c.req.header("Referer")) !== new URL(c.req.url).origin) return null;
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  if (err) return { kind: "error", text: err.slice(0, 300) };
  if (ok) return { kind: "ok", text: ok.slice(0, 300) };
  return null;
}

function redirectWith(c: AppContext, path: string, kind: "ok" | "err", text: string) {
  // The message goes in the query string, which must come before any #anchor.
  const [base, anchor] = path.split("#");
  const query = `${base.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`;
  return c.redirect(`${base}${query}${anchor ? `#${anchor}` : ""}`, 303);
}

function requireUser(c: AppContext): UserRow | null {
  return c.get("user");
}

/** Sends a signed-out visitor to sign in, then back to the page they asked for. */
function signInFirst(c: AppContext) {
  const url = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
}

/** Sensitive pages ask for a fresh sign-in, then continue to `next`. */
function confirmItsYou(c: AppContext, next: string) {
  return c.redirect(`/login?reauth=1&next=${encodeURIComponent(next)}`, 303);
}

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}

/** A string from a parsed JSON body; anything else (numbers, objects, arrays) becomes "". */
function text(value: unknown, max = 10_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  console.error(error);
  return "Something went wrong. Please try again.";
}

function errorStatus(error: unknown) {
  return error instanceof UserFacingError ? error.status : 500;
}

async function renderCard(review: InboxReview, issues: IssueOption[]): Promise<string> {
  return (await (<ReviewCard review={review} issues={issues} />).toString()) as string;
}

/** Wraps a JSON API handler: requires a user and the review, and maps errors to JSON. */
function reviewApi(
  handler: (c: AppContext, user: UserRow, review: InboxReview) => Promise<{ message?: string } | void>,
) {
  return async (c: AppContext) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: "Your session expired. Sign in again." }, 401);
    const review = await db.getInboxReview(c.env.DB, user.id, c.req.param("id") ?? "");
    if (!review) return c.json({ error: "That review no longer exists." }, 404);
    try {
      const result = await handler(c, user, review);
      const [fresh, issues] = await Promise.all([
        db.getInboxReview(c.env.DB, user.id, review.id),
        issuesDb.openIssues(c.env.DB, user.id),
      ]);
      return c.json({ html: fresh ? await renderCard(fresh, issues) : null, message: result?.message ?? null });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  };
}

async function readJson<T>(c: AppContext): Promise<Partial<T>> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** Records a security event for the account's activity log. Never blocks the action it describes. */
async function audit(c: AppContext, userId: string, event: AuditEvent, detail?: string | null): Promise<void> {
  try {
    const ip = c.req.header("CF-Connecting-IP");
    const country = c.req.raw.cf?.country;
    await logEvent(c.env.DB, {
      userId,
      event,
      detail: detail ?? null,
      ipHash: ip ? await hashIp(c.env.ENCRYPTION_KEY, ip) : null,
      country: typeof country === "string" ? country : null,
      userAgent: describeUserAgent(c.req.header("User-Agent")),
    });
  } catch (error) {
    console.warn(`audit ${event} failed:`, error instanceof Error ? error.message : String(error));
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The dev account only works on a local http server, even if DEV_LOGIN leaks into a real deployment. */
function devLoginAllowed(c: AppContext): boolean {
  return c.env.DEV_LOGIN === "true" && !c.env.APP_URL.startsWith("https://") && LOCAL_HOSTS.has(new URL(c.req.url).hostname);
}

// ---------- public pages & auth ----------

app.get("/", (c) => {
  if (c.get("user")) return c.redirect("/inbox");
  return c.html(<LandingPage env={c.env} flash={flashFrom(c)} />);
});

app.get("/healthz", (c) => c.text("ok"));

// RFC 9116: how security researchers reach us.
app.get("/.well-known/security.txt", (c) => {
  c.header("Cache-Control", "public, max-age=86400");
  return c.text(
    [
      `Contact: mailto:${c.env.SUPPORT_EMAIL}`,
      `Expires: ${new Date(Date.now() + 180 * DAY).toISOString()}`,
      "Preferred-Languages: en",
      `Canonical: ${c.env.APP_URL}/.well-known/security.txt`,
      "",
    ].join("\n"),
  );
});

const REAUTH_FLASH: Flash = { kind: "info", text: "For your security, confirm it's you before continuing." };

function authPage(c: AppContext, mode: "signup" | "signin") {
  const next = safeNextPath(c.req.query("next"));
  const reauth = c.req.query("reauth") === "1" && Boolean(c.get("user"));
  if (c.get("user") && !reauth) return c.redirect(next ?? "/inbox");
  return c.html(
    <SignupPage env={c.env} mode={mode} next={next} flash={reauth ? REAUTH_FLASH : flashFrom(c)} devLogin={devLoginAllowed(c)} />,
  );
}

app.get("/signup", (c) => authPage(c, "signup"));
app.get("/login", (c) => authPage(c, "signin"));

// Always starts a new sign-in, even when signed in: that's how sensitive pages confirm it's you.
app.get("/auth/github", async (c) => {
  const next = safeNextPath(c.req.query("next"));
  if (devLoginAllowed(c)) {
    const user = await devLogin(c);
    await startSession(c, user.id);
    await audit(c, user.id, "sign_in", "Local dev account");
    return c.redirect(next ?? "/inbox");
  }
  if (!githubConfigured(c.env)) {
    return c.html(
      <MessagePage env={c.env} user={null} title="Sign-in isn't set up" message="Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable GitHub sign-in." />,
      503,
    );
  }
  return c.redirect(githubAuthorizeUrl(c, next));
});

app.get("/auth/github/callback", async (c) => {
  const githubError = c.req.query("error");
  if (githubError) {
    // Fixed wording only: anyone can craft this URL, so GitHub's error text is never echoed onto the page.
    return c.html(
      <SignupPage
        env={c.env}
        mode="signin"
        next={null}
        flash={
          githubError === "access_denied"
            ? { kind: "info", text: "Sign-in was cancelled on GitHub. Try again whenever you're ready." }
            : { kind: "error", text: "GitHub couldn't complete the sign-in. Please try again." }
        }
        devLogin={false}
      />,
    );
  }
  try {
    const user = await finishGithubLogin(c);
    await startSession(c, user.id);
    await audit(c, user.id, "sign_in", "GitHub");
    return c.redirect(takeNextPath(c));
  } catch (error) {
    if (!(error instanceof SignInError)) console.error(error);
    return c.html(
      <MessagePage
        env={c.env}
        user={null}
        title="Sign-in didn't work"
        message={error instanceof SignInError ? error.message : "Something went wrong while talking to GitHub. Please try again."}
        link={{ href: "/login", label: "Try again" }}
      />,
      400,
    );
  }
});

app.post("/auth/logout", async (c) => {
  const user = c.get("user");
  if (user) await audit(c, user.id, "sign_out");
  await endSession(c);
  return c.redirect("/", 303);
});

app.post("/account/sessions/revoke", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  await audit(c, user.id, "sign_out_everywhere");
  await db.deleteAllSessions(c.env.DB, user.id);
  await endSession(c);
  return redirectWith(c, "/login", "ok", "Signed out on every device. Sign in again to continue.");
});

app.get("/privacy", (c) => c.html(<PrivacyPage env={c.env} user={c.get("user")} />));
app.get("/terms", (c) => c.html(<TermsPage env={c.env} user={c.get("user")} />));
app.get("/refunds", (c) => c.html(<RefundsPage env={c.env} user={c.get("user")} />));

// ---------- public fix log & badge ----------

app.get("/fixed/:slug", async (c) => {
  const slug = c.req.param("slug");
  const target = SLUG_PATTERN.test(slug) ? await issuesDb.publicAppBySlug(c.env.DB, slug) : null;
  if (!target || target.store === "demo") return c.notFound();
  const fixes = await issuesDb.publicFixes(c.env.DB, target.id);
  // Short caches: absorb bursts of visitors, but a log that's turned off disappears within minutes.
  c.header("Cache-Control", "public, max-age=60");
  return c.html(<PublicFixLogPage env={c.env} app={target} fixes={fixes} />);
});

app.get("/badge/:file", async (c) => {
  const file = c.req.param("file");
  const slug = file.endsWith(".svg") ? file.slice(0, -4) : "";
  const target = SLUG_PATTERN.test(slug) ? await issuesDb.publicAppBySlug(c.env.DB, slug) : null;
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  if (!target || target.store === "demo") return c.body(badgeSvg("fixed from reviews", "not found", "#9ca3af"), 404);
  const totals = await issuesDb.publicFixTotals(c.env.DB, target.id);
  return c.body(badgeSvg("fixed from reviews", `${totals.fixed} fixed${totals.stars > 0 ? ` · +${totals.stars}★` : ""}`));
});

// ---------- signed-in pages ----------

const INBOX_VIEWS = new Set<db.InboxView>(["needs_reply", "fix_pending", "followups", "done", "all"]);

app.get("/inbox", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const requestedView = c.req.query("view") as db.InboxView | undefined;
  const view = requestedView && INBOX_VIEWS.has(requestedView) ? requestedView : "needs_reply";
  const appId = c.req.query("app") || null;
  const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(c.req.query("offset")) || 0)));
  const requestedIssue = c.req.query("issue");
  const issueFilter = requestedIssue ? await issuesDb.getIssue(c.env.DB, user.id, requestedIssue) : null;
  const [reviews, counts, apps, connections, wins, appCounts, issues] = await Promise.all([
    db.listInbox(c.env.DB, user.id, { view, appId, issueId: issueFilter?.id ?? null, limit: PAGE_SIZE, offset }),
    db.inboxCounts(c.env.DB, user.id),
    db.listApps(c.env.DB, user.id),
    db.listConnections(c.env.DB, user.id),
    db.ratingWins(c.env.DB, user.id),
    db.appReviewCounts(c.env.DB, user.id),
    issuesDb.openIssues(c.env.DB, user.id),
  ]);
  const readyCounts = new Map([...appCounts].map(([id, count]) => [id, count.followups_ready]));
  return c.html(
    <InboxPage
      env={c.env}
      user={user}
      flash={flashFrom(c)}
      view={view}
      appId={appId}
      apps={apps}
      connections={connections}
      reviews={reviews}
      counts={counts}
      wins={wins}
      offset={offset}
      readyCounts={readyCounts}
      issues={issues}
      issueFilter={issueFilter ? { id: issueFilter.id, title: issueFilter.title } : null}
    />,
  );
});

app.get("/issues", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const tab = c.req.query("tab") === "shipped" ? "shipped" : "open";
  const [issues, counts, basis] = await Promise.all([
    issuesDb.listIssues(c.env.DB, user.id, tab),
    issuesDb.issueCounts(c.env.DB, user.id),
    tab === "open" ? forecastBasisFor(c.env, user.id) : Promise.resolve(null),
  ]);
  return c.html(<IssuesPage env={c.env} user={user} flash={flashFrom(c)} tab={tab} issues={issues} counts={counts} basis={basis} />);
});

app.get("/issues/:id", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const issue = await issuesDb.getIssueWithStats(c.env.DB, user.id, c.req.param("id"));
  if (!issue) return c.notFound();
  const open = issue.status === "open";
  const [reviews, similar, basis] = await Promise.all([
    db.listInbox(c.env.DB, user.id, { view: "all", issueId: issue.id, limit: 200, offset: 0 }),
    open ? similarReviews(c.env, user, issue) : Promise.resolve([]),
    open ? forecastBasisFor(c.env, user.id) : Promise.resolve(null),
  ]);
  return c.html(
    <IssueDetailPage env={c.env} user={user} flash={flashFrom(c)} issue={issue} reviews={reviews} similar={similar} basis={basis} />,
  );
});

app.post("/issues/:id", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const issue = await issuesDb.getIssue(c.env.DB, user.id, c.req.param("id"));
  if (!issue) return redirectWith(c, "/issues", "err", "That issue no longer exists.");
  const back = `/issues/${issue.id}`;
  if (issue.status !== "open") return redirectWith(c, back, "err", "This issue already shipped, so it can't be edited.");
  const form = await c.req.parseBody();
  const title = field(form, "title").trim().slice(0, 120);
  const fixNote = field(form, "fix_note").trim().slice(0, 500) || null;
  const targetVersion = field(form, "target_version").trim() || null;
  if (!title) return redirectWith(c, back, "err", "Give the issue a title.");
  if (targetVersion && !VERSION_PATTERN.test(targetVersion)) return redirectWith(c, back, "err", "Enter a version like 2.3.1.");
  await issuesDb.updateIssue(c.env.DB, user.id, issue.id, { title, fixNote, targetVersion });
  return redirectWith(c, back, "ok", "Issue saved.");
});

app.get("/insights", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const [rows, apps, cached] = await Promise.all([
    appLoopMetrics(c.env.DB, new Date(Date.now() - 90 * DAY).toISOString(), { userId: user.id }),
    db.listApps(c.env.DB, user.id),
    cachedBenchmarks(c.env),
  ]);
  // Before the first scheduled run has computed them, work the peer benchmarks out once here.
  // The page still works without them if that fails.
  const benchmarks =
    cached ??
    (await refreshBenchmarksIfStale(c.env)
      .then((fresh) => (fresh ? cachedBenchmarks(c.env) : null))
      .catch((error) => {
        console.warn("benchmarks failed:", error instanceof Error ? error.message : String(error));
        return null;
      }));
  const appsById = new Map(apps.map((row) => [row.id, row]));
  return c.html(
    <InsightsPage
      env={c.env}
      user={user}
      flash={flashFrom(c)}
      you={summarize(rows)}
      perApp={rows.map((row) => ({ ...row, app: appsById.get(row.app_id) }))}
      benchmarks={benchmarks}
    />,
  );
});

app.get("/releases", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const [apps, counts, releases, shipped] = await Promise.all([
    db.listApps(c.env.DB, user.id),
    db.appReviewCounts(c.env.DB, user.id),
    db.listReleases(c.env.DB, user.id),
    issuesDb.recentlyShippedIssues(c.env.DB, user.id),
  ]);
  const rows = apps
    .filter((app) => app.enabled)
    .map((app) => ({ ...app, ...(counts.get(app.id) ?? { fix_pending: 0, followups_ready: 0 }) }));

  const fixedByRelease = new Map<string, Array<{ title: string; reports: number }>>();
  for (const issue of shipped) {
    const key = `${issue.app_id}\n${issue.shipped_version}`;
    fixedByRelease.set(key, [...(fixedByRelease.get(key) ?? []), issue]);
  }
  const whatsNew = new Map<string, string>();
  for (const release of releases) {
    const fixed = fixedByRelease.get(`${release.app_id}\n${release.version}`);
    if (fixed?.length) whatsNew.set(release.id, whatsNewText([...fixed].sort((a, b) => b.reports - a.reports)));
  }
  return c.html(<ReleasesPage env={c.env} user={user} flash={flashFrom(c)} apps={rows} releases={releases} whatsNew={whatsNew} />);
});

app.post("/apps/:id/releases", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const target = await db.getApp(c.env.DB, user.id, c.req.param("id"));
  if (!target) return redirectWith(c, "/releases", "err", "That app no longer exists.");
  const version = field(await c.req.parseBody(), "version").trim();
  if (!VERSION_PATTERN.test(version)) return redirectWith(c, "/releases", "err", "Enter a version like 2.3.1.");
  const created = await handleRelease(c.env, target, version, "manual");
  return redirectWith(
    c,
    created ? "/inbox?view=followups" : "/releases",
    "ok",
    created ? `${created} follow-up${created === 1 ? "" : "s"} drafted for ${target.name} ${version}.` : `Recorded ${target.name} ${version}. No reviews were waiting on a fix.`,
  );
});

app.get("/apps", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const apps = await db.listApps(c.env.DB, user.id);
  return c.html(<AppsPage env={c.env} user={user} flash={flashFrom(c)} apps={apps} />);
});

app.post("/apps/:id/toggle", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const target = await db.getApp(c.env.DB, user.id, c.req.param("id"));
  if (!target) return redirectWith(c, "/apps", "err", "That app no longer exists.");
  const enable = field(await c.req.parseBody(), "enabled") === "1";
  if (enable && target.store !== "demo" && (await db.countEnabledApps(c.env.DB, user.id)) >= appLimitFor(c.env, user)) {
    const plan = userPlan(c.env, user);
    return redirectWith(
      c,
      "/apps",
      "err",
      `Your ${plan.name} plan covers ${plan.apps} app${plan.apps === 1 ? "" : "s"}. Stop tracking one, or upgrade in Settings to track more.`,
    );
  }
  await db.setAppEnabled(c.env.DB, user.id, target.id, enable);
  return redirectWith(c, "/apps", "ok", enable ? `Tracking ${target.name}.` : `Stopped tracking ${target.name}.`);
});

app.post("/apps/:id/public", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const target = await db.getApp(c.env.DB, user.id, c.req.param("id"));
  if (!target) return redirectWith(c, "/apps", "err", "That app no longer exists.");
  // Real store apps only: a sample app would let anyone publish made-up text on this domain.
  if (target.store === "demo") return redirectWith(c, "/apps", "err", "Public fix logs are for your real store apps.");
  const enable = field(await c.req.parseBody(), "public") === "1";
  const save = (slug: string) => issuesDb.setPublicLog(c.env.DB, user.id, target.id, enable, slug);
  try {
    await save(target.public_slug ?? makeSlug(target.name));
  } catch (error) {
    // Two apps drawing the same random slug is astronomically unlikely, and a fresh one fixes it.
    if (!/UNIQUE/i.test(String(error))) throw error;
    await save(makeSlug(target.name));
  }
  await audit(c, user.id, enable ? "public_log_enabled" : "public_log_disabled", target.name);
  return redirectWith(
    c,
    "/apps",
    "ok",
    enable
      ? `${target.name} has a public fix log now. Add the badge below to your README or website.`
      : `The public fix log for ${target.name} is off. Browsers that loaded it recently may show it for a few more minutes.`,
  );
});

app.get("/connect", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const [connections, apps] = await Promise.all([db.listConnections(c.env.DB, user.id), db.listApps(c.env.DB, user.id)]);
  return c.html(<ConnectPage env={c.env} user={user} flash={flashFrom(c)} connections={connections} apps={apps} />);
});

function connectedMessage(result: ConnectResult): string {
  const found = result.sync ? `, ${result.sync.newReviews} new reviews imported` : "";
  const warning = result.sync?.error ? ` The first check hit a problem: ${result.sync.error}` : "";
  const verb = result.updated ? "Key updated for" : "Connected";
  return `${verb} ${result.apps} app${result.apps === 1 ? "" : "s"}${found}.${warning}`;
}

/** Back to the guide (keeping update mode) so the steps are right there when something fails. */
function guideRedirect(c: AppContext, store: "apple" | "google", connectionId: string | null, error: unknown) {
  const path = guidePath(store) + (connectionId ? `?connection=${encodeURIComponent(connectionId)}` : "");
  return redirectWith(c, path, "err", errorMessage(error));
}

async function auditConnection(c: AppContext, user: UserRow, storeName: string, result: ConnectResult) {
  await audit(c, user.id, result.updated ? "store_key_updated" : "store_connected", `${storeName}, ${result.apps} app${result.apps === 1 ? "" : "s"}`);
}

app.get("/guide/app-store", async (c) => {
  const user = c.get("user");
  const connectionId = c.req.query("connection");
  const connection = user && connectionId ? await db.getConnection(c.env.DB, user.id, connectionId) : null;
  return c.html(
    <AppStoreGuide env={c.env} user={user} flash={flashFrom(c)} connection={connection?.store === "apple" ? connection : null} />,
  );
});

app.get("/guide/google-play", async (c) => {
  const user = c.get("user");
  const connectionId = c.req.query("connection");
  const connection = user && connectionId ? await db.getConnection(c.env.DB, user.id, connectionId) : null;
  const google = connection?.store === "google" ? connection : null;
  const packageNames = google
    ? (await db.listAppsForConnection(c.env.DB, google.id)).map((app) => app.store_app_id).join(", ")
    : "";
  return c.html(<GooglePlayGuide env={c.env} user={user} flash={flashFrom(c)} connection={google} packageNames={packageNames} />);
});

app.post("/connect/apple", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const form = await c.req.parseBody();
  const connectionId = field(form, "connection_id") || null;
  try {
    const result = await connectApple(
      c.env,
      user,
      { issuerId: field(form, "issuer_id"), keyId: field(form, "key_id"), privateKey: field(form, "private_key") },
      connectionId,
    );
    await auditConnection(c, user, "App Store Connect", result);
    return redirectWith(c, "/inbox", "ok", connectedMessage(result));
  } catch (error) {
    return guideRedirect(c, "apple", connectionId, error);
  }
});

app.post("/connect/google", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const form = await c.req.parseBody();
  const connectionId = field(form, "connection_id") || null;
  try {
    const result = await connectGoogle(
      c.env,
      user,
      { serviceAccountJson: field(form, "service_account"), packageNames: field(form, "package_names") },
      connectionId,
    );
    await auditConnection(c, user, "Google Play", result);
    return redirectWith(c, "/inbox", "ok", connectedMessage(result));
  } catch (error) {
    return guideRedirect(c, "google", connectionId, error);
  }
});

app.post("/connect/demo", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  await connectDemo(c.env, user);
  return redirectWith(c, "/inbox", "ok", "Sample reviews loaded. Try drafting a reply to the first one.");
});

app.post("/connections/:id/delete", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const connection = await db.getConnection(c.env.DB, user.id, c.req.param("id"));
  if (!connection) return redirectWith(c, "/connect", "err", "That connection no longer exists.");
  await db.deleteConnection(c.env.DB, user.id, connection.id);
  if (connection.store !== "demo") await audit(c, user.id, "store_removed", connection.label);
  return redirectWith(c, "/connect", "ok", "Connection removed.");
});

app.get("/settings", async (c) => {
  const user = requireUser(c);
  if (!user) return signInFirst(c);
  const [settings, draftsUsed, events] = await Promise.all([
    db.getSettings(c.env.DB, user.id),
    db.aiDraftsThisMonth(c.env.DB, user.id),
    recentEvents(c.env.DB, user.id, 20),
  ]);
  return c.html(
    <SettingsPage
      env={c.env}
      user={user}
      flash={flashFrom(c)}
      settings={settings}
      draftsUsed={draftsUsed}
      draftLimit={draftLimitFor(c.env, user)}
      billingReady={billingConfigured(c.env)}
      events={events}
    />,
  );
});

const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

app.post("/settings", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const form = await c.req.parseBody();
  const current = await db.getSettings(c.env.DB, user.id);

  const slack = field(form, "slack_webhook").trim();
  const discord = field(form, "discord_webhook").trim();
  if (slack && !SLACK_WEBHOOK.test(slack)) return redirectWith(c, "/settings", "err", "That isn't a Slack incoming webhook URL.");
  if (discord && !DISCORD_WEBHOOK.test(discord)) return redirectWith(c, "/settings", "err", "That isn't a Discord webhook URL.");
  const clear = field(form, "clear_webhooks") === "1";
  const alertMax = Math.min(5, Math.max(1, Number(field(form, "alert_max_rating")) || 2));

  await db.saveSettings(c.env.DB, user.id, {
    voice_notes: field(form, "voice_notes").slice(0, 2000),
    signature: field(form, "signature").slice(0, 80),
    support_contact: field(form, "support_contact").slice(0, 120),
    alert_max_rating: alertMax,
    email_alerts: field(form, "email_alerts") === "1" ? 1 : 0,
    slack_webhook: clear ? null : slack ? await encryptOptional(c.env.ENCRYPTION_KEY, slack) : current.slack_webhook,
    discord_webhook: clear ? null : discord ? await encryptOptional(c.env.ENCRYPTION_KEY, discord) : current.discord_webhook,
    auto_followup: userPlan(c.env, user).autoFollowup && field(form, "auto_followup") === "1" ? 1 : 0,
  });

  // Alerts go wherever these URLs point, so changes to them belong in the security log.
  const changes = clear
    ? current.slack_webhook || current.discord_webhook
      ? ["removed saved webhooks"]
      : []
    : [
        slack ? `${current.slack_webhook ? "replaced" : "added"} Slack` : null,
        discord ? `${current.discord_webhook ? "replaced" : "added"} Discord` : null,
      ].filter((change): change is string => change !== null);
  if (changes.length) await audit(c, user.id, "alert_webhooks_changed", changes.join(", "));
  return redirectWith(c, "/settings", "ok", "Settings saved.");
});

app.post("/account/delete", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  if (!isRecentSignIn(c.get("sessionCreatedAt"))) return confirmItsYou(c, "/settings#account");
  await endSession(c);
  await db.deleteUser(c.env.DB, user.id);
  return redirectWith(c, "/", "ok", "Your account and data were deleted.");
});

// ---------- founder dashboard ----------

app.get("/admin", async (c) => {
  const user = requireUser(c);
  if (!user || !isAdmin(c.env, user)) return c.notFound();
  if (!isRecentSignIn(c.get("sessionCreatedAt"))) return confirmItsYou(c, "/admin");
  await audit(c, user.id, "admin_opened");
  const today = db.utcDay();
  const [metrics, todayUsage, monthUsage, rotation] = await Promise.all([
    db.adminMetrics(c.env.DB),
    db.aiUsageSince(c.env.DB, today),
    db.aiUsageSince(c.env.DB, `${currentMonth()}-01`),
    rotationStatus(c.env),
  ]);
  const model = c.env.AI_MODEL || "claude-opus-5";
  return c.html(
    <AdminPage
      env={c.env}
      user={user}
      metrics={metrics}
      ai={{
        today: todayUsage,
        month: monthUsage,
        caps: dailyAiCaps(c.env),
        model,
        monthCostUsd: estimateCostUsd(model, monthUsage.input_tokens, monthUsage.output_tokens),
      }}
      prices={{ plus: planDetails(c.env, "plus").priceUsd, pro: planDetails(c.env, "pro").priceUsd }}
      lockedToId={Boolean(c.env.ADMIN_GITHUB_IDS?.trim())}
      rotation={rotation}
    />,
  );
});

// ---------- billing ----------

app.post("/billing/checkout", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const plan = field(await c.req.parseBody(), "plan");
  if (!isPaidPlan(plan)) return redirectWith(c, "/settings#plan", "err", "Choose Plus or Pro.");
  try {
    return c.redirect(await createCheckout(c.env, user, plan), 303);
  } catch (error) {
    return redirectWith(c, "/settings#plan", "err", errorMessage(error));
  }
});

/** Subscribers switch plans on their existing subscription, so they're never billed twice. */
app.post("/billing/change", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const target = field(await c.req.parseBody(), "plan");
  if (!isPaidPlan(target)) return redirectWith(c, "/settings#plan", "err", "Choose Plus or Pro.");
  const current = userPlan(c.env, user);
  const next = planDetails(c.env, target);
  try {
    const result = await changePlan(c.env, user, target);
    const when = result === "upgraded" ? "now" : "next billing date";
    await audit(c, user.id, "plan_change_requested", `${current.name} to ${next.name} (${when})`);
    if (result === "scheduled") {
      await db.setScheduledPlan(c.env.DB, user.id, target);
      const date = user.plan_renews_at ? user.plan_renews_at.slice(0, 10) : "your next billing date";
      return redirectWith(c, "/settings#plan", "ok", `You'll move to ${next.name} on ${date}. You keep ${current.name} until then.`);
    }
    return redirectWith(c, "/settings#plan", "ok", `Upgrading to ${next.name}. It switches on as soon as the payment goes through, usually within a minute.`);
  } catch (error) {
    return redirectWith(c, "/settings#plan", "err", errorMessage(error));
  }
});

app.post("/billing/keep", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  const current = userPlan(c.env, user);
  if (!user.plan_scheduled) return redirectWith(c, "/settings#plan", "ok", `You're on ${current.name}, with no change booked.`);
  try {
    await cancelScheduledChange(c.env, user);
    await db.setScheduledPlan(c.env.DB, user.id, null);
    await audit(c, user.id, "plan_change_requested", `Kept ${current.name}`);
    return redirectWith(c, "/settings#plan", "ok", `You're staying on ${current.name}.`);
  } catch (error) {
    return redirectWith(c, "/settings#plan", "err", errorMessage(error));
  }
});

app.post("/billing/portal", async (c) => {
  const user = requireUser(c);
  if (!user) return c.redirect("/login", 303);
  try {
    return c.redirect(await createPortalLink(c.env, user), 303);
  } catch (error) {
    return redirectWith(c, "/settings", "err", errorMessage(error));
  }
});

app.get("/billing/return", (c) =>
  c.html(
    <MessagePage
      env={c.env}
      user={c.get("user")}
      title="Thanks for subscribing"
      message="Your payment is being confirmed. Your new plan switches on within a minute; refresh Settings if it hasn't yet."
      link={{ href: "/settings", label: "Go to Settings" }}
    />,
  ),
);

app.post("/webhooks/dodo", async (c) => {
  const status = await handleBillingWebhook(c.env, c.req.raw);
  return c.body(null, status as 200 | 401 | 404);
});

// ---------- JSON API used by public/app.js ----------

app.post(
  "/api/reviews/:id/draft",
  reviewApi(async (c, user, review) => {
    await draftForReview(c.env, user, review, "reply");
    return { message: "Draft ready. Edit it, then send." };
  }),
);

app.post(
  "/api/reviews/:id/reply",
  reviewApi(async (c, user, review) => {
    const body = await readJson<{ text: unknown }>(c);
    await sendReply(c.env, user, review, text(body.text), "reply");
    return { message: review.store === "demo" ? "Reply saved (sample app, nothing was posted)." : "Reply posted." };
  }),
);

app.post(
  "/api/reviews/:id/fix",
  reviewApi(async (c, user, review) => {
    const body = await readJson<{ issueId: unknown; title: unknown; note: unknown; version: unknown }>(c);
    const issue = await linkReviewToIssue(c.env, user, review, {
      issueId: text(body.issueId, 64) || null,
      title: text(body.title, 120) || null,
      note: text(body.note, 500) || null,
      version: text(body.version, 40) || null,
    });
    return { message: `In the issue “${issue.title}”. Everyone in it gets a follow-up draft when the fix ships.` };
  }),
);

app.post(
  "/api/reviews/:id/unlink",
  reviewApi(async (c, _user, review) => {
    if (!review.issue_id && review.status !== "fix_pending") throw new UserFacingError("This review isn't waiting on a fix.", 409);
    await unlinkReview(c.env, review);
    return { message: "Taken out of the issue." };
  }),
);

app.post(
  "/api/reviews/:id/status",
  reviewApi(async (c, _user, review) => {
    const body = await readJson<{ status: unknown }>(c);
    const status = text(body.status);
    if (status !== "done" && status !== "open") throw new UserFacingError("Unknown status.");
    await db.updateReview(c.env.DB, review.id, { status });
    return { message: status === "done" ? "Marked done." : "Moved back to Needs reply." };
  }),
);

app.post(
  "/api/reviews/:id/followup-draft",
  reviewApi(async (c, user, review) => {
    if (review.status !== "followup_ready") throw new UserFacingError("This review isn't waiting on a follow-up.", 409);
    await draftForReview(c.env, user, review, "followup");
    return { message: "Follow-up rewritten." };
  }),
);

app.post(
  "/api/reviews/:id/followup",
  reviewApi(async (c, user, review) => {
    if (review.status !== "followup_ready") throw new UserFacingError("This review isn't waiting on a follow-up.", 409);
    const body = await readJson<{ text: unknown }>(c);
    await sendReply(c.env, user, review, text(body.text), "followup");
    return { message: review.store === "demo" ? "Follow-up saved (sample app). Check for new reviews to see the rating change." : "Follow-up posted." };
  }),
);

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

app.post("/api/issues/:id/add", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Your session expired. Sign in again." }, 401);
  const body = await readJson<{ reviewIds: unknown }>(c);
  const reviewIds = Array.isArray(body.reviewIds)
    ? body.reviewIds.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id)).slice(0, 100)
    : [];
  if (reviewIds.length === 0) return c.json({ error: "Choose at least one review." }, 400);
  try {
    const added = await addReviewsToIssue(c.env, user, c.req.param("id"), reviewIds);
    return c.json({
      message: added
        ? `Added ${added} review${added === 1 ? "" : "s"} to the issue.`
        : "Nothing was added: those reviews are in another app, already in an issue, or already followed up.",
      reload: true,
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/api/apps/:id/followups/send", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Your session expired. Sign in again." }, 401);
  const target = await db.getApp(c.env.DB, user.id, c.req.param("id"));
  if (!target) return c.json({ error: "That app no longer exists." }, 404);
  const { sent, failed } = await sendAllFollowups(c.env, user, target.id);
  const message = `${sent} follow-up${sent === 1 ? "" : "s"} sent${failed ? `, ${failed} failed (see the cards for details)` : ""}.`;
  return c.json({ message, reload: true });
});

app.post("/api/sync", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Your session expired. Sign in again." }, 401);
  const result = await syncNow(c.env, user);
  const parts = [`${result.newReviews} new review${result.newReviews === 1 ? "" : "s"}`];
  if (result.ratingsRaised) parts.push(`${result.ratingsRaised} rating${result.ratingsRaised === 1 ? "" : "s"} raised`);
  if (result.followupsCreated) parts.push(`${result.followupsCreated} follow-ups ready`);
  return c.json({
    message: result.error ? `Checked with problems: ${result.error}` : `Up to date: ${parts.join(", ")}.`,
    reload: true,
  });
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
  return c.html(
    <MessagePage env={c.env} user={c.get("user") ?? null} title="Page not found" message="That page doesn't exist." link={{ href: "/", label: "Go home" }} />,
    404,
  );
});

app.onError((error, c) => {
  console.error(error);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Something went wrong. Please try again." }, 500);
  return c.html(
    <MessagePage env={c.env} user={null} title="Something went wrong" message="Please try again in a moment." link={{ href: "/", label: "Go home" }} />,
    500,
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledWork(env));
  },
} satisfies ExportedHandler<Bindings>;

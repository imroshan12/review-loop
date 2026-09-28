import * as db from "../db";
import type { AppRow, Bindings, ConnectionRow, InboxReview, ReviewRow, UserRow } from "../env";
import { currentPlan, envNumber, planDetails, replyLimit, userPlan } from "../env";
import { checkReplySafety } from "../lib/safety";
import { encryptJson, keyring, openSealed } from "../lib/secrets";
import { compareVersions, maxVersion, nowIso } from "../lib/util";
import * as issuesDb from "../queries/issues";
import { repliesThatWorked } from "../queries/insights";
import { AppleClient } from "../stores/apple";
import { DEMO_LIVE_VERSIONS } from "../stores/demo";
import { GoogleClient } from "../stores/google";
import type { AppleCredentials, FetchLike, GoogleCredentials } from "../stores/types";
import { BudgetExhaustedError, globalFetch, RequestBudget, StoreApiError } from "../stores/types";
import { AiUnavailableError, draftWithClaude, templateFollowup, type DraftResult } from "./ai";
import { runPromiseTracker, runReleaseGuard } from "./guard";
import { refreshBenchmarksIfStale } from "./insights";
import { resealStaleSecrets } from "./rotation";
import { brokenConnectionNotice, deliverNotice, followupsNotice, lowRatingNotice } from "./notify";

export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 403 | 404 | 409 | 429 | 502 = 400,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

type StoreClient =
  | { store: "apple"; client: AppleClient }
  | { store: "google"; client: GoogleClient }
  | { store: "demo" };

export async function clientFor(env: Bindings, connection: ConnectionRow, fetcher: FetchLike = globalFetch): Promise<StoreClient> {
  if (connection.store === "demo") return { store: "demo" };
  const { value: credentials, stale } = await openSealed<AppleCredentials & GoogleCredentials>(keyring(env), connection.credentials);
  // After a key rotation, move this connection onto the current key as soon as it's used.
  if (stale) await db.resealConnection(env.DB, connection.id, connection.credentials, await encryptJson(env.ENCRYPTION_KEY, credentials));
  if (connection.store === "apple") return { store: "apple", client: new AppleClient(credentials, fetcher) };
  return { store: "google", client: new GoogleClient(credentials, fetcher) };
}

export function appLimitFor(env: Bindings, user: Pick<UserRow, "plan" | "plan_renews_at">): number {
  return userPlan(env, user).apps;
}

export function draftLimitFor(env: Bindings, user: Pick<UserRow, "plan" | "plan_renews_at">): number {
  return userPlan(env, user).draftsPerMonth;
}

/** What to say when a plan's monthly AI drafts are used up, pointing at the plan that has more. */
export function draftLimitMessage(env: Bindings, user: Pick<UserRow, "plan" | "plan_renews_at">): string {
  const plan = userPlan(env, user);
  const plus = planDetails(env, "plus");
  const pro = planDetails(env, "pro");
  if (plan.plan === "free") {
    return `You've used your ${plan.draftsPerMonth} free AI drafts this month. Plus includes ${plus.draftsPerMonth} a month and Pro ${pro.draftsPerMonth}.`;
  }
  if (plan.plan === "plus") {
    return `You've used all ${plan.draftsPerMonth} AI drafts this month. They reset on the 1st, or Pro includes ${pro.draftsPerMonth} a month.`;
  }
  return `You've used all ${plan.draftsPerMonth} AI drafts this month. They reset on the 1st.`;
}

export function dailyAiCaps(env: Bindings): { free: number; total: number } {
  return { free: envNumber(env.FREE_AI_DAILY_CAP, 100), total: envNumber(env.AI_DAILY_CAP, 1000) };
}

// ---------- sync ----------

export interface SyncSummary {
  newReviews: number;
  ratingsRaised: number;
  followupsCreated: number;
  error: string | null;
}

const ALERT_WINDOW_MS = 3 * 24 * 3600 * 1000;

export async function syncConnection(env: Bindings, connection: ConnectionRow, budget: RequestBudget): Promise<SyncSummary> {
  const summary: SyncSummary = { newReviews: 0, ratingsRaised: 0, followupsCreated: 0, error: null };
  let failure: unknown = null;
  try {
    const store = await clientFor(env, connection, budget.fetcher());
    const apps = await db.listEnabledAppsForConnection(env.DB, connection.id);
    for (const app of apps) {
      if (budget.remaining < 3) break;
      await syncApp(env, store, app, summary);
    }
  } catch (error) {
    // Running out of this run's request budget isn't the connection's fault; the rest syncs next run.
    if (!(error instanceof BudgetExhaustedError)) failure = error;
  }
  if (!failure) {
    await db.recordSyncSuccess(env.DB, connection.id);
    return summary;
  }
  summary.error = failure instanceof Error ? failure.message : String(failure);
  console.warn(`sync failed for connection ${connection.id}:`, summary.error);
  await handleSyncFailure(env, connection, failure, summary.error);
  return summary;
}

// ---------- connection health ----------

export type FailureKind = "needs_user" | "transient";

/** Revoked keys, missing permissions and unknown apps won't fix themselves; outages and rate limits will. */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof StoreApiError) return error.status === 429 || error.status >= 500 ? "transient" : "needs_user";
  return "transient";
}

/** Minutes until the next automatic check after `failures` failures in a row, capped at a day. */
export function retryDelayMinutes(failures: number, kind: FailureKind): number {
  const base = kind === "needs_user" ? 6 * 60 : 30;
  return Math.min(24 * 60, base * 2 ** Math.max(0, failures - 1));
}

/** Tell the user once: right away when they need to act, or after about a day of outages. */
export function shouldNotifyFailure(kind: FailureKind, failures: number, alreadyNotified: boolean): boolean {
  return !alreadyNotified && (kind === "needs_user" || failures >= 6);
}

async function handleSyncFailure(env: Bindings, connection: ConnectionRow, error: unknown, message: string): Promise<void> {
  const kind = classifyFailure(error);
  const failures = connection.failure_count + 1;
  const nextSyncAt = new Date(Date.now() + retryDelayMinutes(failures, kind) * 60_000).toISOString();
  await db.recordSyncFailure(env.DB, connection.id, message, nextSyncAt);
  if (!shouldNotifyFailure(kind, failures, Boolean(connection.failure_notified_at))) return;

  const user = await db.getUser(env.DB, connection.user_id);
  if (!user) return;
  const settings = await db.getSettings(env.DB, user.id);
  const delivered = await deliverNotice(env, user, settings, brokenConnectionNotice(env, connection, message, kind === "needs_user"));
  // Only count it once something was actually sent, so users who add an alert channel later still hear about it.
  if (delivered > 0) await db.markFailureNotified(env.DB, connection.id);
}

async function syncApp(env: Bindings, store: StoreClient, app: AppRow, summary: SyncSummary): Promise<void> {
  if (store.store === "demo") {
    summary.ratingsRaised += await simulateDemoRaises(env, app);
    return;
  }

  // Look back a day past the newest review we have, to catch edits.
  const since = app.last_review_at ? new Date(Date.parse(app.last_review_at) - 24 * 3600 * 1000).toISOString() : null;
  const reviews =
    store.store === "apple"
      ? await store.client.listReviews(
          app.store_app_id,
          // First sync pulls the backlog; later syncs usually need one small page.
          app.last_review_at ? { since, pageSize: 50, maxPages: 4 } : { since, pageSize: 200, maxPages: 3 },
        )
      : await store.client.listReviews(app.store_app_id);

  const result = await db.upsertStoreReviews(env.DB, app, reviews);
  summary.newReviews += result.inserted.length;
  summary.ratingsRaised += result.raised;

  // Don't alert about old reviews found on the first sync.
  const stale = result.inserted.filter((review) => Date.now() - Date.parse(review.reviewed_at) > ALERT_WINDOW_MS);
  if (stale.length) await db.markAlerted(env.DB, stale.map((review) => review.id));

  // Release detection: App Store asks the store; Google Play infers from versions reviewers are on.
  let liveVersion: string | null = null;
  if (store.store === "apple" && app.auto_release) {
    try {
      liveVersion = await store.client.liveVersion(app.store_app_id);
    } catch (error) {
      if (error instanceof StoreApiError && (error.status === 403 || error.status === 404)) {
        await db.updateAppVersion(env.DB, app.id, { autoRelease: false });
      } else {
        throw error;
      }
    }
  } else if (store.store === "google") {
    liveVersion = maxVersion(reviews.map((review) => review.appVersion));
  }

  await db.updateAppVersion(env.DB, app.id, { lastReviewAt: result.newestReviewAt });
  if (liveVersion) {
    if (!app.latest_version) {
      await db.updateAppVersion(env.DB, app.id, { latestVersion: liveVersion });
    } else if (compareVersions(liveVersion, app.latest_version) > 0) {
      summary.followupsCreated += await handleRelease(env, app, liveVersion, store.store === "apple" ? "store" : "reviews");
    }
  }
}

/** In the sample workspace, reviewers who got a follow-up "update" their rating so the loop is visible. */
async function simulateDemoRaises(env: Bindings, app: AppRow): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM reviews WHERE app_id = ? AND status = 'followed_up' AND rating_raised_at IS NULL",
  )
    .bind(app.id)
    .all<ReviewRow>();
  for (const review of results) {
    await db.updateReview(env.DB, review.id, {
      rating_before: review.rating,
      rating: Math.max(review.rating, 4 + (review.rating % 2)),
      rating_raised_at: nowIso(),
    });
  }
  return results.length;
}

// ---------- releases & follow-ups ----------

/** Records a release and turns matching "fix pending" reviews into ready follow-ups. */
export async function handleRelease(
  env: Bindings,
  app: AppRow,
  version: string,
  source: "store" | "reviews" | "manual",
): Promise<number> {
  const isNew = await db.recordRelease(env.DB, app.id, version, source);
  if (!app.latest_version || compareVersions(version, app.latest_version) > 0) {
    await db.updateAppVersion(env.DB, app.id, { latestVersion: version });
  }
  if (!isNew) return 0;

  const settings = await db.getSettings(env.DB, app.user_id);

  // An issue ships as a unit: its target version (or, without one, any release) decides for all its reviews.
  const shippedIssues = new Set<string>();
  for (const issue of await issuesDb.openIssuesForApp(env.DB, app.id)) {
    if (!issue.target_version || compareVersions(version, issue.target_version) >= 0) {
      await issuesDb.markIssueShipped(env.DB, issue.id, version);
      shippedIssues.add(issue.id);
    }
  }
  const pending = (await db.reviewsAwaitingFix(env.DB, app.id)).filter((review) =>
    review.issue_id
      ? shippedIssues.has(review.issue_id)
      : !review.fixed_in_version || compareVersions(version, review.fixed_in_version) >= 0,
  );
  for (const review of pending) {
    await db.updateReview(env.DB, review.id, {
      status: "followup_ready",
      fixed_in_version: version,
      followup_draft: templateFollowup(review, settings, version, review.fix_note),
      followup_ai: 0,
    });
  }
  await db.setReleaseFollowups(env.DB, app.id, version, pending.length);

  if (pending.length) {
    const user = await db.getUser(env.DB, app.user_id);
    if (user) await deliverNotice(env, user, settings, followupsNotice(env, app.name, version, pending.length));
  }
  return pending.length;
}

// ---------- drafting & replying ----------

export async function draftForReview(
  env: Bindings,
  user: UserRow,
  review: InboxReview,
  kind: "reply" | "followup",
): Promise<DraftResult> {
  const used = await db.aiDraftsThisMonth(env.DB, user.id);
  const limit = draftLimitFor(env, user);
  if (used >= limit) throw new UserFacingError(draftLimitMessage(env, user), 402);
  if (!env.ANTHROPIC_API_KEY) throw new UserFacingError("AI drafts aren't set up yet (ANTHROPIC_API_KEY is missing).", 502);

  // The daily cap protects the AI bill from bursts, such as many new accounts in one day.
  const free = currentPlan(user) === "free";
  if (!(await db.reserveAiDraft(env.DB, free, dailyAiCaps(env)))) {
    console.warn(`AI daily cap reached (${free ? "free" : "all"} drafts)`);
    throw new UserFacingError(
      free
        ? "Free AI drafts are paused until midnight UTC because today's free allowance is used up. You can still write replies yourself, or upgrade to Plus or Pro."
        : "AI drafts are paused until midnight UTC because today's safety limit was reached. You can still write replies yourself.",
      429,
    );
  }

  const settings = await db.getSettings(env.DB, user.id);
  let result: DraftResult;
  try {
    // Replies of this developer's that led reviewers to raise their rating: drafts learn from what worked.
    const examples = await repliesThatWorked(env.DB, user.id, review.app_id);
    result = await draftWithClaude(env, {
      kind,
      appName: review.app_name,
      store: review.store,
      review,
      settings,
      fixedInVersion: review.fixed_in_version,
      fixNote: review.fix_note,
      previousReply: review.reply_text,
      examples: examples.map((example) => ({
        ratingBefore: example.rating_before,
        ratingAfter: example.rating,
        review: [example.title, example.body].filter(Boolean).join(": "),
        reply: example.reply_text,
      })),
    });
  } catch (error) {
    await db.releaseAiDraft(env.DB, free);
    if (error instanceof AiUnavailableError) throw new UserFacingError(error.message, 502);
    throw error;
  }
  await db.recordAiTokens(env.DB, result.usage.inputTokens, result.usage.outputTokens);
  await db.incrementAiDrafts(env.DB, user.id);
  await db.updateReview(
    env.DB,
    review.id,
    kind === "followup"
      ? { followup_draft: result.reply, followup_ai: 1, category: review.category ?? result.category }
      : { draft: result.reply, category: result.category, summary: result.summary },
  );
  return result;
}

export async function sendReply(
  env: Bindings,
  user: UserRow,
  review: InboxReview,
  rawText: string,
  kind: "reply" | "followup",
): Promise<void> {
  const text = rawText.trim();
  if (!text) throw new UserFacingError("Write a reply first.");
  const limit = replyLimit(review.store);
  if (text.length > limit) throw new UserFacingError(`Replies on this store are limited to ${limit} characters.`);

  const app = await db.getApp(env.DB, user.id, review.app_id);
  if (!app) throw new UserFacingError("That app no longer exists.", 404);
  const connection = await db.getConnection(env.DB, user.id, app.connection_id);
  if (!connection) throw new UserFacingError("That store connection no longer exists.", 404);

  let responseId = review.store_response_id;
  try {
    const store = await clientFor(env, connection);
    if (store.store === "apple") {
      responseId = (await store.client.reply(review.store_review_id, text, review.store_response_id)).responseId ?? responseId;
    } else if (store.store === "google") {
      await store.client.reply(app.store_app_id, review.store_review_id, text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateReview(env.DB, review.id, {
      reply_error: message,
      reply_state: review.reply_state === "none" ? "failed" : review.reply_state,
    });
    throw new UserFacingError(`The store didn't accept the reply: ${message}`, 502);
  }

  const now = nowIso();
  const isFollowup = kind === "followup" || review.status === "followup_ready";
  await db.updateReview(env.DB, review.id, {
    reply_text: text,
    reply_state: "sent",
    reply_error: null,
    replied_at: now,
    store_response_id: responseId,
    status: isFollowup ? "followed_up" : review.status === "fix_pending" ? "fix_pending" : "done",
    ...(isFollowup ? { followed_up_at: now, followup_draft: null } : { draft: null }),
  });
}

/**
 * Sends every ready follow-up for an app. With `onlySafe` (automatic sending), drafts that fail
 * the safety check stay in the inbox for a person to read instead.
 */
export async function sendAllFollowups(
  env: Bindings,
  user: UserRow,
  appId: string,
  options: { onlySafe?: boolean } = {},
): Promise<{ sent: number; failed: number; held: number }> {
  const ready = await db.followupsReady(env.DB, appId);
  const settings = options.onlySafe ? await db.getSettings(env.DB, user.id) : null;
  let sent = 0;
  let failed = 0;
  let held = 0;
  for (const review of ready) {
    if (review.user_id !== user.id || !review.followup_draft) continue;
    if (settings) {
      const safety = checkReplySafety(review.followup_draft, settings.support_contact);
      if (!safety.ok) {
        console.warn(`auto follow-up held for review ${review.id}: ${safety.problems.join("; ")}`);
        held++;
        continue;
      }
    }
    try {
      await sendReply(env, user, review, review.followup_draft, "followup");
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed, held };
}

// ---------- scheduled work ----------

const CRON_REQUEST_BUDGET = 40;
const CRON_CONNECTIONS = 10;
const CRON_AI_FOLLOWUPS = 5;

export async function runScheduledWork(env: Bindings): Promise<void> {
  try {
    await db.cleanupExpired(env.DB);
  } catch (error) {
    console.warn("cleanup failed:", error instanceof Error ? error.message : String(error));
  }

  const budget = new RequestBudget(CRON_REQUEST_BUDGET);
  const touchedUsers = new Set<string>();

  for (const connection of await db.connectionsDueForSync(env.DB, CRON_CONNECTIONS)) {
    if (budget.remaining < 6) break;
    await syncConnection(env, connection, budget);
    touchedUsers.add(connection.user_id);
  }

  // Upgrade template follow-ups to AI drafts, within each user's monthly quota.
  for (const review of await db.followupsNeedingAi(env.DB, CRON_AI_FOLLOWUPS)) {
    if (budget.remaining < 4) break;
    const user = await db.getUser(env.DB, review.user_id);
    const full = user ? await db.getInboxReview(env.DB, user.id, review.id) : null;
    if (!user || !full || !env.ANTHROPIC_API_KEY) {
      await db.updateReview(env.DB, review.id, { followup_ai: 2 });
      continue;
    }
    budget.used += 3; // one request plus possible retries
    try {
      await draftForReview(env, user, full, "followup");
    } catch {
      await db.updateReview(env.DB, review.id, { followup_ai: 2 });
    }
    touchedUsers.add(user.id);
  }

  for (const userId of touchedUsers) {
    if (budget.remaining < 3) break;
    const user = await db.getUser(env.DB, userId);
    if (!user) continue;
    const settings = await db.getSettings(env.DB, userId);

    // The setting outlives the plan: someone who moved off Pro keeps it, so check what they pay for now.
    if (settings.auto_followup && userPlan(env, user).autoFollowup) {
      for (const app of await db.listApps(env.DB, userId)) {
        if (!app.enabled || budget.remaining < 3) continue;
        const ready = await db.followupsReady(env.DB, app.id);
        // Wait for the AI pass (or its fallback) before sending automatically.
        if (ready.length && ready.every((review) => review.followup_ai !== 0)) {
          budget.used += ready.length;
          await sendAllFollowups(env, user, app.id, { onlySafe: true });
        }
      }
    }

    const alerts = await db.reviewsToAlert(env.DB, userId, settings.alert_max_rating);
    if (alerts.length) {
      budget.used += 3;
      await deliverNotice(env, user, settings, lowRatingNotice(env, alerts));
      await db.markAlerted(env.DB, alerts.map((review) => review.id));
    }
  }

  // Each of these can send a few alerts, so they only run while outbound requests are left.
  const jobs: Array<[string, number, () => Promise<unknown>]> = [
    ["key rotation", 0, () => resealStaleSecrets(env)],
    ["benchmarks", 0, () => refreshBenchmarksIfStale(env)],
    ["release guard", 9, () => runReleaseGuard(env, Date.now(), 3)],
    ["promise tracker", 9, () => runPromiseTracker(env, Date.now(), 3)],
  ];
  for (const [name, needed, job] of jobs) {
    if (budget.remaining < needed) continue;
    try {
      await job();
      budget.used += needed;
    } catch (error) {
      console.warn(`${name} failed:`, error instanceof Error ? error.message : String(error));
    }
  }
}

export function demoLiveVersion(storeAppId: string): string | null {
  return DEMO_LIVE_VERSIONS[storeAppId] ?? null;
}

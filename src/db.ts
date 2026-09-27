import type {
  AppRow,
  ConnectionRow,
  InboxReview,
  PaidPlan,
  Plan,
  ReleaseRow,
  ReviewRow,
  ReviewStatus,
  SettingsRow,
  Store,
  UserRow,
} from "./env";
import { chunk, currentMonth, newId, nowIso } from "./lib/util";
import type { StoreApp, StoreReview } from "./stores/types";

// ---------- users & sessions ----------

export async function findUserBySession(
  db: D1Database,
  tokenHash: string,
): Promise<{ user: UserRow; sessionCreatedAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT u.*, s.created_at AS session_created_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, nowIso())
    .first<UserRow & { session_created_at: string }>();
  if (!row) return null;
  const { session_created_at: sessionCreatedAt, ...user } = row;
  return { user: user as UserRow, sessionCreatedAt };
}

/** Signs the account out everywhere. */
export async function deleteAllSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function createSession(db: D1Database, tokenHash: string, userId: string, days = 30): Promise<void> {
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, nowIso()),
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, userId, expiresAt),
  ]);
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function upsertGithubUser(
  db: D1Database,
  profile: {
    githubId: number;
    login: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
    twoFactor?: boolean | null;
  },
): Promise<UserRow> {
  const twoFactor = profile.twoFactor == null ? null : profile.twoFactor ? 1 : 0;
  const existing = await db.prepare("SELECT * FROM users WHERE github_id = ?").bind(profile.githubId).first<UserRow>();
  if (existing) {
    await db
      .prepare(
        "UPDATE users SET login = ?, name = ?, email = COALESCE(?, email), avatar_url = ?, github_2fa = COALESCE(?, github_2fa) WHERE id = ?",
      )
      .bind(profile.login, profile.name, profile.email, profile.avatarUrl, twoFactor, existing.id)
      .run();
    return {
      ...existing,
      login: profile.login,
      name: profile.name,
      email: profile.email ?? existing.email,
      github_2fa: twoFactor ?? existing.github_2fa,
    };
  }
  const id = newId();
  await db
    .prepare("INSERT INTO users (id, github_id, login, name, email, avatar_url, github_2fa) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, profile.githubId, profile.login, profile.name, profile.email, profile.avatarUrl, twoFactor)
    .run();
  const created = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!created) throw new Error("Failed to create user.");
  return created;
}

export async function getUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

// ---------- settings ----------

export async function getSettings(db: D1Database, userId: string): Promise<SettingsRow> {
  const row = await db.prepare("SELECT * FROM settings WHERE user_id = ?").bind(userId).first<SettingsRow>();
  if (row) return row;
  await db.prepare("INSERT OR IGNORE INTO settings (user_id) VALUES (?)").bind(userId).run();
  const created = await db.prepare("SELECT * FROM settings WHERE user_id = ?").bind(userId).first<SettingsRow>();
  if (!created) throw new Error("Failed to create settings.");
  return created;
}

export async function saveSettings(
  db: D1Database,
  userId: string,
  values: Omit<SettingsRow, "user_id" | "updated_at">,
): Promise<void> {
  await getSettings(db, userId);
  await db
    .prepare(
      `UPDATE settings SET voice_notes = ?, signature = ?, support_contact = ?, alert_max_rating = ?,
         email_alerts = ?, slack_webhook = ?, discord_webhook = ?, auto_followup = ?, updated_at = ?
       WHERE user_id = ?`,
    )
    .bind(
      values.voice_notes,
      values.signature,
      values.support_contact,
      values.alert_max_rating,
      values.email_alerts,
      values.slack_webhook,
      values.discord_webhook,
      values.auto_followup,
      nowIso(),
      userId,
    )
    .run();
}

// ---------- connections & apps ----------

export async function listConnections(db: D1Database, userId: string): Promise<ConnectionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<ConnectionRow>();
  return results;
}

export async function getConnection(db: D1Database, userId: string, connectionId: string): Promise<ConnectionRow | null> {
  return db
    .prepare("SELECT * FROM connections WHERE id = ? AND user_id = ?")
    .bind(connectionId, userId)
    .first<ConnectionRow>();
}

export async function createConnection(
  db: D1Database,
  userId: string,
  store: Store,
  label: string,
  sealedCredentials: string,
): Promise<string> {
  const id = newId();
  await db
    .prepare("INSERT INTO connections (id, user_id, store, label, credentials) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userId, store, label, sealedCredentials)
    .run();
  return id;
}

export async function deleteConnection(db: D1Database, userId: string, connectionId: string): Promise<void> {
  await db.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").bind(connectionId, userId).run();
}

export async function recordSyncSuccess(db: D1Database, connectionId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE connections SET last_synced_at = ?, status = 'ok', last_error = NULL,
         failure_count = 0, next_sync_at = NULL, failure_notified_at = NULL
       WHERE id = ?`,
    )
    .bind(nowIso(), connectionId)
    .run();
}

export async function recordSyncFailure(
  db: D1Database,
  connectionId: string,
  error: string,
  nextSyncAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE connections SET last_synced_at = ?, status = 'error', last_error = ?,
         failure_count = failure_count + 1, next_sync_at = ?
       WHERE id = ?`,
    )
    .bind(nowIso(), error.slice(0, 500), nextSyncAt, connectionId)
    .run();
}

export async function markFailureNotified(db: D1Database, connectionId: string): Promise<void> {
  await db.prepare("UPDATE connections SET failure_notified_at = ? WHERE id = ?").bind(nowIso(), connectionId).run();
}

/** Re-encrypts stored credentials after a key rotation, without touching sync state. */
/**
 * Swaps in credentials re-encrypted with the current key, only if they haven't changed since they were read:
 * a key the user just replaced must never be overwritten with the old one.
 */
export async function resealConnection(db: D1Database, connectionId: string, previous: string, resealed: string): Promise<void> {
  await db.prepare("UPDATE connections SET credentials = ? WHERE id = ? AND credentials = ?").bind(resealed, connectionId, previous).run();
}

// ---------- encryption key rotation ----------

/** Connections whose credentials aren't sealed with the current key. Random order, so one bad row can't block the rest. */
export async function staleConnections(db: D1Database, currentPattern: string, limit: number): Promise<Array<{ id: string; credentials: string }>> {
  const { results } = await db
    .prepare("SELECT id, credentials FROM connections WHERE credentials NOT LIKE ? ORDER BY RANDOM() LIMIT ?")
    .bind(currentPattern, limit)
    .all<{ id: string; credentials: string }>();
  return results;
}

export async function staleWebhooks(
  db: D1Database,
  currentPattern: string,
  limit: number,
): Promise<Array<{ user_id: string; slack_webhook: string | null; discord_webhook: string | null }>> {
  const { results } = await db
    .prepare(
      `SELECT user_id, slack_webhook, discord_webhook FROM settings
       WHERE (slack_webhook IS NOT NULL AND slack_webhook NOT LIKE ?1) OR (discord_webhook IS NOT NULL AND discord_webhook NOT LIKE ?1)
       ORDER BY RANDOM() LIMIT ?2`,
    )
    .bind(currentPattern, limit)
    .all<{ user_id: string; slack_webhook: string | null; discord_webhook: string | null }>();
  return results;
}

/** Same compare-and-swap rule as resealConnection: skipped if the user changed their webhooks meanwhile. */
export async function resealWebhooks(
  db: D1Database,
  userId: string,
  previous: { slack: string | null; discord: string | null },
  resealed: { slack: string | null; discord: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE settings SET slack_webhook = ?, discord_webhook = ? WHERE user_id = ? AND slack_webhook IS ? AND discord_webhook IS ?")
    .bind(resealed.slack, resealed.discord, userId, previous.slack, previous.discord)
    .run();
}

/** How many secrets still need re-encrypting with the current key. */
export async function countStaleSecrets(db: D1Database, currentPattern: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM connections WHERE credentials NOT LIKE ?1)
            + (SELECT COUNT(*) FROM settings WHERE (slack_webhook IS NOT NULL AND slack_webhook NOT LIKE ?1)
                                                OR (discord_webhook IS NOT NULL AND discord_webhook NOT LIKE ?1)) AS n`,
    )
    .bind(currentPattern)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateConnectionCredentials(
  db: D1Database,
  userId: string,
  connectionId: string,
  sealedCredentials: string,
  label: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE connections SET credentials = ?, label = ?, status = 'ok', last_error = NULL,
         failure_count = 0, next_sync_at = NULL, failure_notified_at = NULL
       WHERE id = ? AND user_id = ?`,
    )
    .bind(sealedCredentials, label, connectionId, userId)
    .run();
}

/** Connections whose turn it is, least recently checked first. Failing ones wait out their backoff. */
export async function connectionsDueForSync(db: D1Database, limit: number): Promise<ConnectionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.* FROM connections c
       WHERE c.store != 'demo' AND (c.next_sync_at IS NULL OR c.next_sync_at <= ?)
         AND EXISTS (SELECT 1 FROM apps a WHERE a.connection_id = c.id AND a.enabled = 1)
       ORDER BY COALESCE(c.last_synced_at, '1970-01-01') ASC LIMIT ?`,
    )
    .bind(nowIso(), limit)
    .all<ConnectionRow>();
  return results;
}

/**
 * Inserts apps the store reported. Newly seen apps start enabled only if the plan has room.
 * Sample apps are always enabled and never count toward the plan limit.
 */
export async function upsertApps(
  db: D1Database,
  userId: string,
  connectionId: string,
  store: Store,
  apps: StoreApp[],
  appLimit: number,
): Promise<void> {
  let enabledCount = await countEnabledApps(db, userId);
  const statements: D1PreparedStatement[] = [];
  for (const app of apps) {
    const enable = store === "demo" || enabledCount < appLimit ? 1 : 0;
    if (store !== "demo") enabledCount += enable;
    statements.push(
      db
        .prepare(
          `INSERT INTO apps (id, user_id, connection_id, store, store_app_id, name, bundle_id, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, store_app_id) DO UPDATE SET name = excluded.name, bundle_id = excluded.bundle_id`,
        )
        .bind(newId(), userId, connectionId, store, app.storeAppId, app.name, app.bundleId ?? null, enable),
    );
  }
  for (const group of chunk(statements, 50)) await db.batch(group);
}

export async function listApps(db: D1Database, userId: string): Promise<AppRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM apps WHERE user_id = ? ORDER BY enabled DESC, name")
    .bind(userId)
    .all<AppRow>();
  return results;
}

export async function listAppsForConnection(db: D1Database, connectionId: string): Promise<AppRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM apps WHERE connection_id = ? ORDER BY name")
    .bind(connectionId)
    .all<AppRow>();
  return results;
}

export async function listEnabledAppsForConnection(db: D1Database, connectionId: string): Promise<AppRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM apps WHERE connection_id = ? AND enabled = 1 ORDER BY name")
    .bind(connectionId)
    .all<AppRow>();
  return results;
}

export async function getApp(db: D1Database, userId: string, appId: string): Promise<AppRow | null> {
  return db.prepare("SELECT * FROM apps WHERE id = ? AND user_id = ?").bind(appId, userId).first<AppRow>();
}

/** Counts enabled real (non-sample) apps, which is what the plan limit applies to. */
export async function countEnabledApps(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM apps WHERE user_id = ? AND enabled = 1 AND store != 'demo'")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setAppEnabled(db: D1Database, userId: string, appId: string, enabled: boolean): Promise<void> {
  await db.prepare("UPDATE apps SET enabled = ? WHERE id = ? AND user_id = ?").bind(enabled ? 1 : 0, appId, userId).run();
}

/** Keeps only the oldest `limit` apps enabled (used when a subscription ends). */
export async function enforceAppLimit(db: D1Database, userId: string, limit: number): Promise<void> {
  await db
    .prepare(
      `UPDATE apps SET enabled = 0 WHERE user_id = ?1 AND enabled = 1 AND store != 'demo' AND id NOT IN (
         SELECT id FROM apps WHERE user_id = ?1 AND enabled = 1 AND store != 'demo' ORDER BY created_at LIMIT ?2)`,
    )
    .bind(userId, limit)
    .run();
}

export async function updateAppVersion(
  db: D1Database,
  appId: string,
  fields: { latestVersion?: string | null; autoRelease?: boolean; lastReviewAt?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE apps SET latest_version = COALESCE(?, latest_version), auto_release = COALESCE(?, auto_release),
         last_review_at = COALESCE(?, last_review_at) WHERE id = ?`,
    )
    .bind(
      fields.latestVersion ?? null,
      fields.autoRelease === undefined ? null : fields.autoRelease ? 1 : 0,
      fields.lastReviewAt ?? null,
      appId,
    )
    .run();
}

// ---------- reviews ----------

export type InboxView = "needs_reply" | "fix_pending" | "followups" | "done" | "all";

const VIEW_FILTERS: Record<InboxView, string> = {
  needs_reply: "r.status = 'open'",
  fix_pending: "r.status = 'fix_pending'",
  followups: "r.status = 'followup_ready'",
  done: "r.status IN ('done', 'followed_up')",
  all: "1 = 1",
};

export async function listInbox(
  db: D1Database,
  userId: string,
  options: { view: InboxView; appId?: string | null; issueId?: string | null; limit: number; offset: number },
): Promise<InboxReview[]> {
  const filters: string[] = [];
  const bindings: unknown[] = [userId];
  if (options.appId) {
    filters.push("AND r.app_id = ?");
    bindings.push(options.appId);
  }
  if (options.issueId) {
    filters.push("AND r.issue_id = ?");
    bindings.push(options.issueId);
  }
  bindings.push(options.limit, options.offset);
  const { results } = await db
    .prepare(
      `SELECT r.*, a.name AS app_name, i.title AS issue_title FROM reviews r JOIN apps a ON a.id = r.app_id AND a.enabled = 1
       LEFT JOIN issues i ON i.id = r.issue_id
       WHERE r.user_id = ? AND ${VIEW_FILTERS[options.view]} ${filters.join(" ")}
       ORDER BY r.reviewed_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings)
    .all<InboxReview>();
  return results;
}

export async function inboxCounts(db: D1Database, userId: string): Promise<Record<ReviewStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT r.status AS status, COUNT(*) AS n FROM reviews r JOIN apps a ON a.id = r.app_id AND a.enabled = 1
       WHERE r.user_id = ? GROUP BY r.status`,
    )
    .bind(userId)
    .all<{ status: ReviewStatus; n: number }>();
  const counts: Record<ReviewStatus, number> = { open: 0, done: 0, fix_pending: 0, followup_ready: 0, followed_up: 0 };
  for (const row of results) counts[row.status] = row.n;
  return counts;
}

export async function ratingWins(db: D1Database, userId: string): Promise<{ count: number; averageGain: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, AVG(rating - rating_before) AS gain FROM reviews
       WHERE user_id = ? AND rating_raised_at IS NOT NULL AND rating_before IS NOT NULL`,
    )
    .bind(userId)
    .first<{ n: number; gain: number | null }>();
  return { count: row?.n ?? 0, averageGain: row?.gain ?? 0 };
}

export async function getInboxReview(db: D1Database, userId: string, reviewId: string): Promise<InboxReview | null> {
  return db
    .prepare(
      `SELECT r.*, a.name AS app_name, i.title AS issue_title FROM reviews r JOIN apps a ON a.id = r.app_id
       LEFT JOIN issues i ON i.id = r.issue_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
    .bind(reviewId, userId)
    .first<InboxReview>();
}

type ReviewUpdate = Partial<
  Pick<
    ReviewRow,
    | "draft"
    | "category"
    | "summary"
    | "reply_text"
    | "reply_state"
    | "reply_error"
    | "replied_at"
    | "store_response_id"
    | "status"
    | "fix_note"
    | "fix_pending_at"
    | "fixed_in_version"
    | "followup_draft"
    | "followup_ai"
    | "followed_up_at"
    | "alerted_at"
    | "rating"
    | "rating_before"
    | "rating_raised_at"
    | "issue_id"
  >
>;

export async function updateReview(db: D1Database, reviewId: string, fields: ReviewUpdate): Promise<void> {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
  await db
    .prepare(`UPDATE reviews SET ${assignments}, updated_at = ? WHERE id = ?`)
    .bind(...entries.map(([, value]) => value), nowIso(), reviewId)
    .run();
}

export interface UpsertResult {
  inserted: ReviewRow[];
  raised: number;
  newestReviewAt: string | null;
}

type StoredReview = Pick<
  ReviewRow,
  "id" | "store_review_id" | "rating" | "title" | "body" | "reviewed_at" | "reply_text" | "reply_state" | "store_response_id" | "status" | "rating_before"
>;

/**
 * True when the store's copy differs from what we have. Syncs re-fetch recent reviews
 * every run, so skipping unchanged rows keeps D1 writes (100k/day on the free plan) low.
 */
export function reviewChanged(current: StoredReview, review: StoreReview): boolean {
  return (
    review.rating !== current.rating ||
    (review.title ?? null) !== (current.title ?? null) ||
    review.body !== current.body ||
    review.reviewedAt !== current.reviewed_at ||
    (review.reply !== null && review.reply.text !== current.reply_text) ||
    (review.reply?.id != null && review.reply.id !== current.store_response_id)
  );
}

/** Stores fetched reviews, detecting new ones, store-side replies and raised ratings. */
export async function upsertStoreReviews(
  db: D1Database,
  app: Pick<AppRow, "id" | "user_id" | "store">,
  reviews: StoreReview[],
): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: [], raised: 0, newestReviewAt: null };
  if (reviews.length === 0) return result;

  const existing = new Map<string, StoredReview>();
  for (const ids of chunk(reviews.map((r) => r.storeReviewId), 90)) {
    const { results } = await db
      .prepare(
        `SELECT id, store_review_id, rating, title, body, reviewed_at, reply_text, reply_state, store_response_id,
           status, rating_before
         FROM reviews WHERE app_id = ? AND store_review_id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(app.id, ...ids)
      .all<StoredReview>();
    for (const row of results) existing.set(row.store_review_id, row);
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const review of reviews) {
    if (!result.newestReviewAt || review.reviewedAt > result.newestReviewAt) result.newestReviewAt = review.reviewedAt;
    const current = existing.get(review.storeReviewId);
    if (!current) {
      const row: ReviewRow = {
        id: newId(),
        user_id: app.user_id,
        app_id: app.id,
        store: app.store,
        store_review_id: review.storeReviewId,
        rating: review.rating,
        rating_before: null,
        rating_raised_at: null,
        title: review.title,
        body: review.body,
        author: review.author,
        territory: review.territory,
        language: review.language,
        app_version: review.appVersion,
        device: review.device,
        reviewed_at: review.reviewedAt,
        category: null,
        summary: null,
        draft: null,
        reply_text: review.reply?.text ?? null,
        reply_state: review.reply ? "existing" : "none",
        reply_error: null,
        replied_at: review.reply?.repliedAt ?? null,
        store_response_id: review.reply?.id ?? null,
        status: review.reply ? "done" : "open",
        fix_note: null,
        fix_pending_at: null,
        fixed_in_version: null,
        followup_draft: null,
        followup_ai: 0,
        followed_up_at: null,
        alerted_at: null,
        issue_id: null,
        created_at: now,
        updated_at: now,
      };
      statements.push(
        db
          .prepare(
            `INSERT INTO reviews (id, user_id, app_id, store, store_review_id, rating, title, body, author, territory,
               language, app_version, device, reviewed_at, reply_text, reply_state, replied_at, store_response_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id, row.user_id, row.app_id, row.store, row.store_review_id, row.rating, row.title, row.body,
            row.author, row.territory, row.language, row.app_version, row.device, row.reviewed_at, row.reply_text,
            row.reply_state, row.replied_at, row.store_response_id, row.status,
          ),
      );
      result.inserted.push(row);
      continue;
    }

    if (!reviewChanged(current, review)) continue;

    // The reviewer raised their rating after we replied: that's the win we track.
    const raised = review.rating > current.rating && current.reply_state === "sent";
    if (raised) result.raised++;
    const replyAppeared = review.reply !== null && current.reply_state === "none";
    statements.push(
      db
        .prepare(
          `UPDATE reviews SET rating = ?, title = ?, body = ?, reviewed_at = ?,
             app_version = COALESCE(?, app_version), language = COALESCE(?, language), device = COALESCE(?, device),
             rating_before = CASE WHEN ? THEN COALESCE(rating_before, rating) ELSE rating_before END,
             rating_raised_at = CASE WHEN ? THEN ? ELSE rating_raised_at END,
             reply_text = COALESCE(?, reply_text),
             reply_state = CASE WHEN ? THEN 'existing' ELSE reply_state END,
             replied_at = CASE WHEN ? THEN ? ELSE replied_at END,
             store_response_id = COALESCE(?, store_response_id),
             status = CASE WHEN ? AND status = 'open' THEN 'done' ELSE status END,
             updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          review.rating, review.title, review.body, review.reviewedAt,
          review.appVersion, review.language, review.device,
          raised ? 1 : 0,
          raised ? 1 : 0, now,
          review.reply?.text ?? null,
          replyAppeared ? 1 : 0,
          replyAppeared ? 1 : 0, review.reply?.repliedAt ?? null,
          review.reply?.id ?? null,
          replyAppeared ? 1 : 0,
          now, current.id,
        ),
    );
  }
  for (const group of chunk(statements, 50)) await db.batch(group);
  return result;
}

export async function appReviewCounts(
  db: D1Database,
  userId: string,
): Promise<Map<string, { fix_pending: number; followups_ready: number }>> {
  const { results } = await db
    .prepare(
      `SELECT app_id,
         SUM(CASE WHEN status = 'fix_pending' THEN 1 ELSE 0 END) AS fix_pending,
         SUM(CASE WHEN status = 'followup_ready' THEN 1 ELSE 0 END) AS followups_ready
       FROM reviews WHERE user_id = ? GROUP BY app_id`,
    )
    .bind(userId)
    .all<{ app_id: string; fix_pending: number; followups_ready: number }>();
  return new Map(results.map((row) => [row.app_id, { fix_pending: row.fix_pending, followups_ready: row.followups_ready }]));
}

export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

export async function reviewsAwaitingFix(db: D1Database, appId: string): Promise<ReviewRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM reviews WHERE app_id = ? AND status = 'fix_pending' ORDER BY reviewed_at")
    .bind(appId)
    .all<ReviewRow>();
  return results;
}

export async function followupsReady(db: D1Database, appId: string): Promise<InboxReview[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, a.name AS app_name FROM reviews r JOIN apps a ON a.id = r.app_id
       WHERE r.app_id = ? AND r.status = 'followup_ready' ORDER BY r.reviewed_at`,
    )
    .bind(appId)
    .all<InboxReview>();
  return results;
}

export async function followupsNeedingAi(db: D1Database, limit: number): Promise<ReviewRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM reviews WHERE status = 'followup_ready' AND followup_ai = 0 ORDER BY updated_at LIMIT ?")
    .bind(limit)
    .all<ReviewRow>();
  return results;
}

export async function reviewsToAlert(db: D1Database, userId: string, maxRating: number): Promise<InboxReview[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, a.name AS app_name FROM reviews r JOIN apps a ON a.id = r.app_id AND a.enabled = 1
       WHERE r.user_id = ? AND r.alerted_at IS NULL AND r.status = 'open' AND r.rating <= ?
       ORDER BY r.reviewed_at DESC LIMIT 20`,
    )
    .bind(userId, maxRating)
    .all<InboxReview>();
  return results;
}

export async function markAlerted(db: D1Database, reviewIds: string[]): Promise<void> {
  const now = nowIso();
  for (const ids of chunk(reviewIds, 90)) {
    await db
      .prepare(`UPDATE reviews SET alerted_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(now, ...ids)
      .run();
  }
}

// ---------- releases ----------

export async function listReleases(db: D1Database, userId: string): Promise<Array<ReleaseRow & { app_name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT rel.*, a.name AS app_name FROM releases rel JOIN apps a ON a.id = rel.app_id
       WHERE a.user_id = ? ORDER BY rel.released_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<ReleaseRow & { app_name: string }>();
  return results;
}

/** Returns true if this version wasn't recorded before. */
export async function recordRelease(
  db: D1Database,
  appId: string,
  version: string,
  source: ReleaseRow["source"],
): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO releases (id, app_id, version, released_at, source) VALUES (?, ?, ?, ?, ?)")
    .bind(newId(), appId, version, nowIso(), source)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setReleaseFollowups(db: D1Database, appId: string, version: string, count: number): Promise<void> {
  await db
    .prepare("UPDATE releases SET followups_created = ? WHERE app_id = ? AND version = ?")
    .bind(count, appId, version)
    .run();
}

// ---------- usage & billing ----------

export async function aiDraftsThisMonth(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT ai_drafts FROM usage WHERE user_id = ? AND month = ?")
    .bind(userId, currentMonth())
    .first<{ ai_drafts: number }>();
  return row?.ai_drafts ?? 0;
}

export async function incrementAiDrafts(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage (user_id, month, ai_drafts) VALUES (?, ?, 1)
       ON CONFLICT (user_id, month) DO UPDATE SET ai_drafts = ai_drafts + 1`,
    )
    .bind(userId, currentMonth())
    .run();
}

// ---------- AI spending cap ----------

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Reserves one AI draft against today's caps, atomically. Returns false when the
 * day's free or total cap is used up. A cap of 0 turns those drafts off.
 */
export async function reserveAiDraft(
  db: D1Database,
  free: boolean,
  caps: { free: number; total: number },
  day = utcDay(),
): Promise<boolean> {
  if (caps.total <= 0 || (free && caps.free <= 0)) return false;
  const result = await db
    .prepare(
      `INSERT INTO ai_daily (day, free_drafts, total_drafts) VALUES (?1, ?2, 1)
       ON CONFLICT (day) DO UPDATE SET free_drafts = free_drafts + ?2, total_drafts = total_drafts + 1
       WHERE total_drafts < ?3 AND (?2 = 0 OR free_drafts < ?4)`,
    )
    .bind(day, free ? 1 : 0, caps.total, caps.free)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Gives back a reservation when the AI call failed. */
export async function releaseAiDraft(db: D1Database, free: boolean, day = utcDay()): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_daily SET total_drafts = MAX(0, total_drafts - 1), free_drafts = MAX(0, free_drafts - ?2)
       WHERE day = ?1`,
    )
    .bind(day, free ? 1 : 0)
    .run();
}

export async function recordAiTokens(db: D1Database, inputTokens: number, outputTokens: number, day = utcDay()): Promise<void> {
  await db
    .prepare("UPDATE ai_daily SET input_tokens = input_tokens + ?2, output_tokens = output_tokens + ?3 WHERE day = ?1")
    .bind(day, inputTokens, outputTokens)
    .run();
}

export interface AiUsage {
  free_drafts: number;
  total_drafts: number;
  input_tokens: number;
  output_tokens: number;
}

export async function aiUsageSince(db: D1Database, fromDay: string): Promise<AiUsage> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(free_drafts), 0) AS free_drafts, COALESCE(SUM(total_drafts), 0) AS total_drafts,
         COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM ai_daily WHERE day >= ?`,
    )
    .bind(fromDay)
    .first<AiUsage>();
  return row ?? { free_drafts: 0, total_drafts: 0, input_tokens: 0, output_tokens: 0 };
}

// ---------- housekeeping ----------

/** Deletes expired sessions and old webhook, AI-usage and security-log records. */
export async function cleanupExpired(db: D1Database, now = new Date()): Promise<void> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()),
    db.prepare("DELETE FROM billing_events WHERE received_at < ?").bind(daysAgo(90)),
    db.prepare("DELETE FROM ai_daily WHERE day < ?").bind(daysAgo(400).slice(0, 10)),
    db.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(daysAgo(180)),
  ]);
}

export async function markSampleLoaded(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE users SET sample_loaded_at = COALESCE(sample_loaded_at, ?) WHERE id = ?")
    .bind(nowIso(), userId)
    .run();
}

// ---------- founder dashboard ----------

export interface AdminMetrics {
  users: { total: number; new7: number; new30: number; triedSample: number; connected: number; plus: number; pro: number };
  activity: {
    replies7: number;
    replies30: number;
    followups30: number;
    fixPending: number;
    raisedAll: number;
    raised30: number;
    averageGain: number;
  };
  funnel: {
    signedUp: number;
    triedSample: number;
    connected: number;
    replied: number;
    trackedFix: number;
    followedUp: number;
    paid: number;
  };
  failing: Array<{ login: string; label: string; store: string; last_error: string | null; failure_count: number; next_sync_at: string | null }>;
  recent: Array<{ login: string; created_at: string; plan: string; connections: number; replies: number }>;
}

/** Real-store numbers only: sample workspace activity is excluded everywhere except "tried sample". */
export async function adminMetrics(db: D1Database, now = new Date()): Promise<AdminMetrics> {
  const ago = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  const d7 = ago(7);
  const d30 = ago(30);
  // Paid plans stay active for 3 days past the paid-through date (see currentPlan).
  const paidCutoff = ago(3);

  const [users, connected, activity, funnel, failing, recent] = await db.batch<Record<string, number | string | null>>([
    db
      .prepare(
        `SELECT COUNT(*) AS total,
           COALESCE(SUM(created_at >= ?1), 0) AS new7,
           COALESCE(SUM(created_at >= ?2), 0) AS new30,
           COALESCE(SUM(sample_loaded_at IS NOT NULL), 0) AS triedSample,
           COALESCE(SUM(plan = 'plus' AND (plan_renews_at IS NULL OR plan_renews_at > ?3)), 0) AS plus,
           COALESCE(SUM(plan = 'pro' AND (plan_renews_at IS NULL OR plan_renews_at > ?3)), 0) AS pro
         FROM users`,
      )
      .bind(d7, d30, paidCutoff),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS connected FROM connections WHERE store != 'demo'"),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(reply_state = 'sent' AND replied_at >= ?1), 0) AS replies7,
           COALESCE(SUM(reply_state = 'sent' AND replied_at >= ?2), 0) AS replies30,
           COALESCE(SUM(followed_up_at >= ?2), 0) AS followups30,
           COALESCE(SUM(status = 'fix_pending'), 0) AS fixPending,
           COALESCE(SUM(rating_raised_at IS NOT NULL), 0) AS raisedAll,
           COALESCE(SUM(rating_raised_at >= ?2), 0) AS raised30,
           COALESCE(AVG(CASE WHEN rating_raised_at IS NOT NULL THEN rating - rating_before END), 0) AS averageGain
         FROM reviews WHERE store != 'demo'`,
      )
      .bind(d7, d30),
    db
      .prepare(
        `SELECT COUNT(*) AS signedUp,
           COALESCE(SUM(u.sample_loaded_at IS NOT NULL), 0) AS triedSample,
           COALESCE(SUM(EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.store != 'demo')), 0) AS connected,
           COALESCE(SUM(EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = u.id AND r.store != 'demo' AND r.reply_state = 'sent')), 0) AS replied,
           COALESCE(SUM(EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = u.id AND r.store != 'demo' AND r.fix_pending_at IS NOT NULL)), 0) AS trackedFix,
           COALESCE(SUM(EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = u.id AND r.store != 'demo' AND r.followed_up_at IS NOT NULL)), 0) AS followedUp,
           COALESCE(SUM(u.plan IN ('plus', 'pro')), 0) AS paid
         FROM users u WHERE u.created_at >= ?1`,
      )
      .bind(d30),
    db.prepare(
      `SELECT u.login, c.label, c.store, c.last_error, c.failure_count, c.next_sync_at
       FROM connections c JOIN users u ON u.id = c.user_id
       WHERE c.status = 'error' ORDER BY c.failure_count DESC LIMIT 20`,
    ),
    db.prepare(
      `SELECT u.login, u.created_at, u.plan,
         (SELECT COUNT(*) FROM connections c WHERE c.user_id = u.id AND c.store != 'demo') AS connections,
         (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id AND r.store != 'demo' AND r.reply_state = 'sent') AS replies
       FROM users u ORDER BY u.created_at DESC LIMIT 20`,
    ),
  ]);

  const one = (result: D1Result<Record<string, number | string | null>>) => result.results[0] ?? {};
  const num = (value: unknown) => Number(value ?? 0);
  const u = one(users);
  const a = one(activity);
  const f = one(funnel);
  return {
    users: {
      total: num(u.total),
      new7: num(u.new7),
      new30: num(u.new30),
      triedSample: num(u.triedSample),
      connected: num(one(connected).connected),
      plus: num(u.plus),
      pro: num(u.pro),
    },
    activity: {
      replies7: num(a.replies7),
      replies30: num(a.replies30),
      followups30: num(a.followups30),
      fixPending: num(a.fixPending),
      raisedAll: num(a.raisedAll),
      raised30: num(a.raised30),
      averageGain: num(a.averageGain),
    },
    funnel: {
      signedUp: num(f.signedUp),
      triedSample: num(f.triedSample),
      connected: num(f.connected),
      replied: num(f.replied),
      trackedFix: num(f.trackedFix),
      followedUp: num(f.followedUp),
      paid: num(f.paid),
    },
    failing: failing.results as unknown as AdminMetrics["failing"],
    recent: recent.results as unknown as AdminMetrics["recent"],
  };
}

/** Returns false if this webhook id was already processed. */
export async function claimBillingEvent(db: D1Database, eventId: string, type: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO billing_events (id, type) VALUES (?, ?)")
    .bind(eventId, type)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateBilling(
  db: D1Database,
  userId: string,
  fields: {
    plan: Plan;
    status: string;
    renewsAt: string | null;
    customerId: string | null;
    subscriptionId: string | null;
    /** A booked downgrade has taken effect or no longer applies. */
    clearScheduled: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET plan = ?, plan_status = ?, plan_renews_at = ?,
         billing_customer_id = COALESCE(?, billing_customer_id),
         billing_subscription_id = COALESCE(?, billing_subscription_id),
         plan_scheduled = CASE WHEN ? THEN NULL ELSE plan_scheduled END
       WHERE id = ?`,
    )
    .bind(fields.plan, fields.status, fields.renewsAt, fields.customerId, fields.subscriptionId, fields.clearScheduled ? 1 : 0, userId)
    .run();
}

export async function setScheduledPlan(db: D1Database, userId: string, plan: PaidPlan | null): Promise<void> {
  await db.prepare("UPDATE users SET plan_scheduled = ? WHERE id = ?").bind(plan, userId).run();
}

export async function findUserForBilling(
  db: D1Database,
  lookup: { userId?: string | null; subscriptionId?: string | null; customerId?: string | null; email?: string | null },
): Promise<UserRow | null> {
  if (lookup.userId) {
    const user = await getUser(db, lookup.userId);
    if (user) return user;
  }
  if (lookup.subscriptionId) {
    const user = await db
      .prepare("SELECT * FROM users WHERE billing_subscription_id = ?")
      .bind(lookup.subscriptionId)
      .first<UserRow>();
    if (user) return user;
  }
  if (lookup.customerId) {
    const user = await db.prepare("SELECT * FROM users WHERE billing_customer_id = ?").bind(lookup.customerId).first<UserRow>();
    if (user) return user;
  }
  if (lookup.email) {
    return db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").bind(lookup.email).first<UserRow>();
  }
  return null;
}

import type { ReleaseRow } from "../env";
import { nowIso } from "../lib/util";

/**
 * Loop metrics per app. Ratings are counted from each reviewer's original rating, and reply speed
 * from when the review first arrived (created_at): edits change reviewed_at, which would bias both.
 */
export interface AppLoopRow {
  app_id: string;
  low: number;
  low_replied: number;
  sent_replies: number;
  sent_fast: number;
  followed: number;
  followed_raised: number;
  sent_raised: number;
  raised_total: number;
  gain_sum: number;
  new_rating_sum: number;
}

export async function appLoopMetrics(
  db: D1Database,
  sinceIso: string,
  scope: { userId?: string } = {},
): Promise<AppLoopRow[]> {
  const userFilter = scope.userId ? "AND r.user_id = ?" : "";
  const bindings: unknown[] = [sinceIso];
  if (scope.userId) bindings.push(scope.userId);
  const { results } = await db
    .prepare(
      `SELECT r.app_id,
         COALESCE(SUM(COALESCE(r.rating_before, r.rating) <= 2), 0) AS low,
         COALESCE(SUM(COALESCE(r.rating_before, r.rating) <= 2 AND r.reply_state IN ('sent', 'existing')), 0) AS low_replied,
         COALESCE(SUM(r.reply_state = 'sent'), 0) AS sent_replies,
         COALESCE(SUM(r.reply_state = 'sent' AND julianday(r.replied_at) - julianday(r.created_at) <= 2), 0) AS sent_fast,
         COALESCE(SUM(r.followed_up_at IS NOT NULL), 0) AS followed,
         COALESCE(SUM(r.followed_up_at IS NOT NULL AND r.rating_raised_at IS NOT NULL), 0) AS followed_raised,
         COALESCE(SUM(r.reply_state = 'sent' AND r.rating_raised_at IS NOT NULL), 0) AS sent_raised,
         COALESCE(SUM(r.rating_raised_at IS NOT NULL), 0) AS raised_total,
         COALESCE(SUM(CASE WHEN r.rating_raised_at IS NOT NULL THEN r.rating - r.rating_before ELSE 0 END), 0) AS gain_sum,
         COALESCE(SUM(CASE WHEN r.rating_raised_at IS NOT NULL THEN r.rating ELSE 0 END), 0) AS new_rating_sum
       FROM reviews r
       WHERE r.store != 'demo' AND r.created_at >= ? ${userFilter}
       GROUP BY r.app_id`,
    )
    .bind(...bindings)
    .all<AppLoopRow>();
  return results;
}

/** Raised-rating counts for replies with and without each trait, across all real-store replies we sent. */
export interface TraitCounts {
  n_fast: number;
  r_fast: number;
  n_slow: number;
  r_slow: number;
  n_version: number;
  r_version: number;
  n_no_version: number;
  r_no_version: number;
  n_sorry: number;
  r_sorry: number;
  n_no_sorry: number;
  r_no_sorry: number;
  n_followup: number;
  r_followup: number;
  n_first: number;
  r_first: number;
  n_long: number;
  r_long: number;
  n_short: number;
  r_short: number;
}

export async function replyTraitCounts(db: D1Database, sinceIso: string): Promise<TraitCounts> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(fast), 0) AS n_fast, COALESCE(SUM(fast AND raised), 0) AS r_fast,
         COALESCE(SUM(NOT fast), 0) AS n_slow, COALESCE(SUM(NOT fast AND raised), 0) AS r_slow,
         COALESCE(SUM(version), 0) AS n_version, COALESCE(SUM(version AND raised), 0) AS r_version,
         COALESCE(SUM(NOT version), 0) AS n_no_version, COALESCE(SUM(NOT version AND raised), 0) AS r_no_version,
         COALESCE(SUM(sorry), 0) AS n_sorry, COALESCE(SUM(sorry AND raised), 0) AS r_sorry,
         COALESCE(SUM(NOT sorry), 0) AS n_no_sorry, COALESCE(SUM(NOT sorry AND raised), 0) AS r_no_sorry,
         COALESCE(SUM(followup), 0) AS n_followup, COALESCE(SUM(followup AND raised), 0) AS r_followup,
         COALESCE(SUM(NOT followup), 0) AS n_first, COALESCE(SUM(NOT followup AND raised), 0) AS r_first,
         COALESCE(SUM(long_reply), 0) AS n_long, COALESCE(SUM(long_reply AND raised), 0) AS r_long,
         COALESCE(SUM(NOT long_reply), 0) AS n_short, COALESCE(SUM(NOT long_reply AND raised), 0) AS r_short
       FROM (
         SELECT
           (julianday(replied_at) - julianday(created_at) <= 1) AS fast,
           (reply_text GLOB '*[0-9].[0-9]*') AS version,
           (lower(reply_text) LIKE '%sorry%' OR lower(reply_text) LIKE '%apolog%') AS sorry,
           (followed_up_at IS NOT NULL) AS followup,
           (length(reply_text) >= 200) AS long_reply,
           (rating_raised_at IS NOT NULL) AS raised
         FROM reviews
         WHERE store != 'demo' AND reply_state = 'sent' AND reply_text IS NOT NULL
           AND COALESCE(rating_before, rating) <= 3 AND replied_at >= ?
       )`,
    )
    .bind(sinceIso)
    .first<TraitCounts>();
  return row ?? EMPTY_TRAITS;
}

const EMPTY_TRAITS: TraitCounts = {
  n_fast: 0, r_fast: 0, n_slow: 0, r_slow: 0, n_version: 0, r_version: 0, n_no_version: 0, r_no_version: 0,
  n_sorry: 0, r_sorry: 0, n_no_sorry: 0, r_no_sorry: 0, n_followup: 0, r_followup: 0, n_first: 0, r_first: 0,
  n_long: 0, r_long: 0, n_short: 0, r_short: 0,
};

export async function readBenchmarks<T>(db: D1Database): Promise<{ computedAt: string; data: T } | null> {
  const row = await db.prepare("SELECT computed_at, data FROM benchmarks WHERE id = 1").first<{ computed_at: string; data: string }>();
  return row ? { computedAt: row.computed_at, data: JSON.parse(row.data) as T } : null;
}

export async function writeBenchmarks(db: D1Database, data: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO benchmarks (id, computed_at, data) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data`,
    )
    .bind(nowIso(), JSON.stringify(data))
    .run();
}

/** Up to `limit` replies from this developer that were followed by the reviewer raising their rating. */
export async function repliesThatWorked(
  db: D1Database,
  userId: string,
  appId: string,
  limit = 3,
): Promise<Array<{ rating_before: number; rating: number; title: string | null; body: string; reply_text: string }>> {
  const { results } = await db
    .prepare(
      `SELECT rating_before, rating, title, body, reply_text FROM reviews
       WHERE user_id = ? AND store != 'demo' AND reply_state = 'sent' AND rating_raised_at IS NOT NULL
         AND rating_before IS NOT NULL AND reply_text IS NOT NULL
       ORDER BY (app_id = ?) DESC, rating_raised_at DESC LIMIT ?`,
    )
    .bind(userId, appId, limit)
    .all<{ rating_before: number; rating: number; title: string | null; body: string; reply_text: string }>();
  return results;
}

// ---------- release guard ----------

export async function releasesToGuard(
  db: D1Database,
  sinceIso: string,
  limit: number,
): Promise<Array<ReleaseRow & { user_id: string; app_name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT rel.*, a.user_id, a.name AS app_name FROM releases rel JOIN apps a ON a.id = rel.app_id
       WHERE rel.released_at >= ? AND a.store != 'demo' AND COALESCE(rel.guard_status, 'ok') != 'spike'
       ORDER BY COALESCE(rel.guard_checked_at, '1970-01-01') ASC LIMIT ?`,
    )
    .bind(sinceIso, limit)
    .all<ReleaseRow & { user_id: string; app_name: string }>();
  return results;
}

/**
 * Reviews that first arrived in [from, to). Old reviews imported late or edited late are
 * excluded by also requiring the review itself to be recent.
 */
export async function windowRatings(
  db: D1Database,
  appId: string,
  fromIso: string,
  toIso: string,
): Promise<{ total: number; low: number; titles: string[] }> {
  const reviewedAfter = new Date(Date.parse(fromIso) - 24 * 3600 * 1000).toISOString();
  const stats = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(rating_before, rating) <= 2), 0) AS low FROM reviews
       WHERE app_id = ? AND created_at >= ? AND created_at < ? AND reviewed_at >= ?`,
    )
    .bind(appId, fromIso, toIso, reviewedAfter)
    .first<{ total: number; low: number }>();
  const { results } = await db
    .prepare(
      `SELECT COALESCE(summary, title, substr(body, 1, 80)) AS label FROM reviews
       WHERE app_id = ? AND created_at >= ? AND created_at < ? AND reviewed_at >= ? AND COALESCE(rating_before, rating) <= 2
       ORDER BY created_at DESC LIMIT 3`,
    )
    .bind(appId, fromIso, toIso, reviewedAfter)
    .all<{ label: string }>();
  return { total: stats?.total ?? 0, low: stats?.low ?? 0, titles: results.map((row) => row.label).filter(Boolean) };
}

export async function recordGuard(
  db: D1Database,
  releaseId: string,
  verdict: { status: "ok" | "spike"; ratio: number; low: number },
): Promise<void> {
  await db
    .prepare("UPDATE releases SET guard_status = ?, guard_ratio = ?, guard_low = ?, guard_checked_at = ? WHERE id = ?")
    .bind(verdict.status, verdict.ratio, verdict.low, nowIso(), releaseId)
    .run();
}

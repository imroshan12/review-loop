import type { AppRow, InboxReview, IssueRow } from "../env";
import { newId, nowIso } from "../lib/util";

/** Stars are counted from each reviewer's original rating, so a later raise doesn't hide the cost. */
export interface IssueWithStats extends IssueRow {
  app_name: string;
  reports: number;
  avg_rating: number;
  star_debt: number;
  replied: number;
  followed_up: number;
  raised: number;
  stars_recovered: number;
  /** When reviewers were first told a fix is coming: replied to and in the issue, whichever came later. */
  promised_at: string | null;
}

const ISSUE_STATS = `
  COUNT(r.id) AS reports,
  COALESCE(AVG(COALESCE(r.rating_before, r.rating)), 0) AS avg_rating,
  COALESCE(SUM(5 - COALESCE(r.rating_before, r.rating)), 0) AS star_debt,
  COALESCE(SUM(r.reply_state IN ('sent', 'existing')), 0) AS replied,
  COALESCE(SUM(r.followed_up_at IS NOT NULL), 0) AS followed_up,
  COALESCE(SUM(r.rating_raised_at IS NOT NULL), 0) AS raised,
  COALESCE(SUM(CASE WHEN r.rating_raised_at IS NOT NULL THEN r.rating - r.rating_before ELSE 0 END), 0) AS stars_recovered,
  MIN(CASE WHEN r.reply_state IN ('sent', 'existing') THEN MAX(r.replied_at, r.fix_pending_at) END) AS promised_at`;

export async function listIssues(db: D1Database, userId: string, status: "open" | "shipped"): Promise<IssueWithStats[]> {
  const order = status === "open" ? "star_debt DESC, i.created_at ASC" : "i.shipped_at DESC";
  const { results } = await db
    .prepare(
      `SELECT i.*, a.name AS app_name, ${ISSUE_STATS}
       FROM issues i JOIN apps a ON a.id = i.app_id
       LEFT JOIN reviews r ON r.issue_id = i.id
       WHERE i.user_id = ? AND i.status = ?
       GROUP BY i.id ORDER BY ${order} LIMIT 200`,
    )
    .bind(userId, status)
    .all<IssueWithStats>();
  return results;
}

export async function issueCounts(db: D1Database, userId: string): Promise<{ open: number; shipped: number }> {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM issues WHERE user_id = ? GROUP BY status")
    .bind(userId)
    .all<{ status: IssueRow["status"]; n: number }>();
  const counts = { open: 0, shipped: 0 };
  for (const row of results) counts[row.status] = row.n;
  return counts;
}

export async function getIssue(db: D1Database, userId: string, issueId: string): Promise<IssueRow | null> {
  return db.prepare("SELECT * FROM issues WHERE id = ? AND user_id = ?").bind(issueId, userId).first<IssueRow>();
}

/** Removes an open issue once its last review has been taken out, so empty issues don't linger or ship. */
export async function deleteIssueIfEmpty(db: D1Database, issueId: string): Promise<void> {
  await db
    .prepare("DELETE FROM issues WHERE id = ? AND status = 'open' AND NOT EXISTS (SELECT 1 FROM reviews WHERE issue_id = ?)")
    .bind(issueId, issueId)
    .run();
}

export async function getIssueWithStats(db: D1Database, userId: string, issueId: string): Promise<IssueWithStats | null> {
  return db
    .prepare(
      `SELECT i.*, a.name AS app_name, ${ISSUE_STATS}
       FROM issues i JOIN apps a ON a.id = i.app_id
       LEFT JOIN reviews r ON r.issue_id = i.id
       WHERE i.id = ? AND i.user_id = ? GROUP BY i.id`,
    )
    .bind(issueId, userId)
    .first<IssueWithStats>();
}

/** Open issues with report counts, for the "add to issue" menus in the inbox. */
export async function openIssues(db: D1Database, userId: string): Promise<Array<IssueRow & { reports: number }>> {
  const { results } = await db
    .prepare(
      `SELECT i.*, COUNT(r.id) AS reports FROM issues i LEFT JOIN reviews r ON r.issue_id = i.id
       WHERE i.user_id = ? AND i.status = 'open' GROUP BY i.id ORDER BY i.updated_at DESC LIMIT 200`,
    )
    .bind(userId)
    .all<IssueRow & { reports: number }>();
  return results;
}

export async function createIssue(
  db: D1Database,
  fields: { userId: string; appId: string; title: string; fixNote: string | null; targetVersion: string | null },
): Promise<string> {
  const id = newId();
  await db
    .prepare("INSERT INTO issues (id, user_id, app_id, title, fix_note, target_version) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, fields.userId, fields.appId, fields.title, fields.fixNote, fields.targetVersion)
    .run();
  return id;
}

/** Updates an open issue and keeps its waiting reviews in step (follow-ups quote the fix note). */
export async function updateIssue(
  db: D1Database,
  userId: string,
  issueId: string,
  fields: { title: string; fixNote: string | null; targetVersion: string | null },
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE issues SET title = ?, fix_note = ?, target_version = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'")
      .bind(fields.title, fields.fixNote, fields.targetVersion, nowIso(), issueId, userId),
    db
      .prepare("UPDATE reviews SET fix_note = ?, fixed_in_version = ?, updated_at = ? WHERE issue_id = ? AND user_id = ? AND status = 'fix_pending'")
      .bind(fields.fixNote, fields.targetVersion, nowIso(), issueId, userId),
  ]);
}

export async function openIssuesForApp(db: D1Database, appId: string): Promise<IssueRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM issues WHERE app_id = ? AND status = 'open'")
    .bind(appId)
    .all<IssueRow>();
  return results;
}

export async function markIssueShipped(db: D1Database, issueId: string, version: string): Promise<void> {
  await db
    .prepare("UPDATE issues SET status = 'shipped', shipped_version = ?, shipped_at = ?, updated_at = ? WHERE id = ? AND status = 'open'")
    .bind(version, nowIso(), nowIso(), issueId)
    .run();
}

/** Recently shipped issues with their release, for the "What's New" drafts on the Releases page. */
export async function recentlyShippedIssues(
  db: D1Database,
  userId: string,
  limit = 200,
): Promise<Array<{ app_id: string; shipped_version: string; title: string; reports: number }>> {
  const { results } = await db
    .prepare(
      `SELECT i.app_id, i.shipped_version, i.title, COUNT(r.id) AS reports FROM issues i LEFT JOIN reviews r ON r.issue_id = i.id
       WHERE i.user_id = ? AND i.status = 'shipped' AND i.shipped_version IS NOT NULL
       GROUP BY i.id ORDER BY i.shipped_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<{ app_id: string; shipped_version: string; title: string; reports: number }>();
  return results;
}

/**
 * Open issues whose reviewers were told a fix was coming before the cutoff, with no reminder sent yet.
 * A promise starts once a review is both replied to and in the issue, so linking a review that was
 * answered long ago doesn't count as an old promise.
 */
export async function overduePromises(
  db: D1Database,
  cutoffIso: string,
  limit: number,
): Promise<Array<IssueRow & { app_name: string; told: number; promised_at: string }>> {
  const { results } = await db
    .prepare(
      `SELECT i.*, a.name AS app_name, COUNT(r.id) AS told, MIN(MAX(r.replied_at, r.fix_pending_at)) AS promised_at
       FROM issues i JOIN apps a ON a.id = i.app_id
       JOIN reviews r ON r.issue_id = i.id AND r.reply_state IN ('sent', 'existing')
       WHERE i.status = 'open' AND i.reminded_at IS NULL AND a.store != 'demo'
       GROUP BY i.id HAVING MIN(MAX(r.replied_at, r.fix_pending_at)) < ? LIMIT ?`,
    )
    .bind(cutoffIso, limit)
    .all<IssueRow & { app_name: string; told: number; promised_at: string }>();
  return results;
}

export async function markReminded(db: D1Database, issueId: string): Promise<void> {
  await db.prepare("UPDATE issues SET reminded_at = ? WHERE id = ?").bind(nowIso(), issueId).run();
}

/** Recent unlinked low-star reviews of an app: candidates to group into an issue. */
export async function groupingCandidates(db: D1Database, userId: string, appId: string): Promise<InboxReview[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, a.name AS app_name FROM reviews r JOIN apps a ON a.id = r.app_id
       WHERE r.user_id = ? AND r.app_id = ? AND r.issue_id IS NULL AND r.status IN ('open', 'done')
         AND COALESCE(r.rating_before, r.rating) <= 3
       ORDER BY r.reviewed_at DESC LIMIT 200`,
    )
    .bind(userId, appId)
    .all<InboxReview>();
  return results;
}

// ---------- public fix log ----------

export async function setPublicLog(db: D1Database, userId: string, appId: string, enabled: boolean, slug: string): Promise<void> {
  await db
    .prepare("UPDATE apps SET public_log = ?, public_slug = COALESCE(public_slug, ?) WHERE id = ? AND user_id = ?")
    .bind(enabled ? 1 : 0, slug, appId, userId)
    .run();
}

export async function publicAppBySlug(db: D1Database, slug: string): Promise<AppRow | null> {
  return db.prepare("SELECT * FROM apps WHERE public_slug = ? AND public_log = 1").bind(slug).first<AppRow>();
}

export interface PublicFix {
  title: string;
  shipped_version: string | null;
  shipped_at: string | null;
  reports: number;
  raised: number;
  stars_recovered: number;
}

/** Totals for the badge: shipped issues and stars won back from their reviewers. */
export async function publicFixTotals(db: D1Database, appId: string): Promise<{ fixed: number; stars: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT i.id) AS fixed,
         COALESCE(SUM(CASE WHEN r.rating_raised_at IS NOT NULL THEN r.rating - r.rating_before ELSE 0 END), 0) AS stars
       FROM issues i LEFT JOIN reviews r ON r.issue_id = i.id
       WHERE i.app_id = ? AND i.status = 'shipped'`,
    )
    .bind(appId)
    .first<{ fixed: number; stars: number }>();
  return { fixed: row?.fixed ?? 0, stars: row?.stars ?? 0 };
}

/** Only what the developer wrote (issue titles) and counts: no reviewer names or review text. */
export async function publicFixes(db: D1Database, appId: string): Promise<PublicFix[]> {
  const { results } = await db
    .prepare(
      `SELECT i.title, i.shipped_version, i.shipped_at, COUNT(r.id) AS reports,
         COALESCE(SUM(r.rating_raised_at IS NOT NULL), 0) AS raised,
         COALESCE(SUM(CASE WHEN r.rating_raised_at IS NOT NULL THEN r.rating - r.rating_before ELSE 0 END), 0) AS stars_recovered
       FROM issues i LEFT JOIN reviews r ON r.issue_id = i.id
       WHERE i.app_id = ? AND i.status = 'shipped'
       GROUP BY i.id ORDER BY i.shipped_at DESC LIMIT 100`,
    )
    .bind(appId)
    .all<PublicFix>();
  return results;
}

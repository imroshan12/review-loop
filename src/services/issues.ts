import * as db from "../db";
import type { Bindings, InboxReview, IssueRow, UserRow } from "../env";
import { rankBySimilarity, type Scored } from "../lib/similarity";
import { nowIso } from "../lib/util";
import * as issuesDb from "../queries/issues";
import { UserFacingError } from "./reviews";

export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.\-+ ()]{0,39}$/;

export interface LinkRequest {
  issueId?: string | null;
  title?: string | null;
  note?: string | null;
  version?: string | null;
}

function clean(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim().slice(0, max);
  return trimmed || null;
}

/** A short default title for a new issue, from the AI summary, the review title or the first sentence. */
export function suggestTitle(review: Pick<InboxReview, "summary" | "title" | "body">): string {
  const source = review.summary?.trim() || review.title?.trim() || review.body.split(/[.!?\n]/)[0].trim() || "Reported problem";
  return source.length > 80 ? `${source.slice(0, 79)}…` : source;
}

function reviewText(review: Pick<InboxReview, "title" | "body" | "summary">): string {
  return [review.title, review.summary, review.body].filter(Boolean).join(" ");
}

/** The open issue in the same app that this review most likely belongs to, if any. */
export function suggestIssue(
  review: Pick<InboxReview, "app_id" | "title" | "body" | "summary">,
  issues: Array<Pick<IssueRow, "id" | "app_id" | "title" | "fix_note">>,
): string | null {
  const candidates = issues
    .filter((issue) => issue.app_id === review.app_id)
    .map((issue) => ({ item: issue.id, text: `${issue.title} ${issue.fix_note ?? ""}` }));
  return rankBySimilarity(reviewText(review), candidates)[0]?.item ?? null;
}

/** Marks a review "fix pending" by linking it to an existing open issue or a new one. */
export async function linkReviewToIssue(env: Bindings, user: UserRow, review: InboxReview, request: LinkRequest): Promise<IssueRow> {
  if (review.status === "followed_up") throw new UserFacingError("You've already followed up on this review.", 409);
  const note = clean(request.note, 500);
  const version = clean(request.version, 40);
  if (version && !VERSION_PATTERN.test(version)) throw new UserFacingError("Enter a version like 2.3.1.");

  let issue: IssueRow | null;
  if (request.issueId) {
    issue = await issuesDb.getIssue(env.DB, user.id, request.issueId);
    if (!issue || issue.app_id !== review.app_id) throw new UserFacingError("That issue isn't part of this app.", 404);
    if (issue.status !== "open") throw new UserFacingError("That issue has already shipped. Start a new one.", 409);
    await issuesDb.updateIssue(env.DB, user.id, issue.id, {
      title: clean(request.title, 120) ?? issue.title,
      fixNote: note,
      targetVersion: version,
    });
  } else {
    const id = await issuesDb.createIssue(env.DB, {
      userId: user.id,
      appId: review.app_id,
      title: clean(request.title, 120) ?? suggestTitle(review),
      fixNote: note,
      targetVersion: version,
    });
    issue = await issuesDb.getIssue(env.DB, user.id, id);
  }
  if (!issue) throw new Error("Issue disappeared while linking.");

  await db.updateReview(env.DB, review.id, {
    status: "fix_pending",
    issue_id: issue.id,
    fix_note: note,
    fixed_in_version: version,
    fix_pending_at: nowIso(),
    // A follow-up drafted for an earlier fix no longer applies.
    followup_draft: null,
  });
  // Moving a review between issues can leave the old one empty.
  if (review.issue_id && review.issue_id !== issue.id) await issuesDb.deleteIssueIfEmpty(env.DB, review.issue_id);
  return issue;
}

/** Takes a review back out of its issue, and removes the issue if nothing is left in it. */
export async function unlinkReview(env: Bindings, review: InboxReview): Promise<void> {
  if (review.status === "followed_up") throw new UserFacingError("This review was already followed up.", 409);
  await db.updateReview(env.DB, review.id, {
    issue_id: null,
    status: review.reply_state === "sent" || review.reply_state === "existing" ? "done" : "open",
    fix_note: null,
    fixed_in_version: null,
    fix_pending_at: null,
    followup_draft: null,
  });
  if (review.issue_id) await issuesDb.deleteIssueIfEmpty(env.DB, review.issue_id);
}

/** Adds more reviews to an issue in one go, e.g. from its "similar reviews" list. */
export async function addReviewsToIssue(env: Bindings, user: UserRow, issueId: string, reviewIds: string[]): Promise<number> {
  const issue = await issuesDb.getIssue(env.DB, user.id, issueId);
  if (!issue) throw new UserFacingError("That issue no longer exists.", 404);
  if (issue.status !== "open") throw new UserFacingError("That issue has already shipped.", 409);
  let added = 0;
  for (const reviewId of reviewIds.slice(0, 100)) {
    const review = await db.getInboxReview(env.DB, user.id, reviewId);
    if (!review || review.app_id !== issue.app_id || review.status === "followed_up" || review.issue_id) continue;
    await db.updateReview(env.DB, review.id, {
      status: "fix_pending",
      issue_id: issue.id,
      fix_note: issue.fix_note,
      fixed_in_version: issue.target_version,
      fix_pending_at: nowIso(),
      followup_draft: null,
    });
    added++;
  }
  return added;
}

export async function similarReviews(env: Bindings, user: UserRow, issue: IssueRow): Promise<Array<Scored<InboxReview>>> {
  const candidates = await issuesDb.groupingCandidates(env.DB, user.id, issue.app_id);
  return rankBySimilarity(
    `${issue.title} ${issue.fix_note ?? ""}`,
    candidates.map((review) => ({ item: review, text: reviewText(review) })),
  ).slice(0, 25);
}

/** Release notes ("What's New") listing the issues a version fixed, ready to paste into the store. */
export function whatsNewText(issues: Array<{ title: string; reports: number }>): string {
  const lines = issues.map((issue) => `• Fixed: ${issue.title}${issue.reports > 1 ? ` (reported by ${issue.reports} of you)` : ""}`);
  return ["Fixes from your reviews:", ...lines, "", "Thanks for taking the time to report these."].join("\n");
}

// ---------- recovery forecast ----------

export interface ForecastBasis {
  /** Share of followed-up reviewers who raised their rating. */
  raiseRate: number;
  /** Average rating those reviewers moved to. */
  newRating: number;
  source: "yours" | "peers";
  sample: number;
}

/**
 * Expected stars won back by following up with an issue's reviewers, from measured outcomes:
 * reviewers × chance they raise × how far they'd rise.
 */
export function forecastRecovery(reports: number, averageRating: number, basis: ForecastBasis): number {
  if (reports <= 0) return 0;
  return reports * basis.raiseRate * Math.max(0, basis.newRating - averageRating);
}

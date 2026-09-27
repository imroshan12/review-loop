import * as db from "../db";
import type { Bindings } from "../env";
import { envNumber } from "../env";
import * as issuesDb from "../queries/issues";
import { recordGuard, releasesToGuard, windowRatings } from "../queries/insights";
import { deliverNotice, promiseNotice, releaseSpikeNotice } from "./notify";

const HOUR = 3600 * 1000;
const WATCH_HOURS = 72;
const BASELINE_DAYS = 14;

export interface GuardVerdict {
  spike: boolean;
  ratio: number;
}

/**
 * A release "spikes" when at least 5 new 1–2★ reviews arrive and their share of new reviews is at
 * least double the share in the two weeks before. With little history, 30% is the assumed baseline.
 */
export function guardVerdict(before: { total: number; low: number }, after: { total: number; low: number }): GuardVerdict {
  const baseline = before.total >= 10 ? before.low / before.total : 0.3;
  const afterShare = after.total > 0 ? after.low / after.total : 0;
  const ratio = afterShare / Math.max(baseline, 0.05);
  return { spike: after.low >= 5 && ratio >= 2, ratio: Math.round(ratio * 10) / 10 };
}

/** Checks releases from the last 72 hours for a jump in low ratings and alerts once per release. */
export async function runReleaseGuard(env: Bindings, now = Date.now(), limit = 10): Promise<number> {
  let alerts = 0;
  const releases = await releasesToGuard(env.DB, new Date(now - WATCH_HOURS * HOUR).toISOString(), limit);
  for (const release of releases) {
    const releasedAt = Date.parse(release.released_at);
    const before = await windowRatings(
      env.DB,
      release.app_id,
      new Date(releasedAt - BASELINE_DAYS * 24 * HOUR).toISOString(),
      release.released_at,
    );
    const after = await windowRatings(env.DB, release.app_id, release.released_at, new Date(Math.min(now, releasedAt + WATCH_HOURS * HOUR)).toISOString());
    const verdict = guardVerdict(before, after);
    await recordGuard(env.DB, release.id, { status: verdict.spike ? "spike" : "ok", ratio: verdict.ratio, low: after.low });
    if (!verdict.spike) continue;

    const user = await db.getUser(env.DB, release.user_id);
    if (!user) continue;
    const settings = await db.getSettings(env.DB, user.id);
    await deliverNotice(env, user, settings, releaseSpikeNotice(env, release.app_name, release.version, verdict.ratio, after.low, after.titles));
    alerts++;
  }
  return alerts;
}

/** Reminds developers who told reviewers a fix was coming, when it still hasn't shipped. */
export async function runPromiseTracker(env: Bindings, now = Date.now(), limit = 10): Promise<number> {
  const days = envNumber(env.PROMISE_DAYS, 14);
  const overdue = await issuesDb.overduePromises(env.DB, new Date(now - days * 24 * HOUR).toISOString(), limit);
  for (const issue of overdue) {
    const user = await db.getUser(env.DB, issue.user_id);
    if (user) {
      const settings = await db.getSettings(env.DB, user.id);
      const waited = Math.floor((now - Date.parse(issue.promised_at)) / (24 * HOUR));
      await deliverNotice(env, user, settings, promiseNotice(env, issue.app_name, issue.title, issue.told, waited, issue.id));
    }
    await issuesDb.markReminded(env.DB, issue.id);
  }
  return overdue.length;
}

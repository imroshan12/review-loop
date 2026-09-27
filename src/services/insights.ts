import type { Bindings } from "../env";
import { envNumber } from "../env";
import { appLoopMetrics, readBenchmarks, replyTraitCounts, writeBenchmarks, type AppLoopRow, type TraitCounts } from "../queries/insights";
import type { ForecastBasis } from "./issues";

const DAY = 24 * 3600 * 1000;
/** Each side of a comparison needs this many replies before we show it. */
export const MIN_SAMPLE = 30;

export interface Finding {
  trait: string;
  without: string;
  withRate: number;
  withoutRate: number;
  withN: number;
  withoutN: number;
}

export interface Benchmarks {
  apps: number;
  minApps: number;
  locked: boolean;
  replyRate: number | null;
  fastReplyRate: number | null;
  followupRaiseRate: number | null;
  followupSample: number;
  replyRaiseRate: number | null;
  replySample: number;
  newRating: number | null;
  averageGain: number | null;
  findings: Finding[];
}

export interface LoopSummary {
  apps: number;
  low: number;
  replyRate: number | null;
  fastReplyRate: number | null;
  followed: number;
  followupRaiseRate: number | null;
  sentReplies: number;
  replyRaiseRate: number | null;
  raised: number;
  starsRecovered: number;
  newRating: number | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const ratio = (part: number, whole: number, minimum = 1): number | null => (whole >= minimum ? part / whole : null);

/** Totals for one developer's apps. */
export function summarize(rows: AppLoopRow[]): LoopSummary {
  const sum = (key: keyof AppLoopRow) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const raised = sum("raised_total");
  return {
    apps: rows.length,
    low: sum("low"),
    replyRate: ratio(sum("low_replied"), sum("low")),
    fastReplyRate: ratio(sum("sent_fast"), sum("sent_replies")),
    followed: sum("followed"),
    followupRaiseRate: ratio(sum("followed_raised"), sum("followed")),
    sentReplies: sum("sent_replies"),
    replyRaiseRate: ratio(sum("sent_raised"), sum("sent_replies")),
    raised,
    starsRecovered: sum("gain_sum"),
    newRating: ratio(sum("new_rating_sum"), raised),
  };
}

/** Turns trait counts into comparisons, keeping only those with enough replies on both sides. */
export function findingsFrom(counts: TraitCounts, minSample = MIN_SAMPLE): Finding[] {
  const pairs: Array<[string, string, number, number, number, number]> = [
    ["Follow up after the fix ships", "First reply only", counts.n_followup, counts.r_followup, counts.n_first, counts.r_first],
    ["Reply within a day of the review arriving", "Slower replies", counts.n_fast, counts.r_fast, counts.n_slow, counts.r_slow],
    ["Mention the version with the fix", "No version mentioned", counts.n_version, counts.r_version, counts.n_no_version, counts.r_no_version],
    ["Apologize", "No apology", counts.n_sorry, counts.r_sorry, counts.n_no_sorry, counts.r_no_sorry],
    ["Longer replies (200+ characters)", "Shorter replies", counts.n_long, counts.r_long, counts.n_short, counts.r_short],
  ];
  return pairs
    .filter(([, , withN, , withoutN]) => withN >= minSample && withoutN >= minSample)
    .map(([trait, without, withN, withRaised, withoutN, withoutRaised]) => ({
      trait,
      without,
      withRate: withRaised / withN,
      withoutRate: withoutRaised / withoutN,
      withN,
      withoutN,
    }));
}

/** Benchmarks across every app on ReviewLoop, hidden until enough apps contribute that none can be singled out. */
export async function computeBenchmarks(env: Bindings, now = Date.now()): Promise<Benchmarks> {
  const minApps = envNumber(env.BENCHMARK_MIN_APPS, 10);
  const rows = await appLoopMetrics(env.DB, new Date(now - 90 * DAY).toISOString());
  const eligible = rows.filter((row) => row.low >= 5);
  const pooled = summarize(rows);
  const counts = await replyTraitCounts(env.DB, new Date(now - 180 * DAY).toISOString());
  return {
    apps: eligible.length,
    minApps,
    locked: eligible.length < minApps,
    replyRate: median(eligible.map((row) => row.low_replied / row.low)),
    fastReplyRate: median(rows.filter((row) => row.sent_replies >= 5).map((row) => row.sent_fast / row.sent_replies)),
    followupRaiseRate: pooled.followed >= MIN_SAMPLE ? pooled.followupRaiseRate : null,
    followupSample: pooled.followed,
    replyRaiseRate: pooled.sentReplies >= MIN_SAMPLE ? pooled.replyRaiseRate : null,
    replySample: pooled.sentReplies,
    newRating: pooled.raised >= 10 ? pooled.newRating : null,
    averageGain: pooled.raised >= 10 ? pooled.starsRecovered / pooled.raised : null,
    findings: findingsFrom(counts),
  };
}

/** Recomputes the shared benchmarks at most once a day (called from the cron job). */
export async function refreshBenchmarksIfStale(env: Bindings, now = Date.now()): Promise<boolean> {
  const cached = await readBenchmarks<Benchmarks>(env.DB);
  if (cached && now - Date.parse(cached.computedAt) < DAY) return false;
  await writeBenchmarks(env.DB, await computeBenchmarks(env, now));
  return true;
}

export async function cachedBenchmarks(env: Bindings): Promise<(Benchmarks & { computedAt: string }) | null> {
  const cached = await readBenchmarks<Benchmarks>(env.DB);
  return cached ? { ...cached.data, computedAt: cached.computedAt } : null;
}

/**
 * What the recovery forecast is based on: the developer's own follow-up results once there are
 * 10 of them, otherwise ReviewLoop-wide results once those are unlocked, otherwise nothing.
 */
export async function forecastBasisFor(env: Bindings, userId: string, now = Date.now()): Promise<ForecastBasis | null> {
  const own = summarize(await appLoopMetrics(env.DB, new Date(now - 365 * DAY).toISOString(), { userId }));
  if (own.followed >= 10 && own.followupRaiseRate !== null) {
    return { raiseRate: own.followupRaiseRate, newRating: own.newRating ?? 4.5, source: "yours", sample: own.followed };
  }
  const peers = await cachedBenchmarks(env);
  if (peers && !peers.locked && peers.followupRaiseRate !== null) {
    return { raiseRate: peers.followupRaiseRate, newRating: peers.newRating ?? 4.5, source: "peers", sample: peers.followupSample };
  }
  return null;
}

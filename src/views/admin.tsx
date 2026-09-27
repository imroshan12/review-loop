import type { FC } from "hono/jsx";
import type { AdminMetrics, AiUsage } from "../db";
import type { Bindings, UserRow } from "../env";
import { relativeTime } from "../lib/util";
import { Layout } from "./layout";

// From the launch plan: about 14 subscribers at $9 net roughly ₹10,000 a month after fees.
const GOAL_SUBSCRIBERS = 14;
const DODO_FEE_SHARE = 0.104;

interface AdminProps {
  env: Bindings;
  user: UserRow;
  metrics: AdminMetrics;
  ai: {
    today: AiUsage;
    month: AiUsage;
    caps: { free: number; total: number };
    model: string;
    monthCostUsd: number | null;
  };
  priceUsd: number;
  /** False when access still relies on usernames (ADMIN_GITHUB_LOGINS) instead of numeric ids. */
  lockedToId: boolean;
  /** Set while ENCRYPTION_KEY_PREVIOUS is configured. */
  rotation: { remaining: number } | null;
}

const Stat: FC<{ label: string; value: string | number; sub?: string }> = ({ label, value, sub }) => (
  <div class="stat">
    <span class="stat-label">{label}</span>
    <span class="stat-value">{value}</span>
    {sub ? <span class="stat-sub">{sub}</span> : null}
  </div>
);

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function usd(amount: number): string {
  return amount < 10 ? `$${amount.toFixed(2)}` : `$${Math.round(amount).toLocaleString("en-US")}`;
}

export const AdminPage: FC<AdminProps> = ({ env, user, metrics, ai, priceUsd, lockedToId, rotation }) => {
  const { users, activity, funnel } = metrics;
  const mrr = users.pro * priceUsd;
  const funnelRows: Array<[string, number]> = [
    ["Signed up", funnel.signedUp],
    ["Tried the sample", funnel.triedSample],
    ["Connected a store", funnel.connected],
    ["Sent a reply", funnel.replied],
    ["Tracked a fix", funnel.trackedFix],
    ["Sent a follow-up", funnel.followedUp],
    ["Paid", funnel.paid],
  ];
  return (
    <Layout env={env} title="Founder dashboard" user={user} active="admin">
      <div class="page-head">
        <div>
          <h1>Founder dashboard</h1>
          <p class="muted">Only you can see this page. Activity counts real stores only; sample workspace usage is left out.</p>
        </div>
      </div>

      {!lockedToId && user.github_id !== null && user.github_id > 0 ? (
        <p class="banner warn">
          This page is unlocked by your GitHub username. If you ever rename your account, someone else could claim the old name.
          Lock it to your permanent GitHub id instead: set <span class="mono">ADMIN_GITHUB_IDS</span> to{" "}
          <strong class="mono">{user.github_id}</strong> in wrangler.jsonc and deploy.
        </p>
      ) : null}

      {rotation ? (
        <p class={`banner ${rotation.remaining ? "warn" : "info"}`}>
          {rotation.remaining
            ? `Key rotation in progress: ${rotation.remaining} secret${rotation.remaining === 1 ? " is" : "s are"} still encrypted with the previous key. They're moved to the new key every 30 minutes. Keep ENCRYPTION_KEY_PREVIOUS until this reaches zero.`
            : "Key rotation finished: every secret uses the new key. Delete ENCRYPTION_KEY_PREVIOUS now (wrangler secret delete ENCRYPTION_KEY_PREVIOUS)."}
        </p>
      ) : null}

      <h2>Revenue</h2>
      <div class="stats">
        <Stat label="Paying developers" value={users.pro} sub={`Goal: ${GOAL_SUBSCRIBERS} (≈ ₹10,000/month)`} />
        <Stat label="Monthly revenue" value={usd(mrr)} sub={`≈ ${usd(mrr * (1 - DODO_FEE_SHARE))} after Dodo fees`} />
        <Stat label="Goal progress" value={percent(users.pro, GOAL_SUBSCRIBERS)} />
      </div>

      <h2>Users</h2>
      <div class="stats">
        <Stat label="Total" value={users.total} sub={`${users.new7} this week · ${users.new30} this month`} />
        <Stat label="Tried the sample" value={users.triedSample} sub={percent(users.triedSample, users.total)} />
        <Stat label="Connected a store" value={users.connected} sub={`${percent(users.connected, users.total)} of all users`} />
      </div>

      <h2>Activity</h2>
      <div class="stats">
        <Stat label="Replies sent (30 days)" value={activity.replies30} sub={`${activity.replies7} in the last 7 days`} />
        <Stat label="Follow-ups sent (30 days)" value={activity.followups30} />
        <Stat label="Fixes being tracked" value={activity.fixPending} />
        <Stat
          label="Ratings raised"
          value={activity.raisedAll}
          sub={`${activity.raised30} in the last 30 days${activity.raisedAll ? ` · +${activity.averageGain.toFixed(1)}★ average` : ""}`}
        />
      </div>

      <h2>Funnel: people who signed up in the last 30 days</h2>
      <table class="table">
        <thead>
          <tr>
            <th>Step</th>
            <th>People</th>
            <th>Of signups</th>
          </tr>
        </thead>
        <tbody>
          {funnelRows.map(([step, count]) => (
            <tr>
              <td>{step}</td>
              <td>{count}</td>
              <td>{percent(count, funnel.signedUp)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>AI usage</h2>
      <div class="stats">
        <Stat label="Free drafts today" value={`${ai.today.free_drafts} / ${ai.caps.free}`} sub="Daily cap across all free users" />
        <Stat label="All drafts today" value={`${ai.today.total_drafts} / ${ai.caps.total}`} sub="Daily safety cap" />
        <Stat label="Drafts this month" value={ai.month.total_drafts} sub={`${ai.month.free_drafts} by free users`} />
        <Stat
          label="AI cost this month"
          value={ai.monthCostUsd === null ? "—" : usd(ai.monthCostUsd)}
          sub={`${ai.model} · ${ai.month.input_tokens.toLocaleString("en-US")} in / ${ai.month.output_tokens.toLocaleString("en-US")} out tokens`}
        />
      </div>

      <h2>Connections needing attention</h2>
      {metrics.failing.length === 0 ? (
        <p class="empty">Every connection is working.</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Connection</th>
              <th>Error</th>
              <th>Failures</th>
              <th>Next retry</th>
            </tr>
          </thead>
          <tbody>
            {metrics.failing.map((row) => (
              <tr>
                <td>{row.login}</td>
                <td>{row.label}</td>
                <td class="small">{row.last_error}</td>
                <td>{row.failure_count}</td>
                <td>{row.next_sync_at ? row.next_sync_at.slice(0, 16).replace("T", " ") + " UTC" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Recent signups</h2>
      <table class="table">
        <thead>
          <tr>
            <th>GitHub user</th>
            <th>Joined</th>
            <th>Plan</th>
            <th>Stores</th>
            <th>Replies</th>
          </tr>
        </thead>
        <tbody>
          {metrics.recent.map((row) => (
            <tr>
              <td>
                <a href={`https://github.com/${row.login}`} target="_blank" rel="noopener">
                  {row.login}
                </a>
              </td>
              <td>{relativeTime(row.created_at)}</td>
              <td>{row.plan === "pro" ? "Pro" : "Free"}</td>
              <td>{row.connections}</td>
              <td>{row.replies}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
};

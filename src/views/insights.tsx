import type { FC } from "hono/jsx";
import type { AppRow, Bindings, UserRow } from "../env";
import type { AppLoopRow } from "../queries/insights";
import type { Benchmarks, LoopSummary } from "../services/insights";
import { Layout, type Flash } from "./layout";

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

const Compare: FC<{ label: string; you: number | null; peers: number | null; locked: boolean; hint: string; appName: string }> = ({
  label,
  you,
  peers,
  locked,
  hint,
  appName,
}) => {
  const verdict = you === null || peers === null || locked ? null : you >= peers ? "ahead" : "behind";
  return (
    <div class="stat">
      <span class="stat-label">{label}</span>
      <span class="stat-value">{pct(you)}</span>
      <span class="stat-sub">
        {locked || peers === null ? hint : `Developers on ${appName}: ${pct(peers)}`}
        {verdict ? <span class={`badge ${verdict === "ahead" ? "ok" : "warn-badge"}`}>{verdict === "ahead" ? "Ahead" : "Behind"}</span> : null}
      </span>
    </div>
  );
};

interface InsightsProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  you: LoopSummary;
  perApp: Array<AppLoopRow & { app: AppRow | undefined }>;
  benchmarks: (Benchmarks & { computedAt: string }) | null;
}

export const InsightsPage: FC<InsightsProps> = ({ env, user, flash, you, perApp, benchmarks }) => {
  const locked = !benchmarks || benchmarks.locked;
  // How many apps contribute is deliberately not shown: it would tell anyone who signs up how big the platform is.
  const lockHint = "Peer benchmark unlocks once enough apps contribute";
  return (
    <Layout env={env} title="Insights" user={user} active="insights" flash={flash}>
      <div class="page-head">
        <div>
          <h1>Insights</h1>
          <p class="muted">Your last 90 days on real stores, compared with developers across {env.APP_NAME}.</p>
        </div>
      </div>

      <div class="stats">
        <Compare appName={env.APP_NAME} label="1–2★ reviews you replied to" you={you.replyRate} peers={benchmarks?.replyRate ?? null} locked={locked} hint={lockHint} />
        <Compare appName={env.APP_NAME}
          label="Replies sent within 2 days"
          you={you.fastReplyRate}
          peers={benchmarks?.fastReplyRate ?? null}
          locked={locked}
          hint={lockHint}
        />
        <Compare appName={env.APP_NAME}
          label="Followed-up reviewers who raised their rating"
          you={you.followupRaiseRate}
          peers={benchmarks?.followupRaiseRate ?? null}
          locked={locked}
          hint={lockHint}
        />
        <div class="stat">
          <span class="stat-label">Stars won back</span>
          <span class="stat-value good">+{you.starsRecovered}★</span>
          <span class="stat-sub">
            from {you.raised} reviewer{you.raised === 1 ? "" : "s"} who raised their rating
          </span>
        </div>
      </div>
      <p class="muted small">
        Benchmarks are computed from counts only, never review text, and stay hidden until enough apps contribute that no single app
        can be identified.
      </p>

      <h2>What gets reviewers to raise their rating</h2>
      {benchmarks && benchmarks.findings.length ? (
        <table class="table">
          <thead>
            <tr>
              <th>Reply habit</th>
              <th>Raised their rating</th>
              <th>Compared with</th>
            </tr>
          </thead>
          <tbody>
            {benchmarks.findings.map((finding) => (
              <tr>
                <td>{finding.trait}</td>
                <td>
                  <strong>{pct(finding.withRate)}</strong> <span class="muted small">of {finding.withN}</span>
                </td>
                <td>
                  {finding.without}: {pct(finding.withoutRate)} <span class="muted small">of {finding.withoutN}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="card">
          <p>
            Findings from {env.APP_NAME}'s own data appear once there are enough replies to compare. Until then, the published
            research:
          </p>
          <ul>
            <li>
              Reviewers raise their rating by <strong>+0.7★</strong> on average after a developer reply (
              <a href="https://android-developers.googleblog.com/2019/05/whats-new-in-play.html" target="_blank" rel="noopener">
                Google, 2019
              </a>
              ).
            </li>
            <li>
              A reply makes a reviewer about <strong>6×</strong> more likely to raise their rating (
              <a href="https://doi.org/10.1007/s10664-017-9538-9" target="_blank" rel="noopener">
                Hassan et al., 2018
              </a>
              ).
            </li>
          </ul>
        </div>
      )}

      <h2>By app</h2>
      {perApp.length === 0 ? (
        <p class="empty">No activity on connected stores in the last 90 days yet.</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>App</th>
              <th>1–2★ reviews</th>
              <th>Replied</th>
              <th>Follow-ups</th>
              <th>Raised</th>
              <th>Stars won back</th>
            </tr>
          </thead>
          <tbody>
            {perApp.map((row) => (
              <tr>
                <td>{row.app?.name ?? "Removed app"}</td>
                <td>{row.low}</td>
                <td>{pct(row.low > 0 ? row.low_replied / row.low : null)}</td>
                <td>{row.followed}</td>
                <td>{row.raised_total}</td>
                <td>+{row.gain_sum}★</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
};

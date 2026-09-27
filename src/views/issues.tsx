import type { FC } from "hono/jsx";
import type { Bindings, InboxReview, UserRow } from "../env";
import { envNumber } from "../env";
import type { Scored } from "../lib/similarity";
import { relativeTime } from "../lib/util";
import type { IssueWithStats } from "../queries/issues";
import { forecastRecovery, type ForecastBasis } from "../services/issues";
import { Layout, type Flash } from "./layout";
import { Stars } from "./review-card";

const DAY = 24 * 3600 * 1000;

function daysSince(iso: string | null, now = Date.now()): number | null {
  return iso ? Math.floor((now - Date.parse(iso)) / DAY) : null;
}

function basisNote(basis: ForecastBasis | null, appName: string): string {
  if (!basis) return "Recovery forecasts start after 10 follow-ups, or once enough apps contribute to peer benchmarks.";
  const rate = Math.round(basis.raiseRate * 100);
  return basis.source === "yours"
    ? `Forecasts use your own results: ${rate}% of the ${basis.sample} reviewers you followed up with raised their rating.`
    : `Forecasts use results across ${appName}: ${rate}% of ${basis.sample} followed-up reviewers raised their rating.`;
}

const IssueCard: FC<{ issue: IssueWithStats; basis: ForecastBasis | null; promiseDays: number }> = ({ issue, basis, promiseDays }) => {
  const shipped = issue.status === "shipped";
  const forecast = basis && !shipped ? forecastRecovery(issue.reports, issue.avg_rating, basis) : null;
  const waiting = daysSince(issue.promised_at);
  const overdue = !shipped && waiting !== null && waiting >= promiseDays && issue.replied > 0;
  return (
    <article class={`issue-card ${overdue ? "overdue" : ""}`}>
      <header class="issue-head">
        <h3>
          <a href={`/issues/${issue.id}`}>{issue.title}</a>
        </h3>
        <span class="badge">{issue.app_name}</span>
        {shipped ? <span class="badge ok">Shipped in v{issue.shipped_version}</span> : null}
      </header>
      <dl class="issue-metrics">
        <div>
          <dt>Reviewers</dt>
          <dd>{issue.reports}</dd>
        </div>
        <div>
          <dt>Stars lost</dt>
          <dd>{issue.star_debt}★</dd>
        </div>
        {shipped ? (
          <>
            <div>
              <dt>Followed up</dt>
              <dd>
                {issue.followed_up}/{issue.reports}
              </dd>
            </div>
            <div>
              <dt>Stars won back</dt>
              <dd class="good">+{issue.stars_recovered}★</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>Average rating</dt>
              <dd>{issue.avg_rating.toFixed(1)}★</dd>
            </div>
            <div>
              <dt>Likely recoverable</dt>
              <dd>{forecast === null ? "—" : `≈ ${forecast.toFixed(1)}★`}</dd>
            </div>
          </>
        )}
      </dl>
      <p class="muted small">
        {shipped
          ? `${issue.raised} of ${issue.reports} reviewers raised their rating · shipped ${relativeTime(issue.shipped_at)}`
          : `${issue.fix_note ? `Fix: ${issue.fix_note} · ` : ""}Ships in ${issue.target_version ? `v${issue.target_version}` : "the next release"} · opened ${relativeTime(issue.created_at)}`}
      </p>
      {overdue ? (
        <p class="banner warn">
          You told {issue.replied} reviewer{issue.replied === 1 ? "" : "s"} about this {waiting} days ago, and it hasn't shipped yet.
        </p>
      ) : null}
    </article>
  );
};

interface IssuesPageProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  tab: "open" | "shipped";
  issues: IssueWithStats[];
  counts: { open: number; shipped: number };
  basis: ForecastBasis | null;
}

export const IssuesPage: FC<IssuesPageProps> = ({ env, user, flash, tab, issues, counts, basis }) => {
  const promiseDays = envNumber(env.PROMISE_DAYS, 14);
  const totalDebt = issues.reduce((sum, issue) => sum + issue.star_debt, 0);
  const totalForecast = basis ? issues.reduce((sum, issue) => sum + forecastRecovery(issue.reports, issue.avg_rating, basis), 0) : null;
  return (
    <Layout env={env} title="Issues" user={user} active="issues" flash={flash}>
      <div class="page-head">
        <div>
          <h1>Issues</h1>
          <p class="muted">
            Reviews that report the same problem, grouped. The fixes costing you the most stars are at the top. When one ships,
            everyone who reported it gets a follow-up.
          </p>
        </div>
      </div>

      <nav class="tabs" aria-label="Issue status">
        <a href="/issues" class={tab === "open" ? "active" : ""} aria-current={tab === "open" ? "page" : undefined}>
          Open<span class="count">{counts.open}</span>
        </a>
        <a href="/issues?tab=shipped" class={tab === "shipped" ? "active" : ""} aria-current={tab === "shipped" ? "page" : undefined}>
          Shipped<span class="count">{counts.shipped}</span>
        </a>
      </nav>

      {tab === "open" && issues.length ? (
        <div class="stats">
          <div class="stat">
            <span class="stat-label">Stars lost to open issues</span>
            <span class="stat-value">{totalDebt}★</span>
          </div>
          <div class="stat">
            <span class="stat-label">Likely recoverable by shipping them</span>
            <span class="stat-value">{totalForecast === null ? "—" : `≈ ${totalForecast.toFixed(1)}★`}</span>
          </div>
        </div>
      ) : null}
      {tab === "open" ? <p class="muted small">{basisNote(basis, env.APP_NAME)}</p> : null}

      {issues.length === 0 ? (
        <p class="empty">
          {tab === "open"
            ? "No open issues. In the inbox, use “Mark fix pending” on a bug report to start one."
            : "Nothing shipped yet. Issues move here when the version with their fix goes live."}
        </p>
      ) : (
        <div class="issue-list">
          {issues.map((issue) => (
            <IssueCard issue={issue} basis={basis} promiseDays={promiseDays} />
          ))}
        </div>
      )}
    </Layout>
  );
};

interface IssueDetailProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  issue: IssueWithStats;
  reviews: InboxReview[];
  similar: Array<Scored<InboxReview>>;
  basis: ForecastBasis | null;
}

export const IssueDetailPage: FC<IssueDetailProps> = ({ env, user, flash, issue, reviews, similar, basis }) => {
  const open = issue.status === "open";
  return (
    <Layout env={env} title={issue.title} user={user} active="issues" flash={flash}>
      <p class="small">
        <a href="/issues">← All issues</a>
      </p>
      <IssueCard issue={issue} basis={basis} promiseDays={envNumber(env.PROMISE_DAYS, 14)} />

      {open ? (
        <details class="card">
          <summary>
            <strong>Edit issue</strong>
          </summary>
          <form method="post" action={`/issues/${issue.id}`} class="stack">
            <label>
              Title
              <input type="text" name="title" required maxlength={120} value={issue.title} />
            </label>
            <label>
              What's the fix? <span class="muted">(quoted in follow-ups)</span>
              <input type="text" name="fix_note" maxlength={500} value={issue.fix_note ?? ""} />
            </label>
            <label>
              Ships in version <span class="muted">(empty means the next release)</span>
              <input type="text" name="target_version" maxlength={40} value={issue.target_version ?? ""} placeholder="2.3.1" />
            </label>
            <div>
              <button type="submit" class="button primary">
                Save
              </button>
            </div>
          </form>
        </details>
      ) : null}

      <h2>Reviews in this issue</h2>
      <ul class="compact-list">
        {reviews.map((review) => (
          <li>
            <Stars rating={review.rating_before ?? review.rating} />
            {review.rating_raised_at ? <span class="badge ok">now {review.rating}★</span> : null}
            <span class="compact-text">{review.title ? `${review.title}: ` : ""}{review.body.slice(0, 160)}</span>
            <span class="muted small">
              {review.author ?? "Anonymous"} · {relativeTime(review.reviewed_at)} ·{" "}
              {review.status === "followed_up" ? "followed up" : review.reply_state === "sent" ? "replied" : "no reply yet"}
            </span>
          </li>
        ))}
      </ul>
      <p class="small">
        <a href={`/inbox?view=all&issue=${issue.id}`}>Open these reviews in the inbox →</a>
      </p>

      {open ? (
        <section>
          <h2>Similar reviews not in an issue yet</h2>
          {similar.length === 0 ? (
            <p class="empty">No similar reviews found.</p>
          ) : (
            <ul class="compact-list">
              {similar.map(({ item: review, score }) => (
                <li data-issue-id={issue.id}>
                  <Stars rating={review.rating} />
                  <span class="compact-text">{review.title ? `${review.title}: ` : ""}{review.body.slice(0, 160)}</span>
                  <span class="muted small">
                    {Math.round(score * 100)}% match · {relativeTime(review.reviewed_at)}
                  </span>
                  <button type="button" class="button small" data-action="add-to-issue" data-review-id-to-add={review.id}>
                    Add to issue
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Layout>
  );
};

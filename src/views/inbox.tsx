import type { FC } from "hono/jsx";
import type { InboxView } from "../db";
import type { AppRow, Bindings, ConnectionRow, InboxReview, ReviewStatus, UserRow } from "../env";
import { guidePath } from "../env";
import { relativeTime } from "../lib/util";
import { Layout, type Flash } from "./layout";
import { ReviewCard, type IssueOption } from "./review-card";

export const PAGE_SIZE = 25;

const VIEWS: Array<{ key: InboxView; label: string; count: (counts: Record<ReviewStatus, number>) => number | null }> = [
  { key: "needs_reply", label: "Needs reply", count: (c) => c.open },
  { key: "fix_pending", label: "Fix pending", count: (c) => c.fix_pending },
  { key: "followups", label: "Follow-ups ready", count: (c) => c.followup_ready },
  { key: "done", label: "Done", count: (c) => c.done + c.followed_up },
  { key: "all", label: "All", count: () => null },
];

const EMPTY_TEXT: Record<InboxView, string> = {
  needs_reply: "Every review has an answer. New ones show up here.",
  fix_pending: "No bugs waiting on a release. Mark a review \"fix pending\" to track it here.",
  followups: "No follow-ups waiting. They appear here when a version ships with fixes you tracked.",
  done: "Nothing finished yet.",
  all: "No reviews yet.",
};

interface InboxProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  view: InboxView;
  appId: string | null;
  apps: AppRow[];
  connections: ConnectionRow[];
  reviews: InboxReview[];
  counts: Record<ReviewStatus, number>;
  wins: { count: number; averageGain: number };
  offset: number;
  /** Follow-ups ready per app, across all pages. */
  readyCounts: Map<string, number>;
  /** Open issues, for each card's "Mark fix pending" menu. */
  issues: IssueOption[];
  /** Set when the inbox is filtered to one issue. */
  issueFilter: { id: string; title: string } | null;
}

function viewHref(view: InboxView, appId: string | null, offset = 0, issueId: string | null = null): string {
  const params = new URLSearchParams({ view });
  if (appId) params.set("app", appId);
  if (issueId) params.set("issue", issueId);
  if (offset) params.set("offset", String(offset));
  return `/inbox?${params}`;
}

export const InboxPage: FC<InboxProps> = (props) => {
  const { env, user, view, appId, apps, connections, reviews, counts, wins, offset, readyCounts, issues, issueFilter } = props;
  const enabledApps = apps.filter((app) => app.enabled);
  const lastSync = connections.map((c) => c.last_synced_at).filter(Boolean).sort().pop() ?? null;
  const failing = connections.filter((c) => c.status === "error");
  const readyByApp = enabledApps
    .filter((app) => !appId || app.id === appId)
    .map((app) => ({ app, count: readyCounts.get(app.id) ?? 0 }))
    .filter((entry) => entry.count > 0);

  return (
    <Layout env={env} title="Inbox" user={user} active="inbox" flash={props.flash}>
      <div class="page-head">
        <div>
          <h1>Inbox</h1>
          <p class="muted">{connections.length ? `Last checked ${relativeTime(lastSync)}` : "Connect a store to start."}</p>
        </div>
        {connections.length ? (
          <button type="button" class="button" data-action="sync">
            Check for new reviews
          </button>
        ) : null}
      </div>

      {failing.map((connection) => (
        <p class="banner error">
          {connection.label}: {connection.last_error}{" "}
          <a href={`${guidePath(connection.store)}?connection=${connection.id}`}>Update key</a>
        </p>
      ))}

      {wins.count > 0 ? (
        <p class="banner win-banner">
          <strong>{wins.count}</strong> reviewer{wins.count === 1 ? "" : "s"} raised their rating after your replies
          {wins.averageGain > 0 ? `, by ${wins.averageGain.toFixed(1)}★ on average` : ""}.
        </p>
      ) : null}

      {issueFilter ? (
        <p class="banner info">
          Showing reviews in the issue “{issueFilter.title}”. <a href={`/issues/${issueFilter.id}`}>Open the issue</a> ·{" "}
          <a href="/inbox">Show all reviews</a>
        </p>
      ) : null}

      {connections.length === 0 ? (
        <section class="card onboarding">
          <h2>Get your first reviews in</h2>
          <p>Connect App Store Connect or Google Play. Setup takes about five minutes, and your keys are encrypted.</p>
          <div class="cta-row">
            <a class="button primary" href="/connect">Connect a store</a>
            <form method="post" action="/connect/demo" class="inline">
              <button type="submit" class="button">Try with sample reviews</button>
            </form>
          </div>
        </section>
      ) : (
        <>
          <nav class="tabs" aria-label="Inbox views">
            {VIEWS.map((item) => {
              const count = item.count(counts);
              return (
                <a href={viewHref(item.key, appId, 0, issueFilter?.id ?? null)} class={item.key === view ? "active" : ""} aria-current={item.key === view ? "page" : undefined}>
                  {item.label}
                  {count !== null ? <span class="count">{count}</span> : null}
                </a>
              );
            })}
          </nav>

          {enabledApps.length > 1 ? (
            <form method="get" action="/inbox" class="filters">
              <input type="hidden" name="view" value={view} />
              <label>
                App{" "}
                <select name="app" data-autosubmit="true">
                  <option value="">All apps</option>
                  {enabledApps.map((app) => (
                    <option value={app.id} selected={app.id === appId}>
                      {app.name}
                    </option>
                  ))}
                </select>
              </label>
              <noscript>
                <button type="submit" class="button small">Filter</button>
              </noscript>
            </form>
          ) : null}

          {view === "followups" && readyByApp.length ? (
            <div class="bulk">
              {readyByApp.map(({ app, count }) => (
                <button type="button" class="button primary" data-action="send-all" data-app-id={app.id}>
                  {count === 1 ? `Send the follow-up for ${app.name}` : `Send all ${count} follow-ups for ${app.name}`}
                </button>
              ))}
            </div>
          ) : null}

          {reviews.length === 0 ? (
            <p class="empty">{EMPTY_TEXT[view]}</p>
          ) : (
            <div class="review-list">
              {reviews.map((review) => (
                <ReviewCard review={review} issues={issues} />
              ))}
            </div>
          )}

          <nav class="pager" aria-label="Pages">
            {offset > 0 ? <a href={viewHref(view, appId, Math.max(0, offset - PAGE_SIZE), issueFilter?.id ?? null)}>Newer</a> : <span />}
            {reviews.length === PAGE_SIZE ? <a href={viewHref(view, appId, offset + PAGE_SIZE, issueFilter?.id ?? null)}>Older</a> : null}
          </nav>
        </>
      )}
    </Layout>
  );
};

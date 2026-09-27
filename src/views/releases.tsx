import type { FC } from "hono/jsx";
import type { AppRow, Bindings, ReleaseRow, UserRow } from "../env";
import { relativeTime } from "../lib/util";
import { Layout, type Flash } from "./layout";

const SOURCE_LABEL: Record<ReleaseRow["source"], string> = {
  store: "Detected from App Store Connect",
  reviews: "Detected from reviews",
  manual: "Marked by you",
};

const WATCH_MS = 72 * 3600 * 1000;

/** Release Guard status: a spike warning, healthy after checks, or still being watched. */
const Guard: FC<{ release: ReleaseRow }> = ({ release }) => {
  if (release.guard_status === "spike") {
    return (
      <span class="badge bad" title={`${release.guard_low ?? 0} low ratings since release`}>
        {release.guard_ratio}× more 1–2★
      </span>
    );
  }
  const watching = Date.now() - Date.parse(release.released_at) < WATCH_MS;
  if (release.guard_status === "ok") return <span class="badge ok">{watching ? "Healthy so far" : "Healthy"}</span>;
  return <span class="muted small">{watching ? "Watching" : "—"}</span>;
};

interface ReleasesProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  apps: Array<AppRow & { fix_pending: number; followups_ready: number }>;
  releases: Array<ReleaseRow & { app_name: string }>;
  /** Release id → "What's New" draft, for releases that shipped fixed issues. */
  whatsNew: Map<string, string>;
}

export const ReleasesPage: FC<ReleasesProps> = ({ env, user, flash, apps, releases, whatsNew }) => (
  <Layout env={env} title="Releases" user={user} active="releases" flash={flash}>
    <div class="page-head">
      <div>
        <h1>Releases</h1>
        <p class="muted">
          When a new version ships, every issue it fixes gets follow-up drafts for its reviewers. App Store versions are detected
          from App Store Connect and Google Play versions from the reviews themselves; you can also mark a release yourself.
          Release Guard watches the 72 hours after each release for a jump in 1–2★ reviews.
        </p>
      </div>
    </div>

    {apps.length === 0 ? (
      <p class="empty">
        No apps yet. <a href="/connect">Connect a store</a> first.
      </p>
    ) : (
      <div class="app-grid">
        {apps.map((app) => (
          <article class="card">
            <h3>{app.name}</h3>
            <p class="muted">
              Live version: <strong>{app.latest_version ?? "unknown"}</strong>
              {app.store === "apple" && !app.auto_release ? " · this key can't read versions, so mark releases below" : ""}
            </p>
            <p>
              <strong>{app.fix_pending}</strong> fix pending · <strong>{app.followups_ready}</strong> follow-ups ready
            </p>
            {app.followups_ready > 0 ? (
              <button type="button" class="button primary" data-action="send-all" data-app-id={app.id}>
                {app.followups_ready === 1 ? "Send the follow-up" : `Send all ${app.followups_ready} follow-ups`}
              </button>
            ) : null}
            <form method="post" action={`/apps/${app.id}/releases`} class="inline-form">
              <label>
                Mark a version as shipped
                <input type="text" name="version" required maxlength={40} placeholder="2.3.1" />
              </label>
              <button type="submit" class="button">
                Mark shipped
              </button>
            </form>
          </article>
        ))}
      </div>
    )}

    <h2>Recent releases</h2>
    {releases.length === 0 ? (
      <p class="empty">No releases recorded yet.</p>
    ) : (
      <table class="table">
        <thead>
          <tr>
            <th>App</th>
            <th>Version</th>
            <th>When</th>
            <th>Source</th>
            <th>Follow-ups</th>
            <th>Release Guard</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((release) => (
            <tr>
              <td>{release.app_name}</td>
              <td>{release.version}</td>
              <td>{relativeTime(release.released_at)}</td>
              <td>{SOURCE_LABEL[release.source]}</td>
              <td>{release.followups_created}</td>
              <td>
                <Guard release={release} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}

    {releases
      .filter((release) => whatsNew.has(release.id))
      .map((release) => (
        <details class="card whats-new">
          <summary>
            <strong>
              “What's New” draft for {release.app_name} {release.version}
            </strong>
          </summary>
          <p class="muted small">Paste into App Store Connect or Play Console release notes. Edit freely.</p>
          <textarea id={`whats-new-${release.id}`} rows={5} readonly>
            {whatsNew.get(release.id)}
          </textarea>
          <button type="button" class="button small" data-copy={`whats-new-${release.id}`}>
            Copy
          </button>
        </details>
      ))}
  </Layout>
);

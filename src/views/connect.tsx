import type { FC } from "hono/jsx";
import type { AppRow, Bindings, ConnectionRow, UserRow } from "../env";
import { guidePath } from "../env";
import { relativeTime } from "../lib/util";
import { Layout, type Flash } from "./layout";

interface ConnectProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  connections: ConnectionRow[];
  apps: AppRow[];
}

/** "in 3 h" style label for the next automatic retry of a failing connection. */
function retryLabel(nextSyncAt: string | null): string {
  if (!nextSyncAt) return "";
  const minutes = Math.round((Date.parse(nextSyncAt) - Date.now()) / 60000);
  if (minutes <= 0) return "Retrying soon";
  if (minutes < 60) return `Next retry in ${minutes} min`;
  return `Next retry in ${Math.round(minutes / 60)} h`;
}

export const ConnectPage: FC<ConnectProps> = ({ env, user, flash, connections, apps }) => {
  const hasDemo = connections.some((connection) => connection.store === "demo");
  return (
    <Layout env={env} title="Connect stores" user={user} active="connect" flash={flash}>
      <div class="page-head">
        <div>
          <h1>Connect stores</h1>
          <p class="muted">Keys are encrypted with AES-256 before they're stored. The guides set up keys that can only read and reply to reviews.</p>
        </div>
      </div>

      {connections.length ? (
        <section>
          <h2>Connected</h2>
          <table class="table">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Apps</th>
                <th>Status</th>
                <th>Last checked</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr>
                  <td>{connection.label}</td>
                  <td>{apps.filter((app) => app.connection_id === connection.id).length}</td>
                  <td>
                    {connection.status === "ok" ? (
                      <span class="badge ok">Working</span>
                    ) : (
                      <>
                        <span class="badge bad">Needs attention</span>
                        <div class="small error-text">{connection.last_error}</div>
                        <div class="small muted">{retryLabel(connection.next_sync_at)}</div>
                      </>
                    )}
                  </td>
                  <td>{relativeTime(connection.last_synced_at)}</td>
                  <td class="row-actions">
                    {connection.store !== "demo" ? (
                      <a class={`button small ${connection.status === "ok" ? "ghost" : "primary"}`} href={`${guidePath(connection.store)}?connection=${connection.id}`}>
                        Update key
                      </a>
                    ) : null}
                    <form
                      method="post"
                      action={`/connections/${connection.id}/delete`}
                      class="inline"
                      data-confirm={`Remove ${connection.label}? Its apps and reviews will be deleted from ${env.APP_NAME}.`}
                    >
                      <button type="submit" class="button small ghost danger">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <div class="connect-grid">
        <a class="card connect-card" href="/guide/app-store">
          <h2>App Store Connect</h2>
          <p>Create a Customer Support API key and paste three values. Step-by-step, about 5 minutes.</p>
          <span class="button primary">Start the guide</span>
        </a>
        <a class="card connect-card" href="/guide/google-play">
          <h2>Google Play</h2>
          <p>Create a service account that can reply to reviews and invite it in Play Console. Step-by-step, about 10 minutes.</p>
          <span class="button primary">Start the guide</span>
        </a>
      </div>

      <section class="card">
        <h2>Sample workspace</h2>
        {hasDemo ? (
          <p>The sample apps are loaded. Remove them from the table above when you're done exploring.</p>
        ) : (
          <>
            <p>Two sample apps with realistic reviews, so you can try drafting, fix tracking and follow-ups before connecting a store.</p>
            <form method="post" action="/connect/demo" class="inline">
              <button type="submit" class="button">Load sample reviews</button>
            </form>
          </>
        )}
      </section>
    </Layout>
  );
};

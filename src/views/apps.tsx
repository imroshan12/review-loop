import type { FC } from "hono/jsx";
import type { AppRow, Bindings, UserRow } from "../env";
import { UNLIMITED, userPlan } from "../env";
import { Layout, type Flash } from "./layout";

const STORE_LABEL = { apple: "App Store", google: "Google Play", demo: "Sample" } as const;

const EmbedCodes: FC<{ env: Bindings; app: AppRow }> = ({ env, app }) => {
  const page = `${env.APP_URL}/fixed/${app.public_slug}`;
  const badge = `${env.APP_URL}/badge/${app.public_slug}.svg`;
  const markdown = `[![Fixed from reviews](${badge})](${page})`;
  const html = `<a href="${page}"><img src="${badge}" alt="Fixed from reviews"></a>`;
  return (
    <details class="card embed">
      <summary>
        <strong>{app.name}: public fix log</strong> · <a href={page}>{page}</a>
      </summary>
      <p class="embed-badge">
        <img src={badge} alt="Fixed from reviews badge preview" height="20" />
      </p>
      <label>
        Markdown (README, docs)
        <textarea id={`md-${app.id}`} rows={2} readonly>
          {markdown}
        </textarea>
      </label>
      <button type="button" class="button small" data-copy={`md-${app.id}`}>
        Copy Markdown
      </button>
      <label>
        HTML (your website)
        <textarea id={`html-${app.id}`} rows={2} readonly>
          {html}
        </textarea>
      </label>
      <button type="button" class="button small" data-copy={`html-${app.id}`}>
        Copy HTML
      </button>
    </details>
  );
};

export const AppsPage: FC<{ env: Bindings; user: UserRow; flash?: Flash | null; apps: AppRow[] }> = ({ env, user, flash, apps }) => {
  const enabledReal = apps.filter((app) => app.enabled && app.store !== "demo").length;
  const plan = userPlan(env, user);
  const publicApps = apps.filter((app) => app.public_log && app.public_slug);
  return (
    <Layout env={env} title="Apps" user={user} active="apps" flash={flash}>
      <div class="page-head">
        <div>
          <h1>Apps</h1>
          <p class="muted">
            {plan.apps === UNLIMITED
              ? `${plan.name} covers every app you connect.`
              : `Your ${plan.name} plan covers ${plan.apps} app${plan.apps === 1 ? "" : "s"}. An app on both stores counts as two; sample apps don't count.`}
          </p>
        </div>
        {plan.plan !== "pro" ? (
          <a class="button primary" href="/settings#plan">
            {plan.plan === "free" ? "Compare plans" : "Upgrade to Pro"}
          </a>
        ) : null}
      </div>

      {apps.length === 0 ? (
        <p class="empty">
          No apps yet. <a href="/connect">Connect a store</a> to import them.
        </p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>App</th>
              <th>Store</th>
              <th>Identifier</th>
              <th>Live version</th>
              <th>Tracking</th>
              <th>Public fix log</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => {
              const blocked = !app.enabled && app.store !== "demo" && enabledReal >= plan.apps;
              return (
                <tr>
                  <td>{app.name}</td>
                  <td>{STORE_LABEL[app.store]}</td>
                  <td class="mono">{app.bundle_id ?? app.store_app_id}</td>
                  <td>{app.latest_version ?? "—"}</td>
                  <td>
                    <form method="post" action={`/apps/${app.id}/toggle`} class="inline">
                      <input type="hidden" name="enabled" value={app.enabled ? "0" : "1"} />
                      <button type="submit" class={`button small ${app.enabled ? "" : "primary"}`}>
                        {app.enabled ? "Stop tracking" : blocked ? "Track (upgrade)" : "Track"}
                      </button>
                    </form>
                  </td>
                  <td>
                    {app.store === "demo" ? (
                      <span class="muted small">Real apps only</span>
                    ) : (
                      <form
                        method="post"
                        action={`/apps/${app.id}/public`}
                        class="inline"
                        data-confirm={
                          app.public_log
                            ? undefined
                            : `Publish a public page listing the issues you fixed in ${app.name}? It shows your issue titles and counts, never who reported them. New issues are titled from the first review's wording, so check the titles on the Issues page first.`
                        }
                      >
                        <input type="hidden" name="public" value={app.public_log ? "0" : "1"} />
                        <button type="submit" class="button small ghost">
                          {app.public_log ? "Turn off" : "Turn on"}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {publicApps.length ? (
        <section>
          <h2>Badges and public pages</h2>
          <p class="muted">Add the badge to your README or website. It links to the app's public fix log.</p>
          {publicApps.map((app) => (
            <EmbedCodes env={env} app={app} />
          ))}
        </section>
      ) : null}
    </Layout>
  );
};

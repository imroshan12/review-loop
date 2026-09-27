import type { FC } from "hono/jsx";
import type { AppRow, Bindings } from "../env";
import type { PublicFix } from "../queries/issues";
import { Layout } from "./layout";

function monthDay(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export const PublicFixLogPage: FC<{ env: Bindings; app: AppRow; fixes: PublicFix[] }> = ({ env, app, fixes }) => {
  const reports = fixes.reduce((sum, fix) => sum + fix.reports, 0);
  const raised = fixes.reduce((sum, fix) => sum + fix.raised, 0);
  const url = `${env.APP_URL}/fixed/${app.public_slug}`;
  return (
    <Layout
      env={env}
      title={`${app.name}: fixed from user reviews`}
      user={null}
      wide
      canonical={url}
      description={`${fixes.length} problems reported in ${app.name}'s app store reviews, fixed and shipped.`}
    >
      <section class="public-log">
        <p class="lp-eyebrow">Fixed from user reviews</p>
        <h1>{app.name}</h1>
        <p class="lp-sub">
          Every problem below was reported in an App Store or Google Play review, then fixed and shipped in an update.
        </p>
        <div class="stats">
          <div class="stat">
            <span class="stat-label">Problems fixed</span>
            <span class="stat-value">{fixes.length}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Reports behind them</span>
            <span class="stat-value">{reports}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Reviewers who raised their rating</span>
            <span class="stat-value good">{raised}</span>
          </div>
        </div>

        {fixes.length === 0 ? (
          <p class="empty">No fixes shipped yet. Check back after the next release.</p>
        ) : (
          <ol class="fix-list">
            {fixes.map((fix) => (
              <li>
                <span class="fix-title">{fix.title}</span>
                <span class="fix-meta">
                  Fixed in v{fix.shipped_version} · {monthDay(fix.shipped_at)} · reported by {fix.reports}
                  {fix.raised ? ` · ${fix.raised} raised their rating` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}

        <p class="public-cta">
          This log is kept by {app.name}'s developer with {env.APP_NAME}.{" "}
          <a href="/signup">Close the loop with your reviewers too →</a>
        </p>
      </section>
    </Layout>
  );
};

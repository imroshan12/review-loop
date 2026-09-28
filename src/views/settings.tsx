import type { Child, FC } from "hono/jsx";
import type { Bindings, SettingsRow, UserRow } from "../env";
import { planDetails, UNLIMITED, userPlan, type PlanDetails } from "../env";
import { hasActiveSubscription } from "../services/billing";
import { relativeTime } from "../lib/util";
import type { AuditEntry, AuditEvent } from "../queries/audit";
import { Layout, type Flash } from "./layout";

const EVENT_LABEL: Record<AuditEvent, string> = {
  sign_in: "Signed in",
  sign_out: "Signed out",
  sign_out_everywhere: "Signed out on all devices",
  store_connected: "Connected a store",
  store_key_updated: "Updated a store key",
  store_removed: "Removed a store connection",
  alert_webhooks_changed: "Changed Slack or Discord alerts",
  plan_changed: "Plan changed",
  plan_change_requested: "Requested a plan change",
  public_log_enabled: "Turned on a public fix log",
  public_log_disabled: "Turned off a public fix log",
  admin_opened: "Opened the founder dashboard",
};

interface SettingsProps {
  env: Bindings;
  user: UserRow;
  flash?: Flash | null;
  settings: SettingsRow;
  draftsUsed: number;
  draftLimit: number;
  billingReady: boolean;
  events: AuditEntry[];
}

function appsLine(plan: PlanDetails): string {
  if (plan.apps === UNLIMITED) return "Unlimited apps";
  if (plan.apps === 2) return "2 apps, like one app on both stores";
  return `${plan.apps} app${plan.apps === 1 ? "" : "s"} on either store`;
}

/** One plan card, with the action that fits: subscribe, switch, or nothing for the current plan. */
const PlanOption: FC<{
  plan: PlanDetails;
  current: PlanDetails;
  subscribed: boolean;
  scheduled: boolean;
  billingReady: boolean;
  renewsOn: string | null;
}> = ({ plan, current, subscribed, scheduled, billingReady, renewsOn }) => {
  const isCurrent = plan.plan === current.plan;
  const upgrade = plan.priceUsd > current.priceUsd;
  let action: Child = null;
  if (isCurrent) {
    action = <span class="badge ok">Your plan</span>;
  } else if (scheduled) {
    action = <span class="badge">Starts {renewsOn ?? "at renewal"}</span>;
  } else if (plan.plan === "free") {
    action = subscribed ? <span class="muted small">Cancel anytime in Manage billing</span> : null;
  } else if (!billingReady) {
    action = null;
  } else if (subscribed) {
    action = (
      <form
        method="post"
        action="/billing/change"
        class="inline"
        data-confirm={
          upgrade
            ? `Switch to ${plan.name} now? You'll be charged the difference for the rest of this billing period.`
            : `Switch to ${plan.name} from your next billing date${renewsOn ? ` (${renewsOn})` : ""}? You keep ${current.name} until then.`
        }
      >
        <input type="hidden" name="plan" value={plan.plan} />
        <button type="submit" class={`button ${upgrade ? "primary" : ""}`}>
          {upgrade ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`}
        </button>
      </form>
    );
  } else {
    action = (
      <form method="post" action="/billing/checkout" class="inline">
        <input type="hidden" name="plan" value={plan.plan} />
        <button type="submit" class={`button ${plan.plan === "plus" ? "primary" : ""}`}>
          Choose {plan.name}
        </button>
      </form>
    );
  }
  return (
    <div class={`plan-option ${isCurrent ? "current" : ""}`}>
      <h3>
        {plan.name} <span class="plan-option-price">{plan.priceUsd ? plan.priceLabel : "$0"}</span>
      </h3>
      <ul>
        <li>{appsLine(plan)}</li>
        <li>{plan.draftsPerMonth} AI drafts a month</li>
        {plan.autoFollowup ? <li>Automatic follow-ups when a release ships</li> : null}
      </ul>
      {action}
    </div>
  );
};

export const SettingsPage: FC<SettingsProps> = ({ env, user, flash, settings, draftsUsed, draftLimit, billingReady, events }) => {
  const plan = userPlan(env, user);
  const subscribed = hasActiveSubscription(user);
  const renewsOn = user.plan_renews_at ? user.plan_renews_at.slice(0, 10) : null;
  const scheduled = user.plan_scheduled ? planDetails(env, user.plan_scheduled) : null;
  return (
    <Layout env={env} title="Settings" user={user} active="settings" flash={flash}>
      <div class="page-head">
        <h1>Settings</h1>
      </div>

      <form method="post" action="/settings" class="stack settings-form">
        <section class="card">
          <h2>Your voice</h2>
          <p class="muted">AI drafts follow these notes. Include facts it may state, like what's planned and who you are.</p>
          <label>
            Notes for drafts
            <textarea name="voice_notes" rows={5} maxlength={2000} placeholder="Friendly and brief, first person. We're a two-person team. Sync fix ships next week. Dark mode is planned, CSV export isn't.">
              {settings.voice_notes}
            </textarea>
          </label>
          <label>
            Signature
            <input type="text" name="signature" maxlength={80} value={settings.signature} placeholder="— Sam, maker of FocusFlow" />
          </label>
          <label>
            Support contact
            <input type="text" name="support_contact" maxlength={120} value={settings.support_contact} placeholder="help@focusflow.app" />
          </label>
        </section>

        <section class="card">
          <h2>Alerts</h2>
          <label>
            Alert me about reviews with
            <select name="alert_max_rating">
              {[1, 2, 3, 4, 5].map((rating) => (
                <option value={String(rating)} selected={settings.alert_max_rating === rating}>
                  {rating === 5 ? "any rating" : `${rating} star${rating === 1 ? "" : "s"} or fewer`}
                </option>
              ))}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" name="email_alerts" value="1" checked={Boolean(settings.email_alerts)} />
            Email alerts to {user.email ?? "your GitHub email"}
          </label>
          <label>
            Slack webhook URL
            <input
              type="password"
              name="slack_webhook"
              autocomplete="off"
              placeholder={settings.slack_webhook ? "Saved. Paste a new URL to replace it." : "https://hooks.slack.com/services/…"}
            />
          </label>
          <label>
            Discord webhook URL
            <input
              type="password"
              name="discord_webhook"
              autocomplete="off"
              placeholder={settings.discord_webhook ? "Saved. Paste a new URL to replace it." : "https://discord.com/api/webhooks/…"}
            />
          </label>
          {settings.slack_webhook || settings.discord_webhook ? (
            <label class="check">
              <input type="checkbox" name="clear_webhooks" value="1" />
              Remove saved webhooks
            </label>
          ) : null}
        </section>

        <section class="card">
          <h2>Follow-ups</h2>
          <label class="check">
            <input
              type="checkbox"
              name="auto_followup"
              value="1"
              checked={Boolean(settings.auto_followup) && plan.autoFollowup}
              disabled={!plan.autoFollowup}
            />
            Send follow-ups automatically when a release ships {plan.autoFollowup ? "" : "(Pro)"}
          </label>
          <p class="muted small">Off by default: follow-ups wait in your inbox so you can check them first.</p>
        </section>

        <div>
          <button type="submit" class="button primary">Save settings</button>
        </div>
      </form>

      <section class="card" id="plan">
        <h2>Plan</h2>
        <p>
          You're on <strong>{plan.name}</strong>
          {plan.plan !== "free" && renewsOn ? `, ${subscribed ? "renews" : "paid through"} ${renewsOn}` : ""}. AI drafts this month:{" "}
          <strong>
            {draftsUsed} / {draftLimit}
          </strong>
          .
        </p>
        {scheduled ? (
          <div class="banner info plan-scheduled">
            <span>
              You'll move to {scheduled.name} on {renewsOn ?? "your next billing date"}.
            </span>
            <form method="post" action="/billing/keep" class="inline">
              <button type="submit" class="button small">
                Keep {plan.name}
              </button>
            </form>
          </div>
        ) : null}
        <div class="plan-options">
          {(["free", "plus", "pro"] as const).map((option) => (
            <PlanOption
              plan={planDetails(env, option)}
              current={plan}
              subscribed={subscribed}
              scheduled={scheduled?.plan === option}
              billingReady={billingReady}
              renewsOn={renewsOn}
            />
          ))}
        </div>
        {!billingReady ? <p class="muted small">Payments aren't configured on this server yet.</p> : null}
        {billingReady && user.billing_customer_id ? (
          <form method="post" action="/billing/portal" class="inline">
            <button type="submit" class="button">Manage billing</button>
          </form>
        ) : null}
      </section>

      <section class="card" id="security">
        <h2>Security</h2>
        {user.github_2fa === 0 ? (
          <p class="banner warn">
            Your GitHub account doesn't have two-factor authentication. Anyone with your GitHub password could reach your store
            keys through {env.APP_NAME}.{" "}
            <a href="https://github.com/settings/security" target="_blank" rel="noopener">
              Turn it on in GitHub
            </a>
            , then sign in again.
          </p>
        ) : user.github_2fa === 1 ? (
          <p class="muted small">Your GitHub account uses two-factor authentication.</p>
        ) : null}
        <h3>Recent activity</h3>
        {events.length === 0 ? (
          <p class="muted small">Nothing recorded yet.</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>What</th>
                <th>When</th>
                <th>Device</th>
                <th>Country</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr>
                  <td>
                    {EVENT_LABEL[event.event] ?? event.event}
                    {event.detail ? <span class="muted small"> · {event.detail}</span> : null}
                  </td>
                  <td>{relativeTime(event.created_at)}</td>
                  <td>{event.user_agent ?? "—"}</td>
                  <td>{event.country ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="muted small">Don't recognize something? Sign out everywhere, then remove and reconnect your stores with new keys.</p>
        <form
          method="post"
          action="/account/sessions/revoke"
          class="inline"
          data-confirm={`Sign out of ${env.APP_NAME} on every device, including this one?`}
        >
          <button type="submit" class="button">Sign out of all devices</button>
        </form>
      </section>

      <section class="card" id="account">
        <h2>Account</h2>
        <form
          method="post"
          action="/account/delete"
          class="inline"
          data-confirm="Delete your account, connections, and all review data? This can't be undone."
        >
          <button type="submit" class="button danger">Delete account and data</button>
        </form>
      </section>
    </Layout>
  );
};

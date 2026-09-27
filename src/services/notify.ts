import type { Bindings, ConnectionRow, InboxReview, SettingsRow, UserRow } from "../env";
import { guidePath } from "../env";
import { decryptOptional, keyring } from "../lib/secrets";
import { globalFetch, type FetchLike } from "../stores/types";

export interface Notice {
  subject: string;
  lines: string[];
  link: string;
}

function stars(rating: number): string {
  return "★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating));
}

export function lowRatingNotice(env: Bindings, reviews: InboxReview[]): Notice {
  const count = reviews.length;
  return {
    subject: count === 1 ? `New ${reviews[0].rating}-star review for ${reviews[0].app_name}` : `${count} new low-star reviews`,
    lines: reviews.slice(0, 10).map((review) => {
      const text = (review.title ? `${review.title}: ` : "") + review.body;
      return `${stars(review.rating)} ${review.app_name}: "${text.length > 140 ? text.slice(0, 139) + "…" : text}"`;
    }),
    link: `${env.APP_URL}/inbox?view=needs_reply`,
  };
}

export function followupsNotice(env: Bindings, appName: string, version: string, count: number): Notice {
  return {
    subject: `${count} follow-up${count === 1 ? "" : "s"} ready for ${appName} ${version}`,
    lines: [
      `${appName} ${version} is live. ${count} reviewer${count === 1 ? "" : "s"} reported problems you marked as fixed.`,
      "Review the drafted follow-ups and send them in one click.",
    ],
    link: `${env.APP_URL}/inbox?view=followups`,
  };
}

export function brokenConnectionNotice(
  env: Bindings,
  connection: Pick<ConnectionRow, "id" | "store" | "label">,
  error: string,
  needsUser: boolean,
): Notice {
  const storeName = connection.store === "google" ? "Google Play" : "App Store Connect";
  return {
    subject: `${env.APP_NAME} can't reach ${storeName}`,
    lines: [
      `${connection.label}: ${error}`,
      needsUser
        ? "New reviews won't show up until this is fixed. Updating the key takes about two minutes, and your reviews and replies are kept."
        : "We've been retrying for about a day and will keep trying. If it continues, check the connection.",
    ],
    link: `${env.APP_URL}${guidePath(connection.store)}?connection=${connection.id}`,
  };
}

export function releaseSpikeNotice(
  env: Bindings,
  appName: string,
  version: string,
  ratio: number,
  lowCount: number,
  complaints: string[],
): Notice {
  return {
    subject: `Release Guard: ${appName} ${version} is getting ${ratio}× more 1–2★ reviews`,
    lines: [
      `${lowCount} low ratings arrived since ${version} shipped, ${ratio}× the usual share.`,
      ...(complaints.length ? [`Top complaints: ${complaints.map((text) => `"${text}"`).join(", ")}`] : []),
      "If this is a regression, consider pausing the rollout: Phased Release in App Store Connect, or Halt rollout in Play Console.",
    ],
    link: `${env.APP_URL}/releases`,
  };
}

export function promiseNotice(env: Bindings, appName: string, title: string, told: number, days: number, issueId: string): Notice {
  return {
    subject: `${told} reviewer${told === 1 ? " is" : "s are"} still waiting on “${title}”`,
    lines: [
      `You replied to ${told} reviewer${told === 1 ? "" : "s"} of ${appName} about this ${days} days ago, and the fix hasn't shipped yet.`,
      `Ship it and ${env.APP_NAME} drafts the follow-ups, or send a quick update so they don't feel ignored.`,
    ],
    link: `${env.APP_URL}/issues/${issueId}`,
  };
}

async function postJson(fetcher: FetchLike, url: string, body: unknown): Promise<void> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
}

/** Sends a notice to every channel the user set up. Failures are logged, not thrown. */
export async function deliverNotice(
  env: Bindings,
  user: Pick<UserRow, "email">,
  settings: SettingsRow,
  notice: Notice,
  fetcher: FetchLike = globalFetch,
): Promise<number> {
  // Notices quote reviewers, so their text is made inert for each channel; only our own link stays live.
  const body = [notice.subject, ...notice.lines].join("\n");
  const text = `${body}\n${notice.link}`;
  const jobs: Array<Promise<void>> = [];

  // A webhook that can't be decrypted (say, the old key was removed too early) skips that channel, never the run.
  const open = async (sealed: string | null, channel: string) => {
    try {
      return await decryptOptional(keyring(env), sealed);
    } catch (error) {
      console.warn(`${channel} webhook can't be decrypted:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const slack = await open(settings.slack_webhook, "Slack");
  if (slack) jobs.push(postJson(fetcher, slack, { text: `${slackEscape(body)}\n${notice.link}` }));

  const discord = await open(settings.discord_webhook, "Discord");
  if (discord) {
    const room = DISCORD_LIMIT - notice.link.length - 1;
    jobs.push(
      postJson(fetcher, discord, {
        content: `${discordEscape(body).slice(0, room)}\n${notice.link}`,
        allowed_mentions: { parse: [] },
      }),
    );
  }

  if (settings.email_alerts && user.email && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const html = `<p><strong>${escapeHtml(notice.subject)}</strong></p>${notice.lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("")}<p><a href="${escapeHtml(notice.link)}">Open ${escapeHtml(env.APP_NAME)}</a></p>`;
    jobs.push(
      (async () => {
        const response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: env.EMAIL_FROM, to: [user.email], subject: notice.subject, html, text }),
        });
        if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
      })(),
    );
  }

  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === "rejected") console.warn("notification failed:", String(result.reason));
  }
  return results.filter((result) => result.status === "fulfilled").length;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const DISCORD_LIMIT = 1900;

/** Slack reads <...> as links and mentions (<!channel>, <url|disguised text>); escaped, they show as typed. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Backslash-escapes Discord markdown, so a review can't render as a disguised [link](url) or break formatting. */
export function discordEscape(text: string): string {
  return text.replace(/[\\*_~`|[\]<>]/g, "\\$&");
}

/** Cloudflare Workers rate limiting binding (see `ratelimits` in wrangler.jsonc). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Bindings {
  DB: D1Database;

  // Rate limiters. Optional so the app still runs where the binding isn't available.
  RL_AUTH?: RateLimiter;
  RL_WRITE?: RateLimiter;
  RL_AI?: RateLimiter;
  RL_PUBLIC?: RateLimiter;
  RL_WEBHOOK?: RateLimiter;

  APP_NAME: string;
  APP_URL: string;
  SUPPORT_EMAIL: string;
  AI_MODEL: string;
  FREE_APP_LIMIT: string;
  FREE_AI_DRAFTS_PER_MONTH: string;
  PLUS_APP_LIMIT: string;
  PLUS_AI_DRAFTS_PER_MONTH: string;
  PLUS_PRICE_LABEL: string;
  PLUS_PRICE_USD: string;
  PRO_AI_DRAFTS_PER_MONTH: string;
  PRO_PRICE_LABEL: string;
  PRO_PRICE_USD: string;
  FREE_AI_DAILY_CAP: string;
  AI_DAILY_CAP: string;
  ADMIN_GITHUB_IDS: string;
  ADMIN_GITHUB_LOGINS: string;
  BENCHMARK_MIN_APPS: string;
  PROMISE_DAYS: string;
  DODO_MODE: string;
  DEV_LOGIN: string;

  // Secrets (wrangler secret put / .dev.vars)
  ENCRYPTION_KEY: string;
  /** The key before the last rotation. Still decrypts; data is re-encrypted with ENCRYPTION_KEY when read. */
  ENCRYPTION_KEY_PREVIOUS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
  /** Dodo product ids, comma-separated: the first is sold at checkout, all of them count (for example a launch-price product). */
  DODO_PLUS_PRODUCT_ID?: string;
  DODO_PRO_PRODUCT_ID?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export type Store = "apple" | "google" | "demo";
export type Plan = "free" | "plus" | "pro";
export type PaidPlan = Exclude<Plan, "free">;
export type ReviewStatus = "open" | "done" | "fix_pending" | "followup_ready" | "followed_up";
export type ReplyState = "none" | "existing" | "sent" | "failed";
export type ReviewCategory = "bug" | "feature_request" | "praise" | "pricing" | "question" | "other";

export interface UserRow {
  id: string;
  github_id: number | null;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  plan: Plan;
  plan_status: string | null;
  plan_renews_at: string | null;
  /** A downgrade booked for the next billing date, until it takes effect. */
  plan_scheduled: PaidPlan | null;
  billing_customer_id: string | null;
  billing_subscription_id: string | null;
  sample_loaded_at: string | null;
  github_2fa: number | null;
  created_at: string;
}

export interface SettingsRow {
  user_id: string;
  voice_notes: string;
  signature: string;
  support_contact: string;
  alert_max_rating: number;
  email_alerts: number;
  slack_webhook: string | null;
  discord_webhook: string | null;
  auto_followup: number;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  store: Store;
  label: string;
  credentials: string;
  status: "ok" | "error";
  last_error: string | null;
  last_synced_at: string | null;
  failure_count: number;
  next_sync_at: string | null;
  failure_notified_at: string | null;
  created_at: string;
}

export interface AppRow {
  id: string;
  user_id: string;
  connection_id: string;
  store: Store;
  store_app_id: string;
  name: string;
  bundle_id: string | null;
  enabled: number;
  latest_version: string | null;
  auto_release: number;
  last_review_at: string | null;
  public_slug: string | null;
  public_log: number;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  user_id: string;
  app_id: string;
  store: Store;
  store_review_id: string;
  rating: number;
  rating_before: number | null;
  rating_raised_at: string | null;
  title: string | null;
  body: string;
  author: string | null;
  territory: string | null;
  language: string | null;
  app_version: string | null;
  device: string | null;
  reviewed_at: string;
  category: ReviewCategory | null;
  summary: string | null;
  draft: string | null;
  reply_text: string | null;
  reply_state: ReplyState;
  reply_error: string | null;
  replied_at: string | null;
  store_response_id: string | null;
  status: ReviewStatus;
  fix_note: string | null;
  fix_pending_at: string | null;
  fixed_in_version: string | null;
  followup_draft: string | null;
  followup_ai: number;
  followed_up_at: string | null;
  alerted_at: string | null;
  issue_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A review joined with the app it belongs to (and its issue, if any), as shown in the inbox. */
export interface InboxReview extends ReviewRow {
  app_name: string;
  issue_title?: string | null;
}

export interface IssueRow {
  id: string;
  user_id: string;
  app_id: string;
  title: string;
  fix_note: string | null;
  target_version: string | null;
  status: "open" | "shipped";
  shipped_version: string | null;
  shipped_at: string | null;
  reminded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReleaseRow {
  id: string;
  app_id: string;
  version: string;
  released_at: string;
  source: "store" | "reviews" | "manual";
  followups_created: number;
  guard_status: "ok" | "spike" | null;
  guard_ratio: number | null;
  guard_low: number | null;
  guard_checked_at: string | null;
}

export function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const GRACE_MS = 3 * 24 * 3600 * 1000;

/** The plan a user has right now. A paid plan keeps working for 3 days past the paid-through date while a renewal is retried. */
export function currentPlan(user: Pick<UserRow, "plan" | "plan_renews_at">, now = Date.now()): Plan {
  if (user.plan !== "plus" && user.plan !== "pro") return "free";
  if (user.plan_renews_at && Date.parse(user.plan_renews_at) + GRACE_MS <= now) return "free";
  return user.plan;
}

export const UNLIMITED = Number.MAX_SAFE_INTEGER;

export interface PlanDetails {
  plan: Plan;
  name: string;
  /** Real-store apps that can be tracked at the same time. Each store listing counts once. */
  apps: number;
  draftsPerMonth: number;
  autoFollowup: boolean;
  priceLabel: string;
  priceUsd: number;
}

type PlanSettings = Partial<
  Pick<
    Bindings,
    | "FREE_APP_LIMIT"
    | "FREE_AI_DRAFTS_PER_MONTH"
    | "PLUS_APP_LIMIT"
    | "PLUS_AI_DRAFTS_PER_MONTH"
    | "PLUS_PRICE_LABEL"
    | "PLUS_PRICE_USD"
    | "PRO_AI_DRAFTS_PER_MONTH"
    | "PRO_PRICE_LABEL"
    | "PRO_PRICE_USD"
  >
>;

/** What each plan includes. Paid features are gated only here, so the limits can't drift apart across pages. */
export function planDetails(env: PlanSettings, plan: Plan): PlanDetails {
  if (plan === "pro") {
    return {
      plan,
      name: "Pro",
      apps: UNLIMITED,
      draftsPerMonth: envNumber(env.PRO_AI_DRAFTS_PER_MONTH, 500),
      autoFollowup: true,
      priceLabel: env.PRO_PRICE_LABEL || "$10/month",
      priceUsd: envNumber(env.PRO_PRICE_USD, 10),
    };
  }
  if (plan === "plus") {
    return {
      plan,
      name: "Plus",
      apps: envNumber(env.PLUS_APP_LIMIT, 2),
      draftsPerMonth: envNumber(env.PLUS_AI_DRAFTS_PER_MONTH, 100),
      autoFollowup: false,
      priceLabel: env.PLUS_PRICE_LABEL || "$5/month",
      priceUsd: envNumber(env.PLUS_PRICE_USD, 5),
    };
  }
  return {
    plan,
    name: "Free",
    apps: envNumber(env.FREE_APP_LIMIT, 1),
    draftsPerMonth: envNumber(env.FREE_AI_DRAFTS_PER_MONTH, 20),
    autoFollowup: false,
    priceLabel: "$0",
    priceUsd: 0,
  };
}

/** The limits that apply to this user right now. */
export function userPlan(env: PlanSettings, user: Pick<UserRow, "plan" | "plan_renews_at">, now = Date.now()): PlanDetails {
  return planDetails(env, currentPlan(user, now));
}

/** The step-by-step setup page for a store. */
export function guidePath(store: Store): string {
  return store === "google" ? "/guide/google-play" : "/guide/app-store";
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Founder access to /admin. Numeric GitHub ids (ADMIN_GITHUB_IDS) can't be taken over by someone
 * registering a username you gave up, so they win when set; usernames are the fallback.
 */
export function isAdmin(
  env: Partial<Pick<Bindings, "ADMIN_GITHUB_IDS" | "ADMIN_GITHUB_LOGINS">>,
  user: Pick<UserRow, "login"> & Partial<Pick<UserRow, "github_id">> | null,
): boolean {
  if (!user) return false;
  const ids = list(env.ADMIN_GITHUB_IDS);
  if (ids.length) return user.github_id != null && ids.includes(String(user.github_id));
  return list(env.ADMIN_GITHUB_LOGINS).includes(user.login.toLowerCase());
}

export function replyLimit(store: Store): number {
  // Google Play caps developer replies at 350 characters; Apple allows ~5,970.
  return store === "google" ? 350 : 5970;
}

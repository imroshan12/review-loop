import * as db from "../db";
import type { Bindings, PaidPlan, Plan, UserRow } from "../env";
import { currentPlan, planDetails } from "../env";
import { verifyStandardWebhook } from "../lib/webhooks";
import { logEvent } from "../queries/audit";
import { globalFetch, type FetchLike } from "../stores/types";
import { UserFacingError } from "./reviews";

export const PAID_PLANS: readonly PaidPlan[] = ["plus", "pro"];
const RANK: Record<Plan, number> = { free: 0, plus: 1, pro: 2 };

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "plus" || value === "pro";
}

function apiBase(env: Bindings): string {
  return env.DODO_MODE === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
}

/** A plan's Dodo product ids. The first is sold at checkout; all of them count, so a launch-price product can be added. */
function productIds(env: Pick<Bindings, "DODO_PLUS_PRODUCT_ID" | "DODO_PRO_PRODUCT_ID">, plan: PaidPlan): string[] {
  const value = plan === "pro" ? env.DODO_PRO_PRODUCT_ID : env.DODO_PLUS_PRODUCT_ID;
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The plan a Dodo product unlocks, or null for a product this app doesn't sell. */
export function planForProduct(
  env: Pick<Bindings, "DODO_PLUS_PRODUCT_ID" | "DODO_PRO_PRODUCT_ID">,
  productId: string | null | undefined,
): PaidPlan | null {
  if (!productId) return null;
  return PAID_PLANS.find((plan) => productIds(env, plan).includes(productId)) ?? null;
}

export function billingConfigured(env: Bindings): boolean {
  return Boolean(
    env.DODO_API_KEY && env.DODO_WEBHOOK_SECRET && productIds(env, "plus").length && productIds(env, "pro").length,
  );
}

/** Paying through a live subscription, which can be switched between plans instead of buying a second one. */
export function hasActiveSubscription(
  user: Pick<UserRow, "plan" | "plan_renews_at" | "plan_status" | "billing_subscription_id">,
): boolean {
  return currentPlan(user) !== "free" && Boolean(user.billing_subscription_id) && user.plan_status === "active";
}

class DodoError extends Error {
  constructor(readonly status: number) {
    super(`Dodo returned HTTP ${status}`);
  }
}

async function dodo<T>(env: Bindings, path: string, init: RequestInit, fetcher: FetchLike): Promise<T> {
  const response = await fetcher(`${apiBase(env)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.DODO_API_KEY}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`Dodo ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    throw new DodoError(response.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Creates a hosted checkout for a plan and returns its URL. */
export async function createCheckout(env: Bindings, user: UserRow, plan: PaidPlan, fetcher: FetchLike = globalFetch): Promise<string> {
  if (!billingConfigured(env)) throw new UserFacingError("Payments aren't set up yet.", 400);
  // A second subscription would bill twice: subscribers switch plans instead.
  if (hasActiveSubscription(user)) {
    throw new UserFacingError("You already have a subscription. Switch plans in Settings instead of buying a second one.", 409);
  }
  const session = await dodo<{ checkout_url?: string }>(
    env,
    "/checkouts",
    {
      method: "POST",
      body: JSON.stringify({
        product_cart: [{ product_id: productIds(env, plan)[0], quantity: 1 }],
        customer: { email: user.email ?? undefined, name: user.name ?? user.login },
        metadata: { user_id: user.id, plan },
        return_url: `${env.APP_URL}/billing/return`,
      }),
    },
    fetcher,
  ).catch(() => {
    throw new UserFacingError("The payment page couldn't be opened. Try again in a minute.", 502);
  });
  if (!session.checkout_url) throw new UserFacingError("The payment page couldn't be opened. Try again in a minute.", 502);
  return session.checkout_url;
}

/**
 * Dodo's change-plan request. Upgrades start now and charge the difference, and don't happen if that
 * payment fails. Downgrades wait for the next billing date, so nobody loses days they paid for.
 */
export function changePlanRequest(current: PaidPlan, target: PaidPlan, productId: string): { upgrade: boolean; body: Record<string, unknown> } {
  const upgrade = RANK[target] > RANK[current];
  return {
    upgrade,
    body: upgrade
      ? {
          product_id: productId,
          quantity: 1,
          proration_billing_mode: "difference_immediately",
          effective_at: "immediately",
          on_payment_failure: "prevent_change",
        }
      : { product_id: productId, quantity: 1, proration_billing_mode: "difference_immediately", effective_at: "next_billing_date" },
  };
}

/** Moves an existing subscription to another plan. The plan itself changes when Dodo's webhook confirms it. */
export async function changePlan(
  env: Bindings,
  user: UserRow,
  target: PaidPlan,
  fetcher: FetchLike = globalFetch,
): Promise<"upgraded" | "scheduled"> {
  if (!billingConfigured(env)) throw new UserFacingError("Payments aren't set up yet.", 400);
  const current = currentPlan(user);
  if (current === "free" || !hasActiveSubscription(user)) {
    throw new UserFacingError("There's no active subscription to change. Choose a plan to subscribe.", 409);
  }
  if (current === target) throw new UserFacingError(`You're already on ${planDetails(env, target).name}.`, 409);
  const { upgrade, body } = changePlanRequest(current, target, productIds(env, target)[0]);
  try {
    await dodo(
      env,
      `/subscriptions/${encodeURIComponent(user.billing_subscription_id!)}/change-plan`,
      { method: "POST", body: JSON.stringify(body) },
      fetcher,
    );
  } catch (error) {
    if (error instanceof DodoError && error.status === 409) {
      throw new UserFacingError("A plan change is already booked. Keep your current plan first, then choose again.", 409);
    }
    throw new UserFacingError("The plan couldn't be changed right now. Try again in a minute, or use Manage billing.", 502);
  }
  return upgrade ? "upgraded" : "scheduled";
}

/** Cancels a downgrade booked for the next billing date. */
export async function cancelScheduledChange(env: Bindings, user: UserRow, fetcher: FetchLike = globalFetch): Promise<void> {
  if (!billingConfigured(env) || !user.billing_subscription_id) throw new UserFacingError("There's no subscription on this account.", 404);
  try {
    await dodo(
      env,
      `/subscriptions/${encodeURIComponent(user.billing_subscription_id)}/change-plan/scheduled`,
      { method: "DELETE" },
      fetcher,
    );
  } catch (error) {
    // Nothing booked on Dodo's side any more (it already applied, or was cancelled there): clearing ours is still right.
    if (error instanceof DodoError && error.status === 404) return;
    throw new UserFacingError("The booked change couldn't be cancelled right now. Try again in a minute.", 502);
  }
}

/** Opens the customer portal where subscribers can update cards or cancel. */
export async function createPortalLink(env: Bindings, user: UserRow, fetcher: FetchLike = globalFetch): Promise<string> {
  if (!billingConfigured(env) || !user.billing_customer_id) {
    throw new UserFacingError("There's no subscription to manage on this account.", 404);
  }
  const params = new URLSearchParams({ return_url: `${env.APP_URL}/settings` });
  const portal = await dodo<{ link?: string }>(
    env,
    `/customers/${encodeURIComponent(user.billing_customer_id)}/customer-portal/session?${params}`,
    { method: "POST" },
    fetcher,
  ).catch(() => {
    throw new UserFacingError("The billing portal couldn't be opened. Try again in a minute.", 502);
  });
  if (!portal.link) throw new UserFacingError("The billing portal couldn't be opened. Try again in a minute.", 502);
  return portal.link;
}

interface SubscriptionPayload {
  subscription_id?: string;
  product_id?: string;
  status?: string;
  next_billing_date?: string | null;
  customer?: { customer_id?: string; email?: string };
  customer_id?: string;
  customer_email?: string;
  metadata?: Record<string, string>;
}

interface WebhookEvent {
  type?: string;
  data?: SubscriptionPayload;
}

/** Events that confirm a live subscription on a product. */
const ACTIVE_EVENTS = new Set([
  "subscription.active",
  "subscription.renewed",
  "subscription.plan_changed",
  "subscription.updated",
  "subscription.unpaused",
]);
/** After these, the subscription no longer pays for anything. */
const ENDING_EVENTS = new Set([
  "subscription.cancelled",
  "subscription.expired",
  "subscription.failed",
  "subscription.on_hold",
  "subscription.paused",
]);
const ENDING_STATUSES = new Set(["cancelled", "expired", "failed", "on_hold", "paused"]);
// Anything else (past_due while a renewal is retried, pending before a first payment) changes nothing:
// access continues through currentPlan's grace period.

/** Verifies and applies a Dodo Payments webhook. Returns an HTTP status for the response. */
export async function handleBillingWebhook(env: Bindings, request: Request): Promise<number> {
  if (!env.DODO_WEBHOOK_SECRET) return 404;
  const body = await request.text();
  const headers = {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  };
  if (!(await verifyStandardWebhook(env.DODO_WEBHOOK_SECRET, headers, body))) return 401;

  const event = JSON.parse(body) as WebhookEvent;
  const type = event.type ?? "unknown";
  if (!type.startsWith("subscription.")) return 200;
  if (!(await db.claimBillingEvent(env.DB, headers.id!, type))) return 200;

  const data = event.data ?? {};
  const customerId = data.customer?.customer_id ?? data.customer_id ?? null;
  const user = await db.findUserForBilling(env.DB, {
    userId: data.metadata?.user_id,
    subscriptionId: data.subscription_id,
    customerId,
    email: data.customer?.email ?? data.customer_email,
  });
  if (!user) {
    console.warn(`billing webhook ${type}: no matching user`);
    return 200;
  }

  const status = data.status ?? (ACTIVE_EVENTS.has(type) ? "active" : type.replace("subscription.", ""));
  const ending = ENDING_EVENTS.has(type) || ENDING_STATUSES.has(status);
  const granting = !ending && ACTIVE_EVENTS.has(type) && status === "active";
  if (!ending && !granting) return 200;

  const tracked = user.billing_subscription_id;
  const otherSubscription = Boolean(tracked && data.subscription_id && data.subscription_id !== tracked);
  // An old subscription ending (say, a cancelled Pro running out after the user bought Plus) must not end the new one.
  if (ending && otherSubscription) {
    console.warn(`billing webhook ${type}: ignored for ${data.subscription_id}, user is on ${tracked}`);
    return 200;
  }

  const nextBilling = data.next_billing_date ? new Date(data.next_billing_date).toISOString() : null;
  const productPlan = planForProduct(env, data.product_id);
  const before = currentPlan(user);
  let plan: Plan;
  if (granting) {
    if (!productPlan) {
      console.warn(
        `billing webhook ${type}: product ${data.product_id ?? "(none)"} isn't in DODO_PLUS_PRODUCT_ID or DODO_PRO_PRODUCT_ID, so no plan was granted`,
      );
      return 200;
    }
    if (otherSubscription && hasActiveSubscription(user)) {
      // Two live subscriptions (say, two checkout tabs): the founder refunds one in Dodo. Until then the
      // better plan stays, so renewals of the other don't flip the user back and forth.
      console.warn(`billing: user ${user.id} has ${data.subscription_id} while ${tracked} is still active`);
      await logEvent(env.DB, {
        userId: user.id,
        event: "plan_changed",
        detail: "A second subscription is active next to the first. Check Dodo for double billing.",
      });
      if (RANK[productPlan] <= RANK[before]) return 200;
    }
    plan = productPlan;
    await db.updateBilling(env.DB, user.id, {
      plan,
      status,
      renewsAt: nextBilling,
      customerId,
      subscriptionId: data.subscription_id ?? null,
      // A booked downgrade has now happened, or a new purchase replaced it.
      clearScheduled: type === "subscription.plan_changed" || otherSubscription || user.plan_scheduled === plan,
    });
  } else {
    // A cancelled subscription keeps its plan until the end of the period that was paid for.
    const paidThroughFuture = type === "subscription.cancelled" && nextBilling !== null && Date.parse(nextBilling) > Date.now();
    plan = paidThroughFuture ? (productPlan ?? before) : "free";
    await db.updateBilling(env.DB, user.id, {
      plan,
      status,
      renewsAt: paidThroughFuture ? nextBilling : null,
      customerId,
      subscriptionId: data.subscription_id ?? null,
      clearScheduled: true,
    });
  }

  const allowed = planDetails(env, plan).apps;
  if (allowed < planDetails(env, before).apps) await db.enforceAppLimit(env.DB, user.id, allowed);
  if (plan !== user.plan) {
    await logEvent(env.DB, { userId: user.id, event: "plan_changed", detail: `${planDetails(env, plan).name} (${type})` });
  }
  return 200;
}

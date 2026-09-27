import * as db from "../db";
import type { Bindings, UserRow } from "../env";
import { envNumber } from "../env";
import { verifyStandardWebhook } from "../lib/webhooks";
import { logEvent } from "../queries/audit";
import { globalFetch, type FetchLike } from "../stores/types";
import { UserFacingError } from "./reviews";

function apiBase(env: Bindings): string {
  return env.DODO_MODE === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
}

export function billingConfigured(env: Bindings): boolean {
  return Boolean(env.DODO_API_KEY && env.DODO_PRODUCT_ID && env.DODO_WEBHOOK_SECRET);
}

async function dodo<T>(env: Bindings, path: string, init: RequestInit, fetcher: FetchLike): Promise<T> {
  const response = await fetcher(`${apiBase(env)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.DODO_API_KEY}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`Dodo ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    throw new UserFacingError("The payment page couldn't be opened. Try again in a minute.", 502);
  }
  return JSON.parse(text) as T;
}

/** Creates a hosted checkout for the Pro subscription and returns its URL. */
export async function createCheckout(env: Bindings, user: UserRow, fetcher: FetchLike = globalFetch): Promise<string> {
  if (!billingConfigured(env)) throw new UserFacingError("Payments aren't set up yet.", 400);
  const session = await dodo<{ checkout_url?: string }>(
    env,
    "/checkouts",
    {
      method: "POST",
      body: JSON.stringify({
        product_cart: [{ product_id: env.DODO_PRODUCT_ID, quantity: 1 }],
        customer: { email: user.email ?? undefined, name: user.name ?? user.login },
        metadata: { user_id: user.id },
        return_url: `${env.APP_URL}/billing/return`,
      }),
    },
    fetcher,
  );
  if (!session.checkout_url) throw new UserFacingError("The payment page couldn't be opened. Try again in a minute.", 502);
  return session.checkout_url;
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
  );
  if (!portal.link) throw new UserFacingError("The billing portal couldn't be opened. Try again in a minute.", 502);
  return portal.link;
}

interface SubscriptionPayload {
  subscription_id?: string;
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

const GRANTS_PRO = new Set(["subscription.active", "subscription.renewed", "subscription.plan_changed", "subscription.updated"]);
const ENDS_PRO = new Set(["subscription.cancelled", "subscription.expired", "subscription.failed", "subscription.on_hold"]);

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

  const nextBilling = data.next_billing_date ? new Date(data.next_billing_date).toISOString() : null;
  let plan: "pro" | "free" | null = null;
  if (GRANTS_PRO.has(type) && (data.status === undefined || data.status === "active")) {
    plan = "pro";
    await db.updateBilling(env.DB, user.id, {
      plan,
      status: data.status ?? "active",
      renewsAt: nextBilling,
      customerId,
      subscriptionId: data.subscription_id ?? null,
    });
  } else if (ENDS_PRO.has(type) || (data.status && data.status !== "active")) {
    // Cancelled subscriptions keep Pro until the end of the paid period.
    const paidThroughFuture = type === "subscription.cancelled" && nextBilling && Date.parse(nextBilling) > Date.now();
    plan = paidThroughFuture ? "pro" : "free";
    await db.updateBilling(env.DB, user.id, {
      plan,
      status: data.status ?? type.replace("subscription.", ""),
      renewsAt: paidThroughFuture ? nextBilling : null,
      customerId,
      subscriptionId: data.subscription_id ?? null,
    });
    if (!paidThroughFuture) await db.enforceAppLimit(env.DB, user.id, envNumber(env.FREE_APP_LIMIT, 1));
  }
  if (plan && user.plan !== plan) {
    await logEvent(env.DB, { userId: user.id, event: "plan_changed", detail: `${plan === "pro" ? "Pro" : "Free"} (${type})` });
  }
  return 200;
}

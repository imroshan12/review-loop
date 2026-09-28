import { describe, expect, it } from "vitest";
import type { Bindings, UserRow } from "../src/env";
import { changePlan, changePlanRequest, createCheckout, hasActiveSubscription, planForProduct } from "../src/services/billing";

const env = {
  APP_URL: "https://reviewloop.example",
  DODO_MODE: "test",
  DODO_API_KEY: "test-key",
  DODO_WEBHOOK_SECRET: "whsec_dGVzdA==",
  DODO_PLUS_PRODUCT_ID: "prod_plus, prod_plus_launch",
  DODO_PRO_PRODUCT_ID: "prod_pro",
} as unknown as Bindings;

const future = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u1",
    github_id: 1,
    login: "sam",
    name: "Sam",
    email: "sam@example.com",
    avatar_url: null,
    plan: "free",
    plan_status: null,
    plan_renews_at: null,
    plan_scheduled: null,
    billing_customer_id: null,
    billing_subscription_id: null,
    sample_loaded_at: null,
    github_2fa: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const subscriber = (plan: "plus" | "pro") =>
  user({ plan, plan_status: "active", plan_renews_at: future, billing_customer_id: "cus_1", billing_subscription_id: "sub_1" });

function recorder(response: unknown = {}, status = 200) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(response), { status });
  };
  return { calls, fetcher };
}

describe("plans and Dodo products", () => {
  it("maps every configured product, including extra launch-price ones, to its plan", () => {
    expect(planForProduct(env, "prod_plus")).toBe("plus");
    expect(planForProduct(env, "prod_plus_launch")).toBe("plus");
    expect(planForProduct(env, "prod_pro")).toBe("pro");
    // A product this app doesn't sell never unlocks anything.
    expect(planForProduct(env, "prod_something_else")).toBeNull();
    expect(planForProduct(env, undefined)).toBeNull();
  });

  it("only treats a live subscription as switchable", () => {
    expect(hasActiveSubscription(subscriber("plus"))).toBe(true);
    expect(hasActiveSubscription(user())).toBe(false);
    expect(hasActiveSubscription({ ...subscriber("pro"), plan_status: "cancelled" })).toBe(false);
    expect(hasActiveSubscription({ ...subscriber("pro"), billing_subscription_id: null })).toBe(false);
  });
});

describe("checkout", () => {
  it("sells the chosen plan's product and tags it with the user", async () => {
    const { calls, fetcher } = recorder({ checkout_url: "https://test.checkout.dodopayments.com/abc" });
    expect(await createCheckout(env, user(), "plus", fetcher)).toBe("https://test.checkout.dodopayments.com/abc");
    expect(calls[0].url).toBe("https://test.dodopayments.com/checkouts");
    expect(calls[0].body).toMatchObject({ product_cart: [{ product_id: "prod_plus", quantity: 1 }], metadata: { user_id: "u1", plan: "plus" } });
  });

  it("refuses a second subscription, which would bill twice", async () => {
    const { calls, fetcher } = recorder({ checkout_url: "x" });
    await expect(createCheckout(env, subscriber("plus"), "pro", fetcher)).rejects.toThrow("Switch plans");
    expect(calls).toHaveLength(0);
  });

  it("lets a cancelled subscriber subscribe again", async () => {
    const { fetcher } = recorder({ checkout_url: "https://test.checkout.dodopayments.com/new" });
    const cancelled = { ...subscriber("pro"), plan_status: "cancelled" };
    expect(await createCheckout(env, cancelled, "plus", fetcher)).toContain("/new");
  });
});

describe("switching plans", () => {
  it("upgrades now, charging the difference, and never on a failed payment", () => {
    expect(changePlanRequest("plus", "pro", "prod_pro")).toEqual({
      upgrade: true,
      body: {
        product_id: "prod_pro",
        quantity: 1,
        proration_billing_mode: "difference_immediately",
        effective_at: "immediately",
        on_payment_failure: "prevent_change",
      },
    });
  });

  it("downgrades at the next billing date, so paid days aren't lost", () => {
    const { upgrade, body } = changePlanRequest("pro", "plus", "prod_plus");
    expect(upgrade).toBe(false);
    expect(body).toMatchObject({ product_id: "prod_plus", effective_at: "next_billing_date" });
  });

  it("changes the existing subscription instead of creating another", async () => {
    const { calls, fetcher } = recorder();
    expect(await changePlan(env, subscriber("plus"), "pro", fetcher)).toBe("upgraded");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://test.dodopayments.com/subscriptions/sub_1/change-plan" });
    expect(await changePlan(env, subscriber("pro"), "plus", recorder().fetcher)).toBe("scheduled");
  });

  it("explains a change that's already booked", async () => {
    const { fetcher } = recorder({ code: "PendingPlanChangeExists" }, 409);
    await expect(changePlan(env, subscriber("pro"), "plus", fetcher)).rejects.toThrow("already booked");
  });

  it("refuses to switch without a live subscription or to the same plan", async () => {
    await expect(changePlan(env, user(), "plus", recorder().fetcher)).rejects.toThrow("no active subscription");
    await expect(changePlan(env, subscriber("plus"), "plus", recorder().fetcher)).rejects.toThrow("already on Plus");
  });
});

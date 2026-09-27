import { describe, expect, it } from "vitest";
import { isRecentSignIn } from "../src/auth";
import type { Bindings } from "../src/env";
import { isAdmin } from "../src/env";
import worker from "../src/index";
import { bytesToBase64 } from "../src/lib/encoding";
import { memoryAllow } from "../src/lib/ratelimit";
import { currentSealPattern, decryptJson, decryptOptional, encryptJson, keyId, keyring, openSealed } from "../src/lib/secrets";
import { contentSecurityPolicy, describeUserAgent, hashIp, safeNextPath } from "../src/lib/security";

const newKey = () => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

const baseEnv = {
  APP_NAME: "ReviewLoop",
  APP_URL: "http://localhost:8787",
  SUPPORT_EMAIL: "help@example.com",
  DEV_LOGIN: "false",
  ENCRYPTION_KEY: newKey(),
  PRO_PRICE_LABEL: "$9/month",
  PRO_PRICE_USD: "9",
  FREE_AI_DRAFTS_PER_MONTH: "20",
  PRO_AI_DRAFTS_PER_MONTH: "500",
  FREE_APP_LIMIT: "1",
  ADMIN_GITHUB_IDS: "",
  ADMIN_GITHUB_LOGINS: "",
} as unknown as Bindings;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

let ipCounter = 0;
/** Each test gets its own client IP so the in-memory rate limiter doesn't carry over between tests. */
function request(path: string, init: RequestInit & { ip?: string } = {}, env: Partial<Bindings> = {}, origin = "http://localhost:8787") {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", init.ip ?? `10.0.0.${++ipCounter}`);
  return worker.fetch(new Request(`${origin}${path}`, { ...init, headers }), { ...baseEnv, ...env } as Bindings, ctx);
}

describe("security headers", () => {
  it("sets a strict policy on every page", async () => {
    const response = await request("/healthz");
    expect(response.status).toBe(200);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    // HSTS only makes sense over https.
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("adds HSTS and upgrades insecure requests over https", async () => {
    const response = await request("/healthz", {}, { APP_URL: "https://reviewloop.example" }, "https://reviewloop.example");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
    expect(contentSecurityPolicy(true)).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy(false)).not.toContain("upgrade-insecure-requests");
  });

  it("lets other sites embed badges, which can't run or load anything", async () => {
    const response = await request("/badge/no.svg");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("publishes security.txt with a contact and an expiry", async () => {
    const text = await (await request("/.well-known/security.txt")).text();
    expect(text).toContain("Contact: mailto:help@example.com");
    expect(text).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
  });
});

describe("cross-site request protection", () => {
  it("blocks form posts from other sites and requests without an origin", async () => {
    expect((await request("/settings", { method: "POST", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await request("/settings", { method: "POST" })).status).toBe(403);
    expect((await request("/auth/logout", { method: "POST", headers: { Referer: "https://evil.example/page" } })).status).toBe(403);
  });

  it("only accepts JSON on the API", async () => {
    const response = await request("/api/sync", {
      method: "POST",
      headers: { Origin: "http://localhost:8787", "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects oversized bodies", async () => {
    const response = await request("/api/sync", {
      method: "POST",
      headers: { Origin: "http://localhost:8787", "Content-Type": "application/json", "Content-Length": String(100 * 1024) },
      body: JSON.stringify({ padding: "x".repeat(100 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("rate limiting", () => {
  it("allows a burst up to the limit, then answers 429 with Retry-After", async () => {
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await request("/login", { ip })).status);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    const blocked = await request("/login", { ip });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    // Another network isn't affected.
    expect((await request("/login")).status).toBe(200);
  });

  it("uses a sliding window per bucket and key", () => {
    const start = 1_000_000;
    for (let i = 0; i < 12; i++) expect(memoryAllow("ai", "user-1", start + i)).toBe(true);
    expect(memoryAllow("ai", "user-1", start + 100)).toBe(false);
    expect(memoryAllow("ai", "user-2", start + 100)).toBe(true);
    expect(memoryAllow("write", "user-1", start + 100)).toBe(true);
    expect(memoryAllow("ai", "user-1", start + 60_000)).toBe(true);
  });
});

describe("sign-in", () => {
  it("never follows a next link off the site", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "evil", "/ok\r\nSet-Cookie: x=1", null, undefined, ""]) {
      expect(safeNextPath(bad)).toBeNull();
    }
    expect(safeNextPath("/admin")).toBe("/admin");
    expect(safeNextPath("/inbox?view=all&issue=1")).toBe("/inbox?view=all&issue=1");
  });

  it("drops an unsafe next link from the sign-in button", async () => {
    const html = await (await request("/login?next=//evil.example")).text();
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="/auth/github"');
    const safe = await (await request("/signup?next=/issues")).text();
    expect(safe).toContain('href="/auth/github?next=%2Fissues"');
  });

  it("refuses the dev account on a real deployment, even with DEV_LOGIN on", async () => {
    // https app URL: no dev login, and GitHub isn't configured, so sign-in is unavailable.
    expect((await request("/auth/github", {}, { DEV_LOGIN: "true", APP_URL: "https://reviewloop.example" })).status).toBe(503);
    // http app URL, but not a local address.
    expect((await request("/auth/github", {}, { DEV_LOGIN: "true", APP_URL: "http://reviewloop.example" }, "http://reviewloop.example")).status).toBe(503);
  });

  it("sends GitHub's cancel back to the sign-in page, not an error", async () => {
    const response = await request("/auth/github/callback?error=access_denied");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign-in was cancelled on GitHub");
  });

  it("treats sessions older than 12 hours as needing a fresh sign-in", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    expect(isRecentSignIn("2026-09-27T01:00:00.000Z", now)).toBe(true);
    expect(isRecentSignIn("2026-09-26T23:00:00.000Z", now)).toBe(false);
    expect(isRecentSignIn(null, now)).toBe(false);
  });

  it("sends signed-out visitors to sign in and back", async () => {
    const response = await request("/issues?tab=shipped");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login?next=%2Fissues%3Ftab%3Dshipped");
  });

  it("hides the founder dashboard from everyone else", async () => {
    expect((await request("/admin")).status).toBe(404);
  });
});

describe("founder access", () => {
  it("prefers permanent numeric ids over usernames", () => {
    const env = { ADMIN_GITHUB_IDS: "123", ADMIN_GITHUB_LOGINS: "sam" };
    expect(isAdmin(env, { login: "sam", github_id: 999 })).toBe(false);
    expect(isAdmin(env, { login: "someone-else", github_id: 123 })).toBe(true);
    expect(isAdmin({ ADMIN_GITHUB_IDS: "", ADMIN_GITHUB_LOGINS: "Sam" }, { login: "sam", github_id: 1 })).toBe(true);
    expect(isAdmin({ ADMIN_GITHUB_IDS: "", ADMIN_GITHUB_LOGINS: "" }, { login: "sam", github_id: 1 })).toBe(false);
  });
});

describe("encryption key rotation", () => {
  it("reads data sealed with the previous key and flags it for re-encryption", async () => {
    const previous = newKey();
    const current = newKey();
    const sealed = await encryptJson(previous, { secret: "p8 key" });
    const keys = keyring({ ENCRYPTION_KEY: current, ENCRYPTION_KEY_PREVIOUS: previous });
    expect(await openSealed(keys, sealed)).toEqual({ value: { secret: "p8 key" }, stale: true });
    expect(await openSealed(keys, await encryptJson(current, "fresh"))).toEqual({ value: "fresh", stale: false });
    expect(await decryptOptional(keys, await encryptJson(previous, "webhook"))).toBe("webhook");
  });

  it("fails closed with the wrong key or tampered data", async () => {
    const sealed = await encryptJson(newKey(), "x");
    await expect(openSealed([newKey()], sealed)).rejects.toThrow();
    const [version, iv, data] = (await encryptJson(baseEnv.ENCRYPTION_KEY, "a longer secret value")).split(".");
    const middle = Math.floor(data.length / 2);
    const tampered = `${version}.${iv}.${data.slice(0, middle)}${data[middle] === "A" ? "B" : "A"}${data.slice(middle + 1)}`;
    await expect(openSealed([baseEnv.ENCRYPTION_KEY], tampered)).rejects.toThrow();
  });

  it("ignores an empty previous key", () => {
    expect(keyring({ ENCRYPTION_KEY: "a", ENCRYPTION_KEY_PREVIOUS: "  " })).toEqual(["a"]);
  });

  it("stamps sealed values with a non-secret key id, so leftovers can be found in SQL", async () => {
    const key = newKey();
    const id = await keyId(key);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(await keyId(` ${key} `)).toBe(id);
    expect(await keyId(newKey())).not.toBe(id);
    const sealed = await encryptJson(key, "x");
    expect(sealed.startsWith(`v2.${id}.`)).toBe(true);
    // The LIKE pattern used to find values on the current key matches exactly these.
    expect((await currentSealPattern({ ENCRYPTION_KEY: key })).slice(0, -1)).toBe(`v2.${id}.`);
  });

  it("still reads values sealed before key ids existed, and flags them for re-encryption", async () => {
    const key = newKey();
    const [, , iv, data] = (await encryptJson(key, { old: true })).split(".");
    const legacy = `v1.${iv}.${data}`;
    expect(await openSealed([key], legacy)).toEqual({ value: { old: true }, stale: true });
  });

  it("rejects a value sealed with another key before trying to decrypt it", async () => {
    await expect(decryptJson(newKey(), await encryptJson(newKey(), "x"))).rejects.toThrow("different key");
  });
});

describe("security log", () => {
  it("stores a keyed hash of the IP, never the IP itself", async () => {
    const hash = await hashIp("secret", "198.51.100.4");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain("198");
    expect(await hashIp("secret", "198.51.100.4")).toBe(hash);
    expect(await hashIp("other-secret", "198.51.100.4")).not.toBe(hash);
  });

  it("labels devices without keeping the raw user agent", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe("Safari on macOS");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0")).toBe("Edge on Windows");
    expect(describeUserAgent("curl/8.7.1")).toBe("Script on unknown OS");
    expect(describeUserAgent(null)).toBe("Unknown device");
  });
});

describe("alerts quoting reviewers", () => {
  it("keeps review text inert in Slack and Discord, and our link clickable", async () => {
    const { deliverNotice, lowRatingNotice } = await import("../src/services/notify");
    const env = { ...baseEnv, APP_URL: "https://reviewloop.example" };
    const settings = {
      slack_webhook: await encryptJson(env.ENCRYPTION_KEY, "https://hooks.slack.com/services/T/B/x"),
      discord_webhook: await encryptJson(env.ENCRYPTION_KEY, "https://discord.com/api/webhooks/1/x"),
      email_alerts: 0,
    } as unknown as import("../src/env").SettingsRow;
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    };
    const review = {
      rating: 1,
      title: "<!channel> @everyone",
      body: "Your key expired, [update it here](https://evil.example) or <https://evil.example|reset it>",
      app_name: "FocusFlow",
    } as unknown as import("../src/env").InboxReview;
    const delivered = await deliverNotice(env, { email: null }, settings, lowRatingNotice(env, [review]), fetcher);
    expect(delivered).toBe(2);

    const slack = String(sent.find((call) => call.url.includes("slack"))!.body.text);
    expect(slack).not.toMatch(/<!channel>|<https:\/\/evil/);
    expect(slack).toContain("&lt;!channel&gt;");
    expect(slack.endsWith("\nhttps://reviewloop.example/inbox?view=needs_reply")).toBe(true);

    const discord = sent.find((call) => call.url.includes("discord"))!.body;
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(String(discord.content)).toContain("\\[update it here\\]");
    expect(String(discord.content).endsWith("\nhttps://reviewloop.example/inbox?view=needs_reply")).toBe(true);
  });

  it("escapes every Discord markdown character", async () => {
    const { discordEscape } = await import("../src/services/notify");
    expect(discordEscape("a*b_c`d|e[f]g<h>~\\")).toBe("a\\*b\\_c\\`d\\|e\\[f\\]g\\<h\\>\\~\\\\");
  });

  it("never cuts our link off a long Discord message", async () => {
    const { deliverNotice } = await import("../src/services/notify");
    const settings = {
      slack_webhook: null,
      discord_webhook: await encryptJson(baseEnv.ENCRYPTION_KEY, "https://discord.com/api/webhooks/1/x"),
      email_alerts: 0,
    } as unknown as import("../src/env").SettingsRow;
    let content = "";
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      content = String(JSON.parse(String(init?.body)).content);
      return new Response("ok");
    };
    const link = "https://reviewloop.example/inbox";
    await deliverNotice(baseEnv, { email: null }, settings, { subject: "Long", lines: ["*".repeat(5000)], link }, fetcher);
    expect(content.length).toBeLessThanOrEqual(1900);
    expect(content.endsWith(`\n${link}`)).toBe(true);
  });
});

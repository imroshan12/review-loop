import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as db from "./db";
import type { Bindings, UserRow } from "./env";
import { randomToken, sha256Hex, timingSafeEqual } from "./lib/encoding";
import { safeNextPath } from "./lib/security";

export type AppVariables = { user: UserRow | null; sessionCreatedAt: string | null };
export type AppContext = Context<{ Bindings: Bindings; Variables: AppVariables }>;

/** Sensitive pages (admin, account deletion) need a sign-in from the last 12 hours. */
export const RECENT_SIGN_IN_MS = 12 * 3600 * 1000;

function isHttps(c: AppContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * On https, cookies use the __Host- prefix: the browser then refuses them unless they're Secure,
 * host-only and Path=/, so a sibling subdomain can't plant or overwrite a session.
 */
function cookieName(c: AppContext, name: string): string {
  return isHttps(c) ? `__Host-${name}` : name;
}

function cookieOptions(c: AppContext, maxAge: number) {
  return { httpOnly: true, secure: isHttps(c), sameSite: "Lax" as const, path: "/", maxAge };
}

/** Sign-in failures whose message is written for the person signing in. */
export class SignInError extends Error {}

const SESSION_TOKEN = /^[0-9a-f]{64}$/;

export async function loadSession(c: AppContext): Promise<{ user: UserRow; sessionCreatedAt: string } | null> {
  const token = getCookie(c, cookieName(c, "rl_session"));
  if (!token || !SESSION_TOKEN.test(token)) return null;
  return db.findUserBySession(c.env.DB, await sha256Hex(token));
}

/** Starts a fresh session. Any session this browser already had is revoked, so tokens never outlive a sign-in. */
export async function startSession(c: AppContext, userId: string): Promise<void> {
  const previous = getCookie(c, cookieName(c, "rl_session"));
  if (previous && SESSION_TOKEN.test(previous)) await db.deleteSession(c.env.DB, await sha256Hex(previous));
  const token = randomToken();
  await db.createSession(c.env.DB, await sha256Hex(token), userId);
  setCookie(c, cookieName(c, "rl_session"), token, cookieOptions(c, 30 * 24 * 3600));
}

export async function endSession(c: AppContext): Promise<void> {
  const name = cookieName(c, "rl_session");
  const token = getCookie(c, name);
  if (token) await db.deleteSession(c.env.DB, await sha256Hex(token));
  deleteCookie(c, name, { path: "/", secure: isHttps(c) });
}

export function isRecentSignIn(sessionCreatedAt: string | null, now = Date.now()): boolean {
  return Boolean(sessionCreatedAt) && now - Date.parse(sessionCreatedAt!) < RECENT_SIGN_IN_MS;
}

export function githubConfigured(env: Bindings): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export function githubAuthorizeUrl(c: AppContext, next: string | null): string {
  const state = randomToken(16);
  setCookie(c, cookieName(c, "rl_oauth_state"), state, cookieOptions(c, 600));
  const safeNext = safeNextPath(next);
  if (safeNext) setCookie(c, cookieName(c, "rl_next"), safeNext, cookieOptions(c, 600));
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID ?? "",
    redirect_uri: `${c.env.APP_URL}/auth/github/callback`,
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

/** Where to go after sign-in: a validated same-site path saved before the redirect, or the inbox. */
export function takeNextPath(c: AppContext): string {
  const name = cookieName(c, "rl_next");
  const next = safeNextPath(getCookie(c, name));
  deleteCookie(c, name, { path: "/", secure: isHttps(c) });
  return next ?? "/inbox";
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  two_factor_authentication?: boolean;
}

const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "ReviewLoop" };

/** Completes the OAuth flow and returns the signed-in user. */
export async function finishGithubLogin(c: AppContext): Promise<UserRow> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stateCookie = cookieName(c, "rl_oauth_state");
  const expectedState = getCookie(c, stateCookie);
  deleteCookie(c, stateCookie, { path: "/", secure: isHttps(c) });
  if (!code || !state || !expectedState || !timingSafeEqual(state, expectedState)) {
    throw new SignInError("Sign-in expired or was tampered with. Please try again.");
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "ReviewLoop" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.APP_URL}/auth/github/callback`,
    }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string; error_description?: string };
  if (!token.access_token) throw new SignInError(token.error_description ?? "GitHub didn't return an access token.");

  const auth = { ...GITHUB_HEADERS, Authorization: `Bearer ${token.access_token}` };
  const profileResponse = await fetch("https://api.github.com/user", { headers: auth });
  if (!profileResponse.ok) throw new SignInError("Couldn't read your GitHub profile.");
  const profile = (await profileResponse.json()) as GithubUser;

  let email = profile.email;
  if (!email) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", { headers: auth });
    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((entry) => entry.primary && entry.verified)?.email ?? null;
    }
  }

  return db.upsertGithubUser(c.env.DB, {
    githubId: profile.id,
    login: profile.login,
    name: profile.name,
    email,
    avatarUrl: profile.avatar_url,
    twoFactor: typeof profile.two_factor_authentication === "boolean" ? profile.two_factor_authentication : null,
  });
}

/** Local development only: a fixed test account, enabled with DEV_LOGIN=true on an http URL. */
export async function devLogin(c: AppContext): Promise<UserRow> {
  return db.upsertGithubUser(c.env.DB, {
    githubId: -1,
    login: "dev",
    name: "Local Developer",
    email: "dev@localhost",
    avatarUrl: null,
    twoFactor: null,
  });
}

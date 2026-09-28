import type { Child, FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Bindings, UserRow } from "../env";
import { isAdmin, userPlan } from "../env";
import { Icon } from "./icon";

export interface Flash {
  kind: "ok" | "error" | "info";
  text: string;
}

type Section = "inbox" | "issues" | "releases" | "insights" | "apps" | "connect" | "settings" | "admin";

interface LayoutProps {
  env: Bindings;
  title: string;
  user: UserRow | null;
  active?: Section;
  flash?: Flash | null;
  /** Full-width sections (landing and public pages) instead of the centered app column. */
  wide?: boolean;
  description?: string;
  /** Absolute URL for search engines on public pages. */
  canonical?: string;
  /** Extra tags for <head>, like a preload for the page's hero image. */
  head?: Child;
  children?: Child;
}

const NAV: Array<{ key: Section; href: string; label: string }> = [
  { key: "inbox", href: "/inbox", label: "Inbox" },
  { key: "issues", href: "/issues", label: "Issues" },
  { key: "releases", href: "/releases", label: "Releases" },
  { key: "insights", href: "/insights", label: "Insights" },
  { key: "apps", href: "/apps", label: "Apps" },
  { key: "connect", href: "/connect", label: "Connect" },
  { key: "settings", href: "/settings", label: "Settings" },
];

const DEFAULT_DESCRIPTION =
  "The review tool that closes the loop: group App Store and Google Play reviews into issues, follow up with every reviewer when your fix ships, and see the stars you win back.";

/** The mark: a star on an amber tile. */
export const Logo: FC = () => (
  <span class="logo-mark" aria-hidden="true">
    <Icon name="star" size={15} />
  </span>
);

/** Marketing pages get a full footer; signed-in pages keep a compact one. */
const SiteFooter: FC<{ env: Bindings }> = ({ env }) => (
  <footer class="site-footer">
    <div class="site-footer-inner">
      <div class="site-footer-brand">
        <a class="brand" href="/">
          <Logo />
          <span>{env.APP_NAME}</span>
        </a>
        <p>Review replies and fix follow-ups for App Store and Google Play developers.</p>
      </div>
      <nav aria-label="Product">
        <p class="site-footer-title">Product</p>
        <a href="/#loop">How it works</a>
        <a href="/#features">Features</a>
        <a href="/#pricing">Pricing</a>
        <a href="/#security">Security</a>
      </nav>
      <nav aria-label="Setup guides">
        <p class="site-footer-title">Guides</p>
        <a href="/guide/app-store">App Store setup</a>
        <a href="/guide/google-play">Google Play setup</a>
      </nav>
      <nav aria-label="Company">
        <p class="site-footer-title">Company</p>
        <a href={`mailto:${env.SUPPORT_EMAIL}`}>Contact</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/refunds">Refunds</a>
      </nav>
    </div>
    <p class="site-footer-base">{`© ${new Date().getUTCFullYear()} ${env.APP_NAME}`}</p>
  </footer>
);

export const Layout: FC<LayoutProps> = ({ env, title, user, active, flash, wide, description, canonical, head, children }) => {
  const plan = user ? userPlan(env, user) : null;
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${title} · ${env.APP_NAME}`}</title>
          <meta name="description" content={description ?? DEFAULT_DESCRIPTION} />
          <meta property="og:title" content={`${title} · ${env.APP_NAME}`} />
          <meta property="og:description" content={description ?? DEFAULT_DESCRIPTION} />
          <meta property="og:type" content="website" />
          {canonical ? <link rel="canonical" href={canonical} /> : null}
          <meta name="theme-color" content="#f7f7f8" media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content="#0c0c0e" media="(prefers-color-scheme: dark)" />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href="/app.css" />
          {head}
          <script src="/app.js" defer></script>
        </head>
        <body class={wide ? "wide" : ""}>
          <a class="skip-link" href="#main">
            Skip to content
          </a>
          <header class="topbar">
            <a class="brand" href={user ? "/inbox" : "/"}>
              <Logo />
              <span>{env.APP_NAME}</span>
            </a>
            {user ? (
              <nav class="nav" aria-label="Main">
                {NAV.map((item) => (
                  <a href={item.href} class={item.key === active ? "active" : ""} aria-current={item.key === active ? "page" : undefined}>
                    {item.label}
                  </a>
                ))}
                {isAdmin(env, user) ? (
                  <a href="/admin" class={active === "admin" ? "active" : ""} aria-current={active === "admin" ? "page" : undefined}>
                    Admin
                  </a>
                ) : null}
              </nav>
            ) : (
              <nav class="nav" aria-label="Main">
                <a href="/#loop">How it works</a>
                <a href="/#features">Features</a>
                <a href="/#pricing">Pricing</a>
                <a href="/#security">Security</a>
              </nav>
            )}
            <div class="account">
              {user ? (
                <>
                  <a class={`plan-badge ${plan?.plan ?? "free"}`} href="/settings#plan">
                    {plan?.name}
                  </a>
                  {user.avatar_url ? <img class="avatar" src={user.avatar_url} alt="" width="28" height="28" /> : null}
                  <form method="post" action="/auth/logout" class="inline">
                    <button type="submit" class="link">Sign out</button>
                  </form>
                </>
              ) : (
                <>
                  <a class="link-plain" href="/login">
                    Sign in
                  </a>
                  <a class="button primary small" href="/signup">
                    Start free
                  </a>
                </>
              )}
            </div>
          </header>
          {flash ? (
            <div class={`flash ${flash.kind}`} role={flash.kind === "error" ? "alert" : "status"}>
              {flash.text}
            </div>
          ) : null}
          <main id="main" class={wide ? "wide-main" : "container"}>
            {children}
          </main>
          {wide && !user ? (
            <SiteFooter env={env} />
          ) : (
            <footer class="footer">
              <span>{`© ${new Date().getUTCFullYear()} ${env.APP_NAME}`}</span>
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
              <a href="/refunds">Refunds</a>
              <a href="/guide/app-store">App Store setup</a>
              <a href="/guide/google-play">Google Play setup</a>
              <a href={`mailto:${env.SUPPORT_EMAIL}`}>Contact</a>
            </footer>
          )}
          <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
        </body>
      </html>
    </>
  );
};

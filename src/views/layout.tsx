import type { Child, FC } from "hono/jsx";
import type { Bindings, UserRow } from "../env";
import { isAdmin, isPro } from "../env";

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

export const Logo: FC = () => (
  <svg class="logo-mark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z" fill="currentColor" opacity=".25" />
    <path d="M7 12a5 5 0 0 1 8.5-3.5M17 12a5 5 0 0 1-8.5 3.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" />
    <path d="M15.5 5.5v3h-3M8.5 18.5v-3h3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const Layout: FC<LayoutProps> = ({ env, title, user, active, flash, wide, description, canonical, children }) => (
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
      <meta name="theme-color" content="#4f46e5" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href="/app.css" />
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
              <span class={`plan-badge ${isPro(user) ? "pro" : ""}`}>{isPro(user) ? "Pro" : "Free"}</span>
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
      <footer class="footer">
        <span>{`© ${new Date().getUTCFullYear()} ${env.APP_NAME}`}</span>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/refunds">Refunds</a>
        <a href="/guide/app-store">App Store setup</a>
        <a href="/guide/google-play">Google Play setup</a>
        <a href={`mailto:${env.SUPPORT_EMAIL}`}>Contact</a>
      </footer>
      <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
    </body>
  </html>
);

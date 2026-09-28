import type { Child, FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Bindings } from "../env";
import { planDetails } from "../env";
import { badgeSvg } from "../services/publiclog";
import { Icon } from "./icon";
import type { IconName } from "./icons.generated";
import { Layout, type Flash } from "./layout";

/** Pixel sizes of the screenshots in public/shots (captured at 2x by scripts/screenshots.mjs). */
const SHOT_SIZES = {
  wins: [2200, 1520],
  inbox: [2200, 1520],
  issue: [2200, 1520],
  followups: [2200, 1520],
  fixlog: [2200, 1280],
  issues: [1592, 716],
  review: [1400, 774],
  shipped: [1592, 344],
} as const;

type ShotName = keyof typeof SHOT_SIZES;

/** Both resolutions of a shot, for srcset: phones take the half-size file. */
function shotSrcset(name: ShotName, theme: "light" | "dark"): string {
  const width = SHOT_SIZES[name][0];
  return `/shots/${name}-${theme}-1x.webp ${width / 2}w, /shots/${name}-${theme}.webp ${width}w`;
}

/**
 * A real product screenshot in the visitor's theme, at the resolution their screen needs.
 * `eager` for images in the first screen; `priority` only for the one that decides first paint.
 */
const Shot: FC<{ name: ShotName; alt: string; sizes?: string; eager?: boolean; priority?: boolean }> = ({
  name,
  alt,
  sizes = "(max-width: 1000px) 92vw, 700px",
  eager,
  priority,
}) => {
  const [width, height] = SHOT_SIZES[name];
  return (
    <picture>
      <source srcset={shotSrcset(name, "dark")} sizes={sizes} media="(prefers-color-scheme: dark)" />
      <img
        src={`/shots/${name}-light.webp`}
        srcset={shotSrcset(name, "light")}
        sizes={sizes}
        alt={alt}
        width={width}
        height={height}
        loading={eager || priority ? "eager" : "lazy"}
        decoding="async"
        fetchpriority={priority ? "high" : undefined}
      />
    </picture>
  );
};

const HERO_SIZES = "(max-width: 1000px) 92vw, 720px";

const STEPS: Array<{ title: string; body: string; shot: ShotName; alt: string }> = [
  {
    title: "A 1★ review lands",
    body: "App Store and Google Play reviews arrive in one inbox, with an alert for the low ones.",
    shot: "inbox",
    alt: "The inbox, listing new App Store and Google Play reviews that need a reply.",
  },
  {
    title: "It joins an issue",
    body: "Reviews that report the same bug are grouped, and the issue shows the stars it costs you.",
    shot: "issue",
    alt: "An issue page for a bank sync bug, with a similar review suggested for the same issue.",
  },
  {
    title: "You ship the fix",
    body: "When the new version is live, every reviewer the fix affects gets a drafted follow-up.",
    shot: "followups",
    alt: "Follow-ups drafted for three reviewers after version 2.3.1 shipped, with a button to send all of them.",
  },
  {
    title: "Stars come back",
    body: "Reviewers are notified of your follow-up, and you see every rating that goes up.",
    shot: "review",
    alt: "A review whose rating went from 1 star to 5 stars after the follow-up.",
  },
];

const SECURITY: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: "lock-key", title: "Encrypted at rest", body: "Store keys are sealed with AES-256-GCM, with key rotation, and never shown back." },
  { icon: "key", title: "Least-privilege keys", body: "The setup guides create keys that can only read reviews and reply to them." },
  { icon: "github", title: "No passwords to steal", body: "You sign in with GitHub, and we warn you if two-factor authentication is off." },
  { icon: "list-magnifying-glass", title: "A security log", body: "Every sign-in, key change and connection is recorded where you can see it." },
  { icon: "shield-check", title: "Hardened by default", body: "Rate limits, a strict content security policy, HSTS and signed webhooks." },
  { icon: "devices", title: "Sessions you control", body: "Sign out of every device from Settings, at any time." },
];

const Faq: FC<{ question: string; children: Child }> = ({ question, children }) => (
  <details class="faq-item">
    <summary>
      {question}
      <Icon name="caret-down" size={18} class="faq-caret" />
    </summary>
    <p>{children}</p>
  </details>
);

export const LandingPage: FC<{ env: Bindings; flash?: Flash | null }> = ({ env, flash }) => {
  const free = planDetails(env, "free");
  const plus = planDetails(env, "plus");
  const pro = planDetails(env, "pro");
  // An example of the badge developers put in their README, drawn by the same code as the real one.
  const badge = badgeSvg("fixed from reviews", "12 fixed");
  return (
    <Layout
      env={env}
      title="Turn 1-star reviews into 5-star updates"
      user={null}
      flash={flash}
      wide
      canonical={`${env.APP_URL}/`}
      head={
        <>
          <link
            rel="preload"
            as="image"
            imagesrcset={shotSrcset("wins", "light")}
            imagesizes={HERO_SIZES}
            media="(prefers-color-scheme: light)"
            fetchpriority="high"
          />
          <link
            rel="preload"
            as="image"
            imagesrcset={shotSrcset("wins", "dark")}
            imagesizes={HERO_SIZES}
            media="(prefers-color-scheme: dark)"
            fetchpriority="high"
          />
        </>
      }
    >
      <section class="hero">
        <div class="hero-inner">
          <div class="hero-copy">
            <p class="eyebrow">For indie iOS and Android developers</p>
            <h1 class="hero-title">
              Turn 1-star reviews into <span class="hero-accent">5-star updates</span>
            </h1>
            <p class="hero-lede">
              Group bug reports from App Store and Google Play reviews. When your fix ships, follow up with every reviewer.
            </p>
            <div class="hero-cta">
              <a class="button primary lg" href="/signup">
                Start free
              </a>
              <a class="button lg" href="#loop">
                See how it works
                <Icon name="arrow-right" size={16} />
              </a>
            </div>
          </div>
          <div class="hero-visual">
            <figure class="frame hero-main">
              <Shot
                name="wins"
                priority
                sizes={HERO_SIZES}
                alt="The ReviewLoop inbox: 3 reviewers raised their rating after the follow-ups, one of them from 1 star to 5 stars."
              />
            </figure>
            <figure class="frame hero-float">
              <Shot
                name="shipped"
                eager
                sizes="(max-width: 640px) 85vw, 480px"
                alt="A shipped issue: 3 reviewers, 11 stars lost, all 3 followed up, 10 stars won back."
              />
            </figure>
          </div>
        </div>
      </section>

      <section class="proof" aria-label="Why following up works">
        <div class="proof-inner">
          <div class="proof-item">
            <span class="proof-number">+0.7★</span>
            <p>
              Average rating increase after developers reply to reviews.{" "}
              <a href="https://android-developers.googleblog.com/2019/05/whats-new-in-play.html" target="_blank" rel="noopener">
                Google, 2019
              </a>
            </p>
          </div>
          <div class="proof-item">
            <span class="proof-number">6×</span>
            <p>
              More likely to raise their rating once a reviewer gets a reply, across 4.5 million reviews.{" "}
              <a href="https://doi.org/10.1007/s10664-017-9538-9" target="_blank" rel="noopener">
                Hassan et al., 2018
              </a>
            </p>
          </div>
          <div class="proof-item">
            <span class="proof-number">1 click</span>
            <p>To follow up with every reviewer a release fixed.</p>
          </div>
        </div>
      </section>

      <section class="section" id="loop">
        <div class="section-head">
          <h2>The loop other review tools leave open</h2>
          <p>Replying once is where most tools stop. Ratings come back when reviewers hear the fix is live.</p>
        </div>
        <div class="tour" data-tour>
          <div class="tour-steps" role="tablist" aria-label="How ReviewLoop works">
            {STEPS.map((step, index) => (
              <button
                type="button"
                class={`tour-step${index === 0 ? " is-active" : ""}`}
                role="tab"
                id={`tour-tab-${index}`}
                aria-controls={`tour-panel-${index}`}
                aria-selected={index === 0 ? "true" : "false"}
                tabindex={index === 0 ? 0 : -1}
                data-step={String(index)}
              >
                <span class="tour-step-title">{step.title}</span>
                <span class="tour-step-body">{step.body}</span>
              </button>
            ))}
          </div>
          <div class="tour-panels">
            {STEPS.map((step, index) => (
              <div
                class={`tour-panel frame${index === 0 ? " is-active" : ""}${step.shot === "review" ? " tour-panel-card" : ""}`}
                role="tabpanel"
                id={`tour-panel-${index}`}
                aria-labelledby={`tour-tab-${index}`}
              >
                <p class="tour-panel-caption">{step.title}</p>
                <Shot name={step.shot} alt={step.alt} sizes={step.shot === "review" ? "(max-width: 1000px) 80vw, 560px" : undefined} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section class="section" id="features">
        <div class="section-head">
          <h2>Built around the day your fix ships</h2>
        </div>
        <div class="bento">
          <article class="bento-cell bento-issues">
            <div class="bento-text">
              <Icon name="stack" size={22} class="bento-icon" />
              <h3>Issues ranked by stars lost</h3>
              <p>See which fix wins back the most stars, before you write a line of code.</p>
            </div>
            <figure class="bento-shot">
              <Shot
                name="issues"
                sizes="(max-width: 1000px) 88vw, 520px"
                alt="Two open issues, each showing how many reviewers reported it and the stars it cost."
              />
            </figure>
          </article>
          <article class="bento-cell bento-tint">
            <Icon name="rocket" size={22} class="bento-icon" />
            <h3>Follow-ups that fire when you ship</h3>
            <p>New App Store versions are detected automatically, and Google Play versions from the reviews themselves.</p>
          </article>
          <article class="bento-cell">
            <Icon name="sparkle" size={22} class="bento-icon" />
            <h3>Replies that learn</h3>
            <p>AI drafts learn from your replies that got reviewers to raise their rating.</p>
          </article>
          <article class="bento-cell">
            <Icon name="siren" size={22} class="bento-icon" />
            <h3>Release Guard</h3>
            <p>An alert when a release sets off a wave of low ratings, while you can still halt the rollout.</p>
          </article>
          <article class="bento-cell bento-public">
            <div class="bento-text">
              <Icon name="globe" size={22} class="bento-icon" />
              <h3>A public fix log and README badge</h3>
              <p>Show users you listen. Every fix you ship appears on a public page, with a badge for your README.</p>
              <figure class="bento-badge">
                <span role="img" aria-label="Example badge: fixed from reviews, 12 fixed">
                  {raw(badge)}
                </span>
                <figcaption>Example</figcaption>
              </figure>
            </div>
            <figure class="bento-shot">
              <Shot
                name="fixlog"
                sizes="(max-width: 1000px) 88vw, 480px"
                alt="A public fix log listing a shipped fix and the reviewers who raised their rating."
              />
            </figure>
          </article>
          <article class="bento-cell">
            <Icon name="chart-bar" size={22} class="bento-icon" />
            <h3>Benchmarks from real outcomes</h3>
            <p>Compare your reply rate and recovery with other developers once enough apps join.</p>
          </article>
        </div>
      </section>

      <section class="section security" id="security">
        <div class="security-head">
          <h2>Security you can check</h2>
          <p>Your store keys can reply to reviews in your name, so they're treated that way.</p>
        </div>
        <ul class="security-grid">
          {SECURITY.map((item) => (
            <li>
              <Icon name={item.icon} size={22} class="security-icon" />
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section class="section" id="pricing">
        <div class="section-head">
          <h2>Simple pricing</h2>
          <p>Every plan has issues, follow-ups, Release Guard and the public fix log. Pay for more apps and AI drafts.</p>
        </div>
        <div class="pricing">
          <article class="price-card">
            <h3>Free</h3>
            <p class="price">$0</p>
            <ul>
              <li>
                <Icon name="check" size={16} />1 app on either store
              </li>
              <li>
                <Icon name="check" size={16} />
                {free.draftsPerMonth} AI drafts a month
              </li>
              <li>
                <Icon name="check" size={16} />
                Email, Slack and Discord alerts
              </li>
            </ul>
            <a class="button" href="/signup">
              Start free
            </a>
          </article>
          <article class="price-card featured">
            <div class="price-card-head">
              <h3>Plus</h3>
              <span class="chip">One app, both stores</span>
            </div>
            <p class="price">{plus.priceLabel}</p>
            <ul>
              <li>
                <Icon name="check" size={16} />
                {plus.apps} apps, like your app on the App Store and Google Play
              </li>
              <li>
                <Icon name="check" size={16} />
                {plus.draftsPerMonth} AI drafts a month
              </li>
              <li>
                <Icon name="check" size={16} />
                Everything in Free
              </li>
            </ul>
            <a class="button primary" href="/signup">
              Start free
            </a>
          </article>
          <article class="price-card">
            <h3>Pro</h3>
            <p class="price">{pro.priceLabel}</p>
            <ul>
              <li>
                <Icon name="check" size={16} />
                Unlimited apps on both stores
              </li>
              <li>
                <Icon name="check" size={16} />
                {pro.draftsPerMonth} AI drafts a month
              </li>
              <li>
                <Icon name="check" size={16} />
                Automatic follow-ups when a release ships
              </li>
              <li>
                <Icon name="check" size={16} />
                Everything in Plus
              </li>
            </ul>
            <a class="button" href="/signup">
              Start free
            </a>
          </article>
        </div>
      </section>

      <section class="section faq" id="faq">
        <h2>Questions</h2>
        <div class="faq-list">
          <Faq question="Which plan do I need?">
            Free covers one app on one store. An app on both the App Store and Google Play is two listings, so Plus (
            {plus.priceLabel}) covers it. Pro ({pro.priceLabel}) is for several apps and sends follow-ups automatically when a
            release ships. Upgrades start right away; downgrades start at your next billing date.
          </Faq>
          <Faq question="Does it ask reviewers to change their rating?">
            No. Follow-ups tell reviewers the problem is fixed and invite them to update the app. Both stores notify reviewers
            when you reply, and many update their review on their own. Asking for a better rating breaks store guidelines, so{" "}
            {env.APP_NAME} never does it, and automatic follow-ups are checked for it before they're sent.
          </Faq>
          <Faq question="What's the public fix log?">
            An optional page per app that lists the issues you fixed from reviews, with a badge for your website or README. It
            shows your issue titles, which you can edit, and counts. It never shows who reported a problem.
          </Faq>
          <Faq question="How does the recovery forecast work?">
            It multiplies an issue's reviewers by the share who raised their rating after your past follow-ups, and by how far
            they rose. Until you have 10 follow-ups, it uses results across {env.APP_NAME}, once enough apps contribute.
          </Faq>
          <Faq question="Can I try it without connecting anything?">
            Yes. After you sign in, load the sample workspace and try the whole loop on realistic reviews.
          </Faq>
        </div>
      </section>

      <section class="closing">
        <div class="closing-inner">
          <h2>Your next release could win back your 1-star reviewers</h2>
          <a class="button primary lg" href="/signup">
            Start free
          </a>
        </div>
      </section>
    </Layout>
  );
};

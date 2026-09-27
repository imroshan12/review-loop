import type { Child, FC } from "hono/jsx";
import type { Bindings } from "../env";
import { envNumber } from "../env";
import { Layout, type Flash } from "./layout";

const Icon: FC<{ name: "issues" | "ship" | "learn" | "public" | "bench" | "guard" | "lock" | "check" }> = ({ name }) => {
  const paths: Record<string, Child> = {
    issues: <path d="M4 6h16M4 12h10M4 18h6M17 15l2 2 3-4" />,
    ship: <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />,
    learn: <path d="M12 3l9 5-9 5-9-5 9-5zm-6 8v5c3 2 9 2 12 0v-5" />,
    public: <path d="M3 12a9 9 0 1018 0 9 9 0 00-18 0zm0 0h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />,
    bench: <path d="M4 20V10m6 10V4m6 16v-7m6 7H2" />,
    guard: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm-3 9l2 2 4-4" />,
    lock: <path d="M6 11V8a6 6 0 0112 0v3M5 11h14v10H5z" />,
    check: <path d="M5 12l4 4 10-10" />,
  };
  return (
    <svg class="lp-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      {paths[name]}
    </svg>
  );
};

/** The loop in motion: a 1★ review is tracked, fixed, followed up and raised to 5★. CSS only; static when motion is reduced. */
const LoopDemo: FC = () => (
  <div class="demo" role="img" aria-label="Example: a one-star review about a timer bug is marked fix pending, version 2.3.1 ships, a follow-up is sent, and the reviewer raises the rating to five stars.">
    <div class="demo-bar" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
      <em>Inbox · FocusFlow</em>
    </div>
    <div class="demo-card" aria-hidden="true">
      <div class="demo-head">
        <span class="demo-stars">
          <span class="demo-stars-low">★☆☆☆☆</span>
          <span class="demo-stars-high">★★★★★</span>
        </span>
        <span class="demo-meta">maya · App Store · 3h ago</span>
      </div>
      <p class="demo-title">Timer stops when I lock my phone</p>
      <p class="demo-body">Lost three focus sessions today. Was great before the last update.</p>
      <div class="demo-reply">
        <span class="demo-label">Your reply</span>
        Sorry, Maya. That's a bug from 2.3.0 and the fix is on its way.
      </div>
      <ol class="demo-steps">
        <li class="step-1">Fix pending · ships in v2.3.1</li>
        <li class="step-2">v2.3.1 is live · follow-up drafted</li>
        <li class="step-3">Follow-up sent</li>
        <li class="step-4">Rating raised 1★ → 5★</li>
      </ol>
    </div>
  </div>
);

const Row: FC<{ label: string; them: string; us: string }> = ({ label, them, us }) => (
  <tr>
    <th scope="row">{label}</th>
    <td class={them === "—" ? "no" : ""}>{them}</td>
    <td class="yes">{us}</td>
  </tr>
);

export const LandingPage: FC<{ env: Bindings; flash?: Flash | null }> = ({ env, flash }) => {
  const freeDrafts = envNumber(env.FREE_AI_DRAFTS_PER_MONTH, 20);
  const proDrafts = envNumber(env.PRO_AI_DRAFTS_PER_MONTH, 500);
  return (
    <Layout env={env} title="Turn 1-star reviews into 5-star updates" user={null} flash={flash} wide canonical={`${env.APP_URL}/`}>
      <section class="lp-hero">
        <div class="lp-hero-inner">
          <div class="lp-hero-copy">
            <p class="lp-eyebrow">For indie iOS and Android developers</p>
            <h1>
              Turn 1-star reviews into <span class="lp-gradient">5-star updates</span>
            </h1>
            <p class="lp-lede">
              {env.APP_NAME} groups the bugs your reviewers report, notices the day your fix ships, and follows up with every
              one of them. Then it shows you exactly how many stars you won back.
            </p>
            <div class="lp-cta">
              <a class="button primary xl" href="/signup">
                Start free with GitHub
              </a>
              <a class="button ghost xl" href="#loop">
                See how it works
              </a>
            </div>
            <ul class="lp-trust">
              <li>
                <Icon name="check" /> Free for 1 app
              </li>
              <li>
                <Icon name="check" /> No card needed
              </li>
              <li>
                <Icon name="check" /> App Store and Google Play
              </li>
            </ul>
          </div>
          <LoopDemo />
        </div>
      </section>

      <section class="lp-proof" aria-label="Why replying matters">
        <div class="lp-proof-inner">
          <div class="lp-stat">
            <span class="lp-stat-num">+0.7★</span>
            <span>
              average rating increase after developers reply to reviews.{" "}
              <a href="https://android-developers.googleblog.com/2019/05/whats-new-in-play.html" target="_blank" rel="noopener">
                Google, 2019
              </a>
            </span>
          </div>
          <div class="lp-stat">
            <span class="lp-stat-num">6×</span>
            <span>
              more likely to raise their rating once a reviewer gets a reply, in a study of 4.5 million reviews.{" "}
              <a href="https://doi.org/10.1007/s10664-017-9538-9" target="_blank" rel="noopener">
                Hassan et al., 2018
              </a>
            </span>
          </div>
          <div class="lp-stat">
            <span class="lp-stat-num">1 click</span>
            <span>to follow up with every reviewer a release just fixed.</span>
          </div>
        </div>
      </section>

      <section class="lp-section" id="loop">
        <h2 class="lp-h2">The loop other review tools leave open</h2>
        <p class="lp-sub">Replying once is where most tools stop. The rating comes back when you close the loop.</p>
        <ol class="lp-steps">
          <li>
            <strong>A 1★ review lands</strong>
            <span>You get an alert. AI drafts a reply in your voice and the reviewer's language.</span>
          </li>
          <li>
            <strong>It joins an issue</strong>
            <span>Reviews reporting the same bug are grouped, and the issue shows how many stars it's costing you.</span>
          </li>
          <li>
            <strong>You ship the fix</strong>
            <span>{env.APP_NAME} detects the new version and drafts a follow-up for everyone that release fixed.</span>
          </li>
          <li>
            <strong>Stars come back</strong>
            <span>Reviewers are notified of your follow-up. You see every rating that goes up, per fix.</span>
          </li>
        </ol>
      </section>

      <section class="lp-section" id="features">
        <h2 class="lp-h2">Built around the day your fix ships</h2>
        <div class="lp-grid">
          <article class="lp-feature">
            <Icon name="issues" />
            <h3>Issues ranked by stars lost</h3>
            <p>Group reviews that report the same problem. See which fix wins back the most stars before you write a line of code.</p>
          </article>
          <article class="lp-feature">
            <Icon name="ship" />
            <h3>Follow-ups that fire when you ship</h3>
            <p>New App Store versions are detected automatically; Google Play versions from the reviews themselves. Every affected reviewer gets a follow-up.</p>
          </article>
          <article class="lp-feature">
            <Icon name="learn" />
            <h3>Replies that learn what works</h3>
            <p>AI drafts learn from your replies that actually got reviewers to raise their rating, and never ask for a better one.</p>
          </article>
          <article class="lp-feature">
            <Icon name="public" />
            <h3>A public fix log and badge</h3>
            <p>Show users you listen: a page and a README badge listing every issue you fixed from their reviews.</p>
          </article>
          <article class="lp-feature">
            <Icon name="bench" />
            <h3>Benchmarks from real outcomes</h3>
            <p>Compare your reply rate, speed and recovery with other developers, and see which reply habits raise ratings.</p>
          </article>
          <article class="lp-feature">
            <Icon name="guard" />
            <h3>Release Guard and promise tracker</h3>
            <p>Get warned when a release sets off a wave of 1★ reviews, and reminded when a fix you promised reviewers is overdue.</p>
          </article>
        </div>
      </section>

      <section class="lp-section" id="compare">
        <h2 class="lp-h2">What's different</h2>
        <div class="lp-table-wrap">
          <table class="lp-table">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">Typical review tools</th>
                <th scope="col">{env.APP_NAME}</th>
              </tr>
            </thead>
            <tbody>
              <Row label="AI reply drafts" them="✓" us="✓, learning from replies that raised ratings" />
              <Row label="App Store and Google Play in one inbox" them="Most" us="✓" />
              <Row label="Reviews grouped into issues, ranked by stars lost" them="Topic tags" us="✓, with a recovery forecast" />
              <Row label="Automatic follow-up when the fix ships" them="—" us="✓" />
              <Row label="Stars won back, measured per fix" them="—" us="✓" />
              <Row label="Public fix log and badge" them="—" us="✓" />
              <Row label="Reminders for promised fixes" them="—" us="✓" />
            </tbody>
          </table>
        </div>
        <p class="lp-note">Based on the public feature lists of popular review tools, September 2026.</p>
      </section>

      <section class="lp-section lp-security" id="security">
        <div class="lp-security-inner">
          <div>
            <h2 class="lp-h2">
              <Icon name="lock" /> Security you can check
            </h2>
            <p class="lp-sub">Your store keys can reply to reviews in your name, so they're treated that way.</p>
          </div>
          <ul class="lp-checks">
            <li>
              <Icon name="check" /> <span><strong>Least-privilege keys.</strong> The setup guides create keys that can only read and reply to reviews.</span>
            </li>
            <li>
              <Icon name="check" /> <span><strong>Encrypted at rest.</strong> AES-256-GCM, with key rotation. Keys are never shown back to anyone.</span>
            </li>
            <li>
              <Icon name="check" /> <span><strong>No passwords to steal.</strong> Sign in with GitHub; we warn you if your account has no two-factor authentication.</span>
            </li>
            <li>
              <Icon name="check" /> <span><strong>A security log.</strong> Every sign-in, key change and connection is recorded where you can see it.</span>
            </li>
            <li>
              <Icon name="check" /> <span><strong>Hardened by default.</strong> Rate limits, a strict content security policy, HSTS, signed webhooks and cross-site request checks.</span>
            </li>
          </ul>
        </div>
      </section>

      <section class="lp-section" id="pricing">
        <h2 class="lp-h2">Simple pricing</h2>
        <div class="plans">
          <article class="card plan">
            <h3>Free</h3>
            <p class="price">$0</p>
            <ul>
              <li>1 app, either store</li>
              <li>{freeDrafts} AI drafts a month</li>
              <li>Issues, follow-ups and the public fix log</li>
              <li>Email, Slack and Discord alerts</li>
            </ul>
            <a class="button" href="/signup">
              Start free
            </a>
          </article>
          <article class="card plan featured">
            <span class="plan-flag">Most popular</span>
            <h3>Pro</h3>
            <p class="price">{env.PRO_PRICE_LABEL}</p>
            <ul>
              <li>Unlimited apps on both stores</li>
              <li>{proDrafts} AI drafts a month</li>
              <li>Automatic follow-ups when a release ships</li>
              <li>Everything in Free</li>
            </ul>
            <a class="button primary" href="/signup">
              Start free, upgrade anytime
            </a>
          </article>
        </div>
      </section>

      <section class="lp-section faq" id="faq">
        <h2 class="lp-h2">Questions</h2>
        <details>
          <summary>Does it ask reviewers to change their rating?</summary>
          <p>
            No. Follow-ups tell reviewers the problem is fixed and invite them to update the app. Both stores notify reviewers when
            you reply, and many update their review on their own. Asking for a better rating goes against store guidelines, so
            {" "}{env.APP_NAME} never does it, and automatic follow-ups are checked for it before they're sent.
          </p>
        </details>
        <details>
          <summary>What's the public fix log?</summary>
          <p>
            An optional page per app that lists the issues you fixed from reviews, with a badge for your website or README. It shows
            your issue titles, which you can edit, and counts. It never shows who reported a problem.
          </p>
        </details>
        <details>
          <summary>How does the recovery forecast work?</summary>
          <p>
            It multiplies an issue's reviewers by the share who raised their rating after your past follow-ups, and by how far
            they rose. Until you have 10 follow-ups, it uses results across {env.APP_NAME}, once enough apps contribute.
          </p>
        </details>
        <details>
          <summary>Can I try it without connecting anything?</summary>
          <p>Yes. After signing in, load the sample workspace to try the whole loop on realistic reviews.</p>
        </details>
      </section>

      <section class="lp-final">
        <h2>Your next release could win back your 1-star reviewers.</h2>
        <a class="button primary xl" href="/signup">
          Start free with GitHub
        </a>
      </section>
    </Layout>
  );
};

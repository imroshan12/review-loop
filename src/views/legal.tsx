import type { FC } from "hono/jsx";
import type { Bindings, UserRow } from "../env";
import { Layout } from "./layout";

// Plain-language starting points. Have them reviewed for your jurisdiction before launch.

export const PrivacyPage: FC<{ env: Bindings; user: UserRow | null }> = ({ env, user }) => (
  <Layout env={env} title="Privacy" user={user}>
    <article class="prose">
      <h1>Privacy policy</h1>
      <p>
        {env.APP_NAME} helps app developers read and answer their App Store and Google Play reviews. This page explains what we
        store and why.
      </p>
      <h2>What we store</h2>
      <ul>
        <li>Your GitHub username, name, email and avatar, to sign you in and send alerts.</li>
        <li>Store API credentials you provide, encrypted with AES-256, to read reviews and post replies you approve.</li>
        <li>Reviews of your apps, your replies, drafts and settings, to run the product.</li>
        <li>Subscription status from our payment provider. We never see or store card details.</li>
      </ul>
      <h2>Who processes it</h2>
      <ul>
        <li>Cloudflare hosts the app and database.</li>
        <li>Anthropic generates AI drafts from the review text and your voice notes. Drafts aren't used to train models under Anthropic's API terms.</li>
        <li>Dodo Payments handles checkout and billing as merchant of record.</li>
        <li>If you turn on email alerts, our email provider delivers them.</li>
      </ul>
      <h2>Your choices</h2>
      <p>
        Remove a store connection at any time to delete its apps and reviews. Deleting your account in Settings removes all your
        data. Questions: <a href={`mailto:${env.SUPPORT_EMAIL}`}>{env.SUPPORT_EMAIL}</a>.
      </p>
    </article>
  </Layout>
);

export const TermsPage: FC<{ env: Bindings; user: UserRow | null }> = ({ env, user }) => (
  <Layout env={env} title="Terms" user={user}>
    <article class="prose">
      <h1>Terms of service</h1>
      <p>By using {env.APP_NAME} you agree to these terms.</p>
      <ul>
        <li>You're responsible for the replies you send and for following App Store and Google Play guidelines.</li>
        <li>Only connect store accounts you're authorized to manage.</li>
        <li>AI drafts can be wrong. Read them before sending, or leave automatic follow-ups off.</li>
        <li>Pro is billed monthly and renews until cancelled. You can cancel anytime from Settings.</li>
        <li>We may suspend accounts that abuse the service or the stores' APIs.</li>
        <li>The service is provided as is, without warranties, and our liability is limited to the fees you paid in the last three months.</li>
      </ul>
      <p>
        Contact: <a href={`mailto:${env.SUPPORT_EMAIL}`}>{env.SUPPORT_EMAIL}</a>
      </p>
    </article>
  </Layout>
);

export const RefundsPage: FC<{ env: Bindings; user: UserRow | null }> = ({ env, user }) => (
  <Layout env={env} title="Refunds" user={user}>
    <article class="prose">
      <h1>Refund policy</h1>
      <p>
        If {env.APP_NAME} doesn't work for you, email <a href={`mailto:${env.SUPPORT_EMAIL}`}>{env.SUPPORT_EMAIL}</a> within 14
        days of your first payment for a full refund. After that, cancel anytime and you keep Pro until the end of the period you
        paid for.
      </p>
    </article>
  </Layout>
);

export const MessagePage: FC<{ env: Bindings; user: UserRow | null; title: string; message: string; link?: { href: string; label: string } }> = ({
  env,
  user,
  title,
  message,
  link,
}) => (
  <Layout env={env} title={title} user={user}>
    <section class="card narrow">
      <h1>{title}</h1>
      <p>{message}</p>
      {link ? (
        <a class="button primary" href={link.href}>
          {link.label}
        </a>
      ) : null}
    </section>
  </Layout>
);

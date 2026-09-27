import type { Child, FC } from "hono/jsx";
import type { Bindings, ConnectionRow, UserRow } from "../env";
import { Layout, type Flash } from "./layout";

export type GuideStore = "app-store" | "google-play";

interface GuideProps {
  env: Bindings;
  user: UserRow | null;
  flash?: Flash | null;
  /** Set when replacing the key of an existing connection. */
  connection: ConnectionRow | null;
  /** Google Play only: package names to prefill when updating. */
  packageNames?: string;
}

const Step: FC<{ n: number; title: string; children?: Child }> = ({ n, title, children }) => (
  <li class="guide-step">
    <span class="guide-num" aria-hidden="true">
      {n}
    </span>
    <div class="guide-body">
      <h2>{title}</h2>
      {children}
    </div>
  </li>
);

const Figure: FC<{ src: string; alt: string; caption: string }> = ({ src, alt, caption }) => (
  <figure class="guide-figure">
    <img src={src} alt={alt} width="640" loading="lazy" />
    <figcaption>{caption}</figcaption>
  </figure>
);

const External: FC<{ href: string; children?: Child }> = ({ href, children }) => (
  <a class="button small" href={href} target="_blank" rel="noopener">
    {children} ↗
  </a>
);

const UpdateBanner: FC<{ connection: ConnectionRow | null }> = ({ connection }) =>
  connection ? (
    <p class="banner info">
      Updating the key for <strong>{connection.label}</strong>. Your apps, reviews and replies are kept.
      {connection.last_error ? ` Last error: ${connection.last_error}` : ""}
    </p>
  ) : null;

const SignInPrompt: FC<{ env: Bindings }> = ({ env }) => (
  <div class="card">
    <p>Sign in to paste your key. {env.APP_NAME} is free for one app.</p>
    <a class="button primary" href="/login">
      Sign in with GitHub
    </a>
  </div>
);

const Troubleshooting: FC<{ items: Array<[string, string]> }> = ({ items }) => (
  <section class="faq guide-faq">
    <h2>If something goes wrong</h2>
    {items.map(([problem, fix]) => (
      <details>
        <summary>{problem}</summary>
        <p>{fix}</p>
      </details>
    ))}
  </section>
);

export const AppStoreGuide: FC<GuideProps> = ({ env, user, flash, connection }) => (
  <Layout env={env} title="Connect App Store Connect" user={user} active="connect" flash={flash}>
    <div class="page-head">
      <div>
        <h1>Connect App Store Connect</h1>
        <p class="muted">
          About 5 minutes. You'll create an API key that can read and reply to reviews, and nothing else. Keys are encrypted
          before they're stored, and you can revoke yours anytime.
        </p>
      </div>
    </div>
    <UpdateBanner connection={connection} />

    <ol class="guide">
      <Step n={1} title="Open the API keys page">
        <p>
          Sign in as the team's Admin or Account Holder. If you see <strong>Request Access</strong>, the Account Holder needs to
          click it once.
        </p>
        <External href="https://appstoreconnect.apple.com/access/integrations/api">Open Users and Access → Integrations</External>
      </Step>

      <Step n={2} title="Generate a key with the Customer Support role">
        <p>
          On the <strong>Team Keys</strong> tab, click <strong>+</strong>. Name it <strong>ReviewLoop</strong> and choose{" "}
          <strong>Customer Support</strong>. That role can read and reply to reviews, nothing more.
        </p>
        <Figure
          src="/guides/asc-generate.svg"
          alt="Generate API Key dialog with the Customer Support role selected"
          caption="Choose Customer Support (1), then click Generate (2)."
        />
      </Step>

      <Step n={3} title="Download the key and copy both IDs">
        <p>
          Click <strong>Download</strong> next to the new key. Apple lets you download it only once, so keep the .p8 file somewhere
          safe. Then copy the <strong>Issuer ID</strong> from the top of the page and the <strong>Key ID</strong> from the key's
          row.
        </p>
        <Figure
          src="/guides/asc-keys.svg"
          alt="Team Keys page showing the Issuer ID, the key's Key ID and its Download link"
          caption="Issuer ID (1), Key ID (2) and the one-time Download link (3)."
        />
      </Step>

      <Step n={4} title="Paste them here">
        {user ? (
          <form method="post" action="/connect/apple" class="stack">
            {connection ? <input type="hidden" name="connection_id" value={connection.id} /> : null}
            <label>
              Issuer ID <span class="muted">(leave empty for an Individual Key)</span>
              <input type="text" name="issuer_id" placeholder="57246542-96fe-1a63-e053-0824d011072a" autocomplete="off" />
            </label>
            <label>
              Key ID
              <input type="text" name="key_id" required placeholder="2X9R4HXF34" autocomplete="off" />
            </label>
            <label>
              Private key (.p8 file)
              <input type="file" accept=".p8,text/plain" data-fill="private_key" />
              <textarea name="private_key" rows={4} required placeholder="-----BEGIN PRIVATE KEY-----" spellcheck={false}></textarea>
            </label>
            <div>
              <button type="submit" class="button primary">
                {connection ? "Update key" : "Connect App Store"}
              </button>
            </div>
          </form>
        ) : (
          <SignInPrompt env={env} />
        )}
      </Step>
    </ol>

    <Troubleshooting
      items={[
        [
          "“App Store Connect rejected the key”",
          "The Issuer ID, Key ID and .p8 file don't belong together, or the key was revoked. Generate a new key and use all three values from it.",
        ],
        [
          "“This API key doesn't have permission”",
          "The key's role is too limited. Customer Support or higher can read and reply to reviews.",
        ],
        ["I lost the .p8 file", "Apple can't send it again. Revoke that key in App Store Connect and generate a new one."],
        [
          "There's no Issuer ID on the page",
          "You're on the Individual Keys tab. Switch to Team Keys, or use your individual key and leave Issuer ID empty.",
        ],
        [
          "New app versions aren't detected",
          "Some roles can't read app versions. Mark releases yourself on the Releases page, or use a key with the App Manager role.",
        ],
      ]}
    />
    <p class="muted small">
      Illustrations are simplified: App Store Connect's screens change from time to time, but the names of these fields don't.
    </p>
  </Layout>
);

export const GooglePlayGuide: FC<GuideProps> = ({ env, user, flash, connection, packageNames }) => (
  <Layout env={env} title="Connect Google Play" user={user} active="connect" flash={flash}>
    <div class="page-head">
      <div>
        <h1>Connect Google Play</h1>
        <p class="muted">
          About 10 minutes. You'll create a Google service account that can read and reply to your reviews, and nothing else.
          Keys are encrypted before they're stored, and you can remove access anytime in Play Console.
        </p>
      </div>
    </div>
    <UpdateBanner connection={connection} />

    <ol class="guide">
      <Step n={1} title="Enable the Google Play Android Developer API">
        <p>
          Pick or create a Google Cloud project at the top of the page, then click <strong>Enable</strong>. Use the same project
          in the next step.
        </p>
        <External href="https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com">Open the API in Google Cloud</External>
        <Figure
          src="/guides/gp-enable.svg"
          alt="Google Cloud API page with the project selector and the Enable button"
          caption="Choose your project (1), then click Enable (2)."
        />
      </Step>

      <Step n={2} title="Create a service account and a JSON key">
        <p>
          Click <strong>Create service account</strong>, name it <strong>reviewloop</strong> and click <strong>Done</strong>. It
          doesn't need any Google Cloud roles. Open it, go to <strong>Keys</strong> → <strong>Add key</strong> →{" "}
          <strong>Create new key</strong>, choose <strong>JSON</strong> and click <strong>Create</strong>. A .json file downloads.
        </p>
        <External href="https://console.cloud.google.com/iam-admin/serviceaccounts">Open Service accounts</External>
        <Figure
          src="/guides/gp-key.svg"
          alt="Service account Keys tab with Add key, Create new key and the JSON option"
          caption="Keys tab (1), Create new key (2), then JSON and Create (3)."
        />
      </Step>

      <Step n={3} title="Give it access in Play Console">
        <p>
          In Play Console, open <strong>Users and permissions</strong> and click <strong>Invite new users</strong>. Paste the
          service account's email: it ends in <span class="mono">iam.gserviceaccount.com</span> and is the{" "}
          <span class="mono">client_email</span> in the JSON file. Under <strong>App permissions</strong>, add your apps with{" "}
          <strong>View app information</strong> and <strong>Reply to reviews</strong>, then click <strong>Invite user</strong>.
        </p>
        <External href="https://play.google.com/console">Open Play Console</External>
        <Figure
          src="/guides/gp-invite.svg"
          alt="Play Console invite form with the service account email and the Reply to reviews permission"
          caption="Service account email (1), App permissions (2), the two permissions (3), then Invite user (4)."
        />
      </Step>

      <Step n={4} title="Paste the key and your package names">
        {user ? (
          <form method="post" action="/connect/google" class="stack">
            {connection ? <input type="hidden" name="connection_id" value={connection.id} /> : null}
            <label>
              Service account key (the .json file)
              <input type="file" accept=".json,application/json" data-fill="service_account" />
              <textarea name="service_account" rows={4} required placeholder='{"type": "service_account", ...}' spellcheck={false}></textarea>
            </label>
            <label>
              Package names <span class="muted">(in Play Console's app list, or after id= in your Play Store link)</span>
              <input type="text" name="package_names" required value={packageNames ?? ""} placeholder="com.example.app, com.example.pro" />
            </label>
            <div>
              <button type="submit" class="button primary">
                {connection ? "Update key" : "Connect Google Play"}
              </button>
            </div>
          </form>
        ) : (
          <SignInPrompt env={env} />
        )}
      </Step>
    </ol>

    <Troubleshooting
      items={[
        [
          "“…has not been used in project … or it is disabled”",
          "Do step 1 in the same Google Cloud project as the service account, then wait a few minutes and try again.",
        ],
        [
          "“The caller does not have permission”",
          "Step 3 isn't finished, or hasn't taken effect yet. New Play Console invites can take a few hours to start working.",
        ],
        [
          "“Invalid grant” or “account not found”",
          "The key was deleted, or the JSON belongs to another service account. Create a new key (step 2).",
        ],
        [
          "Google Cloud won't let me create a key",
          "Your organization blocks service account keys with a policy (iam.disableServiceAccountKeyCreation). Ask your Google Cloud admin to allow it for this project.",
        ],
        ["“Package not found”", "Check the package name. It has to match an app in your Play Console."],
      ]}
    />
    <p class="muted small">
      Illustrations are simplified: Google's screens change from time to time, but these names and steps stay the same.
    </p>
  </Layout>
);

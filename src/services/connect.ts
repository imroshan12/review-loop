import * as db from "../db";
import type { Bindings, ConnectionRow, Store, UserRow } from "../env";
import { encryptJson } from "../lib/secrets";
import { AppleClient } from "../stores/apple";
import { DEMO_APPS, DEMO_LIVE_VERSIONS, demoReviews } from "../stores/demo";
import { GoogleClient } from "../stores/google";
import type { AppleCredentials, GoogleCredentials, StoreApp } from "../stores/types";
import { RequestBudget, StoreApiError } from "../stores/types";
import { appLimitFor, syncConnection, UserFacingError, type SyncSummary } from "./reviews";

const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export interface ConnectResult {
  connectionId: string;
  apps: number;
  updated: boolean;
  sync: SyncSummary | null;
}

/** Turns a store error into a message that says which guide step fixes it. */
export function explainStoreError(store: Store, error: StoreApiError): string {
  const message = error.message.replace(/\.?$/, ".");
  if (store === "apple") {
    if (error.status === 401) return `${message} Check steps 2 and 3: all three values must come from the same key.`;
    if (error.status === 403) return `${message} Use a key with the Customer Support role or higher (step 2).`;
    return message;
  }
  if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(error.message)) {
    return `${message} Enable the Google Play Android Developer API for the service account's project (step 1), then wait a few minutes.`;
  }
  if (/invalid.?grant|account not found|invalid jwt/i.test(error.message)) {
    return `${message} Create a new JSON key for the service account (step 2).`;
  }
  if (error.status === 403 || /permission/i.test(error.message)) {
    return `${message} Invite the service account in Play Console with access to this app (step 3). New invites can take a few hours to start working.`;
  }
  if (error.status === 404) return `${message} Check the package name matches an app in your Play Console (step 4).`;
  return message;
}

function rethrowFriendly(store: Store, prefix = ""): (error: unknown) => never {
  return (error: unknown) => {
    if (error instanceof StoreApiError) throw new UserFacingError(prefix + explainStoreError(store, error), 400);
    if (error instanceof UserFacingError) throw error;
    if (error instanceof Error) throw new UserFacingError(prefix + error.message, 400);
    throw error;
  };
}

async function existingConnection(env: Bindings, user: UserRow, connectionId: string, store: Store): Promise<ConnectionRow> {
  const connection = await db.getConnection(env.DB, user.id, connectionId);
  if (!connection || connection.store !== store) throw new UserFacingError("That connection no longer exists.", 404);
  return connection;
}

async function firstSync(env: Bindings, userId: string, connectionId: string): Promise<SyncSummary | null> {
  const connection = await db.getConnection(env.DB, userId, connectionId);
  return connection ? syncConnection(env, connection, new RequestBudget(30)) : null;
}

/**
 * Creates a store connection, or replaces the key of an existing one (reviews and replies are kept).
 */
async function saveConnection(
  env: Bindings,
  user: UserRow,
  store: "apple" | "google",
  options: { connectionId: string | null; label: string; credentials: unknown; apps: StoreApp[] },
): Promise<ConnectResult> {
  const sealed = await encryptJson(env.ENCRYPTION_KEY, options.credentials);
  let connectionId = options.connectionId;
  if (connectionId) {
    await db.updateConnectionCredentials(env.DB, user.id, connectionId, sealed, options.label);
  } else {
    connectionId = await db.createConnection(env.DB, user.id, store, options.label, sealed);
  }
  await db.upsertApps(env.DB, user.id, connectionId, store, options.apps, appLimitFor(env, user));
  return {
    connectionId,
    apps: options.apps.length,
    updated: Boolean(options.connectionId),
    sync: await firstSync(env, user.id, connectionId),
  };
}

export async function connectApple(
  env: Bindings,
  user: UserRow,
  input: { issuerId: string; keyId: string; privateKey: string },
  connectionId: string | null = null,
): Promise<ConnectResult> {
  const credentials: AppleCredentials = {
    issuerId: input.issuerId.trim() || null,
    keyId: input.keyId.trim(),
    privateKey: input.privateKey.trim(),
  };
  if (!/^[A-Z0-9]{8,12}$/i.test(credentials.keyId)) throw new UserFacingError("The Key ID should look like 2X9R4HXF34.");
  if (credentials.issuerId && !/^[0-9a-f-]{36}$/i.test(credentials.issuerId)) {
    throw new UserFacingError("The Issuer ID should be a UUID like 57246542-96fe-1a63-e053-0824d011072a.");
  }
  if (!credentials.privateKey.includes("PRIVATE KEY")) {
    throw new UserFacingError("Paste the full contents of the .p8 file, including the BEGIN and END lines.");
  }
  const existing = connectionId ? await existingConnection(env, user, connectionId, "apple") : null;

  const apps = await new AppleClient(credentials).listApps().catch(rethrowFriendly("apple"));
  if (apps.length === 0) throw new UserFacingError("The key works, but App Store Connect returned no apps for it.");

  if (existing) {
    const visible = new Set(apps.map((app) => app.storeAppId));
    const current = await db.listAppsForConnection(env.DB, existing.id);
    if (current.length && !current.some((app) => visible.has(app.store_app_id))) {
      throw new UserFacingError(
        "This key can't see the apps in this connection. Use a key from the same App Store Connect team, or add it as a new connection.",
      );
    }
  }

  return saveConnection(env, user, "apple", {
    connectionId: existing?.id ?? null,
    label: `App Store Connect · ${credentials.keyId}`,
    credentials,
    apps,
  });
}

export function parsePackageNames(text: string): string[] {
  const names = [...new Set(text.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))];
  const invalid = names.filter((name) => !PACKAGE_NAME.test(name));
  if (invalid.length) throw new UserFacingError(`These don't look like package names: ${invalid.join(", ")}`);
  if (names.length === 0) throw new UserFacingError("Add at least one package name, like com.example.app.");
  if (names.length > 20) throw new UserFacingError("Connect up to 20 packages at a time.");
  return names;
}

export async function connectGoogle(
  env: Bindings,
  user: UserRow,
  input: { serviceAccountJson: string; packageNames: string },
  connectionId: string | null = null,
): Promise<ConnectResult> {
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(input.serviceAccountJson);
  } catch {
    throw new UserFacingError("Paste the service account key file exactly as downloaded (it's JSON).");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new UserFacingError("That JSON is missing client_email or private_key. Download a new key for the service account.");
  }
  const packageNames = parsePackageNames(input.packageNames);
  const existing = connectionId ? await existingConnection(env, user, connectionId, "google") : null;
  const credentials: GoogleCredentials = { clientEmail: parsed.client_email, privateKey: parsed.private_key, packageNames };

  const client = new GoogleClient(credentials);
  for (const packageName of packageNames) {
    await client.checkAccess(packageName).catch(rethrowFriendly("google", `${packageName}: `));
  }

  return saveConnection(env, user, "google", {
    connectionId: existing?.id ?? null,
    label: `Google Play · ${parsed.client_email.split("@")[0]}`,
    credentials,
    apps: packageNames.map((name) => ({ storeAppId: name, name, bundleId: name })),
  });
}

/** Adds a sample workspace with two apps and realistic reviews, so new users can try every feature. */
export async function connectDemo(env: Bindings, user: UserRow): Promise<string> {
  await db.markSampleLoaded(env.DB, user.id);
  const existing = (await db.listConnections(env.DB, user.id)).find((connection) => connection.store === "demo");
  if (existing) return existing.id;

  const connectionId = await db.createConnection(env.DB, user.id, "demo", "Sample workspace", await encryptJson(env.ENCRYPTION_KEY, {}));
  await db.upsertApps(env.DB, user.id, connectionId, "demo", DEMO_APPS, Number.MAX_SAFE_INTEGER);
  for (const app of await db.listEnabledAppsForConnection(env.DB, connectionId)) {
    const result = await db.upsertStoreReviews(env.DB, app, demoReviews(app.store_app_id));
    await db.markAlerted(env.DB, result.inserted.map((review) => review.id));
    await db.updateAppVersion(env.DB, app.id, {
      latestVersion: DEMO_LIVE_VERSIONS[app.store_app_id] ?? null,
      lastReviewAt: result.newestReviewAt,
    });
  }
  await db.recordSyncSuccess(env.DB, connectionId);
  return connectionId;
}

export async function syncNow(env: Bindings, user: UserRow): Promise<SyncSummary> {
  const total: SyncSummary = { newReviews: 0, ratingsRaised: 0, followupsCreated: 0, error: null };
  const budget = new RequestBudget(40);
  const connections: ConnectionRow[] = await db.listConnections(env.DB, user.id);
  for (const connection of connections) {
    // Protects the user's store API quotas from repeated clicks.
    if (connection.store !== "demo" && connection.last_synced_at && Date.now() - Date.parse(connection.last_synced_at) < 60_000) {
      continue;
    }
    const result = await syncConnection(env, connection, budget);
    total.newReviews += result.newReviews;
    total.ratingsRaised += result.ratingsRaised;
    total.followupsCreated += result.followupsCreated;
    total.error = total.error ?? result.error;
  }
  return total;
}

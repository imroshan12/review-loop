import * as db from "../db";
import type { Bindings } from "../env";
import { currentSealPattern, encryptJson, keyring, openSealed } from "../lib/secrets";

/**
 * Encryption key rotation: while ENCRYPTION_KEY_PREVIOUS is set, each scheduled run moves a small batch
 * of secrets still sealed with an older key onto ENCRYPTION_KEY. Once the founder dashboard shows none
 * left, the previous key can be deleted.
 */
export async function resealStaleSecrets(env: Bindings, limit = 25): Promise<{ resealed: number; failed: number }> {
  const result = { resealed: 0, failed: 0 };
  if (!env.ENCRYPTION_KEY_PREVIOUS?.trim()) return result;

  const keys = keyring(env);
  const pattern = await currentSealPattern(env);
  const current = pattern.slice(0, -1); // "v2.<key id>."
  const reseal = async (sealed: string | null): Promise<string | null> => {
    if (!sealed || sealed.startsWith(current)) return sealed;
    return encryptJson(env.ENCRYPTION_KEY, (await openSealed<unknown>(keys, sealed)).value);
  };
  const failed = (what: string, error: unknown) => {
    result.failed++;
    console.warn(`re-encrypting ${what} failed:`, error instanceof Error ? error.message : String(error));
  };

  for (const connection of await db.staleConnections(env.DB, pattern, limit)) {
    try {
      await db.resealConnection(env.DB, connection.id, connection.credentials, (await reseal(connection.credentials))!);
      result.resealed++;
    } catch (error) {
      failed(`connection ${connection.id}`, error);
    }
  }

  for (const row of await db.staleWebhooks(env.DB, pattern, limit)) {
    try {
      await db.resealWebhooks(
        env.DB,
        row.user_id,
        { slack: row.slack_webhook, discord: row.discord_webhook },
        { slack: await reseal(row.slack_webhook), discord: await reseal(row.discord_webhook) },
      );
      result.resealed++;
    } catch (error) {
      failed(`webhooks for user ${row.user_id}`, error);
    }
  }
  return result;
}

/** For the founder dashboard: null when no rotation is in progress. */
export async function rotationStatus(env: Bindings): Promise<{ remaining: number } | null> {
  if (!env.ENCRYPTION_KEY_PREVIOUS?.trim()) return null;
  return { remaining: await db.countStaleSecrets(env.DB, await currentSealPattern(env)) };
}

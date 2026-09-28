export type AuditEvent =
  | "sign_in"
  | "sign_out"
  | "sign_out_everywhere"
  | "store_connected"
  | "store_key_updated"
  | "store_removed"
  | "alert_webhooks_changed"
  | "plan_changed"
  | "plan_change_requested"
  | "public_log_enabled"
  | "public_log_disabled"
  | "admin_opened";

export interface AuditEntry {
  id: number;
  event: AuditEvent;
  detail: string | null;
  ip_hash: string | null;
  country: string | null;
  user_agent: string | null;
  created_at: string;
}

export async function logEvent(
  db: D1Database,
  entry: {
    userId: string;
    event: AuditEvent;
    detail?: string | null;
    ipHash?: string | null;
    country?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (user_id, event, detail, ip_hash, country, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(
      entry.userId,
      entry.event,
      entry.detail?.slice(0, 300) ?? null,
      entry.ipHash ?? null,
      entry.country?.slice(0, 8) ?? null,
      entry.userAgent?.slice(0, 80) ?? null,
    )
    .run();
}

export async function recentEvents(db: D1Database, userId: string, limit = 20): Promise<AuditEntry[]> {
  const { results } = await db
    .prepare("SELECT id, event, detail, ip_hash, country, user_agent, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .bind(userId, limit)
    .all<AuditEntry>();
  return results;
}

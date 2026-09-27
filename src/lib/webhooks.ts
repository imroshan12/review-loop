import { base64ToBytes, bytesToBase64, timingSafeEqual, utf8 } from "./encoding";

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Standard Webhooks signature (used by Dodo Payments).
 * Signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64 part of a `whsec_` secret.
 * The signature header can hold several space-separated `v1,<base64>` entries.
 */
export async function verifyStandardWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) return false;

  const keyBytes = base64ToBytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, utf8(`${id}.${timestamp}.${body}`));
  const expected = bytesToBase64(new Uint8Array(mac));

  return signature
    .split(" ")
    .map((entry) => entry.split(","))
    .some(([version, value]) => version === "v1" && value !== undefined && timingSafeEqual(value, expected));
}

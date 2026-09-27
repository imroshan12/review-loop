import { base64ToBytes, bytesToBase64, toHex, utf8 } from "./encoding";

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secretBase64: string): Promise<CryptoKey> {
  let key = keyCache.get(secretBase64);
  if (!key) {
    const raw = base64ToBytes(secretBase64.trim());
    if (raw.length !== 32) {
      throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
    }
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secretBase64, key);
  }
  return key;
}

/** Current key first, then the pre-rotation key (ENCRYPTION_KEY_PREVIOUS) if one is set. */
export function keyring(env: { ENCRYPTION_KEY: string; ENCRYPTION_KEY_PREVIOUS?: string }): string[] {
  return [env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS].filter((key): key is string => Boolean(key?.trim()));
}

const keyIdCache = new Map<string, Promise<string>>();

/**
 * A short, non-secret id for a key: 8 hex characters of a hash, which reveal nothing useful about it.
 * It's stored with everything the key seals, so after a rotation the leftovers can be found in SQL.
 */
export function keyId(secretBase64: string): Promise<string> {
  const secret = secretBase64.trim();
  let id = keyIdCache.get(secret);
  if (!id) {
    id = crypto.subtle.digest("SHA-256", utf8(`reviewloop-key-id:${secret}`)).then((hash) => toHex(hash).slice(0, 8));
    keyIdCache.set(secret, id);
  }
  return id;
}

/** SQL LIKE pattern that matches values sealed with the current key. */
export async function currentSealPattern(env: { ENCRYPTION_KEY: string }): Promise<string> {
  return `v2.${await keyId(env.ENCRYPTION_KEY)}.%`;
}

/** Encrypts a value with AES-256-GCM. Output: "v2.<key id>.<iv>.<ciphertext>" (base64 parts). */
export async function encryptJson(secretBase64: string, value: unknown): Promise<string> {
  const key = await importKey(secretBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(JSON.stringify(value)));
  return `v2.${await keyId(secretBase64)}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypts "v2.…" values, and "v1.…" ones sealed before key ids existed. */
export async function decryptJson<T>(secretBase64: string, sealed: string): Promise<T> {
  const parts = sealed.split(".");
  let ivPart: string | undefined;
  let dataPart: string | undefined;
  if (parts[0] === "v2" && parts.length === 4) {
    if (parts[1] !== (await keyId(secretBase64))) throw new Error("Sealed with a different key.");
    [, , ivPart, dataPart] = parts;
  } else if (parts[0] === "v1" && parts.length === 3) {
    [, ivPart, dataPart] = parts;
  }
  if (!ivPart || !dataPart) throw new Error("Unrecognized encrypted value.");
  const key = await importKey(secretBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(dataPart),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/**
 * Decrypts with the first key that works. `stale` means the value should be re-encrypted with the
 * current key: an older key was needed, or it's in the old format without a key id.
 */
export async function openSealed<T>(keys: string[], sealed: string): Promise<{ value: T; stale: boolean }> {
  let lastError: unknown = new Error("No encryption key is configured.");
  for (let index = 0; index < keys.length; index++) {
    try {
      return { value: await decryptJson<T>(keys[index], sealed), stale: index > 0 || sealed.startsWith("v1.") };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function encryptOptional(secretBase64: string, value: string | null | undefined): Promise<string | null> {
  const trimmed = value?.trim();
  return trimmed ? encryptJson(secretBase64, trimmed) : null;
}

export async function decryptOptional(keys: string | string[], sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  return (await openSealed<string>(Array.isArray(keys) ? keys : [keys], sealed)).value;
}

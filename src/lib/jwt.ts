import { base64UrlEncode, pemToDer, utf8 } from "./encoding";

type Claims = Record<string, unknown>;
type SignAlgorithm = Parameters<SubtleCrypto["sign"]>[0];

async function sign(header: Claims, payload: Claims, key: CryptoKey, algorithm: SignAlgorithm): Promise<string> {
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  // WebCrypto returns ECDSA signatures as raw r||s, which is exactly what JWS ES256 expects.
  const signature = await crypto.subtle.sign(algorithm, key, utf8(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Signs an ES256 JWT with a PKCS#8 P-256 key (App Store Connect .p8 files). */
export async function signJwtES256(header: Claims, payload: Claims, privateKeyPem: string): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(privateKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("That doesn't look like an App Store Connect .p8 key.");
  }
  return sign({ ...header, alg: "ES256" }, payload, key, { name: "ECDSA", hash: "SHA-256" });
}

/** Signs an RS256 JWT with a PKCS#8 RSA key (Google service account keys). */
export async function signJwtRS256(header: Claims, payload: Claims, privateKeyPem: string): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("That doesn't look like a Google service account private key.");
  }
  return sign({ ...header, alg: "RS256" }, payload, key, { name: "RSASSA-PKCS1-v1_5" });
}

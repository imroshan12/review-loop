import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, bytesToBase64, pemToDer } from "../src/lib/encoding";
import { signJwtES256, signJwtRS256 } from "../src/lib/jwt";
import { decryptJson, encryptJson } from "../src/lib/secrets";
import { verifyStandardWebhook } from "../src/lib/webhooks";

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer);
  const lines = bytesToBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

describe("base64url", () => {
  it("round-trips bytes and strips padding", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
  });

  it("reads PEM keys pasted with escaped newlines", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\\nAAEC\\n-----END PRIVATE KEY-----\\n";
    expect([...pemToDer(pem)]).toEqual([0, 1, 2]);
  });
});

describe("JWT signing", () => {
  it("signs ES256 tokens App Store Connect can verify", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const token = await signJwtES256({ kid: "ABC123DEFG", typ: "JWT" }, { iss: "issuer", aud: "appstoreconnect-v1" }, await pkcs8Pem(pair.privateKey));
    const [header, payload, signature] = token.split(".");
    expect(decodePart(header)).toEqual({ kid: "ABC123DEFG", typ: "JWT", alg: "ES256" });
    expect(decodePart(payload)).toMatchObject({ iss: "issuer", aud: "appstoreconnect-v1" });
    const raw = base64UrlDecode(signature);
    expect(raw.length).toBe(64); // JWS wants raw r||s, not DER
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      raw,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("signs RS256 tokens for Google service accounts", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const token = await signJwtRS256({ typ: "JWT" }, { iss: "svc@example.iam.gserviceaccount.com" }, await pkcs8Pem(pair.privateKey));
    const [header, payload, signature] = token.split(".");
    expect(decodePart(header).alg).toBe("RS256");
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.publicKey,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("explains a malformed key instead of throwing a DOMException", async () => {
    await expect(signJwtES256({}, {}, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).rejects.toThrow(".p8");
  });
});

describe("credential encryption", () => {
  const key = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

  it("round-trips JSON and uses a fresh IV each time", async () => {
    const secret = { keyId: "ABC", privateKey: "-----BEGIN PRIVATE KEY-----" };
    const first = await encryptJson(key, secret);
    const second = await encryptJson(key, secret);
    expect(first).not.toEqual(second);
    expect(first).not.toContain("ABC");
    expect(await decryptJson(key, first)).toEqual(secret);
  });

  it("fails with a different key", async () => {
    const sealed = await encryptJson(key, "hello");
    const other = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(decryptJson(other, sealed)).rejects.toThrow();
  });

  it("rejects keys that aren't 32 bytes", async () => {
    await expect(encryptJson(bytesToBase64(new Uint8Array(16)), "x")).rejects.toThrow("32 bytes");
  });
});

describe("Standard Webhooks verification", () => {
  const secretBytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = `whsec_${bytesToBase64(secretBytes)}`;

  async function sign(id: string, timestamp: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    return `v1,${bytesToBase64(new Uint8Array(mac))}`;
  }

  it("accepts a valid signature among several", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = '{"type":"subscription.active"}';
    const signature = `v1,bm90LXRoaXMtb25l ${await sign("msg_1", String(now), body)}`;
    expect(await verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(now), signature }, body, now)).toBe(true);
  });

  it("rejects tampered bodies, stale timestamps and missing headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = '{"type":"subscription.active"}';
    const signature = await sign("msg_1", String(now), body);
    expect(await verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(now), signature }, body + " ", now)).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(now), signature }, body, now + 3600)).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: null, timestamp: String(now), signature }, body, now)).toBe(false);
  });
});

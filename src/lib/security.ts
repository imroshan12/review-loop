import { toHex, utf8 } from "./encoding";

export function contentSecurityPolicy(https: boolean): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    // Checkout and the billing portal are reached by redirect from our own forms.
    "form-action 'self' https://github.com https://*.dodopayments.com",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** A same-site path to return to after sign-in, or null. Blocks open redirects like //evil.com. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n\t]/.test(value)) return null;
  return value.slice(0, 200);
}

/** Keyed hash of an IP address for the security log, so raw IPs are never stored. */
export async function hashIp(secret: string, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(`ip-log:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, utf8(ip))).slice(0, 16);
}

/** "Chrome on macOS"-style label for the security log. */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : /curl|wget|python|node|go-http/i.test(userAgent)
              ? "Script"
              : "Browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${os}`;
}

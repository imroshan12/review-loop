const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** "focusflow-k3m9q": readable, but the random suffix keeps pages from being guessed or enumerated. */
export function makeSlug(appName: string): string {
  const base =
    appName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "app";
  const random = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(random, (byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join("");
  return `${base}-${suffix}`;
}

export const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char);
}

/** Rough text width for the badge, in pixels at 11px Verdana (the shields.io convention). */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[mwMW@%]/.test(char) ? 9 : /[il.,:;|!'1 ]/.test(char) ? 4 : 6.5;
  return Math.ceil(width);
}

/** A shields.io-style badge: "fixed from reviews | 12 issues". Text is escaped; no scripts or links inside. */
export function badgeSvg(label: string, value: string, color = "#9a5b06"): string {
  const left = textWidth(label) + 14;
  const right = textWidth(value) + 14;
  const width = left + right;
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${safeLabel}: ${safeValue}">
<title>${safeLabel}: ${safeValue}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${escapeXml(color)}"/><rect width="${width}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${left / 2}" y="15" fill="#010101" fill-opacity=".3">${safeLabel}</text><text x="${left / 2}" y="14">${safeLabel}</text>
<text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${safeValue}</text><text x="${left + right / 2}" y="14">${safeValue}</text>
</g></svg>`;
}

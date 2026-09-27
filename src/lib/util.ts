export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function currentMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Compares dotted version strings numerically ("1.10.0" > "1.9.2").
 * Non-numeric suffixes compare as text after the numeric parts.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.trim().split(/[.\-+ ]/);
  const partsB = b.trim().split(/[.\-+ ]/);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const left = partsA[i] ?? "0";
    const right = partsB[i] ?? "0";
    const numLeft = Number(left);
    const numRight = Number(right);
    if (Number.isFinite(numLeft) && Number.isFinite(numRight)) {
      if (numLeft !== numRight) return numLeft > numRight ? 1 : -1;
    } else if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

export function maxVersion(versions: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!version) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** Trims text to a character limit, preferring to cut at the end of a sentence, then a word. */
export function fitToLimit(text: string, limit: number): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const slice = clean.slice(0, limit);
  // A public reply reads better ending on a full sentence, even if that drops more text.
  const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (sentenceEnd > limit * 0.3) return slice.slice(0, sentenceEnd + 1).trim();
  const wordEnd = slice.lastIndexOf(" ");
  return (wordEnd > limit * 0.5 ? slice.slice(0, wordEnd) : slice.slice(0, limit - 1)).trim() + "…";
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

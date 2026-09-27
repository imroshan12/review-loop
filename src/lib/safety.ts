export interface SafetyResult {
  ok: boolean;
  problems: string[];
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_PATTERN = /\+?\d[\d\s().-]{8,}\d/g;
// Asking reviewers to change their rating breaks both stores' guidelines. Word stems catch
// "updating", "changed" and so on; the object must follow the verb closely, so "we changed the
// timer based on your review" is fine while "would you update your 1-star rating" is not.
const RATING_REQUEST_PATTERNS = [
  /\b(updat|chang|rais|revis|edit|increas|reconsider|improv|bump|boost|adjust|amend|modify|revisit)\w*\s+(your|the)\s+(\S+\s+){0,2}?(rating|review|stars?|score)\b/i,
  /\b(5|five)[\s-]stars?\b/i,
  /\b(better|higher)\s+(rating|review|score)\b/i,
  /\brate\s+(us|it|the\s+app)\s+(again|higher)\b/i,
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[.,;:!?]+$/, "");
}

/**
 * Checks an AI-written reply before it's sent without a person reading it.
 * Anything suspicious (a link, email or phone number that isn't the developer's own
 * support contact, or asking for a rating) keeps the reply waiting for review.
 */
export function checkReplySafety(text: string, supportContact: string): SafetyResult {
  const allowed = supportContact.trim().toLowerCase();
  const allowedDigits = allowed.replace(/\D/g, "");
  const isAllowed = (value: string) => allowed.length > 0 && allowed.includes(normalize(value));
  const problems: string[] = [];

  for (const match of text.match(URL_PATTERN) ?? []) {
    if (!isAllowed(match)) problems.push(`contains a link (${match})`);
  }
  for (const match of text.match(EMAIL_PATTERN) ?? []) {
    if (!isAllowed(match)) problems.push(`contains an email address (${match})`);
  }
  for (const match of text.match(PHONE_PATTERN) ?? []) {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 10 && !(allowedDigits.length >= 10 && allowedDigits.includes(digits))) {
      problems.push("contains a phone number");
    }
  }
  if (RATING_REQUEST_PATTERNS.some((pattern) => pattern.test(text))) problems.push("asks about the rating");
  return { ok: problems.length === 0, problems };
}

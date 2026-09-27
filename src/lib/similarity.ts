// Lightweight text matching for grouping reviews into issues. No AI cost, works in any language.

const STOP_WORDS = new Set(
  (
    "the and but for with this that from have has had was were are not you your our its it's " +
    "app apps when after every just very really please fix fixed update updated version still " +
    "can't cant don't dont doesn't doesnt won't wont get got use using used would could should " +
    "they them there then than what which will been being into only also again any all some"
  ).split(" "),
);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return new Set(words.map(stem));
}

/** Overlap coefficient: shared keywords divided by the smaller set, so a short title can match a long review. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Candidates at or above the threshold, best first. */
export function rankBySimilarity<T>(text: string, candidates: Array<{ item: T; text: string }>, threshold = 0.34): Array<Scored<T>> {
  const target = keywords(text);
  return candidates
    .map(({ item, text: candidateText }) => ({ item, score: similarity(target, keywords(candidateText)) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

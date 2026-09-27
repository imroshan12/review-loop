import { describe, expect, it } from "vitest";
import type { AppLoopRow, TraitCounts } from "../src/queries/insights";
import { checkReplySafety } from "../src/lib/safety";
import { keywords, rankBySimilarity, similarity } from "../src/lib/similarity";
import { guardVerdict } from "../src/services/guard";
import { findingsFrom, median, summarize } from "../src/services/insights";
import { forecastRecovery, suggestIssue, suggestTitle, whatsNewText } from "../src/services/issues";
import { badgeSvg, escapeXml, makeSlug, SLUG_PATTERN } from "../src/services/publiclog";

describe("grouping reviews into issues", () => {
  it("ignores filler words and word endings", () => {
    expect([...keywords("The timer stops when I lock my phone!")]).toEqual(["timer", "stop", "lock", "phone"]);
    expect(similarity(keywords("Timer stopped on lock screen"), keywords("timer stops when locked"))).toBeGreaterThan(0.5);
    expect(similarity(new Set(), keywords("anything"))).toBe(0);
  });

  it("ranks the matching issue first and drops unrelated ones", () => {
    const ranked = rankBySimilarity("Sync fails after the update, lost my notes", [
      { item: "dark", text: "Add a dark mode" },
      { item: "sync", text: "Sync failing, notes lost" },
      { item: "price", text: "Too expensive" },
    ]);
    expect(ranked.map((entry) => entry.item)).toEqual(["sync"]);
  });

  it("suggests an issue from the same app only", () => {
    const review = { app_id: "a1", title: "Crash", body: "App crashes when exporting a PDF", summary: null };
    const issues = [
      { id: "other-app", app_id: "a2", title: "Crash when exporting PDF", fix_note: null },
      { id: "same-app", app_id: "a1", title: "PDF export crash", fix_note: "Fixed the exporter" },
    ];
    expect(suggestIssue(review, issues)).toBe("same-app");
    expect(suggestIssue(review, issues.slice(0, 1))).toBeNull();
  });

  it("titles a new issue from the summary, title or first sentence", () => {
    expect(suggestTitle({ summary: "Timer stops on lock", title: "Bad", body: "x" })).toBe("Timer stops on lock");
    expect(suggestTitle({ summary: null, title: null, body: "Crashes on launch. Please fix." })).toBe("Crashes on launch");
    expect(suggestTitle({ summary: null, title: null, body: "x".repeat(200) })).toHaveLength(80);
  });
});

describe("recovery forecast", () => {
  const basis = { raiseRate: 0.4, newRating: 4.5, source: "yours" as const, sample: 20 };

  it("multiplies reviewers by the raise rate and the expected gain", () => {
    expect(forecastRecovery(10, 1.5, basis)).toBeCloseTo(12);
    expect(forecastRecovery(0, 1, basis)).toBe(0);
    // Reviewers already above the typical new rating have nothing to recover.
    expect(forecastRecovery(5, 4.8, basis)).toBe(0);
  });
});

describe("release notes", () => {
  it("lists fixed issues and credits reporters", () => {
    const text = whatsNewText([
      { title: "Timer stops on lock", reports: 12 },
      { title: "Typo in settings", reports: 1 },
    ]);
    expect(text).toContain("• Fixed: Timer stops on lock (reported by 12 of you)");
    expect(text).toContain("• Fixed: Typo in settings\n");
  });
});

describe("release guard", () => {
  it("flags a jump in 1–2★ reviews against the app's own baseline", () => {
    expect(guardVerdict({ total: 100, low: 10 }, { total: 20, low: 8 })).toEqual({ spike: true, ratio: 4 });
    expect(guardVerdict({ total: 100, low: 10 }, { total: 40, low: 5 })).toEqual({ spike: false, ratio: 1.3 });
  });

  it("needs at least 5 low ratings, so one angry review isn't a spike", () => {
    expect(guardVerdict({ total: 100, low: 1 }, { total: 4, low: 4 }).spike).toBe(false);
  });

  it("assumes a 30% baseline when there's little history", () => {
    expect(guardVerdict({ total: 3, low: 0 }, { total: 8, low: 6 })).toEqual({ spike: true, ratio: 2.5 });
    expect(guardVerdict({ total: 0, low: 0 }, { total: 0, low: 0 })).toEqual({ spike: false, ratio: 0 });
  });
});

describe("insights", () => {
  const row = (overrides: Partial<AppLoopRow>): AppLoopRow => ({
    app_id: "a",
    low: 0,
    low_replied: 0,
    sent_replies: 0,
    sent_fast: 0,
    followed: 0,
    followed_raised: 0,
    sent_raised: 0,
    raised_total: 0,
    gain_sum: 0,
    new_rating_sum: 0,
    ...overrides,
  });

  it("takes the median of an even or odd list", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("totals a developer's apps and leaves rates empty without data", () => {
    const summary = summarize([
      row({ low: 10, low_replied: 5, followed: 4, followed_raised: 2, raised_total: 2, gain_sum: 6, new_rating_sum: 9 }),
      row({ app_id: "b", low: 10, low_replied: 10 }),
    ]);
    expect(summary).toMatchObject({ apps: 2, low: 20, replyRate: 0.75, followupRaiseRate: 0.5, starsRecovered: 6, newRating: 4.5 });
    expect(summary.fastReplyRate).toBeNull();
    expect(summarize([]).replyRate).toBeNull();
  });

  it("only reports comparisons with enough replies on both sides", () => {
    const counts: TraitCounts = {
      n_fast: 40, r_fast: 20, n_slow: 40, r_slow: 8,
      n_version: 50, r_version: 10, n_no_version: 10, r_no_version: 1,
      n_sorry: 0, r_sorry: 0, n_no_sorry: 0, r_no_sorry: 0,
      n_followup: 30, r_followup: 15, n_first: 60, r_first: 6,
      n_long: 0, r_long: 0, n_short: 0, r_short: 0,
    };
    const findings = findingsFrom(counts);
    expect(findings.map((finding) => finding.trait)).toEqual(["Follow up after the fix ships", "Reply within a day of the review arriving"]);
    expect(findings[0]).toMatchObject({ withRate: 0.5, withoutRate: 0.1, withN: 30, withoutN: 60 });
  });
});

describe("public fix log", () => {
  it("makes readable slugs with an unguessable suffix", () => {
    const slug = makeSlug("FocusFlow: Pomodoro Timer!");
    expect(slug).toMatch(/^focusflow-pomodoro-timer-[a-z2-9]{6}$/);
    expect(SLUG_PATTERN.test(slug)).toBe(true);
    expect(makeSlug("专注")).toMatch(/^app-[a-z2-9]{6}$/);
    expect(makeSlug("a".repeat(100)).length).toBeLessThanOrEqual(48);
    expect(new Set(Array.from({ length: 50 }, () => makeSlug("x"))).size).toBe(50);
  });

  it("rejects slugs that could reach other paths", () => {
    for (const bad of ["../admin", "a/b", "AB", "x", "a b", "a%2fb", "a".repeat(49)]) expect(SLUG_PATTERN.test(bad)).toBe(false);
  });

  it("escapes badge text, so an app can't inject markup into the SVG", () => {
    const svg = badgeSvg(`<script>alert(1)</script>`, `"><image href=x onerror=alert(1)>`, `red" onload="alert(1)`);
    expect(svg).not.toMatch(/<script|<image|onload="/);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain('fill="red&quot; onload=&quot;alert(1)"');
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("reply safety check before automatic sending", () => {
  it("passes a normal follow-up", () => {
    expect(checkReplySafety("Hi Maya, version 2.3.1 fixes the timer bug you reported. Thanks for your patience! — Sam", "")).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("holds replies with links, emails or phone numbers that aren't the support contact", () => {
    expect(checkReplySafety("Details at https://evil.example/login", "").problems).toEqual(["contains a link (https://evil.example/login)"]);
    expect(checkReplySafety("Write to scam@evil.example.", "help@focusflow.app").ok).toBe(false);
    expect(checkReplySafety("Call +1 (555) 010-9999 now", "").problems).toEqual(["contains a phone number"]);
  });

  it("allows the developer's own support contact", () => {
    expect(checkReplySafety("Email help@focusflow.app if it happens again.", "help@focusflow.app").ok).toBe(true);
    expect(checkReplySafety("See https://focusflow.app/help.", "https://focusflow.app/help").ok).toBe(true);
  });

  it("holds replies that ask for a better rating, which both stores forbid", () => {
    for (const ask of [
      "Would you consider updating your rating?",
      "If it works now, maybe change your review.",
      "Please reconsider your 1-star rating.",
      "We'd love a 5-star review!",
      "A better rating would mean a lot.",
      "Could you rate us again?",
    ]) {
      expect(checkReplySafety(ask, "").problems, ask).toEqual(["asks about the rating"]);
    }
  });

  it("doesn't hold ordinary follow-up wording", () => {
    for (const fine of [
      "Please update the app to 2.3.1 to get the fix.",
      "We changed the timer based on your review.",
      "Thanks for your review and for your patience.",
      "Update the app and the timer keeps running with the screen locked.",
    ]) {
      expect(checkReplySafety(fine, "").ok, fine).toBe(true);
    }
  });
});

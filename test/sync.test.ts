import { describe, expect, it } from "vitest";
import { reviewChanged } from "../src/db";
import type { StoreReview } from "../src/stores/types";

const stored = {
  id: "r-1",
  store_review_id: "apple-1",
  rating: 1,
  title: "Timer stops",
  body: "It pauses when I lock the phone.",
  reviewed_at: "2026-09-20T10:00:00.000Z",
  reply_text: "Sorry! Fixing it now.",
  reply_state: "sent" as const,
  store_response_id: "resp-1",
  status: "fix_pending" as const,
  rating_before: null,
};

const fetched: StoreReview = {
  storeReviewId: "apple-1",
  rating: 1,
  title: "Timer stops",
  body: "It pauses when I lock the phone.",
  author: "maya",
  territory: "USA",
  language: null,
  appVersion: null,
  device: null,
  reviewedAt: "2026-09-20T10:00:00.000Z",
  reply: { text: "Sorry! Fixing it now.", id: "resp-1", repliedAt: "2026-09-20T11:00:00.000Z" },
};

describe("reviewChanged", () => {
  it("skips reviews the store returned unchanged", () => {
    expect(reviewChanged(stored, fetched)).toBe(false);
  });

  it("catches rating raises, edits and replies posted outside the app", () => {
    expect(reviewChanged(stored, { ...fetched, rating: 5 })).toBe(true);
    expect(reviewChanged(stored, { ...fetched, body: "Fixed now, thanks!" })).toBe(true);
    expect(reviewChanged(stored, { ...fetched, reviewedAt: "2026-09-25T10:00:00.000Z" })).toBe(true);
    expect(reviewChanged({ ...stored, reply_text: null, reply_state: "none", store_response_id: null }, fetched)).toBe(true);
    expect(reviewChanged(stored, { ...fetched, reply: { ...fetched.reply!, id: "resp-2" } })).toBe(true);
  });

  it("treats a missing Google title the same as a null one", () => {
    expect(reviewChanged({ ...stored, title: null }, { ...fetched, title: null })).toBe(false);
  });
});

import type { Store } from "../env";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Workers throws "Illegal invocation" when fetch is called as a method of another
 * object (e.g. `this.fetcher(url)`), so default fetchers always go through this wrapper.
 */
export const globalFetch: FetchLike = (input, init) => fetch(input, init);

export interface AppleCredentials {
  /** Team keys have an issuer id; individual keys don't. */
  issuerId: string | null;
  keyId: string;
  privateKey: string;
}

export interface GoogleCredentials {
  clientEmail: string;
  privateKey: string;
  packageNames: string[];
}

export interface StoreApp {
  storeAppId: string;
  name: string;
  bundleId?: string | null;
}

export interface StoreReview {
  storeReviewId: string;
  rating: number;
  title: string | null;
  body: string;
  author: string | null;
  territory: string | null;
  language: string | null;
  appVersion: string | null;
  device: string | null;
  reviewedAt: string;
  reply: { text: string; id: string | null; repliedAt: string | null } | null;
}

export interface SentReply {
  responseId: string | null;
}

export class StoreApiError extends Error {
  constructor(
    readonly store: Store,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoreApiError";
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Request budget for this run is used up.");
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Wraps fetch with a subrequest budget so one cron run stays inside the
 * Workers per-invocation subrequest limit.
 */
export class RequestBudget {
  used = 0;
  constructor(readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  fetcher(base: FetchLike = globalFetch): FetchLike {
    return (input, init) => {
      if (this.used >= this.limit) return Promise.reject(new BudgetExhaustedError());
      this.used++;
      return base(input, init);
    };
  }
}

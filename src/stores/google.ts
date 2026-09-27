import { signJwtRS256 } from "../lib/jwt";
import type { FetchLike, GoogleCredentials, SentReply, StoreReview } from "./types";
import { globalFetch, StoreApiError } from "./types";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

interface Timestamp {
  seconds?: string | number;
  nanos?: number;
}

interface GoogleReview {
  reviewId: string;
  authorName?: string;
  comments?: Array<{
    userComment?: {
      text?: string;
      lastModified?: Timestamp;
      starRating?: number;
      reviewerLanguage?: string;
      device?: string;
      appVersionName?: string;
    };
    developerComment?: { text?: string; lastModified?: Timestamp };
  }>;
}

interface ReviewsListResponse {
  reviews?: GoogleReview[];
  tokenPagination?: { nextPageToken?: string };
}

function toIso(timestamp: Timestamp | undefined): string | null {
  if (!timestamp?.seconds) return null;
  return new Date(Number(timestamp.seconds) * 1000).toISOString();
}

function describeGoogleError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
    if (typeof parsed.error === "object" && parsed.error?.message) return parsed.error.message;
    if (parsed.error === "invalid_grant") {
      return `Google didn't accept the service account key (${parsed.error_description ?? "invalid grant"}). Check that the JSON key is current and the service account still exists.`;
    }
    if (parsed.error_description) return parsed.error_description;
  } catch {
    // Fall through to the generic message.
  }
  if (status === 401) return "Google rejected the service account key.";
  if (status === 403) return "The service account can't access this app. Invite it in Play Console with review permissions.";
  if (status === 404) return "Google Play doesn't know this package name, or the service account can't see it.";
  return `Google Play returned HTTP ${status}.`;
}

export function mapGoogleReview(review: GoogleReview): StoreReview | null {
  const user = review.comments?.find((comment) => comment.userComment)?.userComment;
  if (!user) return null;
  const developer = review.comments?.find((comment) => comment.developerComment)?.developerComment;
  // Reviews with a title come back as "title\tbody".
  const text = user.text ?? "";
  const tab = text.indexOf("\t");
  return {
    storeReviewId: review.reviewId,
    rating: user.starRating ?? 0,
    title: tab > 0 ? text.slice(0, tab).trim() : null,
    body: (tab > 0 ? text.slice(tab + 1) : text).trim(),
    author: review.authorName ?? null,
    territory: null,
    language: user.reviewerLanguage ?? null,
    appVersion: user.appVersionName ?? null,
    device: user.device ?? null,
    reviewedAt: toIso(user.lastModified) ?? new Date().toISOString(),
    reply: developer?.text ? { text: developer.text, id: null, repliedAt: toIso(developer.lastModified) } : null,
  };
}

export class GoogleClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly fetcher: FetchLike = globalFetch,
  ) {}

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > now) return this.token.value;
    const assertion = await signJwtRS256(
      { typ: "JWT" },
      { iss: this.credentials.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      this.credentials.privateKey,
    );
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new StoreApiError("google", response.status, describeGoogleError(response.status, text));
    const parsed = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.token = { value: parsed.access_token, expiresAt: now + (parsed.expires_in ?? 3600) };
    return parsed.access_token;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new StoreApiError("google", response.status, describeGoogleError(response.status, text));
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Google only returns reviews created or edited in roughly the last week. */
  async listReviews(packageName: string, options: { maxPages?: number } = {}): Promise<StoreReview[]> {
    const reviews: StoreReview[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < (options.maxPages ?? 3); page++) {
      const params = new URLSearchParams({ maxResults: "100" });
      if (pageToken) params.set("token", pageToken);
      const result = await this.request<ReviewsListResponse>(
        `${API}/applications/${encodeURIComponent(packageName)}/reviews?${params}`,
      );
      for (const review of result.reviews ?? []) {
        const mapped = mapGoogleReview(review);
        if (mapped) reviews.push(mapped);
      }
      pageToken = result.tokenPagination?.nextPageToken;
      if (!pageToken) break;
    }
    return reviews;
  }

  async reply(packageName: string, reviewId: string, text: string): Promise<SentReply> {
    await this.request(
      `${API}/applications/${encodeURIComponent(packageName)}/reviews/${encodeURIComponent(reviewId)}:reply`,
      { method: "POST", body: JSON.stringify({ replyText: text }) },
    );
    return { responseId: null };
  }

  /** Confirms the service account can read this package's reviews. */
  async checkAccess(packageName: string): Promise<void> {
    await this.request(`${API}/applications/${encodeURIComponent(packageName)}/reviews?maxResults=1`);
  }
}

import { signJwtES256 } from "../lib/jwt";
import type { AppleCredentials, FetchLike, SentReply, StoreApp, StoreReview } from "./types";
import { globalFetch, StoreApiError } from "./types";

const API = "https://api.appstoreconnect.apple.com";

interface JsonApiResource<A> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, { data?: { type: string; id: string } | null }>;
}

interface JsonApiDocument<A> {
  data: JsonApiResource<A> | Array<JsonApiResource<A>>;
  included?: Array<JsonApiResource<Record<string, unknown>>>;
  links?: { next?: string };
}

interface ReviewAttributes {
  rating: number;
  title?: string | null;
  body?: string | null;
  reviewerNickname?: string | null;
  createdDate: string;
  territory?: string | null;
}

interface ResponseAttributes {
  responseBody?: string;
  lastModifiedDate?: string;
  state?: string;
}

interface VersionAttributes {
  versionString?: string;
  platform?: string;
  appStoreState?: string;
  appVersionState?: string;
  createdDate?: string;
}

const LIVE_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);

function describeAppleError(status: number, text: string): string {
  if (status === 401) {
    return "App Store Connect rejected the key. Check that the Issuer ID, Key ID and .p8 file belong together and the key hasn't been revoked.";
  }
  try {
    const parsed = JSON.parse(text) as { errors?: Array<{ title?: string; detail?: string }> };
    const first = parsed.errors?.[0];
    if (first?.detail) return first.detail;
    if (first?.title) return first.title;
  } catch {
    // Fall through to the generic message.
  }
  if (status === 403) return "This API key doesn't have permission for that action.";
  return `App Store Connect returned HTTP ${status}.`;
}

export function mapAppleReviews(document: JsonApiDocument<ReviewAttributes>): StoreReview[] {
  const responses = new Map<string, JsonApiResource<Record<string, unknown>>>();
  for (const item of document.included ?? []) {
    if (item.type === "customerReviewResponses") responses.set(item.id, item);
  }
  const items = Array.isArray(document.data) ? document.data : [document.data];
  return items.map((item) => {
    const attributes = item.attributes as ReviewAttributes;
    const responseRef = item.relationships?.response?.data;
    const response = responseRef ? responses.get(responseRef.id) : undefined;
    const responseAttributes = response?.attributes as ResponseAttributes | undefined;
    return {
      storeReviewId: item.id,
      rating: attributes.rating,
      title: attributes.title ?? null,
      body: attributes.body ?? "",
      author: attributes.reviewerNickname ?? null,
      territory: attributes.territory ?? null,
      language: null,
      appVersion: null,
      device: null,
      reviewedAt: new Date(attributes.createdDate).toISOString(),
      reply:
        response && responseAttributes?.responseBody
          ? {
              text: responseAttributes.responseBody,
              id: response.id,
              repliedAt: responseAttributes.lastModifiedDate
                ? new Date(responseAttributes.lastModifiedDate).toISOString()
                : null,
            }
          : null,
    };
  });
}

export function pickLiveVersion(document: JsonApiDocument<VersionAttributes>): string | null {
  const items = Array.isArray(document.data) ? document.data : [document.data];
  const live = items
    .filter((item) => {
      const a = item.attributes;
      return a && (LIVE_STATES.has(a.appStoreState ?? "") || LIVE_STATES.has(a.appVersionState ?? ""));
    })
    .sort((x, y) => Date.parse(y.attributes?.createdDate ?? "") - Date.parse(x.attributes?.createdDate ?? ""));
  return live[0]?.attributes?.versionString ?? null;
}

export class AppleClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: AppleCredentials,
    private readonly fetcher: FetchLike = globalFetch,
  ) {}

  private async jwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > now) return this.token.value;
    const expiresAt = now + 15 * 60;
    const payload = this.credentials.issuerId
      ? { iss: this.credentials.issuerId, iat: now, exp: expiresAt, aud: "appstoreconnect-v1" }
      : { sub: "user", iat: now, exp: expiresAt, aud: "appstoreconnect-v1" };
    const value = await signJwtES256({ kid: this.credentials.keyId, typ: "JWT" }, payload, this.credentials.privateKey);
    this.token = { value, expiresAt };
    return value;
  }

  private async request<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T | null> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.jwt()}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new StoreApiError("apple", response.status, describeAppleError(response.status, text));
    return text ? (JSON.parse(text) as T) : null;
  }

  async listApps(): Promise<StoreApp[]> {
    const apps: StoreApp[] = [];
    let next: string | undefined = "/v1/apps?fields[apps]=name,bundleId&limit=200";
    for (let page = 0; next && page < 5; page++) {
      const document: JsonApiDocument<{ name?: string; bundleId?: string }> | null = await this.request(next);
      if (!document) break;
      for (const item of Array.isArray(document.data) ? document.data : [document.data]) {
        apps.push({ storeAppId: item.id, name: item.attributes?.name ?? item.id, bundleId: item.attributes?.bundleId });
      }
      next = document.links?.next;
    }
    return apps;
  }

  /** Newest reviews first. Stops paging once reviews are older than `since`. */
  async listReviews(
    appId: string,
    options: { since?: string | null; maxPages?: number; pageSize?: number } = {},
  ): Promise<StoreReview[]> {
    const since = options.since ? Date.parse(options.since) : null;
    const maxPages = options.maxPages ?? 3;
    const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 200));
    const reviews: StoreReview[] = [];
    let next: string | undefined =
      `/v1/apps/${encodeURIComponent(appId)}/customerReviews?sort=-createdDate&limit=${pageSize}&include=response`;
    for (let page = 0; next && page < maxPages; page++) {
      const document: JsonApiDocument<ReviewAttributes> | null = await this.request(next);
      if (!document) break;
      const batch = mapAppleReviews(document);
      reviews.push(...batch);
      const oldest = batch[batch.length - 1];
      if (since !== null && oldest && Date.parse(oldest.reviewedAt) < since) break;
      next = document.links?.next;
    }
    return reviews;
  }

  /** Creates the public response, replacing an earlier one when needed. */
  async reply(reviewId: string, text: string, existingResponseId: string | null): Promise<SentReply> {
    const body = JSON.stringify({
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: text },
        relationships: { review: { data: { type: "customerReviews", id: reviewId } } },
      },
    });
    const create = () => this.request<JsonApiDocument<ResponseAttributes>>("/v1/customerReviewResponses", { method: "POST", body });
    let created: JsonApiDocument<ResponseAttributes> | null;
    try {
      created = await create();
    } catch (error) {
      if (!(error instanceof StoreApiError) || error.status !== 409 || !existingResponseId) throw error;
      await this.request(`/v1/customerReviewResponses/${encodeURIComponent(existingResponseId)}`, { method: "DELETE" });
      created = await create();
    }
    const data = created && !Array.isArray(created.data) ? created.data : null;
    return { responseId: data?.id ?? null };
  }

  /** The version currently live on the App Store, or null if unknown. */
  async liveVersion(appId: string): Promise<string | null> {
    const document = await this.request<JsonApiDocument<VersionAttributes>>(
      `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?limit=10`,
    );
    return document ? pickLiveVersion(document) : null;
  }
}

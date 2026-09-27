import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../src/lib/encoding";
import { AppleClient, mapAppleReviews, pickLiveVersion } from "../src/stores/apple";
import { GoogleClient, mapGoogleReview } from "../src/stores/google";
import { BudgetExhaustedError, RequestBudget, StoreApiError, type FetchLike } from "../src/stores/types";

async function testKeyPem(algorithm: "ec" | "rsa"): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    algorithm === "ec"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(der)}\n-----END PRIVATE KEY-----`;
}

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Array<(call: Call) => Response | undefined>): { fetcher: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const appleReviewPage = (ids: Array<[string, string]>, next?: string) => ({
  data: ids.map(([id, createdDate]) => ({
    type: "customerReviews",
    id,
    attributes: { rating: 2, title: `Title ${id}`, body: `Body ${id}`, reviewerNickname: "nick", createdDate, territory: "USA" },
    relationships: { response: { data: id === "r1" ? { type: "customerReviewResponses", id: "resp1" } : null } },
  })),
  included: [
    { type: "customerReviewResponses", id: "resp1", attributes: { responseBody: "Thanks!", lastModifiedDate: "2026-09-20T10:00:00-07:00" } },
  ],
  links: next ? { next } : {},
});

describe("App Store Connect", () => {
  it("maps reviews and attaches existing responses", () => {
    const reviews = mapAppleReviews(appleReviewPage([["r1", "2026-09-20T08:00:00-07:00"], ["r2", "2026-09-19T08:00:00-07:00"]]));
    expect(reviews[0]).toMatchObject({
      storeReviewId: "r1",
      rating: 2,
      author: "nick",
      territory: "USA",
      reviewedAt: "2026-09-20T15:00:00.000Z",
      reply: { text: "Thanks!", id: "resp1" },
    });
    expect(reviews[1].reply).toBeNull();
  });

  it("picks the newest live version", () => {
    const version = pickLiveVersion({
      data: [
        { type: "appStoreVersions", id: "1", attributes: { versionString: "2.4.0", appStoreState: "PREPARE_FOR_SUBMISSION", createdDate: "2026-09-25T00:00:00Z" } },
        { type: "appStoreVersions", id: "2", attributes: { versionString: "2.3.1", appStoreState: "READY_FOR_SALE", createdDate: "2026-09-10T00:00:00Z" } },
        { type: "appStoreVersions", id: "3", attributes: { versionString: "2.3.0", appVersionState: "READY_FOR_DISTRIBUTION", createdDate: "2026-08-01T00:00:00Z" } },
      ],
    });
    expect(version).toBe("2.3.1");
  });

  it("pages until reviews are older than the last sync, with a signed bearer token", async () => {
    const { fetcher, calls } = fakeFetch([
      ({ url }) =>
        url.includes("cursor=2")
          ? json(appleReviewPage([["r3", "2026-09-01T00:00:00Z"]], "https://api.appstoreconnect.apple.com/v1/next?cursor=3"))
          : undefined,
      ({ url }) =>
        url.includes("/customerReviews")
          ? json(appleReviewPage([["r1", "2026-09-20T00:00:00Z"], ["r2", "2026-09-18T00:00:00Z"]], "https://api.appstoreconnect.apple.com/v1/next?cursor=2"))
          : undefined,
    ]);
    const client = new AppleClient({ issuerId: "i", keyId: "KEY1234567", privateKey: await testKeyPem("ec") }, fetcher);
    const reviews = await client.listReviews("123", { since: "2026-09-10T00:00:00Z", maxPages: 5 });
    expect(reviews.map((review) => review.storeReviewId)).toEqual(["r1", "r2", "r3"]);
    expect(calls).toHaveLength(2); // stopped once page 2 reached reviews older than `since`
    const auth = new Headers(calls[0].init?.headers).get("Authorization") ?? "";
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("replaces an existing response when Apple reports a conflict", async () => {
    let posts = 0;
    const { fetcher, calls } = fakeFetch([
      ({ url, init }) => {
        if (!url.endsWith("/v1/customerReviewResponses") || init?.method !== "POST") return undefined;
        posts++;
        return posts === 1
          ? json({ errors: [{ status: "409", title: "Conflict", detail: "A response already exists" }] }, 409)
          : json({ data: { type: "customerReviewResponses", id: "resp-new" } }, 201);
      },
      ({ url, init }) => (url.endsWith("/v1/customerReviewResponses/resp-old") && init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
    ]);
    const client = new AppleClient({ issuerId: null, keyId: "KEY1234567", privateKey: await testKeyPem("ec") }, fetcher);
    const result = await client.reply("review-1", "Fixed now, thanks!", "resp-old");
    expect(result.responseId).toBe("resp-new");
    expect(calls.map((call) => call.init?.method)).toEqual(["POST", "DELETE", "POST"]);
    const body = JSON.parse(String(calls[2].init?.body));
    expect(body.data.relationships.review.data).toEqual({ type: "customerReviews", id: "review-1" });
  });

  it("surfaces Apple's error detail", async () => {
    const { fetcher } = fakeFetch([() => json({ errors: [{ title: "Forbidden", detail: "The API key in use does not allow this request" }] }, 403)]);
    const client = new AppleClient({ issuerId: "i", keyId: "KEY1234567", privateKey: await testKeyPem("ec") }, fetcher);
    const error = await client.listApps().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreApiError);
    expect((error as StoreApiError).status).toBe(403);
    expect((error as StoreApiError).message).toContain("does not allow");
  });
});

describe("Google Play", () => {
  it("splits titles from bodies and reads developer replies", () => {
    const review = mapGoogleReview({
      reviewId: "g1",
      authorName: "Arjun",
      comments: [
        {
          userComment: {
            text: "Crashes\tIt crashes when I open settings",
            starRating: 1,
            reviewerLanguage: "en_IN",
            appVersionName: "1.8.2",
            device: "Pixel 9",
            lastModified: { seconds: "1790000000" },
          },
        },
        { developerComment: { text: "Sorry! Looking into it.", lastModified: { seconds: "1790003600" } } },
      ],
    });
    expect(review).toMatchObject({
      storeReviewId: "g1",
      title: "Crashes",
      body: "It crashes when I open settings",
      rating: 1,
      appVersion: "1.8.2",
      reply: { text: "Sorry! Looking into it." },
    });
    expect(review?.reviewedAt).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it("exchanges a service account JWT for a token, then pages and replies", async () => {
    const { fetcher, calls } = fakeFetch([
      ({ url }) => (url === "https://oauth2.googleapis.com/token" ? json({ access_token: "ya29.token", expires_in: 3600 }) : undefined),
      ({ url }) =>
        url.includes("/reviews?") && url.includes("token=page2")
          ? json({ reviews: [{ reviewId: "g2", comments: [{ userComment: { text: "ok", starRating: 4 } }] }] })
          : undefined,
      ({ url }) =>
        url.includes("/reviews?")
          ? json({
              reviews: [{ reviewId: "g1", comments: [{ userComment: { text: "bad", starRating: 1 } }] }],
              tokenPagination: { nextPageToken: "page2" },
            })
          : undefined,
      ({ url }) => (url.endsWith("/reviews/g1:reply") ? json({ result: { replyText: "hi" } }) : undefined),
    ]);
    const client = new GoogleClient({ clientEmail: "svc@x.iam.gserviceaccount.com", privateKey: await testKeyPem("rsa"), packageNames: ["com.example.app"] }, fetcher);
    const reviews = await client.listReviews("com.example.app");
    expect(reviews.map((review) => review.storeReviewId)).toEqual(["g1", "g2"]);
    await client.reply("com.example.app", "g1", "hi");

    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(String(calls[0].init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(calls.filter((call) => call.url.includes("oauth2")).length).toBe(1); // token is cached
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer ya29.token");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ replyText: "hi" });
  });
});

describe("request budget", () => {
  it("refuses requests past the limit", async () => {
    const budget = new RequestBudget(2);
    const fetcher = budget.fetcher(async () => new Response("ok"));
    await fetcher("https://a");
    await fetcher("https://b");
    await expect(fetcher("https://c")).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(budget.remaining).toBe(0);
  });
});

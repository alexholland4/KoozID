import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetJwksCache, verifyAccessJwt } from "../src/worker/auth";
import { makeClient } from "./helpers";

const TEAM = "https://koozid-test.cloudflareaccess.com";
const AUD = "test-aud-123";

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
const fetcher = async () => [jwk];

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function sign(claims: Record<string, unknown>, key = keyPair.privateKey, kid = "k1") {
  const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const now = () => Math.floor(Date.now() / 1000);
const good = (extra: Record<string, unknown> = {}) => ({ aud: [AUD], iss: TEAM, exp: now() + 3600, iat: now(), email: "Brother@Example.com", ...extra });

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey), kid: "k1" };
});
beforeEach(() => resetJwksCache());

describe("verifyAccessJwt", () => {
  it("accepts a valid token", async () => {
    const claims = await verifyAccessJwt(await sign(good()), TEAM, AUD, fetcher);
    expect(claims.email).toBe("Brother@Example.com");
  });

  it("rejects wrong audience, issuer, expiry, signature and algorithm", async () => {
    await expect(verifyAccessJwt(await sign(good({ aud: ["other"] })), TEAM, AUD, fetcher)).rejects.toThrow(/audience/);
    await expect(verifyAccessJwt(await sign(good({ iss: "https://evil.cloudflareaccess.com" })), TEAM, AUD, fetcher)).rejects.toThrow(/issuer/);
    await expect(verifyAccessJwt(await sign(good({ exp: now() - 3600 })), TEAM, AUD, fetcher)).rejects.toThrow(/expired/);
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    await expect(verifyAccessJwt(await sign(good(), other.privateKey), TEAM, AUD, fetcher)).rejects.toThrow(/signature/);
    await expect(verifyAccessJwt(await sign(good(), keyPair.privateKey, "unknown"), TEAM, AUD, fetcher)).rejects.toThrow(/signing key/);
    const [, p, s] = (await sign(good())).split(".");
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${p}.${s}`;
    await expect(verifyAccessJwt(none, TEAM, AUD, fetcher)).rejects.toThrow(/algorithm/);
    await expect(verifyAccessJwt("garbage", TEAM, AUD, fetcher)).rejects.toThrow();
  });
});

describe("API authorization boundary (access mode)", () => {
  const accessEnv = { AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  it("rejects requests without a token on every kind of endpoint", async () => {
    const api = makeClient({ keyFetcher: fetcher }, accessEnv, "https://koozid.example.com");
    for (const [m, p] of [
      ["GET", "/stats"],
      ["GET", "/items"],
      ["GET", "/items/1"],
      ["GET", `/photos/${crypto.randomUUID()}/full`],
      ["POST", "/scans"],
      ["PATCH", "/items/1"],
      ["DELETE", "/items/1"],
      ["GET", "/export/items"],
      ["POST", "/admin/import"],
    ] as const) {
      const res = await api.call(m, p);
      expect(res.status, `${m} ${p}`).toBe(401);
    }
  });

  it("accepts a valid token via header or cookie and enforces allowlists", async () => {
    const api = makeClient({ keyFetcher: fetcher }, { ...accessEnv, ALLOWED_EMAILS: "brother@example.com, admin@example.com", ADMIN_EMAILS: "admin@example.com" }, "https://koozid.example.com");
    const token = await sign(good());
    const me = await api.json("GET", "/me", undefined, { "cf-access-jwt-assertion": token });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("brother@example.com");
    expect(me.body.is_admin).toBe(false);
    expect((await api.call("GET", "/me", undefined, { cookie: `foo=1; CF_Authorization=${token}` })).status).toBe(200);

    // Non-admins cannot use admin tools.
    expect((await api.call("POST", "/admin/reindex", {}, { "cf-access-jwt-assertion": token })).status).toBe(403);
    // Bulk photo upload/matching is admin-only, but anyone allowed can review the matches.
    expect((await api.call("POST", "/admin/bulk/photos", new FormData(), { "cf-access-jwt-assertion": token })).status).toBe(403);
    expect((await api.call("POST", `/admin/bulk/photos/${crypto.randomUUID()}/match`, undefined, { "cf-access-jwt-assertion": token })).status).toBe(403);
    expect((await api.call("GET", "/bulk", undefined, { "cf-access-jwt-assertion": token })).status).toBe(200);
    // The collector (a member, not an admin) runs offers, the mailing address, leaderboard groups and the goal.
    const h = { "cf-access-jwt-assertion": token };
    expect((await api.call("GET", "/admin/offers", undefined, h)).status).toBe(200);
    expect((await api.call("GET", "/admin/contribute", undefined, h)).status).toBe(200);
    expect((await api.json("PUT", "/admin/contribute", { mailing_address: "1 Main St" }, h)).body.mailing_address).toBe("1 Main St");
    expect((await api.call("GET", "/admin/sources", undefined, h)).status).toBe(200);
    expect((await api.call("PUT", "/admin/settings", { goal: 4000 }, h)).status).toBe(200);
    expect((await api.call("GET", "/admin/usage", undefined, h)).status).toBe(403);
    // Someone who passes Access but is not on the app allowlist.
    const stranger = await sign(good({ email: "stranger@example.com" }));
    expect((await api.call("GET", "/stats", undefined, { "cf-access-jwt-assertion": stranger })).status).toBe(403);
  });

  it("only accepts service tokens that are explicitly allowed", async () => {
    const svc = await sign(good({ email: undefined, common_name: "abc123.access" }));
    const denied = makeClient({ keyFetcher: fetcher }, accessEnv, "https://koozid.example.com");
    expect((await denied.call("GET", "/stats", undefined, { "cf-access-jwt-assertion": svc })).status).toBe(403);
    const allowed = makeClient({ keyFetcher: fetcher }, { ...accessEnv, SERVICE_TOKEN_CLIENT_IDS: "abc123.access" }, "https://koozid.example.com");
    expect((await allowed.call("GET", "/stats", undefined, { "cf-access-jwt-assertion": svc })).status).toBe(200);
  });

  it("fails closed when Access is not configured", async () => {
    const api = makeClient({ keyFetcher: fetcher }, { AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }, "https://koozid.example.com");
    const res = await api.json("GET", "/stats", undefined, { "cf-access-jwt-assertion": await sign(good()) });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("auth_misconfigured");
  });

  it("refuses dev auth on a non-localhost hostname", async () => {
    const api = makeClient({}, { AUTH_MODE: "dev" }, "https://koozid.workers.dev");
    const res = await api.json("GET", "/stats");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("auth_misconfigured");
  });

  it("requires the CSRF header on mutations", async () => {
    const api = makeClient();
    const res = await api.call("POST", "/admin/reindex", {}, { "x-koozid": "0" });
    expect(res.status).toBe(403);
  });
});

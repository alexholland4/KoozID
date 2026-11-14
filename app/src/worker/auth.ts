// Authentication: Cloudflare Access in production, an explicit localhost-only dev identity locally.
//
// Access guards /api and /signin (the rest of the site is the public guest view), but the Worker
// still verifies the signed Access JWT on every API request so that a misconfigured Access
// policy, a forgotten workers.dev route, or a preview URL can never expose the API.

import type { Config } from "./env";
import { forbidden, HttpError, unauthorized } from "./errors";

export interface Identity {
  email: string;
  isAdmin: boolean;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

export type KeyFetcher = (teamDomain: string) => Promise<Jwk[]>;

// Module-scope cache survives across requests in the same isolate.
let jwksCache: { team: string; keys: Jwk[]; at: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export const fetchAccessKeys: KeyFetcher = async (teamDomain) => {
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  return body.keys;
};

async function getKeys(teamDomain: string, fetcher: KeyFetcher, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.team === teamDomain && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const keys = await fetcher(teamDomain);
  jwksCache = { team: teamDomain, keys, at: Date.now() };
  return keys;
}

export function resetJwksCache() {
  jwksCache = null;
}

const b64urlToBytes = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export interface AccessClaims {
  aud: string | string[];
  iss: string;
  exp: number;
  nbf?: number;
  email?: string;
  common_name?: string; // service tokens
  sub?: string;
}

/** Verify an Access JWT (RS256) and return its claims. Throws on any failure. */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
  fetcher: KeyFetcher = fetchAccessKeys,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized("Malformed access token");
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    throw unauthorized("Malformed access token");
  }
  if (header.alg !== "RS256" || !header.kid) throw unauthorized("Unsupported token algorithm");

  let keys = await getKeys(teamDomain, fetcher);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation: refetch once.
    keys = await getKeys(teamDomain, fetcher, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw unauthorized("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw unauthorized("Invalid token signature");

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw unauthorized("Token audience mismatch");
  if (claims.iss !== teamDomain) throw unauthorized("Token issuer mismatch");
  const skew = 60;
  if (typeof claims.exp !== "number" || claims.exp + skew < nowSec) throw unauthorized("Session expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > nowSec) throw unauthorized("Token not yet valid");
  return claims;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function readToken(req: Request): string | null {
  const header = req.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

export async function authenticate(req: Request, cfg: Config, fetcher?: KeyFetcher): Promise<Identity> {
  if (cfg.authMode === "dev") {
    const host = new URL(req.url).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      // Never let a stray AUTH_MODE=dev open up a deployed Worker.
      throw new HttpError(500, "auth_misconfigured", "Dev auth is only permitted on localhost");
    }
    return { email: cfg.devUserEmail.toLowerCase(), isAdmin: true };
  }

  if (!cfg.accessTeamDomain || !cfg.accessAud) {
    throw new HttpError(500, "auth_misconfigured", "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)");
  }
  const token = readToken(req);
  if (!token) throw unauthorized();
  const claims = await verifyAccessJwt(token, cfg.accessTeamDomain, cfg.accessAud, fetcher);

  if (!claims.email) {
    // Service token (scripts, backups): identified by client id, must be explicitly allowed.
    const cn = (claims.common_name ?? "").toLowerCase();
    if (cn && cfg.serviceTokenIds.includes(cn)) return { email: `service:${cn}`, isAdmin: true };
    throw forbidden("This identity is not allowed");
  }
  const email = claims.email.toLowerCase();
  if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) throw forbidden("This account is not allowed");
  const isAdmin = cfg.adminEmails.length === 0 || cfg.adminEmails.includes(email);
  return { email, isAdmin };
}

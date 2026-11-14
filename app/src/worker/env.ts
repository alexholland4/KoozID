// Bindings and centralised configuration parsing.

export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORS?: VectorizeIndex;

  AUTH_MODE?: string;
  DEV_USER_EMAIL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  ADMIN_EMAILS?: string;
  SERVICE_TOKEN_CLIENT_IDS?: string;

  AI_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMS?: string;
  DESCRIBE_MODEL?: string;

  VECTOR_BACKEND?: string;
  MATCH_STRONG?: string;
  MATCH_POSSIBLE?: string;
  AI_DAILY_LIMIT?: string;
  AI_DAILY_REINDEX_LIMIT?: string;
  PUBLIC_CHECK_DAILY_LIMIT?: string;

  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  NOTIFY_EMAILS?: string;
  PUBLIC_OFFER_DAILY_LIMIT?: string;
}

export interface Config {
  authMode: "access" | "dev";
  devUserEmail: string;
  accessTeamDomain: string;
  accessAud: string;
  allowedEmails: string[];
  adminEmails: string[];
  serviceTokenIds: string[];
  aiProvider: "gemini" | "mock";
  geminiApiKey: string;
  embeddingModel: string;
  embeddingDims: number;
  describeModel: string;
  /** DESCRIBE_MODEL is a comma-separated fallback list; the first is preferred. */
  describeModels: string[];
  vectorBackend: "vectorize" | "d1-exact";
  matchStrong: number;
  matchPossible: number;
  aiDailyLimit: number;
  aiDailyReindexLimit: number;
  /** Guest "Do we have this one?" checks per UTC day, across all visitors. */
  publicCheckDailyLimit: number;
  /** "none" until a provider is connected; emails are then handed to the collector to send himself. */
  emailProvider: "resend" | "none";
  resendApiKey: string;
  emailFrom: string;
  emailReplyTo: string;
  /** Who hears about new koozie offers; defaults to the admins. */
  notifyEmails: string[];
  /** Koozie offers from the public form per UTC day, across all visitors. */
  publicOfferDailyLimit: number;
}

const list = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
};

export function getConfig(env: Env): Config {
  const dims = num(env.EMBEDDING_DIMS, 768);
  const describeModels = (env.DESCRIBE_MODEL || "gemini-3.5-flash-lite")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    // Anything other than the literal "dev" means production auth.
    authMode: env.AUTH_MODE === "dev" ? "dev" : "access",
    devUserEmail: env.DEV_USER_EMAIL || "dev@localhost",
    accessTeamDomain: (env.ACCESS_TEAM_DOMAIN ?? "").replace(/\/+$/, ""),
    accessAud: env.ACCESS_AUD ?? "",
    allowedEmails: list(env.ALLOWED_EMAILS),
    adminEmails: list(env.ADMIN_EMAILS),
    serviceTokenIds: list(env.SERVICE_TOKEN_CLIENT_IDS),
    aiProvider: env.AI_PROVIDER === "mock" ? "mock" : "gemini",
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    embeddingModel: env.EMBEDDING_MODEL || "gemini-embedding-2",
    embeddingDims: dims,
    describeModel: describeModels[0],
    describeModels,
    vectorBackend: env.VECTOR_BACKEND === "d1-exact" ? "d1-exact" : "vectorize",
    matchStrong: num(env.MATCH_STRONG, 0.9),
    matchPossible: num(env.MATCH_POSSIBLE, 0.8),
    aiDailyLimit: num(env.AI_DAILY_LIMIT, 300),
    aiDailyReindexLimit: num(env.AI_DAILY_REINDEX_LIMIT, 3000),
    publicCheckDailyLimit: num(env.PUBLIC_CHECK_DAILY_LIMIT, 200),
    emailProvider: env.EMAIL_PROVIDER === "resend" && env.RESEND_API_KEY ? "resend" : "none",
    resendApiKey: env.RESEND_API_KEY ?? "",
    emailFrom: env.EMAIL_FROM || "Bobby at KoozID <bobby@koozid.com>",
    emailReplyTo: (env.EMAIL_REPLY_TO ?? "").trim(),
    notifyEmails: list(env.NOTIFY_EMAILS).length ? list(env.NOTIFY_EMAILS) : list(env.ADMIN_EMAILS),
    publicOfferDailyLimit: num(env.PUBLIC_OFFER_DAILY_LIMIT, 100),
  };
}

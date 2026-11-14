import type { ApiErrorBody } from "../shared/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const forbidden = (message = "Forbidden") => new HttpError(403, "forbidden", message);
export const unauthorized = (message = "Sign-in required") => new HttpError(401, "unauthorized", message);

/** Raised by AI providers. Callers decide whether it is fatal (usually not). */
export class AiError extends Error {
  constructor(
    message: string,
    // rate_limited: the provider asked us to slow down (retry soon). quota: our own daily cap.
    public kind: "unavailable" | "rate_limited" | "quota" | "failed" = "failed",
    /** Worth retrying, possibly with another model: overloaded (5xx), rate-limited (429) or timed out. */
    public retryable = false,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

// Claude Code's reply access-failure detector. A leaf plugin: it implements
// the shared ReplyFailureDetector interface and knows nothing about other
// harnesses.
//
// Claude surfaces a turn-ending API error via its `StopFailure` hook, whose
// `error` field is a DISCRETE TYPE — one of a fixed enum the harness itself
// classifies (authentication_failed, billing_error, rate_limit, ...). So this
// detector does no string scanning at all: it reads that type and keeps only
// the access/entitlement failures. Transient types the operator cannot fix by
// re-authenticating (rate_limit, overloaded, server_error, ...) are excluded.

import type { ReplyFailureDetector } from "../detector.js";
import type { ReplyFailureHit, ReplyFailureSignal } from "../types.js";

/** Claude `StopFailure.error` types that mean the seat's ACCESS or
 *  ENTITLEMENT is dead — an operator must re-auth, fix billing, or restore
 *  org access before the seat can work again. Only these flag a seat. */
const ACCESS_ERROR_TYPES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
]);

export const claudeReplyFailureDetector: ReplyFailureDetector = {
  runtime: "claude-code",
  inspect(signal) {
    return inspectClaude(signal);
  },
};

function inspectClaude(signal: ReplyFailureSignal): ReplyFailureHit | null {
  const errorType = signal.errorType?.trim();
  if (!errorType || !ACCESS_ERROR_TYPES.has(errorType)) return null;

  // Detail maps the discrete type to an operator-actionable reason. The raw
  // type rides as evidence; errorDetails (when Claude supplies it) is folded
  // in so the operator sees the harness's own wording too.
  const evidence = signal.errorDetails?.trim()
    ? `${errorType}: ${signal.errorDetails.trim()}`
    : errorType;

  return {
    detail: ACCESS_FAILURE_DETAIL[errorType] ?? `Claude model reply failed: ${errorType}.`,
    evidence,
  };
}

const ACCESS_FAILURE_DETAIL: Record<string, string> = {
  authentication_failed:
    "Claude authentication failed — the token is invalid or the seat is not logged in.",
  oauth_org_not_allowed:
    "Claude rejected the request: this organisation is not allowed. Restore org access.",
  billing_error:
    "Claude billing error — the account has no valid subscription or payment method.",
};

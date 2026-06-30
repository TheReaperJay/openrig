// Pi's reply access-failure detector. A leaf plugin: it implements the shared
// ReplyFailureDetector interface and knows nothing about other harnesses.
//
// Pi surfaces a provider error via its `after_provider_response` event, whose
// `status` field is the raw HTTP status integer (401, 403, 429, 500, ...). So
// this detector does no string scanning: it reads that integer and keeps only
// the access failures (401/403). Transient errors the operator cannot fix by
// re-authenticating (429 rate limit, 5xx server faults) are excluded.

import type { ReplyFailureDetector } from "../detector.js";
import type { ReplyFailureHit, ReplyFailureSignal } from "../types.js";

export const piReplyFailureDetector: ReplyFailureDetector = {
  runtime: "pi-coding-agent",
  inspect(signal) {
    return inspectPi(signal);
  },
};

function inspectPi(signal: ReplyFailureSignal): ReplyFailureHit | null {
  const status = signal.httpStatus;
  // Only access/entitlement failures flag a seat. 401 = not authenticated,
  // 403 = authenticated but forbidden (no entitlement). A 429 (rate limit) or
  // any 5xx is transient and returns null — the operator cannot fix it by
  // re-authenticating, so the seat must not be marked attention_required.
  if (status !== 401 && status !== 403) return null;

  return {
    detail:
      status === 401
        ? "Pi provider call failed with 401 — the API key is invalid or missing."
        : "Pi provider call failed with 403 — the key lacks permission for this resource.",
    evidence: String(status),
  };
}

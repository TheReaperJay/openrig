// Result of scanning a captured model reply for an access failure.
//
// A login-status probe answers "am I logged in?" before the harness launches.
// This type answers the orthogonal question that only surfaces on the first
// real model call: the account is logged in yet the call still fails — an
// expired token, a revoked device key, an account out of quota, no
// subscription, a 403. The status probe cannot see that; the reply can.
//
// The classification carries NO harness name on purpose. A rejected token is
// the same failure whether Claude, Codex, or Pi printed it. Which harness
// produced the reply only determines WHICH anchor strings a detector matches
// (that lives in the per-harness detector files); it is not a property of the
// failure. The human specifics live in `detail`; the exact matched text in
// `evidence`.

/** The structured failure payload a harness's turn-end hook forwards when a
 *  provider/model call ends in error. Each field maps to one runtime family's
 *  native hook — a detector inspects the field its harness populates and
 *  ignores the rest. A signal is only present when a failure actually
 *  occurred; a plain successful turn carries none of these. */
export interface ReplyFailureSignal {
  /** Claude `StopFailure.error` — a discrete type string (e.g.
   *  "authentication_failed", "rate_limit"). */
  errorType?: string;
  /** Claude `StopFailure.error_details` — free-text additional detail. */
  errorDetails?: string;
  /** Pi `after_provider_response.status` — the raw HTTP status integer
   *  (e.g. 401). */
  httpStatus?: number;
  /** Codex `Stop.last_assistant_message` (or Claude `StopFailure`'s rendered
   *  error text) — the only string a detector must scan. */
  lastAssistantMessage?: string;
}

export interface ReplyFailureHit {
  /** Human-readable classification. Flows into the seat's attention-required
   *  signal so the operator sees why the seat needs action. */
  detail: string;
  /** The exact matched substring(s) / signal value, surfaced verbatim as the
   *  operator-visible evidence line. */
  evidence: string;
}

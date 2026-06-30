// Codex's reply access-failure detector. A leaf plugin implementing the shared
// ReplyFailureDetector interface; it knows nothing about other harnesses.
//
// Unlike Claude (discrete errorType) and Pi (raw httpStatus), Codex exposes NO
// structured error field on a turn-end failure: its `Stop` hook carries only
// `last_assistant_message` (the rendered reply text). So Codex is the one
// runtime where detection must string-scan — over the signal field, never a
// scraped pane. The primary signal is the access-token-refresh refusal, caught
// by the shared `looksLikeCodexAuthRefusal` two-anchor rule (the access-token
// phrase AND a sign-in-again instruction). Each remaining matcher is anchored
// so a benign reply that merely contains the token "401" cannot trip.

import type { ReplyFailureDetector } from "../detector.js";
import type { ReplyFailureHit, ReplyFailureSignal } from "../types.js";
import { looksLikeCodexAuthRefusal } from "../../native-resume-probe.js";

export const codexReplyFailureDetector: ReplyFailureDetector = {
  runtime: "codex",
  inspect(signal) {
    return inspectCodex(signal);
  },
};

function inspectCodex(signal: ReplyFailureSignal): ReplyFailureHit | null {
  const text = signal.lastAssistantMessage ?? "";
  if (!text) return null;

  // Access-token refresh refusal — two-anchored by looksLikeCodexAuthRefusal.
  if (looksLikeCodexAuthRefusal(text)) {
    return {
      detail: "Codex could not refresh the stored access token; sign in again before continuing.",
      evidence: "access token could not be refreshed",
    };
  }

  // Token-invalidated / auth-error frame — an auth noun AND an error marker
  // must both appear, so a reply discussing tokens in prose does not trip.
  if (/token(?:\s|_|-)?invalid/i.test(text) && /\b(?:401|error|expired|revoked|denied)\b/i.test(text)) {
    return {
      detail: "Codex reply indicates the access token is invalid or expired.",
      evidence: firstMatch(text, /token(?:\s|_|-)?invalid[^\n]*/i) ?? "token_invalidated",
    };
  }

  return null;
}

/** Return the first regex match as a string, or null. */
function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? (m[0] ?? null) : null;
}

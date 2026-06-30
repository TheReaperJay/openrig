// Claude reply-failure detector. Claude surfaces a turn-ending API error via
// its StopFailure hook's discrete `error` type, so this detector reads
// `signal.errorType` directly — no string scanning. Fixtures cover the access /
// entitlement types (which flag a seat) and the transient types (which must
// NOT, since an operator cannot fix them by re-authenticating).

import { describe, it, expect } from "vitest";
import { claudeReplyFailureDetector } from "../src/domain/reply-failure/detectors/claude.js";
import type { ReplyFailureSignal } from "../src/domain/reply-failure/types.js";

describe("claudeReplyFailureDetector", () => {
  const det = claudeReplyFailureDetector;

  const sig = (errorType: string, errorDetails?: string): ReplyFailureSignal =>
    errorDetails ? { errorType, errorDetails } : { errorType };

  it("runtime is claude-code", () => {
    expect(det.runtime).toBe("claude-code");
  });

  // --- positives: access / entitlement error types flag the seat ---

  it("hits on authentication_failed", () => {
    const hit = det.inspect(sig("authentication_failed"));
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/authentication failed/i);
    expect(hit!.evidence).toBe("authentication_failed");
  });

  it("hits on oauth_org_not_allowed", () => {
    const hit = det.inspect(sig("oauth_org_not_allowed"));
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/organisation is not allowed/i);
  });

  it("hits on billing_error", () => {
    const hit = det.inspect(sig("billing_error"));
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/billing/i);
  });

  it("folds errorDetails into the evidence when supplied", () => {
    const hit = det.inspect(sig("authentication_failed", "Invalid API key"));
    expect(hit).not.toBeNull();
    expect(hit!.evidence).toBe("authentication_failed: Invalid API key");
  });

  // --- negatives: transient types the operator cannot fix by re-auth ---

  it("does not hit on rate_limit (transient)", () => {
    expect(det.inspect(sig("rate_limit"))).toBeNull();
  });

  it("does not hit on overloaded (transient)", () => {
    expect(det.inspect(sig("overloaded"))).toBeNull();
  });

  it("does not hit on server_error (transient)", () => {
    expect(det.inspect(sig("server_error"))).toBeNull();
  });

  it("does not hit on invalid_request (transient)", () => {
    expect(det.inspect(sig("invalid_request"))).toBeNull();
  });

  it("does not hit on an unrecognised type", () => {
    expect(det.inspect(sig("something_else"))).toBeNull();
  });

  // --- guards ---

  it("returns null on an empty errorType", () => {
    expect(det.inspect(sig(""))).toBeNull();
    expect(det.inspect(sig("   "))).toBeNull();
  });

  it("returns null on a signal with no errorType", () => {
    expect(det.inspect({ httpStatus: 401 })).toBeNull();
  });
});

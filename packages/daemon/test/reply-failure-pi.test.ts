// Pi reply-failure detector. Pi surfaces a provider error via its
// `after_provider_response` event's `status` integer, so this detector reads
// `signal.httpStatus` directly — no string scanning. Fixtures cover the access
// failures (401/403, which flag a seat) and the transient errors (429/5xx,
// which must NOT, since an operator cannot fix them by re-authenticating).

import { describe, it, expect } from "vitest";
import { piReplyFailureDetector } from "../src/domain/reply-failure/detectors/pi.js";
import type { ReplyFailureSignal } from "../src/domain/reply-failure/types.js";

describe("piReplyFailureDetector", () => {
  const det = piReplyFailureDetector;

  const sig = (httpStatus: number): ReplyFailureSignal => ({ httpStatus });

  it("runtime is pi-coding-agent", () => {
    expect(det.runtime).toBe("pi-coding-agent");
  });

  // --- positives: access failures flag the seat ---

  it("hits on 401", () => {
    const hit = det.inspect(sig(401));
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/401/);
    expect(hit!.evidence).toBe("401");
  });

  it("hits on 403", () => {
    const hit = det.inspect(sig(403));
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/403/);
  });

  // --- negatives: transient errors the operator cannot fix by re-auth ---

  it("does not hit on 429 (rate limit, transient)", () => {
    expect(det.inspect(sig(429))).toBeNull();
  });

  it("does not hit on 500 (server error, transient)", () => {
    expect(det.inspect(sig(500))).toBeNull();
  });

  it("does not hit on 503 (transient)", () => {
    expect(det.inspect(sig(503))).toBeNull();
  });

  it("does not hit on 200 (success)", () => {
    expect(det.inspect(sig(200))).toBeNull();
  });

  // --- guards ---

  it("returns null when httpStatus is absent", () => {
    expect(det.inspect({ errorType: "authentication_failed" })).toBeNull();
  });
});

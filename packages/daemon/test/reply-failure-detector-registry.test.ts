// ReplyFailureDetectorRegistry — dispatch is a map lookup, not a switch. These
// tests pin the closed-core contract: register/inspect, unknown runtime ⇒ null,
// null/empty signal ⇒ null, and last-write-wins on a duplicate registration.

import { describe, it, expect } from "vitest";
import { ReplyFailureDetectorRegistry } from "../src/domain/reply-failure/detector.js";
import type { ReplyFailureDetector } from "../src/domain/reply-failure/detector.js";
import { claudeReplyFailureDetector } from "../src/domain/reply-failure/detectors/claude.js";
import { codexReplyFailureDetector } from "../src/domain/reply-failure/detectors/codex.js";
import { piReplyFailureDetector } from "../src/domain/reply-failure/detectors/pi.js";
import type { ReplyFailureSignal } from "../src/domain/reply-failure/types.js";

describe("ReplyFailureDetectorRegistry", () => {
  function registryWithAll(): ReplyFailureDetectorRegistry {
    const r = new ReplyFailureDetectorRegistry();
    r.register(claudeReplyFailureDetector);
    r.register(codexReplyFailureDetector);
    r.register(piReplyFailureDetector);
    return r;
  }

  it("dispatches to the registered detector by runtime (claude)", () => {
    const r = registryWithAll();
    const hit = r.inspect("claude-code", { errorType: "authentication_failed" });
    expect(hit).not.toBeNull();
    expect(hit!.evidence).toBe("authentication_failed");
  });

  it("dispatches to the registered detector by runtime (codex)", () => {
    const r = registryWithAll();
    const hit = r.inspect(
      "codex",
      { lastAssistantMessage: "Your access token could not be refreshed. Please log out and sign in again." },
    );
    expect(hit).not.toBeNull();
    expect(hit!.evidence).toBe("access token could not be refreshed");
  });

  it("dispatches to the registered detector by runtime (pi)", () => {
    const r = registryWithAll();
    const hit = r.inspect("pi-coding-agent", { httpStatus: 401 });
    expect(hit).not.toBeNull();
    expect(hit!.evidence).toBe("401");
  });

  it("returns null for an unregistered runtime", () => {
    const r = registryWithAll();
    expect(r.inspect("acme-agent", { errorType: "authentication_failed" })).toBeNull();
  });

  it("returns null for a null/empty runtime", () => {
    const r = registryWithAll();
    const signal: ReplyFailureSignal = { errorType: "authentication_failed" };
    expect(r.inspect(null, signal)).toBeNull();
    expect(r.inspect(undefined, signal)).toBeNull();
    expect(r.inspect("", signal)).toBeNull();
  });

  it("returns null for a null signal", () => {
    const r = registryWithAll();
    expect(r.inspect("claude-code", null)).toBeNull();
    expect(r.inspect("claude-code", undefined)).toBeNull();
  });

  it("returns null when a benign signal yields no hit", () => {
    const r = registryWithAll();
    // rate_limit is a transient type — not an access failure.
    expect(r.inspect("claude-code", { errorType: "rate_limit" })).toBeNull();
    // 429 is transient.
    expect(r.inspect("pi-coding-agent", { httpStatus: 429 })).toBeNull();
  });

  it("last write wins on a duplicate runtime registration", () => {
    const r = new ReplyFailureDetectorRegistry();
    const always: ReplyFailureDetector = {
      runtime: "claude-code",
      inspect: () => ({ detail: "second", evidence: "second" }),
    };
    r.register(claudeReplyFailureDetector);
    r.register(always); // replaces
    const hit = r.inspect("claude-code", { errorType: "authentication_failed" });
    expect(hit).not.toBeNull();
    expect(hit!.evidence).toBe("second");
  });
});

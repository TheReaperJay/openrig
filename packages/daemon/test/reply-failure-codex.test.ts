// Codex reply-failure detector. Codex exposes no structured error field — its
// Stop hook carries only `last_assistant_message` — so this is the one runtime
// whose detector string-scans, over `signal.lastAssistantMessage` (never a
// scraped pane). Fixtures cover the access-token-refresh refusal (the primary
// two-anchor signal) and the benign-reply guards.

import { describe, it, expect } from "vitest";
import { codexReplyFailureDetector } from "../src/domain/reply-failure/detectors/codex.js";
import type { ReplyFailureSignal } from "../src/domain/reply-failure/types.js";

describe("codexReplyFailureDetector", () => {
  const det = codexReplyFailureDetector;

  const sig = (lastAssistantMessage: string): ReplyFailureSignal => ({ lastAssistantMessage });

  it("runtime is codex", () => {
    expect(det.runtime).toBe("codex");
  });

  // --- positives ---

  it("hits on the access-token-refresh refusal (two-anchor)", () => {
    const hit = det.inspect(
      sig("Your access token could not be refreshed because you have since logged out. Please sign in again."),
    );
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/refresh the stored access token/i);
    expect(hit!.evidence).toBe("access token could not be refreshed");
  });

  it("hits on the alternate sign-in-again phrasing", () => {
    const hit = det.inspect(sig("Your access token could not be refreshed. Please log out and sign in again."));
    expect(hit).not.toBeNull();
    expect(hit!.evidence).toBe("access token could not be refreshed");
  });

  it("hits on a token-invalidated frame", () => {
    const hit = det.inspect(sig("The token_invalidated error occurred: 401"));
    expect(hit).not.toBeNull();
    expect(hit!.detail).toMatch(/invalid or expired/i);
  });

  // --- negatives: benign text must not trip ---

  it("does not hit on a clean reply", () => {
    expect(det.inspect(sig("Done. I refactored the auth module and added a token cache."))).toBeNull();
  });

  it("does not hit on a bare '401' in explanatory prose", () => {
    expect(det.inspect(sig("HTTP 401 is the unauthorized status code."))).toBeNull();
  });

  it("does not hit on 'access token' without the refusal + sign-in pair", () => {
    expect(det.inspect(sig("We store the access token in the keychain."))).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(det.inspect(sig(""))).toBeNull();
  });

  it("returns null when lastAssistantMessage is absent", () => {
    expect(det.inspect({ errorType: "authentication_failed" })).toBeNull();
  });
});

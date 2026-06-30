// The plugin contract for reply access-failure detection, plus the registry
// that dispatches to it. Built Open/Closed: the interface and registry below
// are CLOSED — adding a harness edits neither. One detector file per harness
// is the OPEN set; adding a harness is a new detector file plus a single
// register() call at composition. There is no `if (runtime === …)` switch
// anywhere in detection — dispatch is a map lookup.
//
// Detection reads each harness's NATIVE turn-end failure payload (a
// ReplyFailureSignal), never a scraped pane. Each runtime populates a
// different field of that signal — Claude an `errorType`, Pi an `httpStatus`,
// Codex a `lastAssistantMessage` string — and each detector inspects the one
// its harness fills. This mirrors how runtime adapters are already wired in
// this codebase: a `RuntimeAdapter` interface implemented per harness, held in
// a map keyed by runtime name, and consumed by map lookup rather than by
// branching.

import type { ReplyFailureHit, ReplyFailureSignal } from "./types.js";

/**
 * One harness's access-failure detection strategy. Implement one per harness
 * in `detectors/<runtime>.ts` and register it with the registry. Each
 * implementation is a leaf: it imports only this interface and the shared
 * types, and knows nothing about the other harnesses.
 */
export interface ReplyFailureDetector {
  /** The runtime name this detector handles (e.g. "claude-code"). */
  readonly runtime: string;
  /** Inspect this harness's native failure signal for an access/entitlement
   *  failure. Returns the hit, or null when the signal is benign or absent
   *  (a transient rate_limit / overloaded / 4xx-5xx that an operator cannot
   *  fix by re-authenticating is NOT an access failure and returns null). */
  inspect(signal: ReplyFailureSignal): ReplyFailureHit | null;
}

/**
 * Holds the registered detectors and dispatches by runtime name. This is the
 * ONLY dispatch in reply-failure detection. Adding a harness never grows a
 * branch here — it only adds a register() call at composition time. inspect()
 * returns null for a runtime with no registered detector or for a missing
 * signal, so a benign or unrecognised reply never produces a false hit.
 */
export class ReplyFailureDetectorRegistry {
  private readonly detectors = new Map<string, ReplyFailureDetector>();

  /** Register (or replace) the detector for its runtime. Last write wins. */
  register(detector: ReplyFailureDetector): void {
    this.detectors.set(detector.runtime, detector);
  }

  /** Look up the detector for `runtime` and inspect `signal`. Returns null
   *  when the runtime is unregistered, the signal is null, or the signal has
   *  no field the detector would inspect. */
  inspect(
    runtime: string | null | undefined,
    signal: ReplyFailureSignal | null | undefined,
  ): ReplyFailureHit | null {
    if (!runtime || !signal) return null;
    const detector = this.detectors.get(runtime);
    return detector ? detector.inspect(signal) : null;
  }
}

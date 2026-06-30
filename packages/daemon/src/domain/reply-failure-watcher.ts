import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { SeatStatusStateMachine } from "./seat-status-state-machine.js";
import { SessionRegistry } from "./session-registry.js";
import type { ReplyFailureDetectorRegistry } from "./reply-failure/detector.js";
import type { ReplyFailureSignal } from "./reply-failure/types.js";

/**
 * Flags a managed seat the instant a turn-end hook forwards an access/
 * entitlement failure. It reads the structured failure signal off each
 * `agent.activity` event, asks the per-runtime detector registry whether
 * that signal is an access failure, and — only on a hit — PROPOSES a
 * `reply_failure` transition to the single `SeatStatusStateMachine`. It
 * never writes `startup_status` itself.
 *
 * This is the per-message half of access-failure detection, and it is
 * purely event-driven: it owns no timer, captures no tmux pane, and never
 * sleeps. The signal is already on the event (each harness's turn-end
 * hook forwards its native failure field — Claude `errorType`, Pi
 * `httpStatus`, Codex `lastAssistantMessage` — via the activity relay).
 * A transient failure (rate_limit / overloaded / 429 / 5xx) is not an
 * access failure, so the detector returns null and the watcher no-ops —
 * an operator cannot fix those by re-authenticating, and the seat must
 * not be marked attention_required.
 *
 * Mirrors `StartupStatusSelfHealer`: subscribe on start(), unsubscribe on
 * stop(), resolve the node's latest session, best-effort (never propagates).
 */
export class ReplyFailureWatcher {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly detectors: ReplyFailureDetectorRegistry;
  private readonly stateMachine: SeatStatusStateMachine;
  private unsub?: () => void;

  constructor(deps: {
    db: Database.Database;
    eventBus: EventBus;
    detectors: ReplyFailureDetectorRegistry;
    stateMachine?: SeatStatusStateMachine;
  }) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.detectors = deps.detectors;
    this.stateMachine =
      deps.stateMachine ??
      new SeatStatusStateMachine({
        db: deps.db,
        sessionRegistry: new SessionRegistry(deps.db),
        eventBus: deps.eventBus,
      });
  }

  /** Register the subscriber. Idempotent. */
  start(): void {
    if (this.unsub) return;
    this.unsub = this.eventBus.subscribe((event) => {
      if (event.type !== "agent.activity") return;
      const signal = event.activity?.replyFailureSignal;
      if (!signal) return; // no failure signal on this event → nothing to inspect
      this.onSignal(event.nodeId, event.runtime, signal);
    });
  }

  /** Unregister. Safe to call before start or multiple times. */
  stop(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  /**
   * Inspect the signal and, on an access-failure hit, propose a
   * `reply_failure` transition for the node's latest session. The state
   * machine's declared table decides whether to apply (pending|ready →
   * attention_required) and is the only writer of `startup_status`; a
   * re-hit on an already-attention seat is an idempotent no-op in the table.
   */
  private onSignal(
    nodeId: string | null | undefined,
    runtime: string | null | undefined,
    signal: ReplyFailureSignal,
  ): void {
    try {
      if (!nodeId) return;
      const hit = this.detectors.inspect(runtime, signal);
      if (!hit) return; // transient error or benign signal → not an access failure
      const row = this.db
        .prepare(
          `SELECT s.id AS sid
           FROM sessions s
           JOIN nodes n ON n.id = s.node_id
           WHERE n.id = ?
           ORDER BY s.id DESC
           LIMIT 1`,
        )
        .get(nodeId) as { sid: string } | undefined;
      if (!row) return;
      this.stateMachine.transition(row.sid, {
        kind: "reply_failure",
        detail: hit.detail,
      });
    } catch {
      // Best-effort detection only; never propagate.
    }
  }
}

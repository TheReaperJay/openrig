import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { SeatStatusStateMachine } from "./seat-status-state-machine.js";
import { SessionRegistry } from "./session-registry.js";

/**
 * Self-heals stuck seats via the terminal's NATIVE lifecycle events.
 *
 * Replaces the old `ContextMonitor.normalizeStartupStatus` 30s readiness poll.
 * A managed agent seat that is stuck in `failed` or `attention_required` is
 * promoted back to `ready` the INSTANT it emits a lifecycle hook — because a
 * hook arriving proves the harness booted and loaded the mandatory telemetry
 * plugin past any boot-time gate. Event-driven, not polled; covers every
 * runtime (claude/codex/pi), unlike the old runtime-keyed readiness-checker
 * map which never registered pi.
 *
 * Scheduler-free: it owns no timer. It subscribes once on start() and
 * unsubscribes on stop(). Lives here (not in ContextMonitor) so
 * ContextMonitor stays focused on context-window telemetry acquisition.
 *
 * This module PROPOSES transitions to the single `SeatStatusStateMachine`; it
 * does not write `startup_status` itself. The machine's declared table rejects
 * the proposal unless the seat is `failed`/`attention_required`, reproducing
 * this healer's pre-refactor guard. The promote emits no event (the table maps
 * `positive_activity → ready` with a null event), preserving the prior silent
 * behavior.
 */
export class StartupStatusSelfHealer {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly stateMachine: SeatStatusStateMachine;
  private unsub?: () => void;

  constructor(db: Database.Database, eventBus: EventBus, stateMachine?: SeatStatusStateMachine) {
    this.db = db;
    this.eventBus = eventBus;
    this.stateMachine = stateMachine ?? new SeatStatusStateMachine({ db, sessionRegistry: new SessionRegistry(db), eventBus });
  }

  /** Register the subscriber. Idempotent. */
  start(): void {
    if (this.unsub) return;
    this.unsub = this.eventBus.subscribe((event) => {
      if (event.type !== "agent.activity") return;
      const nodeId = event.nodeId;
    if (!nodeId) return;
      this.maybePromote(nodeId);
    });
  }

  /** Unregister. Safe to call before start or multiple times. */
  stop(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  /**
   * Propose a `positive_activity` transition for the node's latest session.
   * The state machine applies it only if the seat is `failed`/
   * `attention_required` (the table rejects otherwise), so a hook landing on
   * an already-ready seat is a no-op — matching the prior guard.
   */
  private maybePromote(nodeId: string): void {
    try {
      const row = this.db.prepare(
        `SELECT s.id AS sid
         FROM sessions s
         JOIN nodes n ON n.id = s.node_id
         WHERE n.id = ?
         ORDER BY s.id DESC
         LIMIT 1`,
      ).get(nodeId) as { sid: string } | undefined;
      if (!row) return;
      this.stateMachine.transition(row.sid, { kind: "positive_activity" });
    } catch {
      // Best-effort self-heal only; never propagate.
    }
  }
}
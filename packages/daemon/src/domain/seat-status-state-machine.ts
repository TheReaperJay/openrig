// SeatStatusStateMachine — the SINGLE owner/writer of `sessions.startup_status`
// and the SINGLE emitter of the `startup_*` / `seat.attention_cleared` transitions.
//
// Every detector that wants to move a seat's startup status PROPOSES a transition
// via `transition(sessionId, evidence)`. This module is the only domain code that
// applies a declared `(from × evidence → to)` table, writes the column, and emits
// the mapped event. It replaces the prior multi-writer smell where
// StartupOrchestrator, StartupStatusSelfHealer, and SeatAttentionReconciler each
// called `sessionRegistry.updateStartupStatus` directly with their own ad-hoc
// guards. There is no race to reconcile because there is one writer; idempotent
// no-ops fall out of the table (e.g. attention_required + reply_failure →
// attention_required applies nothing, emits nothing — added in a later slice).
//
// The table is behavior-preserving vs. the pre-refactor writers:
//   • Orchestrator lifecycle (launch_started / boot_completed_clean / launch_failed
//     / launch_attention) is AUTHORITATIVE: it applies regardless of `from`
//     (the orchestrator owns the launch lifecycle and never raced with itself).
//     launch_attention emits its own `node.startup_attention_required` event
//     (distinct from launch_failed's `node.startup_failed`) so attention seats
//     carry a dedicated signal the reconciler and #3 detector both read.
//   • Recovery (positive_activity / operator_attestation / evidence_clear) is
//     GUARDED: it only applies from `failed` | `attention_required`, mirroring
//     the self-healer's and reconciler's pre-refactor guards.
//
// `startup_completed_at` is set exactly when `to === "ready"`, matching every
// prior writer (orchestrator success, self-healer promote, reconciler clear all
// set it; pending/failed/attention_required never did).

import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { RigEvent } from "./types.js";

export type SeatStatus = "pending" | "ready" | "attention_required" | "failed";

export type SeatEvidenceKind =
  // Orchestrator lifecycle (authoritative — applies from any state).
  | "launch_started" // step 1: → pending, emit node.startup_pending
  | "boot_completed_clean" // success: → ready, emit node.startup_ready
  | "launch_failed" // fail(failed): → failed, emit node.startup_failed
  | "launch_attention" // fail(attention_required): → attention_required, emit node.startup_attention_required
  // #3 — per-message reply access-failure (ReplyFailureWatcher + ContextMonitor backstop).
  // Applies from pending|ready → attention_required (the core #3 transition plus a
  // boot-time edge). Intentionally NOT declared for attention_required|failed: a
  // dead-access seat re-proposing on every Stop is an idempotent no-op (table
  // absence ⇒ reject ⇒ no write, no emit) — this is the single-owner fix for the
  // old #3-vs-self-healer race (R5 deleted, not mitigated).
  | "reply_failure" // a reply access-failure detector hit: → attention_required, emit node.startup_attention_required
  // Recovery (guarded — applies only from failed | attention_required).
  | "positive_activity" // self-healer: → ready, emit nothing
  | "operator_attestation" // reconciler --reason: → ready, emit seat.attention_cleared
  | "evidence_clear"; // reconciler evidence: → ready, emit seat.attention_cleared

export interface SeatEvidence {
  kind: SeatEvidenceKind;
  /** For launch_failed / launch_attention → node.startup_failed / node.startup_attention_required .error. */
  error?: string;
  /** For reply_failure → node.startup_attention_required .error (human-readable
   *  classification of the per-message access failure; used when `error` is
   *  absent so a reply_failure proposal lands the same way a launch_attention
   *  does). */
  detail?: string;
  /** For operator_attestation → seat.attention_cleared.reason. */
  reason?: string;
  /** For evidence_clear → seat.attention_cleared.evidence. */
  evidence?: { kind: string; state?: string; reason?: string };
  /** For seat.attention_cleared.previousError (reconciler-derived). */
  previousError?: string | null;
}

export interface TransitionOutcome {
  applied: boolean;
  eventEmitted: boolean;
  from: SeatStatus;
  to: SeatStatus;
}

interface ResolvedSeat {
  status: SeatStatus;
  sessionName: string;
  nodeId: string;
  rigId: string;
}

interface TransitionRule {
  to: SeatStatus;
  event: RigEvent["type"] | null;
}

// Authoritative kinds apply from ANY state. Recovery kinds apply only from
// failed | attention_required. Undefined entries reject (no write, no emit).
const TABLE: Record<SeatStatus, Partial<Record<SeatEvidenceKind, TransitionRule>>> = {
  pending: {
    launch_started: { to: "pending", event: "node.startup_pending" },
    boot_completed_clean: { to: "ready", event: "node.startup_ready" },
    launch_failed: { to: "failed", event: "node.startup_failed" },
    launch_attention: { to: "attention_required", event: "node.startup_attention_required" },
    // Boot-time reply access-failure (edge): a model reply that dies with an
    // auth/entitlement error before boot is confirmed still needs attention.
    reply_failure: { to: "attention_required", event: "node.startup_attention_required" },
  },
  ready: {
    // Orchestrator lifecycle is authoritative; allow re-launch / re-ready from ready.
    launch_started: { to: "pending", event: "node.startup_pending" },
    boot_completed_clean: { to: "ready", event: "node.startup_ready" },
    launch_failed: { to: "failed", event: "node.startup_failed" },
    launch_attention: { to: "attention_required", event: "node.startup_attention_required" },
    // ◀ #3 CORE: a ready seat whose model reply surfaced an access failure
    // (expired token, out of quota, revoked) becomes attention_required so the
    // operator can re-auth. Proposed by the ReplyFailureWatcher on every Stop.
    reply_failure: { to: "attention_required", event: "node.startup_attention_required" },
  },
  failed: {
    positive_activity: { to: "ready", event: null },
    operator_attestation: { to: "ready", event: "seat.attention_cleared" },
    evidence_clear: { to: "ready", event: "seat.attention_cleared" },
    // Orchestrator can re-launch a failed seat (fresh fallback / restore).
    launch_started: { to: "pending", event: "node.startup_pending" },
    boot_completed_clean: { to: "ready", event: "node.startup_ready" },
    launch_failed: { to: "failed", event: "node.startup_failed" },
    launch_attention: { to: "attention_required", event: "node.startup_attention_required" },
  },
  attention_required: {
    positive_activity: { to: "ready", event: null },
    operator_attestation: { to: "ready", event: "seat.attention_cleared" },
    evidence_clear: { to: "ready", event: "seat.attention_cleared" },
    launch_started: { to: "pending", event: "node.startup_pending" },
    boot_completed_clean: { to: "ready", event: "node.startup_ready" },
    launch_failed: { to: "failed", event: "node.startup_failed" },
    launch_attention: { to: "attention_required", event: "node.startup_attention_required" },
  },
};

export interface SeatStatusStateMachineDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
}

export class SeatStatusStateMachine {
  readonly db: Database.Database;
  private readonly sessionRegistry: SessionRegistry;
  private readonly eventBus: EventBus;

  constructor(deps: SeatStatusStateMachineDeps) {
    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
  }

  /**
   * Propose a startup-status transition for `sessionId`. The declared table is
   * the authority: it decides whether to apply, what to write, and what to emit.
   * Returns the outcome (whether a transition was applied, and from→to).
   */
  transition(sessionId: string, evidence: SeatEvidence): TransitionOutcome {
    const seat = this.resolveSeat(sessionId);
    if (!seat) {
      return { applied: false, eventEmitted: false, from: "pending", to: "pending" };
    }
    const rule = TABLE[seat.status]?.[evidence.kind];
    if (!rule) {
      return { applied: false, eventEmitted: false, from: seat.status, to: seat.status };
    }
    const from = seat.status;
    const to = rule.to;

    // Write the column. Set startup_completed_at only when landing on `ready`
    // (matches every prior writer: success/promote/clear set it; pending/
    // failed/attention_required never did).
    const completedAt = to === "ready" ? new Date().toISOString() : undefined;
    this.sessionRegistry.updateStartupStatus(sessionId, to, completedAt);

    // Emit the mapped event (null rule.event → no emit, e.g. self-healer promote).
    let eventEmitted = false;
    if (rule.event) {
      this.eventBus.emit(this.buildEvent(rule.event, from, to, seat, evidence));
      eventEmitted = true;
    }

    return { applied: true, eventEmitted, from, to };
  }

  /** Read the current status + identity for a session, or null if absent. */
  getStartupStatus(sessionId: string): SeatStatus | null {
    const seat = this.resolveSeat(sessionId);
    return seat ? seat.status : null;
  }

  private resolveSeat(sessionId: string): ResolvedSeat | null {
    const row = this.db
      .prepare(
        `SELECT s.startup_status AS status, s.session_name AS session_name,
                n.id AS node_id, n.rig_id AS rig_id
         FROM sessions s
         JOIN nodes n ON n.id = s.node_id
         WHERE s.id = ?`
      )
      .get(sessionId) as
      | { status: string | null; session_name: string; node_id: string; rig_id: string }
      | undefined;
    if (!row) return null;
    return {
      status: (row.status as SeatStatus) ?? "pending",
      sessionName: row.session_name,
      nodeId: row.node_id,
      rigId: row.rig_id,
    };
  }

  private buildEvent(
    type: RigEvent["type"],
    from: SeatStatus,
    to: SeatStatus,
    seat: ResolvedSeat,
    evidence: SeatEvidence,
  ): RigEvent {
    if (type === "node.startup_pending") {
      return { type: "node.startup_pending", rigId: seat.rigId, nodeId: seat.nodeId };
    }
    if (type === "node.startup_ready") {
      return { type: "node.startup_ready", rigId: seat.rigId, nodeId: seat.nodeId };
    }
    if (type === "node.startup_failed") {
      return {
        type: "node.startup_failed",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        error: evidence.error ?? "",
      };
    }
    if (type === "node.startup_attention_required") {
      return {
        type: "node.startup_attention_required",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        // launch_attention carries `error`; reply_failure carries `detail`.
        error: evidence.error ?? evidence.detail ?? "",
      };
    }
    if (type === "seat.attention_cleared") {
      const clearedBy: "evidence" | "operator_attestation" =
        evidence.kind === "operator_attestation" ? "operator_attestation" : "evidence";
      return {
        type: "seat.attention_cleared",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: seat.sessionName,
        from,
        to: "ready",
        clearedBy,
        evidence: evidence.evidence,
        reason: evidence.reason,
        previousError: evidence.previousError ?? null,
      };
    }
    // Defensive — should be unreachable given the table's event set.
    return { type: "node.startup_ready", rigId: seat.rigId, nodeId: seat.nodeId };
  }
}
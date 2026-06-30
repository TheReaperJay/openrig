// SeatStatusStateMachine — unit tests for the single owner of startup_status.
// Covers every declared (from × evidence → to) cell, the recovery guards
// (reject from ready/pending), idempotency (no re-emit once cleared), the
// authoritative orchestrator tier (applies from any state), the
// startup_completed_at-on-ready rule, and the exact event payloads.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatStatusStateMachine } from "../src/domain/seat-status-state-machine.js";

type Emitted = { type: string; payload: any };

function emittedEvents(db: Database.Database, type: string): Emitted[] {
  const rows = db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as { payload: string }[];
  return rows.map((r) => ({ type, payload: JSON.parse(r.payload) }));
}

function startupStatus(db: Database.Database, sessionId: string): { status: string | null; completedAt: string | null } {
  const row = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(sessionId) as { startup_status: string | null; startup_completed_at: string | null };
  return { status: row.startup_status, completedAt: row.startup_completed_at };
}

describe("SeatStatusStateMachine", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let sm: SeatStatusStateMachine;
  let sessionId: string;
  let nodeId: string;
  let rigId: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    sm = new SeatStatusStateMachine({ db, sessionRegistry, eventBus });
    const rig = rigRepo.createRig("r1");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r1");
    sessionId = session.id;
    nodeId = node.id;
    rigId = rig.id;
  });

  afterEach(() => { db.close(); });

  function setStatus(status: "pending" | "ready" | "attention_required" | "failed") {
    sessionRegistry.updateStartupStatus(sessionId, status);
  }

  // --- Orchestrator lifecycle (authoritative — applies from any state) ---

  it("launch_started: pending → pending, emits node.startup_pending", () => {
    const out = sm.transition(sessionId, { kind: "launch_started" });
    expect(out).toMatchObject({ applied: true, eventEmitted: true, from: "pending", to: "pending" });
    const ev = emittedEvents(db, "node.startup_pending");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ rigId, nodeId });
    expect(startupStatus(db, sessionId).status).toBe("pending");
  });

  it("boot_completed_clean: pending → ready, emits node.startup_ready, sets startup_completed_at", () => {
    const out = sm.transition(sessionId, { kind: "boot_completed_clean" });
    expect(out).toMatchObject({ applied: true, eventEmitted: true, from: "pending", to: "ready" });
    expect(emittedEvents(db, "node.startup_ready")).toHaveLength(1);
    const { status, completedAt } = startupStatus(db, sessionId);
    expect(status).toBe("ready");
    expect(completedAt).not.toBeNull();
  });

  it("launch_failed: pending → failed, emits node.startup_failed with error", () => {
    const out = sm.transition(sessionId, { kind: "launch_failed", error: "projection blew up" });
    expect(out).toMatchObject({ applied: true, eventEmitted: true, from: "pending", to: "failed" });
    const ev = emittedEvents(db, "node.startup_failed");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ rigId, nodeId, error: "projection blew up" });
    expect(startupStatus(db, sessionId).status).toBe("failed");
    expect(startupStatus(db, sessionId).completedAt).toBeNull();
  });

  it("launch_attention: pending → attention_required, emits node.startup_attention_required (not startup_failed)", () => {
    const out = sm.transition(sessionId, { kind: "launch_attention", error: "codex auth-refusal" });
    expect(out).toMatchObject({ applied: true, eventEmitted: true, from: "pending", to: "attention_required" });
    const ev = emittedEvents(db, "node.startup_attention_required");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ rigId, nodeId, error: "codex auth-refusal" });
    // The split: a launch_attention must NOT overload onto node.startup_failed.
    expect(emittedEvents(db, "node.startup_failed")).toHaveLength(0);
    expect(startupStatus(db, sessionId).status).toBe("attention_required");
  });

  it("orchestrator tier is authoritative from failed/attention_required (re-launch path)", () => {
    setStatus("failed");
    const out = sm.transition(sessionId, { kind: "launch_started" });
    expect(out).toMatchObject({ applied: true, from: "failed", to: "pending" });
    expect(emittedEvents(db, "node.startup_pending")).toHaveLength(1);
    expect(startupStatus(db, sessionId).status).toBe("pending");
  });

  // --- Recovery tier (guarded — only from failed | attention_required) ---

  it("positive_activity: failed → ready, emits NOTHING, sets startup_completed_at", () => {
    setStatus("failed");
    const out = sm.transition(sessionId, { kind: "positive_activity" });
    expect(out).toMatchObject({ applied: true, eventEmitted: false, from: "failed", to: "ready" });
    expect(startupStatus(db, sessionId).status).toBe("ready");
    expect(startupStatus(db, sessionId).completedAt).not.toBeNull();
    // No startup_* event emitted at all on a promote.
    expect(emittedEvents(db, "node.startup_ready")).toHaveLength(0);
  });

  it("positive_activity: attention_required → ready, no event", () => {
    setStatus("attention_required");
    const out = sm.transition(sessionId, { kind: "positive_activity" });
    expect(out).toMatchObject({ applied: true, eventEmitted: false, from: "attention_required", to: "ready" });
  });

  it("positive_activity: ready → reject (guard, no write, no emit)", () => {
    setStatus("ready");
    const out = sm.transition(sessionId, { kind: "positive_activity" });
    expect(out).toMatchObject({ applied: false, eventEmitted: false, from: "ready", to: "ready" });
    expect(startupStatus(db, sessionId).status).toBe("ready");
  });

  it("positive_activity: pending → reject (guard)", () => {
    const out = sm.transition(sessionId, { kind: "positive_activity" });
    expect(out.applied).toBe(false);
    expect(startupStatus(db, sessionId).status).toBe("pending");
  });

  it("operator_attestation: attention_required → ready, emits seat.attention_cleared (operator_attestation, reason, previousError)", () => {
    setStatus("attention_required");
    const out = sm.transition(sessionId, { kind: "operator_attestation", reason: "founder re-authed", previousError: "401" });
    expect(out).toMatchObject({ applied: true, eventEmitted: true, from: "attention_required", to: "ready" });
    const ev = emittedEvents(db, "seat.attention_cleared");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({
      rigId, nodeId, sessionName: "worker@r1",
      from: "attention_required", to: "ready",
      clearedBy: "operator_attestation", reason: "founder re-authed", previousError: "401",
    });
  });

  it("operator_attestation: failed → ready, emits seat.attention_cleared", () => {
    setStatus("failed");
    const out = sm.transition(sessionId, { kind: "operator_attestation", reason: "ok" });
    expect(out).toMatchObject({ applied: true, from: "failed", to: "ready" });
    const ev = emittedEvents(db, "seat.attention_cleared");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.clearedBy).toBe("operator_attestation");
  });

  it("evidence_clear: attention_required → ready, emits seat.attention_cleared (evidence, clearedBy:evidence)", () => {
    setStatus("attention_required");
    const out = sm.transition(sessionId, {
      kind: "evidence_clear",
      evidence: { kind: "fresh_activity", state: "running" },
      previousError: null,
    });
    expect(out).toMatchObject({ applied: true, eventEmitted: true, from: "attention_required", to: "ready" });
    const ev = emittedEvents(db, "seat.attention_cleared");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({
      clearedBy: "evidence",
      evidence: { kind: "fresh_activity", state: "running" },
      previousError: null,
    });
  });

  it("operator_attestation: ready → reject (guard, no re-emit — kills the dedup concern)", () => {
    setStatus("attention_required");
    const first = sm.transition(sessionId, { kind: "operator_attestation", reason: "ok" });
    expect(first.applied).toBe(true);
    const second = sm.transition(sessionId, { kind: "operator_attestation", reason: "ok" });
    expect(second.applied).toBe(false);
    expect(second.eventEmitted).toBe(false);
    // Exactly one seat.attention_cleared event — no re-emit on the second proposal.
    expect(emittedEvents(db, "seat.attention_cleared")).toHaveLength(1);
  });

  it("evidence_clear: ready → reject", () => {
    setStatus("ready");
    const out = sm.transition(sessionId, { kind: "evidence_clear", evidence: { kind: "x" } });
    expect(out.applied).toBe(false);
    expect(emittedEvents(db, "seat.attention_cleared")).toHaveLength(0);
  });

  it("rejects when evidence kind is not declared for the current state", () => {
    setStatus("ready");
    // boot_completed_clean is declared for ready (authoritative) so it applies;
    // but no recovery kind is declared for ready.
    expect(sm.transition(sessionId, { kind: "positive_activity" }).applied).toBe(false);
  });

  it("unknown session → applied false (no throw)", () => {
    const out = sm.transition("does-not-exist", { kind: "launch_started" });
    expect(out.applied).toBe(false);
    expect(out.eventEmitted).toBe(false);
  });

  it("getStartupStatus reads current status", () => {
    setStatus("attention_required");
    expect(sm.getStartupStatus(sessionId)).toBe("attention_required");
    expect(sm.getStartupStatus("missing")).toBeNull();
  });
});
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { simulateSessionStart } from "./helpers/simulate-hook.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupStatusSelfHealer } from "../src/domain/startup-status-self-healer.js";

describe("StartupStatusSelfHealer", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    rigRepo = new RigRepository(db);
  });
  afterEach(() => { db.close(); });

  function seedStuck(status: "failed" | "attention_required"): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET startup_status = ? WHERE id = ?").run(status, session.id);
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function activityOf(nodeId: string, rigId: string) {
    return {
      type: "agent.activity" as const,
      rigId,
      nodeId,
      sessionName: "r01-impl",
      runtime: "claude-code",
      activity: { state: "unknown" as const, reason: "session_start_observed", evidenceSource: "runtime_hook" as const, sampledAt: new Date().toISOString(), evidence: "SessionStart" },
    };
  }

  /**
   * Drive the REAL readiness pipeline (AgentActivityStore.recordHookEvent ->
   * eventBus.emit("agent.activity")) for a node that has a seeded session.
   * Awaitable so the healer's subscriber has fired before assertions run.
   */
  async function fireHook(nodeId: string) {
    simulateSessionStart(agentActivityStore, { nodeId, runtime: "claude-code" });
    await new Promise((r) => setTimeout(r, 0));
  }

  it("promotes a failed seat to ready on the first lifecycle hook", async () => {
    const seed = seedStuck("failed");
    const healer = new StartupStatusSelfHealer(db, eventBus);
    healer.start();

    await fireHook(seed.nodeId);

    const row = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string; startup_completed_at: string | null };
    expect(row.startup_status).toBe("ready");
    expect(row.startup_completed_at).not.toBeNull();
    healer.stop();
  });

  it("promotes an attention_required seat to ready on the first lifecycle hook", async () => {
    const seed = seedStuck("attention_required");
    const healer = new StartupStatusSelfHealer(db, eventBus);
    healer.start();

    await fireHook(seed.nodeId);

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("ready");
    healer.stop();
  });

  it("leaves a pending or ready seat untouched", async () => {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    // pending (default) — no UPDATE to startup_status
    const healer = new StartupStatusSelfHealer(db, eventBus);
    healer.start();

    await fireHook(node.id);

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(row.startup_status).toBe("pending");
    healer.stop();
  });

  it("ignores non-activity events", () => {
    const seed = seedStuck("failed");
    const healer = new StartupStatusSelfHealer(db, eventBus);
    healer.start();

    eventBus.emit({ type: "node.startup_ready", rigId: seed.rigId, nodeId: seed.nodeId });

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("failed");
    healer.stop();
  });

  // Intentionally a DIRECT emit (not recordHookEvent): the point is to feed
  // the healer an agent.activity for a node with NO session. recordHookEvent
  // would refuse (session_not_found) and emit nothing, so the healer's
  // unknown-node defensive path could only be exercised by a direct emit.
  it("does not throw for an unknown node id", () => {
    const healer = new StartupStatusSelfHealer(db, eventBus);
    healer.start();
    expect(() => eventBus.emit(activityOf("nonexistent-node", "rig-x"))).not.toThrow();
    healer.stop();
  });

  it("stop() unregisters the subscriber (no promotion after stop)", async () => {
    const seed = seedStuck("failed");
    const healer = new StartupStatusSelfHealer(db, eventBus);
    healer.start();
    healer.stop();

    await fireHook(seed.nodeId);

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("failed");
  });
});

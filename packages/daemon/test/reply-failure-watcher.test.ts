import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatStatusStateMachine } from "../src/domain/seat-status-state-machine.js";
import { ReplyFailureDetectorRegistry } from "../src/domain/reply-failure/detector.js";
import { claudeReplyFailureDetector } from "../src/domain/reply-failure/detectors/claude.js";
import { piReplyFailureDetector } from "../src/domain/reply-failure/detectors/pi.js";
import { ReplyFailureWatcher } from "../src/domain/reply-failure-watcher.js";
import type { RigEvent } from "../src/domain/types.js";

describe("ReplyFailureWatcher", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;
  let rigRepo: RigRepository;
  let stateMachine: SeatStatusStateMachine;
  let detectors: ReplyFailureDetectorRegistry;
  let emitted: RigEvent[];

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    rigRepo = new RigRepository(db);
    stateMachine = new SeatStatusStateMachine({ db, sessionRegistry, eventBus });
    detectors = new ReplyFailureDetectorRegistry();
    detectors.register(claudeReplyFailureDetector);
    detectors.register(piReplyFailureDetector);
    emitted = [];
    eventBus.subscribe((e) => { emitted.push(e); });
  });
  afterEach(() => { db.close(); });

  /** Seed a session whose seat starts `ready` (the core #3 transition target). */
  function seedReady(runtime = "claude-code"): { nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET startup_status = 'ready' WHERE id = ?").run(session.id);
    return { nodeId: node.id, sessionId: session.id };
  }

  /** Drive the REAL pipeline: recordHookEvent forwards the failure fields,
   *  sets replyFailureSignal on the activity, and emits agent.activity —
   *  which the watcher's subscriber inspects. Awaitable so the subscriber
   *  has fired before assertions. */
  async function fireStopFailure(
    nodeId: string,
    fields: { runtime: string; errorType?: string; httpStatus?: number; lastAssistantMessage?: string },
  ) {
    agentActivityStore.recordHookEvent({
      runtime: fields.runtime,
      nodeId,
      hookEvent: "StopFailure",
      errorType: fields.errorType,
      httpStatus: fields.httpStatus,
      lastAssistantMessage: fields.lastAssistantMessage,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 0));
  }

  function startupStatus(sessionId: string): string {
    return (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(sessionId) as { startup_status: string }).startup_status;
  }

  it("flags a ready seat attention_required on a claude authentication_failed signal", async () => {
    const seed = seedReady();
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();

    await fireStopFailure(seed.nodeId, { runtime: "claude-code", errorType: "authentication_failed" });

    expect(startupStatus(seed.sessionId)).toBe("attention_required");
    expect(emitted.some((e) => e.type === "node.startup_attention_required")).toBe(true);
    watcher.stop();
  });

  it("flags a ready seat attention_required on a pi 401 signal", async () => {
    const seed = seedReady("pi-coding-agent");
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();

    await fireStopFailure(seed.nodeId, { runtime: "pi-coding-agent", httpStatus: 401 });

    expect(startupStatus(seed.sessionId)).toBe("attention_required");
    watcher.stop();
  });

  it("does NOT flag on a transient claude rate_limit signal", async () => {
    const seed = seedReady();
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();

    await fireStopFailure(seed.nodeId, { runtime: "claude-code", errorType: "rate_limit" });

    expect(startupStatus(seed.sessionId)).toBe("ready"); // unchanged
    expect(emitted.some((e) => e.type === "node.startup_attention_required")).toBe(false);
    watcher.stop();
  });

  it("does NOT flag on a transient pi 429 signal", async () => {
    const seed = seedReady("pi-coding-agent");
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();

    await fireStopFailure(seed.nodeId, { runtime: "pi-coding-agent", httpStatus: 429 });

    expect(startupStatus(seed.sessionId)).toBe("ready");
    watcher.stop();
  });

  it("no-ops on an agent.activity event that carries no failure signal", async () => {
    const seed = seedReady();
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();

    // A plain Stop (no failure fields) → activity has no replyFailureSignal.
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", nodeId: seed.nodeId, hookEvent: "Stop", occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(startupStatus(seed.sessionId)).toBe("ready");
    watcher.stop();
  });

  it("is idempotent: a re-hit on an already-attention seat does not re-emit", async () => {
    const seed = seedReady();
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();

    await fireStopFailure(seed.nodeId, { runtime: "claude-code", errorType: "authentication_failed" });
    const firstEmits = emitted.filter((e) => e.type === "node.startup_attention_required").length;
    await fireStopFailure(seed.nodeId, { runtime: "claude-code", errorType: "authentication_failed" });
    const secondEmits = emitted.filter((e) => e.type === "node.startup_attention_required").length;

    expect(startupStatus(seed.sessionId)).toBe("attention_required");
    // The table rejects attention_required + reply_failure (no-op), so the
    // second hit emits nothing further.
    expect(secondEmits).toBe(firstEmits);
    watcher.stop();
  });

  it("stop() unregisters the subscriber (no flagging after stop)", async () => {
    const seed = seedReady();
    const watcher = new ReplyFailureWatcher({ db, eventBus, detectors, stateMachine });
    watcher.start();
    watcher.stop();

    await fireStopFailure(seed.nodeId, { runtime: "claude-code", errorType: "authentication_failed" });

    expect(startupStatus(seed.sessionId)).toBe("ready");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";

const NOW = new Date("2026-04-24T12:00:00.000Z");

describe("AgentActivityStore", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(runtime: "claude-code" | "codex" = "claude-code") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, runtime === "codex" ? "dev.qa" : "dev.impl", { runtime });
    const sessionName = runtime === "codex" ? "dev-qa@test-rig" : "dev-impl@test-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, attachmentType: "tmux" });
    return { rig, node, session, sessionName };
  }

  it("normalizes Claude prompt/tool hooks to running", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    const result = store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    expect(result.ok).toBe(true);
    const latest = store.getLatestForNode({
      nodeId: node.id,
      sessionName,
      now: NOW,
    });
    expect(latest).toMatchObject({
      state: "running",
      reason: "user_prompt_submit",
      evidenceSource: "runtime_hook",
      eventAt: "2026-04-24T11:59:00.000Z",
      rawEvent: "UserPromptSubmit",
    });
  });

  it("normalizes Claude permission notifications to needs_input and idle_prompt to idle", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "permission_prompt",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "idle_prompt",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "idle",
      reason: "idle_prompt",
      rawEvent: "Notification",
      rawSubtype: "idle_prompt",
    });
  });

  it("normalizes Claude PreToolUse and elicitation_dialog hooks", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "PreToolUse",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "running",
      reason: "pre_tool_use",
      rawEvent: "PreToolUse",
    });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "elicitation_dialog",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "needs_input",
      reason: "elicitation_dialog",
      rawEvent: "Notification",
      rawSubtype: "elicitation_dialog",
    });
  });

  it("normalizes Codex prompt-submit to running and Stop to idle", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "idle",
      reason: "stop",
      evidenceSource: "runtime_hook",
      rawEvent: "Stop",
    });
  });

  it("records Codex SessionStart as observed but not active", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "SessionStart",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "session_start_observed",
      evidenceSource: "runtime_hook",
      rawEvent: "SessionStart",
    });
  });

  it("returns the latest state regardless of age (no stale decay — a fired hook IS the state)", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:50:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });

    expect(latest).toMatchObject({
      state: "running",
      reason: "user_prompt_submit",
      evidenceSource: "runtime_hook",
    });
  });

  it("rejects hook events without managed session identity", () => {
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    const result = store.recordHookEvent({
      runtime: "claude-code",
      hookEvent: "UserPromptSubmit",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "missing_session_identity",
    });
  });

  describe("reply failure signal forwarding", () => {
    it("forwards Claude StopFailure error fields onto replyFailureSignal (and marks idle)", () => {
      const { node, sessionName } = seedSession("claude-code");
      const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

      store.recordHookEvent({
        runtime: "claude-code",
        sessionName,
        hookEvent: "StopFailure",
        errorType: "authentication_failed",
        errorDetails: "Invalid API key",
        lastAssistantMessage: "API Error: 401 Unauthorized",
        occurredAt: "2026-04-24T11:59:00.000Z",
      });

      const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
      // The turn still ended → idle from a liveness standpoint.
      expect(latest).toMatchObject({
        state: "idle",
        rawEvent: "StopFailure",
        replyFailureSignal: {
          errorType: "authentication_failed",
          errorDetails: "Invalid API key",
          lastAssistantMessage: "API Error: 401 Unauthorized",
        },
      });
    });

    it("leaves replyFailureSignal unset on a plain successful Stop", () => {
      const { node, sessionName } = seedSession("claude-code");
      const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

      store.recordHookEvent({
        runtime: "claude-code",
        sessionName,
        hookEvent: "Stop",
        occurredAt: "2026-04-24T11:59:00.000Z",
      });

      const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
      expect(latest?.state).toBe("idle");
      expect(latest?.replyFailureSignal).toBeUndefined();
    });

    it("forwards Pi provider status onto replyFailureSignal.httpStatus", () => {
      const { node, sessionName } = seedSession("claude-code");
      const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

      store.recordHookEvent({
        runtime: "claude-code",
        sessionName,
        hookEvent: "StopFailure",
        httpStatus: 401,
        occurredAt: "2026-04-24T11:59:00.000Z",
      });

      const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
      expect(latest).toMatchObject({
        state: "idle",
        replyFailureSignal: { httpStatus: 401 },
      });
    });

    it("does not attach a signal when all failure fields are empty/blank", () => {
      const { node, sessionName } = seedSession("claude-code");
      const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

      store.recordHookEvent({
        runtime: "claude-code",
        sessionName,
        hookEvent: "StopFailure",
        errorType: "   ",
        errorDetails: "",
        occurredAt: "2026-04-24T11:59:00.000Z",
      });

      const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
      expect(latest?.replyFailureSignal).toBeUndefined();
    });
  });
});

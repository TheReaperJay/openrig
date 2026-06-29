import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle prompt\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
  } as unknown as TmuxAdapter;
}

describe("SessionTransport", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTransport(tmux?: TmuxAdapter, overrides?: {
    agentActivityStore?: AgentActivityStore;
    sleep?: (ms: number) => Promise<void>;
    waitForIdlePollMs?: number;
    now?: () => Date;
  }) {
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      ...overrides,
    });
  }

  function seedCanonicalRig() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
    return { rig, node, session };
  }

  function seedLegacyRig() {
    const rig = rigRepo.createRig("r00-legacy");
    const node = rigRepo.addNode(rig.id, "worker-a", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "r00-legacy-worker-a");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r00-legacy-worker-a" });
    return { rig, node, session };
  }

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", {
      role: "orchestrator",
      runtime: "claude-code",
    });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
    return { rig, node, session };
  }

  // Test 1: send calls sendText -> delay -> sendKeys C-m
  it("send calls sendText then sendKeys C-m with delay", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    const tmux = mockTmux({
      sendText: async () => { callOrder.push("sendText"); return { ok: true }; },
      sendKeys: async (_t, keys) => { callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["sendText", "sendKeys:C-m"]);
  });

  // Test 2: send to canonical session name resolves correctly
  it("send to canonical session name resolves correctly", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "message");
  });

  // Test 3: send to legacy session name resolves correctly
  it("send to legacy session name resolves correctly", async () => {
    seedLegacyRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("r00-legacy-worker-a", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("r00-legacy-worker-a", "message");
  });

  // Test 4: send to missing session returns error with guidance
  it("send to missing session returns error with guidance", async () => {
    const tmux = mockTmux({ hasSession: async () => false });
    const transport = createTransport(tmux);

    const result = await transport.send("nonexistent", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session_missing");
    expect(result.error).toContain("not found");
    expect(result.error).toContain("rig ps");
  });

  // Test 5: send where sendKeys C-m fails returns "text visible but not submitted"
  it("send where C-m fails returns submit_failed with guidance", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("submit_failed");
    expect(result.error).toContain("visible");
    expect(result.error).toContain("not submitted");
  });

  // Test 6: send with verify captures pane and checks for text.
  // NOTE: the send() default guard no longer captures pane text for activity
  // (it consults the hook store), so the verify path is the ONLY capture
  // source — pre-verify (capture 1) + post-verify (capture 2).
  it("send with verify checks pane for sent text", async () => {
    seedCanonicalRig();
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        return captureCount < 2 ? "some output\n❯ " : "some output\nhello\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // OPR.99.0.6.3: a confirmed render is the strong positive outcome.
    expect(result.outcome).toBe("delivered");
  });

  it("send with verify does not false-positive on pre-existing pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    // OPR.99.0.6.3: text + Enter both succeeded, only the render re-confirm
    // missed — the honest middle, NOT a failure.
    expect(result.outcome).toBe("rendered-unconfirmed");
  });

  // OPR.99.0.6.3 — honest delivery-outcome vocabulary
  it("verify capture throwing after a successful send is the middle outcome, not a failure", async () => {
    seedCanonicalRig();
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        // Pre-verify capture succeeds; the post-send verify capture throws
        // (e.g. pane busy mid-redraw).
        if (captureCount >= 2) throw new Error("pane busy");
        return "some output\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("rendered-unconfirmed");
  });

  it("DISCRIMINATOR: a redraw-race send and a genuine transport failure surface differently", async () => {
    seedCanonicalRig();
    // Redraw-race: send + submit succeed, post-capture cannot re-confirm.
    const racyTmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const middle = await createTransport(racyTmux).send("dev-impl@my-rig", "hello", { verify: true });

    // Genuine transport failure: Enter does not land.
    const brokenTmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const failure = await createTransport(brokenTmux).send("dev-impl@my-rig", "hello", { verify: true });

    // The acceptance criterion: the two states are NOT equal in surfaced outcome.
    expect(middle.ok).toBe(true);
    expect(middle.outcome).toBe("rendered-unconfirmed");
    expect(failure.ok).toBe(false);
    expect(failure.outcome).toBe("failed");
    expect(middle.outcome).not.toBe(failure.outcome);
  });

  it("send_failed and submit_failed carry outcome 'failed' (vocabulary symmetry, ok:false unchanged)", async () => {
    seedCanonicalRig();
    const noPaste = mockTmux({
      sendText: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    });
    const sendFailed = await createTransport(noPaste).send("dev-impl@my-rig", "hello");
    expect(sendFailed.ok).toBe(false);
    expect(sendFailed.reason).toBe("send_failed");
    expect(sendFailed.outcome).toBe("failed");

    const noEnter = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    });
    const submitFailed = await createTransport(noEnter).send("dev-impl@my-rig", "hello");
    expect(submitFailed.ok).toBe(false);
    expect(submitFailed.reason).toBe("submit_failed");
    expect(submitFailed.outcome).toBe("failed");
  });

  it("send without verify carries no outcome field (additive, verify-scoped)", async () => {
    seedCanonicalRig();
    const transport = createTransport(mockTmux());
    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(result.outcome).toBeUndefined();
  });

  // Mid-work guard (default path, no --force / no --wait-for-idle): the agent
  // seat consults the hook pipeline. Fresh `running` => refuse with mid_work.
  // No hook yet (cold start) => proceed; hooks are mandatory infrastructure,
  // absence is transient not mid-work.
  it("send refuses with mid_work when fresh hook state is running", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ sendText: sendTextSpy }), { agentActivityStore });

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
    expect(result.error).toContain("mid-task");
    expect(result.error).toContain("force");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send with running hook + force sends anyway", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ sendText: sendTextSpy }), { agentActivityStore });

    const result = await transport.send("dev-impl@my-rig", "hello", { force: true });
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send proceeds when no hook exists (cold start — no mid-work guess)", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ sendText: sendTextSpy }));

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  // -- wait-for-idle: hook-pipeline driven (no pane scanning) --

  it("send with wait-for-idle prefers fresh hook activity and waits for hook idle", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "PreToolUse",
    });
    let sleepCount = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => {
        sleepCount++;
        if (sleepCount === 1) {
          agentActivityStore.recordHookEvent({
            runtime: "claude-code",
            sessionName: "dev-impl@my-rig",
            hookEvent: "Stop",
          });
        }
      },
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send with wait-for-idle treats fresh UserPromptSubmit hook evidence as running", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wait_for_idle_timeout");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("running");
    expect(result.activity?.reason).toBe("user_prompt_submit");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send with wait-for-idle hard-stops on fresh permission prompt hook evidence", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "Notification",
      subtype: "permission_prompt",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("needs_input");
    expect(result.activity?.reason).toBe("permission_prompt");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send with wait-for-idle treats fresh unknown hook evidence as unknown and does not fall through to pane idle", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "SessionStart",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "› idle\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_activity_unknown");
    expect(result.sent).toBe(false);
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send with wait-for-idle treats no hook (null) as unknown and refuses", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ sendText: sendTextSpy }), {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_activity_unknown");
    expect(result.sent).toBe(false);
    expect(result.activity).toBeUndefined();
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  // Terminal seat: the foreground-command guard STAYS (process-name, not regex;
  // terminals are hookless). A non-shell foreground process => mid_work.
  it("send to terminal session with foreground non-shell command refuses with mid_work", async () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "infra.ui", {
      role: "ui", runtime: "terminal",
    });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@term-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "infra-ui@term-rig" });

    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "VITE ready\npress h + enter to show help",
      getPaneCommand: async () => "node",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("infra-ui@term-rig", "printf 'hello\\n'");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
    expect(result.error).toContain("mid-task");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  // Test 9: send when tmux unavailable → guided error
  it("send when tmux unavailable returns tmux_unavailable with guidance", async () => {
    const tmux = mockTmux({
      hasSession: async () => { throw new Error("no server running"); },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
    expect(result.error).toContain("tmux");
  });

  it("send to external_cli target fails honestly before tmux transport", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.send("orch1-lead@rigged-buildout", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("transport_unavailable");
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
  });

  // Test 10: capture returns pane content
  it("capture returns pane content for existing session", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "line1\nline2\nline3",
    });
    const transport = createTransport(tmux);

    const result = await transport.capture("dev-impl@my-rig");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("line1");
  });

  it("capture for external_cli target fails honestly before tmux transport", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.capture("orch1-lead@rigged-buildout");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
  });

  // Test 11: resolveSessions by rig returns running sessions
  it("resolveSessions by rig returns running sessions", async () => {
    seedCanonicalRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ rig: "my-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@my-rig");
    }
  });

  // Test 12: resolveSessions global returns all running sessions across all rigs
  it("resolveSessions global returns all running sessions across all rigs", async () => {
    seedCanonicalRig(); // rig "my-rig" with dev-impl@my-rig
    seedLegacyRig();    // rig "r00-legacy" with r00-legacy-worker-a
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ global: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(3);
      const names = result.sessions.map((s) => s.sessionName).sort();
      expect(names).toContain("dev-impl@my-rig");
      expect(names).toContain("r00-legacy-worker-a");
      expect(names).toContain("orch1-lead@rigged-buildout");
    }
  });

  // Test 13: resolveSessions by pod filters by logicalId prefix
  it("resolveSessions by pod filters by logicalId prefix", async () => {
    const rig = rigRepo.createRig("multi-rig");
    // dev pod
    const devNode = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const devSess = sessionRegistry.registerSession(devNode.id, "dev-impl@multi-rig");
    sessionRegistry.updateStatus(devSess.id, "running");
    sessionRegistry.updateBinding(devNode.id, { tmuxSession: "dev-impl@multi-rig" });
    // orch pod
    const orchNode = rigRepo.addNode(rig.id, "orch.lead", { role: "orchestrator", runtime: "claude-code" });
    const orchSess = sessionRegistry.registerSession(orchNode.id, "orch-lead@multi-rig");
    sessionRegistry.updateStatus(orchSess.id, "running");
    sessionRegistry.updateBinding(orchNode.id, { tmuxSession: "orch-lead@multi-rig" });

    const transport = createTransport();
    const result = await transport.resolveSessions({ pod: "dev", rig: "multi-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@multi-rig");
    }
  });

  it("broadcast includes external_cli targets as explicit transport_unavailable failures", async () => {
    seedCanonicalRig();
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.broadcast({ global: true }, "hello", { force: true });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionName: "orch1-lead@rigged-buildout",
          ok: false,
          reason: "transport_unavailable",
        }),
      ]),
    );
  });
});
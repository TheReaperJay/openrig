import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { AgentActivity } from "./types.js";

// Foreground-process whitelist for the terminal send() guard. A tmux pane
// whose foreground command is NOT in this set is considered busy (vim, npm
// test, htop) and send() refuses to paste into it. This is a process-name
// signal, NOT pane-text regex scanning. Terminals are hookless, so there is
// no hook-pipeline alternative for this transport-safety guard.
const IDLE_TERMINAL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "nu", "tmux"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count++;
    start = index + needle.length;
  }
  return count;
}

export type TargetSpec =
  | { session: string }
  | { rig: string }
  | { pod: string; rig?: string }
  | { global: true };

export type ResolveResult =
  | { ok: true; sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> }
  | { ok: false; code: "not_found" | "ambiguous"; error: string };

export interface SendOpts {
  verify?: boolean;
  force?: boolean;
  waitForIdleMs?: number;
}

export interface SendResult {
  ok: boolean;
  sessionName: string;
  verified?: boolean;
  /**
   * OPR.99.0.6.3 — honest delivery-outcome vocabulary (additive; `verified`
   * keeps its exact semantics for existing parsers). Three distinguishable
   * states, mirroring the restore honest-outcome style:
   * - `delivered`: text + Enter landed AND the post-send capture re-confirmed
   *   the snippet (the strong positive; was `Verified: yes`).
   * - `rendered-unconfirmed`: text + Enter BOTH succeeded (the message landed)
   *   but the post-send capture raced a TUI redraw and could not re-confirm
   *   the snippet. Landed-but-unconfirmable, NOT a failure — confirm with
   *   `rig capture` if it matters. (Was collapsed into `Verified: no`.)
   * - `failed`: the transport itself failed (paste or Enter did not land) —
   *   set on the send_failed / submit_failed returns for vocabulary symmetry;
   *   their `ok:false` + HTTP mapping is unchanged.
   */
  outcome?: "delivered" | "rendered-unconfirmed" | "failed";
  warning?: string;
  error?: string;
  reason?: string;
  activity?: AgentActivity;
  waitedMs?: number;
  attempts?: number;
  sent?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  error?: string;
  reason?: string;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  failed: number;
  results: SendResult[];
}

interface SessionTransportDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  agentActivityStore?: AgentActivityStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitForIdlePollMs?: number;
}

interface SessionRow { node_id: string; session_name: string; }
interface NodeRow { rig_id: string; logical_id: string; }
interface SessionMetaRow { runtime: string | null; attachment_type: string | null; }
interface ResolvedTarget { sessionName: string; rigName: string; nodeLogicalId: string; }

export class SessionTransport {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private agentActivityStore?: AgentActivityStore;
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;
  private waitForIdlePollMs: number;

  constructor(deps: SessionTransportDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.agentActivityStore = deps.agentActivityStore;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? delay;
    this.waitForIdlePollMs = deps.waitForIdlePollMs ?? 500;
  }

  private getSessionMeta(sessionName: string): { runtime: string | null; attachmentType: string | null } {
    const row = this.db.prepare(`
      SELECT
        n.runtime AS runtime,
        b.attachment_type AS attachment_type
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as SessionMetaRow | undefined;

    return {
      runtime: row?.runtime ?? null,
      attachmentType: row?.attachment_type ?? null,
    };
  }

  async resolveSessions(target: TargetSpec): Promise<ResolveResult> {
    if ("session" in target) {
      return this.resolveBySessionName(target.session);
    }
    if ("pod" in target) {
      return this.resolveByPod(target.pod, target.rig);
    }
    if ("global" in target) {
      return this.resolveGlobal();
    }
    return this.resolveByRig(target.rig);
  }

  private resolveGlobal(): ResolveResult {
    const allRigs = this.rigRepo.listRigs();
    if (allRigs.length === 0) {
      return { ok: false, code: "not_found", error: "No rigs found. Check status with: rig ps" };
    }
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of allRigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "No running sessions found. Check status with: rig ps" };
    }
    return { ok: true, sessions };
  }

  private resolveBySessionName(sessionName: string): ResolveResult {
    const sessionRows = this.db
      .prepare("SELECT node_id, session_name FROM sessions WHERE session_name = ? ORDER BY id DESC")
      .all(sessionName) as SessionRow[];

    if (sessionRows.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    // Check for ambiguity: same session name across different rigs
    const rigNames = new Map<string, { nodeLogicalId: string }>();
    for (const row of sessionRows) {
      const nodeRow = this.db
        .prepare("SELECT rig_id, logical_id FROM nodes WHERE id = ?")
        .get(row.node_id) as NodeRow | undefined;
      if (nodeRow) {
        const rig = this.rigRepo.getRig(nodeRow.rig_id);
        if (rig) {
          rigNames.set(rig.rig.name, { nodeLogicalId: nodeRow.logical_id });
        }
      }
    }

    if (rigNames.size === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    if (rigNames.size > 1) {
      const names = Array.from(rigNames.keys()).join(", ");
      return {
        ok: false,
        code: "ambiguous",
        error: `Session '${sessionName}' is ambiguous — found in rigs: ${names}. Specify the rig explicitly.`,
      };
    }

    const [rigName, meta] = Array.from(rigNames.entries())[0]!;
    return {
      ok: true,
      sessions: [{ sessionName, rigName, nodeLogicalId: meta.nodeLogicalId }],
    };
  }

  private resolveByRig(rigName: string): ResolveResult {
    const rigs = this.rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No rig named '${rigName}' found. Check available rigs with: rig ps`,
      };
    }

    const sessions: ResolvedTarget[] = [];
    for (const rig of rigs) {
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for rig '${rigName}'. Check rig status with: rig ps`,
      };
    }

    return { ok: true, sessions };
  }

  private resolveByPod(podName: string, rigName?: string): ResolveResult {
    // Get rigs to search
    const rigs = rigName
      ? this.rigRepo.findRigsByName(rigName)
      : this.rigRepo.listRigs();

    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: rigName
          ? `No rig named '${rigName}' found. Check available rigs with: rig ps`
          : `No rigs found. Check status with: rig ps`,
      };
    }

    // Collect running sessions across all matching rigs, deduplicated by rig ID
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of rigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);

      for (const target of this.collectTransportTargetsForRig(rig.id, rig.name)) {
        const podPart = target.nodeLogicalId.split(".")[0];
        if (podPart === podName) {
          sessions.push(target);
        }
      }
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for pod '${podName}'${rigName ? ` in rig '${rigName}'` : ""}. Check available pods with: rig ps --nodes`,
      };
    }

    return { ok: true, sessions };
  }

  private collectTransportTargetsForRig(rigId: string, rigName: string): ResolvedTarget[] {
    const rigSessions = this.sessionRegistry.getSessionsForRig(rigId);
    const latestByNode = new Map<string, typeof rigSessions[0]>();
    for (const session of rigSessions) {
      const existing = latestByNode.get(session.nodeId);
      if (!existing || session.id > existing.id) {
        latestByNode.set(session.nodeId, session);
      }
    }

    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return [];

    const targets: ResolvedTarget[] = [];
    for (const node of rig.nodes) {
      const binding = this.sessionRegistry.getBindingForNode(node.id);
      const latestSession = latestByNode.get(node.id);

      if (binding?.attachmentType === "external_cli" && binding.externalSessionName) {
        targets.push({
          sessionName: binding.externalSessionName,
          rigName,
          nodeLogicalId: node.logicalId,
        });
        continue;
      }

      if (latestSession?.status === "running" && binding?.tmuxSession) {
        targets.push({
          sessionName: binding.tmuxSession,
          rigName,
          nodeLogicalId: node.logicalId,
        });
      }
    }

    return targets;
  }

  async send(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    let preVerifyContent: string | null = null;
    const sessionMeta = this.getSessionMeta(sessionName);
    const runtime = sessionMeta.runtime;
    const waitForIdleMs = opts?.waitForIdleMs;
    const waitMode = waitForIdleMs !== undefined;
    let waitEvidence: Pick<SendResult, "activity" | "waitedMs" | "attempts"> = {};

    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux transport is unavailable for this target.`,
      };
    }

    if (waitForIdleMs !== undefined) {
      if (opts?.force) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle cannot be combined with force. No text was sent.",
          sent: false,
        };
      }
      if (!Number.isFinite(waitForIdleMs) || waitForIdleMs <= 0) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs must be a positive number. No text was sent.",
          sent: false,
        };
      }
    }

    // 1. Check session exists / tmux available
    try {
      const exists = await this.tmuxAdapter.hasSession(sessionName);
      if (!exists) {
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found. Check available sessions with: rig ps --nodes`,
        };
      }
    } catch {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: "tmux is not available. Ensure tmux is installed and a server is running.",
      };
    }

    if (waitForIdleMs !== undefined) {
      const waitResult = await this.waitForIdle({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        timeoutMs: waitForIdleMs,
      });
      waitEvidence = {
        activity: waitResult.activity ?? undefined,
        waitedMs: waitResult.waitedMs,
        attempts: waitResult.attempts,
      };
      if (!waitResult.ok) {
        return {
          ok: false,
          sessionName,
          reason: waitResult.reason,
          error: waitResult.error,
          sent: false,
          ...waitEvidence,
        };
      }
    }

    // 2. Mid-work guard (unless force or explicit wait mode already proved idle).
    //    Terminal seat: process-name guard (KEEP — not regex; terminals are
    //    hookless). Agent seat: consult the hook pipeline; fresh `running`
    //    => refuse. No hook yet (cold start) => proceed; hooks are mandatory
    //    infrastructure, absence is transient not mid-work.
    if (!opts?.force && waitForIdleMs === undefined) {
      if (runtime === "terminal") {
        try {
          const paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
          if (paneCommand && !IDLE_TERMINAL_COMMANDS.has(paneCommand)) {
            return {
              ok: false,
              sessionName,
              reason: "mid_work",
              error: `Target pane appears mid-task. Use force: true to send anyway, or wait for the task to settle.`,
            };
          }
        } catch {
          // Can't check — proceed anyway
        }
      } else {
        const hookActivity = this.agentActivityStore?.getLatestForNode({
          sessionName,
          now: this.now(),
        });
        if (hookActivity && hookActivity.state === "running") {
          return {
            ok: false,
            sessionName,
            reason: "mid_work",
            error: `Target pane appears mid-task. Use force: true to send anyway, or wait for the task to settle.`,
          };
        }
      }
    }

    if (opts?.verify) {
      try {
        preVerifyContent = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
      } catch {
        preVerifyContent = null;
      }
    }

    // 3. Send text (paste)
    const textResult = await this.tmuxAdapter.sendText(sessionName, text);
    if (!textResult.ok) {
      return {
        ok: false,
        sessionName,
        reason: "send_failed",
        outcome: "failed",
        error: `Failed to send text to '${sessionName}': ${textResult.message}`,
        ...(waitMode ? { sent: false, ...waitEvidence } : {}),
      };
    }

    // 4. Wait 200ms (spike-proven delay)
    await this.sleep(200);

    // 5. Submit (C-m)
    const submitResult = await this.tmuxAdapter.sendKeys(sessionName, ["C-m"]);
    if (!submitResult.ok) {
      return {
        ok: false,
        sessionName,
        reason: "submit_failed",
        outcome: "failed",
        error: `Text is visible in '${sessionName}' but was not submitted (Enter failed). The agent may need manual attention.`,
        ...(waitMode ? { sent: true, ...waitEvidence } : {}),
      };
    }

    // 6. Verify if requested. At this point text + Enter BOTH succeeded, so the
    // message LANDED; the capture only re-confirms the render. Not re-confirming
    // (a TUI redraw race, or the capture throwing) is therefore the honest
    // middle outcome `rendered-unconfirmed` — never a failure (OPR.99.0.6.3).
    if (opts?.verify) {
      await this.sleep(500);
      try {
        const content = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
        const snippet = text.substring(0, Math.min(text.length, 40));
        const preCount = countOccurrences(preVerifyContent ?? "", snippet);
        const postCount = countOccurrences(content ?? "", snippet);
        const verified = postCount > preCount;
        return { ok: true, sessionName, verified, outcome: verified ? "delivered" : "rendered-unconfirmed", ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
      } catch {
        return { ok: true, sessionName, verified: false, outcome: "rendered-unconfirmed", ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
      }
    }

    return { ok: true, sessionName, ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
  }

  private async waitForIdle(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
    timeoutMs: number;
  }): Promise<
    | { ok: true; activity: AgentActivity; waitedMs: number; attempts: number }
    | { ok: false; reason: string; error: string; activity: AgentActivity | null; waitedMs: number; attempts: number }
  > {
    const startedAt = Date.now();
    let attempts = 0;

    while (true) {
      attempts++;
      const activity = await this.classifySendReadiness(input);
      const waitedMs = Date.now() - startedAt;

      if (activity && activity.state === "idle") {
        return { ok: true, activity, waitedMs, attempts };
      }

      if (activity && activity.state === "needs_input") {
        return {
          ok: false,
          reason: "target_needs_input",
          error: `Target requires attention (${activity.reason}). No text was sent.`,
          activity,
          waitedMs,
          attempts,
        };
      }

      if (!activity || activity.state === "unknown") {
        return {
          ok: false,
          reason: "target_activity_unknown",
          error: `Target activity could not be determined (${activity ? activity.reason : "no_hook_activity"}). No text was sent.`,
          activity: activity ?? null,
          waitedMs,
          attempts,
        };
      }

      if (waitedMs >= input.timeoutMs) {
        return {
          ok: false,
          reason: "wait_for_idle_timeout",
          error: `Target remained busy for ${waitedMs}ms. No text was sent.`,
          activity,
          waitedMs,
          attempts,
        };
      }

      const remainingMs = input.timeoutMs - waitedMs;
      await this.sleep(Math.min(this.waitForIdlePollMs, Math.max(1, remainingMs)));
    }
  }

  // Hook pipeline only. No text-scanner fallback. No synthesis — absence of
  // a hook event is honestly `null` (not a fake `runtime_hook` unknown). The
  // latest hook event IS the state; it does not decay (stale is deleted).
  private async classifySendReadiness(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
  }): Promise<AgentActivity | null> {
    const now = this.now();
    return this.agentActivityStore?.getLatestForNode({
      sessionName: input.sessionName,
      now,
    }) ?? null;
  }

  async capture(sessionName: string, opts?: { lines?: number }): Promise<CaptureResult> {
    const sessionMeta = this.getSessionMeta(sessionName);
    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux capture is unavailable for this target.`,
      };
    }

    try {
      const exists = await this.tmuxAdapter.hasSession(sessionName);
      if (!exists) {
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found. Check available sessions with: rig ps --nodes`,
        };
      }
    } catch {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: "tmux is not available. Ensure tmux is installed and a server is running.",
      };
    }

    const lines = opts?.lines ?? 20;
    const content = await this.tmuxAdapter.capturePaneContent(sessionName, lines);
    if (content === null) {
      return {
        ok: false,
        sessionName,
        reason: "capture_failed",
        error: `Could not capture pane content for '${sessionName}'.`,
      };
    }

    return { ok: true, sessionName, content, lines };
  }

  async broadcast(target: TargetSpec, text: string, opts?: SendOpts): Promise<BroadcastResult> {
    const resolved = await this.resolveSessions(target);
    if (!resolved.ok) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        results: [{
          ok: false,
          sessionName: "",
          reason: resolved.code,
          error: resolved.error,
        }],
      };
    }

    const results: SendResult[] = [];
    for (const session of resolved.sessions) {
      const result = await this.send(session.sessionName, text, opts);
      results.push(result);
    }

    return {
      total: results.length,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}

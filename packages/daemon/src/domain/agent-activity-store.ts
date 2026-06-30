import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity, PersistedEvent } from "./types.js";
import type { ReplyFailureSignal } from "./reply-failure/types.js";

export interface HookActivityInput {
  runtime: string | null;
  sessionName?: string | null;
  nodeId?: string | null;
  hookEvent: string;
  subtype?: string | null;
  occurredAt?: string | null;
  /** Claude StopFailure `error`. */
  errorType?: string | null;
  /** Claude StopFailure `error_details`. */
  errorDetails?: string | null;
  /** Pi `after_provider_response.status`. */
  httpStatus?: number | null;
  /** Codex Stop / Claude StopFailure `last_assistant_message`. */
  lastAssistantMessage?: string | null;
}

export type RecordHookActivityResult =
  | { ok: true; activity: AgentActivity; event: PersistedEvent }
  | { ok: false; code: "missing_session_identity" | "session_not_found"; error: string };

interface AgentActivityStoreDeps {
  db: Database.Database;
  eventBus: EventBus;
  now?: () => Date;
}

interface SessionLookupRow {
  rig_id: string;
  node_id: string;
  session_name: string;
  runtime: string | null;
}

interface EventPayloadRow {
  payload: string;
}

export class AgentActivityStore {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly now: () => Date;

  constructor(deps: AgentActivityStoreDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
  }

  recordHookEvent(input: HookActivityInput): RecordHookActivityResult {
    if (!input.sessionName && !input.nodeId) {
      return {
        ok: false,
        code: "missing_session_identity",
        error: "Hook activity requires a managed sessionName or nodeId",
      };
    }

    const session = this._resolveSession(input);
    if (!session) {
      return {
        ok: false,
        code: "session_not_found",
        error: "Hook activity did not match a managed session. List seats with: rig ps --nodes",
      };
    }

    const sampledAt = this.now().toISOString();
    const eventAt = parseTimestamp(input.occurredAt) ?? sampledAt;
    const activity = normalizeHookActivity({
      runtime: input.runtime ?? session.runtime,
      hookEvent: input.hookEvent,
      subtype: input.subtype ?? null,
      sampledAt,
      eventAt,
      errorType: input.errorType ?? null,
      errorDetails: input.errorDetails ?? null,
      httpStatus: input.httpStatus ?? null,
      lastAssistantMessage: input.lastAssistantMessage ?? null,
    });

    const event = this.eventBus.emit({
      type: "agent.activity",
      rigId: session.rig_id,
      nodeId: session.node_id,
      sessionName: session.session_name,
      runtime: activity.runtime ?? session.runtime,
      activity,
    });

    return { ok: true, activity, event };
  }

  getLatestForNode(input: {
    nodeId?: string | null;
    sessionName?: string | null;
    now?: Date;
  }): AgentActivity | null {
    const nodeId = input.nodeId ?? (input.sessionName ? this._resolveSession({ sessionName: input.sessionName })?.node_id : null);
    if (!nodeId) return null;

    const row = this.db.prepare(
      "SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT 1"
    ).get(nodeId) as EventPayloadRow | undefined;
    if (!row) return null;

    const payload = parseActivityPayload(row.payload);
    if (!payload?.activity) return null;

    const activity = payload.activity;
    if (input.sessionName && payload.sessionName !== input.sessionName) return null;

    // The latest hook event IS the state. It does not decay — a fired hook
    // remains authoritative until another event overwrites it. Liveness ("is
    // the pane alive?") is a separate question owned by terminalActive /
    // SeatActivityService, not by AgentActivity. (The stale/freshness concept
    // was deleted: it wrongly aged valid states like idle into unknown.)
    const referenceTime = input.now ?? this.now();
    return {
      ...activity,
      sampledAt: referenceTime.toISOString(),
    };
  }

  resolveSession(input: { sessionName?: string | null; nodeId?: string | null; runtime?: string | null }): { sessionId: string; rigId: string; nodeId: string; sessionName: string } | null {
    const row = this._resolveSession(input);
    if (!row) return null;
    const sessionRow = this.db.prepare(
      "SELECT id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1"
    ).get(row.session_name) as { id: string } | undefined;
    if (!sessionRow) return null;
    return { sessionId: sessionRow.id, rigId: row.rig_id, nodeId: row.node_id, sessionName: row.session_name };
  }

  private _resolveSession(input: { sessionName?: string | null; nodeId?: string | null }): SessionLookupRow | null {
    if (input.nodeId) {
      const row = this.db.prepare(`
        SELECT n.rig_id, n.id AS node_id, s.session_name, n.runtime
        FROM nodes n
        LEFT JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        WHERE n.id = ?
        LIMIT 1
      `).get(input.nodeId) as SessionLookupRow | undefined;
      if (row?.session_name) return row;
    }

    if (!input.sessionName) return null;
    const row = this.db.prepare(`
      SELECT n.rig_id, n.id AS node_id, s.session_name, n.runtime
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(input.sessionName) as SessionLookupRow | undefined;
    return row ?? null;
  }
}

function normalizeHookActivity(input: {
  runtime: string | null;
  hookEvent: string;
  subtype: string | null;
  sampledAt: string;
  eventAt: string;
  errorType: string | null;
  errorDetails: string | null;
  httpStatus: number | null;
  lastAssistantMessage: string | null;
}): AgentActivity {
  const rawEvent = input.hookEvent;
  const rawSubtype = input.subtype;
  const reason = normalizeReason(rawSubtype ?? rawEvent);
  const runtime = input.runtime;
  let state: AgentActivity["state"] = "unknown";
  let normalizedReason = reason;

  if (rawEvent === "UserPromptSubmit" || rawEvent === "PreToolUse" || rawEvent === "active") {
    state = "running";
  } else if (rawEvent === "Notification") {
    if (rawSubtype === "permission_prompt" || rawSubtype === "elicitation_dialog") {
      state = "needs_input";
    } else if (rawSubtype === "idle_prompt") {
      state = "idle";
    } else {
      state = "unknown";
      normalizedReason = rawSubtype ? reason : "notification";
    }
  } else if (
    rawEvent === "Stop" ||
    rawEvent === "StopFailure" ||
    rawEvent === "SessionEnd" ||
    rawEvent === "stop" ||
    rawEvent === "idle"
  ) {
    // StopFailure fires INSTEAD OF Stop when a turn ends on an API error — the
    // turn still ended, so the seat is idle from a liveness standpoint. The
    // structured failure (if any) rides on replyFailureSignal below.
    state = "idle";
  } else if (rawEvent === "SessionStart") {
    state = "unknown";
    normalizedReason = "session_start_observed";
  } else {
    state = "unknown";
    normalizedReason = "unmapped_runtime_hook";
  }

  const replyFailureSignal = buildReplyFailureSignal({
    errorType: input.errorType,
    errorDetails: input.errorDetails,
    httpStatus: input.httpStatus,
    lastAssistantMessage: input.lastAssistantMessage,
  });

  return {
    state,
    reason: normalizedReason,
    evidenceSource: "runtime_hook",
    sampledAt: input.sampledAt,
    evidence: rawSubtype ?? rawEvent,
    eventAt: input.eventAt,
    rawEvent,
    rawSubtype,
    runtime,
    ...(replyFailureSignal ? { replyFailureSignal } : {}),
  };
}

/** Builds the structured failure signal from whichever native fields the
 *  reporting harness forwarded. Returns undefined when no failure was reported
 *  (a plain successful turn), so the activity carries no signal at all. */
function buildReplyFailureSignal(input: {
  errorType: string | null;
  errorDetails: string | null;
  httpStatus: number | null;
  lastAssistantMessage: string | null;
}): ReplyFailureSignal | undefined {
  const errorType = input.errorType?.trim() || undefined;
  const errorDetails = input.errorDetails?.trim() || undefined;
  const lastAssistantMessage = input.lastAssistantMessage?.trim() || undefined;
  const httpStatus =
    typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus)
      ? input.httpStatus
      : undefined;
  if (!errorType && !errorDetails && !httpStatus && !lastAssistantMessage) return undefined;
  const signal: ReplyFailureSignal = {};
  if (errorType) signal.errorType = errorType;
  if (errorDetails) signal.errorDetails = errorDetails;
  if (httpStatus !== undefined) signal.httpStatus = httpStatus;
  if (lastAssistantMessage) signal.lastAssistantMessage = lastAssistantMessage;
  return signal;
}

function normalizeReason(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function parseTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseActivityPayload(payload: string): { sessionName?: string; activity?: AgentActivity } | null {
  try {
    return JSON.parse(payload) as { sessionName?: string; activity?: AgentActivity };
  } catch {
    return null;
  }
}

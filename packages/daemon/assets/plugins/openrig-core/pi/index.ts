import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * OpenRig activity hook extension for the Pi coding agent.
 *
 * Maps Pi lifecycle events to the canonical hook event names consumed by
 * OpenRig's activity-relay. The relay POSTs to the daemon's
 * /api/activity/hooks endpoint so the rig UI sees accurate seat status.
 *
 * The extension is dormant outside an OpenRig-managed session:
 *   - it only runs when OpenRig has stamped the process env with session
 *     identity (OPENRIG_SESSION_NAME / OPENRIG_NODE_ID / OPENRIG_RUNTIME).
 *   - even then, the relay silently no-ops unless OPENRIG_URL and
 *     OPENRIG_ACTIVITY_HOOK_TOKEN are set.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, "activity-relay.cjs");

function isManagedByOpenRig(): boolean {
  const env = process.env;
  return !!(
    env.OPENRIG_SESSION_NAME ||
    env.RIGGED_SESSION_NAME ||
    env.OPENRIG_NODE_ID ||
    env.RIGGED_NODE_ID
  );
}

function emit(hookEvent: string, subtype?: string) {
  if (!isManagedByOpenRig()) return;

  const payload = JSON.stringify({ hookEvent, subtype });
  const child = spawn(process.execPath, [RELAY], {
    stdio: ["pipe", "ignore", "ignore"],
    env: process.env,
    detached: true,
  });

  child.stdin?.write(payload);
  child.stdin?.end();
  child.on("error", () => {});
  child.unref();
}

export default function (pi: ExtensionAPI) {
  // Session boot / reload / resume / fork → the seat is alive.
  // Forward the NATIVE reason (startup|reload|new|resume|fork) so the daemon
  // records WHY the session started. Claude/codex already forward `source`
  // via the relay's subtype; this makes pi symmetric. The reason flows to the
  // daemon as the SessionStart hook's subtype.
  pi.on("session_start", (e) => emit("SessionStart", e?.reason));

  // User prompt submitted, agent loop about to begin → busy
  pi.on("before_agent_start", () => emit("UserPromptSubmit"));

  // Tool execution keeps the "running" state fresh during long turns
  pi.on("tool_execution_start", () => emit("PreToolUse"));

  // Agent turn finished → idle (until next prompt)
  pi.on("agent_end", () => emit("Stop"));

  // Session replacement / quit → seat going away
  pi.on("session_shutdown", () => emit("SessionEnd"));
}

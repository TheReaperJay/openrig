// Headless auth-status probe for managed agent seats. Run BEFORE launching the
// harness TUI, so a not-logged-in runtime fails fast as attention_required
// instead of burning a 30s readiness timeout on a harness that can never boot.
//
// This is #1 of the access-failure detection design: a cheap, status-only
// probe. It does NOT try to answer whether the token actually has access
// (expired, out of quota, no subscription) — that surfaces only on the first
// model reply and is #3's job (the per-message reply-failure watcher). Keeping
// #1 status-only is what makes it sub-second and side-effect-free: no model
// call, no exec tier.
//
// The exec fn is injected (mirrors verifyCodexProfileLoads in
// codex-profile-preflight) so the probe is deterministic under test. Contract:
// exec resolves to {exitCode, stdout, stderr} on a successful spawn — including
// a non-zero exit, because `claude auth status --json` exits 1 when logged out
// but still prints JSON we must parse — and rejects on a spawn failure such as
// ENOENT (binary missing), which the probe maps to auth_probe_error. A missing
// binary never silently launches a dead seat.
//
// Verified contracts (run on this machine, see BUILD-HEADLESS-AUTH-PROBE.md §5):
//   claude auth status --json  (claude v2.1.195)
//     logged-in  : exit 0,  stdout {loggedIn:true, authMethod, apiProvider, ...}
//     logged-out : exit 1,  stdout {loggedIn:false, authMethod:"none", ...}
//     --text mode: exit 1,  stdout "Not logged in. ..." (non-JSON)
//   codex login status         (codex-cli 0.133.0)
//     logged-in  : exit 0,  stderr "Logged in using ChatGPT"
//     logged-out : exit 1,  stderr "Not logged in"

import { exec } from "node:child_process";

export interface AuthExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected command runner. Resolves with the exit code + streams on a
 *  successful spawn (including a non-zero exit), and rejects on a spawn failure
 *  such as ENOENT. If the probe times out, it aborts `signal`; a well-behaved
 *  exec wires that signal into the child (execFileSync/spawn both accept it) so
 *  the child is killed instead of orphaning. */
export type AuthExecFn = (cmd: string, signal?: AbortSignal) => Promise<AuthExecResult>;

export type AuthProbeCode = "login_required" | "codex_auth_refusal" | "auth_probe_error";

export interface AuthProbeResult {
  /** false => the adapter returns recovery:"attention_required" without launching the TUI. */
  ok: boolean;
  /** Readiness bucket this runtime maps to (both are existing ATTENTION_REQUIRED_READINESS_CODES). */
  code: AuthProbeCode;
  detail: string;
  evidence: string;
}

export interface AuthProbeOpts {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Probe Claude Code's logged-in status via `claude auth status --json`.
 * Parses the `loggedIn` field; on non-JSON output (e.g. --text) falls back to
 * the exit code. The `loggedIn` field is trusted over the exit code: exit 0
 * with {loggedIn:false} is treated as not logged in.
 */
export async function probeClaudeAuth(exec: AuthExecFn, opts: AuthProbeOpts = {}): Promise<AuthProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const r = await runExec(exec, "claude auth status --json", timeoutMs);
    let loggedIn = false;
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: unknown };
      loggedIn = j.loggedIn === true;
    } catch {
      // Non-JSON output (e.g. --text mode prints "Not logged in. ..."):
      // fall back to the exit code.
      loggedIn = r.exitCode === 0;
    }
    if (loggedIn) {
      return { ok: true, code: "login_required", detail: "authenticated", evidence: r.stdout };
    }
    return {
      ok: false,
      code: "login_required",
      detail: "Claude is not logged in (run `claude auth login`)",
      evidence: r.stderr || r.stdout,
    };
  } catch (err) {
    return probeError("claude auth status --json", err);
  }
}

/**
 * Probe Codex's logged-in status via `codex login status`. Codex prints its
 * status on stderr; the exit code is the signal (0 = authed, 1 = not). No
 * JSON to parse.
 */
export async function probeCodexAuth(exec: AuthExecFn, opts: AuthProbeOpts = {}): Promise<AuthProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const r = await runExec(exec, "codex login status", timeoutMs);
    if (r.exitCode === 0) {
      return { ok: true, code: "codex_auth_refusal", detail: "authenticated", evidence: r.stderr };
    }
    return {
      ok: false,
      code: "codex_auth_refusal",
      detail: "Codex is not logged in (run `codex login`)",
      evidence: r.stderr || r.stdout,
    };
  } catch (err) {
    return probeError("codex login status", err);
  }
}

/** Run exec with a hard timeout. Three properties, all required:
 *  1. The probe always returns — Promise.race settles on either exec or the
 *     timeout, so an exec that ignores the signal still can't hang the probe.
 *  2. The timer is cleared on every path (finally), so a fast success never
 *     leaves a 10s timer holding the event loop.
 *  3. On timeout the AbortSignal fires, so a well-behaved exec kills its child
 *     instead of orphaning a hung `claude auth status` process. */
async function runExec(exec: AuthExecFn, cmd: string, timeoutMs: number): Promise<AuthExecResult> {
  const controller = new AbortController();
  const reason = new Error(`auth probe timed out after ${timeoutMs}ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(reason);
      reject(reason);
    }, timeoutMs);
  });
  try {
    return await Promise.race([exec(cmd, controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function probeError(cmd: string, err: unknown): AuthProbeResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    code: "auth_probe_error",
    detail: `auth probe failed (${cmd}): ${message}`,
    evidence: String(err),
  };
}

/** Default real exec for production wiring. Runs the command via the shell,
 *  resolves with {exitCode, stdout, stderr} on a successful spawn (including
 *  a non-zero exit: `claude auth status --json` exits 1 when logged out but
 *  still prints JSON), and rejects on a spawn failure such as ENOENT. The
 *  AbortSignal is wired into the child so a probe timeout kills the process
 *  instead of orphaning it. Async on purpose: a sync execFileSync would
 *  block the daemon event loop and could not be interrupted by the signal. */
export function createDefaultAuthExec(): AuthExecFn {
  return (cmd, signal) =>
    new Promise((resolve, reject) => {
      exec(cmd, { encoding: "utf8", signal, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (!err) return resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        // Non-zero exit: err.code is the numeric exit code, so resolve and let
        // the probe parse the output. Spawn failures (ENOENT) and signal kills
        // have a non-numeric err.code, so reject -> auth_probe_error.
        if (typeof err.code === "number") return resolve({ exitCode: err.code, stdout: stdout ?? "", stderr: stderr ?? "" });
        reject(err);
      });
    });
}
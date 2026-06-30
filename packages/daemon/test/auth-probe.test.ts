// auth-probe — unit tests for the #1 headless status probe.
// The exec fn is a stub, so every case is deterministic and binary-free.

import { describe, it, expect } from "vitest";
import { probeClaudeAuth, probeCodexAuth } from "../src/domain/auth-probe.js";
import type { AuthExecFn, AuthExecResult } from "../src/domain/auth-probe.js";

function stubExec(result: AuthExecResult): AuthExecFn {
  return async () => result;
}

function rejectingExec(err: unknown): AuthExecFn {
  return async () => {
    throw err;
  };
}

function neverResolvesExec(): AuthExecFn {
  // A promise whose executor never calls resolve/reject: simulates a hung child.
  return async () => new Promise<AuthExecResult>(() => {});
}

describe("probeClaudeAuth", () => {
  it("logged-in (exit 0 + {loggedIn:true}) => ok", async () => {
    const r = await probeClaudeAuth(stubExec({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
      stderr: "",
    }));
    expect(r.ok).toBe(true);
    expect(r.code).toBe("login_required");
    expect(r.detail).toBe("authenticated");
  });

  it("exit 0 + {loggedIn:false} => not ok (trusts the field over the exit code)", async () => {
    const r = await probeClaudeAuth(stubExec({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      stderr: "",
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("login_required");
    expect(r.detail).toMatch(/not logged in/);
  });

  it("exit 1 + {loggedIn:false} => login_required (parses JSON even on non-zero exit)", async () => {
    const r = await probeClaudeAuth(stubExec({
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      stderr: "",
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("login_required");
    expect(r.evidence).toContain('"loggedIn":false');
  });

  it("exit 0 + non-JSON => ok (exit-code fallback)", async () => {
    const r = await probeClaudeAuth(stubExec({
      exitCode: 0,
      stdout: "All good.",
      stderr: "",
    }));
    expect(r.ok).toBe(true);
  });

  it("exit 1 + non-JSON (--text mode) => not ok (exit-code fallback on non-zero)", async () => {
    const r = await probeClaudeAuth(stubExec({
      exitCode: 1,
      stdout: "Not logged in. Run claude auth login to authenticate.",
      stderr: "",
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("login_required");
  });

  it("ENOENT (spawn failure) => auth_probe_error", async () => {
    const r = await probeClaudeAuth(rejectingExec(new Error("spawn claude ENOENT")));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("auth_probe_error");
    expect(r.detail).toMatch(/auth probe failed/);
    expect(r.detail).toMatch(/ENOENT/);
  });

  it("timeout => auth_probe_error", async () => {
    const r = await probeClaudeAuth(neverResolvesExec(), { timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("auth_probe_error");
    expect(r.detail).toMatch(/timed out after 30ms/);
  }, 5000);
});

describe("probeCodexAuth", () => {
  it("logged-in (exit 0) => ok", async () => {
    const r = await probeCodexAuth(stubExec({
      exitCode: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT",
    }));
    expect(r.ok).toBe(true);
    expect(r.code).toBe("codex_auth_refusal");
    expect(r.evidence).toBe("Logged in using ChatGPT");
  });

  it("logged-out (exit 1 + 'Not logged in') => codex_auth_refusal", async () => {
    const r = await probeCodexAuth(stubExec({
      exitCode: 1,
      stdout: "",
      stderr: "Not logged in",
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("codex_auth_refusal");
    expect(r.detail).toMatch(/not logged in/);
    expect(r.evidence).toBe("Not logged in");
  });

  it("ENOENT (spawn failure) => auth_probe_error", async () => {
    const r = await probeCodexAuth(rejectingExec(new Error("spawn codex ENOENT")));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("auth_probe_error");
  });

  it("timeout => auth_probe_error", async () => {
    const r = await probeCodexAuth(neverResolvesExec(), { timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("auth_probe_error");
    expect(r.detail).toMatch(/timed out after 30ms/);
  }, 5000);
});
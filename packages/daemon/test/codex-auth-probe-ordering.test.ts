// CodexRuntimeAdapter — ordering: the profile preflight (OPR.0.3.4.7) runs
// BEFORE the #1 auth probe. A profile that fails to load must short-circuit at
// the profile block, so the auth probe is never reached. Deterministic: the
// profile preflight module is mocked to fail, so no real codex binary is
// involved (the real preflight uses a hardcoded execSync we cannot inject).

import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { AuthProbeResult } from "../src/domain/auth-probe.js";

vi.mock("../src/domain/codex-profile-preflight.js", () => ({
  verifyCodexProfileLoads: async () => ({
    ok: false,
    profile: "fleet",
    error: "profile failed to load",
    migrationHint: "fix it",
  }),
}));

import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => ""),
  } as unknown as TmuxAdapter;
}

function mockFs(): CodexAdapterFsOps {
  return {
    readFile: () => "",
    writeFile: () => {},
    exists: () => true,
    mkdirp: () => {},
    homedir: "/mock-home",
  } as unknown as CodexAdapterFsOps;
}

function makeBinding(): NodeBinding {
  return {
    id: "b1",
    nodeId: "n1",
    tmuxSession: "r01-qa",
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: "",
    cwd: "/project",
    codexConfigProfile: "fleet",
  } as NodeBinding;
}

describe("CodexRuntimeAdapter — profile preflight runs before the #1 auth probe", () => {
  it("profile failure short-circuits before the auth probe is called", async () => {
    const authProbe = vi.fn(
      async () => ({ ok: true, code: "codex_auth_refusal", detail: "authenticated", evidence: "" }) as AuthProbeResult,
    );
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(),
      fsOps: mockFs(),
      sleep: async () => {},
      authProbe,
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(false);
    expect(authProbe).not.toHaveBeenCalled();
  });
});
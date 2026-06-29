import { describe, it, expect, vi } from "vitest";
import { PiCodingAgentAdapter, type PiAdapterFsOps } from "../src/adapters/pi-coding-agent-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

function mockTmux() {
  return {
    sessionExists: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue({ ok: true as const }),
    capturePaneContent: vi.fn().mockResolvedValue(""),
    getPaneCommand: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    runCommandInSession: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    hasSession: vi.fn().mockResolvedValue(true),
    sendText: vi.fn().mockResolvedValue({ ok: true as const }),
  } as unknown as ConstructorParameters<typeof PiCodingAgentAdapter>[0]["tmux"];
}

function mockPiFs(files?: Record<string, string>, homedir = "/mock-home"): PiAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  const vendoredPlugin = `${homedir}/.openrig/plugins/openrig-core/pi/index.ts`;
  if (!(vendoredPlugin in store)) {
    store[vendoredPlugin] = "export default {}";
  }
  return {
    readFile: (p: string) => {
      if (p in store) return store[p]!;
      throw new Error(`Not found: ${p}`);
    },
    writeFile: (p: string, c: string) => {
      store[p] = c;
    },
    exists: (p: string) => p in store || Object.keys(store).some((k) => k === p || k.startsWith(p + "/")),
    mkdirp: () => {},
    listFiles: (dir: string) =>
      Object.keys(store)
        .filter((k) => k.startsWith(dir + "/"))
        .map((k) => k.slice(dir.length + 1)),
    _store: store,
    homedir,
  } as PiAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/cwd"): NodeBinding {
  return {
    id: "b1",
    nodeId: "n1",
    tmuxSession: "test",
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: "",
    cwd,
  };
}

function makePluginEntry(id: string, absolutePath: string): ProjectionEntry {
  return {
    category: "plugin",
    effectiveId: id,
    sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec",
    resourcePath: absolutePath,
    absolutePath,
    classification: "safe_projection",
  };
}

function makeSkillEntry(id: string, absolutePath: string): ProjectionEntry {
  return {
    category: "skill",
    effectiveId: id,
    sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec",
    resourcePath: absolutePath,
    absolutePath,
    classification: "safe_projection",
  };
}

function makePlan(entries: ProjectionEntry[]): ProjectionPlan {
  return {
    runtime: "pi-coding-agent",
    cwd: "/cwd",
    entries,
    startup: { files: [], actions: [] },
    conflicts: [],
    noOps: [],
    diagnostics: [],
  };
}

const OPENRIG_CORE_TREE = {
  "/p/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
  "/p/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
  "/p/openrig-core/.pi-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","extension":"./pi/index.ts"}',
  "/p/openrig-core/pi/index.ts": "// pi extension",
  "/p/openrig-core/pi/activity-relay.cjs": "// relay",
  "/p/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user",
  "/p/openrig-core/hooks/claude.json": "{}",
  "/p/openrig-core/hooks/scripts/activity-relay.cjs": "// relay",
};

describe("Pi Coding Agent adapter — plugin projection", () => {
  it("projects openrig-core to .pi/extensions/<id>/ using the pi/ subdir", async () => {
    const fs = mockPiFs(OPENRIG_CORE_TREE);
    const adapter = new PiCodingAgentAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("openrig-core");
    expect(result.failed).toEqual([]);

    // Only the pi/ contents land, not the whole dual-manifest tree.
    expect(fs._store["/cwd/.pi/extensions/openrig-core/index.ts"]).toBe("// pi extension");
    expect(fs._store["/cwd/.pi/extensions/openrig-core/activity-relay.cjs"]).toBe("// relay");
    expect(fs._store["/cwd/.pi/extensions/openrig-core/.claude-plugin/plugin.json"]).toBeUndefined();
    expect(fs._store["/cwd/.pi/extensions/openrig-core/hooks/claude.json"]).toBeUndefined();
  });

  it("auto-detects pi applicability via .pi-plugin manifest or pi/index.ts", async () => {
    const fs = mockPiFs({
      "/p/pi-only/.pi-plugin/plugin.json": '{"name":"pi-only"}',
      "/p/pi-only/pi/index.ts": "// pi",
    });
    const adapter = new PiCodingAgentAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("pi-only", "/p/pi-only")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));
    expect(result.projected).toContain("pi-only");
  });

  it("skips claude-only plugins when pluginType is auto", async () => {
    const fs = mockPiFs({
      "/p/claude-only/.claude-plugin/plugin.json": '{"name":"claude-only"}',
    });
    const adapter = new PiCodingAgentAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));
    expect(result.projected).not.toContain("claude-only");
    expect(result.skipped).toContain("claude-only");
  });

  it("honors explicit pluginType=pi even without .pi-plugin", async () => {
    const fs = mockPiFs({
      "/p/forced-pi/index.ts": "// extension",
    });
    const adapter = new PiCodingAgentAdapter({ tmux: mockTmux(), fsOps: fs });
    const entry = makePluginEntry("forced-pi", "/p/forced-pi");
    entry.pluginType = "pi";
    const plan = makePlan([entry]);

    const result = await adapter.project(plan, makeBinding("/cwd"));
    expect(result.projected).toContain("forced-pi");
    expect(fs._store["/cwd/.pi/extensions/forced-pi/index.ts"]).toBe("// extension");
  });
});

describe("Pi Coding Agent adapter — skill projection", () => {
  it("projects a skill directory to .pi/skills/<id>/ without appending a pi/ subdir", async () => {
    // Regression: resolvePluginSourceRoot() was being called for skills too,
    // which appended a non-existent `pi/` subdir and caused ENOENT on real
    // rig up. Skills project their own directory verbatim.
    const fs = mockPiFs({
      "/s/brainstorming/SKILL.md": "---\nname: brainstorming\ndescription: x\n---\nbody",
      "/s/brainstorming/guide.md": "# guide",
    });
    const adapter = new PiCodingAgentAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makeSkillEntry("brainstorming", "/s/brainstorming")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("brainstorming");
    expect(result.failed).toEqual([]);
    expect(fs._store["/cwd/.pi/skills/brainstorming/SKILL.md"]).toContain("brainstorming");
    expect(fs._store["/cwd/.pi/skills/brainstorming/guide.md"]).toBe("# guide");
  });
});

describe("Pi Coding Agent adapter — launch + readiness", () => {
  it("launches pi fresh with --name and --session-id", async () => {
    const tmux = mockTmux();
    const adapter = new PiCodingAgentAdapter({ tmux, fsOps: mockPiFs() });

    const result = await adapter.launchHarness(makeBinding("/cwd"), { name: "test-seat" });

    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("test", expect.stringContaining("pi --name 'test-seat'"));
    expect(tmux.sendText).toHaveBeenCalledWith("test", expect.stringContaining("--session-id"));
    expect(tmux.sendKeys).toHaveBeenCalledWith("test", ["Enter"]);
  });

  it("launches pi resume with --session", async () => {
    const tmux = mockTmux();
    tmux.getPaneCommand = vi.fn().mockResolvedValue("node");
    tmux.capturePaneContent = vi.fn().mockResolvedValue("pi tui");
    const adapter = new PiCodingAgentAdapter({ tmux, fsOps: mockPiFs() });

    const result = await adapter.launchHarness(makeBinding("/cwd"), {
      name: "test-seat",
      resumeToken: "sess-123",
    });

    expect(result.ok).toBe(true);
    expect(result.resumeToken).toBe("sess-123");
    expect(tmux.sendText).toHaveBeenCalledWith("test", expect.stringContaining("pi --session 'sess-123'"));
    expect(tmux.sendKeys).toHaveBeenCalledWith("test", ["Enter"]);
  });

  it("reports ready when pane command is node/pi", async () => {
    const tmux = mockTmux();
    tmux.getPaneCommand = vi.fn().mockResolvedValue("node");
    tmux.capturePaneContent = vi.fn().mockResolvedValue("some pi tui text");
    const adapter = new PiCodingAgentAdapter({ tmux, fsOps: mockPiFs() });

    const result = await adapter.checkReady(makeBinding("/cwd"));
    expect(result.ready).toBe(true);
  });

  it("reports shell-returned failure when pane is a shell", async () => {
    const tmux = mockTmux();
    tmux.getPaneCommand = vi.fn().mockResolvedValue("bash");
    tmux.capturePaneContent = vi.fn().mockResolvedValue("$ ");
    const adapter = new PiCodingAgentAdapter({ tmux, fsOps: mockPiFs() });

    const result = await adapter.checkReady(makeBinding("/cwd"));
    expect(result.ready).toBe(false);
    expect(result.code).toBe("returned_to_shell");
  });
});

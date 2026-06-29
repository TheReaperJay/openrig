import nodePath from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export const TELEMETRY_PLUGIN_ID = "openrig-core" as const;

export const TELEMETRY_RUNTIMES = new Set([
  "claude-code",
  "codex",
  "pi-coding-agent",
] as const);
export type TelemetryRuntime = "claude-code" | "codex" | "pi-coding-agent";

export function isTelemetryRuntime(runtime: string | null | undefined): runtime is TelemetryRuntime {
  return typeof runtime === "string" && TELEMETRY_RUNTIMES.has(runtime as TelemetryRuntime);
}

export function vendoredTelemetryPluginPath(homedir: string = os.homedir()): string {
  return nodePath.join(homedir, ".openrig", "plugins", TELEMETRY_PLUGIN_ID);
}

/**
 * Per-harness target directory for the projection of the telemetry plugin.
 * Returns null for runtimes that don't need a per-cwd projection
 * (currently none — every non-terminal runtime projects to a per-cwd dir).
 */
export function telemetryProjectionTarget(runtime: TelemetryRuntime, cwd: string): string {
  switch (runtime) {
    case "claude-code":
      return nodePath.join(cwd, ".claude", "plugins", TELEMETRY_PLUGIN_ID);
    case "codex":
      return nodePath.join(cwd, ".codex", "plugins", TELEMETRY_PLUGIN_ID);
    case "pi-coding-agent":
      return nodePath.join(cwd, ".pi", "extensions", TELEMETRY_PLUGIN_ID);
  }
}

/**
 * Per-harness command-line flag(s) to make the harness load the vendored
 * plugin at startup.
 *
 * Claude: --plugin-dir=<path>. Verified against `claude --help`: additive,
 * loads the plugin "for this session only" alongside whatever else Claude
 * loads (marketplace plugins, settings-based plugins). Repeatable. We pass
 * exactly one. The user's other plugins continue to load.
 *
 * Codex: NO FLAG. Codex's hook trust gate is satisfied at startup by
 * writing `[state."<source>:<event>:<matcher>:<hook>"]` entries with
 * `trusted_hash = "sha256:<hex>"` into `~/.codex/config.toml` (verified
 * against Codex PR #20321, openai/codex). The hash is computed over the
 * TOML serialization of our hook's NormalizedHookIdentity. See
 * `codex-global-hooks.ts` for the full implementation. This trusts ONLY
 * our hooks by key (file path + position); the user's other hooks in
 * `~/.codex/hooks.json` or in other files retain whatever trust state
 * they had (typically untrusted, prompting the user).
 *
 * Pi: no flag. Native auto-discovery of .pi/extensions/<id>/index.ts.
 *
 * Callers must shellQuote() each token before splicing into the command.
 */
export function telemetryHarnessLoadArg(runtime: TelemetryRuntime, vendoredPath: string): string[] {
  switch (runtime) {
    case "claude-code":
      return [`--plugin-dir=${vendoredPath}`];
    case "codex":
      return [];
    case "pi-coding-agent":
      return [];
  }
}

export interface TelemetryPluginFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export function copyPluginTree(fs: TelemetryPluginFs, sourceDir: string, targetDir: string): void {
  if (!fs.exists(sourceDir)) {
    throw new Error(`source does not exist: ${sourceDir}`);
  }
  fs.mkdirp(targetDir);
  const files = fs.listFiles ? fs.listFiles(sourceDir) : [];
  for (const relPath of files) {
    const srcPath = nodePath.join(sourceDir, relPath);
    const destPath = nodePath.join(targetDir, relPath);
    const content = fs.readFile(srcPath);
    if (fs.exists(destPath)) {
      // hash-skip when content already matches (idempotent re-runs)
      const srcHash = createHash("sha256").update(content).digest("hex");
      const destHash = createHash("sha256").update(fs.readFile(destPath)).digest("hex");
      if (srcHash === destHash) continue;
    }
    fs.mkdirp(nodePath.dirname(destPath));
    fs.writeFile(destPath, content);
  }
}

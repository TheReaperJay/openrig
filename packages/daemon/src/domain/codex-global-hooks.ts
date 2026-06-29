import nodePath from "node:path";
import { createHash } from "node:crypto";

// Codex's hook loader reads ~/.codex/hooks.json (user-global). NOT
// per-cwd .codex/hooks.json — that path is decorative. This module
// owns the idempotent read/merge/write of the user-global file.
//
// Shape mirrors Codex's config:
//   {
//     "hooks": {
//       "SessionStart":    [{ "hooks": [{ "type": "command", "command": "node <path>", "timeout": N }] }],
//       "UserPromptSubmit": [...],
//       "Stop":            [...]
//     }
//   }

export interface CodexHookCommand {
  type: "command";
  command: string;
  timeout: number;
}
export interface CodexHookMatcher {
  matcher?: string;
  hooks: CodexHookCommand[];
}
export type CodexHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "Notification";
export type CodexHooksFile = {
  hooks: Partial<Record<CodexHookEvent, CodexHookMatcher[]>>;
};

export interface CodexGlobalHooksFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

export function readCodexGlobalHooks(fs: CodexGlobalHooksFs, home: string): CodexHooksFile {
  const path = nodePath.join(home, ".codex", "hooks.json");
  if (!fs.exists(path)) return { hooks: {} };
  try {
    const parsed = JSON.parse(fs.readFile(path));
    if (parsed && typeof parsed === "object" && "hooks" in parsed) return parsed as CodexHooksFile;
  } catch {
    /* fall through to empty */
  }
  return { hooks: {} };
}

export function mergeOpenRigHooks(existing: CodexHooksFile, relayCommand: string): CodexHooksFile {
  const out: CodexHooksFile = { hooks: { ...existing.hooks } };
  const events: CodexHookEvent[] = ["SessionStart", "UserPromptSubmit", "Stop"];
  for (const event of events) {
    const prior = out.hooks[event] ?? [];
    // Already present? Idempotent.
    const alreadyOpenRig = prior.some((matcher) =>
      matcher.hooks.some((h) => h.type === "command" && h.command === relayCommand)
    );
    if (alreadyOpenRig) continue;
    out.hooks[event] = [
      ...prior,
      { hooks: [{ type: "command", command: relayCommand, timeout: 5 }] },
    ];
  }
  return out;
}

export function writeCodexGlobalHooks(fs: CodexGlobalHooksFs, home: string, file: CodexHooksFile): void {
  const path = nodePath.join(home, ".codex", "hooks.json");
  fs.mkdirp(nodePath.dirname(path));
  fs.writeFile(path, JSON.stringify(file, null, 2) + "\n");
}

/**
 * Compute the sha256:<hex> trust hash for a single hook entry.
 * Replicates Codex's `command_hook_hash` Rust function (verified from
 * openai/codex PR #20321).
 *
 * The hash is over the TOML serialization of a NormalizedHookIdentity
 * struct with these fields, sorted alphabetically per TOML 1.0:
 *
 *   event_name = "<event>"
 *   matcher = ""                (omitted when None per Codex serde skip_if)
 *   command = "<command>"
 *   timeout_sec = <N>
 *   async = false
 *   status_message = <not set>  (omitted when None)
 *
 * Codex's serde-derived TOML output for
 *   NormalizedHookIdentity {
 *     event_name: "<event>",
 *     group: MatcherGroup {
 *       matcher: None,
 *       hooks: [Command { command, timeout_sec: Some(N), async: false, status_message: None }]
 *     }
 *   }
 * is:
 *
 *   [[group]]
 *
 *   [[group.hooks]]
 *   async = false
 *   command = "<command>"
 *   timeout_sec = <N>
 *
 *   event_name = "<event>"
 *
 * (with `matcher = ""` added when matcher is Some). Empty line between
 * tables is from the multi-doc array-of-tables representation. The
 * Codex serializer emits a blank line between tables; we replicate it.
 *
 * Hash input is the UTF-8 bytes of that exact string. Output is
 * "sha256:" + 64 lowercase hex chars.
 */
export function computeCodexHookTrustHash(
  eventName: "SessionStart" | "UserPromptSubmit" | "Stop",
  matcher: string | null,
  command: string,
  timeoutSec: number,
): string {
  const parts: string[] = [];
  parts.push("[[group]]");
  parts.push("");
  parts.push("[[group.hooks]]");
  parts.push("async = false");
  parts.push(`command = ${tomlQuote(command)}`);
  parts.push(`timeout_sec = ${timeoutSec}`);
  parts.push("");

  if (matcher !== null) {
    parts.push(`matcher = ${tomlQuote(matcher)}`);
  }
  parts.push(`event_name = ${tomlQuote(eventName)}`);

  const canonicalToml = parts.join("\n") + "\n";
  const sha256Hex = createHash("sha256").update(canonicalToml, "utf-8").digest("hex");
  return `sha256:${sha256Hex}`;
}

/**
 * TOML 1.0 basic double-quoted string escape. For our inputs (paths,
 * event names) the only characters that need escaping are backslash
 * and double quote. We do NOT need to handle control chars, multi-line
 * strings, or literal strings because our inputs don't contain those.
 *
 * If a future Codex serde format changes the quoting, this function
 * must be updated to match. The slice 1 verification test (live Codex
 * seat launches, /api/rigs/<id>/nodes shows runtime_hook) will catch
 * any drift.
 */
function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Compute the (key, trusted_hash) pairs for our three hook entries.
 *
 * Key format (verified from Codex source codex-rs/config/src/hooks_tests.rs):
 *   `<absolute-path-to-source-file>:<event-name>:<matcher-index>:<hook-index>`
 *
 * Indices:
 *   - matcher-index = 0 because we use NO matcher (matches all)
 *   - hook-index = 0 because we have exactly one handler per matcher group
 *
 * If `mergeOpenRigHooks` puts our relay as the FIRST entry on an event
 * (it does, because we append AFTER prior entries), our index is prior.length.
 * For correctness, we compute the actual post-merge indices.
 */
function computeTrustEntriesForOpenRigHooks(
  relayCommand: string,
  hooksJsonPath: string,
  existing: CodexHooksFile,
): Array<{ key: string; trustedHash: string }> {
  const events: Array<"SessionStart" | "UserPromptSubmit" | "Stop"> = [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
  ];
  return events.map((event) => {
    const prior = existing.hooks[event] ?? [];
    const matcherIndex = prior.length; // our entry is appended after prior entries
    const hookIndex = 0; // single handler in our matcher group
    return {
      key: `${hooksJsonPath}:${event}:${matcherIndex}:${hookIndex}`,
      trustedHash: computeCodexHookTrustHash(event, "", relayCommand, 5),
    };
  });
}

/**
 * Upsert [state."<key>"] trust entries into ~/.codex/config.toml.
 *
 * The config.toml is TOML with multiple sections. We need to preserve
 * every existing section except our [state."..."] entries, which we
 * upsert.
 */
function upsertCodexTrustEntries(
  fs: CodexGlobalHooksFs,
  home: string,
  entries: Array<{ key: string; trustedHash: string }>,
): void {
  let parsed: Record<string, unknown>;
  const configPath = nodePath.join(home, ".codex", "config.toml");
  if (fs.exists(configPath)) {
    const { parse } = require("@iarna/toml");
    parsed = parse(fs.readFile(configPath)) as Record<string, unknown>;
  } else {
    parsed = {};
  }
  if (!parsed.state || typeof parsed.state !== "object") {
    parsed.state = {};
  }
  let changed = false;
  for (const { key, trustedHash } of entries) {
    const prior = (parsed.state as Record<string, unknown>)[key];
    if (prior && typeof prior === "object" && (prior as Record<string, string>).trusted_hash === trustedHash) {
      continue;
    }
    (parsed.state as Record<string, unknown>)[key] = { enabled: true, trusted_hash: trustedHash };
    changed = true;
  }
  if (!changed) return;
  const { stringify } = require("@iarna/toml");
  const serialized = stringify(parsed);
  fs.mkdirp(nodePath.dirname(configPath));
  fs.writeFile(configPath, serialized);
}

/**
 * Public seam. Reads ~/.codex/hooks.json, merges in OpenRig's three
 * hook entries (idempotent), writes back if changed. No-op when already
 * present with matching entries.
 *
 * Also writes [state] trust entries into ~/.codex/config.toml so our
 * hooks pass Codex's per-hook trust gate at startup.
 */
export function ensureCodexGlobalHooks(
  fs: CodexGlobalHooksFs,
  home: string,
  relayCommand: string,
): void {
  // STEP 1: write ~/.codex/hooks.json with our three hook entries.
  const hooksFile = readCodexGlobalHooks(fs, home);
  const mergedHooks = mergeOpenRigHooks(hooksFile, relayCommand);
  const hooksJsonPath = nodePath.join(home, ".codex", "hooks.json");
  if (JSON.stringify(hooksFile) !== JSON.stringify(mergedHooks)) {
    writeCodexGlobalHooks(fs, home, mergedHooks);
  }

  // STEP 2: write [state."..."] trust entries into ~/.codex/config.toml
  const trustEntries = computeTrustEntriesForOpenRigHooks(
    relayCommand,
    hooksJsonPath,
    mergedHooks,
  );
  upsertCodexTrustEntries(fs, home, trustEntries);
}

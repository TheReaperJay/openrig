// Plugin Discovery Service.
//
// Read-only registry that scans the filesystem for installed plugins and
// exposes them to the Library UI via GET /api/plugins (+ /:id, /:id/used-by).
// It is a derived view only — it never mutates state and performs no SQL.
//
// Sources scanned:
//   - ~/.openrig/plugins/<id>/                              (vendored, e.g. openrig-core)
//   - ~/.claude/plugins/cache/<mp>/<plugin>/<version>/      (Claude marketplace cache)
//   - ~/.codex/plugins/cache/<mp>/<plugin>/<version>/       (Codex marketplace cache)
//   - ~/.pi/agent/extensions/<id>.ts + <id>/index.ts        (global Pi extensions)
//   - per-rig <cwd>/.claude|codex/plugins/* + .pi/extensions/*  (projected into a rig)
//
// getPlugin(id) summarizes a plugin's tree (skills/, hooks/, mcpServers) so the
// UI detail viewer can show what a plugin ships without re-reading files.
//
// findUsedBy(id) parses agent.yaml files and walks resources.plugins[].id to
// report which specs reference a plugin. It operates on parsed YAML (not
// string-grep) so comments and adjacent text don't produce false positives.
//
// This service depends only on filesystem reads + parsed YAML. It reads the
// agent.yaml plugin structure (resources.plugins[].id + profile.uses.plugins[])
// directly, so it stays correct regardless of how plugin types evolve.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export type PluginRuntime = "claude" | "codex" | "pi";
// `rig-cwd` source: plugins projected into a specific rig's working dir
// (<cwd>/.claude/plugins/*, <cwd>/.codex/plugins/*, <cwd>/.pi/extensions/*).
// `pi-global` source: global Pi extensions auto-discovered from
// ~/.pi/agent/extensions/ (single .ts files + <id>/index.ts folders). These
// belong to the Pi runtime (like ~/.claude + ~/.codex caches), not OpenRig
// state, so the dir is homedir-anchored.
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache" | "rig-cwd" | "pi-global";

export interface PluginEntry {
  /** Stable id for routing (`openrig-core`, `<marketplace>:<plugin>:<version>`). */
  id: string;
  /** Plugin's declared name from manifest. */
  name: string;
  /** Plugin's declared version. */
  version: string;
  /** Optional description from manifest. */
  description: string | null;
  /** Source root where this plugin was discovered. */
  source: PluginSourceKind;
  /**
   * Human-readable provenance label:
   *   - `vendored:<plugin>`
   *   - `claude-cache:<marketplace>/<plugin>/<version>`
   *   - `codex-cache:<marketplace>/<plugin>/<version>`
   *   - `pi-global:<id>` / `rig-cwd:<rig>/<...>`
   */
  sourceLabel: string;
  /** Which runtimes this plugin supports (presence of manifest dirs). */
  runtimes: PluginRuntime[];
  /** Filesystem path to the plugin root. */
  path: string;
  /**
   * mtime of the manifest file (used as a soft "last loaded" approximation
   * for the UI list view).
   */
  lastSeenAt: string | null;
  /**
   * Number of skill folders shipped under `<plugin>/skills/`. Surfaced in the
   * list response so the Library can render a skill-count column without an
   * N+1 detail fetch per plugin row. Counted once at detection time.
   */
  skillCount: number;
  /**
   * True for plugins OpenRig treats as mandatory infrastructure and projects
   * unconditionally regardless of agent.yaml (e.g. the telemetry plugin — see
   * the adapters' "MANDATORY TELEMETRY PLUGIN PROJECTION" blocks). Read-only UX
   * flag: the Library renders a "Mandatory / Infrastructure" badge for these.
   * NOT an enable/disable state — there is no opt-out for infra plugins.
   */
  mandatory: boolean;
}

export interface PluginManifestSummary {
  /** Original manifest object from `<plugin>/.claude-plugin/plugin.json`. */
  raw: Record<string, unknown>;
  /** Convenience-extracted fields (best-effort; null if missing). */
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

export interface PluginSkillSummary {
  /** Skill folder name. */
  name: string;
  /** Path relative to plugin root. */
  relativePath: string;
}

export interface PluginHookSummary {
  /** Which runtime this hook config targets. */
  runtime: PluginRuntime;
  /** Path relative to plugin root. */
  relativePath: string;
  /** Hook event names declared (best-effort parse). */
  events: string[];
}

// MCP server declarations surfaced from a plugin's manifest. The runtime's
// plugin loader actually wires these servers; OpenRig only reads what the
// manifest declares so the UI can list "this plugin ships these MCP servers."
// Reads manifest.mcpServers (the Claude/Codex spec key) and emits one summary
// per declared server. Best-effort: a missing or oddly-shaped field yields []
// rather than throwing.
export interface PluginMcpServerSummary {
  /** Which runtime manifest declared this MCP server. */
  runtime: PluginRuntime;
  /** Server name (object key in the manifest's mcpServers map). */
  name: string;
  /** Declared command if the entry is a stdio-style spec. */
  command: string | null;
  /** Declared transport (stdio/http/etc) if the entry exposes it. */
  transport: string | null;
}

export interface PluginDetail {
  /** The list-view entry. */
  entry: PluginEntry;
  /** Parsed `.claude-plugin/plugin.json` if present. */
  claudeManifest: PluginManifestSummary | null;
  /** Parsed `.codex-plugin/plugin.json` if present. */
  codexManifest: PluginManifestSummary | null;
  /** Skill folders shipped under `<plugin>/skills/`. */
  skills: PluginSkillSummary[];
  /** Hook configs shipped under `<plugin>/hooks/`. */
  hooks: PluginHookSummary[];
  /** MCP server declarations from the claude/codex manifest's `mcpServers` field. */
  mcpServers: PluginMcpServerSummary[];
}

export interface AgentReference {
  /** agent name (from agent.yaml `name` field). */
  agentName: string;
  /** absolute path to agent.yaml. */
  sourcePath: string;
  /** profile names that include this plugin in their uses.plugins[]. */
  profiles: string[];
}

export interface PluginDiscoveryServiceOpts {
  /** Root directory for vendored OpenRig plugins (typically ~/.openrig/plugins). */
  openrigPluginsDir: string;
  /** Root directory for Claude Code plugin cache (typically ~/.claude/plugins/cache). */
  claudeCacheDir: string;
  /** Root directory for Codex plugin cache (typically ~/.codex/plugins/cache). */
  codexCacheDir: string;
  /**
   * Root directory for global Pi extensions (typically ~/.pi/agent/extensions).
   * Optional: when absent, the global Pi scan is skipped (keeps existing call
   * sites and tests isolated from a real home dir). Pi extensions are
   * auto-discovered as single `.ts` files and `<id>/index.ts` folders (per pi's
   * own auto-discovery rules). Project-local <cwd>/.pi/extensions/* are scanned
   * separately via cwdScanRoots.
   */
  piExtensionsDir?: string;
  /**
   * Spec library directory containing agent.yaml files (recursively scanned)
   * for findUsedBy. Typically the daemon's resolved spec library root.
   */
  specLibraryDir: string;
  /**
   * Optional rig cwd roots whose `.claude/plugins/*`, `.codex/plugins/*`, and
   * `.pi/extensions/*` subdirectories get scanned for plugins projected into a
   * specific rig. Default empty. Typically populated per-call from the API
   * layer's ?cwd=<path> query param rather than at construction.
   */
  cwdScanRoots?: string[];
}

export interface ListPluginsOpts {
  /** Filter to plugins supporting a specific runtime. */
  runtimeFilter?: PluginRuntime;
  /** Filter to plugins from a specific source root. */
  sourceFilter?: PluginSourceKind;
  /**
   * Per-call rig cwd roots; overrides the constructor option. Each cwd
   * contributes plugins projected into that rig. The API layer passes a single
   * ?cwd=<path> query param down here.
   */
  cwdScanRoots?: string[];
}

const CLAUDE_MANIFEST_REL = ".claude-plugin/plugin.json";
const CODEX_MANIFEST_REL = ".codex-plugin/plugin.json";
const PI_MANIFEST_REL = ".pi-plugin/plugin.json";

/**
 * Plugin ids OpenRig treats as mandatory infrastructure and projects
 * unconditionally (independent of agent.yaml — see the adapters' "MANDATORY
 * TELEMETRY PLUGIN PROJECTION" blocks). Surfaced read-only in the Library UX
 * so the mandatory badge distinguishes infra from optional/user plugins.
 * Add ids here as more infra-grade plugins ship.
 */
const MANDATORY_INFRA_PLUGIN_IDS = new Set<string>(["openrig-core"]);

export class PluginDiscoveryService {
  private readonly opts: PluginDiscoveryServiceOpts;

  constructor(opts: PluginDiscoveryServiceOpts) {
    this.opts = opts;
  }

  listPlugins(filterOpts: ListPluginsOpts = {}): PluginEntry[] {
    const out: PluginEntry[] = [];

    // Vendored OpenRig plugins.
    if (existsSync(this.opts.openrigPluginsDir)) {
      for (const entry of safeReaddir(this.opts.openrigPluginsDir)) {
        const pluginPath = join(this.opts.openrigPluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const detected = this.detectPlugin(pluginPath, "vendored", entry);
        if (detected) out.push(detected);
      }
    }

    // Claude Code cache: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
    if (existsSync(this.opts.claudeCacheDir)) {
      for (const marketplace of safeReaddir(this.opts.claudeCacheDir)) {
        const marketplacePath = join(this.opts.claudeCacheDir, marketplace);
        if (!isDir(marketplacePath)) continue;
        for (const plugin of safeReaddir(marketplacePath)) {
          const pluginRoot = join(marketplacePath, plugin);
          if (!isDir(pluginRoot)) continue;
          for (const version of safeReaddir(pluginRoot)) {
            const versionPath = join(pluginRoot, version);
            if (!isDir(versionPath)) continue;
            const id = `claude-cache:${marketplace}/${plugin}/${version}`;
            const sourceLabel = `claude-cache:${marketplace}/${plugin}/${version}`;
            const detected = this.detectPlugin(versionPath, "claude-cache", id, sourceLabel);
            if (detected) out.push(detected);
          }
        }
      }
    }

    // Codex cache: ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/
    if (existsSync(this.opts.codexCacheDir)) {
      for (const marketplace of safeReaddir(this.opts.codexCacheDir)) {
        const marketplacePath = join(this.opts.codexCacheDir, marketplace);
        if (!isDir(marketplacePath)) continue;
        for (const plugin of safeReaddir(marketplacePath)) {
          const pluginRoot = join(marketplacePath, plugin);
          if (!isDir(pluginRoot)) continue;
          for (const version of safeReaddir(pluginRoot)) {
            const versionPath = join(pluginRoot, version);
            if (!isDir(versionPath)) continue;
            const id = `codex-cache:${marketplace}/${plugin}/${version}`;
            const sourceLabel = `codex-cache:${marketplace}/${plugin}/${version}`;
            const detected = this.detectPlugin(versionPath, "codex-cache", id, sourceLabel);
            if (detected) out.push(detected);
          }
        }
      }
    }

    // Global Pi extensions: ~/.pi/agent/extensions/<id>.ts (single file) +
    // ~/.pi/agent/extensions/<id>/index.ts (folder). These are pi's own
    // auto-discovery forms (per pi's extensions doc "Extension Locations");
    // they carry no manifest, so detectPiExtension derives metadata from the
    // path. Non-.ts files (e.g. .json config/data consumed by extensions) are
    // skipped — pi does not auto-discover them.
    if (this.opts.piExtensionsDir && existsSync(this.opts.piExtensionsDir)) {
      for (const entry of safeReaddir(this.opts.piExtensionsDir)) {
        const extensionPath = join(this.opts.piExtensionsDir, entry);
        if (isDir(extensionPath)) {
          const indexPath = join(extensionPath, "index.ts");
          if (!existsSync(indexPath)) continue;
          const detected = this.detectPiExtension(
            extensionPath, "pi-global", entry, entry, `pi-global:${entry}`, indexPath,
          );
          if (detected) out.push(detected);
        } else if (entry.endsWith(".ts")) {
          const id = entry.slice(0, -3);
          const detected = this.detectPiExtension(
            extensionPath, "pi-global", id, id, `pi-global:${id}`, extensionPath,
          );
          if (detected) out.push(detected);
        }
      }
    }

    // Rig-bundled cwd plugin roots. Per-call opts override constructor opts
    // (per-call wins by replacement, NOT append-to-constructor, because the API
    // layer's ?cwd=<path> intent is "ALL plugins this specific rig sees" —
    // predictable + cacheable).
    const effectiveCwds = filterOpts.cwdScanRoots ?? this.opts.cwdScanRoots ?? [];
    for (const cwd of effectiveCwds) {
      this.scanCwdBundledPlugins(cwd, out);
    }

    let filtered = out;
    if (filterOpts.runtimeFilter) {
      filtered = filtered.filter((p) => p.runtimes.includes(filterOpts.runtimeFilter!));
    }
    if (filterOpts.sourceFilter) {
      filtered = filtered.filter((p) => p.source === filterOpts.sourceFilter);
    }
    return filtered;
  }

  // Scan a single rig cwd for `.claude/plugins/*`, `.codex/plugins/*`, and
  // `.pi/extensions/*` bundles. Emits one PluginEntry per discovered plugin.
  // Claude/Codex bundles are detected by manifest (`.claude-plugin/plugin.json`
  // / `.codex-plugin/plugin.json`); Pi bundles follow pi's auto-discovery rule
  // (`<id>/index.ts` folder or `<id>.ts` file).
  private scanCwdBundledPlugins(cwd: string, out: PluginEntry[]): void {
    if (!existsSync(cwd)) return;
    const claudePluginsDir = join(cwd, ".claude", "plugins");
    if (existsSync(claudePluginsDir)) {
      for (const entry of safeReaddir(claudePluginsDir)) {
        const pluginPath = join(claudePluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const id = `rig-cwd:${cwd}/.claude/plugins/${entry}`;
        const sourceLabel = `rig-cwd:${basename(cwd)}/${entry}`;
        const detected = this.detectPlugin(pluginPath, "rig-cwd", id, sourceLabel);
        if (detected) out.push(detected);
      }
    }
    const codexPluginsDir = join(cwd, ".codex", "plugins");
    if (existsSync(codexPluginsDir)) {
      for (const entry of safeReaddir(codexPluginsDir)) {
        const pluginPath = join(codexPluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const id = `rig-cwd:${cwd}/.codex/plugins/${entry}`;
        const sourceLabel = `rig-cwd:${basename(cwd)}/${entry}`;
        const detected = this.detectPlugin(pluginPath, "rig-cwd", id, sourceLabel);
        if (detected) out.push(detected);
      }
    }

    // Project-local Pi extensions: <cwd>/.pi/extensions/<id>.ts +
    // <cwd>/.pi/extensions/<id>/index.ts (the Pi adapter's projection target,
    // incl. openrig-core). Detection mirrors pi's auto-discovery rules.
    const piExtDir = join(cwd, ".pi", "extensions");
    if (existsSync(piExtDir)) {
      for (const entry of safeReaddir(piExtDir)) {
        const extensionPath = join(piExtDir, entry);
        if (isDir(extensionPath)) {
          const indexPath = join(extensionPath, "index.ts");
          if (!existsSync(indexPath)) continue;
          const id = `rig-cwd:${cwd}/.pi/extensions/${entry}`;
          const sourceLabel = `rig-cwd:${basename(cwd)}/.pi/extensions/${entry}`;
          const detected = this.detectPiExtension(extensionPath, "rig-cwd", id, entry, sourceLabel, indexPath);
          if (detected) out.push(detected);
        } else if (entry.endsWith(".ts")) {
          const id = `rig-cwd:${cwd}/.pi/extensions/${entry.slice(0, -3)}`;
          const sourceLabel = `rig-cwd:${basename(cwd)}/.pi/extensions/${entry}`;
          const detected = this.detectPiExtension(extensionPath, "rig-cwd", id, entry.slice(0, -3), sourceLabel, extensionPath);
          if (detected) out.push(detected);
        }
      }
    }
  }

  getPlugin(id: string): PluginDetail | null {
    // rig-cwd: ids are self-resolvable. listPlugins() only includes cwd
    // discoveries when given cwdScanRoots, so to look up a rig-cwd plugin we
    // parse the cwd back out of the id and re-scan that cwd. ID format (built
    // in scanCwdBundledPlugins):
    //   rig-cwd:<cwd>/.claude/plugins/<plugin>
    //   rig-cwd:<cwd>/.codex/plugins/<plugin>
    //   rig-cwd:<cwd>/.pi/extensions/<plugin>
    const cwdScanRoots = extractCwdFromRigCwdId(id);
    const entry = this.listPlugins(cwdScanRoots ? { cwdScanRoots } : {}).find((p) => p.id === id);
    if (!entry) return null;

    const claudeManifestPath = join(entry.path, CLAUDE_MANIFEST_REL);
    const codexManifestPath = join(entry.path, CODEX_MANIFEST_REL);

    const claudeManifest = readManifest(claudeManifestPath);
    const codexManifest = readManifest(codexManifestPath);

    const skills: PluginSkillSummary[] = [];
    const skillsDir = join(entry.path, "skills");
    if (existsSync(skillsDir)) {
      for (const skillName of safeReaddir(skillsDir)) {
        const skillPath = join(skillsDir, skillName);
        if (isDir(skillPath)) {
          skills.push({ name: skillName, relativePath: `skills/${skillName}` });
        }
      }
    }

    const hooks: PluginHookSummary[] = [];
    const hooksDir = join(entry.path, "hooks");
    if (existsSync(hooksDir)) {
      const claudeHooks = join(hooksDir, "claude.json");
      if (existsSync(claudeHooks)) {
        hooks.push({
          runtime: "claude",
          relativePath: "hooks/claude.json",
          events: extractHookEvents(claudeHooks),
        });
      }
      const codexHooks = join(hooksDir, "codex.json");
      if (existsSync(codexHooks)) {
        hooks.push({
          runtime: "codex",
          relativePath: "hooks/codex.json",
          events: extractHookEvents(codexHooks),
        });
      }
    }

    // MCP server discovery from each runtime's manifest.
    const mcpServers: PluginMcpServerSummary[] = [
      ...readMcpServers(claudeManifest, "claude"),
      ...readMcpServers(codexManifest, "codex"),
    ];

    return { entry, claudeManifest, codexManifest, skills, hooks, mcpServers };
  }

  findUsedBy(pluginId: string): AgentReference[] {
    const refs: AgentReference[] = [];
    if (!existsSync(this.opts.specLibraryDir)) return refs;

    for (const candidate of walkAgentYamls(this.opts.specLibraryDir)) {
      const parsed = safeParseYaml(candidate.content);
      if (!parsed || typeof parsed !== "object") continue;

      const resourcesPlugins = readResourcesPlugins(parsed);
      const declaresThisPlugin = resourcesPlugins.some((p) => p === pluginId);
      if (!declaresThisPlugin) continue;

      const profiles = readProfilesUsingPlugin(parsed, pluginId);
      const agentName = readField(parsed, "name");
      if (!agentName) continue;
      refs.push({ agentName, sourcePath: candidate.path, profiles });
    }
    return refs;
  }

  // -- helpers --

  private detectPlugin(
    pluginPath: string,
    source: PluginSourceKind,
    explicitId: string,
    explicitSourceLabel?: string,
  ): PluginEntry | null {
    const claudeManifestPath = join(pluginPath, CLAUDE_MANIFEST_REL);
    const codexManifestPath = join(pluginPath, CODEX_MANIFEST_REL);
    const piManifestPath = join(pluginPath, PI_MANIFEST_REL);

    const hasClaude = existsSync(claudeManifestPath);
    const hasCodex = existsSync(codexManifestPath);
    const hasPi = existsSync(piManifestPath);
    if (!hasClaude && !hasCodex && !hasPi) return null;

    const runtimes: PluginRuntime[] = [];
    if (hasClaude) runtimes.push("claude");
    if (hasCodex) runtimes.push("codex");
    if (hasPi) runtimes.push("pi");

    // Read the first available manifest for name/version/description.
    const primaryManifestPath = hasClaude ? claudeManifestPath : hasCodex ? codexManifestPath : piManifestPath;
    const manifest = readManifest(primaryManifestPath);
    if (!manifest) return null;

    const name = manifest.name ?? basename(pluginPath);
    const version = manifest.version ?? "unknown";
    const description = manifest.description;

    const sourceLabel = explicitSourceLabel ?? `vendored:${name}`;
    let lastSeenAt: string | null = null;
    try {
      const stat = statSync(primaryManifestPath);
      lastSeenAt = stat.mtime.toISOString();
    } catch {
      lastSeenAt = null;
    }

    // Count skill subdirectories under <plugin>/skills/. Matches the
    // detail-side enumeration in getPlugin() (every shipped skill folder
    // counts, whether or not it has landed a SKILL.md yet).
    let skillCount = 0;
    const skillsDir = join(pluginPath, "skills");
    if (existsSync(skillsDir)) {
      for (const entry of safeReaddir(skillsDir)) {
        if (isDir(join(skillsDir, entry))) skillCount += 1;
      }
    }

    return {
      id: explicitId,
      name,
      version,
      description,
      source,
      sourceLabel,
      runtimes,
      path: pluginPath,
      lastSeenAt,
      skillCount,
      mandatory: MANDATORY_INFRA_PLUGIN_IDS.has(explicitId),
    };
  }

  // Detect a pure Pi extension. Unlike detectPlugin (which requires a
  // .claude-plugin/.codex-plugin/.pi-plugin manifest), Pi extensions are
  // auto-discovered by pi as single `.ts` files or `<id>/index.ts` folders —
  // no manifest. Name/version are derived from the path; runtimes is always
  // ["pi"]. `entryFile` is the discovered entry (.ts file or <id>/index.ts),
  // used for the lastSeenAt mtime.
  private detectPiExtension(
    extensionPath: string,
    source: PluginSourceKind,
    explicitId: string,
    name: string,
    sourceLabel: string,
    entryFile: string,
  ): PluginEntry | null {
    let lastSeenAt: string | null = null;
    try {
      lastSeenAt = statSync(entryFile).mtime.toISOString();
    } catch {
      lastSeenAt = null;
    }
    let skillCount = 0;
    const skillsDir = join(extensionPath, "skills");
    if (isDir(skillsDir)) {
      for (const e of safeReaddir(skillsDir)) {
        if (isDir(join(skillsDir, e))) skillCount += 1;
      }
    }
    return {
      id: explicitId,
      name,
      version: "unknown",
      description: null,
      source,
      sourceLabel,
      runtimes: ["pi"],
      path: extensionPath,
      lastSeenAt,
      skillCount,
      mandatory: MANDATORY_INFRA_PLUGIN_IDS.has(explicitId),
    };
  }
}

// Parse the cwd out of a rig-cwd: id so getPlugin can re-scan that cwd before
// the lookup. Returns the cwd in a single-element array (caller passes it as
// cwdScanRoots) or null when the id is not a rig-cwd: id or has no recognizable
// marker. Tolerant of `/.claude/plugins/`, `/.codex/plugins/`, and
// `/.pi/extensions/` markers (the earliest one wins; a canonical id has one).
const RIG_CWD_PREFIX = "rig-cwd:";
const CLAUDE_MARKER = "/.claude/plugins/";
const CODEX_MARKER = "/.codex/plugins/";
const PI_MARKER = "/.pi/extensions/";
function extractCwdFromRigCwdId(id: string): string[] | null {
  if (!id.startsWith(RIG_CWD_PREFIX)) return null;
  const rest = id.slice(RIG_CWD_PREFIX.length);
  const claudeIdx = rest.indexOf(CLAUDE_MARKER);
  const codexIdx = rest.indexOf(CODEX_MARKER);
  const piIdx = rest.indexOf(PI_MARKER);
  // Whichever marker appears earliest wins; a canonical id contains exactly one.
  let cwd: string | null = null;
  let earliest = Infinity;
  if (claudeIdx >= 0 && claudeIdx < earliest) { cwd = rest.slice(0, claudeIdx); earliest = claudeIdx; }
  if (codexIdx >= 0 && codexIdx < earliest) { cwd = rest.slice(0, codexIdx); earliest = codexIdx; }
  if (piIdx >= 0 && piIdx < earliest) { cwd = rest.slice(0, piIdx); earliest = piIdx; }
  if (!cwd) return null;
  return [cwd];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(manifestPath: string): PluginManifestSummary | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    return {
      raw,
      name: typeof raw.name === "string" ? raw.name : null,
      version: typeof raw.version === "string" ? raw.version : null,
      description: typeof raw.description === "string" ? raw.description : null,
      homepage: typeof raw.homepage === "string" ? raw.homepage : null,
      repository: typeof raw.repository === "string" ? raw.repository : null,
      license: typeof raw.license === "string" ? raw.license : null,
    };
  } catch {
    return null;
  }
}

// Read MCP server declarations from a manifest's `mcpServers` field. The
// Claude/Codex plugin spec convention is
// mcpServers: { <name>: { command, args, transport, ... } }. We surface the
// names + best-effort command/transport for the UI.
function readMcpServers(
  manifest: PluginManifestSummary | null,
  runtime: PluginRuntime,
): PluginMcpServerSummary[] {
  if (!manifest) return [];
  const raw = manifest.raw;
  if (!raw || typeof raw !== "object") return [];
  const mcpServers = (raw as Record<string, unknown>)["mcpServers"];
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return [];
  }
  const out: PluginMcpServerSummary[] = [];
  for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
    let command: string | null = null;
    let transport: string | null = null;
    if (value && typeof value === "object") {
      const config = value as Record<string, unknown>;
      if (typeof config.command === "string") command = config.command;
      if (typeof config.transport === "string") transport = config.transport;
    }
    out.push({ runtime, name, command, transport });
  }
  return out;
}

function extractHookEvents(hooksJsonPath: string): string[] {
  try {
    const data = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as { hooks?: Record<string, unknown> };
    if (data.hooks && typeof data.hooks === "object") {
      return Object.keys(data.hooks);
    }
  } catch {
    // best-effort
  }
  return [];
}

interface AgentYamlCandidate {
  path: string;
  content: string;
}

function walkAgentYamls(rootDir: string): AgentYamlCandidate[] {
  const out: AgentYamlCandidate[] = [];
  walk(rootDir);
  return out;

  function walk(dir: string): void {
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry);
      if (isDir(p)) {
        walk(p);
        continue;
      }
      if (entry === "agent.yaml" || entry === "agent.yml") {
        try {
          const content = readFileSync(p, "utf8");
          out.push({ path: p, content });
        } catch {
          // best-effort; skip unreadable files
        }
      }
    }
  }
}

function safeParseYaml(content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    return null;
  }
}

function readField(obj: unknown, field: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function readResourcesPlugins(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const resources = (spec as Record<string, unknown>)["resources"];
  if (!resources || typeof resources !== "object") return [];
  const plugins = (resources as Record<string, unknown>)["plugins"];
  if (!Array.isArray(plugins)) return [];
  const ids: string[] = [];
  for (const p of plugins) {
    if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
      ids.push((p as Record<string, unknown>).id as string);
    } else if (typeof p === "string") {
      // tolerate shorthand string form for forward-compat
      ids.push(p);
    }
  }
  return ids;
}

function readProfilesUsingPlugin(spec: unknown, pluginId: string): string[] {
  if (!spec || typeof spec !== "object") return [];
  const profiles = (spec as Record<string, unknown>)["profiles"];
  if (!profiles || typeof profiles !== "object") return [];
  const matched: string[] = [];
  for (const [profileName, profileVal] of Object.entries(profiles as Record<string, unknown>)) {
    if (!profileVal || typeof profileVal !== "object") continue;
    const uses = (profileVal as Record<string, unknown>)["uses"];
    if (!uses || typeof uses !== "object") continue;
    const usesPlugins = (uses as Record<string, unknown>)["plugins"];
    if (!Array.isArray(usesPlugins)) continue;
    if (usesPlugins.some((p) => p === pluginId)) {
      matched.push(profileName);
    }
  }
  return matched;
}

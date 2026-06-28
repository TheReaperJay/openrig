import nodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter,
  InstalledResource,
  NodeBinding,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  ResolvedStartupFile,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";

export interface PiAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  homedir?: string;
}

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/**
 * Pi Coding Agent runtime adapter.
 *
 * Projects OpenRig resources to Pi's filesystem layout:
 *   - skills  → <cwd>/.pi/skills/<id>
 *   - guidance → AGENTS.md (managed block merge)
 *   - plugins  → <cwd>/.pi/extensions/<id>/
 *
 * Launches `pi` in the bound tmux session and performs a lightweight
 * readiness probe (foreground process / shell detection).
 */
export class PiCodingAgentAdapter implements RuntimeAdapter {
  readonly runtime = "pi-coding-agent";
  private tmux: TmuxAdapter;
  private fs: PiAdapterFsOps;
  private sessionIdFactory: () => string;
  private sleep: (ms: number) => Promise<void>;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: PiAdapterFsOps;
    sessionIdFactory?: () => string;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sessionIdFactory = deps.sessionIdFactory ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".pi", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }

      try {
        const didProject = this.projectEntry(entry, binding.cwd);
        if (didProject) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".pi", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Pi harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `pi-coding-agent fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the prior session id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "pi-coding-agent fork: forkSource.value is required (parent native_id)" };
      }
      const cmd = `pi --fork ${shellQuote(parentId)} --name ${shellQuote(opts.name)}`;
      const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      // Pi's --fork creates a new session file; OpenRig does not yet scrape
      // the post-fork session id, so we return success without a resume token.
      return { ok: true };
    }

    const model = binding.model?.trim();
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";

    const cmd = opts.resumeToken
      ? `pi --session ${shellQuote(opts.resumeToken)} --name ${shellQuote(opts.name)}${modelArg}`
      : `pi --name ${shellQuote(opts.name)} --session-id ${shellQuote(this.sessionIdFactory())}${modelArg}`;

    const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "pi_session_id" };
    }

    return { ok: true };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";

    // If the pane is back at a shell, the harness exited or failed to start.
    if (isShellReady(paneCommand, paneContent)) {
      return { ready: false, reason: "Pi pane returned to shell instead of staying inside the runtime", code: "returned_to_shell" };
    }

    // Accept node or pi as the foreground process (pi is a node script).
    if (paneCommand === "node" || paneCommand === "pi" || paneCommand?.startsWith("pi")) {
      return { ready: true };
    }

    return { ready: false, reason: "Pi is not yet the active pane process", code: "awaiting_runtime" };
  }

  // -- Private helpers --

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "runtime_resource") {
      // Pi has no runtime_resource fragment types in v1.
      return false;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "plugin" && !this.pluginAppliesToPi(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const sourceRoot = entry.category === "plugin" ? this.resolvePluginSourceRoot(entry) : entry.absolutePath;
    const isDir = this.fs.listFiles ? this.fs.listFiles(sourceRoot).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      for (const file of this.fs.listFiles(sourceRoot)) {
        const src = nodePath.join(sourceRoot, file);
        const dest = nodePath.join(targetDir, file);
        const content = this.fs.readFile(src);
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) continue;
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
      }
    } else {
      const content = this.fs.readFile(sourceRoot);
      const destFile = nodePath.join(targetDir, nodePath.basename(sourceRoot));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) return true;
      this.fs.writeFile(destFile, content);
    }
    return true;
  }

  private pluginAppliesToPi(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "pi") return true;
    if (explicit === "claude" || explicit === "codex") return false;
    // auto: detect via .pi-plugin manifest OR a pi/ extension entry point.
    return (
      this.fs.exists(nodePath.join(entry.absolutePath, ".pi-plugin", "plugin.json")) ||
      this.fs.exists(nodePath.join(entry.absolutePath, "pi", "index.ts"))
    );
  }

  /**
   * Pi plugins project the `pi/` subdirectory when it exists (the extension
   * entry point + relay), otherwise the whole plugin root. This matches how
   * openrig-core ships a shared tree with per-runtime subdirs.
   */
  private resolvePluginSourceRoot(entry: ProjectionEntry): string {
    const piSubdir = nodePath.join(entry.absolutePath, "pi");
    if (this.fs.listFiles && this.fs.listFiles(piSubdir).length > 0) {
      return piSubdir;
    }
    return entry.absolutePath;
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".pi", "skills", entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return null; // Pi has no subagent loader in v1
      case "plugin": return nodePath.join(cwd, ".pi", "extensions", entry.effectiveId);
      case "runtime_resource": return null;
      default: return null;
    }
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Same rig-role collision guard as Claude/Codex adapters.
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private async verifyResumeLaunch(tmuxSession: string): Promise<HarnessLaunchResult> {
    const attempts = 30;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";

      if (paneCommand === "node" || paneCommand === "pi" || paneCommand?.startsWith("pi")) {
        return { ok: true };
      }

      if (isShellReady(paneCommand, paneContent)) {
        return {
          ok: false,
          error: "Pi resume failed: pane returned to shell instead of entering Pi",
          recovery: "retry_fresh",
        };
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    return {
      ok: false,
      error: "Pi resume could not be confirmed: the process is alive but a restored session was never proven.",
      recovery: "attention_required",
    };
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isShellReady(paneCommand: string | null, paneContent: string): boolean {
  return !!(paneCommand && SHELL_COMMANDS.has(paneCommand) && paneContent.trim().length > 0);
}

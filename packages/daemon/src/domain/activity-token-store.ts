import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Activity-hook token: the shared secret between the daemon and the
 * in-harness plugin relays (claude / codex / pi). The daemon validates
 * POSTs to /api/activity/hooks against it; the relays send it as a
 * Bearer header. Both sides must hold the SAME value.
 *
 * Lifecycle: the token is daemon-owned and daemon-global (one secret
 * validates every seat across every rig). It is minted ONCE on first
 * daemon start, persisted to disk (mode 0600), and reused across
 * restarts so that surviving tmux seats (which keep the token they were
 * launched with, and whose env cannot be re-injected into a running
 * pane) keep working after a daemon restart or reboot.
 *
 * An operator may force/rotate the value via the OPENRIG_ACTIVITY_HOOK_TOKEN
 * env var (highest precedence), e.g. for reproducible deployments.
 */

const TOKEN_FILE_NAME = "activity-hook-token";
const TOKEN_BYTES = 32;

export interface ActivityTokenDeps {
  /** Operator-supplied override from env (highest precedence). */
  envOverride?: string;
  /** OPENRIG_HOME — where the persisted token file lives. */
  homeDir: string;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  /** Must be atomic + enforce 0600. */
  writeFile?: (p: string, data: string) => void;
  randomBytes?: (n: number) => string;
}

export function activityTokenFilePath(homeDir: string): string {
  return path.join(homeDir, TOKEN_FILE_NAME);
}

/**
 * Resolve the activity-hook token, minting + persisting on first use.
 * Pure + injectable for tests (all fs/crypto behind deps).
 */
export function resolveActivityToken(deps: ActivityTokenDeps): string {
  const override = (deps.envOverride ?? "").trim();
  if (override.length > 0) return override;

  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = deps.writeFile ?? defaultAtomicWrite0600;
  const randomBytes = deps.randomBytes ?? ((n: number) => nodeRandomBytes(n).toString("hex"));

  const tokenPath = activityTokenFilePath(deps.homeDir);

  if (exists(tokenPath)) {
    const persisted = readFile(tokenPath).trim();
    if (persisted.length > 0) return persisted;
  }

  const minted = randomBytes(TOKEN_BYTES);
  if (minted.length === 0) {
    throw new Error("activity-hook-token: randomBytes returned an empty value");
  }
  writeFile(tokenPath, minted);
  return minted;
}

/**
 * Derive the OPENRIG_URL the in-harness relay should POST to, from the
 * daemon's ACTUAL bound hosts + port. The relay is a same-machine
 * control channel, so loopback is the preferred target when it is
 * actually bound; otherwise any bound host is reachable from the local
 * seat. No host is invented — only values that are genuinely in
 * bindHosts are used. (Operator env override still wins at the caller.)
 */
export function deriveActivityHookUrl(bindHosts: string[], port: number): string | null {
  if (!bindHosts || bindHosts.length === 0 || !port) return null;
  const host =
    bindHosts.find((h) => h === "127.0.0.1" || h === "localhost" || h === "::1") ??
    bindHosts[0]!;
  return `http://${host}:${port}`;
}

/**
 * Default writer: atomic (temp file in the same dir + rename) and 0600.
 * Writes to the same directory as the target so the rename is atomic on
 * the same filesystem. chmod is explicit because writeFileSync mode is
 * masked by umask and is not guaranteed across platforms.
 */
function defaultAtomicWrite0600(targetPath: string, data: string): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `.${base}.${nodeRandomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    chmodSync(tmp, 0o600);
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

// Exported only for tests that want to exercise the temp-dir plumbing.
export const __testing = {
  mkdtempSync,
  tmpdir,
  createHash,
};

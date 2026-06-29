import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveActivityToken,
  deriveActivityHookUrl,
  activityTokenFilePath,
} from "../src/domain/activity-token-store.js";

function makeTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "openrig-tok-"));
}

describe("resolveActivityToken", () => {
  it("mints + persists on first call, reuses on subsequent calls", () => {
    const home = makeTempHome();
    const files = new Map<string, string>();
    let mintCount = 0;
    const deps = {
      envOverride: undefined,
      homeDir: home,
      exists: (p: string) => files.has(p),
      readFile: (p: string) => files.get(p) ?? "",
      writeFile: (p: string, data: string) => { files.set(p, data); },
      randomBytes: () => { mintCount++; return `minted-${mintCount}`; },
    };

    const first = resolveActivityToken(deps);
    expect(first).toBe("minted-1");
    expect(mintCount).toBe(1);

    // Second call reuses the persisted value — no re-mint.
    const second = resolveActivityToken(deps);
    expect(second).toBe("minted-1");
    expect(mintCount).toBe(1);

    // The persisted file lives at the documented path.
    expect(files.has(activityTokenFilePath(home))).toBe(true);
    expect(files.get(activityTokenFilePath(home))).toBe("minted-1");
  });

  it("env override wins over a persisted file", () => {
    const home = makeTempHome();
    const files = new Map<string, string>([[activityTokenFilePath(home), "persisted-value"]]);
    let minted = false;
    const token = resolveActivityToken({
      envOverride: "operator-forced",
      homeDir: home,
      exists: (p) => files.has(p),
      readFile: (p) => files.get(p) ?? "",
      writeFile: () => { minted = true; },
      randomBytes: () => { minted = true; return "should-not-happen"; },
    });
    expect(token).toBe("operator-forced");
    expect(minted).toBe(false);
  });

  it("reuses an existing persisted token without minting", () => {
    const home = makeTempHome();
    const files = new Map<string, string>([[activityTokenFilePath(home), "pre-existing"]]);
    let minted = false;
    const token = resolveActivityToken({
      envOverride: undefined,
      homeDir: home,
      exists: (p) => files.has(p),
      readFile: (p) => files.get(p) ?? "",
      writeFile: () => { minted = true; },
      randomBytes: () => { minted = true; return "x"; },
    });
    expect(token).toBe("pre-existing");
    expect(minted).toBe(false);
  });

  it("mints when env override is empty/whitespace", () => {
    const home = makeTempHome();
    const files = new Map<string, string>();
    const token = resolveActivityToken({
      envOverride: "   ",
      homeDir: home,
      exists: (p) => files.has(p),
      readFile: (p) => files.get(p) ?? "",
      writeFile: (p, d) => { files.set(p, d); },
      randomBytes: () => "fresh-mint",
    });
    expect(token).toBe("fresh-mint");
  });

  it("throws if the random source returns empty", () => {
    const home = makeTempHome();
    expect(() =>
      resolveActivityToken({
        envOverride: undefined,
        homeDir: home,
        exists: () => false,
        readFile: () => "",
        writeFile: () => {},
        randomBytes: () => "",
      }),
    ).toThrow();
  });
});

describe("deriveActivityHookUrl", () => {
  it("prefers loopback when it is actually bound", () => {
    expect(deriveActivityHookUrl(["127.0.0.1", "100.112.242.25"], 7433)).toBe("http://127.0.0.1:7433");
  });

  it("uses a bound host when loopback is not bound (operator explicit non-loopback host)", () => {
    expect(deriveActivityHookUrl(["9.9.9.9"], 7000)).toBe("http://9.9.9.9:7000");
  });

  it("prefers tailscale over the first array entry when loopback is absent", () => {
    expect(deriveActivityHookUrl(["100.112.242.25"], 7433)).toBe("http://100.112.242.25:7433");
  });

  it("returns null when there are no bound hosts or no port", () => {
    expect(deriveActivityHookUrl([], 7433)).toBeNull();
    expect(deriveActivityHookUrl(["127.0.0.1"], 0)).toBeNull();
    expect(deriveActivityHookUrl(["127.0.0.1"], undefined as unknown as number)).toBeNull();
  });
});

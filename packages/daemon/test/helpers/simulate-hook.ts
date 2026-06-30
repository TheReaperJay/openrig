import type { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import type { NodeBinding } from "../../src/domain/runtime-adapter.js";

/**
 * Test-only simulation of a managed harness firing its native SessionStart
 * hook. Drives the SAME pipeline production uses
 * (`AgentActivityStore.recordHookEvent` -> `eventBus.emit("agent.activity")`),
 * i.e. the `/api/activity` route's core, not a parallel emit. This is the
 * single source of truth for "the harness booted" in tests.
 *
 * Deferred to a macrotask: the orchestrator's readiness wait subscribes to the
 * EventBus AFTER `launchHarness` returns, so the hook must land later than the
 * subscribe registration. Guarded so a macrotask left pending past test
 * teardown (db closed) does not throw, mirroring production where a late relay
 * POST would simply be refused.
 */
export function simulateSessionStart(
  store: AgentActivityStore,
  opts: { nodeId: string; runtime?: string; source?: string | null; occurredAt?: string },
) {
  setTimeout(() => {
    try {
      store.recordHookEvent({
        nodeId: opts.nodeId,
        runtime: opts.runtime,
        hookEvent: "SessionStart",
        subtype: opts.source ?? null,
        occurredAt: opts.occurredAt ?? new Date().toISOString(),
      });
    } catch {
      // Daemon already torn down by test teardown.
    }
  }, 0);
}

/**
 * A `launchHarness` that simulates the harness booting then firing its
 * SessionStart through the real pipeline, returning `returnValue` (default
 * `{ ok: true }`). Use for mock adapters consumed by `startNode`.
 */
export function makeHookFiringLaunchHarness<T extends { ok: true } = { ok: true }>(
  store: AgentActivityStore,
  runtime: string,
  returnValue?: T,
) {
  return async (binding: NodeBinding): Promise<T> => {
    simulateSessionStart(store, { nodeId: binding.nodeId, runtime });
    return (returnValue ?? { ok: true }) as T;
  };
}
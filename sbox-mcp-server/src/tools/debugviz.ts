import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Debug-visualization & playtest meta-tools ported from the Unity bridge's
 * engine/workflow layer (see docs/plans/2026-06-17-unity-carryover-meta-tools.md).
 *
 * Currently: set_time_scale + get_profiler_stats (Unity carry-over wave, 2 of 4).
 * Planned next: debug_draw_* + debug_clear (Gizmo.Draw edit-mode + DebugOverlay
 * play-mode) and run_tests (dotnet test spike).
 */
export function registerDebugVizTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── set_time_scale ───────────────────────────────────────────────
  server.tool(
    "set_time_scale",
    "Set the running game's time scale DURING PLAY MODE (ported from Unity's playtest_set_time_scale). 0 = pause, 1 = normal, 0.1 = slow-mo to watch a fast interaction frame-by-frame, 2+ = fast-forward idle/economy ticks. Requires start_play first — the edit scene doesn't tick, so this no-ops outside play mode and returns an error. Sets Game.ActiveScene.TimeScale (clamped to 0–100). Returns the applied and previous values.",
    {
      scale: z
        .number()
        .min(0)
        .describe(
          "Time multiplier: 0 = pause, 1 = normal speed, 0.1 = slow-mo, 2 = double speed. Clamped to 0–100"
        ),
    },
    async (params) => {
      const res = await bridge.send("set_time_scale", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── get_profiler_stats ───────────────────────────────────────────
  server.tool(
    "get_profiler_stats",
    "Read live engine performance counters (ported from Unity's get_profiler_stats): FPS, frame ms, GPU ms, bytes allocated, process memory, exception count, and per-category timings (update/physics/ui/render/network/gcPause) averaged over `frames`. Reads Sandbox.Diagnostics.PerformanceStats. Most meaningful during play (call start_play first) but populated in the editor too. Read-only.",
    {
      frames: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "Averaging window (frames) for the per-category timings. Default 60"
        ),
    },
    async (params) => {
      const res = await bridge.send("get_profiler_stats", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Inspection & validation tools — the high-leverage gaps surfaced by mining 27 shipped
 * s&box games. These let an assistant VERIFY the things that are otherwise invisible from
 * a single editor instance: networking authority, save state, input-driven behavior, and
 * scene/networking correctness.
 *
 *   inspect_networked_object — per-object Network.Owner/IsProxy/[Sync] values (vs session-only get_network_status)
 *   networking_lint          — static scan for unguarded [Sync] mutators, money-as-[Sync], List-as-[Sync], etc.
 *   scene_validate           — missing camera/controller, multiple root Rigidbodies, IsTrigger-vs-trace footguns
 *   save_inspect             — list/read/diff FileSystem.Data save files (21 of 27 games persist; assistant was blind)
 *   services_query           — Sandbox.Services Stats / leaderboard reads
 *   simulate_input           — press/release a named action + AnalogMove/Look during play (drive movement/IPressable/weapons)
 */
export function registerInspectionTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── inspect_networked_object ──────────────────────────────────────
  server.tool(
    "inspect_networked_object",
    "Inspect the live networking contract of a GameObject: Network.Owner/IsProxy/IsOwner/Active, OwnerTransfer + OrphanedMode, and every component's [Sync] property names, SyncFlags, and current values (host vs proxy). Unlike get_network_status (session-only), this is per-object — the way to verify a host-authoritative or ownership change actually replicated. Works in edit or play mode.",
    {
      id: z.string().describe("GUID of the GameObject to inspect"),
      allProps: z
        .boolean()
        .default(false)
        .describe("Include all component properties, not just [Sync]-marked ones"),
    },
    async (params) => {
      const res = await bridge.send("inspect_networked_object", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── networking_lint ───────────────────────────────────────────────
  server.tool(
    "networking_lint",
    "Static-scan the project's C# for the highest-frequency networking/authority bugs: a mutator that writes a [Sync] field with no IsProxy/Networking.IsHost guard; money/health/score-shaped fields marked plain [Sync] (should be SyncFlags.FromHost); List<>/Dictionary<> marked [Sync] (should be NetList/NetDictionary); [Sync] fields typed Connection/GameObject (sync a Guid instead); [Rpc.Host] methods that mutate without re-checking Rpc.Caller; and component swaps / reflection writes missing Network.Refresh(). Returns findings with file:line + the suggested fix.",
    {
      path: z
        .string()
        .optional()
        .describe("Optional sub-path under the project (e.g. 'Code/Player') to scope the scan; omit for the whole project"),
    },
    async (params) => {
      const res = await bridge.send("networking_lint", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── scene_validate ────────────────────────────────────────────────
  server.tool(
    "scene_validate",
    "Validate the active scene for the silent setup footguns that break controllers/physics/cameras: no CameraComponent, no player controller, multiple root Rigidbodies, a Rigidbody with MotionEnabled=false fighting a kinematic root, IsTrigger colliders that Scene.Trace will ignore, child Rigidbodies breaking collider binding, and missing required child anchors. Returns each issue with the GameObject and the exact fix.",
    {},
    async () => {
      const res = await bridge.send("scene_validate", {});
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── save_inspect ──────────────────────────────────────────────────
  server.tool(
    "save_inspect",
    "Inspect the game's FileSystem.Data save files — the assistant is otherwise blind to persisted state. action='list' enumerates files under a folder (with size/mtime); action='read' dumps a save file's JSON; action='diff' compares two save files key-by-key. Use to verify a save actually wrote, debug a load/migration, or confirm a sanitize/clamp ran.",
    {
      action: z.enum(["list", "read", "diff"]).default("list"),
      path: z
        .string()
        .optional()
        .describe("File or folder path under FileSystem.Data (e.g. 'lumber_corp2_progress' or '<folder>/steam_123.json')"),
      pathB: z
        .string()
        .optional()
        .describe("Second file path for action='diff'"),
    },
    async (params) => {
      const res = await bridge.send("save_inspect", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── services_query ────────────────────────────────────────────────
  server.tool(
    "services_query",
    "Read from Sandbox.Services — the cloud stats/leaderboard layer many games use as their real DB. action='stats' lists/reads the project's stat definitions and the local player's values; action='leaderboard' fetches a leaderboard board's top entries. Read-only. Use to verify a Stats.Increment/SetValue path or a leaderboard wired correctly.",
    {
      action: z.enum(["stats", "leaderboard"]).default("stats"),
      name: z
        .string()
        .optional()
        .describe("Stat name (action='stats') or leaderboard/board name (action='leaderboard')"),
      limit: z.number().int().default(10).describe("Max leaderboard entries to return"),
    },
    async (params) => {
      const res = await bridge.send("services_query", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── simulate_input ────────────────────────────────────────────────
  server.tool(
    "simulate_input",
    "Synthesize player input during PLAY mode so behavior can be verified without a human at the keyboard: press/hold/release a named input action (e.g. 'jump','attack1','use','reload') and/or set AnalogMove / AnalogLook for a duration. Drives movement, IPressable interactions, weapon fire/cooldown/reload, vehicle controls, and HUD advance-on-click. Requires play mode.",
    {
      action: z
        .string()
        .optional()
        .describe("Named input action to drive (must exist in Input.config), e.g. 'jump', 'attack1', 'use'"),
      state: z
        .enum(["press", "hold", "release"])
        .default("press")
        .describe("press = one tick (Pressed); hold = held for durationMs; release = clear a held action"),
      analogMove: z
        .union([
          z.object({ x: z.number(), y: z.number(), z: z.number().default(0) }),
          z.string().describe('Comma string "x,y,z", e.g. "1,0,0"'),
        ])
        .optional()
        .describe('AnalogMove vector to apply (forward/left) — object {x,y,z} or comma string "x,y,z"'),
      analogLook: z
        .object({ pitch: z.number(), yaw: z.number(), roll: z.number().default(0) })
        .optional()
        .describe("AnalogLook angles delta to apply"),
      durationMs: z
        .number()
        .int()
        .default(100)
        .describe("How long to hold the action / apply the analog values"),
    },
    async (params) => {
      const res = await bridge.send("simulate_input", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );
}

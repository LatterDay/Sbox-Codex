import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * NPC Brains (Feature Wave #3) — give bridge-built NPCs actual behavior.
 *
 * create_npc_brain generates a finite-state-machine Component (idle/patrol/
 * wander/chase/search/flee/ambush) driven by occlusion-aware perception (FOV
 * cone + range + line-of-sight trace + hearing) with last-known-position
 * memory — the decision layer on top of the existing movement substrate
 * (bake_navmesh / get_navmesh_path / create_npc_controller). place_patrol_route
 * + assign_patrol_route make a patrol authorable end-to-end; create_npc_spawner
 * is the swarm/wave backbone. simulate_npc_perception is the keystone verifier:
 * it runs the EXACT line-of-sight check the brain uses, in EDIT mode, without
 * play — so "does the tree block the NPC's view" is checkable structurally
 * (the bridge can't see a real chase in a single static screenshot).
 *
 * Mirrors the templates.ts / navigation.ts module shape: zod params, one
 * bridge.send per tool, JSON.stringify(res.data) on success.
 */

// A world-space Vector3 accepted as EITHER an object {x,y,z} OR a comma string
// "x,y,z", passed through unchanged. The C# handler parses both forms (source of
// truth). See the cross-language vector/color contract.
const Vec3 = z
  .union([
    z.object({
      x: z.number().describe("X"),
      y: z.number().describe("Y"),
      z: z.number().describe("Z"),
    }),
    z.string().describe('Comma string "x,y,z", e.g. "0,0,200"'),
  ])
  .describe('A world-space Vector3 — object {x,y,z} OR comma string "x,y,z"');

export function registerNpcTools(server: McpServer, bridge: BridgeClient): void {
  // ── create_npc_brain ──────────────────────────────────────────────
  server.tool(
    "create_npc_brain",
    "Generate an NpcBrain Component: a behavior state machine (Idle/Patrol/Wander/Chase/Search/Flee/Ambush) driven by occlusion-aware perception — FOV cone + sight range + a line-of-sight trace (respects walls/trees) + proximity hearing — with last-known-position memory (lose-LOS -> search -> give up -> resume). This is the decision layer on top of bake_navmesh / NavMeshAgent movement. Pick a behavior preset, then tune via the generated [Property] fields with set_property. After generating: trigger_hotload + get_compile_errors, place a route with place_patrol_route + assign_patrol_route, bake_navmesh, and verify perception in EDIT mode with simulate_npc_perception (chase/search behavior needs play mode). The component is added to a GameObject like any other; it auto-adds a NavMeshAgent in OnStart.",
    {
      name: z
        .string()
        .optional()
        .describe("Class/file name. Defaults to 'NpcBrain'. Sanitized to a valid C# identifier."),
      directory: z
        .string()
        .optional()
        .describe("Subdirectory under the project root for the .cs file. Defaults to 'Code'."),
      behavior: z
        .enum(["patrol", "guard", "hunter", "swarm", "skittish"])
        .optional()
        .describe(
          "Preset (sets StartState + flee toggle): 'patrol' (walk waypoints), 'guard' (Ambush near spawn until a target enters range), 'hunter' (patrol->chase->search, the Sasquatch), 'swarm' (wander/idle->chase nearest, RUN mobs), 'skittish' (chase but flee on low health). The generated file is the same shape; the preset just changes defaults. Defaults to 'hunter'."
        ),
      targetTag: z
        .string()
        .optional()
        .describe("Tag the NPC hunts (its candidates are GameObjects with this tag). Defaults to 'player'."),
      moveSpeed: z.number().optional().describe("Patrol/wander speed (NavMeshAgent MaxSpeed). Default 130."),
      chaseSpeed: z.number().optional().describe("Chase/flee speed. Default 200."),
      sightRange: z.number().optional().describe("Max sight distance. Default 1500."),
      fovDegrees: z
        .number()
        .optional()
        .describe("Full field-of-view cone angle in degrees. Default 110. (Baked into a cosine threshold for cheap, trig-free checks.)"),
      eyeHeight: z.number().optional().describe("Trace origin height above the NPC's feet. Default 64."),
      hearingRadius: z
        .number()
        .optional()
        .describe("Proximity-hearing radius — a target within it is investigated (sets last-known-pos) but NOT instantly aggroed. Default 600."),
      giveUpTime: z
        .number()
        .optional()
        .describe("Seconds to search after losing line-of-sight before giving up and resuming the start state. Default 6."),
      searchRadius: z.number().optional().describe("Wander radius around the last-known position while searching. Default 400."),
      waypointStopDistance: z
        .number()
        .optional()
        .describe("How close the NPC must get to a waypoint/target before it counts as reached. Default 80."),
      canFlee: z.boolean().optional().describe("Enable the Flee state (else the NPC never flees). Defaults from the preset."),
      fleeHealthFrac: z
        .number()
        .optional()
        .describe("Flee when CurrentHealthFrac drops to/below this (the game sets CurrentHealthFrac 0..1). Default 0.25."),
      networked: z
        .boolean()
        .optional()
        .describe(
          "When true (default), emit a host-authoritative brain: 'if (IsProxy) return;' + [Sync] CurrentState. NOTE: a no-session solo playtest makes everything a proxy, so a networked brain won't think until a host session exists — pass false to iterate solo in the edit scene."
        ),
    },
    async (params) => {
      const res = await bridge.send("create_npc_brain", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── place_patrol_route ────────────────────────────────────────────
  server.tool(
    "place_patrol_route",
    "Place a set of waypoint GameObjects (tagged empties) for a patrol route and group them under a parent route object — authorable in one call. Optionally snaps each point to the ground (raycast down) so waypoints sit on the navmesh, not floating. Returns the route parent GUID + ordered waypoint GUIDs to feed into assign_patrol_route. Validate connectivity afterward with get_navmesh_path between consecutive waypoints (catches a 'point in a wall').",
    {
      points: z
        .array(Vec3)
        .min(2)
        .describe("Ordered world positions for the route (at least 2)."),
      name: z.string().optional().describe("Route name. Defaults to 'PatrolRoute'. Waypoints are named <route>_WP0, _WP1, ..."),
      tag: z.string().optional().describe("Tag applied to each waypoint. Defaults to 'waypoint'."),
      snapToGround: z
        .boolean()
        .optional()
        .describe("Drop each point onto the surface below via a downward raycast. Default true."),
      parentId: z
        .string()
        .optional()
        .describe("Existing parent GameObject GUID to nest the waypoints under; otherwise a new route empty is created at the points' centroid."),
    },
    async (params) => {
      const res = await bridge.send("place_patrol_route", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── assign_patrol_route ───────────────────────────────────────────
  server.tool(
    "assign_patrol_route",
    "Wire a placed route (or an arbitrary ordered GUID list) into an NpcBrain's Waypoints list on a target NPC. This is the list-of-GameObject-references case that plain set_property can't express. Pass either waypointIds (explicit order) or routeId (a route parent whose children become the waypoints in hierarchy order). The list count is returned; List<GameObject> refs may read back as handles/GUIDs via get_property, so trust the count or confirm patrol in play mode.",
    {
      npcId: z
        .string()
        .describe("GUID of the GameObject holding the NpcBrain (or any component with a List<GameObject> waypoint property)."),
      waypointIds: z
        .array(z.string())
        .optional()
        .describe("Ordered waypoint GameObject GUIDs (e.g. from place_patrol_route). Takes precedence over routeId."),
      routeId: z
        .string()
        .optional()
        .describe("A route parent GUID whose children (in hierarchy order) become the waypoints."),
      property: z
        .string()
        .optional()
        .describe("The List<GameObject> property name to set. Defaults to 'Waypoints'. (Use 'SpawnPoints' to wire spawn points on a spawner.)"),
    },
    async (params) => {
      const res = await bridge.send("assign_patrol_route", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── create_npc_spawner ────────────────────────────────────────────
  server.tool(
    "create_npc_spawner",
    "Generate a spawner Component that instantiates an NPC prefab over time / in escalating waves at spawn points, capped by maxAlive. RUN's swarm backbone and Sasquatched's round-start spawn. After generating: set NpcPrefab via set_prefab_ref, set SpawnPoints (reuse place_patrol_route to make a set of empties, then assign_patrol_route with property='SpawnPoints'), trigger_hotload + get_compile_errors. Verify by watching the GameObject count over time in play mode. Networked spawns use NetworkSpawn() and are host-only.",
    {
      name: z.string().optional().describe("Class/file name. Defaults to 'NpcSpawner'."),
      directory: z.string().optional().describe("Subdirectory under the project root. Defaults to 'Code'."),
      mode: z
        .enum(["continuous", "waves", "burst"])
        .optional()
        .describe(
          "'continuous' (one every interval), 'waves' (a batch every interval, waveCount times), 'burst' (one batch then stop). Default 'waves'."
        ),
      count: z.number().optional().describe("NPCs per wave (waves) or per batch (burst/continuous batch). Default 5."),
      interval: z.number().optional().describe("Seconds between spawns (continuous) or between waves (waves). Default 8."),
      waveCount: z.number().optional().describe("Number of waves (waves mode). Default 3."),
      waveGrowth: z
        .number()
        .optional()
        .describe("Multiply count each wave (>1 = escalating). Default 1.0."),
      radius: z.number().optional().describe("Random scatter radius around a spawn point. Default 200."),
      maxAlive: z
        .number()
        .optional()
        .describe("Cap on concurrent live NPCs (important so swarms don't melt the frame rate). Default 12."),
      networked: z
        .boolean()
        .optional()
        .describe("When true (default), spawn via NetworkSpawn() (host-only, try/catch solo-safe) so clients see the NPCs; false = a plain local Clone for solo/edit testing."),
    },
    async (params) => {
      const res = await bridge.send("create_npc_spawner", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── simulate_npc_perception ───────────────────────────────────────
  server.tool(
    "simulate_npc_perception",
    "READ-ONLY edit-mode verifier: evaluate the NPC's perception math RIGHT NOW without entering play mode. Given an NPC (reads its NpcBrain SightRange/FovDegrees/EyeHeight/TargetTag + transform) and either a targetId or a point, it runs the SAME line-of-sight check the brain uses — FOV cone (dot vs the baked cosine), sight-range gate, and an occlusion trace from the eye to the target — and reports the result AND why. This is the keystone verifier: it makes the perception layer checkable in edit mode (no flaky screenshot timing) — e.g. place the Sasquatch, place a camper behind a tree, and confirm the tree blocks LOS. Call params override the brain's values, so it also works before/without an NpcBrain (uses defaults). Safe in play mode too (read-only, like raycast).",
    {
      npcId: z
        .string()
        .describe("GUID of the NPC GameObject (ideally with an NpcBrain; its perception [Property] values are read)."),
      targetId: z
        .string()
        .optional()
        .describe("GUID of the target GameObject to test visibility to (e.g. a player). Provide this OR point."),
      point: Vec3.optional().describe("A raw world point to test visibility to. Provide this OR targetId."),
      sightRange: z.number().optional().describe("Override the sight range for this check (else read from the NpcBrain / default 1500)."),
      fovDegrees: z.number().optional().describe("Override the FOV cone angle for this check (else read from the NpcBrain / default 110)."),
      eyeHeight: z.number().optional().describe("Override the eye height for this check (else read from the NpcBrain / default 64)."),
      targetTag: z
        .string()
        .optional()
        .describe("Override the target tag (canSee also requires the target to carry this tag; else read from the NpcBrain / default 'player')."),
    },
    async (params) => {
      const res = await bridge.send("simulate_npc_perception", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

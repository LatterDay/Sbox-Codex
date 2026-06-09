import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Gameplay scaffold tools — Phase 1 of "playable game in one ask".
 *
 * Two low-level capability gap-fillers:
 *   - set_component_reference   wire a component property to a LIVE scene object
 *   - add_component_to_new_object  atomic create-GO + add-component + props
 *
 * Three system scaffolds (generate a clean, self-contained .cs, optionally place it):
 *   - create_objective_system   the win/lose primitive (ObjectiveManager)
 *   - create_health_system      Health/damage component
 *   - create_pickup             trigger-based collectible
 *
 * The `sbox-scaffold-game` skill orchestrates these into a playable starter.
 * All scene/file-mutating; refused during play mode by the bridge dispatch.
 */

// A 3D vector accepted as EITHER an object {x,y,z} OR a comma string "x,y,z",
// passed through unchanged. The C# handler parses both forms (source of truth).
// See the cross-language vector/color contract.
const Vector3Object = z.object({
  x: z.number().describe("X coordinate"),
  y: z.number().describe("Y coordinate"),
  z: z.number().describe("Z coordinate"),
});

const Vector3Schema = z
  .union([
    Vector3Object,
    z.string().describe('Comma string "x,y,z", e.g. "0,0,200"'),
  ])
  .describe('3D vector — object {x,y,z} OR comma string "x,y,z"');

const RotationSchema = z
  .object({
    pitch: z.number().describe("Pitch angle in degrees"),
    yaw: z.number().describe("Yaw angle in degrees"),
    roll: z.number().describe("Roll angle in degrees"),
  })
  .describe("Euler rotation with pitch, yaw, roll in degrees");

export function registerGameplayTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── set_component_reference ───────────────────────────────────────
  // Assign one scene GameObject (or a component on it) to a component property.
  // set_property can now also set a GameObject/Component ref from a GUID, but this
  // tool is the ergonomic choice for refs: it can pull a specific component type off
  // the target (targetComponent) and validates the wiring. set_prefab_ref is for
  // PREFAB assets. Wires live scene objects: Spawner.SpawnPoint = thatEmpty,
  // Camera follows thatPlayer, Door.Hinge = thatPivot.
  server.tool(
    "set_component_reference",
    "Wire a component's GameObject/Component-typed property to ANOTHER live object in the scene by GUID (e.g. ObjectiveManager.Player = the player, a camera's follow target, a door's hinge). Preferred for object/component refs (can pick a specific component type off the target via targetComponent, and validates). set_property also accepts a GUID for ref props; set_prefab_ref is for prefab assets. Set clear:true to null the reference",
    {
      id: z
        .string()
        .describe("GUID of the GameObject that HOLDS the component you're writing into"),
      component: z
        .string()
        .describe("Component type name on that object (e.g. 'ObjectiveManager', 'CameraComponent')"),
      property: z
        .string()
        .describe("The property to set (must be a GameObject- or Component-typed property)"),
      targetId: z
        .string()
        .optional()
        .describe("GUID of the GameObject to reference. Required unless clear:true"),
      targetComponent: z
        .string()
        .optional()
        .describe("If the property is a Component subtype, the specific component type to pull off the target object. Omit to auto-match by the property's type"),
      clear: z
        .boolean()
        .optional()
        .describe("If true, set the reference to null instead of assigning a target"),
    },
    async (params) => {
      const res = await bridge.send("set_component_reference", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_component_to_new_object ───────────────────────────────────
  server.tool(
    "add_component_to_new_object",
    "Create a new GameObject, add a component, set its properties, and optionally parent/position/tag it — all in one atomic call. Collapses the create_gameobject → add_component_with_properties → set_parent sequence. NOTE: a freshly GENERATED component type only resolves after a trigger_hotload; generate the script, hotload, THEN call this",
    {
      name: z
        .string()
        .optional()
        .describe("Display name for the new GameObject. Defaults to the component type name"),
      component: z
        .string()
        .describe("Component type name to add (e.g. 'CameraComponent', 'ObjectiveManager'). Use list_available_components to find valid types"),
      properties: z
        .record(z.unknown())
        .optional()
        .describe("Key-value map of property names to values, auto-converted to the right type (same convention as add_component_with_properties)"),
      position: Vector3Schema.optional().describe("World position"),
      rotation: RotationSchema.optional().describe("World rotation"),
      scale: Vector3Schema.optional().describe("World scale (per-axis)"),
      parentId: z
        .string()
        .optional()
        .describe("GUID of a parent GameObject. Omit for scene root"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags to add to the new GameObject (e.g. ['player'])"),
    },
    async (params) => {
      const res = await bridge.send("add_component_to_new_object", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── create_objective_system ───────────────────────────────────────
  // The win/lose primitive — turns "objects in a scene" into "a game with a goal".
  server.tool(
    "create_objective_system",
    "Generate an ObjectiveManager component — the win/lose brain of a game. Tracks an objective (collect_all / reach_goal / survive_time / eliminate_all), fires a win, and handles a lose condition (fall below kill-Z / timer / out of lives). Self-contained C#; other systems call ObjectiveManager.Instance. Optionally placed as a scene singleton",
    {
      name: z
        .string()
        .optional()
        .describe("Class name. Defaults to 'ObjectiveManager'"),
      directory: z
        .string()
        .optional()
        .describe("Subdirectory for the .cs file. Defaults to 'Code'"),
      objective: z
        .enum(["collect_all", "reach_goal", "survive_time", "eliminate_all"])
        .optional()
        .describe("Win condition. Defaults to 'reach_goal'"),
      targetCount: z
        .number()
        .int()
        .optional()
        .describe("How many to collect/eliminate (for collect_all / eliminate_all). Defaults to 3"),
      timeLimit: z
        .number()
        .optional()
        .describe("Seconds — survive this long to win (survive_time) or before losing (loseOn=timer). Defaults to 60"),
      loseOn: z
        .enum(["fall", "timer", "lives", "none"])
        .optional()
        .describe("Lose condition. 'fall' = player drops below killZ. Defaults to 'fall'"),
      killZ: z
        .number()
        .optional()
        .describe("World Z below which the player is considered fallen out of the world. Defaults to -1000"),
      lives: z
        .number()
        .int()
        .optional()
        .describe("Lives before game over (loseOn=lives). Defaults to 1"),
      placeInScene: z
        .boolean()
        .optional()
        .describe("Place the manager as a scene singleton. Defaults to true. (Only attaches if the type is already loaded — generate, hotload, then it places; otherwise add it after hotload.)"),
    },
    async (params) => {
      const res = await bridge.send("create_objective_system", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── create_health_system ──────────────────────────────────────────
  server.tool(
    "create_health_system",
    "Generate a Health component: MaxHealth, [Sync] CurrentHealth, TakeDamage/Heal, an OnDeath event, optional regen and respawn. Host-authoritative damage when networked, single-player safe. Optionally attached to an existing GameObject by GUID",
    {
      name: z.string().optional().describe("Class name. Defaults to 'Health'"),
      directory: z
        .string()
        .optional()
        .describe("Subdirectory for the .cs file. Defaults to 'Code'"),
      maxHealth: z
        .number()
        .optional()
        .describe("Starting/maximum health. Defaults to 100"),
      regen: z
        .boolean()
        .optional()
        .describe("Include passive health regeneration after a delay. Defaults to false"),
      respawn: z
        .boolean()
        .optional()
        .describe("On death, respawn at a RespawnPoint (wire it with set_component_reference) instead of disabling. Defaults to false"),
      targetId: z
        .string()
        .optional()
        .describe("GUID of an existing GameObject to attach the Health component to (only attaches if the type is already loaded — hotload first)"),
    },
    async (params) => {
      const res = await bridge.send("create_health_system", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── create_economy_wallet ─────────────────────────────────────────
  server.tool(
    "create_economy_wallet",
    "Generate a host-authoritative currency Wallet component: a [Sync(SyncFlags.FromHost)] Money balance (only the host can write it — plain [Sync] money is the classic economy exploit) with AddMoney / TrySpend / SetMoney / CanAfford and an OnMoneyChanged event. Single-player safe. Optionally attached to an existing GameObject by GUID (after a hotload). Pairs with a save system for persistence. Mined from the most-requested currency pattern across 51 games.",
    {
      name: z.string().optional().describe("Class name. Defaults to 'Wallet'"),
      directory: z
        .string()
        .optional()
        .describe("Subdirectory for the .cs file. Defaults to 'Code'"),
      startingMoney: z
        .number()
        .int()
        .optional()
        .describe("Initial balance the host seeds on start. Defaults to 0"),
      targetId: z
        .string()
        .optional()
        .describe("GUID of an existing GameObject to attach the Wallet to (only attaches if the type is already loaded — hotload first)"),
    },
    async (params) => {
      const res = await bridge.send("create_economy_wallet", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── create_pickup ─────────────────────────────────────────────────
  server.tool(
    "create_pickup",
    "Generate a trigger-based collectible component. On enter by a tagged object it raises OnCollected (wire it to your objective/score system) and despawns. Optionally builds a visible pickup GameObject with a trigger SphereCollider (+ a model) in one call",
    {
      name: z.string().optional().describe("Class name. Defaults to 'Pickup'"),
      directory: z
        .string()
        .optional()
        .describe("Subdirectory for the .cs file. Defaults to 'Code'"),
      action: z
        .enum(["score", "heal", "item", "custom"])
        .optional()
        .describe("Effect flavour (all self-contained; the heal/item branches show the typed call to a companion system in comments). Defaults to 'score'"),
      amount: z
        .number()
        .optional()
        .describe("Magnitude of the effect (score points, heal amount). Defaults to 1"),
      filterTag: z
        .string()
        .optional()
        .describe("Only collect for objects with this tag. Defaults to 'player'"),
      placeInScene: z
        .boolean()
        .optional()
        .describe("Also build a pickup GameObject (trigger SphereCollider + optional model). Defaults to false"),
      position: Vector3Schema.optional().describe("World position when placeInScene is true"),
      radius: z
        .number()
        .optional()
        .describe("Trigger sphere radius when placed. Defaults to 24"),
      model: z
        .string()
        .optional()
        .describe("Optional model path for a visible pickup (e.g. 'models/dev/box.vmdl'). Cloud assets must be installed first"),
    },
    async (params) => {
      const res = await bridge.send("create_pickup", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

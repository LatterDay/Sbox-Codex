import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * World-generation and map-editing tools.
 *
 * Drives terrain (MapBuilder), caves (CaveBuilder), and forests (ForestGenerator)
 * components. Includes a generic invoke_button for pressing any [Button] on any
 * component, sculpt brushes for direct heightmap editing, and place_along_path
 * for dropping assets along a curve.
 *
 * Most "add_*" tools default to rebuilding the affected feature (Build Terrain,
 * Build Cave, Generate Forest) so changes are visible immediately. Set
 * `rebuild: false` to batch many edits and rebuild manually.
 *
 * Component lookup: by default each tool finds the first instance of the
 * relevant component (MapBuilder, CaveBuilder, ForestGenerator) in the scene.
 * Pass `id` (GameObject GUID) to target a specific GameObject.
 */
export function registerWorldTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── invoke_button ────────────────────────────────────────────────
  server.tool(
    "invoke_button",
    "Call a public method on a component. Matching is tried in order: (1) a [Button] attribute label, (2) the exact method NAME, (3) case-insensitive name with spaces stripped. Calls ANY public method, not only [Button]-attributed ones (e.g. 'StartGame'). Pass `args` to call methods that take parameters — the arg count must match and each value is coerced to the parameter type (primitives: string/number/bool work; complex types like Vector3 may not coerce). Omit args (or []) for parameterless methods. (list_component_buttons only lists [Button] methods, so a plain method may be invokable yet not appear there.)",
    {
      component: z
        .string()
        .describe("Component type name (e.g. 'MapBuilder', 'SasquatchedGame')"),
      button: z
        .string()
        .describe("A [Button] label OR a public method name (e.g. 'Build Terrain', 'StartGame'); case- and space-insensitive"),
      id: z
        .string()
        .optional()
        .describe("Optional GameObject GUID — if omitted, finds first matching component in scene"),
      args: z
        .array(z.unknown())
        .optional()
        .describe("Arguments to pass (must match the method's parameter count); coerced to each parameter type"),
    },
    async (params) => {
      const res = await bridge.send("invoke_button", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── list_component_buttons ───────────────────────────────────────
  server.tool(
    "list_component_buttons",
    "List the [Button]-attributed methods on a component. NOTE: this only finds methods decorated with [Button]; invoke_button can ALSO call any plain public no-arg method by name, so a method missing here may still be invokable. Use describe_type / get_method_signature to find non-button methods.",
    {
      component: z.string().describe("Component type name"),
      id: z.string().optional().describe("Optional GameObject GUID"),
    },
    async (params) => {
      const res = await bridge.send("list_component_buttons", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── raycast_terrain ──────────────────────────────────────────────
  server.tool(
    "raycast_terrain",
    "Sample MapBuilder terrain height at world (x, y). Returns z (the surface height). Use to place props on the terrain surface.",
    {
      x: z.number().describe("World X coordinate"),
      y: z.number().describe("World Y coordinate"),
      id: z.string().optional().describe("Optional GameObject GUID for MapBuilder"),
      component: z
        .string()
        .optional()
        .describe("Override the terrain component type name (default MapBuilder)"),
    },
    async (params) => {
      const res = await bridge.send("raycast_terrain", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── add_terrain_hill ─────────────────────────────────────────────
  server.tool(
    "add_terrain_hill",
    "Add a hill (cosine-falloff bump) to MapBuilder. Negative height creates a depression.",
    {
      x: z.number().describe("World X of hill center"),
      y: z.number().describe("World Y of hill center"),
      radius: z.number().default(500).describe("Hill radius in world units"),
      height: z.number().default(100).describe("Peak height (negative for depression)"),
      rebuild: z.boolean().default(true).describe("Rebuild terrain after adding (set false to batch)"),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("add_terrain_hill", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── add_terrain_clearing ─────────────────────────────────────────
  server.tool(
    "add_terrain_clearing",
    "Add a flat clearing zone to MapBuilder (lerps height toward base inside radius).",
    {
      x: z.number(),
      y: z.number(),
      radius: z.number().default(300),
      rebuild: z.boolean().default(true),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("add_terrain_clearing", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── add_terrain_trail ────────────────────────────────────────────
  server.tool(
    "add_terrain_trail",
    "Carve a trail depression between two points on MapBuilder.",
    {
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
      rebuild: z.boolean().default(true),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("add_terrain_trail", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── clear_terrain_features ───────────────────────────────────────
  server.tool(
    "clear_terrain_features",
    "Wipe Hills, Clearings, Trails, or all features from MapBuilder. 'what' is one of: Hills, Clearings, Trails, CavePath, all (default).",
    {
      what: z
        .enum(["Hills", "Clearings", "Trails", "CavePath", "all"])
        .default("all"),
      rebuild: z.boolean().default(true),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("clear_terrain_features", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── add_cave_waypoint ────────────────────────────────────────────
  server.tool(
    "add_cave_waypoint",
    "Append (or insert) a waypoint to CaveBuilder.Path. Z is depth (negative = underground).",
    {
      x: z.number(),
      y: z.number(),
      z: z.number().default(0).describe("Z depth — negative = underground"),
      index: z
        .number()
        .int()
        .optional()
        .describe("Optional insert position (default: append to end)"),
      rebuild: z.boolean().default(true),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("add_cave_waypoint", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── clear_cave_path ──────────────────────────────────────────────
  server.tool(
    "clear_cave_path",
    "Clear all waypoints in CaveBuilder and remove the cave from the scene.",
    {
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("clear_cave_path", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── add_forest_poi ───────────────────────────────────────────────
  server.tool(
    "add_forest_poi",
    "Add a point of interest (clearing) to ForestGenerator.POIs. Returns the index of the new POI for use with add_forest_trail.",
    {
      name: z.string().default("POI"),
      x: z.number(),
      y: z.number(),
      radius: z.number().default(300),
      density_multiplier: z
        .number()
        .default(1)
        .describe("Multiplies forest density inside this POI's region"),
      rebuild: z
        .boolean()
        .default(false)
        .describe("Forest gen is slow (~1s); default false to batch"),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("add_forest_poi", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── add_forest_trail ─────────────────────────────────────────────
  server.tool(
    "add_forest_trail",
    "Add a trail gap between two POIs (by index) to ForestGenerator.Trails.",
    {
      from_index: z.number().int(),
      to_index: z.number().int(),
      rebuild: z.boolean().default(false),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("add_forest_trail", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── set_forest_seed ──────────────────────────────────────────────
  server.tool(
    "set_forest_seed",
    "Set ForestGenerator.Seed and regenerate. Useful for re-rolling layouts.",
    {
      seed: z.number().int().default(77),
      rebuild: z.boolean().default(true),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("set_forest_seed", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── clear_forest_pois ────────────────────────────────────────────
  server.tool(
    "clear_forest_pois",
    "Wipe all POIs and trails in ForestGenerator and clear placed forest objects from the scene.",
    {
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("clear_forest_pois", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── sculpt_terrain ───────────────────────────────────────────────
  server.tool(
    "sculpt_terrain",
    "Apply a heightmap brush at (x, y) to MapBuilder. Modes: raise, lower, flatten, smooth. Modifies the current heightmap directly and rebuilds the mesh; survives between calls until you press Build Terrain again.",
    {
      x: z.number().describe("World X of brush center"),
      y: z.number().describe("World Y of brush center"),
      radius: z.number().default(400).describe("Brush radius in world units"),
      strength: z.number().default(50).describe("Height delta (units) for raise/lower; ignored for flatten/smooth"),
      mode: z.enum(["raise", "lower", "flatten", "smooth"]).default("raise"),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("sculpt_terrain", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── paint_forest_density ─────────────────────────────────────────
  server.tool(
    "paint_forest_density",
    "Add a circular biome region with overridden forest density. Multiple regions stack via cosine falloff. density: 0=no trees, 1=normal, 2=double.",
    {
      x: z.number(),
      y: z.number(),
      radius: z.number().default(800),
      density: z.number().default(1).describe("Density multiplier (0=clear, 1=normal, 2=dense)"),
      rebuild: z.boolean().default(false),
      id: z.string().optional(),
      component: z
        .string()
        .optional()
        .describe(
          "Override the builder component type name — set this if your project's terrain/cave/forest component is named differently than the default (MapBuilder/CaveBuilder/ForestGenerator)"
        ),
    },
    async (params) => {
      const res = await bridge.send("paint_forest_density", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── place_along_path ─────────────────────────────────────────────
  server.tool(
    "place_along_path",
    "Drop instances of a model along a path (list of points). Useful for fences, lampposts, road markers, lined-up rocks.",
    {
      model: z.string().describe("Model path (e.g. 'models/dev/box.vmdl' or installed-asset path)"),
      points: z
        .array(z.object({ x: z.number(), y: z.number(), z: z.number().default(0) }))
        .min(2)
        .describe("Path waypoints (at least 2)"),
      spacing: z.number().default(200).describe("Distance between placements (world units)"),
      jitter: z.number().default(0).describe("Max random offset perpendicular to path"),
      min_scale: z.number().default(1),
      max_scale: z.number().default(1),
      seed: z.number().int().default(42),
      name: z.string().default("PathItem").describe("Base name for placed objects"),
    },
    async (params) => {
      const res = await bridge.send("place_along_path", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── build_terrain_mesh ───────────────────────────────────────────
  server.tool(
    "build_terrain_mesh",
    "Build a standalone heightmap terrain mesh from a hills/clearings JSON spec — independent of MapBuilder. Use when you don't have a MapBuilder component in the scene and want one-shot terrain.",
    {
      size: z.number().default(9600).describe("Total terrain size (world units, square)"),
      resolution: z.number().int().default(64).describe("Grid resolution per side"),
      name: z.string().default("Generated Terrain"),
      hills: z
        .array(
          z.object({
            x: z.number(),
            y: z.number(),
            radius: z.number().default(500),
            height: z.number().default(100),
          })
        )
        .default([]),
      clearings: z
        .array(z.object({ x: z.number(), y: z.number(), radius: z.number().default(300) }))
        .default([]),
    },
    async (params) => {
      const res = await bridge.send("build_terrain_mesh", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── set_prefab_ref ───────────────────────────────────────────────
  server.tool(
    "set_prefab_ref",
    "Set a GameObject-typed property on a component to a loaded prefab. Use this when set_property can't handle prefab references (which it can't, because prefabs are GameObjects not primitives).",
    {
      id: z.string().describe("GUID of the GameObject holding the component"),
      component: z.string().describe("Component type name"),
      property: z.string().describe("Property name to set (must be GameObject-typed)"),
      prefabPath: z.string().describe("Prefab asset path (e.g. 'prefabs/player.prefab')"),
    },
    async (params) => {
      const res = await bridge.send("set_prefab_ref", params);
      if (!res.success) return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );
}

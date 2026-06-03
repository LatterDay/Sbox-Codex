import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Navigation tools (Batch 27) — REAL editor operations, not component wrappers.
 *
 * bake_navmesh runs the editor's static NavMesh bake (NavMesh.BakeNavMesh) so
 * NavMeshAgents can pathfind; get_navmesh_path queries the baked mesh for a
 * route (NavMesh.GetSimplePath). Neither is reachable via add_component — they
 * operate on the scene's navmesh itself, which is why they earn dedicated tools.
 */

const Vec3 = z
  .object({
    x: z.number().describe("X"),
    y: z.number().describe("Y"),
    z: z.number().describe("Z"),
  })
  .describe("A world-space Vector3");

export function registerNavigationTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── bake_navmesh ────────────────────────────────────────────────────
  server.tool(
    "bake_navmesh",
    "Enable + bake the active scene's navigation mesh so NavMeshAgents can pathfind. This is an editor operation (NavMesh.BakeNavMesh), not a component. The bake runs ASYNC — it returns immediately with baking:true; the editor shows a progress bar and isGenerating flips false when done (give it a moment before querying paths). Optional agent params let you size the mesh to your characters.",
    {
      agentRadius: z.number().optional().describe("Agent radius (default scene setting)"),
      agentHeight: z.number().optional().describe("Agent height"),
      agentStepSize: z.number().optional().describe("Max step-up height"),
      agentMaxSlope: z.number().optional().describe("Max walkable slope, degrees"),
      includeStaticBodies: z
        .boolean()
        .optional()
        .describe("Include static physics bodies in the bake"),
    },
    async (params) => {
      const res = await bridge.send("bake_navmesh", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── get_navmesh_path ────────────────────────────────────────────────
  server.tool(
    "get_navmesh_path",
    "Query the baked navmesh for a walkable path between two world points (NavMesh.GetSimplePath). Returns the ordered path points, or reachable:false if no route exists. Requires bake_navmesh to have run first. Read-only — useful for validating connectivity, AI patrol routes, and spawn reachability.",
    {
      from: Vec3.describe("Start point (world space)"),
      to: Vec3.describe("Destination point (world space)"),
    },
    async (params) => {
      const res = await bridge.send("get_navmesh_path", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

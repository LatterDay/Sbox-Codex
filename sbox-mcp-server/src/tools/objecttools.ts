import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Object utility & query tools (Batch 23): find objects in the scene, and
 * bulk-edit tint / model / tags across one or many objects. find_objects is
 * the composable workhorse — query GUIDs, then feed them to align/distribute/
 * set_tint/group/etc.
 */

const ColorSchema = z
  .object({
    r: z.number().min(0).describe("Red, 0-1"),
    g: z.number().min(0).describe("Green, 0-1"),
    b: z.number().min(0).describe("Blue, 0-1"),
    a: z.number().min(0).max(1).optional().describe("Alpha, 0-1 (default 1)"),
  })
  .describe("RGBA colour as 0-1 floats");

export function registerObjectTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── find_objects ───────────────────────────────────────────────────
  server.tool(
    "find_objects",
    "Query the scene for GameObjects by name (case-insensitive substring), component type name, and/or tag — combine filters (AND). Returns {id,name} for matches (limit default 50, max 500). Read-only; works during play. Use it to get GUIDs to feed into align/distribute/set_tint/group/delete/etc.",
    {
      name: z.string().optional().describe("Name substring (case-insensitive)"),
      component: z
        .string()
        .optional()
        .describe("Component type name, e.g. 'PointLight', 'SkinnedModelRenderer'"),
      tag: z.string().optional().describe("Tag the object must have"),
      limit: z.number().int().optional().describe("Max results (default 50, max 500)"),
    },
    async (params) => {
      const res = await bridge.send("find_objects", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── set_tint ───────────────────────────────────────────────────────
  server.tool(
    "set_tint",
    "Set the renderer tint colour on one object (id) or many (ids) at once. Works on any ModelRenderer/SkinnedModelRenderer.",
    {
      id: z.string().optional().describe("Single GameObject GUID"),
      ids: z.array(z.string()).optional().describe("Multiple GameObject GUIDs"),
      tint: ColorSchema.describe("Tint colour to apply"),
    },
    async (params) => {
      const res = await bridge.send("set_tint", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── replace_model ──────────────────────────────────────────────────
  server.tool(
    "replace_model",
    "Swap the model on one object (id) or many (ids) — e.g. retheme a row of props in one call.",
    {
      id: z.string().optional().describe("Single GameObject GUID"),
      ids: z.array(z.string()).optional().describe("Multiple GameObject GUIDs"),
      model: z.string().describe("New model path, e.g. 'models/dev/sphere.vmdl'"),
    },
    async (params) => {
      const res = await bridge.send("replace_model", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── set_tags ───────────────────────────────────────────────────────
  server.tool(
    "set_tags",
    "Add, remove, and/or clear gameplay tags on one object (id) or many (ids). Tags drive collision groups, queries, and triggers.",
    {
      id: z.string().optional().describe("Single GameObject GUID"),
      ids: z.array(z.string()).optional().describe("Multiple GameObject GUIDs"),
      add: z.array(z.string()).optional().describe("Tags to add"),
      remove: z.array(z.string()).optional().describe("Tags to remove"),
      clear: z.boolean().optional().describe("Remove all existing tags first"),
    },
    async (params) => {
      const res = await bridge.send("set_tags", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

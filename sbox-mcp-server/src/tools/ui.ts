import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * UI tools: create_razor_ui, add_screen_panel, add_world_panel.
 * Manages s&box's Razor-based UI system — .razor component files, ScreenPanel, and WorldPanel.
 */
export function registerUITools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── create_razor_ui ───────────────────────────────────────────────
  server.tool(
    "create_razor_ui",
    "Create a Razor UI component file (.razor) with optional SCSS stylesheet. Generates boilerplate for HUD, menu, or basic panel types",
    {
      name: z
        .string()
        .describe("Component name (e.g. 'GameHud', 'MainMenu')"),
      directory: z
        .string()
        .optional()
        .describe(
          "Subdirectory under code/ for the file. Defaults to 'UI'"
        ),
      panelType: z
        .enum(["basic", "hud", "menu"])
        .optional()
        .describe(
          "Type of panel to generate: 'basic' (simple panel), 'hud' (health/score overlay), 'menu' (title + buttons). Defaults to 'basic'"
        ),
      description: z
        .string()
        .optional()
        .describe("Description of what this UI panel does"),
      includeStyles: z
        .boolean()
        .optional()
        .describe(
          "Generate a companion .razor.scss stylesheet. Defaults to true"
        ),
      content: z
        .string()
        .optional()
        .describe(
          "Raw .razor content (skips boilerplate generation)"
        ),
      styles: z
        .string()
        .optional()
        .describe(
          "Raw .razor.scss content (only used with raw content mode)"
        ),
    },
    async (params) => {
      const res = await bridge.send("create_razor_ui", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_screen_panel ──────────────────────────────────────────────
  server.tool(
    "add_screen_panel",
    "Create a new GameObject with a ScreenPanel component for full-screen UI overlay (HUD, menus, etc.)",
    {
      name: z
        .string()
        .optional()
        .describe("Name for the UI GameObject. Defaults to 'Screen UI'"),
      zIndex: z
        .number()
        .optional()
        .describe("Z-index for layering multiple screen panels"),
      panelComponent: z
        .string()
        .optional()
        .describe(
          "Name of a Razor PanelComponent to add (e.g. 'GameHud')"
        ),
      parent: z
        .string()
        .optional()
        .describe("GUID of parent GameObject"),
    },
    async (params) => {
      const res = await bridge.send("add_screen_panel", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_world_panel ───────────────────────────────────────────────
  server.tool(
    "add_world_panel",
    "Create a new GameObject with a WorldPanel component for in-world 3D UI (health bars, signs, nameplates)",
    {
      name: z
        .string()
        .optional()
        .describe("Name for the UI GameObject. Defaults to 'World UI'"),
      position: z
        .union([
          z.object({ x: z.number(), y: z.number(), z: z.number() }),
          z.string().describe('Comma string "x,y,z", e.g. "0,0,64"'),
        ])
        .optional()
        .describe('World position for the panel — object {x,y,z} or comma string "x,y,z"'),
      rotation: z
        .object({
          pitch: z.number(),
          yaw: z.number(),
          roll: z.number(),
        })
        .optional()
        .describe("Rotation as euler angles"),
      worldScale: z
        .number()
        .optional()
        .describe("Scale of the world panel. Smaller = smaller in world"),
      lookAtCamera: z
        .boolean()
        .optional()
        .describe("Whether the panel always faces the camera (billboard)"),
      panelComponent: z
        .string()
        .optional()
        .describe(
          "Name of a Razor PanelComponent to add (e.g. 'NpcNameplate')"
        ),
      parent: z
        .string()
        .optional()
        .describe("GUID of parent GameObject"),
    },
    async (params) => {
      const res = await bridge.send("add_world_panel", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

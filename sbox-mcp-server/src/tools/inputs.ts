import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Input action tools — register the custom named verbs a scaffolded game needs.
 *
 * s&box stores input actions in the project's `.sbproj` under
 * `Metadata.InputSettings.Actions[]` (each: { Name, KeyboardCode, GamepadCode?,
 * GroupName }). A game that defines NO actions is handed a default set by the
 * engine (Forward/Back/Left/Right/Jump/Use/...). The catch: the moment a game
 * writes its own InputSettings block, that block becomes the authoritative
 * full list — so the handler seeds the full default set when none exists, then
 * appends the custom action, so movement/use survive.
 *
 *   ensure_input_action — add a named action (e.g. "interact") if missing so
 *                         Input.Pressed("interact") actually fires in play mode.
 */
export function registerInputTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── ensure_input_action ───────────────────────────────────────────
  server.tool(
    "ensure_input_action",
    'Register a custom named INPUT ACTION in the project so a generated game\'s custom verbs work in play mode. Writes to <project>.sbproj → Metadata.InputSettings.Actions[]. Idempotent: if the action already exists it is left alone (pass update=true to rebind its key). If the project has no InputSettings yet, the full DEFAULT action set (Forward/Back/Left/Right/Jump/Use/attack1/...) is seeded first so player movement/use are preserved — the engine only auto-injects defaults when a game defines NONE. After adding, call it from game code with Input.Pressed("name") / Input.Down("name") / Input.Released("name"). Note: input config is read at project load, so restart_editor (or reload the project) for a new action to take effect in play mode.',
    {
      name: z
        .string()
        .describe(
          'The action verb game code will call, e.g. "interact", "sprint", "drop". Matches Input.Pressed("interact").'
        ),
      keyboardKey: z
        .string()
        .optional()
        .describe(
          'Default keyboard binding, e.g. "e", "f", "space", "mouse1", "shift". Omit to add the action with no default key (player can bind it).'
        ),
      group: z
        .string()
        .optional()
        .describe(
          'UI group the action is listed under in the bindings menu (e.g. "Actions", "Movement", "Other"). Defaults to "Actions".'
        ),
      update: z
        .boolean()
        .optional()
        .describe(
          "If the action already exists, rebind its keyboardKey to the provided value instead of leaving it untouched. Default false (idempotent no-op when present)."
        ),
    },
    async (params) => {
      const res = await bridge.send("ensure_input_action", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

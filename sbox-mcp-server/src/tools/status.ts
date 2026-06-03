import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Diagnostic and health-check tool (get_bridge_status).
 * Reports connection state, latency, host/port, and editor version.
 */
export function registerStatusTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── get_bridge_status ────────────────────────────────────────────
  server.tool(
    "get_bridge_status",
    "Check the connection status to the s&box Bridge — whether it's connected, latency, host/port, and editor info. Useful for debugging",
    {},
    async () => {
      const connected = bridge.isConnected();
      const ipcDir = bridge.getIpcDir();
      const heartbeatAgeMs = bridge.getHeartbeatAgeMs();
      let latencyMs: number | null = null;
      let editorVersion: string | null = null;
      let roundTripOk = false;

      if (connected) {
        latencyMs = await bridge.ping();

        // A real round-trip — distinguishes a live editor from one whose
        // heartbeat is fresh but whose request loop is stalled.
        try {
          const res = await bridge.send("get_project_info", {}, 5000);
          roundTripOk = res.success;
          if (res.success && res.data) {
            const data = res.data as Record<string, unknown>;
            editorVersion = (data.editorVersion as string) ?? null;
          }
        } catch {
          // Non-fatal
        }
      }

      const status = {
        connected,
        ipcDir,
        heartbeatAgeMs,
        roundTripOk,
        latencyMs: connected ? latencyMs : null,
        lastPong: connected
          ? new Date(bridge.getLastPongTime()).toISOString()
          : null,
        editorVersion,
        // legacy/cosmetic — there is no socket; transport is file IPC
        host: bridge.getHost(),
        port: bridge.getPort(),
      };

      let text: string;
      if (!connected) {
        text = `Bridge NOT connected — no recent heartbeat in ${ipcDir}. Is s&box running with the Claude Bridge addon?`;
      } else if (roundTripOk) {
        text = `Bridge connected and responding (IPC: ${ipcDir}, heartbeat ${heartbeatAgeMs ?? "?"}ms ago).`;
      } else {
        text = `Bridge heartbeat is live but a test round-trip FAILED — the editor isn't draining requests. IPC: ${ipcDir}. Check the s&box editor console for [SboxBridge] lines.`;
      }

      return {
        content: [
          {
            type: "text",
            text: `${text}\n\n${JSON.stringify(status, null, 2)}`,
          },
        ],
      };
    }
  );

  // ── restart_editor ────────────────────────────────────────────────
  server.tool(
    "restart_editor",
    "Restart the s&box editor and wait for the bridge to reconnect — closes the C#-edit→recompile loop so addon/bridge changes apply without a manual restart. Relaunches straight back into the current project (EditorUtility.RestartEditor). Saves unsaved scenes by default (pass save:false to discard them). Blocks until the bridge is back (or waitMs elapses), then reports the handler count.",
    {
      save: z
        .boolean()
        .optional()
        .describe("Save unsaved scenes before restarting (default true; false discards them)"),
      waitMs: z
        .number()
        .int()
        .optional()
        .describe("Max ms to wait for reconnect (default 150000)"),
    },
    async (params) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Fire the restart. The editor closes mid-request, so a timeout/no-response here is EXPECTED.
      try {
        await bridge.send("restart_editor", { save: params.save ?? true }, 5000);
      } catch {
        /* editor going down — expected */
      }

      const waitMs = params.waitMs ?? 150000;
      const deadline = Date.now() + waitMs;
      // Let the old process actually exit (heartbeat goes stale) before checking, so we
      // don't false-positive on the pre-restart connection.
      await sleep(8000);

      while (Date.now() < deadline) {
        await sleep(2500);
        if (bridge.isConnected()) {
          // Heartbeat is fresh again — confirm the request loop drains + read the count.
          try {
            const st = await bridge.send("get_bridge_status", {}, 5000);
            if (st.success && st.data) {
              const hc = (st.data as Record<string, unknown>).handlerCount;
              return {
                content: [
                  {
                    type: "text",
                    text: `Editor restarted — bridge reconnected${hc ? ` with ${hc} handlers` : ""}.`,
                  },
                ],
              };
            }
          } catch {
            /* still settling — keep polling */
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Restart fired, but the bridge didn't reconnect within ${waitMs}ms — the editor may still be compiling. Try get_bridge_status in a moment.`,
          },
        ],
      };
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
}

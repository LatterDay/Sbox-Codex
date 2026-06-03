import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * File-based IPC transport for communicating with the s&box Bridge Addon.
 *
 * There is NO socket. Despite the legacy `host`/`port` fields, communication is
 * entirely through a shared temp directory:
 * - MCP server writes request files (req_*.json) atomically — it writes
 *   req_*.json.tmp first, then renames it into place so the addon can never
 *   read a half-written request. The addon consumes only req_*.json and
 *   ignores *.tmp.
 * - s&box addon polls for them, processes on the main editor thread, and writes
 *   response files (res_*.json)
 * - MCP server polls for response files
 *
 * The addon also maintains `status.json` as a HEARTBEAT (rewritten from the
 * editor frame loop). "Connected" means that heartbeat is recent — not merely
 * that the file exists. A write-once status file used to make the bridge report
 * "connected" forever after the first run, even with the editor closed.
 */

/** Default IPC directory name under the system temp dir. */
const IPC_DIR_NAME = "sbox-bridge-ipc";

/** Strip a leading UTF-8 BOM (older addons may prepend one to IPC files). */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Max age of the editor's status heartbeat before we consider the bridge dead.
 * The addon refreshes the heartbeat roughly once per second from its frame
 * loop, so this gives generous margin for GC pauses / frame hitches while still
 * catching a closed, crashed, or frame-stalled editor within a few seconds.
 */
export const STATUS_STALE_MS = 5000;

/** Resolve the IPC directory, honoring an explicit override. */
export function resolveIpcDir(): string {
  const override = process.env.SBOX_BRIDGE_IPC_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.tmpdir(), IPC_DIR_NAME);
}

/** Result of inspecting the editor's status.json heartbeat. */
export interface StatusClassification {
  /** The editor reported `running: true`. */
  running: boolean;
  /** The heartbeat is recent enough to trust (or the addon predates heartbeats). */
  fresh: boolean;
  /** Age of the heartbeat in ms, or null if the addon doesn't emit one. */
  heartbeatMs: number | null;
}

/**
 * Decide whether a parsed status.json means the bridge is live.
 *
 * A recent heartbeat → fresh. A stale heartbeat → not fresh (editor closed,
 * crashed, or frame loop stalled). No heartbeat field at all → treated as fresh
 * for backward compatibility with addons built before v1.3.2 (so upgrading the
 * MCP server alone never regresses a working setup to "disconnected").
 */
export function classifyStatus(
  status: unknown,
  nowMs: number,
  staleMs: number
): StatusClassification {
  if (!status || typeof status !== "object") {
    return { running: false, fresh: false, heartbeatMs: null };
  }
  const s = status as Record<string, unknown>;
  const running = s.running === true;
  const hb = s.heartbeat;
  if (typeof hb === "string") {
    const t = Date.parse(hb);
    if (!Number.isNaN(t)) {
      const heartbeatMs = nowMs - t;
      return { running, fresh: heartbeatMs <= staleMs, heartbeatMs };
    }
  }
  // Old addon (no parseable heartbeat) — don't regress working setups.
  return { running, fresh: true, heartbeatMs: null };
}

/**
 * Build a timeout error that names WHICH side of the IPC broke, so a 30s hang
 * is actionable instead of opaque.
 */
export function describeTimeout(opts: {
  reqConsumed: boolean;
  ipcDir: string;
  timeoutMs: number;
  command: string;
}): string {
  const { reqConsumed, ipcDir, timeoutMs, command } = opts;
  if (!reqConsumed) {
    return (
      `Request '${command}' timed out after ${timeoutMs}ms. The s&box editor never picked up the request ` +
      `(its req_*.json file was not consumed). Likely causes: s&box isn't running, the Claude Bridge addon ` +
      `failed to load, or the editor and MCP server resolved different IPC directories (server is using: ` +
      `${ipcDir}). Open the s&box editor console and check for [SboxBridge] lines — it logs the directory it ` +
      `is watching; set SBOX_BRIDGE_IPC_DIR on both sides if they disagree.`
    );
  }
  return (
    `Request '${command}' timed out after ${timeoutMs}ms. The editor consumed the request but never wrote a ` +
    `response. Its frame loop may be stalled (e.g. the s&box window is unfocused or minimized) or the handler ` +
    `errored. Check the s&box editor console for [SboxBridge] errors.`
  );
}

/** A single command request sent to the s&box Bridge. */
export interface BridgeRequest {
  id: string;
  command: string;
  params: Record<string, unknown>;
}

/** Response from the s&box Bridge. Check `success` before reading `data`. */
export interface BridgeResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * File-based IPC client that communicates with the s&box Bridge Addon.
 */
export class BridgeClient {
  private requestCounter = 0;
  private ipcDir: string;
  private connected = false;
  private lastPongTime = 0;
  private host: string;
  private port: number;

  static readonly POLL_INTERVAL_MS = 50; // 50ms polling for responses
  static readonly STATUS_CHECK_INTERVAL_MS = 5000;

  constructor(host = "127.0.0.1", port = 29015) {
    // host/port are legacy/cosmetic — surfaced in get_bridge_status only. The
    // real transport is the file IPC directory below.
    this.host = host;
    this.port = port;
    this.ipcDir = resolveIpcDir();
  }

  /** The directory this client reads/writes IPC files in. */
  getIpcDir(): string {
    return this.ipcDir;
  }

  private statusPath(): string {
    return path.join(this.ipcDir, "status.json");
  }

  /** Read + classify the editor's status heartbeat. Never throws. */
  readStatus(): StatusClassification {
    try {
      // Strip a UTF-8 BOM in case an older addon wrote one.
      const raw = stripBom(fs.readFileSync(this.statusPath(), "utf8"));
      return classifyStatus(JSON.parse(raw), Date.now(), STATUS_STALE_MS);
    } catch {
      return { running: false, fresh: false, heartbeatMs: null };
    }
  }

  /** Age of the editor's last heartbeat in ms, or null if unavailable. */
  getHeartbeatAgeMs(): number | null {
    return this.readStatus().heartbeatMs;
  }

  /**
   * Verify the s&box Bridge is live (recent heartbeat), throwing a specific
   * error if it is missing or stale.
   */
  async connect(): Promise<void> {
    if (!fs.existsSync(this.ipcDir)) {
      fs.mkdirSync(this.ipcDir, { recursive: true });
    }

    const s = this.readStatus();
    if (s.running && s.fresh) {
      this.connected = true;
      this.lastPongTime = Date.now();
      return;
    }
    this.connected = false;

    if (s.running && !s.fresh) {
      throw new Error(
        `s&box Bridge heartbeat is stale at ${this.statusPath()} (last beat ${s.heartbeatMs}ms ago, ` +
          `limit ${STATUS_STALE_MS}ms). The editor likely closed, crashed, or its frame loop stalled. ` +
          `IPC dir: ${this.ipcDir}`
      );
    }
    throw new Error(
      `Cannot connect to s&box Bridge. No live status at ${this.statusPath()}. Is s&box running with the ` +
        `Claude Bridge addon? (MCP server IPC dir: ${this.ipcDir})`
    );
  }

  /**
   * Send a command to the s&box Bridge and wait for its response.
   */
  async send(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000
  ): Promise<BridgeResponse> {
    // Try to connect if not connected
    if (!this.connected) {
      try {
        await this.connect();
      } catch (err) {
        return {
          id: "",
          success: false,
          error:
            err instanceof Error
              ? err.message
              : "Not connected to s&box Bridge. Make sure s&box is running with the Claude Bridge addon installed.",
        };
      }
    }

    const id = `${++this.requestCounter}_${Date.now()}`;
    const request: BridgeRequest = { id, command, params };

    // Ensure IPC directory exists
    if (!fs.existsSync(this.ipcDir)) {
      fs.mkdirSync(this.ipcDir, { recursive: true });
    }

    // Write request file atomically: write to a .tmp sibling, then rename into
    // place. The C# poller only consumes `req_*.json` (it ignores `*.tmp`), so
    // it can never observe a half-written request for a large payload — the
    // rename is atomic on the same volume.
    const reqPath = path.join(this.ipcDir, `req_${id}.json`);
    const tmpPath = `${reqPath}.tmp`;
    const resPath = path.join(this.ipcDir, `res_${id}.json`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(request), "utf8");
      fs.renameSync(tmpPath, reqPath);
    } catch (err) {
      // Best-effort cleanup of a partial temp file so it doesn't linger.
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      return {
        id,
        success: false,
        error: `Failed to write request file: ${err}`,
      };
    }

    // Poll for response file
    const startTime = Date.now();

    return new Promise((resolve) => {
      const poll = setInterval(() => {
        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(poll);
          // Whether the editor ever read the request tells us which side broke.
          const reqConsumed = !fs.existsSync(reqPath);
          // Clean up request file if still there
          try {
            if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath);
          } catch {}
          resolve({
            id,
            success: false,
            error: describeTimeout({ reqConsumed, ipcDir: this.ipcDir, timeoutMs, command }),
          });
          return;
        }

        // Check for response file
        if (fs.existsSync(resPath)) {
          try {
            // Defensively strip a BOM in case an older addon wrote one.
            const responseJson = stripBom(fs.readFileSync(resPath, "utf8"));
            const response = JSON.parse(responseJson) as BridgeResponse;

            // Clean up response file
            try {
              fs.unlinkSync(resPath);
            } catch {}

            clearInterval(poll);
            this.lastPongTime = Date.now();
            resolve(response);
          } catch {
            // Response file might be partially written, try again next poll
          }
        }
      }, BridgeClient.POLL_INTERVAL_MS);
    });
  }

  /**
   * Send multiple commands as a batch.
   */
  async sendBatch(
    commands: Array<{ command: string; params?: Record<string, unknown> }>,
    timeoutMs = 30000
  ): Promise<BridgeResponse> {
    if (!this.connected) {
      try {
        await this.connect();
      } catch (err) {
        return {
          id: "",
          success: false,
          error: err instanceof Error ? err.message : "Not connected to s&box Bridge.",
        };
      }
    }

    const id = `batch_${++this.requestCounter}_${Date.now()}`;
    const request = { id, commands };

    if (!fs.existsSync(this.ipcDir)) {
      fs.mkdirSync(this.ipcDir, { recursive: true });
    }

    // Write atomically (temp + rename) so the C# poller never reads a partial
    // batch request file. See the note in send() above.
    const reqPath = path.join(this.ipcDir, `req_${id}.json`);
    const tmpPath = `${reqPath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(request), "utf8");
      fs.renameSync(tmpPath, reqPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      return {
        id,
        success: false,
        error: `Failed to write request file: ${err}`,
      };
    }

    const resPath = path.join(this.ipcDir, `res_${id}.json`);
    const startTime = Date.now();

    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(poll);
          const reqConsumed = !fs.existsSync(reqPath);
          try {
            if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath);
          } catch {}
          resolve({
            id,
            success: false,
            error: describeTimeout({ reqConsumed, ipcDir: this.ipcDir, timeoutMs, command: "batch" }),
          });
          return;
        }

        if (fs.existsSync(resPath)) {
          try {
            // Defensively strip a BOM in case an older addon wrote one.
            const responseJson = stripBom(fs.readFileSync(resPath, "utf8"));
            const response = JSON.parse(responseJson) as BridgeResponse;
            try {
              fs.unlinkSync(resPath);
            } catch {}
            clearInterval(poll);
            this.lastPongTime = Date.now();
            resolve(response);
          } catch {}
        }
      }, BridgeClient.POLL_INTERVAL_MS);
    });
  }

  /**
   * Liveness check. Returns elapsed ms if the heartbeat is recent, else -1.
   */
  async ping(): Promise<number> {
    const start = Date.now();
    const s = this.readStatus();
    if (s.running && s.fresh) {
      this.lastPongTime = Date.now();
      return Date.now() - start;
    }
    return -1;
  }

  isConnected(): boolean {
    const s = this.readStatus();
    this.connected = s.running && s.fresh;
    return this.connected;
  }

  getHost(): string {
    return this.host;
  }

  getPort(): number {
    return this.port;
  }

  getLastPongTime(): number {
    return this.lastPongTime;
  }

  disconnect(): void {
    this.connected = false;
  }
}

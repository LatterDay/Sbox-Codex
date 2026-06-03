import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Diagnostic tools (Batch 24 — "let Claude see its own errors"): read s&box's
 * editor log so Claude can check compile errors, exceptions, and Log.Info
 * output directly — instead of flying blind or relying on the user to relay
 * them.
 *
 * Deliberately reads the log FILE on the Node side (not over the bridge IPC),
 * so it works even when the s&box editor has crashed and the bridge is down —
 * which is exactly when you need the log most.
 *
 * Log path resolution:
 *   1. SBOX_LOG_PATH env var (explicit override — use this on macOS/Linux or
 *      non-Steam installs).
 *   2. Windows Steam auto-detect: parse steamapps/libraryfolders.vdf for each
 *      library, look for steamapps/common/sbox/logs/sbox-dev.log, pick newest.
 */

function locateSboxLog(): { path: string | null; tried: string[] } {
  const tried: string[] = [];

  const env = process.env.SBOX_LOG_PATH;
  if (env) {
    tried.push(env);
    if (existsSync(env)) return { path: env, tried };
  }

  if (process.platform === "win32") {
    const steamRoots = [
      "C:\\Program Files (x86)\\Steam",
      "C:\\Program Files\\Steam",
    ];
    const libs: string[] = [];
    for (const steam of steamRoots) {
      const vdf = join(steam, "steamapps", "libraryfolders.vdf");
      if (existsSync(vdf)) {
        libs.push(steam);
        try {
          const txt = readFileSync(vdf, "utf-8");
          for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) {
            libs.push(m[1].replace(/\\\\/g, "\\"));
          }
        } catch {
          /* ignore unreadable vdf */
        }
      }
    }
    const candidates: string[] = [];
    for (const lib of libs) {
      const p = join(lib, "steamapps", "common", "sbox", "logs", "sbox-dev.log");
      tried.push(p);
      if (existsSync(p)) candidates.push(p);
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      return { path: candidates[0], tried };
    }
  }

  return { path: null, tried };
}

function tailLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n));
}

export function registerDiagnosticTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── read_log ───────────────────────────────────────────────────────
  server.tool(
    "read_log",
    "Read s&box's editor log (sbox-dev.log) so Claude can see compile errors, exceptions, and Log.Info output directly. Reads the log file (not via the bridge), so it works even when the editor has crashed. If auto-detection fails (non-Windows / non-Steam install), set the SBOX_LOG_PATH environment variable to the full log path.",
    {
      lines: z
        .number()
        .int()
        .optional()
        .describe("How many lines from the end to return (default 80, max 1000)"),
      filter: z
        .string()
        .optional()
        .describe("Only return lines containing this substring (case-insensitive)"),
    },
    async (params) => {
      const { path, tried } = locateSboxLog();
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text:
                "Error: couldn't locate sbox-dev.log. Set the SBOX_LOG_PATH environment variable to its full path.\nTried:\n" +
                tried.join("\n"),
            },
          ],
        };
      }
      let n = params.lines ?? 80;
      if (n < 1) n = 1;
      if (n > 1000) n = 1000;
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error reading ${path}: ${(e as Error).message}` }],
        };
      }
      let out = tailLines(text, n);
      if (params.filter) {
        const f = params.filter.toLowerCase();
        out = out.filter((l) => l.toLowerCase().includes(f));
      }
      const header = `# ${path}\n# last ${n} lines${params.filter ? ` · filter "${params.filter}"` : ""}\n\n`;
      return { content: [{ type: "text", text: header + out.join("\n") }] };
    }
  );

  // ── get_compile_errors ─────────────────────────────────────────────
  server.tool(
    "get_compile_errors",
    "Scan the recent s&box log for compile errors and exceptions — the fast way for Claude to confirm whether its last script/addon edit actually compiled. Reads sbox-dev.log directly (works even if the editor is mid-crash). Returns the matching lines, or an all-clear.",
    {
      lines: z
        .number()
        .int()
        .optional()
        .describe("How many lines from the end to scan (default 400, max 4000)"),
    },
    async (params) => {
      const { path } = locateSboxLog();
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: "Error: couldn't locate sbox-dev.log. Set the SBOX_LOG_PATH environment variable.",
            },
          ],
        };
      }
      let n = params.lines ?? 400;
      if (n < 1) n = 1;
      if (n > 4000) n = 4000;
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error reading ${path}: ${(e as Error).message}` }],
        };
      }
      const recent = tailLines(text, n);
      const re =
        /(error CS\d+|Compile of .* Failed|Exception|Couldn't add project|Broken Reference|StackTrace|^\s*at Sandbox\.)/i;
      const hits = recent.filter((l) => re.test(l));
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No compile errors or exceptions in the last ${n} log lines — looks clean.\n(${path})`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Found ${hits.length} error/exception line(s) in the last ${n} log lines:\n\n${hits.join("\n")}`,
          },
        ],
      };
    }
  );

  // ── frame_camera ─────────────────────────────────────────────────── (bridge)
  server.tool(
    "frame_camera",
    "Aim the s&box EDITOR viewport camera at a GameObject (by id) or a world point (position + optional radius), then call take_screenshot to capture that view. This is how Claude points its own screenshots at what it's working on — frame a spawned object, then screenshot to verify it actually looks right.",
    {
      id: z.string().optional().describe("GUID of a GameObject to frame on"),
      position: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("World point to frame on (use instead of id)"),
      radius: z
        .number()
        .optional()
        .describe("Frame radius around the position, in units (default 128)"),
    },
    async (params) => {
      const res = await bridge.send("frame_camera", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── screenshot_from ──────────────────────────────────────────────── (bridge)
  server.tool(
    "screenshot_from",
    "Take a screenshot from a chosen angle. take_screenshot is locked to the scene's main camera; this temporarily moves that camera to frame your target, captures, then restores it — so Claude can finally AIM its own screenshots. Pass id (frame an object) OR position {x,y,z} with optional lookAt {x,y,z} or rotation {pitch,yaw,roll}. After it returns, read the newest PNG in the editor's screenshots folder.",
    {
      id: z.string().optional().describe("GUID of a GameObject to frame"),
      position: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Camera world position (use instead of id)"),
      lookAt: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("World point to look at (pair with position)"),
      rotation: z
        .object({ pitch: z.number(), yaw: z.number(), roll: z.number() })
        .optional()
        .describe("Explicit camera rotation (pair with position)"),
      width: z.number().int().optional().describe("Screenshot width (default 1920)"),
      height: z.number().int().optional().describe("Screenshot height (default 1080)"),
    },
    async (params) => {
      const res = await bridge.send("screenshot_from", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── console_run ──────────────────────────────────────────────────── (bridge)
  server.tool(
    "console_run",
    "Run an s&box console command / ConCmd via Sandbox.ConsoleSystem.Run — e.g. a cvar ('sv_cheats 1') or a registered command. Also the invocation primitive behind execute_csharp.",
    {
      command: z.string().describe("The console command line to run"),
    },
    async (params) => {
      const res = await bridge.send("console_run", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  // ── execute_csharp ───────────────────────────────────────────────── (orchestrated)
  let execCounter = 0;
  server.tool(
    "execute_csharp",
    "EXPERIMENTAL. Compile + run a C# snippet inside the s&box EDITOR (which is unsandboxed): writes a temp [ConCmd] into the project's Editor/ folder, hotloads, runs it, reads the result/exception from the log, then deletes the temp file. With expression:true, returns the JSON value of a single expression; otherwise runs statements. CAVEATS: each call triggers a hotload (~2-8s) and recompiles the project's editor assembly; a snippet that fails to compile is reported + cleaned up, but briefly taints the editor assembly until cleanup.",
    {
      code: z
        .string()
        .describe("C# to run (editor-context, unsandboxed). With expression:true, a single expression; otherwise statements."),
      expression: z
        .boolean()
        .optional()
        .describe("Treat code as an expression and return its JSON value (default false)"),
      timeoutMs: z
        .number()
        .int()
        .optional()
        .describe("Max wait for compile + run, ms (default 20000)"),
    },
    async (params) => {
      const id = `${Date.now().toString(36)}${++execCounter}`;
      const cmd = `claude_exec_${id}`;
      const filePath = `Editor/__Exec_${id}.cs`;
      const marker = `[EXEC ${id}]`;
      const inner = params.expression
        ? `var __r = (${params.code});\n\t\t\tSandbox.Log.Info( "${marker} RESULT=" + System.Text.Json.JsonSerializer.Serialize( __r ) );`
        : `${params.code}\n\t\t\tSandbox.Log.Info( "${marker} DONE" );`;
      const cs =
        `using Editor;\nusing Sandbox;\nusing System;\n\n` +
        `public static class __Exec_${id}\n{\n` +
        `\t[ConCmd( "${cmd}" )]\n\tpublic static void Run()\n\t{\n` +
        `\t\ttry\n\t\t{\n\t\t\t${inner}\n\t\t}\n` +
        `\t\tcatch ( System.Exception __e ) { Sandbox.Log.Error( "${marker} ERROR=" + __e.Message ); }\n` +
        `\t}\n}\n`;
      const timeout = params.timeoutMs ?? 20000;

      const wr = await bridge.send("write_file", { path: filePath, content: cs });
      if (!wr.success) {
        return { content: [{ type: "text", text: `execute_csharp: failed to write temp file: ${wr.error}` }] };
      }
      await bridge.send("trigger_hotload", {});

      const { path: logPath } = locateSboxLog();
      const startedAt = Date.now();
      let found: string | null = null;
      let compileErr: string | null = null;
      while (Date.now() - startedAt < timeout) {
        await new Promise((r) => setTimeout(r, 1500));
        await bridge.send("console_run", { command: cmd });
        if (logPath) {
          try {
            const txt = readFileSync(logPath, "utf-8");
            const tail = txt.slice(Math.max(0, txt.length - 30000));
            const mi = tail.lastIndexOf(marker);
            if (mi >= 0) {
              found = tail.slice(mi).split(/\r?\n/)[0];
              break;
            }
            if (/__Exec_/.test(tail) && /(error CS\d+|Compile of .* Failed)/i.test(tail)) {
              const errs = tail.split(/\r?\n/).filter((l) => /error CS\d+/i.test(l)).slice(-6).join("\n");
              if (errs) {
                compileErr = errs;
                break;
              }
            }
          } catch {
            /* log not ready yet */
          }
        }
      }

      // cleanup: remove the temp file + hotload back to a clean assembly
      try {
        await bridge.send("delete_script", { path: filePath });
      } catch {
        /* best effort */
      }
      try {
        await bridge.send("trigger_hotload", {});
      } catch {
        /* best effort */
      }

      if (compileErr) {
        return { content: [{ type: "text", text: `execute_csharp: compile error —\n${compileErr}` }] };
      }
      if (found) {
        let out = found;
        if (found.includes("RESULT=")) out = "RESULT = " + found.split("RESULT=")[1].trim();
        else if (found.includes("ERROR=")) out = "Runtime exception: " + found.split("ERROR=")[1].trim();
        else if (found.includes("DONE")) out = "Executed (no return value).";
        return { content: [{ type: "text", text: `execute_csharp ${id}: ${out}` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `execute_csharp ${id}: no result captured within ${timeout}ms — the snippet may still be compiling, or the log marker wasn't found. Try read_log with filter "${marker}".`,
          },
        ],
      };
    }
  );
}

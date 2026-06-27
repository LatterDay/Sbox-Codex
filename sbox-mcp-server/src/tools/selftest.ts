import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "../transport/bridge-client.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";

/**
 * run_self_test — an end-to-end health check / regression gate. MCP-server-side
 * orchestration (like execute_csharp / screenshot_orbit): it drives the REAL
 * bridge commands so it exercises the actual IPC path, then cleans up after
 * itself (try/finally + a prefix sweep). Refuses to run in play mode.
 */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function report(checks: Check[], override: string | null, runId?: string) {
  const pass = checks.filter((c) => c.ok).length;
  const total = checks.length;
  let verdict = override;
  if (!verdict) {
    verdict =
      pass === total
        ? `HEALTHY — ${pass}/${total} checks passed`
        : pass >= total - 1
          ? `DEGRADED — ${pass}/${total} passed`
          : `BROKEN — only ${pass}/${total} passed`;
  }
  const lines = checks
    .map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? " — " + c.detail : ""}`)
    .join("\n");
  const json = JSON.stringify({ verdict, pass, total, runId: runId ?? null, checks }, null, 2);
  return { content: [{ type: "text" as const, text: `run_self_test: ${verdict}\n\n${lines}\n\n${json}` }] };
}

export function registerSelfTestTools(server: McpServer, bridge: BridgeClient): void {
  server.tool(
    "run_self_test",
    "Run an end-to-end health check of the bridge: create a temp object, add a component, assign + measure a model, capture a screenshot, recompile a temp asset, remove the component — then clean it all up, reporting pass/fail per subsystem. Use it to confirm the install works or to catch regressions before a release. Safe and self-cleaning; refuses to run in play mode.",
    {},
    async () => {
      const runId = Date.now().toString(36);
      const checks: Check[] = [];
      const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
      const send = (cmd: string, p: Record<string, unknown> = {}) => bridge.send(cmd, p, 15000);

      let createdId: string | null = null;
      let projectRoot: string | null = null;
      let tempVmatAbs: string | null = null;
      const tempVmatRel = `materials/__selftest_${runId}.vmat`;

      try {
        // 0. Connectivity
        const pi = await send("get_project_info");
        if (!pi.success) {
          add("connectivity", false, pi.error ?? "no response");
          return report(checks, "BROKEN — bridge not responding. Is s&box running with the Codex Bridge addon?");
        }
        projectRoot = ((pi.data as Record<string, unknown>)?.path as string) ?? null;
        add("connectivity", true, "get_project_info round-trip OK");

        // Pre-flight: refuse in play mode (the battery mutates the scene)
        const ip = await send("is_playing");
        if (ip.success && (ip.data as Record<string, unknown>)?.isPlaying) {
          add("play-mode guard", false, "editor is in play mode");
          return report(checks, "ABORTED — stop play mode first; the self-test mutates the scene.");
        }

        // 1. Create a temp object
        const cg = await send("create_gameobject", { name: `__selftest_${runId}` });
        const cgd = cg.data as Record<string, any> | undefined;
        createdId = cgd?.id ?? cgd?.gameObject?.id ?? cgd?.guid ?? null;
        if (!cg.success || !createdId) {
          add("create_gameobject", false, cg.error ?? "no id returned");
          return report(checks, "BROKEN — couldn't create a GameObject.");
        }
        add("create_gameobject", true, `id ${createdId}`);

        // 2. Add a component
        const ac = await send("add_component_with_properties", { id: createdId, component: "ModelRenderer" });
        add("add_component", ac.success, ac.success ? "ModelRenderer added" : ac.error ?? "fail");

        // 3. Assign a model
        const am = await send("assign_model", { id: createdId, model: "models/dev/box.vmdl" });
        add("assign_model", am.success, am.success ? "box.vmdl" : am.error ?? "fail");

        // 4. Bounds round-trip — non-empty bounds prove the model write took effect
        const gb = await send("get_bounds", { id: createdId });
        const sz = (gb.data as Record<string, any> | undefined)?.size;
        const nonEmpty = !!sz && Math.abs(sz.x ?? 0) + Math.abs(sz.y ?? 0) + Math.abs(sz.z ?? 0) > 0.001;
        add(
          "get_bounds",
          gb.success && nonEmpty,
          gb.success ? (nonEmpty ? "non-empty bounds" : "empty bounds (model not applied?)") : gb.error ?? "fail"
        );

        // 5. Capture (the new RenderToBitmap path)
        const cv = await send("capture_view", { width: 640, height: 360 });
        const cvPath = (cv.data as Record<string, unknown> | undefined)?.path as string | undefined;
        const capOk = cv.success && !!cvPath && existsSync(cvPath);
        add("capture_view", capOk, capOk ? "PNG written" : cv.error ?? "no PNG produced");
        if (cvPath && existsSync(cvPath)) {
          try {
            unlinkSync(cvPath);
          } catch {
            /* best effort */
          }
        }

        // 6. Recompile a temp asset
        const wf = await send("write_file", {
          path: tempVmatRel,
          content: `// selftest\n"Layer0"\n{\n\tshader "shaders/complex.shader"\n}\n`,
        });
        if (wf.success) {
          if (projectRoot) tempVmatAbs = join(projectRoot, tempVmatRel.replace(/\//g, "\\"));
          const rc = await send("recompile_asset", { path: tempVmatRel });
          add("recompile_asset", rc.success, rc.success ? "compiled temp .vmat" : rc.error ?? "fail");
        } else {
          add("recompile_asset", false, `write_file failed: ${wf.error ?? "?"}`);
        }

        // 7. Remove the component (symmetric with step 2)
        const rm = await send("remove_component", { id: createdId, component: "ModelRenderer" });
        add("remove_component", rm.success, rm.success ? "removed" : rm.error ?? "fail");

        return report(checks, null, runId);
      } finally {
        // Cleanup — runs on success, throw, or early-return.
        if (createdId) {
          try {
            await send("delete_gameobject", { id: createdId });
          } catch {
            /* best effort */
          }
        }
        for (const f of [tempVmatAbs, tempVmatAbs ? tempVmatAbs + "_c" : null]) {
          if (f && existsSync(f)) {
            try {
              unlinkSync(f);
            } catch {
              /* best effort */
            }
          }
        }
      }
    }
  );
}

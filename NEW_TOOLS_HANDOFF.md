# Bridge v1.10.0 — Release Handoff (for a fresh session)

Everything below is **code-complete and uncommitted** on top of v1.9.0. The C# addon is **live-compile-verified**; what remains is **functional verification + 2 deferred fixes + version bump + publish**. Open a fresh session with **`C:\Users\cargi\Desktop\sbox-claude` as the working dir** and run the Convergence Sequence.

> Why a fresh session: the session that produced this was extremely long and got sloppy (presented an abbreviated graph as done; mis-bucketed restart-fixable gotchas). The verify + ship is precision work — do it with clean context.

---

## What landed (uncommitted in the repo)

**A. Three new tools** (written; C# compiles live; functional test pending)
- `invoke_method` — call a component method by name **with args** (reflection + the existing coercion). Files: `sbox-bridge-addon/Editor/InvokeMethodHandlers.cs`, `sbox-mcp-server/src/tools/components.ts`.
- `ensure_input_action` — add a custom input action to `<project>.sbproj → Metadata.InputSettings.Actions[]`. Files: `Editor/InputActionHandlers.cs`, `tools/inputs.ts`.
- **play-input driver** (EXPERIMENTAL) — drives the active `PlayerController` directly (since `simulate_input` doesn't trigger `Input.Pressed`). Files: `Editor/PlayInputHandlers.cs`, `tools/playmode.ts`. Needs live play-mode iteration.
- Wiring: `MyEditorMenu.cs` (RegisterHandlers), `index.ts` (`registerInputTools`).

**B. Eight gotcha fixes** (C# in `MyEditorMenu.cs`, live-compile-verified; TS schemas aligned)
1. `set_transform` scale — new `ParseVector3Flexible` accepts object / number(uniform) / array / "x,y,z".
2. `create_gameobject` parentId — `SetParent(keepWorldPosition:false)`; accepts `parent` OR `parentId`.
3. `duplicate_gameobject` + `grid_duplicate` "No Active Scene" — wrapped in `using (scene.Push())` → works in edit mode.
4. `place_along_path` yaw — new `align` + `randomizeYaw` flags; **default = deterministic** (no random yaw).
5. `execute_csharp` leftover `__Exec_*.cs` — `SweepStaleExecFiles()` on bridge start.
6. `spawn_model` ERROR mesh — detects `model.IsError`, returns a `warning` field instead of clean success.
7. vector/color coercion — `VisualHelpers.ParseColorElement` accepts object / "r,g,b,a" / array.
8. TS side: `set_transform` scale, `set_tint` (+`color` alias), `add_light`/`set_fog`/`set_skybox`/etc. color, `get_compile_errors` cascade-filter, `place_along_path` new params, `spawn_model` warning surfaced. **Note:** the shared `Vector3Schema`/`ColorSchema` were widened to object|string unions, so the TS diff is broad (~15 tool files) but mechanical.

**C. NEW gotcha discovered (NOT yet fixed):** `execute_csharp` is broken for **multi-line** snippets in this SDK — the `[ConCmd]` wrapper injects the body **outside class scope** → CS errors. Bug is in `sbox-mcp-server/src/tools/diagnostics.ts`. The fix-agent flagged it; **confirm whether it got fixed or just flagged, and fix it.**

**D. Two restart auto-handle improvements — DEFERRED, STILL TO DO** (go in `MyEditorMenu.cs`, now free):
- "Default Surface not found" on `Scene.Trace` → auto-detect + recover. **First check for a surface-registry *reload* API** (cheaper than a full restart); else auto-`restart_editor` or return a clear hint.
- Newly-added `PackageReference` → auto-restart or warn that `trigger_hotload` won't resolve it.
- After adding these, update `docs/BRIDGE_GOTCHAS.md` to mark them **auto-handled in v1.10.0**.

**E. Graphify map → repo** (landed): `docs/graph/{graph.json,GRAPH_REPORT.md,graph.html,README.md}` + `scripts/regen-graph.ps1` + "Bridge map" pointers in `CLAUDE.md` and `sbox-build-feature/SKILL.md` + a `CHANGELOG [Unreleased]` note. **Regenerating the graph is now part of every release** (regen-graph.ps1 for code-AST; `/graphify` for the full doc-inclusive graph).

**F. Cookbook fold-in** (landed): the 5 session games were **already** covered; the real delta was the **~20 batch-2 games + basebuilder + phenodex**. Added new `references/systems/genetics-breeding.md` + patterns across 10 reference files (networking-authority, worldgen-rendering, physics-traces-movement, architecture, player-controller, save-persistence, building-placement, round-match, spawning-waves, economy-currency).

**G. Known-issues doc** (landed): `docs/BRIDGE_GOTCHAS.md` — engine limits + workflow lessons not code-fixable.

---

## LIVE LIBRARY STATE (important)
The fix-agent **deployed the new 6-file / ~170-handler addon into the live `untitled` project's bridge library** and left it there (it compile-verified + the editor loaded the Gravehold scene clean). So the running bridge is **already the new version** (was 3-file / 166-handler). Old-version backup: `untitled/Libraries/<claudebridge>/Editor/MyEditorMenu.cs.published-bak` (Jun 7) — restore only if you want to revert.

---

## CONVERGENCE SEQUENCE (run in order)
1. **Add the 2 deferred restart fixes (D)** in `MyEditorMenu.cs` → re-sync the addon to the live `untitled` library → `restart_editor` → `get_bridge_status` (confirm handlerCount, ~172).
2. **Confirm/fix `execute_csharp` multi-line wrapper (C)** in `diagnostics.ts`.
3. **`npm run build`** in `sbox-mcp-server` — confirm the broad schema-union TS diff is green; fix any errors. *(The TS agent ran it but confirm fresh.)*
4. **Functional verify** via raw IPC (`ipc.ps1` writes `req_<id>.json`): each new tool (`invoke_method` w/ an arg, `ensure_input_action`, play-input) **and** spot-check fixes (`set_transform` scale as number AND "x,y,z"; `create_gameobject` with parent; `duplicate_gameobject` in edit mode; `spawn_model` bad path → `warning`). Test commands are in `tasks/wivcdwhod.output` (new tools) and `tasks/wk5ub3tf1.output` (fixes).
5. **Regenerate the bridge-map graph** (docs + cookbook changed): `scripts/regen-graph.ps1` (or `/graphify` for full) → copy into `docs/graph/`.
6. **Version bump → v1.10.0:** `sbox-mcp-server/package.json`, `BridgeVersion` in `MyEditorMenu.cs`, `plugins/sbox-claude/.claude-plugin/plugin.json`, the plugin `.mcp.json` server pin, `CLAUDE.md` status header + tool/handler counts, `README` counts, finalize `CHANGELOG [1.10.0]`.
7. **Restart Claude Code** to load the new MCP tools in-session; smoke-test.
8. **Commit.** Then **PUBLISH (user-gated):** `npm publish` → `git push` → republish the s&box Asset Library addon (`IncludeSourceFiles: true`). User does the s&box republish.
9. **Update memory `reference_sbox_bridge_tool_gotchas`:** mark the 8 fixed + 2 auto-handled as **FIXED in v1.10.0**; the rest are now documented in `docs/BRIDGE_GOTCHAS.md`.

---

## Verified vs. pending (honest)
- ✅ C# addon **compiles live** (deployed to the untitled library, hotloaded, editor loaded clean — no CS errors, no Broken Reference).
- ⏳ **Functional behavior** of each new tool + each fix — NOT tested (compile ≠ works). Step 4.
- ⏳ **TS `npm run build`** — re-confirm (Step 3); the diff is broad.
- ⏳ **2 restart fixes + execute_csharp wrapper** — not done (Steps 1–2).
- ⏳ **Version bump + publish** — not done (Steps 6–8).

## Key paths
- Repo: `C:\Users\cargi\Desktop\sbox-claude` · Live project bridge: `<...>\untitled\Libraries\<claudebridge>\Editor\`
- Graph source: `C:\Users\cargi\graphify-out\` · in-repo copy: `docs/graph/`
- Workflow outputs: `...\tasks\wk5ub3tf1.output` (fixes), `w3uywvo39.output` (integrations), `wivcdwhod.output` (new tools)
- Memory: `project_sbox_mcp`, `reference_sbox_claude_dev_workflow`, `reference_sbox_bridge_tool_gotchas`

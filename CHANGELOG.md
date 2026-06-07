# Changelog

All notable changes to the s&box Claude Bridge.

## [1.9.0] — 2026-06-07

**6 new inspection & validation tools — see what replicates, lint your networking, catch scene footguns, read saves/services, drive input. 166 handlers (was 160). Plus a new `sbox-cookbook` recipe skill and an AGPL relicense.** Verified live against the SDK. New TS module `tools/inspection.ts`; the C# handlers are **"Batch 37"** in the addon. Additive — no existing tool contract changed.

### Added — Inspection & validation (Batch 37)

- **`inspect_networked_object`** — dump a single object's `Network.*` state plus **every component's `[Sync]` fields** (flags + live values), so you can see exactly what an object replicates.
- **`networking_lint`** — static scan for multiplayer footguns: unguarded `[Sync]` mutators, money / health / score declared as plain `[Sync]`, `List`/`Dictionary` typed as `[Sync]`, and `[Rpc.Host]` methods that never re-check `Rpc.Caller`.
- **`scene_validate`** — flags scene-setup footguns: no camera in the scene, stray `Rigidbody`s on root objects, and `IsTrigger`-vs-trace mismatches.
- **`save_inspect`** — list / read / diff the project's `FileSystem.Data` save files.
- **`services_query`** — read `Sandbox.Services` stats + leaderboards.
- **`simulate_input`** — drive named input actions in play mode (press / hold a bound action without a keyboard), to exercise input-driven systems.

### Added — `sbox-cookbook` skill

- A new bundled skill: a master **router** indexing **code-grounded recipes** mined from **27 current (2026) open-source s&box games** plus the modern engine repos. Its `references/` hold **11 engine** references (networking-authority, architecture, components-lifecycle, player-controller, ui-razor, combat-weapons, input-interaction, physics-traces-movement, worldgen-rendering, performance-threading, data-assets), **15 systems** (inventory, economy-currency, shop-vendor, save-persistence, progression-upgrades, gacha-loot, leaderboards-services, idle-offline, building-placement, crafting, dialogue, round-match, spawning-waves, anti-cheat, level-design), and **14 genre recipes** (tycoon-idle, shopkeeper, document-sim, roleplay, sandbox-voxel, social-hub, platformer-obstacle, deathmatch-arena, card-battler, survival-horror, gacha-crawler, puzzle, vehicles, party-microgame). Ask "how do I build a tycoon / an inventory / a save system?" and it routes to a grounded how-to. Full bundled skill set: `sbox-api`, `sbox-build-feature`, `sbox-setup`, `sbox-scaffold-game`, `sbox-cookbook`.

### Changed — License

- **Relicensed GPL-3.0 → AGPL-3.0-or-later** (the `LICENSE` file and every `license` field). The AGPL's network/hosted-service clause now applies: if you run a modified bridge as a service, make your modified source available to its users.
- **Added a `NOTICE`** with the AGPL summary plus a **branding/trademark** note: the code is open under AGPL, but the **"s&box Claude Bridge"** / **"sboxskins.gg"** name and branding may not be reused to present a fork as the original.

### Notes

- The 6 new tools need both the updated MCP server (npm `@1.9.0`) and the republished addon (`BridgeVersion` `1.9.0`); the cookbook skill and the license/NOTICE changes are docs-side.
- **No breaking changes** to existing tool contracts.

---

## [1.8.0] — 2026-06-06

**Reliability + correctness pass on core authoring tools, verified live in the editor. Additive — no existing tool contract changed.**

### Fixed
- **`set_property` / `add_component_with_properties` value types now actually apply.** Value-type values reach the addon as strings, and `PropertyDescription.SetValue` does NOT auto-parse a string into `Vector3`/`Vector2`/`Color`/`Rotation` — it silently no-op'd (the long-standing "Vector3 reads back default" bug). `CoercePropertyAndSet` now builds the typed value explicitly (new `ExtractFloats` accepts `"x,y,z"`, `[..]`, or `{...}` forms). Verified: `Vector3` + `Color` set and read back correctly.
- **`set_material_property` auto-creates a `MaterialOverride`** (via `Material.Create`) when none is assigned, instead of erroring "assign a material first." Verified (`autoCreatedMaterial:true`).
- **Runtime-spawned GameObjects are addressable** — `get_/set_property` (and the `*_runtime_property` variants) fall back to scanning the live scene by runtime `.Id` when the persisted-GUID lookup misses, so objects created during play can be targeted.
- **`create_scene` now writes under `Assets/` and registers the scene** — it was writing to a project-root `Scenes/` dir (outside `Assets/`, so unloadable) and not registering with AssetSystem, so `load_scene` failed until a manual `recompile_asset`. It now honours the `path` param under `Assets/`, registers/compiles the scene, and returns the assets-relative path — `create_scene` → `load_scene` works directly. `load_scene` also self-compiles an unregistered scene as a fallback.

### Added / improved
- **`set_fog`** supports `cubemap` (`CubemapFog`) and `volumetric` (`VolumetricFogVolume`) in addition to `gradient`.
- **`invoke_button`** can call methods that take parameters — pass `args` (count-matched, coerced per parameter type).
- **`add_sync_property`** honours `syncFlags` → `[Sync( SyncFlags.X )]`; **`add_rpc_method`** honours `methodParams` → a real method signature.
- **`trigger_hotload`** nudges a recompile of externally-edited C# by bumping project `.csproj` timestamps (falls back to advising play-mode / `restart_editor`).
- Map/terrain/cave/forest tools now expose a `component` override (target a builder named differently than MapBuilder/CaveBuilder/ForestGenerator) and give a clearer "component not found" error pointing to it + the `invoke_button` fallback.

### Known issues
- `create_scene` does not yet generate `includeDefaults` content (camera / light / ground) — it writes an empty scene; add those via `create_gameobject` / `add_light` after loading.

## [1.7.0] — 2026-06-04

**Four-wave release: play-mode eyes, reliability, playable-game scaffolds, and NPC brains. 169 tools / 160 handlers.** Built locally and verified against the live editor (including live play-mode capture and compiling generated code). Additive — no existing tool contract changed.

### Added — Play-mode eyes
- **`capture_view`** — capture a PNG of the scene from a camera via `CameraComponent.RenderToBitmap` + `Bitmap.ToPng`. Unlike `take_screenshot`/`screenshot_from` (editor-only), this renders a camera's view of the ACTIVE scene, so **it works in play mode — capturing the running game** (the player POV + HUD with `renderUI`). No args = the live main camera; `position`/`id` = a temp camera that never disturbs the game's own. Returns the saved PNG path (uniquely named — no filename collisions). VERIFIED capturing the running game.

### Added — Playable-game scaffolds (the non-coder mission)
- **`set_component_reference`** — wire a component property to a live scene GameObject by GUID (the missing gap: `set_property` is primitives-only, `set_prefab_ref` is prefab-assets-only).
- **`add_component_to_new_object`** — atomic create GameObject + add component + set properties.
- **`create_objective_system`** / **`create_health_system`** / **`create_pickup`** — generate self-contained, sandbox-legal gameplay components (the win/lose primitive; health/damage with host-authoritative guards; collectibles). Generated code VERIFIED to compile.
- Bundled **`sbox-scaffold-game`** skill (first-person preset) that orchestrates these into a playable starter.

### Added — NPC brains
- **`create_npc_brain`** — generate an FSM behavior `Component` (Idle/Patrol/Wander/Chase/Search/Flee/Ambush) with occlusion-aware perception (FOV cone + range + LOS trace + hearing) and 5 presets (patrol/guard/hunter/swarm/skittish); host-authoritative + `[Sync] CurrentState` when networked. Generated code VERIFIED to compile + load (full `[Property]` surface).
- **`place_patrol_route`** / **`assign_patrol_route`** — author + wire patrol waypoints into the brain.
- **`create_npc_spawner`** — generate a spawner (continuous / waves / burst, max-alive cap, networked).
- **`simulate_npc_perception`** — READ-ONLY edit-mode verifier: runs the exact FOV+range+LOS check and reports `canSee/inFov/inRange/losBlocked/blockedBy` — verify perception without entering play mode.

### Added — Reliability
- **`run_self_test`** — end-to-end health check / regression gate (create → component → model → bounds → capture → recompile → cleanup), pass/fail per subsystem, self-cleaning, refuses to run in play mode.

### Fixed
- **`create_material` crash** — it called `p.GetProperty("name")` and threw `KeyNotFoundException` when the tool sent `path` (the "dictionary key" bug). Now reads `path` (or legacy `name`/`directory`) and honors `properties`. VERIFIED.
- **`is_playing` stale flag** — `isPlaying` no longer folds in the unreliable `sessionPlaying` (true after a restart); authoritative flag is `gameFlag || tracked`, with `sessionPlaying` kept as a diagnostic field. VERIFIED.
- **`get_bridge_status`** now reports the bridge `version` + `handlerCount` (the tool was reading a dead `editorVersion`); wired to the addon's built-in status command.

### Notes
- `capture_view` + the 5 scaffold + 5 NPC tools need both the updated MCP server and the republished addon; the `create_material`/`is_playing`/`get_bridge_status` fixes are addon-side; `run_self_test` is server-side.
- Deferred to a follow-up: the `create_player_controller` upgrade (third-person/top-down + scene placement — spec'd, with a couple of unverified input APIs to confirm) and `ensure_input_action`.

---

## [1.6.0] — 2026-06-03

**Animation + better eyes. Drive `SkinnedModelRenderer` animgraphs (`set_animgraph_param`, `play_animation`, `list_animations`), read world bounds (`get_bounds`), and capture an object from multiple angles in one call (`screenshot_orbit`). 157 tools / 149 handlers.**

### Added

- **`list_animations`** — list the sequences on a GameObject's `SkinnedModelRenderer` (merges `Sequence.SequenceNames` + `Model.AnimationNames`) and report whether it's AnimationGraph-driven. A spawned Citizen returns 500+ sequences.
- **`set_animgraph_param`** — set an AnimationGraph parameter via `SkinnedModelRenderer.Set(name, value)` — the way to drive Citizen/animgraph motion (e.g. `move_x`/`move_y` float, `b_grounded`/`duck` bool, or a Vector3). Poses preview in-editor when `PlayAnimationsInEditorScene` is on. Verified: `duck=1.0` visibly crouches a Citizen.
- **`play_animation`** — play a named sequence by setting `SkinnedModelRenderer.Sequence` (best for raw-sequence models; for animgraph characters prefer `set_animgraph_param`). Validates the name against the model's sequences and returns the available list on a miss.
- **`get_bounds`** — a GameObject's world-space bounding box: center, size, extents, mins/maxs, radius (`GameObject.GetBounds()`). Objects with no renderer report `empty:true` with their world position.
- **`screenshot_orbit`** — capture an object from several angles in one call. Drives `get_bounds` for framing, then `screenshot_from` per angle (each its own frame — the reliable capture path), spacing shots so s&box's 1-second screenshot filenames don't collide. Returns the saved PNG paths in order for Claude to read.

### Notes

- Additive only — no existing tool contract changes. `set_animgraph_param` / `play_animation` are play-mode-guarded edit-mode tools (like `pose_citizen`); `get_bounds` / `list_animations` are read-only.
- The 5 new tools need both the updated MCP server (npm `@1.6.0`) and the republished addon; existing tools are unaffected by version skew.

---

## [1.5.2] — 2026-06-03

**`recompile_asset` — compile a project asset from the bridge (`Editor.AssetSystem.RegisterFile` + `Asset.Compile`), so an asset Claude writes or edits gets its compiled form regenerated without a manual editor step. 152 tools / 145 handlers.**

### Added

- **`recompile_asset`** — register + compile a project asset by path. Verified on materials (`.vmat` → `.vmat_c`). Pairs with `write_file` / `edit_script`: edit an asset, then recompile it so the change takes effect. Built on the editor's `AssetSystem` (`RegisterFile` → `Asset.Compile(true)`, with a `CompileResource` fallback).

### Notes

- **Particles still can't be authored through the bridge.** This release confirmed *why*: the engine reports "Failed to find compiler for `.vpcf`" — there's no particle compiler reachable from the addon's compile path (unlike materials, whose compiler is loaded). Author particles in s&box's particle editor, then `spawn_vpcf` plays the compiled result.
- No breaking changes.

---

## [1.5.1] — 2026-06-03

**Closes the dev loop + adds library awareness. `restart_editor` lets Claude relaunch the editor itself (no more manual restarts to apply C# changes); `list_libraries` detects installed addons; and a `sbox-setup` onboarding wizard greets new users. 151 tools / 144 handlers.**

### Added

- **`restart_editor`** — restart the s&box editor and wait for the bridge to reconnect (`EditorUtility.RestartEditor` + headless unsaved-scene handling, saves by default). Closes the C#-edit→recompile loop: addon/bridge changes apply without a manual restart. Uses the engine API directly — **no dependency on the `auto_restart` library** (that's just where the mechanism was confirmed).
- **`list_libraries`** — list installed s&box libraries/addons (reads `Libraries/` + each `.sbproj`). Lets Claude discover what's available to build on — character controllers (Shrimple `fish.scc`, `facepunch.playercontroller`), world tools, etc. — and leverage them via `add_component_with_properties` instead of writing from scratch.
- **Setup wizard** — a `sbox-setup` skill plus a connect-time nudge in the MCP `instructions`: welcomes, verifies the bridge, detects libraries, recommends a first move, and points to help + feedback.

### Notes

- No breaking changes — all 1.5.0 tools unchanged.

---

## [1.5.0] — 2026-06-03

**16 new tools — self-diagnosis, aimed screenshots, navmesh + spatial queries, real `.vpcf` particles, console/C# execution, and live docs search — plus a security & correctness hardening pass from an external code audit. Total: 150 tools / 142 handlers.**

### Added

**Self-diagnosis (MCP-server-side — work even when the editor has crashed):**
- `read_log` — tail/filter `sbox-dev.log` directly (auto-locates via Steam `libraryfolders.vdf`, or `SBOX_LOG_PATH`).
- `get_compile_errors` — surface the latest C# compile failures from the log. Claude can finally see its own errors instead of guessing.

**Verification & camera:**
- `screenshot_from` — **aim a screenshot at any object or point.** `take_screenshot` always renders from the scene's Main Camera (one fixed angle), which made most visual changes impossible to verify; `screenshot_from` moves the Main Camera to frame a target, captures, and restores it. This is what makes the authoring layer screenshot-verifiable.
- `frame_camera` — move the editor viewport to focus an object/point (the editor's own view; distinct from the screenshot camera).

**Navigation (real editor ops, not component wrappers):**
- `bake_navmesh` — enable + bake the scene navmesh (`NavMesh.BakeNavMesh`) so agents can path. Async.
- `get_navmesh_path` — query a walkable route between two points (`GetSimplePath`); returns the path or `reachable:false`.

**Spatial & reflections:**
- `physics_overlap` — sphere/box volume query (the volume counterpart to `raycast`): which objects sit in a region.
- `bake_reflections` — bake all `EnvmapProbe`s (`EnvmapProbe.BakeAll`); a placed probe captures nothing until baked.

**Particles:**
- `spawn_vpcf` — play a compiled `.vpcf` via `LegacyParticleSystem` — the reliable particle path (the Batch 18 runtime `ParticleEffect` graph does not render through the bridge). See Known Issues re: source assets.

**Console & C#:**
- `console_run` — run an s&box console command / ConCmd (`ConsoleSystem.Run`).
- `execute_csharp` *(experimental)* — compile + run a C# snippet in the unsandboxed editor context (temp `[ConCmd]` → hotload → run → read result from the log → clean up).

**Object utilities:**
- `remove_component` (counterpart to `add_component_with_properties`), `get_tags` (counterpart to `set_tags`).

**Documentation search (MCP-server-side):**
- `search_docs`, `get_doc_page`, `list_doc_categories` — search the official `Facepunch/sbox-docs` guides (225 pages; git-tree cached + raw Markdown).

### Security & Fixed

External code-audit remediation:
- **Handler errors were reported as success.** The dispatch hardcoded `success=true`, so a handler returning `{ error }` (e.g. "Path traversal denied") surfaced as a successful call — `write_file` even printed "File written successfully". The dispatch now detects a handler-level `error` and reports `success=false`; `write_file` no longer claims false success.
- **Path-traversal hardening.** All file/asset handlers resolve user paths through one separator-safe `TryResolveProjectPath` helper (canonicalize + containment) — 25 call sites. Previously `list_project_files`/`create_script`/`create_scene` had no containment check (a rooted path escaped the project).
- **Generated C# identifiers are sanitized** (`SanitizeIdentifier`) — a `name` with spaces/punctuation/keywords no longer emits an uncompilable `class` declaration.
- **Atomic IPC.** The MCP server writes request files to a temp path then atomically renames, so the editor can't consume a half-written large payload.
- **Honest networking schemas.** `add_sync_property` / `add_rpc_method` params + descriptions now reflect what the addon actually does (annotate an existing property with `[Sync]`; generate an empty RPC stub) instead of advertising unimplemented options.
- **Version pinning + doc reconciliation.** The plugin pins the server version; stale tool counts (78/99/109/131) reconciled to the real totals.

### Notes & Known Issues

- **Particles:** the experimental Batch 18 runtime `ParticleEffect` tools (`spawn_particle` etc.) still do not render visibly through the bridge (confirmed: at most a single flat sprite, nothing in play mode). `spawn_vpcf` is the supported path, but no flame `.vpcf` ships in a bridge-loadable form (`ParticleSystem.Load` returns null for the cloud-cached `impact.generic`); a project-owned `.vpcf` is under investigation.
- `execute_csharp` is experimental (hotload latency; briefly recompiles the project editor assembly).
- The `is_playing` `sessionPlaying` field can read stale (true in edit mode after a restart) — trust `gameFlag`.
- **No breaking changes** to existing tool contracts (networking schema descriptions clarified, not removed).

---

## [1.4.0] — 2026-06-02

**32 new authoring tools across 7 batches — lighting & atmosphere, characters, scene layout, environment scatter, and object utilities. The bridge goes from "manipulate one object at a time" to "compose a whole scene." Tool count 99 → 131 (handlers 100 → 132).**

### Added

**Visual & Atmosphere (Batch 17 — 7 tools)** — author scene mood directly instead of hand-driving `add_component_with_properties` (which can't even set a Color):
- `add_light` — directional / point / spot / ambient. Note: s&box lights have **no brightness field** — intensity is the colour's magnitude, so the `brightness` param scales the colour's RGB (use >1 for HDR).
- `set_fog` (gradient distance haze), `add_post_process` (generic — Bloom / Tonemapping / ColorAdjustments / Vignette / DepthOfField / etc. on the main camera), `set_skybox`, `add_envmap_probe`.
- Presets: `apply_atmosphere` (`horror-night` / `foggy-dawn` / `warm-interior` / `overcast` — a full day→night transform in one call) and `apply_post_fx_look`.

**Characters & Models (Batches 19–20 — 9 tools)** — spawn, dress, pose, accessorize:
- `spawn_model` (any model + tint), `spawn_citizen` (animated Citizen + `CitizenAnimationHelper`, idles in-editor), `dress_citizen` (apply `.clothing` resources via `ClothingContainer`), `set_bodygroup`, `pose_citizen` (hold type / move style / sitting / crouch).
- `equip_model` (attach a prop to a bone or attachment point), `set_look_at` (gaze tracking), `add_ragdoll` (`ModelPhysics`), `set_expression` (facial morphs; call with no morph to list the model's available blendshapes).

**Scene & Level Building (Batch 21 — 5 tools)**:
- `snap_to_ground` (raycast-drop onto the surface below), `align_objects`, `distribute_objects`, `grid_duplicate` (array copies in an X/Y/Z grid), `measure_distance` (read-only).

**Environment & Props (Batch 22 — 3 tools)**:
- `scatter_props` (N model copies in a radius — seeded, ground-snapped, grouped), `randomize_transforms` (yaw/scale variation for a natural look), `group_objects` (reparent a set under a centroid empty).

**Object Utilities & Queries (Batch 23 — 4 tools)**:
- `find_objects` (query by name / component type / tag — read-only, and composable: feed the GUIDs into align / distribute / set_tint / group / delete), `set_tint`, `replace_model`, `set_tags` — each operates on one object or many.

**Experimental — VFX / Particles (Batch 18 — 4 tools):** `spawn_particle`, `create_particle_effect`, `add_trail`, `add_beam`. These compile and build the correct component graph, but **runtime particle rendering is currently unverified through the bridge** — s&box's component `ParticleEffect` needs sprite assets plus a live-play view the bridge can't supply. Shipped as experimental; for guaranteed-visible particles use a legacy `.vpcf` + `LegacyParticleSystem`, or wire them up by hand in the editor.

### Notes

- **Design principle this release — verifiable-first.** Every non-experimental tool produces a static mesh / pose / state that renders in the editor viewport (screenshot-verifiable) or returns checkable data. That's the lesson from the particle batch, which is the one category the bridge fundamentally can't see.
- New MCP tool modules: `tools/visuals.ts`, `tools/characters.ts`, `tools/leveltools.ts`, `tools/objecttools.ts`.
- **No breaking changes** — every v1.3.2 tool is unchanged.

---

## [1.3.2] — 2026-06-02

**Bridge liveness + diagnostics. Fixes the "connected, 0ms ping, but every scene call times out" report: `ping` / `connect` were a file-existence check, not proof the editor was alive.**

### Fixed

- **Permanent false-positive "connected".** `status.json` was written once at startup and never updated or removed, so after the bridge ran even once, `connect()` / `ping()` / `isConnected()` reported "connected" forever — including when the editor was closed, crashed, or its frame loop had stalled (`ping()` only stat'd that file, hence the ~0ms). It is now a **heartbeat**: the addon refreshes `status.json` (with a `heartbeat` timestamp) from the editor frame loop, and the MCP server treats a heartbeat older than 5s as **disconnected**. Driving it from the frame loop means a stalled/closed editor goes stale within seconds — no separate (and unreliable) shutdown event needed. Old addons without a `heartbeat` field are still treated as connected, so upgrading the server alone never regresses a working setup.

### Added

- **`SBOX_BRIDGE_IPC_DIR`** (MCP server) — overrides the IPC directory. The #1 cause of a silent 30s hang is the Node side (`os.tmpdir()`, reads `TEMP` first) and the C# side (`Path.GetTempPath()`, reads `TMP` first) resolving **different** temp dirs; point both at one dir to realign. The addon logs and writes its resolved dir (`[SboxBridge] … IPC at <dir>` and `status.json.ipcDir`) so you know what to match.
- **Timeouts now name the failing side.** Instead of a bare `Request timed out after 30000ms`, a timeout reports whether the editor never consumed the request (not running / wrong IPC dir) or consumed it but never responded (frame loop stalled / handler errored) — with the IPC dir and a pointer to the `[SboxBridge]` console logs.
- **Richer `get_bridge_status`** — reports the IPC directory, heartbeat age, and the result of a real round-trip, so "heartbeat live but requests not draining" is distinguishable from "fully working" and "not connected". Also surfaces the bridge build version.
- **`BridgeVersion`** in `status.json` and the **Editor → Claude Bridge → Status** dialog, so a marketplace-addon-vs-MCP-server skew is visible at a glance.
- **Transport regression tests** — `npm test` (Node's built-in test runner, zero new deps) covers heartbeat-staleness, the timeout diagnostics, and the IPC-dir override.

### Changed

- Removed the misleading **WebSocket / port 29015** references from code and docs. There is no socket — `SBOX_BRIDGE_HOST` / `SBOX_BRIDGE_PORT` are cosmetic (shown only in `get_bridge_status`). INSTALL.md's old "change the port in `MyEditorMenu.cs`" step (the file no longer contains `29015`) is replaced with a temp-dir-mismatch fix guide.

---

## [1.3.1] — 2026-05-16

**Discoverability patch. No tool changes. Surfaces the new Claude Code plugin and the screenshot-driven workflow inside the existing distribution channels.**

### Added

- **`McpServer.instructions`** — the MCP server now ships an `instructions` string that surfaces at the top of every Claude Code session that uses the bridge (the same mechanism Supabase / TurboTax use). It tells Claude how to work effectively with the bridge: call `get_bridge_status` first, take screenshots and read them after visual changes, use `describe_type` before guessing s&box APIs, scene-mutating tools refuse during play mode, and points at the `sbox-claude` plugin for the full workflow.
- **`sbox-mcp-server` README rewritten** — leads with the Claude Code plugin install path, falls back to the manual three-step install. Tool table updated to 99 working (was 78 from v1.0.0 docs). Includes the two-discipline summary: screenshot after visual changes, `describe_type` before guessing.
- **`claudebridge.sbproj` Description rewritten** — mentions the `sbox-claude` plugin install path inline, so users discovering the addon through the s&box Asset Library see the plugin in the first paragraph.

### Why a patch and not a minor

No tool surface changes, no behavior changes outside of the new instructions text that surfaces at session start. Pure DX patch — users on v1.3.0 should upgrade for the better defaults, but nothing they were doing will break.

---

## [1.3.0] — 2026-05-16

**Closes 5 community issues. Critical bootstrap-crash fix, RPCs work without the dock, hierarchy query gets smarter, phantom tools removed.**

### Fixed

- **Editor bootstrap crash on current s&box builds.** `ClaudeBridge`'s static constructor called `Log.Info`, which dispatches to the menu addon's `ConsoleOverlay`. `ConsoleOverlay.OnConsoleMessage` constructs a `ConsoleEntry` panel, and `Panel..ctor()` calls `InitializeEvents()` which accesses `Game.TypeLibrary` — but `TypeLibrary` is explicitly disabled during `PackageLoader.AddAssembly → RunAllStaticConstructors`. Result: `InvalidOperationException: TypeLibrary is currently inaccessible. Reason: Disabled during static constructors.` and any project depending on this addon becomes unopenable. **Fix:** keep the static constructor empty and run logging / handler registration / IPC bridge startup from the first `[EditorEvent.Frame]` callback (gated by an `_initialized` flag) so init happens after bootstrap completes and `TypeLibrary` is accessible. **Original report and patch by [@FurkanZhlp](https://github.com/FurkanZhlp) in [PR #6](https://github.com/LouSputthole/Sbox-Claude/pull/6).**
- **GitHub issue [#2](https://github.com/LouSputthole/Sbox-Claude/issues/2)** — RPCs hung for 30s whenever the **Claude Bridge** dock panel wasn't open. Reason: `[EditorEvent.Frame]` was on an instance method of `BridgePoller : Widget`, so it only fired during the lifetime of the dock instance. **Fix:** moved the frame handler to a static method on `ClaudeBridge` itself — `[EditorEvent.Frame] public static void OnEditorFrame()`. The dock widget remains as a status display but the bridge no longer depends on it being open.
- **GitHub issue [#4](https://github.com/LouSputthole/Sbox-Claude/issues/4)** — `get_scene_hierarchy` ignored its `maxDepth` parameter and always returned the full tree, overflowing token budgets on real scenes. **Fix:** the handler now honors `maxDepth` (default 10) and gates recursion at that depth. **Bonus:** added optional `rootId` parameter to start traversal from a specific GameObject GUID instead of the scene roots — drill into a subtree without paying for the rest of the scene.

### Removed

- **GitHub issue [#3](https://github.com/LouSputthole/Sbox-Claude/issues/3)** — Removed 10 tools from the MCP server that never had handlers in the bridge addon and only ever returned `"Unknown command: ..."`. The s&box editor doesn't expose public APIs for any of these:
  - **console** (3): `get_console_output`, `get_compile_errors`, `clear_console`
  - **playmode** (2): `pause_play`, `resume_play`
  - **publishing** (5): `build_project`, `get_build_status`, `clean_build`, `export_project`, `prepare_publish`
  
  Tool count goes from 109 → 99 (all working). The MCP `--help` listing and README tables are updated to match. For console output, read `<sbox>/logs/sbox-dev.log` directly.

### Confirmed already fixed

- **GitHub issue [#1](https://github.com/LouSputthole/Sbox-Claude/issues/1)** — UTF-8 BOM in response files causing silent JSON.parse failures. Fixed in **v1.0.0** with `new UTF8Encoding(false)` on the C# write side and `.replace(/^﻿/, "")` on the Node read side.
- **GitHub issue [#5](https://github.com/LouSputthole/Sbox-Claude/issues/5)** — Tool invocations timing out after a compile error. Fixed in **v1.2.0** when per-handler registration was made fault-tolerant and `OnFrame` was wrapped in try/catch with deduplicated logging.

### Compatibility

Drop-in upgrade from 1.2.0. No breaking changes to working tools. Tools that were already broken (`get_compile_errors`, etc.) are no longer listed — calls to them now fail at the MCP server with "tool not found" instead of round-tripping to "Unknown command".

### Acknowledgments

- **[@FurkanZhlp](https://github.com/FurkanZhlp)** — diagnosed and patched the editor bootstrap crash. Without this fix the addon doesn't load on current s&box builds at all.
- **[@Jmcasavant](https://github.com/Jmcasavant)** — three detailed bug reports (#1, #2, #3, #4) with stack traces, reproductions, and suggested fixes. Top-tier issue quality, made the fixes nearly mechanical.
- **[@dvd900](https://github.com/dvd900)** — timeout report (#5) that helped validate the v1.2.0 per-handler resilience work.

---

## [1.2.0] — 2026-05-15

**Stability release. Same 100 tools, far more resilient. Fixes three reported bugs.**

### Fixed

- **`install.ps1` / `install.sh` installed to the wrong folder.** The old installers copied the addon into `<sbox>/addons/sbox-bridge-addon/`. That folder is built-in only and silently refuses to compile custom C#, so first-time installs appeared to "do nothing" and users had to install twice (eventually by hand) before the bridge worked. Reported as "I have to install this twice." Installer now targets the project's `Libraries/claudebridge/` folder where libraries actually compile.
- **`Error calling event 'tool.frame' on 'BridgePoller'` spamming every frame.** If `ClaudeBridge`'s static initializer threw (e.g. handler constructor failed on a newer SDK), every subsequent frame re-threw the wrapped `TypeInitializationException` at ~60×/sec, filling the console with the same message. `BridgePoller.OnFrame` now wraps the call in try/catch with message deduplication — the real underlying exception is logged **once per unique error**, not 60×/sec.
- **Scene corruption from tool calls during play mode.** Mutating the scene while `Game.IsPlaying` was true could desync the serializer and corrupt `.scene` files when saved. Reported as "Claude made tons of errors when trying to make a box and broke my project save." `ProcessRequest` now refuses scene-mutating commands during play and returns a clear error: `'create_gameobject' is not allowed while play mode is active. Stop play first (stop_play) and try again.` Safe-during-play tools (read-only, `take_screenshot`, runtime properties, `start_play` / `stop_play`) unaffected.

### Changed

- **Handler registration is now fault-tolerant.** `Register()` takes a `Func<IBridgeHandler>` factory and try/catches construction. One broken handler no longer takes the entire bridge offline — only that tool becomes unavailable, and the failure is logged with the exception type and message for diagnosis.
- **Installer flags:** `-ProjectPath` / explicit project arg (auto-detects if you have one s&box project in `Documents\s&box projects`), `-ListProjects` / `--list` (show projects then exit), `-RemoveStaleAddons` / `--remove-stale` (delete old wrong-location installs).
- **`install.ps1` removes any stale `claudebridge.editor.csproj`** before s&box gets a chance to use it. The auto-generated `.csproj` contains absolute paths to s&box DLLs on the original build machine and breaks installs on other PCs — deleting it lets s&box regenerate one with the right local paths.

### Added

- **`TROUBLESHOOTING.md`** — the 10 most common failure modes, each with diagnosis and fix. Covers wrong install location, frame-error spam, save corruption, dock-closed timeouts, stale `.csproj` paths, `take_screenshot` save location, broken `create_material`, color formatting, MeshComponent material rendering, and MCP server not registering.
- **Single canonical install path in `README.md` + `INSTALL.md`.** Removed the contradictions between Quick Start, INSTALL.md, and Manual Install sections that previously sent users to three different (often wrong) places.

### Honesty Note

The bridge is excellent at building **game systems** through conversation — player controllers, networking, UI, AI, prefabs, sound events, scripts, components, runtime logic. It is **serviceable but not exceptional** at building **maps** — Claude can drive terrain sculpting, forest placement, and cave layout, but it can't see the result, only read coordinates, so visual polish still needs your eyes on it.

### Compatibility

Drop-in upgrade from 1.1.0. No breaking changes to tool signatures or behavior outside play mode.

### Acknowledgments

Thanks to community user **britishtaxi46** for reporting the three user-facing bugs that drove this release. Stability work is reactive — we don't find these without the report.

---

## [1.1.0] — 2026-04-27

**21 new tools, 109 total. Major focus: world editing and code discovery.**

### Added — Map & World Editing

The bridge now drives map-building components that follow a `[Property] List<Feature>` + `[Button]` pattern. Works with any project structured this way; no special integration required.

- `invoke_button` — press any `[Button]` on any component (the keystone tool)
- `list_component_buttons` — discover buttons available on a component
- `add_terrain_hill` / `add_terrain_clearing` / `add_terrain_trail` — sculpt the heightmap by adding features
- `clear_terrain_features` — wipe Hills / Clearings / Trails / CavePath / all
- `raycast_terrain` — sample surface height at world XY (place props on the surface)
- `add_cave_waypoint` / `clear_cave_path` — edit cave tunnel paths
- `add_forest_poi` / `add_forest_trail` — add clearing zones and trail gaps to procedural forests
- `set_forest_seed` / `clear_forest_pois` — re-roll layouts, reset

### Added — Terrain Sculpting & Painting

- `sculpt_terrain` — direct heightmap brush with raise / lower / flatten / smooth modes
- `paint_forest_density` — paint circular biome regions with density multipliers (0 = clearing, 2 = dense)
- `place_along_path` — drop instances of any model along a curve with spacing, jitter, and scale variation

### Added — Code Discovery

Stops Claude from guessing s&box APIs by exposing `Game.TypeLibrary` reflection.

- `describe_type` — full surface of any type: properties, methods, events, attributes
- `search_types` — find types by name pattern, optionally filter to Components only
- `get_method_signature` — formal signature with all overloads, parameter types, defaults
- `find_in_project` — grep the project for a symbol to find usage examples

### Added — Component Reference

- `set_prefab_ref` — assign a prefab GameObject to a component property (the case `set_property` couldn't handle because prefab references are GameObjects, not primitives)

### Added — Standalone Terrain Builder

- `build_terrain_mesh` — build a heightmap terrain mesh from a JSON spec (hills + clearings) without needing a `MapBuilder` component in the scene

### Fixed

- **`is_playing` always returning false** after `start_play` succeeded. Now uses `EditorScene.Play` with `SetPlaying` fallback, plus a `PlayState` tracker that combines multiple signals (manual flag + `Game.IsPlaying` + active-scene divergence).
- **`MeshComponent.Mesh` NullReferenceException** in `build_terrain_mesh`. `MeshComponent.Mesh` is `null` on a freshly-added component and must be assigned `new PolygonMesh()`. Latent in the previous build; surfaced by live testing.
- **`invoke_button` reporting misleading "Button not found" errors.** The reflection helper was catching `TargetInvocationException`, logging a warning, and returning `false` — which masked the actual exception thrown by the invoked method. Now unwraps and rethrows, so callers see the real inner error (e.g. `NullReferenceException: ... at MyComponent.Build()`) directly.

### Removed

- Legacy hardcoded `build_map` inline command (~150 lines of grey-box scene generator). Superseded by the new component-driver pattern.

### Tool Count

| | Before | After |
|---|---|---|
| Defined | 89 | **109** |
| Implemented | 78 | **100** |
| Not implementable (no s&box API) | 11 | **9** |

### Compatibility

- All 78 existing tools unchanged. Drop-in upgrade.
- The new map-edit tools (`add_terrain_hill`, etc.) work on any project with components shaped like `MapBuilder` / `CaveBuilder` / `ForestGenerator` (a `[Property] List<FeatureClass>` plus `[Button]` to rebuild).
- `invoke_button`, `list_component_buttons`, `raycast_terrain`, `set_prefab_ref`, and all four discovery tools work on any project, no specific component required.

### For Game Developers

To make your own components driveable by the named map tools, follow this convention:

```csharp
public class MyHill {
    [Property] public Vector2 Position { get; set; }
    [Property] public float Radius { get; set; } = 500f;
    [Property] public float Height { get; set; } = 100f;
}

public class MyTerrain : Component {
    [Property] public List<MyHill> Hills { get; set; } = new();

    [Button("Build Terrain")]
    public void Build() {
        var go = Scene.CreateObject(true);
        var mesh = go.AddComponent<MeshComponent>();
        if ( mesh.Mesh == null ) mesh.Mesh = new PolygonMesh();  // ← required, easy to miss
        // ... read Hills, generate vertices/faces ...
    }
}
```

The bridge tools find your component via `Game.TypeLibrary`, mutate the `List<>` via reflection, and re-press the `[Button]` — no per-project bridge changes required.

---

## [1.0.0] — 2026-04-10

Initial public release.

- 78 working tools across 18 categories: project, scenes, GameObjects, components, assets, materials, audio, physics, prefabs, play mode, UI, templates, networking, publishing, status.
- File-based IPC transport via `%TEMP%/sbox-bridge-ipc/` (replaced earlier WebSocket attempt — s&box's sandboxed C# blocks `System.Net`).
- Bridge addon as project-local Library at `Libraries/claudebridge/Editor/MyEditorMenu.cs`.
- BOM-less UTF-8 fix on both sides of the IPC channel (C# `new UTF8Encoding(false)` writes, MCP server strips `﻿` reads).
- 11 tools defined-but-not-implementable due to missing s&box APIs: `pause_play`, `resume_play`, `get_console_output`, `get_compile_errors`, `clear_console`, `build_project`, `get_build_status`, `clean_build`, `export_project`, `prepare_publish`.

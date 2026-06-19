# Claude Bridge for s&box
### Build s&box games by talking to Claude — or any AI.

**200+ tools · 190 handlers** that let an AI work *inside* your s&box editor — writing scripts, creating GameObjects, wiring components, and building whole systems: physics, networking, UI, lighting, characters, terrain, and more. You describe what you want; Claude builds it, screenshots it, and fixes it.

But the tools aren't the real story. **The bridge ships a brain.** The companion plugin now bundles `sbox-cookbook` — a deep, code-grounded knowledge base of how to actually build games in s&box, mined from **real, shipped, open-source s&box games** and the modern engine source. So the AI reaches for *proven, shipped patterns* — real inventories, economies, save systems, shops, gacha, progression, multiplayer netcode, whole genre playbooks — instead of guessing.

📬 **Feedback & bugs:** **sboxskins@gmail.com** or [GitHub Issues](https://github.com/LouSputthole/Sbox-Claude/issues)

---

## ⚡ Start here: the one-command plugin (recommended)

If you use Claude Code, install the plugin first. It's the whole experience in one shot:

1. `/plugin marketplace add LouSputthole/Sbox-Claude` — registers the repo as a plugin source
2. `/plugin install sbox-claude` — installs the plugin
3. Restart Claude Code (or run `/reload-plugins`)

That single install gives you:

- **The brain** — `sbox-cookbook`, a code-grounded recipe library of how real s&box games are built (the #1 reason to use this — see below).
- **A specialist agent** tuned to build games *with the bridge* — it knows the workflow, the gotchas, and when to reach for the cookbook.
- **The screenshot workflow skill** — codifies the build → screenshot → verify → fix loop so Claude isn't building blind.
- **Onboarding** — on first connect it checks the bridge, detects your libraries, and suggests a first move.

You still install the **s&box addon** from this page (see **Install** below). The plugin always pulls the latest MCP server automatically.

Not on Claude Code? The bridge still works with any MCP client via npm (see **Install → Method B**) — you just wire the brain in yourself.

---

## 🧠 The brain: build like a real s&box game, not a guess

This is the headline feature, so it gets its own section.

The hardest part of building an s&box game with an AI isn't typing C# — it's *knowing the right pattern*. How do shipped games actually structure an inventory? Where does the money live so a client can't forge it? How do they sign and version a save file? How does a tycoon tick offline earnings? Get those wrong and you get something that compiles but desyncs, dupes currency, or corrupts saves the first time you change a balance number.

`sbox-cookbook` is a **massive, code-grounded knowledge base** that answers exactly those questions — built by mining **real, shipped, open-source s&box games** plus the modern engine repos, then distilling them into recipes that cite real source you can open. It's a router: ask "how do I build a tycoon / an inventory / a save system?" and it loads the grounded how-to for *that* problem.

What it knows, with proven patterns from real games:

- **Genre playbooks** — tycoon / idle, shopkeeper / management, deathmatch / arena, platformer / obstacle course, survival / horror, card-battler, gacha / dungeon-crawler, social-hub, document / inspection sim, puzzle, sandbox / voxel, vehicles, roleplay. Each gives you the system stack to compose, a build order, and how real games did it.
- **Game systems** — inventory, economy / currency, shop / vendor / trading, save / persistence, progression / upgrades / prestige, gacha / loot tables, leaderboards, idle / offline earnings, building & placement, crafting, dialogue, round / match flow, spawning & waves, anti-cheat.
- **Engine fundamentals** — networking & authority, architecture, player controller, Razor UI, weapons / combat, input, physics & traces, component lifecycle, world-gen & rendering, performance & threading, data assets.

And it carries the cross-cutting laws that bite *every* system — authority gating (mutating synced state on a proxy silently rolls back), why money/health/score must be host-authoritative, the request → apply → confirm shape for RPCs, save sanitize-and-clamp-on-load, hotload-safe singletons. The kind of thing you only learn by shipping.

**This is why you use the plugin.** The brain turns "the AI writes plausible C#" into "the AI builds it the way a shipped game would."

---

## A note on the reviews

I've seen the thumbs-down reviews on the Claude Bridge release, and I want to address them directly.

I'm still not certain whether they're from people who simply don't want AI-assisted tools in s&box, or whether the bridge was broken, confusing, or unreliable for some of you. Either way — I want the feedback.

I built this tool for people who have game ideas but don't necessarily know how to code. The goal isn't to replace creativity. It's to give more people a way to build their dream game by letting Claude act like a coding assistant *inside* the editor. You describe what you want, and Claude helps write scripts, create objects, wire components, and build systems that would otherwise be out of reach for non-programmers.

That said — if the tool didn't work for you, that matters. A bad install, a broken tool call, a timeout, a confusing setup step, or missing docs is on me to fix.

The patches have matured a lot since launch. Install paths, tool stability, play-mode safety, timeout confusion, reliability (Claude can read its own errors now), and — the big one this release — the AI no longer *guesses* at how to build a system, because the cookbook brain hands it patterns from real shipped games. A lot of those fixes came straight from user reports, and the reception since has been genuinely positive. Thank you to everyone who took the time to tell me what broke instead of silently launching the tomato cannon. 🍅

If you had a bad experience, please reach out: **sboxskins@gmail.com**. Tell me what happened, what broke, what confused you, or what the bridge should do better. I'll move quickly on real issues and keep improving it.

Thanks to everyone giving it a shot, testing it, breaking it, and helping make it better.

---

## How it works

You describe what you want. Claude does the work.

> **You:** *"Make a player controller with WASD, mouse look, double-jump, and a flashlight."*
> **Claude:** writes the script, adds the component, wires the input, sets up the spotlight — then aims a camera, screenshots it, and checks its own work.

> **You:** *"Build me an inventory system with a hotbar."*
> **Claude:** opens the cookbook's inventory recipe, builds it the way real games do (host-authoritative items, networked, drag-and-drop UI) — then runs `networking_lint` and `inspect_networked_object` to confirm it actually replicates.

**✅ Great at — coding game systems through conversation.**
Player controllers, NPC behavior, networking & multiplayer, UI panels, sound events, prefab wiring, runtime game logic, custom components. With the brain in the loop, it builds inventories, economies, save systems, shops, progression, and whole genre loops the way shipped games do — clean, working s&box C#, iterating from your feedback.

**🟡 Serviceable at — map building.**
Terrain sculpting, forest/cave/trail generation, prop scatter. Claude can **aim a camera and screenshot its own work**, so it's no longer building blind — but final visual polish still wants your eyes.

**⛔ Not yet — particle authoring.**
Claude can *play* a compiled `.vpcf` particle, but s&box compiles those in its particle editor, not through the bridge. Build the effect in-editor, and Claude can spawn + place it.

---

## What it can do (200+ tools · 190 handlers)

**Scene & GameObjects** — create, clone, transform, parent, delete; full hierarchy access + editor selection; find objects by name, component, or tag.

**Scripts & templates** — write / edit / hotload C#; one-shot scaffolds for player controllers, NPC AI, game managers, trigger zones, networked players, and lobby managers.

**Components** — add or remove any of s&box's 130+ components; read/write typed properties (Model, Material, Color, Vector3, Angles…); assign models, materials, and prefab references.

**Physics** — rigidbodies; box / sphere / capsule / hull colliders; fixed / spring / hinge / slider joints; raycasts; and sphere/box **volume overlap** queries.

**Lighting & atmosphere** — lights, fog, post-processing, skyboxes, reflection probes (+ bake), and one-call mood presets: **Horror Night · Foggy Dawn · Warm Interior · Overcast**.

**Characters** — spawn, dress, and pose Citizens; hold types; sit / crouch; equip props to bones; aim gaze; add ragdolls; set facial expressions; drive AnimationGraph params and play named animations.

**Scene layout & environment** — snap-to-ground, align, distribute, grid-duplicate, measure; seeded prop scatter, transform randomization, grouping.

**Terrain & world-gen** — heightmap sculpt brushes (raise / lower / flatten / smooth), hills / clearings / trails, cave paths, forest POIs & density painting, path placement, and a generic `[Button]` driver for any component.

**Navigation** — bake the scene navmesh and query walkable paths.

**UI & audio** — Razor UI components, screen + world panels; sound events, assignment, and in-editor preview.

**Networking** — network spawn, sync properties, RPC methods, network helpers, lobby config.

**Inspection & validation** — see *exactly* what replicates (`inspect_networked_object`), lint a project for multiplayer footguns (`networking_lint`), catch scene-setup mistakes (`scene_validate`), read/diff save files (`save_inspect`), read services/leaderboards (`services_query`), and drive named input actions in play mode (`simulate_input`). The AI can now **verify** multiplayer, saves, and scenes instead of hoping.

**Assets & prefabs** — search + install Asset Library packages; create / instantiate / inspect prefabs; **compile an asset you just wrote or edited** (e.g. a material).

**Self-verify & diagnostics** — **aim a screenshot at any object** and read it back; **read the bridge's own logs and compile errors** (works even if the editor stalls); detect your installed libraries; run console commands; execute C# snippets; and **restart the editor itself** (`restart_editor`) to recompile and apply changes.

**Docs & live API search** — Claude searches the **official s&box docs pulled straight from Facepunch's GitHub** (`search_docs` / `get_doc_page` / `list_doc_categories`) *and* inspects the **real loaded SDK** by live reflection (`describe_type` / `search_types` / `get_method_signature` — every type, method, and property the editor actually has). So it works from the current API and real docs instead of stale guesses — a big reason the generated C# actually compiles.

**Publishing** — validate the project, configure settings, set thumbnails, fetch package details.

---

## What's new

### v1.9 — the brain + see-and-verify
- **A brain that knows real games** — the companion plugin now bundles `sbox-cookbook`, a code-grounded recipe library mined from **real, shipped, open-source s&box games** + the modern engine source. Genre playbooks, system how-tos, and engine references mean the AI builds inventories, economies, saves, shops, gacha, progression, and netcode the way shipped games do — not from a guess. See **The brain** above.
- **Inspection & validation (+6 tools)** — the AI can now *verify* what it builds:
  - `inspect_networked_object` — dump one object's `Network.*` state plus every component's `[Sync]` fields (flags + live values) — see exactly what replicates.
  - `networking_lint` — static scan for multiplayer footguns: unguarded `[Sync]` mutators, money/health/score as plain `[Sync]`, collections as `[Sync]`, `[Rpc.Host]` methods that never re-check the caller.
  - `scene_validate` — flags scene-setup footguns: no camera, stray root `Rigidbody`s, `IsTrigger`-vs-trace mismatches.
  - `save_inspect` — list / read / diff the project's `FileSystem.Data` save files.
  - `services_query` — read `Sandbox.Services` stats + leaderboards.
  - `simulate_input` — drive named input actions in play mode.
  - All six are confirmed live against the SDK. Additive — no existing tool contract changed.

### v1.7 — play-mode eyes, AI brains & playable scaffolds
- **See the running game** — `capture_view` captures the *live* game in play mode (player POV + HUD), not just the edit scene. The bridge's first real play-mode eyes.
- **NPCs that hunt** — `create_npc_brain` generates a full behavior state machine (patrol → chase → search, with FOV cone + line-of-sight + hearing and 5 presets) that *animates* as it moves; plus patrol routes, wave spawners, and an edit-mode perception checker.
- **From scene to *game*** — gameplay scaffolds (`create_health_system`, `create_pickup`, `create_objective_system`, spawners) + wiring tools (`set_component_reference`, `add_component_to_new_object`) turn placed objects into a playable loop. A bundled `sbox-scaffold-game` skill assembles a first-person starter in one ask.
- **Trust & correctness** — a `run_self_test` health check, plus fixes under the hood: `set_property` now sets model/asset/object references reliably, `create_material` / `load_scene` / `stop_play` repaired, and an upgraded `create_player_controller` (first-person / third-person / top-down + auto scene placement).

### v1.6 — animation & better eyes
- **Bring characters to life** — `set_animgraph_param` drives a Citizen's AnimationGraph (walk, crouch, aim, gestures); `play_animation` plays a named sequence; `list_animations` shows every animation a model has (a Citizen has 500+).
- **See it from every side** — `screenshot_orbit` captures an object from several angles in one call, so Claude can verify 3D work from the front, back, and sides instead of guessing from a single view.
- **Know how big things are** — `get_bounds` returns an object's world-space size, center, and extents for precise placement and framing.

### v1.5 — reliability & autonomy
- **Claude reads its own errors** — `read_log` + `get_compile_errors` surface compile failures and logs, even when the editor has stalled. No more guessing.
- **Aimed screenshots** — `screenshot_from` points the camera at any object/point so Claude can actually *see* what it built (and fix the angle).
- **Builds on what you already have** — `list_libraries` detects installed addons (like the Shrimple Character Controller) so Claude drives them instead of reinventing.
- **Compile-from-the-bridge** — `recompile_asset` compiles a material/asset Claude writes or edits.
- **Nav + spatial** — bake navmesh, query paths, sphere/box overlap.
- **Auto-restart** — the bridge can **restart the s&box editor itself** (`restart_editor`) to recompile and apply changes, so new code and bridge updates take effect *without you manually restarting*. Claude closes its own edit → compile → verify loop.
- **In-session docs search** — query the official s&box docs without leaving the conversation.
- **Security & correctness pass** — handler errors now report failure (previously masked as success), path-traversal protection on all file ops, atomic IPC, and honest tool schemas.

### v1.4 — the Scene Authoring update (+32 tools)
The bridge went from editing one object at a time to composing entire scenes: **lighting & atmosphere** (lights, fog, post-FX, skyboxes, reflection probes, mood presets), **characters** (spawn / dress / pose Citizens, equip props, gaze, ragdolls, expressions), **scene layout** (snap, align, distribute, grid-duplicate, measure), **environment** (seeded scatter, randomize, group), and **object utilities** (find by name/component/tag, bulk tint/model/tags). *Verifiable-first:* every non-experimental tool renders in the editor or returns concrete data, so Claude can confirm its own work.

### v1.3 — stability & liveness
- **Honest connection status** — a real heartbeat replaced the old "always connected" false positive; a closed/crashed editor now shows as disconnected within seconds.
- **Frame loop runs without the dock** — the request queue + heartbeat moved to a **static** frame handler, so tool calls process whether or not the Claude Bridge dock is open on-screen.
- **Clearer timeouts** — they now tell you *which* side failed (editor not running, wrong temp dir, stalled handler, IPC mismatch). Realign with `SBOX_BRIDGE_IPC_DIR`.
- **Editor bootstrap crash fixed.**

### v1.2 / v1.1
Reliable first-time install (correct `Libraries/` target), no more `tool.frame` console spam, scene-edits refused during play mode (no save corruption), fault tolerance (one broken tool can't take the rest down), a `TROUBLESHOOTING.md` for the 10 most common failures, plus world-editing, terrain sculpting, forest painting, and live API/type discovery.

*No breaking changes across any of these — every existing tool still works.*

---

## Under the hood

- **File-based IPC — no network, no open ports.** The MCP server writes request files to a temp dir; the addon polls them inside the editor, runs them on the main editor thread, and writes responses back. Everything stays on your machine.
- **Two pieces** — a Node.js MCP server (talks to Claude Code) + a C# editor addon (does the work in s&box).
- **Self-verifying** — Claude screenshots its work, reads its own logs/compile errors, and can lint networking + inspect what replicates, so it can close the build-and-check loop instead of hoping.
- **Fault-tolerant** — a single broken tool is isolated; it can't take the whole bridge offline.
- **Path-safe & play-mode-safe** — file ops are confined to your project; scene edits are refused during play mode with a clear error.
- **Library-aware** — detects the addons already in your project and builds on them.

---

## Install

**Two pieces:** the **addon** (runs in s&box) and the **MCP server** (a Node.js process linking Claude Code to the addon over file IPC). Install the addon once, then connect the Claude side with whichever method you like.

### 1. Install the addon — *everyone*
Click **Install** on this Asset Library page. s&box drops it into your project's `Libraries/claudebridge/` automatically.

### 2. Connect the Claude side — *pick one*

**Method A — Claude Code plugin (recommended).** Use the one-command plugin at the top of this page (`/plugin install sbox-claude`, after `/plugin marketplace add LouSputthole/Sbox-Claude`). It registers the MCP server for you and keeps it updated — *and* bundles the cookbook brain, the specialist agent, the screenshot workflow skill, and onboarding. This is the path that gives you the full experience.

**Method B — manual / npm.**
1. Install **Node.js 18+** → https://nodejs.org/
2. Install **Claude Code**, if you don't have it → https://docs.anthropic.com/en/docs/claude-code
3. Register the server in a terminal:
   ```
   claude mcp add sbox -- npx sbox-mcp-server@latest
   ```
   (Works with any MCP client, not just Claude Code — you just don't get the bundled brain/agent/skill.)

### 3. (Optional) Open the bridge dock
In s&box: **View → Claude Bridge** opens the Status dock, handy for confirming the connection at a glance. **You do *not* need to keep it open** — since v1.3 the bridge's frame loop is a **static** handler that processes requests whether or not the dock is on-screen. Open it if you want the status readout; close it if you'd rather not.

### 4. Verify
In Claude Code (in your project folder), ask *"Check the bridge status"* — you want `connected: true` with a live handler count. Then try:
> *"Create a cube at 0, 0, 100 with a box model."*
> *"Write a player controller with WASD and mouse look."*
> *"Build me a host-authoritative currency system."* (watch it reach for the cookbook)

---

## Architecture

```
Claude Code  ──stdio──>  MCP Server (Node.js)  ──file IPC──>  Editor Addon (C#)  ──>  s&box Editor
                                                  %TEMP%/sbox-bridge-ipc/
```

The MCP server writes request JSON; the addon polls, runs each command on the editor's main thread, and writes the response back. Sandbox-safe (s&box's C# blocks `System.Net`, so there's no socket) and entirely local.

---

## Full tool list

Every tool the bridge exposes, grouped by area (190 editor handlers + a handful of MCP-server-side tools that work even when the editor is down):

**Project, files & scripts (9)** — `get_project_info`, `list_project_files`, `read_file`, `write_file`, `recompile_asset`, `create_script`, `edit_script`, `delete_script`, `trigger_hotload`

**Scenes (4)** — `list_scenes`, `load_scene`, `save_scene`, `create_scene`

**GameObjects & hierarchy (11)** — `create_gameobject`, `delete_gameobject`, `duplicate_gameobject`, `rename_gameobject`, `set_parent`, `set_enabled`, `set_transform`, `get_scene_hierarchy`, `get_selected_objects`, `select_object`, `focus_object`

**Components & properties (9)** — `list_available_components`, `add_component_with_properties`, `remove_component`, `get_property`, `set_property`, `get_all_properties`, `get_runtime_property`, `set_runtime_property`, `set_prefab_ref`

**Physics & spatial (5)** — `add_physics`, `add_collider`, `add_joint`, `raycast`, `physics_overlap`

**Lighting, atmosphere & VFX (13)** — `add_light`, `set_fog`, `add_post_process`, `set_skybox`, `add_envmap_probe`, `bake_reflections`, `apply_atmosphere`, `apply_post_fx_look`, `spawn_particle`, `create_particle_effect`, `add_trail`, `add_beam`, `spawn_vpcf`

**Characters & animation (12)** — `spawn_model`, `spawn_citizen`, `dress_citizen`, `set_bodygroup`, `pose_citizen`, `equip_model`, `set_look_at`, `add_ragdoll`, `set_expression`, `list_animations`, `play_animation`, `set_animgraph_param`

**Scene layout & environment (8)** — `snap_to_ground`, `align_objects`, `distribute_objects`, `grid_duplicate`, `measure_distance`, `scatter_props`, `randomize_transforms`, `group_objects`

**Object utilities (5)** — `find_objects`, `set_tint`, `replace_model`, `set_tags`, `get_tags`

**Terrain & world-gen (17)** — `invoke_button`, `list_component_buttons`, `raycast_terrain`, `build_terrain_mesh`, `sculpt_terrain`, `add_terrain_hill`, `add_terrain_clearing`, `add_terrain_trail`, `clear_terrain_features`, `add_cave_waypoint`, `clear_cave_path`, `add_forest_poi`, `add_forest_trail`, `set_forest_seed`, `clear_forest_pois`, `paint_forest_density`, `place_along_path`

**Navigation (2)** — `bake_navmesh`, `get_navmesh_path`

**UI (3)** — `create_razor_ui`, `add_screen_panel`, `add_world_panel`

**Audio (4)** — `list_sounds`, `create_sound_event`, `assign_sound`, `play_sound_preview`

**Materials (4)** — `assign_model`, `create_material`, `assign_material`, `set_material_property`

**Prefabs (4)** — `create_prefab`, `instantiate_prefab`, `list_prefabs`, `get_prefab_info`

**Networking (10)** — `add_network_helper`, `configure_network`, `get_network_status`, `network_spawn`, `set_ownership`, `add_sync_property`, `add_rpc_method`, `create_networked_player`, `create_lobby_manager`, `create_network_events`

**Inspection & validation (6)** — `inspect_networked_object`, `networking_lint`, `scene_validate`, `save_inspect`, `services_query`, `simulate_input`

**Templates & scaffolds (4)** — `create_player_controller`, `create_npc_controller`, `create_game_manager`, `create_trigger_zone`

**Assets (4)** — `search_assets`, `list_asset_library`, `install_asset`, `get_asset_info`

**Play mode & editor (5)** — `start_play`, `stop_play`, `is_playing`, `undo`, `redo`

**Verify, diagnostics & lifecycle (13)** — `capture_view`, `take_screenshot`, `screenshot_from`, `screenshot_orbit`, `get_bounds`, `run_self_test`, `frame_camera`, `read_log`, `get_compile_errors`, `console_run`, `execute_csharp`, `restart_editor`, `get_bridge_status`

**Discovery & docs (8)** — `describe_type`, `search_types`, `get_method_signature`, `find_in_project`, `list_libraries`, `search_docs`, `get_doc_page`, `list_doc_categories`

**NPC AI (5)** — `create_npc_brain`, `place_patrol_route`, `assign_patrol_route`, `create_npc_spawner`, `simulate_npc_perception`

**Gameplay scaffolds (5)** — `create_health_system`, `create_pickup`, `create_objective_system`, `add_component_to_new_object`, `set_component_reference`

**Publishing (5)** — `get_project_config`, `set_project_config`, `validate_project`, `set_project_thumbnail`, `get_package_details`

---

## Troubleshooting

See **[TROUBLESHOOTING.md](https://github.com/LouSputthole/Sbox-Claude/blob/main/TROUBLESHOOTING.md)** for the most common failure modes. The #1 issue is an **IPC-dir mismatch** — if every tool call times out, the MCP server and the editor addon are watching different temp dirs. Set `SBOX_BRIDGE_IPC_DIR` to the *same* path on both sides (or clear it on both so they share the default `%TEMP%/sbox-bridge-ipc/`). The #2 issue is the **editor not actually running / not finished compiling** — if `get_bridge_status` pings but other tools time out, the editor side isn't processing requests yet; let it finish loading or restart it. (Note: an old guide said the bridge dock must stay open — that's no longer true. Since v1.3 the frame loop is static and runs with the dock closed.)

## Updating
- **Addon:** reinstall from the Asset Library when a new version drops.
- **MCP server:** `npx sbox-mcp-server@latest` pulls the newest version on the next Claude session (the plugin does this automatically).

## Compatibility
s&box current SDK · Node.js 18+ · Claude Code (or any MCP client) · Windows, Linux, macOS

## Tips
- **Use the plugin.** The cookbook brain + specialist agent + screenshot skill is most of the value, and it's one command.
- **Save before a big batch.** Hit Ctrl+S, then turn Claude loose.
- **Use Git** for your project — keep `.scene` files under version control for anything non-trivial.
- **Ask for systems by name.** "Build me an inventory / a save system / a host-authoritative economy" lets the brain route you to a proven recipe.
- **Don't mutate the scene during play mode** — the bridge will refuse with a clear message.

## License
**AGPL-3.0-or-later.** Free to use in your games (free or commercial), free to modify. If you redistribute a modified copy of the bridge itself — or run a modified version as a network/hosted service — release your modified source under AGPL. The code is open, but the **"s&box Claude Bridge" / "sboxskins.gg" name and branding are not licensed for reuse** — you may not use them to present a fork as the original (see **NOTICE**).

## Links
- **GitHub:** https://github.com/LouSputthole/Sbox-Claude
- **Issues / bugs:** https://github.com/LouSputthole/Sbox-Claude/issues
- **npm:** https://www.npmjs.com/package/sbox-mcp-server
- **Feedback:** sboxskins@gmail.com

---

**Two pieces, zero ceremony. 200+ tools · 190 handlers + a brain trained on real shipped games. Describe your game — Claude builds it.**

*Built by [sboxskins.gg](https://sboxskins.gg), the s&box community marketplace.*

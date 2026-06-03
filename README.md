# s&box Claude Bridge

> Let non-coders build s&box games through conversation with Claude Code.

## What This Does

Claude Code connects to the s&box editor in real-time. You describe what you want — Claude writes the C# scripts, builds the scenes, and iterates until it works.

```
You: "Make me a horror game where I explore an abandoned hospital with a flashlight"
Claude: *creates scripts, builds scene, configures lighting, adds player controller*
```

## Architecture

```
┌──────────────┐     stdio      ┌───────────────┐   file IPC     ┌──────────────┐
│  Claude Code │ ◄────────────► │  MCP Server   │ ◄────────────► │ Bridge Addon │
│              │                │  (Node.js)    │   %TEMP%/      │  (in s&box)  │
└──────────────┘                └───────────────┘                └──────┬───────┘
                                                                       │
                                                                       ▼
                                                                ┌──────────────┐
                                                                │ s&box Editor │
                                                                │  (Source 2)  │
                                                                └──────────────┘
```

Communication uses **file-based IPC** through `%TEMP%/sbox-bridge-ipc/` — the MCP server writes request JSON files, the bridge addon (running inside s&box) polls for them, processes on the main editor thread, and writes response files back.

## Quick Start

> **Important:** the bridge addon MUST live inside an s&box **project's** `Libraries/` folder. Putting it in s&box's global `addons/` folder will silently fail to compile. The installer below handles this correctly.

### Fastest path — install the Claude Code plugin

If you use Claude Code, the easiest install is the bundled plugin (under `plugins/sbox-claude/` in this repo). It registers the MCP server automatically and ships the `sbox-build-feature` skill + `sbox-game-dev` agent.

```
/plugin marketplace add LouSputthole/Sbox-Claude
/plugin install sbox-claude
```

You still need to install the **bridge addon** into your s&box project (Steps 1-4 below) — the plugin only handles the Claude side. See `plugins/sbox-claude/README.md` for details.

### Manual install (no plugin)

### 1. Clone and install the bridge into your project

```powershell
# Windows
git clone https://github.com/lousputthole/sbox-claude.git
cd sbox-claude
.\install.ps1                                    # auto-detects your s&box project
# or:
.\install.ps1 -ProjectPath "C:\path\to\your\sbox\project"
.\install.ps1 -ListProjects                      # show all projects, then exit
.\install.ps1 -RemoveStaleAddons                 # also clean up old wrong-location installs
```

```bash
# Linux / WSL / macOS
git clone https://github.com/lousputthole/sbox-claude.git
cd sbox-claude
./install.sh                                     # auto-detects
./install.sh /path/to/your/sbox/project          # explicit
./install.sh --list                              # show projects
./install.sh --remove-stale                      # also clean up old wrong-location installs
```

This copies the bridge to `<your-project>/Libraries/claudebridge/`. If you previously ran an older installer that put files under `<sbox>/addons/`, pass `-RemoveStaleAddons` / `--remove-stale` to clean them up — those files never compiled and only cause confusion.

### 2. Build the MCP server

```bash
cd sbox-mcp-server
npm install
npm run build
```

### 3. Register the MCP server with Claude Code (one-time)

```bash
claude mcp add sbox -- node /full/path/to/sbox-claude/sbox-mcp-server/dist/index.js
```

Or, if you have the published npm package:

```bash
claude mcp add sbox -- npx sbox-mcp-server
```

### 4. Open the bridge dock

In s&box, go to **View → Claude Bridge** to open the dock. **The dock must stay visible** — the bridge's frame handler only fires while the dock is on-screen. If you close it, every Claude tool call will time out.

### 5. Verify

Ask Claude:
```
"Check the bridge status."
```

If it reports `connected: true` and `handlerCount: 142`, you're set. If it times out, see `TROUBLESHOOTING.md`.

> **Tip — verifying visual changes:** `take_screenshot` always renders from the scene's **Main Camera** (one fixed angle). To actually *see* the thing you just changed, use **`screenshot_from`** — it aims the camera at any object or point, captures, and restores. This is the single most useful habit for closing the build-and-check loop.

### 6. Start building

```
"Create a first-person player controller with WASD movement and mouse look"
"Add a cube at position 0,0,100 and give it a box model"
"What scenes are in the project?"
"Create a new script called EnemyAI with patrol behavior"
```

## Available Tools (150 tools / 142 handlers)

The MCP server registers **150 tools**; `get_bridge_status` reports **142** C# handlers compiled inside the s&box editor. Six tools run **MCP-server-side** and need no editor handler — `read_log`, `get_compile_errors`, `execute_csharp`, `search_docs`, `get_doc_page`, `list_doc_categories` — so they keep working even when the editor has crashed or stalled.

> **2026-06-03 (v1.5.0):** +16 tools — self-diagnosis (`read_log`, `get_compile_errors`), aimed screenshots (`screenshot_from`), navmesh (`bake_navmesh`, `get_navmesh_path`), spatial queries (`physics_overlap`), reflections (`bake_reflections`), real `.vpcf` particles (`spawn_vpcf`), console/C# execution (`console_run`, `execute_csharp`), live docs search (`search_docs` etc.), and object utilities (`remove_component`, `get_tags`). Plus a security & correctness hardening pass: handler errors now report `success=false` (were masked as success), path-traversal safety on all file handlers, sanitized generated identifiers, atomic IPC, honest networking schemas. See the **New in v1.5.0** rows below and `CHANGELOG.md`.
>
> **2026-06-02 (v1.4.0):** +32 authoring tools across 7 batches — lighting & atmosphere, characters, scene layout, environment scatter, and object utilities. The bridge goes from one-object-at-a-time to scene composition. See the **New in v1.4.0** rows below.
>
> **2026-05-16 (v1.3.1):** Discoverability patch. MCP server ships `instructions` that surface every Claude Code session and points at the companion plugin. No tool changes.
>
> **2026-05-16 (v1.3.0):** Closes 5 community issues. Fixed editor bootstrap crash (PR #6 by @FurkanZhlp). RPCs now process even when the Claude Bridge dock is closed (#2). `get_scene_hierarchy` honors `maxDepth` + optional `rootId` (#4). Removed 10 phantom tools that never had addon handlers (#3). See `CHANGELOG.md`.
>
> **2026-05-15 (v1.2.0):** Stability release. Fixed install-to-wrong-folder, frame-error spam, and play-mode save corruption; handler registration made fault-tolerant. See `CHANGELOG.md` and `TROUBLESHOOTING.md`.
>
> **2026-04-26 (v1.1.0):** +21 tools — generic component-button invocation, map editing, heightmap sculpt brushes, and type-discovery helpers.



### Working & Tested
| Category | Tools |
|----------|-------|
| **Project & Files** | `get_project_info`, `list_project_files`, `read_file`, `write_file` |
| **Scripts** | `create_script`, `edit_script`, `delete_script` |
| **Scenes** | `list_scenes`, `load_scene`, `save_scene`, `create_scene` |
| **GameObjects** | `create_gameobject`, `delete_gameobject`, `duplicate_gameobject`, `rename_gameobject`, `set_parent`, `set_enabled`, `set_transform` |
| **Hierarchy** | `get_scene_hierarchy`, `get_selected_objects`, `select_object`, `focus_object` |
| **Components** | `get_property`, `set_property`, `get_all_properties`, `list_available_components`, `add_component_with_properties` |
| **Play Mode** | `start_play`, `stop_play`, `is_playing`, `get_runtime_property`, `set_runtime_property` |
| **Assets** | `search_assets`, `get_asset_info`, `assign_model`, `create_material`, `assign_material` |
| **Audio** | `list_sounds`, `create_sound_event`, `assign_sound`, `play_sound_preview` |
| **Prefabs** | `create_prefab`, `instantiate_prefab`, `list_prefabs`, `get_prefab_info` |
| **Physics** | `add_physics`, `add_collider`, `add_joint`, `raycast` |
| **Materials** | `set_material_property` |
| **Templates** | `create_player_controller`, `create_npc_controller`, `create_game_manager`, `create_trigger_zone` |
| **UI** | `create_razor_ui`, `add_screen_panel`, `add_world_panel` |
| **Editor** | `undo`, `redo`, `take_screenshot`, `trigger_hotload` |
| **Networking** | `network_spawn`, `add_sync_property`, `add_rpc_method`, `create_networked_player`, `create_lobby_manager`, `create_network_events`, `add_network_helper`, `configure_network`, `get_network_status`, `set_ownership` |
| **Publishing** | `get_project_config`, `set_project_config`, `validate_project`, `set_project_thumbnail`, `get_package_details`, `install_asset`, `list_asset_library` |
| **Components Extra** | `set_prefab_ref` (assign GameObject prefab to a component property) |
| **World Gen** | `invoke_button`, `list_component_buttons`, `raycast_terrain`, `build_terrain_mesh` |
| **Map Edit** | `add_terrain_hill`, `add_terrain_clearing`, `add_terrain_trail`, `clear_terrain_features`, `sculpt_terrain` |
| **Caves** | `add_cave_waypoint`, `clear_cave_path` |
| **Forest** | `add_forest_poi`, `add_forest_trail`, `set_forest_seed`, `clear_forest_pois`, `paint_forest_density` |
| **Placement** | `place_along_path` |
| **Discovery** | `describe_type`, `search_types`, `get_method_signature`, `find_in_project` |
| **Status** | `get_bridge_status` |

### New in v1.4.0 — scene composition
| Category | Tools |
|----------|-------|
| **Visual & Atmosphere** | `add_light`, `set_fog`, `add_post_process`, `set_skybox`, `add_envmap_probe`, `apply_atmosphere`, `apply_post_fx_look` |
| **Characters & Models** | `spawn_model`, `spawn_citizen`, `dress_citizen`, `set_bodygroup`, `pose_citizen`, `equip_model`, `set_look_at`, `add_ragdoll`, `set_expression` |
| **Scene & Level** | `snap_to_ground`, `align_objects`, `distribute_objects`, `grid_duplicate`, `measure_distance` |
| **Environment** | `scatter_props`, `randomize_transforms`, `group_objects` |
| **Object Utilities** | `find_objects`, `set_tint`, `replace_model`, `set_tags` |
| **VFX (experimental)** | `spawn_particle`, `create_particle_effect`, `add_trail`, `add_beam` — compile but do **not** render through the bridge; use `spawn_vpcf` (below) for visible particles |

### New in v1.5.0 — diagnosis, aimed screenshots, navmesh, particles, docs
| Category | Tools |
|----------|-------|
| **Diagnostics** *(MCP-server-side)* | `read_log`, `get_compile_errors` — read `sbox-dev.log` directly; work even when the editor has crashed |
| **Camera** | `screenshot_from` (**aim a screenshot at any object/point**), `frame_camera` (move the editor viewport) |
| **Navigation** | `bake_navmesh`, `get_navmesh_path` |
| **Spatial** | `physics_overlap` (volume counterpart to `raycast`) |
| **Reflections** | `bake_reflections` (a placed `EnvmapProbe` captures nothing until baked) |
| **Particles** | `spawn_vpcf` — play a compiled `.vpcf` via `LegacyParticleSystem` (the **supported** particle path) |
| **Console / Exec** | `console_run`, `execute_csharp` *(experimental)* |
| **Object Utilities** | `remove_component`, `get_tags` |
| **Docs Search** *(MCP-server-side)* | `search_docs`, `get_doc_page`, `list_doc_categories` — official `Facepunch/sbox-docs` |

### How the World Gen / Map Edit tools work

The `invoke_button` tool is the keystone — it presses any `[Button]` on any component in the scene by attribute label or method name. The map-edit tools (`add_terrain_hill` etc.) build on top: each looks up a target component (default: first `MapBuilder` / `CaveBuilder` / `ForestGenerator` in scene) by reflection, mutates the relevant `[Property] List<>` (e.g. `Hills`, `Path`, `POIs`), and optionally re-invokes the rebuild button.

This means **the tools work on any project** that follows the same component pattern (lists of feature data + a `[Button]` to rebuild). They don't take a hard dependency on the bigfoot game code.

The `Discovery` tools surface `Game.TypeLibrary` reflection so Claude can look up real method signatures, properties, and events instead of guessing API names. Use `describe_type "MeshComponent"` before writing code that touches it.

### Not implemented (no s&box editor API exists)
`pause_play`, `resume_play`, `get_console_output`, `clear_console`, `build_project`, `get_build_status`, `clean_build`, `export_project`, `prepare_publish` — removed from the MCP surface in v1.3.0.

> Note: `get_compile_errors` *used* to be on this list. As of v1.5.0 it's implemented **MCP-server-side** — it reads the compile failures straight out of `sbox-dev.log`, so it needs no editor API. Same for `read_log`.

## Technical Notes

- **No WebSocket**: s&box's sandboxed C# doesn't allow `System.Net`. We use file-based IPC instead.
- **Main thread required**: Scene APIs must run on the editor's main thread. A `[Dock]` widget with `[EditorEvent.Frame]` processes queued requests.
- **Addon location**: Must be in the project's `Libraries/` folder, NOT the global `addons/` folder.
- **UTF-8 BOM**: C#'s `Encoding.UTF8` writes a BOM prefix (`EF BB BF`) that breaks Node.js `JSON.parse`. The bridge writes with `new UTF8Encoding(false)` to avoid this, and the MCP server strips any BOM as a safety net.
- **Dock must be visible**: The `[EditorEvent.Frame]` handler only fires when the Claude Bridge dock widget is open in the editor. If it's closed, no requests will be processed (the frame loop also drives the heartbeat). Still true in v1.5.0 — keep the dock open.
- **Screenshots are fixed to the Main Camera**: `take_screenshot` always renders the scene's Main Camera. Use `screenshot_from` to aim at a specific object/point — otherwise visual changes outside the camera's current framing can't be verified.
- **Particles**: the runtime `ParticleEffect` tools are experimental and don't render through the bridge. Use `spawn_vpcf` (compiled `.vpcf` + `LegacyParticleSystem`) for visible particles.
- **`is_playing.sessionPlaying` can read stale** after a restart — trust the `gameFlag` field.
- **API reference**: Use `describe_type` / `search_types` (live reflection) as the source of truth, or download the full type schema from `sbox.game/api`.

## Development

```bash
# Build MCP Server
cd sbox-mcp-server && npm install && npm run build

# Test IPC manually (PowerShell):
echo '{"id":"test","command":"get_project_info","params":{}}' > $env:TEMP\sbox-bridge-ipc\req_test.json
cat $env:TEMP\sbox-bridge-ipc\res_test.json
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture docs, verified APIs, and lessons learned.

## Credits

Built by [sboxskins.gg](https://sboxskins.gg) — the s&box community marketplace.

## License

**GPL-3.0** — see [LICENSE](LICENSE) for details.

This means you can freely use Claude Bridge in your s&box games (free or commercial). You can modify it for your own use. But if you redistribute a modified version of the bridge itself, you must keep it open source under GPL-3.0 and credit sboxskins.gg.

Copyright (c) 2026 [sboxskins.gg](https://sboxskins.gg)

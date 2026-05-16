# sbox-mcp-server

MCP Server for the s&box game engine. Lets Claude Code build s&box games through conversation — 99 working tools for scenes, scripts, GameObjects, components, assets, materials, audio, physics, UI, networking, publishing, world-gen, and type discovery.

## Fastest install — the Claude Code plugin

If you use Claude Code, the easiest install is the companion plugin. It registers this MCP server automatically, ships a workflow skill, and includes the `sbox-game-dev` specialist agent.

```
/plugin marketplace add LouSputthole/Sbox-Claude
/plugin install sbox-claude
```

You still need to install the s&box-side **bridge addon** into your project's `Libraries/` folder (see step 1 below). The plugin handles the Claude side; the addon handles the s&box side.

## Manual install — three steps

### 1. Install the bridge addon in s&box

The bridge addon runs inside the s&box editor and receives commands from this MCP server. It MUST live inside a project's `Libraries/` folder — putting it in s&box's global `addons/` will silently fail to compile.

```powershell
git clone https://github.com/LouSputthole/Sbox-Claude.git
cd Sbox-Claude
.\install.ps1 -RemoveStaleAddons      # Windows, auto-detects your s&box project
./install.sh --remove-stale            # Linux/Mac/WSL
```

See [INSTALL.md](https://github.com/LouSputthole/Sbox-Claude/blob/main/INSTALL.md) for the full guide and manual fallback.

### 2. Register the MCP server with Claude Code

```bash
claude mcp add sbox -- npx sbox-mcp-server
```

This is the bare command — equivalent to what the plugin's `.mcp.json` does for you.

### 3. Open s&box

Open your project. The bridge starts automatically. Verify with:

```
Check the bridge status.
```

You should see `connected: true, handlerCount: 99`.

## How it works

```
Claude Code → (stdio) → sbox-mcp-server → (file IPC) → bridge addon → s&box editor
```

Communication uses file-based IPC through `%TEMP%/sbox-bridge-ipc/`. The MCP server writes request JSON files, the bridge addon (running inside s&box) polls and processes on the main editor thread, then writes response files back. WebSocket is not used — s&box's sandboxed C# environment blocks `System.Net`.

## Tools (99 working)

| Category | Tools |
|----------|-------|
| **Project** | get_project_info, list_project_files, read_file, write_file |
| **Scripts** | create_script, edit_script, delete_script, trigger_hotload |
| **Scenes** | list_scenes, load_scene, save_scene, create_scene |
| **GameObjects** | create/delete/duplicate/rename, set_parent/enabled/transform |
| **Components** | get/set_property, get_all_properties, list_available, add_component, set_prefab_ref |
| **Hierarchy** | get_scene_hierarchy (with `maxDepth` + `rootId`), get/select/focus_object |
| **Assets** | search_assets, list_asset_library, install_asset, get_asset_info |
| **Materials** | assign_model, create/assign_material, set_material_property |
| **Audio** | list_sounds, create_sound_event, assign_sound, play_sound_preview |
| **Play Mode** | start/stop_play, is_playing |
| **Runtime** | get/set_runtime_property, take_screenshot |
| **Editor** | undo, redo |
| **Prefabs** | create/instantiate_prefab, list_prefabs, get_prefab_info |
| **Physics** | add_physics, add_collider, add_joint, raycast |
| **UI** | create_razor_ui, add_screen_panel, add_world_panel |
| **Templates** | create_player/npc_controller, create_game_manager, create_trigger_zone |
| **Networking** | network_helper, configure/status, spawn, ownership, sync, RPCs, lobby/event templates |
| **Publishing** | project_config, validate, thumbnail, package_details |
| **World gen** | invoke_button, list_component_buttons, raycast_terrain, build_terrain_mesh |
| **Map edit** | add_terrain_hill/clearing/trail, clear_terrain_features, sculpt_terrain |
| **Caves / Forest** | add_cave_waypoint, clear_cave_path, add_forest_poi/trail, set_forest_seed, clear_forest_pois, paint_forest_density |
| **Placement** | place_along_path |
| **Discovery** | describe_type, search_types, get_method_signature, find_in_project |
| **Status** | get_bridge_status |

## Working with Claude effectively

Two disciplines prevent the iteration-loop trap:

1. **After visual changes, call `take_screenshot` and read the PNG.** Claude is a multimodal model — it can see the result. Guessing about visual outcomes from code alone produces long iteration loops.
2. **Before writing code that touches an unfamiliar s&box type, call `describe_type` or `search_types`.** Reflection is the source of truth; training data goes stale across SDK versions.

The companion plugin's `sbox-build-feature` skill encodes this workflow plus the common gotchas. If you're not using the plugin, the same rules apply manually.

## Requirements

- **Node.js 18+**
- **s&box** with the bridge addon installed in your project's `Libraries/` folder
- **Claude Code**

## Documentation

- [Main README](https://github.com/LouSputthole/Sbox-Claude/blob/main/README.md) — full project overview
- [INSTALL.md](https://github.com/LouSputthole/Sbox-Claude/blob/main/INSTALL.md) — install + manual fallback
- [TROUBLESHOOTING.md](https://github.com/LouSputthole/Sbox-Claude/blob/main/TROUBLESHOOTING.md) — 10 most common failures
- [CHANGELOG.md](https://github.com/LouSputthole/Sbox-Claude/blob/main/CHANGELOG.md) — release history
- [Plugin README](https://github.com/LouSputthole/Sbox-Claude/blob/main/plugins/sbox-claude/README.md) — Claude Code plugin docs

## License

**GPL-3.0** — see [LICENSE](../LICENSE) for details.

Copyright (c) 2026 [sboxskins.gg](https://sboxskins.gg)

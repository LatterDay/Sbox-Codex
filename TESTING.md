# Testing Guide

This document provides a test plan for the s&box Codex Bridge. The MCP server exposes its full toolset (`get_bridge_status` reports the editor-handler count; the rest run MCP-server-side). The phases below are a **representative smoke-test plan**, not an exhaustive pass over every tool — the v1.4.0 authoring batches (visual/atmosphere, characters, scene layout, environment, object utilities) and the v1.5.0 additions (diagnostics, aimed camera, navmesh, spatial, reflections, particles, console/exec, docs search) are covered at a representative level in **Phase 8** below. Verify each tool against a running s&box editor.

> **Note:** These tests require s&box running with the Bridge Addon loaded and Codex connected via the MCP server. Most tests modify the active project/scene — use a test project, not a production one.
>
> **Removed tools:** `get_console_output`, `clear_console`, `pause_play`, `resume_play`, `build_project`, `get_build_status`, `clean_build`, `export_project`, and `prepare_publish` were removed from the MCP surface in v1.3.0 (no s&box editor API). Steps that referenced them have been retargeted to the tools that replaced them (`read_log` / `get_compile_errors` for console + compile diagnostics).

## Prerequisites

- [ ] s&box editor installed and running
- [ ] Bridge Addon compiled and loaded (check console for `[SboxBridge] All Phase 1–6 command handlers registered`)
- [ ] MCP server connected (`get_bridge_status` returns connected)
- [ ] A test project open with at least one scene

---

## Phase 1 — Foundation (15 tools)

### Project Awareness

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 1 | `get_project_info` | Call with no params | Returns project path, name, type, dependencies | [ ] |
| 2 | `list_project_files` | Call with `directory: ""` | Returns file tree of project root | [ ] |
| 3 | `list_project_files` | Call with `extension: ".cs"` | Returns only .cs files | [ ] |
| 4 | `read_file` | Pass path to an existing .cs file | Returns file content | [ ] |
| 5 | `read_file` | Pass path outside project (e.g. `../../etc/passwd`) | Returns error (path traversal blocked) | [ ] |
| 6 | `write_file` | Write a new .txt file in project | File created, content correct | [ ] |
| 7 | `write_file` | Write to nested directory that doesn't exist | Directory auto-created, file written | [ ] |

### Script Management

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 8 | `create_script` | Create "TestComponent" with default params | .cs file created with Component boilerplate | [ ] |
| 9 | `create_script` | Create with `content` param (raw mode) | File written with exact raw content | [ ] |
| 10 | `edit_script` | Find/replace a string in existing script | String replaced correctly | [ ] |
| 11 | `edit_script` | Insert line at specific line number | Line inserted at correct position | [ ] |
| 12 | `delete_script` | Delete the test script created above | File removed from disk | [ ] |
| 13 | `delete_script` | Try to delete file outside project | Error (path traversal blocked) | [ ] |
| 14 | `trigger_hotload` | Call after modifying a script | s&box recompiles (check console) | [ ] |

### Log & Compile Errors (MCP-server-side — v1.5.0)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 15 | `read_log` | Call with no filter | Returns the tail of `sbox-dev.log` | [ ] |
| 16 | `read_log` | Call with a `filter` substring | Returns only matching lines | [ ] |
| 17 | `get_compile_errors` | Introduce a syntax error, hotload, call | Returns the latest compile failure(s) from the log | [ ] |
| 18 | `get_compile_errors` | Call with a clean build | Returns no errors | [ ] |

### Scene Operations

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 19 | `list_scenes` | Call in project with scenes | Returns list of .scene files | [ ] |
| 20 | `load_scene` | Pass path to existing scene | Scene loads in editor | [ ] |
| 21 | `save_scene` | Modify scene, call save | Scene saved to disk | [ ] |
| 22 | `create_scene` | Create with `includeCamera: true, includeLight: true` | New .scene file with camera + directional light | [ ] |

---

## Phase 2 — Scene Building (15 tools)

### GameObject Lifecycle

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 23 | `create_gameobject` | Create with name + position | Object appears in scene at position | [ ] |
| 24 | `create_gameobject` | Create with parent GUID | Object parented correctly | [ ] |
| 25 | `delete_gameobject` | Delete object by GUID | Object removed from scene | [ ] |
| 26 | `duplicate_gameobject` | Duplicate with offset | Clone created at offset position | [ ] |
| 27 | `rename_gameobject` | Change object name | Name updated in hierarchy | [ ] |
| 28 | `set_parent` | Move object to different parent | Parent changed in hierarchy | [ ] |
| 29 | `set_parent` | Set parent to null | Object moved to scene root | [ ] |
| 30 | `set_enabled` | Disable then re-enable | Object toggles visibility | [ ] |
| 31 | `set_transform` | Set position/rotation/scale | Transform updated correctly | [ ] |

### Components

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 32 | `get_property` | Read a known property | Returns correct value | [ ] |
| 33 | `set_property` | Write a property value | Value updated on component | [ ] |
| 34 | `get_all_properties` | Call on object with components | Returns all property names + values as JSON | [ ] |
| 35 | `list_available_components` | Call with no filter | Returns component types sorted by group | [ ] |
| 36 | `add_component_with_properties` | Add ModelRenderer with model path | Component added, model assigned | [ ] |

### Hierarchy & Selection

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 37 | `get_scene_hierarchy` | Call on scene with objects | Returns full tree with GUIDs, names, components | [ ] |
| 38 | `get_selected_objects` | Select object in editor, call | Returns selected object info | [ ] |
| 39 | `select_object` | Pass valid GUID | Object selected in editor | [ ] |
| 40 | `focus_object` | Pass valid GUID | Editor camera moves to object | [ ] |

---

## Phase 3 — Assets & Resources (12 tools)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 41 | `search_assets` | Search for "cube" or common model name | Returns matching assets | [ ] |
| 42 | `search_assets` | Search with `type: "model"` | Returns only models | [ ] |
| 43 | `list_asset_library` | Call with search term | Returns community packages | [ ] |
| 44 | `install_asset` | Install a small free package | Package added to project | [ ] |
| 45 | `get_asset_info` | Pass known asset path | Returns metadata (size, type, etc.) | [ ] |
| 46 | `assign_model` | Set model on a GameObject | ModelRenderer created/updated | [ ] |
| 47 | `create_material` | Create a .vmat file | Material file created with shader properties | [ ] |
| 48 | `assign_material` | Apply material to renderer | Material applied to slot | [ ] |
| 49 | `set_material_property` | Change color or roughness | Material property updated | [ ] |
| 50 | `list_sounds` | Call in project with sounds | Returns sound assets | [ ] |
| 51 | `create_sound_event` | Create .sound file | Sound event file created | [ ] |
| 52 | `assign_sound` | Attach to SoundPointComponent | Sound attached to object | [ ] |

---

## Phase 4 — Play & Test (11 tools)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 53 | `start_play` | Call when not playing | Play mode enters | [ ] |
| 54 | `is_playing` | Call during play mode | Returns `gameFlag: true` (trust `gameFlag`, not `sessionPlaying` — it can read stale) | [ ] |
| 55 | `take_screenshot` | Call in editor | Saves a PNG to `<sbox>/screenshots/`; renders the scene's **Main Camera** | [ ] |
| 56 | `screenshot_from` | Aim at a known object/point, call | Main Camera moves to frame the target, captures, then restores | [ ] |
| 57 | `stop_play` | Call during play mode | Returns to editor | [ ] |
| 58 | `get_runtime_property` | Read property during play | Returns live value | [ ] |
| 59 | `set_runtime_property` | Write property during play | Value changes in running game | [ ] |
| 61 | `undo` | Make a change, call undo | Change reverted | [ ] |
| 62 | `redo` | Undo then redo | Change re-applied | [ ] |

---

## Phase 5 — Game Logic (15 tools)

### Prefabs

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 63 | `create_prefab` | Save a GameObject as .prefab | Prefab file created with object data | [ ] |
| 64 | `instantiate_prefab` | Spawn prefab at position | New instance appears in scene | [ ] |
| 65 | `list_prefabs` | Call after creating prefab | Lists the created prefab | [ ] |
| 66 | `get_prefab_info` | Read created prefab | Returns JSON contents | [ ] |

### Physics

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 67 | `add_physics` | Add to object with `collider: "sphere"` | Rigidbody + SphereCollider added | [ ] |
| 68 | `add_collider` | Add BoxCollider with `isTrigger: true` | Trigger collider added | [ ] |
| 69 | `add_joint` | Add spring joint between two objects | SpringJoint created with target | [ ] |
| 70 | `raycast` | Cast ray from above ground downward | Returns hit with position/normal | [ ] |
| 71 | `raycast` | Cast ray with `all: true` | Returns multiple hits | [ ] |

### UI

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 72 | `create_razor_ui` | Create HUD panel | .razor + .razor.scss files created | [ ] |
| 73 | `create_razor_ui` | Create with raw `content` | Custom content written | [ ] |
| 74 | `add_screen_panel` | Create screen panel object | ScreenPanel component on new object | [ ] |
| 75 | `add_world_panel` | Create world panel at position | WorldPanel at specified world position | [ ] |

### Templates

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 76 | `create_player_controller` | Generate FPS controller | Script with CharacterController movement | [ ] |
| 77 | `create_player_controller` | Generate TPS with `type: "third_person"` | Script with third-person camera | [ ] |
| 78 | `create_npc_controller` | Generate patrol NPC | Script with NavMeshAgent patrol logic | [ ] |
| 79 | `create_npc_controller` | Generate with `behavior: "chase"` | Script with chase AI | [ ] |
| 80 | `create_game_manager` | Generate with score + timer | Script with GameState enum, score, countdown | [ ] |
| 81 | `create_trigger_zone` | Generate teleport trigger | Script with ITriggerListener + teleport | [ ] |

---

## Phase 6 — Multiplayer (10 tools)

### Networking Setup

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 82 | `add_network_helper` | Call with no params | Creates "Network Manager" with NetworkHelper | [ ] |
| 83 | `add_network_helper` | Call with `maxPlayers: 4` | NetworkHelper configured with max 4 | [ ] |
| 84 | `configure_network` | Set lobbyName + playerPrefab | NetworkHelper updated | [ ] |
| 85 | `get_network_status` | Call before hosting | Returns `isActive: false` | [ ] |

### Networked Objects

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 86 | `network_spawn` | Spawn a test object on network | Object network-enabled | [ ] |
| 87 | `network_spawn` | Call on already-networked object | Returns `alreadyNetworked: true` | [ ] |
| 88 | `set_ownership` | Take ownership (no connectionId) | Ownership taken by local | [ ] |
| 89 | `set_ownership` | Drop ownership (`connectionId: ""`) | Ownership released | [ ] |

### Script Helpers

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 90 | `add_sync_property` | Add `[Sync] float Health` to script | Property inserted after class brace | [ ] |
| 91 | `add_sync_property` | Add with `syncFlags: "FromHost"` | `[Sync( SyncFlags.FromHost )]` attribute | [ ] |
| 92 | `add_rpc_method` | Add broadcast RPC method | `[Rpc.Broadcast]` method inserted | [ ] |
| 93 | `add_rpc_method` | Add host RPC with body | `[Rpc.Host]` method with custom body | [ ] |

### Multiplayer Templates

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 94 | `create_networked_player` | Generate with health | Script with [Sync], [Rpc.Broadcast], [Rpc.Host] | [ ] |
| 95 | `create_lobby_manager` | Generate with `maxPlayers: 4` | Script with CreateLobby, OnActive, OnDisconnected | [ ] |
| 96 | `create_network_events` | Generate with `includeChat: true` | Script with INetworkListener + chat RPC | [ ] |

---

## Integration Tests

These test multi-tool workflows that simulate real user scenarios.

### Scenario 1: Build a Simple Game

```
1. create_scene → new scene with camera + light + ground
2. create_player_controller → FPS controller script
3. create_gameobject → "Player" object
4. add_component_with_properties → add CharacterController
5. add_component_with_properties → add PlayerController script
6. start_play → enter play mode
7. is_playing → verify playing
8. take_screenshot → capture viewport
9. stop_play → exit play mode
```

**Expected:** Player moves with WASD, camera rotates with mouse.

### Scenario 2: Prefab Workflow

```
1. create_gameobject → "Enemy" with position
2. add_component_with_properties → add ModelRenderer
3. assign_model → set enemy model
4. add_physics → add Rigidbody + BoxCollider
5. create_prefab → save as "prefabs/enemy.prefab"
6. instantiate_prefab → spawn 3 instances at different positions
7. list_prefabs → verify prefab listed
8. get_scene_hierarchy → verify 4 enemy objects in scene
```

### Scenario 3: Multiplayer Setup

```
1. create_networked_player → network-aware controller
2. create_lobby_manager → lobby management
3. add_network_helper → add NetworkHelper to scene
4. configure_network → set maxPlayers, playerPrefab
5. get_network_status → verify configured but not active
6. create_network_events → event handler with chat
```

### Scenario 4: UI Overlay

```
1. create_razor_ui → HUD panel with health/score
2. add_screen_panel → ScreenPanel container
3. create_game_manager → game manager with score
4. start_play → enter play mode
5. take_screenshot → verify HUD visible
```

### Scenario 5: Error Recovery (v1.5.0 self-diagnosis)

```
1. create_script → write broken C# (missing semicolon)
2. trigger_hotload → force compile
3. get_compile_errors → see the error (read straight from sbox-dev.log)
4. edit_script → fix the syntax error
5. trigger_hotload → recompile
6. get_compile_errors → verify clean
```

### Scenario 6: Config & Validate Workflow

```
1. get_project_config → read current config
2. set_project_config → set title, description, version
3. set_project_thumbnail → add thumb.png
4. validate_project → check all requirements pass
```

> Build/export/publish are done from the s&box editor UI, not the bridge (those tools were removed in v1.3.0).

### Scenario 7: Visual Verification (v1.5.0)

```
1. create_gameobject → "Subject" at a known position
2. assign_model → give it a visible model
3. screenshot_from → aim the camera at "Subject", capture
4. Read the PNG → confirm the model is framed and visible
```

---

## Phase 7 — Publishing (10 tools)

### Project Configuration

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 97 | `get_project_config` | Call with no params | Returns full .sbproj config including title, type, metadata, raw JSON | [ ] |
| 98 | `set_project_config` | Set `title: "Test Game"` | Title updated, saved to .sbproj | [ ] |
| 99 | `set_project_config` | Set `description`, `version`, `summary` | All fields updated | [ ] |
| 100 | `set_project_config` | Set `type: "game"` | Project type changed | [ ] |
| 101 | `set_project_config` | Set `isPublic: true` | Metadata.Public set to true | [ ] |
| 102 | `validate_project` | Call on project with title + scenes | Returns valid: true with all checks passed | [ ] |
| 103 | `validate_project` | Call on project missing title | Returns valid: false, title check failed | [ ] |

### Thumbnail & Packages

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 104 | `set_project_thumbnail` | Set via `sourcePath` to existing PNG | thumb.png created from source | [ ] |
| 105 | `set_project_thumbnail` | Set via `base64` data | Image written from base64 | [ ] |
| 106 | `set_project_thumbnail` | Source path outside project | Error: path must be within project | [ ] |
| 107 | `get_package_details` | Fetch known package (e.g. "facepunch.flatgrass") | Returns title, author, downloads, version | [ ] |
| 108 | `get_package_details` | Fetch non-existent package | Error: Package not found | [ ] |

> `build_project`, `get_build_status`, `clean_build`, `export_project`, and `prepare_publish` were removed in v1.3.0 (no s&box editor API). Build/publish from the s&box editor UI directly.

---

## Phase 8 — Authoring, diagnosis & spatial (v1.4.0 + v1.5.0, representative)

These cover the newer batches at a representative level — not every tool, but at least one per category. Most produce a static result you can verify with `screenshot_from`.

### Visual & Atmosphere (v1.4.0)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 120 | `add_light` | Add a `point` light with a color + `brightness: 2` | Light object created; scene visibly lit (no separate brightness field — brightness scales the color) | [ ] |
| 121 | `set_fog` | Apply gradient distance fog | Fog visible in a `screenshot_from` | [ ] |
| 122 | `apply_atmosphere` | Apply `horror-night` | Lighting/fog/skybox transform applied in one call | [ ] |
| 123 | `add_post_process` | Add `Bloom` to the main camera | Bloom component present | [ ] |

### Characters (v1.4.0)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 124 | `spawn_citizen` | Spawn an animated Citizen | Citizen present + idles in editor (CitizenAnimationHelper) | [ ] |
| 125 | `dress_citizen` | Apply a `.clothing` resource | Clothing visible on the citizen | [ ] |
| 126 | `pose_citizen` | Set a sitting/crouch pose | Pose applied | [ ] |

### Scene layout & object utilities (v1.4.0)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 127 | `snap_to_ground` | Drop an object onto the surface below | Object lands on the surface | [ ] |
| 128 | `grid_duplicate` | Array-copy an object 3×3 | 9 copies in a grid | [ ] |
| 129 | `scatter_props` | Scatter N copies of a model in a radius | Seeded, ground-snapped, grouped copies | [ ] |
| 130 | `find_objects` | Query by component type | Returns matching GUIDs (composable into align/distribute/group) | [ ] |
| 131 | `set_tint` | Tint a found object | Tint applied | [ ] |

### Diagnostics, camera, navmesh, spatial, reflections, particles (v1.5.0)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 132 | `frame_camera` | Focus the editor viewport on an object | Viewport moves to the object (distinct from the screenshot camera) | [ ] |
| 133 | `bake_navmesh` | Enable + bake the scene navmesh | Returns success (async); navmesh present | [ ] |
| 134 | `get_navmesh_path` | Query a route between two reachable points | Returns the path, or `reachable: false` if blocked | [ ] |
| 135 | `physics_overlap` | Sphere query a region containing objects | Returns the objects inside the volume | [ ] |
| 136 | `bake_reflections` | Add an `EnvmapProbe`, then bake | Probe captures the scene after baking | [ ] |
| 137 | `spawn_vpcf` | Play a compiled `.vpcf` via LegacyParticleSystem | Particle effect plays (the runtime `ParticleEffect` tools do **not** render through the bridge) | [ ] |
| 138 | `remove_component` | Add then remove a component | Component gone | [ ] |
| 139 | `get_tags` | Set tags, then read them back | Returns the tags set with `set_tags` | [ ] |
| 140 | `console_run` | Run a benign ConCmd | Command executes | [ ] |
| 141 | `execute_csharp` *(exp)* | Run a snippet that logs a value | Result read back from the log (brief recompile) | [ ] |

### Docs search (v1.5.0, MCP-server-side)

| # | Tool | Test Steps | Expected Result | Status |
|---|------|-----------|-----------------|--------|
| 142 | `list_doc_categories` | Call with no params | Returns the `Facepunch/sbox-docs` category list | [ ] |
| 143 | `search_docs` | Search for "navmesh" | Returns matching guide pages | [ ] |
| 144 | `get_doc_page` | Fetch a known page path | Returns the page Markdown | [ ] |

---

## Security Tests

| # | Test | Steps | Expected |
|---|------|-------|----------|
| S1 | Path traversal (read) | `read_file` with `../../etc/passwd` | Error: path must be within project |
| S2 | Path traversal (write) | `write_file` with `../../../tmp/evil` | Error returned **and** `success: false` (v1.5.0 — was previously masked as success) |
| S3 | Path traversal (delete) | `delete_script` with `../../system.dll` | Error: path must be within project |
| S4 | Path traversal (load scene) | `load_scene` with `../../etc/hosts` | Error: path must be within project |
| S5 | Path traversal (list) | `list_project_files` with a rooted path outside the project | Error: path must be within project (v1.5.0 added containment here) |
| S6 | Invalid GUID | `delete_gameobject` with `not-a-guid` | Error: Invalid GUID |
| S7 | Missing object | `get_property` with random valid GUID | Error: GameObject not found |
| S8 | Path traversal (create_script) | `create_script` with a rooted path outside the project | Error: path must be within project (v1.5.0 added containment here) |
| S9 | Path traversal (thumbnail) | `set_project_thumbnail` with `../../etc/passwd` | Error: path must be within project |
| S10 | Identifier sanitization | `create_script` with a `name` containing spaces/punctuation | Emits a compilable class (sanitized identifier), not broken C# (v1.5.0) |

---

## Performance Tests

| # | Test | Steps | Expected |
|---|------|-------|----------|
| P1 | Large scene hierarchy | Create 100+ objects, call `get_scene_hierarchy` | Returns within 5s, complete tree |
| P2 | Rapid sequential calls | Call `get_project_info` 20 times quickly | All return successfully, no crashes |
| P3 | Large file write | `write_file` with 100KB content | File written correctly |
| P4 | Concurrent tool calls | Call 5 different tools via batch | All respond within 30s timeout |

---

## Bridge Connection Tests

| # | Test | Steps | Expected |
|---|------|-------|----------|
| B1 | Status check | `get_bridge_status` | Returns connected, reports IPC dir + heartbeat age + a real round-trip result |
| B2 | Reconnection | Restart s&box, retry tool | Reconnects automatically |
| B3 | Timeout | Call tool with the dock closed / editor frozen | Times out after 30s; the error names the failing side (never consumed vs. consumed-but-no-response) |
| B4 | Heartbeat staleness | Close s&box, then call `get_bridge_status` | Reports **disconnected** once the heartbeat is >5s stale (no false-positive "connected") |
| B5 | IPC dir mismatch | Set `SBOX_BRIDGE_IPC_DIR` to a dir the addon isn't using | Requests time out; fix by matching the addon's `status.json.ipcDir` |

---

## Test Execution Notes

- Tests marked `[ ]` are pending. Mark `[x]` when passing.
- Some s&box APIs have `API-NOTE` comments in handlers — these may need adjustment for your specific SDK version.
- `take_screenshot` saves a PNG to `<sbox>/screenshots/` and renders the scene's **Main Camera**. Use `screenshot_from` to aim at a specific object/point — otherwise visual changes outside the camera's framing can't be verified.
- Networking tests (Phase 6) require either a running lobby or may only verify setup/code generation.
- The transport layer has automated regression tests: run `npm test` in `sbox-mcp-server/` (heartbeat staleness, timeout diagnostics, IPC-dir override).
- Run security tests in an isolated environment to prevent accidental file modifications.

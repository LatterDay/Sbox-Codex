# s&box + Claude Code MCP Integration

> Let non-coders build s&box games through conversation with Claude Code.

## Status: v1.5.2 (run `get_bridge_status` for the live tool/handler count)

**Last updated:** 2026-06-03 (v1.5.2)
**Bridge:** File-based IPC ✅ working on main thread
**Tools:** MCP `server.tool()` registrations across `sbox-mcp-server/src/tools/`
**Handlers:** C# command handlers compiled and registered (verified via the live bridge)
**Why the difference:** 6 tools are **MCP-server-side** and need no editor handler — `read_log`, `get_compile_errors`, `execute_csharp`, `search_docs`, `get_doc_page`, `list_doc_categories`. They read the log file / fetch docs / hotload-eval directly, so they work even when the editor has crashed or stalled.

### What's new in v1.5.0

**+16 tools** — self-diagnosis, aimed screenshots, navmesh + spatial queries, real `.vpcf` particles, console/C# execution, and live docs search — plus a **security & correctness hardening pass** from an external code audit. Grouped:

- **Diagnostics (MCP-server-side):** `read_log` (tail/filter `sbox-dev.log`, auto-located via Steam `libraryfolders.vdf` or `SBOX_LOG_PATH`), `get_compile_errors` (surface the latest C# compile failures from the log — Claude can finally see its own errors instead of guessing).
- **Camera:** `screenshot_from` (**aim a screenshot at any object/point** — see the gotcha below), `frame_camera` (move the editor viewport to focus an object/point).
- **Navigation:** `bake_navmesh` (enable + bake `NavMesh.BakeNavMesh`, async), `get_navmesh_path` (query a walkable route via `GetSimplePath`; returns the path or `reachable:false`).
- **Spatial:** `physics_overlap` (sphere/box volume query — the volume counterpart to `raycast`).
- **Reflections:** `bake_reflections` (`EnvmapProbe.BakeAll` — a placed probe captures nothing until baked).
- **Particles:** `spawn_vpcf` (play a compiled `.vpcf` via `LegacyParticleSystem` — the supported particle path; the Batch 18 runtime `ParticleEffect` tools do not render through the bridge).
- **Console/Exec:** `console_run` (`ConsoleSystem.Run`), `execute_csharp` *(experimental)* (compile + run a C# snippet in the unsandboxed editor context via a temp `[ConCmd]` → hotload → run → read result from the log → clean up).
- **Object utilities:** `remove_component` (counterpart to `add_component_with_properties`), `get_tags` (counterpart to `set_tags`).
- **Docs search (MCP-server-side):** `search_docs`, `get_doc_page`, `list_doc_categories` (search the official `Facepunch/sbox-docs` guides — git-tree cached + raw Markdown).

**Security & correctness hardening (external audit):**
- **Handler errors now report `success=false`.** The dispatch hardcoded `success=true`, so a handler returning `{ error }` (e.g. "Path traversal denied") surfaced as a *successful* call — `write_file` even printed "File written successfully". Fixed; `write_file` no longer claims false success.
- **Path-traversal hardening** — all file/asset handlers resolve user paths through one separator-safe `TryResolveProjectPath` helper (canonicalize + containment), 25 call sites. Previously `list_project_files`/`create_script`/`create_scene` had no containment check.
- **Generated C# identifiers are sanitized** (`SanitizeIdentifier`) — a `name` with spaces/punctuation/keywords no longer emits an uncompilable `class` declaration.
- **Atomic IPC** — the MCP server writes request files to a temp path then atomically renames, so the editor can't consume a half-written large payload.
- **Honest networking schemas** — `add_sync_property` / `add_rpc_method` params + descriptions now reflect what the addon actually does (annotate an existing property with `[Sync]`; generate an empty RPC stub).

New TS modules this release: `tools/diagnostics.ts`, `tools/docs.ts`, `tools/navigation.ts`. Full notes in `CHANGELOG.md` [1.5.0]. **No breaking changes** to existing tool contracts.

### What's new in v1.4.0 (previous)

**+32 authoring tools across 7 batches** — the bridge goes from one-object-at-a-time to scene composition:
- **Visual & Atmosphere (Batch 17):** `add_light`, `set_fog`, `add_post_process`, `set_skybox`, `add_envmap_probe`, `apply_atmosphere`, `apply_post_fx_look`.
- **Characters & Models (Batches 19–20):** `spawn_model`, `spawn_citizen`, `dress_citizen`, `set_bodygroup`, `pose_citizen`, `equip_model`, `set_look_at`, `add_ragdoll`, `set_expression`.
- **Scene & Level (Batch 21):** `snap_to_ground`, `align_objects`, `distribute_objects`, `grid_duplicate`, `measure_distance`.
- **Environment (Batch 22):** `scatter_props`, `randomize_transforms`, `group_objects`.
- **Object Utilities (Batch 23):** `find_objects`, `set_tint`, `replace_model`, `set_tags`.
- **Experimental — VFX/Particles (Batch 18):** `spawn_particle`, `create_particle_effect`, `add_trail`, `add_beam` — compile + build the component graph, but runtime rendering is **unverified through the bridge** (use `spawn_vpcf` for visible particles). New TS modules: `tools/{visuals,characters,leveltools,objecttools}.ts`.

---

## Architecture

```
Claude Code → (stdio) → MCP Server → (file IPC) → Bridge Addon → s&box Editor
                          Node.js        %TEMP%/sbox-bridge-ipc/     C# in Editor
```

**NOT WebSocket.** s&box's sandboxed C# environment does not allow `System.Net` (HttpListener, WebSocket, TcpListener). Communication uses **file-based IPC**:

1. MCP Server writes `req_<id>.json` to the temp directory
2. Bridge addon polls for request files via `System.Threading.Timer` (50ms)
3. Requests are queued and processed on the **main editor thread** (required for scene APIs)
4. Bridge writes `res_<id>.json` back
5. MCP Server polls for response files

IPC directory: `%TEMP%/sbox-bridge-ipc/` (typically `C:\Users\<user>\AppData\Local\Temp\sbox-bridge-ipc\`)

Two components:
1. **MCP Server** (`sbox-mcp-server/`) — TypeScript/Node.js, stdio transport, talks to Claude Code
2. **Bridge Addon** — C# editor library, lives in the s&box **project's Libraries folder**

---

## Critical Lessons Learned

### Addon Location
- **DO NOT** put addons in the global `sbox/addons/` folder — those are built-in only and won't compile custom code
- **DO** put addons in the project's `Libraries/` folder (e.g., `bigfoot/Libraries/claudebridge/`)
- s&box auto-scaffolds `Editor/`, `Code/`, `UnitTests/` with proper `.csproj` files when you create a library through the editor

### Compilation
- s&box compiles addons silently — if there are errors, **no log output appears** unless you check the full log
- Check `logs/sbox-dev.log` or the console for `Compile of 'local.X.editor' Failed:` messages
- The `.csproj` file is required and must reference s&box DLLs with absolute paths
- s&box generates the `.csproj` automatically when you create a library through the Library Manager

### Main Thread Requirement
- All scene manipulation APIs (`CreateObject`, `AddComponent`, `Destroy`, etc.) **must run on the main editor thread**
- `System.Threading.Timer` callbacks run on thread pool threads — NOT safe for scene APIs
- Solution: Timer reads files from disk (thread-safe), queues them, and a `[EditorEvent.Frame]` handler on a `[Dock]` widget processes them on the main thread

### Class Discovery
- s&box discovers classes via attributes like `[Menu]`, `[Dock]`, `[EditorEvent.Frame]`
- Static constructors fire when the type scanner discovers the class
- `[Event("editor.created")]` fires BEFORE custom addons load — don't rely on it
- `[Event("editor.loaded")]` does NOT exist

### s&box API Key Differences (vs. what was originally coded)
- `SceneEditorSession.Active.Scene` — the editor scene (NOT `Game.ActiveScene` which is for play mode)
- `go.AddComponent<T>()` — add component (NOT `go.Components.Create<T>()`, though ComponentList.Create also exists)
- `go.GetOrAddComponent<T>()` — get existing or add
- `go.GetComponent<T>()` — get existing
- `SceneEditorSession.Active.Selection` — editor selection (NOT `EditorScene.Selection`)
- `SceneEditorSession.Active.SetPlaying(scene)` / `.StopPlaying()` — play mode
- `SceneEditorSession.Active.FrameTo(bbox)` — focus camera on object
- `SceneEditorSession.Active.Save()` — save scene
- `Game.TypeLibrary.GetType("name")` — find types
- `Game.TypeLibrary.GetTypes<Component>()` — list all component types
- `MeshCollider` does NOT exist — use `HullCollider` instead
- `Rotation.Pitch()`, `.Yaw()`, `.Roll()` are methods, not properties

### Math & Events (s&box sandbox specifics)
- `MathX.Clamp(value, min, max)` — NOT `System.Math` or `MathF` (neither exists in s&box sandbox)
- `System.MathF` does NOT exist in s&box's C# sandbox
- `IGameEvent` / `GameObject.Dispatch()` / `Scene.Dispatch()` are from `facepunch.libevents` package, NOT base s&box
- `Networking.MaxPlayers` is **read-only** — set via lobby config, not direct assignment
- `Networking.IsHost` may throw if networking is not active — guard with try/catch or check `Networking.IsActive` first

### UTF-8 BOM (Critical IPC Bug — Fixed)
- C#'s `Encoding.UTF8` writes a BOM prefix (`EF BB BF`) at the start of files
- Node.js `JSON.parse` rejects the BOM: `Unexpected token '﻿'` — but the `catch` block in the polling loop swallowed this silently, causing every response to time out
- **Bridge fix**: Use `new UTF8Encoding(false)` for all IPC file writes (status.json, res_*.json)
- **MCP server fix**: Strip BOM with `.replace(/^\uFEFF/, "")` before `JSON.parse` as a safety net
- Both fixes are applied — belt and suspenders

### Bridge Behavior Notes
- Bridge **drains the full request queue every editor frame** (`ProcessPendingOnMainThread` while-loop) — NOT one-per-frame. A single very slow handler still blocks that frame until it finishes (see the optional per-frame time-budget TODO).
- If game code fails to compile, the editor code (bridge) also fails (`Broken Reference: package.local.X`)
- Bridge Status menu item always works even when frame processing is broken (it's a sync call)
- The bridge's `[EditorEvent.Frame]` is a **static** handler (moved off the dock widget — GitHub issue #2), so the request queue + heartbeat process **whether or not the dock is open**. (Frames may still throttle when the editor window is minimized/unfocused — OS-level; unverified.)
- `Org` in `.sbproj` must be `"local"` for local development — only set to your org name when publishing

### Visual Verification & Other v1.5.0 Gotchas
- **`take_screenshot` renders from the scene's Main Camera — ONE fixed angle.** This is the #1 reason visual changes "can't be verified": the Main Camera may not be pointed at the thing you changed. Use **`screenshot_from`** to move the Main Camera to frame a target object/point, capture, and restore it. `screenshot_from` is the tool that makes the authoring layer screenshot-verifiable. (`frame_camera` only moves the editor *viewport*, which the screenshot doesn't use.)
- **Particles:** the runtime `ParticleEffect` tools (`spawn_particle` / `create_particle_effect` / `add_trail` / `add_beam`) are **experimental and do not render through the bridge**. Use **`spawn_vpcf`** (a compiled `.vpcf` via `LegacyParticleSystem`) for visible particles. See `CHANGELOG.md` [1.5.0] Known Issues re: source `.vpcf` assets.
- **`is_playing.sessionPlaying` can read stale** (it reports `true` in edit mode after a restart). Trust the `gameFlag` field instead.
- **Self-diagnosis works even when the editor is down:** `read_log` and `get_compile_errors` read `sbox-dev.log` directly (MCP-server-side), so Claude can diagnose a crashed/stalled editor without a live round-trip.

### API Schema
- The full s&box type schema can be downloaded as JSON from `sbox.game/api`
- It contains all types, methods, properties, and fields
- Use this as the source of truth, NOT reverse engineering from the tools addon
- Key types verified from schema: `MathX.Clamp`, `SceneEditorSession`, `NetworkHelper`, `Package.FetchAsync`, `AssetSystem.InstallAsync`, `UndoSystem.Undo/Redo`

---

## Project Structure

```
sbox-claude/
├── CLAUDE.md                          ← YOU ARE HERE
├── README.md                          ← User-facing docs
├── INSTALL.md                         ← Installation guide
├── LICENSE                            ← MIT
├── install.ps1 / install.sh           ← Legacy installers (need updating)
│
├── sbox-mcp-server/                   # MCP Server (TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                   # Entry point — registers all the tools
│   │   ├── transport/
│   │   │   └── bridge-client.ts       # File-based IPC client
│   │   └── tools/
│   │       ├── project.ts             # get_project_info, list_project_files, read_file, write_file
│   │       ├── scripts.ts             # create_script, edit_script, delete_script, trigger_hotload
│   │       ├── scenes.ts              # list_scenes, load_scene, save_scene, create_scene
│   │       ├── gameobjects.ts         # CRUD, hierarchy, selection
│   │       ├── components.ts          # get/set properties, list components, add/remove components
│   │       ├── assets.ts              # search, list, install, info
│   │       ├── materials.ts           # assign_model, create_material, assign_material, set_material_property
│   │       ├── audio.ts               # list_sounds, create_sound_event, assign_sound, play_sound_preview
│   │       ├── playmode.ts            # play/stop, is_playing, runtime properties, screenshot, undo/redo
│   │       ├── prefabs.ts             # create/instantiate/list/info
│   │       ├── physics.ts             # add_physics, add_collider, add_joint, raycast, physics_overlap
│   │       ├── ui.ts                  # create_razor_ui, screen/world panels
│   │       ├── templates.ts           # player/npc/game_manager/trigger templates
│   │       ├── networking.ts          # network helpers, spawn, sync, RPC, templates
│   │       ├── publishing.ts          # project config, validate, thumbnail, package details
│   │       ├── world.ts               # invoke_button, terrain/cave/forest editing, sculpt, place_along_path
│   │       ├── discovery.ts           # describe_type, search_types, get_method_signature, find_in_project
│   │       ├── visuals.ts             # lights, fog, post-fx, skybox, envmaps, spawn_vpcf, bake_reflections
│   │       ├── characters.ts          # spawn/dress/pose citizens, equip, look_at, ragdoll, expression
│   │       ├── leveltools.ts          # snap_to_ground, align/distribute, grid_duplicate, scatter, group
│   │       ├── objecttools.ts         # find_objects, set_tint, replace_model, set/get_tags, remove_component
│   │       ├── navigation.ts          # bake_navmesh, get_navmesh_path
│   │       ├── diagnostics.ts         # read_log, get_compile_errors, screenshot_from, frame_camera, console_run, execute_csharp
│   │       ├── docs.ts                # search_docs, get_doc_page, list_doc_categories (MCP-server-side)
│   │       └── status.ts              # get_bridge_status
│   └── dist/                          # Compiled JS
│
└── sbox-bridge-addon/                 # Legacy location (DO NOT USE)
    └── ...                            # Old WebSocket-based addon (non-functional)

# ACTUAL working addon location (per-project):
<s&box project>/Libraries/claudebridge/
├── claudebridge.sbproj               # Auto-generated by s&box
├── Editor/
│   ├── claudebridge.editor.csproj    # Auto-generated by s&box
│   └── MyEditorMenu.cs               # ALL bridge code — server + handlers
├── Code/
│   └── claudebridge.csproj           # Auto-generated
└── UnitTests/
    └── claudebridge.unittest.csproj  # Auto-generated
```

---

## How to Install (Current Working Method)

### Prerequisites
- s&box installed via Steam
- Node.js 18+ installed
- Claude Code installed

### Step 1: Create the Library in s&box
1. Open s&box with your project
2. Go to Library Manager
3. Create a new library called "claudebridge"
4. s&box will scaffold the folder structure

### Step 2: Copy the Bridge Code
Copy `MyEditorMenu.cs` into the `Editor/` folder of the library.

### Step 3: Build the MCP Server
```bash
cd sbox-mcp-server
npm install
npm run build
```

### Step 4: Register with Claude Code
```bash
claude mcp add sbox -- node /path/to/sbox-mcp-server/dist/index.js
```

### Step 5: Restart s&box
- Open the "Claude Bridge" dock from View menu
- Check status: Editor → Claude Bridge → Status

---

## Verified s&box APIs (from schema + testing)

### Scene Access
```csharp
var scene = SceneEditorSession.Active?.Scene;  // Editor scene
var scene = Game.ActiveScene;                   // Play mode scene
```

### GameObject
```csharp
var go = scene.CreateObject(true);
go.Name = "My Object";
go.WorldPosition = new Vector3(x, y, z);
go.WorldRotation = Rotation.From(pitch, yaw, roll);
go.WorldScale = new Vector3(sx, sy, sz);
go.SetParent(parent, keepWorldPosition: true);
go.Enabled = false;
go.Destroy();
var clone = go.Clone();
scene.Directory.FindByGuid(guid);
scene.Directory.FindByName("name");
```

### Components
```csharp
go.AddComponent<ModelRenderer>();
go.GetComponent<ModelRenderer>();
go.GetOrAddComponent<ModelRenderer>();
go.Components.GetAll();
go.Components.Create(typeDescription);  // Dynamic type
```

### Models & Materials
```csharp
var renderer = go.GetOrAddComponent<ModelRenderer>();
renderer.Model = Model.Load("models/dev/box.vmdl");
renderer.MaterialOverride = Material.Load("path.vmat");
renderer.Tint = Color.Red;
```

### Physics
```csharp
go.AddComponent<Rigidbody>();       // Has: Gravity, MassOverride, LinearDamping, etc.
go.AddComponent<BoxCollider>();      // Has: Scale, Center, IsTrigger
go.AddComponent<SphereCollider>();   // Has: Radius, Center, IsTrigger
go.AddComponent<CapsuleCollider>(); // Has: Radius, Start, End, IsTrigger
go.AddComponent<HullCollider>();     // (NOT MeshCollider — doesn't exist)
```

### Play Mode
```csharp
Game.IsPlaying   // bool
Game.IsPaused    // bool
SceneEditorSession.Active.SetPlaying(scene);
SceneEditorSession.Active.StopPlaying();
```

### Editor Selection
```csharp
SceneEditorSession.Active.Selection.Set(go);
SceneEditorSession.Active.Selection.Add(go);
SceneEditorSession.Active.Selection.Clear();
SceneEditorSession.Active.FrameTo(go.GetBounds());  // Focus camera
```

### TypeLibrary
```csharp
Game.TypeLibrary.GetType("ModelRenderer");          // TypeDescription
Game.TypeLibrary.GetTypes<Component>();              // All component types
// TypeDescription: .Name, .Title, .Description, .Properties, .IsAbstract, .FullName
```

### Project
```csharp
Project.Current.GetRootPath();
Project.Current.GetAssetsPath();
Project.Current.Config.Title / .Org / .Ident / .Type
```

---

## Known Issues / TODO

- [x] ~~Parameter name alignment~~ — Fixed, handlers use correct MCP param names
- [x] ~~get_scene_hierarchy empty~~ — Fixed, removed erroneous Parent==null filter
- [x] ~~Old WebSocket code~~ — Removed, ws dependency dropped
- [x] ~~`start_play` triggers but `is_playing` returns false~~ — Fixed via `EditorScene.Play` + manual `PlayState` tracking
- [x] ~~Handler `{ error }` masked as `success=true`~~ — Fixed in v1.5.0; dispatch now reports `success=false` on handler-level errors
- [x] ~~`get_compile_errors` not implementable~~ — Implemented in v1.5.0 **MCP-server-side** (reads `sbox-dev.log` directly, no editor API needed); same for `read_log`
- [ ] `add_sync_property` only annotates an existing property with `[Sync]`; `add_rpc_method` generates an empty stub (schemas now reflect this honestly as of v1.5.0)
- [ ] `set_material_property` requires MaterialOverride to be set first
- [x] ~~`create_material` dictionary-key bug~~ — Fixed; reads `path` (or legacy `name`) and writes a KV1 `.vmat`.
- [ ] **Runtime `ParticleEffect` tools** (`spawn_particle` etc.) do not render through the bridge — use `spawn_vpcf`. No flame `.vpcf` ships in a bridge-loadable form yet (under investigation).
- [ ] `is_playing.sessionPlaying` can read stale after a restart — trust `gameFlag`.
- [ ] `take_screenshot` is fixed to the Main Camera — use `screenshot_from` to aim at a target.
- [ ] Bridge addon is project-specific (lives in each project's `Libraries/`) — also published to the s&box Asset Library.
- [ ] Tools with no s&box editor API and therefore not implemented: `pause_play`, `resume_play`, `get_console_output`, `clear_console`, `build_project`, `get_build_status`, `clean_build`, `export_project`, `prepare_publish` (removed from the MCP surface in v1.3.0).
- [ ] Map-edit tools assume the project has `MapBuilder`/`CaveBuilder`/`ForestGenerator`-shaped components. `invoke_button` works on any project; the named convenience tools require those components or compatible ones.

---

## Development

```bash
# Build MCP Server
cd sbox-mcp-server && npm install && npm run build

# The Bridge Addon is compiled automatically by s&box
# Just edit MyEditorMenu.cs and restart s&box

# Test IPC manually:
echo '{"id":"test","command":"get_project_info","params":{}}' > %TEMP%/sbox-bridge-ipc/req_test.json
# Check response:
cat %TEMP%/sbox-bridge-ipc/res_test.json
```

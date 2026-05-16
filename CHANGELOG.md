# Changelog

All notable changes to the s&box Claude Bridge.

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

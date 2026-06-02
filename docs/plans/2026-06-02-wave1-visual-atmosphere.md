# Wave 1 — Visual & Atmosphere Tools — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (inline) or subagent-driven-development to implement task-by-task. Steps use `- [ ]` for tracking.
>
> **Validation note:** The bridge addon is **editor C#** — it cannot be unit-tested outside s&box. The test harness for each tool is the **screenshot loop**: build → sync to the active addon → hotload → invoke the tool in the live editor → `take_screenshot` → read the PNG → confirm the visual result. (Mirrors how v1.3.2's C# was validated; only the Node/TS layer is unit-testable, and these tools are thin Zod schemas not worth unit-testing.)

**Goal:** Add a "Batch 17 — Visual & Atmosphere" set of bridge tools so Claude can author lighting, post-processing, fog, sky, and reflection-probes in s&box (plus two compose-it-all presets), instead of hand-driving `add_component_with_properties` with guessed property names.

**Architecture:** Same pattern as the existing 100 tools — C# `IBridgeHandler` classes registered in `MyEditorMenu.cs` `RegisterHandlers()` (new Batch 17 block), a TS Zod tool module `src/tools/visuals.ts`, and a `registerVisualTools(server, bridge)` call wired into `index.ts`. Handlers reuse the existing scene-access (`SceneEditorSession.Active.Scene`), component-create, and property-set helpers already in the addon (DRY — same machinery `add_component_with_properties` uses). All tools are scene-mutating → add their command names to `_sceneMutatingCommands` so the play-mode guard covers them.

**Tech Stack:** C# (s&box editor addon, .NET), TypeScript + Zod (`@modelcontextprotocol/sdk`), file-IPC bridge.

---

## Verified API reference (from live `describe_type`, 2026-06-02 — source of truth)

**Lights** (all derive `Light`; **no `Brightness` field — intensity = `LightColor` magnitude**, so `brightness` param does `LightColor = color * brightness`):
- `Light` (shared): `LightColor: Color`, `Shadows: bool`, `ShadowBias: float`, `ShadowHardness: float`, `FogMode: FogInfluence`, `FogStrength: float`
- `DirectionalLight`: + `SkyColor: Color`, `ShadowCascadeCount: int`, `ShadowCascadeSplitRatio: float`  (no range — infinite; aim via WorldRotation)
- `PointLight`: + `Radius: float` (range), `Attenuation: float`
- `SpotLight`: + `Radius: float`, `ConeInner: float` (deg), `ConeOuter: float` (deg), `Attenuation: float`, `Cookie: Texture`
- `AmbientLight`: **VERIFY props before coding** (`describe_type AmbientLight` — expected a single `Color`)

**Post-process** (components added to the **camera's GameObject**; set `CameraComponent.EnablePostProcessing = true`):
- `CameraComponent`: `IsMainCamera: bool`, `EnablePostProcessing: bool`, `PostProcessAnchor: GameObject`, `FieldOfView`, `BackgroundColor`, `ZNear/ZFar`
- `Bloom` (template, derives `BasePostProcess<>`): `Mode: BloomMode`, `Strength: float`, `Threshold: float`, `Gamma: float`, `Tint: Color`, `Filter: FilterMode`
- `Tonemapping`, `ColorAdjustments`, `ColorGrading`, `DepthOfField`, `Vignette`, `FilmGrain`, `AmbientOcclusion`, `ChromaticAberration`, `MotionBlur`, `Sharpen`: **VERIFY each one's props with `describe_type` at implementation** — same add-to-camera pattern, only the prop set differs.

**Fog / sky / reflections:**
- `GradientFog`: `Color: Color`, `Height: float`, `VerticalFalloffExponent: float`, `StartDistance: float`, `EndDistance: float`, `FalloffExponent: float`
- `CubemapFog`, `VolumetricFogVolume`: **VERIFY props before coding**
- `SkyBox2D`: **VERIFY** (expected `SkyMaterial: Material` + tint)
- `EnvmapProbe`: **VERIFY** (expected bounds + `UpdateStrategy`/`Projection`)

**Component create / prop-set:** reuse the addon's existing helper used by `add_component_with_properties` (`Game.TypeLibrary.GetType(name)` → `go.Components.Create(typeDesc)` → set props via the existing JSON→property coercion). Do NOT hand-roll a second coercion path.

---

## File structure

- **Modify** `sbox-bridge-addon/Editor/MyEditorMenu.cs`
  - New Batch 17 registrations in `RegisterHandlers()`
  - New handler classes: `AddLightHandler`, `AddPostProcessHandler`, `SetFogHandler`, `SetSkyboxHandler`, `AddEnvmapProbeHandler`, `ApplyAtmosphereHandler`, `ApplyPostFxLookHandler`
  - Add the 7 command names to `_sceneMutatingCommands`
  - Shared private helpers: `FindMainCamera(scene)`, `ApplyLightIntensity(light, color, brightness)`
- **Create** `sbox-mcp-server/src/tools/visuals.ts` — Zod schemas + `registerVisualTools(server, bridge)`
- **Modify** `sbox-mcp-server/src/index.ts` — import + call `registerVisualTools(server, bridge)`
- **Modify** `CLAUDE.md` / `README` tool list + `--help` in `index.ts` — bump tool count, list Batch 17
- **Modify** `CHANGELOG.md` — v1.4.0 entry (new tools = minor bump)

---

## Tasks

### Task 0: Verify the not-yet-confirmed component APIs
- [ ] `describe_type` each of: `AmbientLight`, `SkyBox2D`, `EnvmapProbe`, `CubemapFog`, `VolumetricFogVolume`, and every post-fx effect to be supported (`Tonemapping`, `ColorAdjustments`, `DepthOfField`, `Vignette`, `FilmGrain`, `AmbientOcclusion`, `ChromaticAberration`). Record each writable prop + type into the API reference above. **No handler code for a component until its props are recorded here.**

### Task 1: `add_light`
- **Tool params:** `type` ("directional"|"point"|"spot"|"ambient"), `name?`, `color?` ({r,g,b} 0-1, default white), `brightness?` (float, default 1), `range?` (point/spot, → `Radius`), `coneInner?`/`coneOuter?` (spot), `shadows?` (bool, default true), `position?`/`rotation?`, `parentId?`.
- [ ] C#: `AddLightHandler` — resolve scene, create a GameObject (reuse existing create path), add the typed light component, `light.LightColor = color * brightness`, set type-specific props, set transform. Return `SerializeGo(go)`.
- [ ] TS: Zod schema in `visuals.ts`.
- [ ] **Verify (screenshot):** invoke `add_light{type:"point", position:..., color:{r:1,g:0.6,b:0.2}, brightness:8}` near the campsite → `take_screenshot` → confirm an orange point light is lighting the scene.

### Task 2: `set_fog`
- **Tool params:** `type` ("gradient"|"cubemap"|"volumetric"), `color?`, `startDistance?`, `endDistance?`, `height?`, `falloff?`, `targetId?` (GameObject to host it; default a new "Fog" GO).
- [ ] C#: `SetFogHandler` — add the chosen fog component to the target GO, map params to the verified props (gradient props confirmed; cubemap/volumetric from Task 0).
- [ ] TS schema.
- [ ] **Verify (screenshot):** `set_fog{type:"gradient", color:{r:.5,g:.55,b:.6}, startDistance:200, endDistance:4000}` → screenshot → confirm distance haze.

### Task 3: `add_post_process`
- **Tool params:** `effect` (enum of the verified effects), per-effect optional params (`strength`, `threshold`, `tint`, etc.), `cameraId?` (default: main camera).
- [ ] C#: `AddPostProcessHandler` — `FindMainCamera(scene)` (first `CameraComponent`, prefer `IsMainCamera`), set `cam.EnablePostProcessing = true`, add the effect component to the camera's GameObject, set props (Bloom confirmed as template; others from Task 0). Error clearly if no camera found.
- [ ] TS schema.
- [ ] **Verify (screenshot):** `add_post_process{effect:"bloom", strength:0.6}` then `{effect:"vignette"}` → screenshot → confirm glow + edge darkening.

### Task 4: `set_skybox` + Task 5: `add_envmap_probe`
- [ ] C#: `SetSkyboxHandler` (add/configure `SkyBox2D` on a sky GO; props from Task 0), `AddEnvmapProbeHandler` (add `EnvmapProbe`, set bounds; props from Task 0).
- [ ] TS schemas.
- [ ] **Verify (screenshot):** set a dark skybox tint; confirm in screenshot.

### Task 6: Presets `apply_atmosphere` + `apply_post_fx_look`
- **`apply_atmosphere`** params: `mood` ("horror-night"|"foggy-dawn"|"warm-interior"|"overcast"). Composes existing handlers: e.g. `horror-night` = dim blue `DirectionalLight` (low brightness) + `AmbientLight` near-black + `GradientFog` cold/short + `add_post_process` tonemap + vignette + slight desaturate via `ColorAdjustments`.
- **`apply_post_fx_look`** params: `look` ("cinematic"|"filmic-horror"|"clean"). Composes post-fx defaults.
- [ ] C#: `ApplyAtmosphereHandler` / `ApplyPostFxLookHandler` call the same internal routines the primitives use (extract primitive bodies into reusable `static` methods so presets and primitives share one code path — DRY).
- [ ] TS schemas.
- [ ] **Verify (screenshot):** `apply_atmosphere{mood:"horror-night"}` on the Black Pines map → screenshot → confirm the whole scene reads as dread/night in one call.

### Task 7: Register, document, ship
- [ ] Add all 7 command names to `_sceneMutatingCommands`.
- [ ] Register all 7 in `RegisterHandlers()` (Batch 17 block).
- [ ] `registerVisualTools(server, bridge)` imported + called in `index.ts`.
- [ ] Update `--help` tool listing + `CLAUDE.md`/README counts (100 → 107).
- [ ] `CHANGELOG.md`: **v1.4.0** entry ("Batch 17 — Visual & Atmosphere: lighting, post-processing, fog, sky, envmap + atmosphere/post-fx presets").
- [ ] Build MCP server (`npm --prefix sbox-mcp-server run build`), sync `MyEditorMenu.cs` to the active addon (`Libraries/sboxskinsgg.claudebridge/Editor/`), hotload, and run the full screenshot pass over Tasks 1-6 in the live Sasquatched scene.

---

## Out of scope for Wave 1 (deferred)
`PostProcessVolume` region-based effects; baked GI / `IndirectLightVolume`; lightmap-bake triggers; light *flicker* animation; `ColorGrading` LUT files. Revisit as a "Wave 1.5".

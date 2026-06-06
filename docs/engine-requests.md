# s&box Engine / SDK Limitations — Feature & Bug Requests

**Date:** 2026-06-06
**Source project:** the Claude Bridge (`sbox-mcp-server` + the in-editor `claudebridge` addon) — an editor-side automation tool that drives the s&box editor through a sandboxed C# addon plus an external Node process.

This document lists capabilities that are **blocked by s&box itself** — the engine/SDK provides no API, the sandbox forbids it, or a public API has a confirmed rendering/lifecycle bug. Items the bridge simply hasn't implemented (and could fix on its own) are **excluded** (see the last section).

Each item is self-contained so it can be filed individually. Citations point at the bridge repo where the limitation was confirmed.

**Priority key:** 🔴 High = strong, well-isolated ask. 🟡 Medium = real gap, reasonable ask. ⚪ Verify-first = needs isolation or is mostly a docs request.

---

## 🔴 High priority

### 1. Expose the `.vpcf` particle compiler through `Editor.AssetSystem`
- **What's blocked:** An addon can write a valid `.vpcf` source file but cannot compile it to `.vpcf_c`. The same pipeline that compiles materials — `Editor.AssetSystem.RegisterFile(path).Compile()` / `CompileResource()` — succeeds for `.vmat` but returns **`Failed to find compiler for `.vpcf``** for particles.
- **Why it's engine-level:** The addon invokes the documented `AssetSystem.Compile` path correctly; only the particle compiler is not registered/reachable in the editor assembly the addon runs in. There is no other API to reach it. The compiler exists (the interactive particle editor uses it) but isn't exposed through `AssetSystem`.
- **Evidence:** `CHANGELOG.md [1.5.2]`; `MyEditorMenu.cs` `RecompileAssetHandler`.
- **Requested fix:** Register the particle `ResourceCompiler` in the editor assembly so `AssetSystem.RegisterFile("x.vpcf").Compile()` / `CompileResource("particles/x.vpcf", text)` succeeds, the way it already does for `.vmat`.
- **Use case:** Tools/agents author a `.vpcf` as text and need the compiled `.vpcf_c` without opening the interactive particle editor.

### 2. A sanctioned local IPC channel for editor addons (the sandbox blocks `System.Net`)
- **What's blocked:** The C# sandbox excludes `System.Net` (`HttpListener`, `WebSocket`, `TcpListener`), so an editor addon cannot open any socket. The entire bridge transport had to fall back to polling JSON files in a shared temp directory — which is the root cause of temp-dir hangs, a one-request-per-editor-frame throughput cap, and the "dock must be visible" requirement.
- **Why it's engine-level:** The sandbox whitelist is a hard policy decision only Facepunch controls; there is no in-sandbox substitute for a socket or local IPC channel.
- **Evidence:** `CLAUDE.md` (Architecture), `README.md`, `bridge-client.ts`.
- **Requested fix:** Provide a sanctioned local IPC mechanism for editor addons — a whitelisted **localhost-only socket / named pipe**, or a first-class editor **"external tool channel"** — so an addon can talk to a local helper process without polling temp files.
- **Use case:** Bridging the editor to external automation / MCP / tooling processes.

### 3. An always-on editor tick, independent of widget visibility and window focus
- **What's blocked:** `[EditorEvent.Frame]` only fires while a `[Dock]` widget is visible **and** the window is focused; when the panel is closed or s&box loses focus (Windows throttles frame events), the addon's work queue and heartbeat stop entirely.
- **Why it's engine-level:** There is no engine-provided always-on editor tick; the SDK only surfaces `[EditorEvent.Frame]`, which the engine gates on visibility/focus.
- **Evidence:** `CLAUDE.md` (Known Issues), `TROUBLESHOOTING.md`.
- **Requested fix:** Provide an editor periodic callback (e.g. `[EditorEvent.Tick]` or a registerable timer driven by the editor main loop) that fires regardless of whether any widget is visible and even when the window is unfocused/minimized.
- **Use case:** A background tooling addon that must drain a work queue and emit a heartbeat without a visible panel or foreground focus.

### 4. Whitelist `System.Math`/`System.MathF` in the sandbox (or complete `MathX`)
- **What's blocked:** Sandboxed game code cannot call `MathF.Sin`, `Math.Abs`, etc., and the always-available helper `MathX` omits `Abs`, `Min`, `Max`, `Sin`, `Cos`, `Tan`, `Atan2`, `Sqrt`, `Pow`, and `PI`/`Tau`. Routine math must be hand-rolled.
- **Why it's engine-level:** Sandbox whitelist + first-party API surface — only Facepunch can add `System.MathF` to the whitelist or extend `MathX`.
- **Evidence:** `CLAUDE.md` (Math & Events), `sbox-build-feature/SKILL.md`, `ScaffoldHandlers.cs`.
- **Requested fix:** Whitelist `System.Math`/`System.MathF`, or extend `MathX` to cover the common functions above.
- **Use case:** Any gameplay math — oscillation, distances, angles — in sandboxed components.

### 5. Runtime / data-driven cloud loading (`Cloud.Model` is literal-only)
- **What's blocked:** `Cloud.Model`/`Cloud.Texture`/`Cloud.Sound` are backed by a source generator that only matches **string-literal** arguments, so a cloud asset cannot be loaded from a runtime/variable ident.
- **Why it's engine-level:** The source-generator constraint is entirely an SDK decision; there is no runtime overload.
- **Evidence:** `sbox-build-feature/SKILL.md`.
- **Requested fix:** Add a runtime API (e.g. `Cloud.Load(string ident)` that resolves at runtime), or document the intended data-driven path.
- **Use case:** Loading a cloud asset whose ident is chosen at runtime or read from config.

### 6. Fix `MeshComponent` per-face material + `Color` tint on a code-built `PolygonMesh` (rendering bug)
- **What's blocked:** On a procedurally built `PolygonMesh`, `MeshComponent.SetFaceMaterial(face, material)` and the `MeshComponent.Color` tint have **no visible effect** — the geometry renders but ignores per-face material and tint.
- **Why it's engine-level:** These are public APIs called correctly that silently do nothing visually. There is no alternate API to color a procedural mesh.
- **Evidence:** `TROUBLESHOOTING.md` (Known limitation), `CHANGELOG.md [1.2.0]`.
- **Requested fix:** Make per-face materials and the `Color` tint actually render for a code-built `PolygonMesh`.
- **Use case:** Programmatic mesh generation that needs more than a single default material.

### 7. Editor-viewport / arbitrary-camera "render to image" API
- **What's blocked:** Screenshots can only be rendered from the scene's **Main Camera**; moving the editor viewport (`frame_camera`) has no effect on the captured image. The only workaround is temporarily relocating the Main Camera and restoring it.
- **Why it's engine-level:** There is no editor API to render the active viewport (or an arbitrary camera/transform) to an image.
- **Evidence:** `CLAUDE.md` (Visual Verification), `TROUBLESHOOTING.md`, `sbox-build-feature/SKILL.md`.
- **Requested fix:** Add an editor API to capture the active viewport, or render an arbitrary camera/transform to an image, without mutating the scene's Main Camera.
- **Use case:** Visual verification of an edit from any chosen viewpoint.

---

## 🟡 Medium priority

### 8. Runtime `ParticleEffect` component renders nothing in an editor-driven scene
A code-configured `ParticleEffect` emitter graph produces at most a single static sprite (nothing in play mode); only a pre-compiled `.vpcf` via `LegacyParticleSystem` renders. **Ask:** clarify the minimal required setup, or fix the component so a code-configured emitter renders in edit and play views. *(`MyEditorMenu.cs`, `CHANGELOG.md [1.5.0]`, `TROUBLESHOOTING.md`.)*

### 9. No always-resolvable built-in `.vpcf`; `ParticleSystem.Load` returns null for cloud-cached particles
`ParticleSystem.Load("particles/impact.generic")` returns null for the cloud-cached asset, so out of the box there is no particle the bridge can spawn. **Ask:** ship at least one always-resolvable built-in `.vpcf` (generic spark/impact + a flame) loadable by a stable logical path, and make cloud-cached particle assets resolve via `ParticleSystem.Load` rather than returning null. *(`MyEditorMenu.cs`, `CHANGELOG.md [1.5.0]`.)*

### 10. Cloud assets are not persisted across project restarts
Anything referenced purely via `Cloud.Model/Texture/Sound` is gone after a restart, so cloud assets can't back durable scene content. **Ask:** a way to pin/cache a cloud asset locally so a `Cloud.X` reference stays valid across restarts (or a one-call "materialize cloud asset into the project" API). *(`sbox-build-feature/SKILL.md`, `README.md`.)*

### 11. No `.mp3` audio import
The importer accepts `.wav` etc. but not `.mp3`. **Ask:** add `.mp3` import support, or document the canonical in-editor conversion path. *(`sbox-build-feature/SKILL.md`.)*

### 12. No concave `MeshCollider` component (only `HullCollider`)
There is no triangle-mesh/concave collider, so procedural concave geometry can't have accurate collision. **Ask:** add a triangle-mesh / `PolygonMesh`-backed collider component. *(`CLAUDE.md`, `sbox-build-feature/SKILL.md`.)* **Use case:** caves, terrain, authored concave `PolygonMesh` geometry.

### 13. Light components expose no `Intensity`/`Brightness` field
Brightness must be encoded as the HDR magnitude of `LightColor` (channels >1), conflating color and intensity. **Ask:** add an explicit `Intensity`/`Brightness` float decoupled from color. *(`sbox-build-feature/SKILL.md`, `CHANGELOG.md [1.4.0]`.)*

### 14. `PlayerController.AnimationHelper` removed — throws `MissingMethodException` at runtime (regression)
Access to the previously-present property now throws at runtime (not a compile error or graceful null). **Ask:** if removal is intended, document the migration (how to obtain the `CitizenAnimationHelper` the `PlayerController` drives); if not, restore it. *(`sbox-build-feature/SKILL.md`.)*

### 15. Razor reactivity: `@if`, root `class="@(...)"`, and `@Prop`-as-element-text don't re-render reliably
These idiomatic bindings are correct on first render but don't update when state changes, forcing imperative `@ref`/`OnUpdate` workarounds. **Ask:** fix reactivity for these binding forms. *(`sbox-build-feature/SKILL.md`.)* **Use case:** declarative HUDs whose visibility/class/text depend on game state.

### 16. No sandbox-safe API to capture editor console / log output from an addon
`LogCapture` isn't available in-sandbox, so tooling must scrape `sbox-dev.log` from disk out-of-process (which is exactly what the bridge does). **Ask:** expose an in-editor log/console subscription API (event delivering log lines + severity, or a "fetch recent compile errors" method) usable from a sandboxed addon. *(`MyEditorMenu.cs`, `CLAUDE.md`.)*

### 17. No editor API to pause/resume play mode
Only `SetPlaying`/`StopPlaying` are exposed; `Game.IsPaused` is readable but not settable from tooling. **Ask:** expose pause/resume of play mode to editor addons. *(`MyEditorMenu.cs`, `README.md`.)*

### 18. No main-thread dispatch primitive for scene APIs
Scene APIs are main-editor-thread-only and the SDK provides no main-thread dispatch, so addons must hand-roll a frame-loop queue. **Ask:** add a sanctioned "run on the editor main thread" API (e.g. `Editor.Dispatcher.Invoke(Action)` or a `Task` that completes on the main thread). *(`CLAUDE.md`.)* **Use case:** an addon receiving work on a background timer/IO thread that needs to mutate the scene safely.

### 19. Mutating the scene during play mode can desync the serializer and corrupt `.scene` files (robustness bug)
Editing the scene while `Game.IsPlaying` is true can corrupt the saved `.scene` (the bridge hard-refuses such edits because it actually happened). **Ask:** make play-mode edits safe (separate play/edit scene state on save) or provide a supported API for edits that survive the play/stop transition. *(`TROUBLESHOOTING.md`, `CHANGELOG.md [1.2.0]`.)*

---

## ⚪ Verify-first / lower priority
- **`MeshComponent.Mesh` is null on a freshly added component** — renders nothing until code assigns `new PolygonMesh()`. Minor DX nit: consider auto-initializing an empty mesh on add. *(`CHANGELOG.md [1.1.0]`.)*
- **Razor `.razor` `PanelComponent` classes generate into the global namespace by default** — surprises namespaced references unless `@namespace` is added. Consider defaulting to the project/folder namespace. *(`sbox-build-feature/SKILL.md`.)*
- **`set_property` on a `Vector3` silently no-ops** (reports success, reads back default). **Isolate first** — may be a TypeLibrary serializer coercion bug *or* bridge value-marshalling for `Vector3`; verify the value is passed in the SDK's expected shape before filing. *(`sbox-build-feature/SKILL.md`.)*
- **`SkinnedModelRenderer.Sequence` is overridden by the AnimationGraph on Citizen-type models** — directly-set sequences are clobbered each frame; `set_animgraph_param` is the only path. Mostly a documentation/DX ask, or a supported "play one-shot over the graph" API. *(`sbox-build-feature/SKILL.md`.)*

---

## Out of scope — bridge-side gaps (NOT filed with Facepunch)
The following surfaced during the audit but are the bridge's own to fix (the engine isn't blocking them), so they're intentionally excluded from any Facepunch submission: `create_material` dictionary-key bug; `set_property` Color/reference-type coercion; the TEMP-vs-TMP IPC temp-dir mismatch; one-request-per-frame throughput; runtime-spawned GameObject GUID addressing; `set_fog` gradient-only; `invoke_button` parameterless-only; `execute_csharp` roughness; stale `.csproj`/Node prerequisites; and various correct-usage gotchas (case-sensitive bones, `[Property]` overwrite, sound path format, etc.).

*Derived from a 114-candidate audit of the bridge repo (CHANGELOG, TROUBLESHOOTING, skill docs, and source), adversarially classified engine-limitation vs bridge-gap.*

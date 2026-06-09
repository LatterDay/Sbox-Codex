# Worldgen & Rendering

Procedural, editable, and destructible worlds in s&box: SDF terrain, deadlock-proof spawn placement, and runtime mesh generation — all host-authoritative.

## Mental model

Three jobs live under "worldgen", and one rule governs all of them.

- **Editable/destructible terrain** — carve holes and add material with `facepunch.libsdf` (a 2D signed-distance-field world). Few devs know this library exists; it is the canonical Worms/Terraria-style digging system.
- **Procedural placement** — pick valid spots for spawns/loot/props on irregular or destructible geometry via a trace → validate → relaxed-retry loop, never naive `Random`.
- **Runtime geometry** — build meshes on the fly with `VertexMeshBuilder` for platforms, bridges, force-fields.

**The rule: terrain and synced geometry are host-authoritative.** A client-side SDF edit or spawn desyncs every peer because the result silently rolls back on a proxy. Every mutator is gated `[Rpc.Host]` + a host assert, or `if (!Networking.IsHost) return;`. SDF edits are also **async** — you cannot read terrain state in the frame you edited it.

Because the SDF and mesh APIs drift between SDK builds, treat reflection (`describe_type Sdf2DWorld`, `get_method_signature`) as the source of truth and the snippets below as shape, not gospel.

---

## Pattern 1 — Destructible 2D terrain with facepunch.libsdf

Declare the world as a required property, stand it up vertically for a side-view game, and expose every edit as a host RPC. Build an SDF primitive (`CircleSdf`, `RectSdf`, `LineSdf`, `TextureSdf`), optionally `.Expand(offset)` per material layer so each layer gets its own thickness, then `await` `AddAsync` / `SubtractAsync`.

```csharp
using Sandbox.Sdf;

public partial class GrubsTerrain : Component
{
    [Property] public required Sdf2DWorld SdfWorld { get; set; }

    public async void Init()
    {
        await SdfWorld.ClearAsync();
        await Task.MainThread();
        // Side-view (Worms/Terraria) playfield: stand the flat 2D world up.
        SdfWorld.WorldRotation = Rotation.FromRoll( 90f );
    }

    // Any mutator is a host surface. NetFlags restrict who INVOKES, not security.
    [Rpc.Host]
    public void SubtractCircle( Vector2 center, float radius, Sdf2DLayer material )
    {
        if ( !AssertIsHost() ) return;                 // loud failure, not silent desync
        var sdf = new CircleSdf( center, radius );
        SdfWorld.SubtractAsync( sdf.Expand( 0f ), material );  // async — do not read this frame
    }

    private bool AssertIsHost() => Connection.Local == Connection.Host;
}
```

Verified against `sbox-grubs/Code/Terrain/Terrain.Modifications.cs:28` (`[Rpc.Host] SubtractCircle` → `new CircleSdf(...)` → `.Expand(offset)` → `SubtractAsync`) and `Terrain.cs:46` (`SdfWorld.WorldRotation = Rotation.FromRoll( 90f )`). Primitives `RectSdf`, `LineSdf`, `TextureSdf` and `AddAsync` for adding material all appear in `Terrain.Modifications.cs:75,98,132,181`. `Expand(offset)` per material layer: `Terrain.Modifications.cs:38-39`.

Notes:
- `.Translate(...)` repositions an SDF in world space before applying it (`Terrain.Modifications.cs:180`). Grubs offsets by `-WorldPosition.z` so SDF coords match the rotated world.
- Use one material code per layer (foreground, background, destruction mask, scorch). Grubs maps an `int matCode` → a `MaterialsConfig` so RPC args stay `[Sync]`-friendly value types (`Terrain.Modifications.cs:10-19`) — pass an `int`, not a `Sdf2DLayer` reference, over the wire.

---

## Pattern 2 — Deadlock-proof procedural placement

Naive random placement clips into geometry and stacks units. Instead: sample a point, trace **down**, then reject on a checklist. The trick that prevents deadlock on a crowded/destructible map is **relaxing the minimum-spacing constraint toward 0 as retries climb**, so a packed map never fails to place.

```csharp
public Vector3 FindSpawnLocation( float size = 16f, float maxAngle = 70f )
{
    var avoid = Scene.GetAllComponents<Grub>().Select( g => g.GameObject ).ToList();
    float dist = 128f;
    const int maxRetries = 1000;

    for ( int retries = 1; retries <= maxRetries; retries++ )
    {
        var start = new Vector3( Game.Random.Int( Width ) - Width / 2, 512, Game.Random.Int( 60, Height ) );
        var tr = Scene.Trace.Ray( start, start + Vector3.Down * Height )
            .WithAnyTags( "solid", "player" ).Size( size ).Run();

        if ( !tr.Hit || tr.StartedSolid ) continue;
        var pos = tr.EndPosition;

        if ( tr.GameObject.Components.TryGet( out Grub _, FindMode.EverythingInSelfAndAncestors ) ) continue; // inside a unit
        if ( PointInside( pos ) ) continue;                                   // inside terrain
        if ( Vector3.GetAngle( Vector3.Up, tr.Normal ) > maxAngle ) continue; // too steep
        if ( pos.z < 60 ) continue;                                           // too low

        // Relax spacing as we struggle: a busy map degrades gracefully instead of looping forever.
        dist = MathF.Min( dist, 128f - (128f * (retries / (float)maxRetries)) );
        if ( !IsDistanceValid( avoid, pos, dist ) ) continue;

        return pos;
    }
    return Vector3.Zero; // fallback
}

// "Is this point buried?" — trace sideways a short distance into solids.
public bool PointInside( Vector3 p ) =>
    Scene.Trace.Ray( p, p + Vector3.Right * 64f ).WithAnyTags( "solid" ).Size( 2f ).Run().Hit;
```

Verified against `sbox-grubs/Code/Terrain/Terrain.cs:61` (the full loop), `:99` (`Vector3.GetAngle(Vector3.Up, tr.Normal) > maxAngle`), `:107` (the `dist = MathF.Min(...)` relaxation), `:121` (`IsDistanceValid`), and `:215` (the sideways `PointInside` trace). Genre-agnostic — reuse for loot, enemies, scatter props, anything placed on irregular geometry.

---

## Pattern 3 — Runtime procedural mesh + the weld/constraint gotcha

Build geometry with `VertexMeshBuilder`, spawn it as a `Prop`, override its material, place it at the mesh origin, raise its mass so it's walkable, and weld it to a carrier. **Resizing means swapping the `Prop.Model`, which invalidates existing constraints** — you must remove the weld *before* the swap and re-weld *after*.

```csharp
length = MathF.Round( length, 1 );                         // quantize to 0.1
if ( Length.AlmostEqual( length, 0.5f ) ) return;          // skip sub-threshold churn
Length = length;

var handle = VertexMeshBuilder.CreateRectangle( (int)length, 100, 1, 64 );

if ( !bridge.IsValid() )
{
    bridge = VertexMeshBuilder.SpawnEntity( handle );
}
else
{
    // CRITICAL: the weld dies the moment we change the model.
    bridge.GetComponent<PropHelper>().RemoveConstraints( ConstraintType.Weld, GameObject );
    bridge.GetComponent<Prop>().Model = VertexMeshBuilder.Models[handle];   // swap, then re-weld
}

var r = bridge.GetComponent<ModelRenderer>();
r.SetMaterialOverride( Material.Load( "materials/wirebox/katlatze/metal.vmat" ), "" );
r.Tint = new Color( 0, 0.35f, 1, 0.7f );                   // translucent if alpha < 1
// Align to the mesh origin, not the bounds centre.
bridge.WorldPosition = Transform.World.PointToWorld( new Vector3( 4, -50, 9.5f ) - r.Model.PhysicsBounds.Mins );
bridge.WorldRotation = WorldRotation;

var helper = bridge.GetComponent<PropHelper>();
if ( helper.Rigidbody.Mass < 100 )
    helper.Rigidbody.MassOverride = 100;                   // default-mass platforms get shoved around
helper.Weld( GameObject );
```

Verified against `wirebox/Code/wirebox/components/WireLightBridgeComponent.cs:9-45`: `MathF.Round(length,1)` + `AlmostEqual(length,0.5f)` change-threshold guard (`:13-14`), `CreateRectangle` (`:24`), `SpawnEntity`/`Models[handle]` (`:27,33`), the `RemoveConstraints(Weld)`-before-model-swap order (`:31-33`), `PointToWorld(local - Model.PhysicsBounds.Mins)` origin (`:38`), `MassOverride = 100` (`:41-42`), and `Weld` (`:43`). `VertexMeshBuilder` itself is a Wirebox library type — confirm its signature with reflection before use.

---

## Pattern 4 — `[Sync]` day/night cycle with smoothstep twilight + sunrise/sunset events

A driven sun + sky from a single normalized `[Sync] float TimeOfDay` (0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset). **Only the host advances it**; every client calls `Apply()` each frame so visuals stay in lock-step. The day↔night colour/intensity cross-fade is a **cubic smoothstep over a `±TwilightHalfWidth` window** around the sunrise/sunset thresholds — time-driven, so it works identically whether the sun pose is static (pinned to match a baked cubemap sun disk) or rotating (sin-pitch + 360° yaw).

```csharp
[Sync, Property, Range( 0f, 1f )] public float TimeOfDay { get; set; } = 0.5f;   // host owns the clock

protected override void OnUpdate()
{
    var isAuthoritative = !Network.Active || !IsProxy;   // host in MP; anybody solo/editor
    if ( isAuthoritative && AutoProgress && Config.CycleSeconds > 0f )
    {
        var prev = TimeOfDay;
        TimeOfDay += Time.Delta / Config.CycleSeconds;
        if ( TimeOfDay >= 1f ) TimeOfDay -= 1f;
        CheckPhaseCrossing( prev, TimeOfDay );           // fire OnSunrise/OnSunset on threshold cross
    }
    Apply();                                             // EVERY client every frame
}

void Apply()                                            // signed distance to nearest day/night boundary
{
    float dist = /* +inside day window, −inside night */;
    var u = ( ( dist + hw ) / ( 2f * hw ) ).Clamp( 0f, 1f );
    var dayness = u * u * ( 3f - 2f * u );               // cubic smoothstep
    Sun.LightColor = Color.Lerp( dayLit, nightLit, 1f - dayness );   // HDR RGB×intensity (no Brightness prop)
    Sun.SkyColor   = Color.Lerp( Config.DaySkyColor, Config.NightSkyColor, 1f - dayness );
    if ( Sky is not null && desired is not null && Sky.SkyMaterial != desired ) Sky.SkyMaterial = desired; // twilight swap
}
```

Verified against intercrusstudio.sneguborka `Code/World/DayNightManager.cs`: `[Sync] TimeOfDay` host-advance (`:57,:91-99`), the smoothstep `dayness = clamped*clamped*(3 - 2*clamped)` (`:149-151`), HDR colour-multiply for intensity (`:155-165`), optional `SkyMaterial` swap at twilight (`:169-176`), and the `OnSunrise`/`OnSunset` events fired only on an ascending threshold crossing (`:179-199`). **Authority nuance worth copying:** it gates on `!Network.Active || !IsProxy`, NOT a strict `Networking.IsHost` — the stricter check returns false on the first frame before the lobby finishes creating and would freeze the cycle in editor Play. **Subscriber contract:** the events fire host-only and every external `+=` MUST be paired with a `-=` in the subscriber's `OnDestroy`. A 5-state day/night + weather *director* (lighting/post/fog/waves) is the richer variant (stepdev.xtrem_road; thefancylads.restaurant_dev `Code/Common/World/DayNightController.cs:40` for the new-day-event flavour).

---

## Pattern 5 — Self-instanced scatter field (GPU `DrawModelInstanced` + frustum cull + async respawn)

To cover a large area with thousands of props (grass, rocks, trees, gravestones) without a GameObject per blade, render them through a single `SceneCustomObject.RenderOverride` that calls `Graphics.DrawModelInstanced` over a transform list, **frustum-culled** each frame, with **async respawn** of harvested resources. Placement is a min-distance radius scatter (N attempts, reject within `MinDistanceBetweenResources`), ground-aligned by a down-trace, with "clear collider" exclusion zones.

```csharp
SceneCustomObject _instancedRenderer;

protected override void OnStart()
{
    _instancedRenderer = new SceneCustomObject( Scene.SceneWorld ) { RenderOverride = RenderInstanced };
}

void RenderInstanced( SceneObject so )
{
    var frustum = Camera.Main.GetFrustum( ... );
    foreach ( var batch in _batches )                          // one batch per model
    {
        var visible = batch.Transforms.Where( t => frustum.IsInside( t.Position, padding ) );
        Graphics.DrawModelInstanced( batch.Model, visible.ToList() );   // ONE draw call per model
    }
}
```

Verified against bublic.stone_by_stone `Code/RecourcesGeneratorComponent.cs`: `MinDistanceBetweenResources` radius scatter (`:18`), camera-frustum cull toggle + padding (`:31-33`), `new SceneCustomObject(Scene.SceneWorld){ RenderOverride = RenderInstanced }` (`:54-56`), and async `RespawnResourceAsync` with jittered delay + a generation guard so a hotload/teardown cancels in-flight respawns (`:334`, `:346`). The respawn uses a `_spawnGeneration` int bumped on regen so a stale `await` can't resurrect a destroyed field. Engine-repo siblings: vault77.chop_the_forest's chunk-streaming instanced grass with LOD + biomes (`Code/GrassField/GrassFieldStreamer.cs:1224`) and the drop-in `GrassField` with shader-attribute player trample.

---

## Gotcha table

| Gotcha | Why it bites | Fix | Source |
| --- | --- | --- | --- |
| Client-side terrain edit | Synced SDF mutation on a proxy silently rolls back → every peer desyncs | `[Rpc.Host]` + `AssertIsHost()` (or `if (!Networking.IsHost) return;`) on every mutator | grubs `Terrain.Modifications.cs:28,164` |
| `[Rpc.Host]` ≠ secure | NetFlags restrict who *invokes*, not forged args; a client can still call it | Re-validate ownership/limits and rate-limit (cooldown keyed by `Rpc.CallerId`) inside the host body | crossCutting |
| Reading terrain same frame as edit | `AddAsync`/`SubtractAsync` complete later, not synchronously | Treat edits as fire-and-forget; gate dependent reads on `TimeSinceLastModification` or the awaited task | grubs `Terrain.Modifications.cs:181,197` |
| Flat side-view playfield | `Sdf2DWorld` defaults flat (lies in a horizontal plane) | `SdfWorld.WorldRotation = Rotation.FromRoll( 90f )` to stand it up | grubs `Terrain.cs:46` |
| Naive random spawns | Units clip into terrain, stack on each other, or the loop deadlocks on a full map | trace-down → reject-checklist → relax `dist` toward 0 as retries climb | grubs `Terrain.cs:61,107` |
| Model swap detaches welds | Changing `Prop.Model` invalidates existing physics constraints; the welded object silently falls off | `RemoveConstraints(Weld)` **before** the swap, re-`Weld` **after** | wirebox `:31-33` |
| Per-frame mesh rebuild | Regenerating geometry every frame thrashes GPU + physics | Round dims (`MathF.Round(x,0.1f)`) and `AlmostEqual`-skip sub-threshold deltas | wirebox `:13-14` |
| Procedural platform un-walkable | Default-mass runtime mesh gets shoved by the player | Raise `Rigidbody.MassOverride` (~100) | wirebox `:41-42` |
| Mesh placed off-origin | `VertexMeshBuilder` origin ≠ bounds centre | Position via `Transform.World.PointToWorld(local - Model.PhysicsBounds.Mins)` | wirebox `:38` |
| `IsOwner` guard dead solo | No lobby in solo editor playtest → `Network.IsOwner` is false; whole systems silently off | Combine with a `LocalSimulation` property: `ShouldSimulate => LocalSimulation \|\| Network.IsOwner` | crossCutting |
| `async void` in lifecycle | Continuations outlive the GameObject/scene, aren't cancelled on disable/hotload, swallow exceptions | Prefer `TimeUntil`/`TimeSince` + `Destroy`; own a CTS for real loops; `await` background tasks | crossCutting |
| API drift | `Sdf2DWorld` / `VertexMeshBuilder` signatures change between SDK builds; training data is stale | `describe_type` / `get_method_signature` before writing; `try/catch` + safe fallback for volatile calls | crossCutting |
| Day/night frozen on first frame of editor Play | Strict `Networking.IsHost` is false until the lobby finishes creating | Gate on `!Network.Active \|\| !IsProxy` instead; only the host advances, ALL clients `Apply()` | sneguborka `DayNightManager.cs:91` |
| Sun "Brightness" not applied | s&box `DirectionalLight` has no Brightness; intensity is baked into the HDR colour | Multiply `LightColor.rgb * Intensity` into the `Color` before `Lerp` | sneguborka `:155-165` |
| Day/night subscribers leak | `OnSunrise`/`OnSunset` are host-side C# events; a missed `-=` keeps a dead object alive | Pair every `+=` with a `-=` in the subscriber's `OnDestroy` | sneguborka `:35-38` |
| Async respawn resurrects a destroyed field | An in-flight `await` completes after a hotload/regen | Bump a `_spawnGeneration` int on regen; the continuation bails if `generation != _spawnGeneration` | stone_by_stone `:346` |
| Thousands of scatter props tank FPS | One GameObject + ModelRenderer per prop | `SceneCustomObject.RenderOverride` → `Graphics.DrawModelInstanced` per model, frustum-culled | stone_by_stone `:54` |

---

**Verify live:** the SDF and mesh APIs drift between SDK builds — `describe_type Sdf2DWorld` and `search_types Sdf` (plus `get_method_signature` for `AddAsync`/`SubtractAsync`/`VertexMeshBuilder.CreateRectangle`) are authoritative for *your* installed SDK. Reflection over memory, always.

See also: **sbox-api** (resolve exact type/method signatures via bridge reflection) and **sbox-build-feature** (the screenshot-driven loop to validate generated geometry and spawn distribution).

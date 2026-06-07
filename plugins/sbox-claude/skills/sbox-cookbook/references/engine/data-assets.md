# Data Assets & Content Pipelines

Purpose: data-drive game content in modern s&box — `GameResource` catalogs, prefab registries, runtime file discovery, render-to-texture surfaces, and shipping editor authoring tools — without hand-writing C# per variant.

## Mental model

"Assets" in s&box spans four things, each with its own idiom:

1. **Data assets** — a `GameResource` subclass with `[AssetType]` gives every typed variant (a car, a weapon, an enemy) its own editor file, asset picker, and inspector. Designers add content; you write zero C#.
2. **Prefab registries** — designer-referenced `PrefabScene`/`GameObject` prefabs pre-cloned at awake, broken from prefab, indexed by a stable id, and handed out via `Clone`.
3. **Runtime files** — `FileSystem.Mounted` (read-only shipped) vs `FileSystem.Data` (user-writable) for mods, saves, and screenshots.
4. **Custom render objects** — raw `SceneLight`/`SceneCustomObject`/render targets you own and must clean up manually.

Cross-cutting rule: **reflection is the source of truth**. Editor-namespace and render-object APIs drift between SDK builds — confirm with `describe_type`/`search_types` before writing, never from training data.

## Pattern: data-drive content with `GameResource` + `[AssetType]`

Make every catalog of typed variants a `GameResource`. Each variant becomes a `.vcfg` file the designer edits in the inspector; reference other assets by typed path (`[ResourceType("vmdl")]`, `[ResourceType("sound")]`); add free-form `Tags` for gamemode filtering. Adding a new car = a new `.vcfg` + model, no code (sbox-vehicle-kit: VehicleConfig.cs:11-92).

```csharp
[AssetType( Name = "Vehicle Config", Extension = "vcfg", Category = "Vehicles" )]
[Icon( "directions_car" )]
public sealed class VehicleConfig : GameResource
{
    [Property] public string DisplayName { get; set; } = "Sedan";
    [Property, ResourceType( "vmdl" )]   public string ModelPath  { get; set; }
    [Property, ResourceType( "prefab" )] public string PrefabPath { get; set; }

    [Group( "Performance" ), Property, Range( 20, 400 )]
    public float MaxSpeedKmh { get; set; } = 140;

    [Group( "Cosmetics" ), Property]
    public List<string> Tags { get; set; } = new();   // "police", "starter", ...
}
```

`[Group(...)]`, `[Range(...)]`, `[Icon(...)]`, and `Curve` properties turn the inspector into the authoring tool (sbox-vehicle-kit: VehicleConfig.cs:21-42). For pure serializable data with no behavior, a thin `IAsset` interface (`Path => ResourcePath`) over a `GameResource` base is enough (SBox-Visual-Novel-Base: Asset.cs:21-25).

## Pattern: discover assets at runtime — and FILTER the suffix collision

Expose static accessors over `ResourceLibrary.GetAll<T>()`. **Critical gotcha:** the resource system suffix-matches extensions, so a `.vcfg` type silently picks up engine `core/cfg/*.cfg` files (e.g. `configschema.cfg`) as all-default phantom instances. Always reject engine-dir prefixes (sbox-vehicle-kit: VehicleConfig.cs:102-119).

```csharp
public static IEnumerable<VehicleConfig> All =>
    ResourceLibrary.GetAll<VehicleConfig>()
        .Where( v => v is not null
            && !string.IsNullOrEmpty( v.ResourcePath )
            && !v.ResourcePath.StartsWith( "cfg/", StringComparison.OrdinalIgnoreCase ) );

public static VehicleConfig Find( string ident ) => All.FirstOrDefault( v => v.ResourceName == ident );
public static IEnumerable<VehicleConfig> WithTag( string tag ) => All.Where( v => v.Tags.Contains( tag ) );
```

Any custom extension that is a *suffix* of a built-in one is vulnerable — bake this filter into every GameResource lookup.

## Pattern: prefab registry — pre-clone, BreakFromPrefab, index by id

For inspector-referenced prefabs, build a registry `Component`: in `OnAwake` clone each prefab disabled, parent it, **call `BreakFromPrefab()`**, and index by a stable string id. "Giving" an item is then a lookup + clone (simple-weapon-base: WeaponRegistry.cs:25-55).

```csharp
[Property] public List<PrefabScene> WeaponPrefabs { get; set; } = new();
public Dictionary<string, Weapon> Weapons { get; } = new();

protected override void OnAwake()
{
    Instance = this;
    foreach ( var prefab in WeaponPrefabs )
    {
        var go = prefab.Clone( new CloneConfig { StartEnabled = false } );
        go.SetParent( GameObject );
        go.BreakFromPrefab();                       // REQUIRED if mutated at runtime
        var weapon = go.Components.Get<Weapon>( true );
        Weapons.TryAdd( weapon.ClassName, weapon );
        go.Name = weapon.ClassName;
    }
}
```

`BreakFromPrefab()` is mandatory on any prefab you mutate at runtime (e.g. attaching weapon attachments) — skip it and runtime-added components are silently lost on the next clone (simple-weapon-base: WeaponRegistry.cs:40).

## Pattern: service-locator singleton for registries/settings

The standard idiom for a globally-reachable content service: a static `Instance` set in `OnAwake`, **nulled in `OnDestroy`** so a stale handle doesn't survive a scene reload/hotload (simple-weapon-base: WeaponRegistry.cs:14-23).

```csharp
public static WeaponRegistry Instance { get; private set; }
protected override void OnAwake()   => Instance = this;
protected override void OnDestroy() { if ( Instance == this ) Instance = null; }
```

Null-guard every read — the component may not have awoken yet. (For state that must survive hotload, prefer `GameObjectSystem<T>` — see the networking reference.)

## Pattern: runtime file discovery & persistence

Treat the two filesystems distinctly: `FileSystem.Mounted` is read-only packaged content (listed in `.sbproj` `Resources`); `FileSystem.Data` is the user-writable sandbox. **Discover = enumerate both and merge; write = `Data` only** (sgba: GameEntry.cs:13-40).

```csharp
public static List<GameEntry> Discover()
{
    List<GameEntry> entries = [];
    CollectFrom( FileSystem.Mounted, entries );     // shipped roms/levels
    CollectFrom( FileSystem.Data,    entries );     // user-imported
    return entries;
}

static void CollectFrom( BaseFileSystem fs, List<GameEntry> entries )
{
    IEnumerable<string> found;
    try { found = fs.FindFile( "roms", "*.gba" ) ?? []; } catch { return; }   // FindFile can throw
    foreach ( var name in found ) entries.Add( BuildEntry( fs, $"roms/{name}", name ) );
}
```

For reads, probe whichever store reports `FileExists`. Write all saves/states/screenshots under `FileSystem.Data` with stable derived paths.

## Pattern: render-to-texture surface (CCTV / scope / minimap / mirror)

In `OnEnabled` create a dynamic render target; in a pre-render hook call `Graphics.RenderToTexture` **throttled by a `TimeSince` gate**; bind the texture to the model's `screen` attribute or a material override; `Dispose()` in `OnDestroy` (wirebox: WireCameraScreenComponent.cs:30-118 — API surface only; that file uses legacy attributes).

```csharp
Texture _texture;
TimeSince _sinceRender = 0;
int _fps = 20;

protected override void OnEnabled()
{
    _texture?.Dispose();
    _texture = Texture.CreateRenderTarget()
        .WithSize( 500, 300 ).WithScreenFormat().WithDynamicUsage().Create();

    var so = Components.Get<ModelRenderer>().SceneObject;
    if ( so.Attributes.GetTexture( "screen" ) != null )   // model has a screen slot
        so.Attributes.Set( "screen", _texture );
    else                                                  // override a material index
    {
        var mat = Material.Create( "cam_screen", "simple" );
        mat.Set( "Color", _texture );
        Components.Get<ModelRenderer>().SetMaterialOverride( mat, "materialIndex0" );
    }
}

protected override void OnPreRender()
{
    if ( !_camera.IsValid() || _sinceRender < 1.0f / _fps ) return;   // THROTTLE
    _sinceRender = 0;
    Graphics.RenderToTexture( _camera.GetSceneCamera(), _texture );
}

protected override void OnDestroy() => _texture?.Dispose();
```

Rendering every frame, with N screens, tanks framerate — the `TimeSince` gate is not optional. The `WithDynamicUsage` render target is **not** GC-managed; `Dispose()` it.

## Pattern: editor-live custom visuals — `[ExecuteInEditor]` + raw scene objects

To drive engine render objects directly (live-preview tools, procedural lights), implement `Component.ExecuteInEditor` so lifecycle runs in the editor. You **own** the handle: delete it in `OnDisabled` and before recreating in `OnEnabled`, and guard every access with `IsValid()` (sbox-scenestaging: LineRendererLight.cs:4-70).

```csharp
public class LineRendererLight : Component, Component.ExecuteInEditor
{
    SceneLight _light;

    protected override void OnEnabled()
    {
        if ( _light.IsValid() ) _light.Delete();                 // before recreate
        _light = new SceneLight( Scene.SceneWorld, Vector3.Zero, 100, Color.Red );
    }

    protected override void OnDisabled() { if ( _light.IsValid() ) _light.Delete(); }

    protected override void OnUpdate()
    {
        if ( !_light.IsValid() ) return;
        _light.Shape = SceneLight.LightShape.Capsule;
        _light.Position = WorldPosition;
    }
}
```

Because `[ExecuteInEditor]` runs during normal editing, leaks (no `Delete()` on disable/recreate) accumulate orphaned `SceneLight`/`SceneObject` handles on every hotload.

## Pattern: ship editor tooling inside a library

Put editor-only code under an `editor/` folder and exclude it from the runtime build via `IgnoreFolders` (SBox-Visual-Novel-Base: vnbase_library.sbproj:25-28). It still compiles into the editor assembly (can reference `Editor`, `EditorUtility`, `AssetList`) but is stripped from the shipped runtime build.

```jsonc
// .sbproj
"Metadata": { "Compiler": { "IgnoreFolders": [ "editor", "unittest" ] } }
```

Add a **"New > YourType"** file creator to the asset-browser folder menu via a `static [Event]` handler. Defer to `AboutToShow` and **self-unsubscribe** — the event fires repeatedly, so an inline build appends your option N times (SBox-Visual-Novel-Base: Events.cs:13-39).

```csharp
[Event( "folder.contextmenu" )]
private static void FolderContextMenu( FolderContextMenu obj )
{
    if ( obj.Context is not AssetList assetList ) return;     // narrow first

    Action? handler = null;
    handler = () =>
    {
        obj.Menu.AboutToShow -= handler;                     // self-unsubscribe
        var menu = obj.Menu.FindOrCreateMenu( "New" ).FindOrCreateMenu( "VNBase" );
        menu.AddOption( new Option( "VNScript", "desc", () => CreateNewFile( assetList.Browser ) ) );
    };
    obj.Menu.AboutToShow += handler;
}
```

Write the file with `SaveFileDialog` + an inline raw-string template, wrapped in try/catch — editor commands swallow exceptions silently (SBox-Visual-Novel-Base: Events.cs:41-69).

```csharp
var chosen = EditorUtility.SaveFileDialog( "Save vnscript...", ".vnscript", defaultPath );
if ( string.IsNullOrWhiteSpace( chosen ) ) return;            // user cancelled = no-op
try { File.WriteAllText( chosen, Template ); Log.Info( $"Created {chosen}" ); }
catch ( Exception ex ) { Log.Error( $"Failed: {ex}" ); }
```

For **batch operations on existing assets**, hook `[Event("asset.contextmenu", Priority = 60)]`, gate on the selection, then add an option that loops over `e.SelectedList` (sbox-grubs: AddAutoLOD.cs:10-21).

```csharp
[Event( "asset.contextmenu", Priority = 60 )]
public static void OnAssetContext( AssetContextMenu e )
{
    if ( !e.SelectedList.All( x => x.AbsolutePath.EndsWith( ".vmdl", StringComparison.OrdinalIgnoreCase ) ) )
        return;
    e.Menu.AddOption( "Add Automatic LODs", "layers",
        action: () => { foreach ( var a in e.SelectedList ) AddLODsToVmdl( a.AbsolutePath ); } );
}
```

When a tool must hand-edit text-based asset source (`.vmdl`/`.vmat` is KeyValues), do it defensively: normalize newlines (`.Replace("\r\n","\n")`), bail if the block already exists (idempotency), anchor on a stable structural marker and error if it's missing, and format numbers with `CultureInfo.InvariantCulture` (sbox-grubs: AddAutoLOD.cs:96-144). Prefer a real asset API; reserve text surgery for fields no API exposes.

## Gotcha table

| Gotcha | Fix |
| --- | --- |
| `GetAll<T>()` returns engine `cfg/*.cfg` as phantom `.vcfg` instances (suffix match) | Reject `ResourcePath.StartsWith("cfg/", OrdinalIgnoreCase)` in your `All` accessor (sbox-vehicle-kit: VehicleConfig.cs:109-113) |
| Runtime-added components lost when a prefab is re-cloned | Call `BreakFromPrefab()` on any prefab you mutate at runtime (simple-weapon-base: WeaponRegistry.cs:40) |
| Stale static `Instance` survives scene reload/hotload; reads before awake NRE | Null it in `OnDestroy`, null-guard reads (simple-weapon-base: WeaponRegistry.cs:19-23) |
| `RenderToTexture` every frame × N screens tanks FPS | Throttle with a `TimeSince < 1/fps` gate (wirebox: WireCameraScreenComponent.cs:38-42) |
| `WithDynamicUsage` render target leaks (not GC-managed) | `Dispose()` in `OnDestroy` (wirebox: WireCameraScreenComponent.cs:102-108) |
| Raw `SceneLight`/`SceneObject` orphaned on hotload | `Delete()` in `OnDisabled` and before recreate; guard with `IsValid()` (sbox-scenestaging: LineRendererLight.cs:26-35) |
| Reading one filesystem misses shipped OR user content; writes outside `Data` don't persist | Discover = merge `Mounted` + `Data`; write = `Data` only (sgba: GameEntry.cs:13-20) |
| `[ExecuteInEditor]` runs in the editor, so render-object leaks bite during normal editing | Same `IsValid`/`Delete` lifecycle discipline applies at edit time, not just play |
| `editor/` code leaks into the runtime build (whitelist failure) | List `editor` in `.sbproj` `Compiler.IgnoreFolders` (VNBase: vnbase_library.sbproj:25-28) |
| `folder.contextmenu` fires repeatedly → option appended N times | Defer to `AboutToShow` and self-unsubscribe (`-= handler`) (VNBase: Events.cs:21-38) |
| Editor command lambdas swallow exceptions silently | Wrap dialog + write in try/catch + `Log.Error`/`Log.Info` (VNBase: Events.cs:53-68) |
| `SaveFileDialog` returns null/empty on cancel | Treat as no-op, not an error (VNBase: Events.cs:57-60) |
| Hand-editing `.vmdl`/`.vmat` text corrupts on CRLF/culture/marker drift | Normalize newlines, idempotency-guard, anchor on a stable marker, `InvariantCulture` (sbox-grubs: AddAutoLOD.cs:96-144) |

Verify live: editor-namespace types (`AssetList`, `FolderContextMenu`, `AssetContextMenu`, `EditorUtility`, `Option`) and render-object APIs (`SceneLight`, `Texture.CreateRenderTarget`, `Graphics.RenderToTexture`) shift between SDK builds — confirm signatures with `describe_type`/`search_types`/`get_method_signature` against the installed SDK; reflection is authoritative, not training data.

See also: **sbox-api** (resolve exact types/signatures before writing) and **sbox-build-feature** (screenshot-driven iteration to verify render targets and inspector authoring visually).

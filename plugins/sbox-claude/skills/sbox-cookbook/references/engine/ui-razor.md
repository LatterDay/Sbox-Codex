# s&box UI: Razor PanelComponents, HUDs & World UI

Purpose: build HUDs, menus, and world-space UI in modern s&box (GameObject/Component/Scene) with correct `BuildHash()` reactivity, networked transient feeds, and async-UI safety.

## Mental model

There are three modern UI paths — pick by update style:

1. **Declarative `.razor` `PanelComponent`** — data-bound HTML/CSS tree that rebuilds when `BuildHash()` changes. Default choice for HUDs, menus, lists, world tags.
2. **Imperative `Sandbox.UI.Panel` + `override Tick()`** — subclass `Panel`, build children once in the constructor, read live state and mutate labels every frame. Use for fast scalar readouts (ammo/health/speed) where Razor diffing is overkill.
3. **World-space** — `Sandbox.WorldPanel` component for diegetic screens on a prop face, or a world-tag `PanelComponent` that sets `WorldPosition` each `OnUpdate` to follow a target (nameplates/healthbars).

The single most important contract is `BuildHash()`. Every `PanelComponent` re-evaluates each frame; the tree only **rebuilds** when the hash changes. List **exactly** the displayed state. Omit a field → UI silently never refreshes. Include a per-frame value (`Time.Now`, raw position, unquantized float) → you thrash a full rebuild 60×/sec. (garryware: `Code/Ware/UI/WareHud.razor:42`; sbox-grubs: `Code/UI/World/GrubTag.razor:78`)

Modern API only: `GameObject`/`Component`/`Scene`, `PanelComponent`, `[Sync]`, `[Rpc.Broadcast]`, `Connection.Local`. No legacy `Entity`/`Pawn`/`[Net]`/`RootPanel`.

## Recipe: a declarative HUD panel with correct BuildHash

```csharp
// MyHud.razor — @inherits PanelComponent
protected override int BuildHash()
    => HashCode.Combine( Health, Ammo, IsAlive ); // exactly what's rendered
```

Read live state straight off the source component rather than caching stale copies; bind it in the markup (`@Health`, `width: @(pct)%`). Quantize any time input you must show: garryware folds message age in as `(int)(Instruction.Age * 60f)` so it advances in 1/60s steps instead of every frame (garryware: `Code/Ware/UI/WareHud.razor:43`). The grubs healthbar drives CSS from inline expressions — `width: @(Grub.Health.CurrentHealth / 150f * 100f)%` — and hashes `ScaleFactor, Grub.Name, Grub.Health.CurrentHealth, Color` (sbox-grubs: `Code/UI/World/GrubTag.razor:16,80`).

## Recipe: imperative tree mutation needs StateHasChanged()

`BuildHash` only catches changes to **bound scalar fields**. When you imperatively mutate the tree (append a chat line, prune an expired entry, add code-built children) the framework won't notice — call `StateHasChanged()` after the mutation (sbox-scenestaging: `Code/ExampleComponents/Chat/Chat.razor:53,81`).

```csharp
[Rpc.Broadcast]
public void AddText( string author, string message )
{
    Entries.Add( new Entry( author, message, 0.0f ) );
    StateHasChanged();                       // force a rebuild
}

protected override void OnUpdate()
{
    if ( Entries.RemoveAll( x => x.timeSinceAdded > 30.0f ) > 0 )
        StateHasChanged();                   // pruning is also imperative
}
```

The Chat panel mixes both: a data-bound `@foreach` list + an RPC that pushes a line, and implements `Component.INetworkListener` for join/leave messages (sbox-scenestaging: `Code/ExampleComponents/Chat/Chat.razor:4,84`).

## Recipe: imperative widget (constructor + Tick)

For a fast readout, subclass `Panel`, build children once, refresh every frame. Toggle visibility with a CSS class, not by disabling the GameObject (simple-weapon-base: `code/swb_hud/AmmoDisplay.cs:20,30`).

```csharp
public class AmmoDisplay : Panel
{
    Label clipLabel;
    public AmmoDisplay( PlayerBase player )
    {
        StyleSheet.Load( "/swb_hud/AmmoDisplay.cs.scss" );
        clipLabel = Add.Label( "", "clip" );   // build once
    }
    public override void Tick()                // read live state each frame
    {
        var weapon = player.Inventory.Active?.Components.Get<Weapon>();
        SetClass( "hide", weapon is null );    // CSS toggle, panel stays cheap
        if ( weapon is null ) return;
        clipLabel.Text = weapon.Primary.Ammo.ToString();
    }
}
```

## Recipe: networked transient feed (kill feed / toasts)

A `[Rpc.Broadcast]` builds panels imperatively, styles "is-me" off `Connection.Local.SteamId`, and auto-expires each entry with `Invoke(delay, …)`. Early-return on the dedicated server so it doesn't waste cycles or null-crash on missing presentation (sandbox: `Code/UI/Feed.razor.cs:19`).

```csharp
[Rpc.Broadcast]
public void NotifyKill( string victim, string attacker, long attackerSteamId, Texture icon )
{
    if ( Application.IsDedicatedServer ) return;
    var row = new Panel();
    var p = row.AddChild<Panel>( "icon" );
    p.Style.SetBackgroundImage( icon );
    p.Style.AspectRatio = icon.Width / icon.Height;
    if ( attackerSteamId == Connection.Local.SteamId ) row.AddClass( "is-me" );
    Panel?.AddChild( row );
    Invoke( 7, () => row.Delete() );           // timed teardown
}

protected override void OnUpdate()
    => SetClass( "hide", Player.FindLocalPlayer()?.WantsHideHud ?? false );
```

## Recipe: bootstrap a HUD in code (GameObjectSystem + ScreenPanel)

Create the HUD at runtime instead of placing it in a scene. A `GameObjectSystem` makes a `GameObject`, adds a `ScreenPanel` (`AutoScreenScale`, `ScaleStrategy`, `ZIndex`) plus the panel type found via `Game.TypeLibrary`, and tears it down when play stops. **Guard the editor and dedicated-server contexts** or you spam the editor scene view and waste headless cycles (garryware: `Code/Ware/UI/WareHudSystem.cs:13,47,71`).

```csharp
public sealed class HudSystem : GameObjectSystem<HudSystem>
{
    GameObject _root;
    public HudSystem( Scene scene ) : base( scene )
        => Listen( Stage.StartUpdate, 1000, Tick, "Hud" );

    void Tick()
    {
        if ( Application.IsEditor && !Game.IsPlaying ) { Teardown(); return; }
        EnsureHud();
    }

    void EnsureHud()
    {
        if ( Application.IsDedicatedServer ) return;
        if ( Application.IsEditor && !Game.IsPlaying ) return;
        if ( _root.IsValid() ) return;

        _root = new GameObject( true, "HUD" ) { Flags = GameObjectFlags.NotSaved };
        var screen = _root.Components.Create<ScreenPanel>();
        screen.AutoScreenScale = true;
        screen.ScaleStrategy = ScreenPanel.AutoScale.ConsistentHeight;
        screen.ZIndex = 300;

        var type = Game.TypeLibrary.GetTypes<PanelComponent>()
            .FirstOrDefault( t => t.TargetType.Name == "MyHud" );
        if ( type is not null ) _root.Components.Create( type );
    }

    void Teardown() { if ( _root.IsValid() ) _root.Destroy(); _root = null; }
}
```

Decouple data from rendering: hold the current instruction/status in a plain `static` state class that RPCs write into, and have the razor read it + fold `Version` into `BuildHash`. Gameplay never references UI types (garryware: `Code/Ware/UI/WareHud.razor:33,43`).

## Recipe: world-space panel on a prop's screen face

Spawn a child GameObject, add `Sandbox.WorldPanel`, `NetworkSpawn` it, then build labels into `worldPanelComponent.GetPanel()`. Sizing is **not pixels** — convert through `WorldPanel.ScreenToWorldScale`. Keep a per-model offset table for local Position/Rotation/Size, and lazily retry init until the panel is valid (wirebox: `Code/wirebox/components/WireDigitalScreenComponent.cs:42,49,66`).

```csharp
worldPanelComponent = mountPoint.AddComponent<Sandbox.WorldPanel>();
mountPoint.NetworkSpawn();
// later, once valid:
var panel = worldPanelComponent.GetPanel() as Sandbox.UI.WorldPanel;
var data  = ScreenDatabase.GetValueOrDefault( Model.Name );   // per-model offsets
mountPoint.WorldPosition       = Transform.World.PointToWorld( data.Position );
mountPoint.WorldRotation       = Transform.World.RotationToWorld( data.Rotation );
worldPanelComponent.PanelSize  = data.Size / Sandbox.UI.WorldPanel.ScreenToWorldScale;
```

For floating nameplates use a world-tag `PanelComponent` instead: set `WorldPosition` every `OnUpdate` (a cheap transform write, **not** a rebuild) and lerp a scale by camera distance, keeping `BuildHash` limited to displayed data (sbox-grubs: `Code/UI/World/GrubTag.razor:67,74`).

## Recipe: show a runtime Texture (minimap / camera feed / render target)

Don't fight the `.razor` `<img>` — wrap a `Panel` whose setter calls `Style.SetBackgroundImage`, and hash the texture so it redraws when the instance flips. The host panel should also fold the live texture into its own `BuildHash` (sgba: `Code/UI/TextureImage.cs:1`).

```csharp
public sealed class TextureImage : Panel
{
    Texture _texture;
    [Parameter] public Texture Texture
    {
        get => _texture;
        set { if ( _texture == value ) return; _texture = value; Style.SetBackgroundImage( _texture ); }
    }
    protected override void OnParametersSet() { Style.SetBackgroundImage( _texture ); }
    protected override int BuildHash() => HashCode.Combine( _texture );
}
```

## Recipe: guard overlapping async UI (typewriter / fades / auto-advance)

The #1 async-UI bug: a `Task.Delay` from an old animation wakes after the user skipped/advanced and clobbers the new state. Gate every continuation behind a **revision counter + CancellationToken**. Bump the revision and cancel the CTS on every new op so in-flight tasks become no-ops (SBox-Visual-Novel-Base: `Libraries/VNBase/Code/Systems/Player/ScriptPlayer.cs:231-247`).

```csharp
int _revision; CancellationTokenSource _cts;

int StartOp( out CancellationToken token )
{
    _revision++; _cts?.Cancel(); _cts?.Dispose();   // invalidate prior op
    _cts = new CancellationTokenSource(); token = _cts.Token;
    return _revision;
}

async Task TypeAsync()
{
    var rev = StartOp( out var token );
    foreach ( var ch in text )
    {
        await Task.Delay( 30 );
        if ( token.IsCancellationRequested || rev != _revision ) return; // stale → bail
        Label.Text += ch;
    }
}
```

When revealing **rich text** (`IsRich` labels), chunk whole `<tag>` / `&entity;` spans in one step or you briefly print `<b`, `&am` mid-markup — only literal glyphs incur the delay (SBox-Visual-Novel-Base: `Libraries/VNBase/Code/Systems/Effects/Effects.cs:19-94`). Prefer `TimeUntil`/`Destroy` over `async void` for timed lifetimes — `async void` continuations outlive the GameObject and aren't cancelled on disable/hotload.

## Misc patterns

- **Find sub-panels by type**, don't cache serialized refs (null/brittle for Razor-built trees): walk `Panel.ChildrenOfType<T>()` and `OfType<T>().FirstOrDefault()` on demand (SBox-Visual-Novel-Base: `Libraries/VNBase/Code/UI/VNHud.razor.cs:39-57`).
- **Cursor unlock** fought over by multiple widgets → use an owner-keyed request set and unlock if any owner requests it, not a shared bool.
- **Localization** — externalize every string into per-locale JSON keyed by registry-derived `GetTranslationKey()` so new content auto-participates; retrofitting is painful (ttt-reborn: `code/roles/Role.cs:74`).

## Gotcha table

| Symptom | Cause | Fix |
|---|---|---|
| Panel never updates | Displayed field missing from `BuildHash()` | List exactly the rendered state |
| Full rebuild 60×/sec | `Time.Now`/raw position/unquantized float in `BuildHash()` | Quantize time inputs (`(int)(age*60f)`), exclude per-frame values |
| Appended/pruned list not shown | Imperative tree mutation | Call `StateHasChanged()` after the mutation |
| HUD spams editor / wastes server | `GameObjectSystem` runs in editor scene view + dedicated server | Gate on `Application.IsEditor && !Game.IsPlaying` and `Application.IsDedicatedServer` |
| Old animation clobbers new line | Dangling `Task.Delay` after skip/advance | Revision counter + `CancellationToken`, check before mutating |
| Typewriter prints `<b`, `&am` | Naive per-char reveal on `IsRich` label | Emit whole tags/entities in one step |
| World panel wrong size / null first frame | Pixel sizing; panel not valid yet | `PanelSize = worldSize / WorldPanel.ScreenToWorldScale`; lazily retry init in `OnUpdate` |
| Sub-panel ref is null | Cached serialized ref to Razor-built child | Discover via `ChildrenOfType<T>()` on demand |
| Cursor flickers between widgets | Boolean tug-of-war | Owner-keyed unlock request set; unlock if any active |
| `[Rpc.Broadcast]` UI crashes headless | Body runs on dedicated server too | Early-return on `Application.IsDedicatedServer` |
| Synced UI state rolls back | Mutated on a proxy | Gate mutators with `if (IsProxy) return;` (owner-auth) or `if (!Networking.IsHost) return;` |
| `Connection`/`GameObject` field won't sync | They're local handles, not `[Sync]`-able | Sync a `Guid`, resolve via `Connection.All` / `Scene.Directory.FindByGuid` |

Verify live: API names drift between SDK builds — confirm types/members with `describe_type`, `search_types`, and `get_method_signature` (reflection is authoritative for the installed SDK) before writing, especially `WorldPanel.ScreenToWorldScale`, `ScreenPanel.AutoScale`, and `Style.SetBackgroundImage` overloads. Cross-link: see the **sbox-api** skill for reflection lookups and the **sbox-build-feature** skill for the screenshot-driven iteration loop that proves a HUD re-renders only on the intended state changes.

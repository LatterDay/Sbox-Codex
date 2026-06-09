# s&box Architecture

How to structure a modern s&box game: own scene-wide logic in systems, decouple via event buses and shared interfaces, decompose fat components, and package reusable features as Library addons.

## Mental model

Four pillars, all built on the modern `GameObject` / `Component` / `Scene` runtime (never legacy `Entity`/`Pawn`/`[Net]`):

1. **System ownership** — authoritative game-loop logic lives in a `GameObjectSystem<T>`, not a manager Component a designer can delete.
2. **Event decoupling** — systems talk through `ISceneEvent<T>` buses, never direct references.
3. **Component decomposition** — one feature = one `sealed partial class` split across files by concern, with an ordered `Tick*` pipeline.
4. **Library packaging** — reusable features ship as `.sbproj` addons that depend only on thin interfaces in a shared assembly + a static registry.

Training data leans on a "GameManager Component on a root GameObject" — that is the outdated pattern. The modern equivalent is a system whose `Current` is reconstructed safely across scene loads and hotloads.

## Pattern: own the game loop in `GameObjectSystem<T>`

Make the authoritative loop a system, compose responsibilities by implementing engine interfaces, reach it via the static `Current` — no `GetAllComponents` scan, no deletable manager object. Per-connection spawn lives in `INetworkListener.OnActive`; lobby creation in `ISceneStartup.OnHostInitialize`.

```csharp
public sealed partial class GameManager
    : GameObjectSystem<GameManager>,
      Component.INetworkListener, ISceneStartup, IScenePhysicsEvents
{
    public GameManager( Scene scene ) : base( scene )
    {
        // Per-frame work, registered with an explicit order for deterministic sequencing.
        Listen( Stage.StartUpdate, 0,    TickRound, "round" );
        Listen( Stage.StartUpdate, 1000, TickHud,   "hud" );   // HUD reads AFTER sim
    }

    void ISceneStartup.OnHostInitialize()
    {
        if ( !Networking.IsActive )
            Networking.CreateLobby( new() { MaxPlayers = 32, Name = "MyGame" } );
    }

    void Component.INetworkListener.OnActive( Connection channel )
    {
        var data = CreatePlayerInfo( channel );   // networked PlayerData object
        SpawnPlayer( data );                       // clone prefab + NetworkSpawn( owner )
    }

    void TickRound() { /* ... */ }
    void TickHud() { /* ... */ }
}
```

The spawn flow itself: create a networked info object with fixed ownership, then clone the prefab and hand authority to the joining connection (sandbox: `Code/GameLoop/GameManager.cs:53-66,70-98`).

```csharp
var go = new GameObject( true, $"PlayerInfo - {channel.DisplayName}" );
var data = go.AddComponent<PlayerData>();
go.NetworkSpawn( channel );
go.Network.SetOwnerTransfer( OwnerTransfer.Fixed );
// ...later, to spawn the body:
var playerGo = GameObject.Clone( "/prefabs/engine/player.prefab",
    new CloneConfig { StartEnabled = false, Transform = startLocation } );
playerGo.NetworkSpawn( owner );   // exactly one machine spawns; owner gets authority
```

This system-owns-the-loop shape is the single most repeated modern pattern across `sandbox`, `sandbox-plus-plus`, and `garryware` (sandbox: `Code/GameLoop/GameManager.cs:3`).

## Pattern: decoupled event bus on `ISceneEvent<T>`, split Local vs Global

Declare a typed event interface with **empty default-bodied methods** so each listener implements only the hooks it needs — zero manual subscribe/unsubscribe. Expose two facets via partial static classes: `Local` fires to one object's hierarchy, `Global` fires scene-wide (sandbox: `Code/Player/PlayerEvent.cs:104-148`).

```csharp
public static partial class Local
{
    public interface IPlayerEvents : ISceneEvent<IPlayerEvents>
    {
        void OnSpawned() { }
        void OnDamaging( PlayerDamageEvent e ) { }   // default body = optional
    }
}

public static partial class Global
{
    public interface IPlayerEvents : ISceneEvent<IPlayerEvents>
    {
        void OnPlayerSpawned( Player player ) { }
        void OnPlayerRespawning( PlayerRespawnEvent e ) { }   // mutable arg -> veto/rewrite
    }
}
```

Fire to one hierarchy, or scene-wide:

```csharp
Local.IPlayerEvents.PostToGameObject( player.GameObject, x => x.OnSpawned() );
Global.IPlayerEvents.Post( x => x.OnPlayerSpawned( player ) );
```

For **pre-action hooks**, pass a mutable class so any listener can rewrite or veto before the action commits — this is how an independent system overrides spawn points without the core ever referencing it (sandbox: `Code/GameLoop/GameManager.cs:83-85`):

```csharp
var respawnEvent = new PlayerRespawnEvent { SpawnLocation = startLocation };
Global.IPlayerEvents.Post( x => x.OnPlayerRespawning( respawnEvent ) );
startLocation = respawnEvent.SpawnLocation;   // a listener may have changed it
```

Never broadcast a per-entity event scene-wide — that wakes every listener. The Local/Global split exists precisely to prevent that.

## Pattern: split a big Component into one sealed partial class by concern

Keep a feature-rich entity as a SINGLE `sealed partial class` (one inspector, shared private state, one networked identity) but physically split it across files by concern. The root file's lifecycle methods read like a table of contents calling per-concern `Tick*`/`OnStart*` methods in explicit order — that ordered sequence IS your pipeline.

```csharp
// Weapon.cs   (root: shared state + lifecycle dispatch)
public sealed partial class Weapon : Component
{
    protected override void OnUpdate()
    {
        TickAiming();
        TickShoot();     // Weapon.Shoot.cs
        TickReload();    // Weapon.Reload.cs
    }
}

// Weapon.Shoot.cs  (one concern; may add its own interfaces)
public sealed partial class Weapon : IShootable
{
    void TickShoot() { /* ... */ }
}
```

Each partial can declare the interfaces relevant to its slice (e.g. `Player.Interact.cs` adds `IPressable`). Reach for this the moment a Component passes ~300 lines — it avoids manager-component spaghetti and keeps a hot file mergeable (simple-weapon-base: `code/swb_base/Weapon.cs:10`, `code/swb_base/Weapon.Shoot.cs`; sbox-vehicle-kit: `Libraries/Vehicles.Maintenance/Code/Components/VehicleBase.cs:13-83`).

## Pattern: portable system = thin interface in a shared assembly + static registry

A reusable system (weapon, inventory, vehicle, economy) must NEVER name a concrete host type. Put thin contracts in a separate shared `.sbproj`; the library talks only to the interface; the game supplies the implementation.

```csharp
// swb_shared assembly — compose with engine contracts so you inherit IsValid/OnDamage.
public interface IPlayerBase : IValid, Sandbox.Component.IDamageable
{
    Guid Id { get; }
    GameObject GameObject { get; }
}
```

The weapon types its owner as `IPlayerBase` and resolves up the tree, never naming the game's `PlayerBase` (simple-weapon-base: `code/swb_shared/IPlayerBase.cs:8`):

```csharp
Owner = Components.GetInAncestors<IPlayerBase>( true );
```

For services with currency/jobs/state, add a `static Host { Current; Register }` seam. The gamemode writes a small adapter and registers it once at startup; library code calls `Current` and never names a gamemode type (sbox-vehicle-kit: `Libraries/Vehicles.Maintenance/Code/Contracts/IVehicleHost.cs:11-39`):

```csharp
public interface IVehicleHost
{
    bool TryCharge( Connection player, int amount, string reason );
    bool IsMechanic( Connection player );
}

public static class VehicleHost
{
    public static IVehicleHost Current { get; private set; }
    public static void Register( IVehicleHost host ) => Current = host;
}

// Library runtime, decoupled from any game:
if ( VehicleHost.Current.TryCharge( player, 500, "repair" ) ) { /* ... */ }
```

This interface-in-shared-assembly + static-registry seam is THE reason these frameworks drop into any game.

## Pattern: auto-register pluggable types via TypeLibrary reflection

For any open-ended set (commands, abilities, items, roles, spawnables), discover implementers at startup instead of editing a central switch. Adding a feature = drop in a class; it just works — killing the classic "I added the class but it never fires" bug (dxrp: `game/code/Chat/Chat.Command.cs:9`; ttt-reborn: `code/roles/Role.cs:76`).

```csharp
foreach ( var t in TypeLibrary.GetTypes<ICommand>().Where( t => !t.IsAbstract ) )
{
    var cmd = TypeLibrary.Create<ICommand>( t.TargetType );
    _commands[cmd.Name] = cmd;   // index by metadata the interface carries
}
```

Combine with library attributes for tagged lookup-by-name (`[Role("traitor")]`, `[Team("traitors")]`) so factions/classes are additive and never touch an enum.

## Pattern: ship a feature as a Library addon

Package cross-cutting functionality under `Libraries/<Name>/` with its own `<name>_library.sbproj` and namespace — not in the game's `Code/`. Expose a real public API: `OnLoad/OnUnload` hooks, `Action` events, an interface, and a `Settings` object whose asset-path roots are `const` so consumers and the editor agree. Put the cross-component contract interface in the library so external addons can be compatible WITHOUT referencing your addon, and query peers polymorphically (wirebox: `wirelib/Code/BaseWireOutputComponent.cs:48`; SBox-Visual-Novel-Base: `Libraries/VNBase/vnbase_library.sbproj`).

```csharp
if ( go.GetComponent<IWireOutputComponent>() is { } output )
    output.TriggerOutput( value );
```

## Pattern: singletons that survive hotload

Plain `static` singletons are nulled on every code hotload. Use a generic base that caches a `static T Local`, lazily falls back to a scene scan, and persists the active instance across recompile via `IHotloadManaged` (sbox-grubs: `Code/Common/LocalComponent.cs:8`).

```csharp
public abstract class LocalComponent<T> : Component, IHotloadManaged
    where T : LocalComponent<T>
{
    private static T _local;
    public static T Local
    {
        get => _local ?? Game.ActiveScene
            .GetAllComponents<T>()
            .FirstOrDefault( c => c.Network.IsOwner || !c.IsProxy );
        protected set => _local = value;
    }

    void IHotloadManaged.Destroyed( Dictionary<string, object> s ) => s["IsActive"] = _local == this;
    void IHotloadManaged.Created( IReadOnlyDictionary<string, object> s )
    {
        if ( s.GetValueOrDefault( "IsActive" ) is true ) Local = (T)this;
    }
    protected override void OnDestroy() => Local = null;
}
```

Assign `Local` in `OnStart` AFTER an `!IsProxy` check, or a client will claim another player's `Local` on a proxy object.

## Pattern: dependency-sorted module loader (topological boot + fault isolation)

For a big framework game (RP, life-sim) where features are independent subsystems (economy, jobs, doors, inventory, chat, admin), boot them through a **module loader** instead of a hand-ordered list of `OnStart`s. Each module declares its `Dependencies`; the loader **topological-sorts** them (so a module's deps boot first), runs staged lifecycle phases across the whole set, and **isolates faults** so one broken module is marked `Failed` and boot continues.

```csharp
public static IReadOnlyList<GameModule> BootOrder => _bootOrder ??= GetSorted();
public static bool ContinueOnModuleFailure { get; set; } = true;   // safer default for a modular framework

public static void Boot()
{
    Run( "PreInitialize", m => m.PreInitializeInternal() );        // staged phases over the sorted set
    Run( "Initialize",    m => m.InitializeInternal() );
    Run( "PostInitialize",m => m.PostInitializeInternal() );
    Run( "Start",         m => m.StartInternal() );
    Run( "PostStart",     m => m.PostStartInternal() );
}

static void Run( string stage, Action<GameModule> action )
{
    foreach ( var module in BootOrder )
    {
        if ( module.HasFailed || HasFailedDependency( module ) ) { module.MarkFailed(...); continue; }
        try { action( module ); }
        catch ( Exception ex ) { module.MarkFailed( ex ); if ( !ContinueOnModuleFailure ) throw; }
    }
}
```

The DFS sort throws a clear **`Module dependency cycle detected: A -> B -> A`** on a back-edge (permanent/temporary visited sets + a stack to print the path), and `Shutdown()` runs the boot order **in reverse**. Verified against lowkeynetworks.newrp `Code/framework/modules/ModuleManager.cs`: factory registration locked after `BuildModules` (`:31`), `GetSorted`/`Visit` topological sort with cycle detection (`:249-293`), staged `Run` with per-module try/catch + dependency-failure skip (`:202-236`), reverse-order shutdown (`:156`). Pair it with a typed static **EventBus** so modules talk without naming each other — `Subscribe<T>(Action<T>)` / `Publish<T>(T)`, dup-guarded, with each handler dispatched inside its own try/catch so one throwing subscriber can't break the publish loop (newrp `Code/framework/events/EventBus.cs:57-84`). This is the "module loader + DI + EventBus" backbone for a walkable-town-with-jobs game; the `GameObjectSystem<T>` pattern above is the lighter choice when you have one authoritative loop rather than many pluggable subsystems.

## Pattern: separate identity (Role) from win-condition (Team)

Don't conflate cosmetic/economy identity with who-beats-whom. A `Role` carries color/credits/shop/selectability; a `Team` owns the `Members` list and `CheckWin`. Delegate evaluation down the chain `Player.CheckWin() -> Role.CheckWin() -> Team.CheckWin()` so each faction's win logic lives in one place and multiple roles can share one condition. Tag both with library attributes and instantiate by name through the reflection registry, never a hardcoded enum (ttt-reborn: `code/roles/Role.cs:76`, `code/teams/Team.cs:41`).

## Pattern: defensive boundaries for drifting APIs and threads

Engine API names drift between SDK builds, so wrap genuinely volatile calls in `try/catch` that sets a one-shot `_warned` flag, logs ONE actionable Warning, and falls back to safe behavior instead of crashing (sbox-vehicle-kit: `Libraries/Vehicles.Maintenance/Code/Components/VehicleBase.Wheels.cs:528-536`).

```csharp
try { Body.MotionEnabled = false; }
catch ( Exception e ) { if ( !_warnedMotion ) { _warnedMotion = true; Log.Warning( $"MotionEnabled unavailable: {e.Message}" ); } }
```

For REST/threaded subsystems: single-flight with `Interlocked.CompareExchange` so pulses can't overlap, and ALWAYS `await GameTask.MainThread()` after every await before touching scene/Component state (dxrp: `game/code/Api/ServerApiLink.cs:63,137`).

## Pattern: const tag/input helpers + the canonical trace chain

Stringly-typed tags and input actions are a top silent-bug source — expose each as a `const string` for compile-time safety and one refactor point. The reference raycast recipe for any weapon/interaction/LOS check is the full builder chain (simple-weapon-base: `code/swb_base/Weapon.Shoot.cs:149`):

```csharp
var tr = Game.ActiveScene.Trace.Ray( start, end )
    .UseHitboxes()
    .WithoutTags( BulletTraceIgnoreTags )      // const[] spread from a TagsHelper
    .Size( radius )
    .IgnoreGameObjectHierarchy( owner )
    .Run();
```

## Gotchas

| Gotcha | Why it bites | Fix |
| --- | --- | --- |
| Manager as a Component on a root GameObject | Designer can delete/duplicate it; needs a `GetAllComponents` scan | Use `GameObjectSystem<T>`; reach via `Current` |
| `static Player Local` nulled after hotload | Plain statics are wiped on recompile | `GameObjectSystem<T>` or `LocalComponent<T>` + `IHotloadManaged` |
| Assigning `Local` without `!IsProxy` guard | A client claims another player's pawn on a proxy | Guard with `!IsProxy` / `Network.IsOwner` in `OnStart` |
| `Time.Delta` is 0 when paused (`Scene.TimeScale=0`) | Free cameras / pause UI freeze | Use `RealTime.SmoothDelta` for time-scale-independent motion |
| Broadcasting a per-entity event scene-wide | Wakes every listener in the scene | `Local.IFooEvents.PostToGameObject(go, …)` for one hierarchy |
| `Listen(Stage,…)` runs in registration order | HUD reads stale sim state | Low order for sim (0), high for HUD (1000) |
| Default interface methods can't be called on a class ref | `x.Foo()` won't compile without a cast | Wrap in a `this`-extension so call sites stay clean |
| Re-entrant async / off-thread scene mutation | Overlapping pulses; silent rollback off main thread | `Interlocked.CompareExchange` single-flight + `await GameTask.MainThread()` before any mutation |
| Engine API renamed between SDK builds | Code from memory won't compile/run | Verify via reflection; wrap volatile calls in try/catch + one-shot warning |
| Persisted config hand-edited / version-skewed | Throws on load, or loads wrong file type | Enumerated load outcome that regenerates defaults + a `JsonType` discriminator |
| Mutating synced state on a proxy | Silently rolls back (the #1 bug class) | `if (IsProxy) return;` (owner-auth) or `if (!Networking.IsHost) return;` (host-auth) + dev `Assert` |
| `[Rpc.Host]` body trusts caller args | NetFlags restrict who *invokes*, not security | Re-validate ownership/permission/limits and rate-limit inside the body |

## Verify live

API names drift between SDK builds — reflection on the installed SDK is authoritative. Before writing code against any type here, confirm it with `describe_type` / `search_types` / `get_method_signature` (e.g. `describe_type GameObjectSystem`, `search_types ISceneEvent`, `describe_type Component.INetworkListener`).

Cross-link: pair with the **sbox-api** skill (reflection lookups for exact signatures) and the **sbox-build-feature** skill (screenshot-driven iteration to prove a change works).

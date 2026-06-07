# Component & GameObject Lifecycle

Purpose: spawn timing, dependency wiring, persistent-vs-disposable object splits, scene-scoped services, simulation gating, and deterministic teardown for s&box `Component`/`GameObject`/`Scene` code.

## Mental model

A `Component` is a script on a `GameObject`; the `Scene` owns the tree. Hooks fire in order (override `protected override void On…`):

- `OnAwake` — once on create. Transform/owner set, but other systems and screen NOT settled. Do off-screen positioning + `Network.ClearInterpolation()` here.
- `OnStart` — once, after the batch's `OnAwake`s. Still before `Screen` size / peers settle — defer heavy work.
- `OnEnabled` / `OnDisabled` — every enable/disable toggle (incl. spawn/despawn).
- `OnUpdate` — per render frame (`Time.Delta`). UI, cosmetics, world-panel positioning.
- `OnFixedUpdate` — fixed physics tick. All movement/physics integration belongs here.
- `OnDestroy` — teardown: cancel async, unsubscribe delegates, null statics.

`OnUpdate`/`OnFixedUpdate`/`OnCollisionStart` run on every machine, but usually only the simulating one should mutate state — gate them (see #6).

## Patterns (recipes)

### 1. Hide-until-positioned to kill the one-frame origin flicker

A freshly spawned object renders at `(0,0,0)` for one frame before its real position is computed. Park it off-screen in `OnAwake`, then clear interpolation so the visual doesn't lerp from the origin.

```csharp
protected override void OnAwake()
{
    if ( !IsProxy ) // only the authority sets position; proxies receive it networked
    {
        WorldPosition = new Vector3( 0, 0, -999999 );
        Network.ClearInterpolation();
    }
    Owner = Components.GetInAncestors<IPlayerBase>( true );
}
```
(simple-weapon-base: code/swb_base/Weapon.cs:42) — note `GetInAncestors` to find the owning player. Call `Network.ClearInterpolation()` after ANY hard teleport, not just spawn. For fast networked projectiles also set `Network.Interpolation = false` so the visual doesn't lag the true position (simple-weapon-base: code/swb_base/bullets/BulletInfo.Physical.cs:56).

To dodge renderer-enable flicker, create renderers `ShadowsOnly`/`Off` and reveal a frame later via `await GameTask.DelayRealtime(1)` in `OnComponentEnabled` (simple-weapon-base: code/swb_player/PlayerBase.cs:67).

### 2. Guaranteed deps with `[RequireComponent]`; correct `FindMode` for lookups

`[RequireComponent]` makes the engine auto-add and guarantee the dependency — no null checks:

```csharp
public sealed class NavigationTargetWanderer : Component
{
    [RequireComponent] NavMeshAgent Agent { get; set; }
    [RequireComponent] Rigidbody Body { get; set; }

    protected override void OnEnabled() => Agent.MoveTo( _currentTarget ); // Agent is never null
}
```
(sbox-scenestaging: Code/ExampleComponents/NavigationTargetWanderer.cs:9)

`Components.Get<T>()` defaults to **self-only** and silently returns `null` when the component lives on a child or parent. Pick the directional `FindMode`:

```csharp
Components.Get<Gun>();                                          // self only (the silent-null trap)
Components.GetInAncestors<IPlayerBase>( includeDisabled: true ); // walk UP (gun → owning player)
Components.Get<Health>( FindMode.EnabledInSelfAndDescendants );  // walk DOWN, enabled only
Components.Get<Hitbox>( FindMode.EverythingInSelfAndDescendants );// any tagged child under a prefab
```
A trace hits a child collider/hitbox, not the entity root — resolve up with `GetInAncestorsOrSelf<IDamageable>()`.

### 3. Split persistent networked data from the disposable pawn

Stats and identity tied to the pawn vanish when the pawn is destroyed on death. Spawn a separate `PlayerData` component once per connection to hold `[Sync]`'d data, and re-spawn the pawn freely:

```csharp
var go = new GameObject( true, $"PlayerInfo - {channel.DisplayName}" );
var data = go.AddComponent<PlayerData>();
data.SteamId = (long)channel.SteamId;
go.NetworkSpawn( null );                       // replicate; null = no per-client owner
go.Network.SetOwnerTransfer( OwnerTransfer.Fixed );  // survives owner disconnect
```
The pawn is a separate prefab clone linking back via `[Sync(SyncFlags.FromHost)] public PlayerData PlayerData`; look it up with a static `PlayerData.For(connection)` / `PlayerData.All`. (garryware: Code/GameLoop/GameManager.cs:41-89). Note pawn spawn there: `Clone(..., new CloneConfig { StartEnabled = false, Transform = startLocation })` then `NetworkSpawn(owner)` — configure BEFORE spawning, assign authority via the `Connection`.

### 4. Belt-and-suspenders cleanup for transient (per-round) objects

Track by reference AND by tag so nothing leaks even if a reference is dropped:

```csharp
public GameObject CreateTemporaryObject( string name, Vector3 position, bool networked = false )
{
    var go = new GameObject( true, name )
    {
        WorldPosition = position,
        Flags = GameObjectFlags.NotSaved,                      // keep out of the saved scene
        NetworkMode = networked ? NetworkMode.Object : NetworkMode.Never
    };
    RegisterTemporaryObject( go );                             // push into a tracked list
    return go;
}

public void CleanupTemporaryObjects()
{
    foreach ( var go in Scene.GetAllObjects( true )
        .Where( x => x.Tags.Contains( "ware" ) && x.Tags.Contains( "removable" ) ).ToArray() )
        if ( go.IsValid() ) go.Destroy();                      // tag sweep

    foreach ( var go in _temporaryObjects.ToArray() )
        if ( go.IsValid() ) go.Destroy();                      // tracked list
    _temporaryObjects.Clear();
}
```
(garryware: Code/Ware/WareRoundSystem.cs:394-421). Choose `NetworkMode.Never` vs `.Object` per object based on whether clients need it.

### 5. Scene-scoped services via `GameObjectSystem<T>` with ordered hooks

For cross-cutting managers (cooldowns, watchdogs, API links) extend `GameObjectSystem<T>` instead of putting a `Component` on a `GameObject` — no deletable/duplicable prefab slot, a real per-scene singleton, and survives hotload (access via `T.Current`):

```csharp
public class Cooldown : GameObjectSystem<Cooldown>
{
    public Cooldown( Scene scene ) : base( scene )
    {
        Listen( Stage.FinishUpdate, 10, ProcessCooldowns, "ProcessCooldowns" );
    }
    private void ProcessCooldowns() { /* … */ }
}
```
(dxrp: game/code/Cooldown.cs:6). The middle arg is **priority** — it deterministically orders cross-system ticks ("system A before system B"). Subscribe to load too: `Listen( Stage.SceneLoaded, 100, Loaded, "Sentinel Start" )` and bail in editor with `if ( Scene.IsEditor ) return;` (dxrp: game/code/Sentinel/Sentinel.cs:18).

### 6. Simulation gating — `LocalSimulation || Network.IsOwner` (incl. collisions)

`Network.IsOwner` is `false` in a solo editor playtest (no lobby = no owner), so an `IsOwner`-only guard makes whole systems silently dead until multiplayer starts. Combine with a `[Property]` override:

```csharp
[Property] public bool LocalSimulation { get; set; } = true;
bool ShouldSimulate => LocalSimulation || Network.IsOwner;

public void OnCollisionStart( Collision collision )
{
    if ( !ShouldSimulate ) return;   // gate collisions too, not just OnUpdate/OnFixedUpdate
    var impact = collision.Contact.Speed.Length;
    // … apply crash damage
}
```
(sbox-vehicle-kit: Libraries/Vehicles.Maintenance/Code/Components/VehicleBase.Damage.cs:87-94). Gating crash damage on `Network.IsOwner` alone once broke the entire crash→repair loop in solo play.

### 7. Defer heavy init out of `OnStart` behind a readiness gate

`OnStart` runs before `Screen.Width/Height` and peers settle (you get the placeholder `1024x1024`). Set a flag and do the real work in `OnUpdate`, deferring while not ready, wrapped in try/catch that surfaces a UI error instead of throwing:

```csharp
protected override void OnStart() => _initCoreOnUpdate = true;

protected override void OnUpdate()
{
    if ( !StartCoreWhenReady() ) return;
    // … per-frame work once ready
}

private bool StartCoreWhenReady()
{
    if ( _initCoreOnUpdate )
    {
        if ( ShouldDeferInitialCore() ) return false;  // screen still placeholder → wait more frames
        _initCoreOnUpdate = false;
        InitCore();
    }
    return IsReady;
}
```
(sgba: Code/EmulatorComponent.cs:252)

### 8. Teardown discipline — cancel async, then unsubscribe, then clear

C# `Action` event subscribers survive content/hotload reloads and double-fire or leak. The reusable order is **cancel async first → unsubscribe delegates → clear state → fire unload events**:

```csharp
public void UnloadScript()
{
    CancelPlaybackOperation();                                   // 1. cancel running async loop

    if ( ActiveScript.OnChoiceSelected is not null )             // 2. detach every subscriber
        foreach ( var d in ActiveScript.OnChoiceSelected.GetInvocationList() )
            ActiveScript.OnChoiceSelected -= (Action<Script.Choice>)d;

    State.Clear();                                               // 3. clear / stop owned resources
    ActiveScript.OnUnload();                                     // 4. fire unload events
    OnScriptUnload?.Invoke( ActiveScript );
}
```
(SBox-Visual-Novel-Base: Libraries/VNBase/Code/Systems/Player/ScriptPlayer.cs:186-229). Mirror this in `OnDestroy`: null any static `Instance`, `-=` static-event subscribers, cancel a CTS for owned loops.

### 9. Partition a large pawn by concern

A pawn balloons into a thousand-line monster. Keep one file per concern with a central tick calling named helpers. **Modern (Scene) — preferred:** make each concern its own `Component` composed onto the pawn `GameObject` (composable, independently toggleable, testable). **Legacy (`Sandbox.Game`):** partial-class files (`Player.AFK.cs`, `Player.Roles.cs`, …) with a central `Simulate` calling `TickAFKSystem()`, `TickEntityHints()`, etc. (ttt-reborn: code/player/Player.cs:177 — *legacy `Simulate(Client)`/`IsClient`, shown for the per-feature-tick idea only; do NOT copy the `Client`/`Pawn` API*). Keep the named-per-feature-tick structure regardless of API.

## Gotcha table

| Gotcha | Fix |
|---|---|
| One-frame flicker at origin on spawn | Park off-screen in `OnAwake` + `Network.ClearInterpolation()`; clear after EVERY hard teleport |
| Renderer-enable flicker | Create `RenderType = ShadowsOnly/Off`, reveal after `await GameTask.DelayRealtime(1)` |
| Fast projectile visual lags true position | `Network.Interpolation = false` on the object |
| `Network.IsOwner` is false in solo playtest → system silently dead | Gate on `LocalSimulation \|\| Network.IsOwner`; expose `LocalSimulation` as a `[Property]` |
| `Components.Get<T>()` returns null for child/parent components | Use `GetInAncestors(OrSelf)` / `FindMode.EnabledInSelfAndDescendants` / `EverythingInSelfAndDescendants` |
| Stats/identity lost when pawn destroyed on death | Hold them on a separate `NetworkSpawn`'d `PlayerData` component, link via `[Sync(SyncFlags.FromHost)]` |
| Transient objects leak across rounds | Tag + tracked-list double cleanup; set `GameObjectFlags.NotSaved` |
| `OnStart` reads give placeholder `Screen` size (1024x1024) | Defer real init into `OnUpdate` behind a readiness gate; try/catch → UI error |
| `Action` subscribers double-fire / leak across hotload | Walk `GetInvocationList()` and `-=` each in teardown/`OnDestroy` |
| Singleton `Component` is deletable/duplicable, needs a prefab slot | Use `GameObjectSystem<T>` (per-scene singleton, `T.Current`, survives hotload) |
| Cross-system tick ordering nondeterministic | `Listen(stage, priority, …)` — the priority arg orders systems |
| In-flight async touches half-torn-down state | Teardown order: cancel async → unsubscribe → clear → unload events |
| `Clone()`/`new GameObject` not replicating | `NetworkSpawn` is required; configure (`CloneConfig.StartEnabled=false`) BEFORE, set `OwnerTransfer.Fixed` AFTER, spawn on one machine only |
| Movement jitter | Move/integrate physics in `OnFixedUpdate`, not `OnUpdate` |

## Verify live

SDK API drifts between builds — confirm against the installed SDK before writing: `describe_type` / `search_types` / `get_method_signature` on `Component`, `GameObject`, `GameObjectSystem`, `FindMode`, `GameObjectFlags`, `CloneConfig`, `OwnerTransfer`, `Stage`. Reflection is the source of truth, not memory.

Cross-links: networking/`[Sync]`/`[Rpc.*]`/`NetworkSpawn` authority rules live in the **sbox-api** reference; the screenshot-driven build loop and bridge gotchas live in the **sbox-build-feature** skill.

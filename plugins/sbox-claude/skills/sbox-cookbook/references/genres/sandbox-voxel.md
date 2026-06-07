# Sandbox / Construction Recipe

How to build a sandbox-construction game (Garry's-Mod-style: spawn anything, build with tools, optional round/PvP layer) in modern s&box (GameObject/Component/Scene), distilled from the mined game `apl.sandboxwars` (Sandbox Wars) — a polished, fully hand-coded GMod-style sandbox on the modern API. (The genre's sibling `facepunch.ss1` is a 2D bullet-heaven and is covered by the survivors-like recipe; its stat-modifier engine cross-links below.)

## What defines the genre

A sandbox-construction game is a **player-authored, persistent, networked world** with no win condition by default — the player is handed a toolbox + a spawn menu and builds whatever they want, while the game enforces fairness (limits, ownership) and lets the host reset state. The hard part is **not** any one feature; it is keeping a dozen cross-cutting systems (spawning, limits, undo, ownership, cleanup, inventory) decoupled so each can be added or removed independently. Sandbox Wars solves this with `GameObjectSystem<T>` singletons that talk through **scene-wide interface events**, never direct references (`apl.sandboxwars: Code/GameLoop/LimitsSystem.cs:8`).

**Core loop:** `pick a spawnable → place it (trace from eyes, ghost preview) → fire ISpawnEvents → systems react (limit-check / undo-register / ownership-tag) → manipulate with tools → undo or cleanup`. An optional round layer (build phase → battle phase) turns the sandbox into a minigame on top of the same primitives.

## The system stack to compose

Build each as an independent `GameObjectSystem<T>` singleton or per-actor `Component`. The producer (the spawn pipeline) knows none of the consumers — it just fires events.

| System | Role | Reference |
|---|---|---|
| **ISpawner strategy + dispatch** | One interface for "anything placeable"; async-loaded; string-ident factory | below + `references/systems/spawning-waves.md` |
| **Scene-wide interface events** | Decoupling backbone: `ISpawnEvents`, `IToolActionEvents`, `ICleanupEvents` | below |
| **Per-player limit / quota** | Cap props/tools per player; veto via `e.Cancelled` | `references/systems/anti-cheat.md` |
| **Per-player undo stack** | Pop+destroy last spawn group; owner-only notice | below |
| **Ownership / prop protection** | Tag spawns with owner; gate physgun/tool/delete | `references/systems/anti-cheat.md` |
| **Baseline-snapshot cleanup** | Capture map at load; restore to it, keep players | `references/systems/save-persistence.md` |
| **Slot-based networked inventory** | Weapons/tools as child GameObjects; loadout JSON | `references/systems/inventory.md` |
| **Host-authoritative shared pool** | Ammo/resource pool, optimistic client + host clamp | `references/systems/economy-currency.md` |
| **Trigger/collision pickup base** | Abstract host-only pickup; subclass per item | `references/systems/inventory.md` |
| **ConVar GameSettings config** | Every tunable as a replicated, UI-rendered ConVar | below |
| **Round/phase state machine** (opt) | ModeSelect → Build → Battle; chat-vote skip | `references/systems/round-match.md` |
| **Persistent ban / connection gate** (opt) | Refuse banned SteamIds at handshake | `references/systems/anti-cheat.md` |

## The one idiom that makes it composable: scene-wide interface events

Every cross-cutting concern is a `GameObjectSystem<T>` that *implements an event interface*. The spawn pipeline fires the event once; any number of systems react without the producer importing them. A **mutable payload** (`e.Cancelled`) lets a listener veto.

```csharp
// Producer: the spawn pipeline fires one event — knows nothing about who listens.
var ev = new SpawnEventData { Player = player, GameObjects = spawned };
Scene.RunEvent<ISpawnEvents>( x => x.OnSpawn( ev ) );   // pre-spawn: listeners may veto
if ( ev.Cancelled ) { /* roll back */ return; }
Scene.RunEvent<ISpawnEvents>( x => x.OnPostSpawn( ev ) ); // post-spawn: track for limits/undo
```

```csharp
// Consumer: a self-contained system. LimitsSystem and UndoSystem both hook
// ISpawnEvents with zero references to each other or to GameManager.
public sealed class LimitsSystem : GameObjectSystem<LimitsSystem>, ISpawnEvents, IToolActionEvents
{
    void ISpawnEvents.OnSpawn( SpawnEventData e )
    {
        if ( CountFor( e.Player ) >= MaxPropsPerPlayer && MaxPropsPerPlayer >= 0 )
            e.Cancelled = true;   // veto before anything is created
    }
}
```
(`apl.sandboxwars: Code/GameLoop/LimitsSystem.cs:8`; producer fires the same event consumed by both limits and undo registration — `Code/GameLoop/GameManager.Spawn.cs:110`.) `GameObjectSystem<T>` is auto-discovered and exposed as `Scene.GetSystem<T>()` — no manual wiring.

## ISpawner: one interface for everything placeable

Abstract every spawnable (prop, cloud package, workshop duplicator, entity) behind one interface exposing **`Task<bool> Loading`** + **`bool IsReady`**, so the pipeline can `await spawner.Loading` uniformly regardless of source.

```csharp
public interface ISpawner
{
    string DisplayName { get; }
    BBox Bounds { get; }                       // to offset placement onto the surface
    bool IsReady { get; }
    Task<bool> Loading { get; }                 // await this — local prop or cloud pkg, same call
    void DrawPreview( Transform tx, Material ghost );
    Task<List<GameObject>> Spawn( Transform tx, Player player );  // runs on host; returns roots
}
```
(`apl.sandboxwars: Code/Spawner/ISpawner.cs:5`.) A string-ident `switch` is the single factory — `"prop:path"`, `"dupe.workshop:id"`, etc. — parsed into the right strategy, then dispatched over the network:

```csharp
[Rpc.Broadcast]
public async void Spawn( string ident, ... )
{
    ISpawner spawner = ident.Split(':')[0] switch
    {
        "prop"  => new PropSpawner( ident ),
        "dupe"  => new DuplicatorSpawner( ident ),
        _       => new EntitySpawner( ident ),
    };
    if ( !Networking.IsHost ) { /* clients only bump a stat + play a sound */ return; }
    var tr = Scene.Trace.Ray( player.AimRay, 4096 ).Run();   // place where the player looks
    if ( !await spawner.Loading ) return;                    // async cloud/workshop load can fail → null
    var roots = await spawner.Spawn( tr.HitPosition.WithTransform(), player );
    player.Undo.Create().Add( roots );                       // register for undo
}
```
(strategy + async readiness — `Code/Spawner/ISpawner.cs:5`, `Code/Spawner/DuplicatorSpawner.cs:55`; dispatch — `Code/GameLoop/GameManager.Spawn.cs:13`.) **Gotcha:** `Spawn()` is `[Rpc.Broadcast]` but the real spawn early-returns on non-host — the host/proxy split is implicit, easy to miss. Cloud/dupe installs are async and can fail silently (return null), so guard every `await`.

## Per-player undo stack

A `GameObjectSystem` keeps `Dictionary<long, Stack<Entry>>` keyed by SteamId. After each spawn the caller opens an entry, names it, and adds the spawned roots; undo pops + destroys, recursing past empty entries (objects already gone).

```csharp
public sealed class UndoSystem : GameObjectSystem<UndoSystem>
{
    readonly Dictionary<long, Stack<Entry>> _stacks = new();

    public Entry Create( Player p ) { var e = new Entry(); Stack(p).Push(e); return e; }

    public void Undo( Player p )
    {
        var s = Stack( p );
        while ( s.Count > 0 )
        {
            var e = s.Pop();
            if ( e.Run() ) break;   // destroyed something → done; else recurse to next entry
        }
        // notice only to the owning client:
        using ( Rpc.FilterInclude( p.Network.Owner ) ) ShowUndoToast();
    }
}
```
(`apl.sandboxwars: Code/Player/UndoSystem/UndoSystem.cs:3`, `Entry.Run at :134`.) **Gotchas:** stores hard `GameObject` refs (not Guids) → every use must `IsValid()`-check. A global `Remove(go)` yanks an object from *every* stack (e.g. a weapon picked back up can't be undone out of your hands). No redo.

## Ownership / prop protection

Tag each spawn with its owner. `Connection` can't be `[Sync]`'d directly, so store the connection **Guid** and resolve lazily.

```csharp
public sealed class Ownable : Component, IPhysgunEvent, IToolgunEvent
{
    [Sync( SyncFlags.FromHost )] Guid _ownerId { get; set; }
    public Connection Owner
    {
        get => Connection.All.FirstOrDefault( c => c.Id == _ownerId );  // resolve each get
        set => _ownerId = value?.Id ?? Guid.Empty;
    }

    [ConVar( "sb.ownership_checks", ConVarFlags.Replicated | ConVarFlags.Server | ConVarFlags.GameSetting )]
    public static bool OwnershipChecks { get; set; } = false;

    public static bool HasAccess( Connection caller, Connection owner )
    {
        if ( !OwnershipChecks ) return true;
        if ( caller?.HasPermission( "admin" ) == true ) return true;  // admins + unowned always pass
        if ( owner is null ) return true;
        return owner == caller;
    }

    void IPhysgunEvent.OnPhysgunGrab( IPhysgunEvent.GrabEvent e )
    {
        if ( !HasAccess( e.Grabber, Owner ) ) e.Cancelled = true;     // veto the grab
    }
}
```
(`apl.sandboxwars: Code/Components/Ownable.cs:7`, `HasAccess at :40`.) An extension `GameObject.HasAccess(caller)` makes the check ergonomic at every delete/gib call site. **Gotcha:** resolving `Connection.All.FirstOrDefault` per-get is slightly costly in hot loops; the Guid outlives a disconnect and resolves to null.

## Host-authoritative shared pool (ammo / resources)

Optimistic client + host-authoritative clamp: a client mutation forwards to `[Rpc.Host]` and returns a *predicted* value immediately; the host re-clamps against the authoritative max.

```csharp
[Sync( SyncFlags.FromHost )] public NetDictionary<string, int> Pool { get; set; } = new();

public int AddAmmo( AmmoResource res, int count )
{
    if ( !Networking.IsHost ) { AddAmmoRpc( res, count ); return count; }   // optimistic on client
    var current = GetAmmo( res );
    var toAdd = Math.Min( count, res.MaxReserve - current );                // host clamps to max
    if ( toAdd <= 0 ) return 0;
    Pool[res.ResourcePath] = current + toAdd;
    return toAdd;
}
```
(`apl.sandboxwars: Code/Game/Weapon/AmmoInventory.cs:5`, `AddAmmo at :37`.) Keys are string resource paths so multiple weapons of one caliber share a pool (and renaming the `.ammo` asset orphans saved pools). **Note:** this is host C# context — it uses `System.Math.Clamp`, which is fine; inside the *gameplay sandbox* prefer `MathX.Clamp` (`System.MathF`/`System.Math` are unavailable there). **Gotcha:** the client path is optimistic — `TakeAmmo` reports success before the host confirms, so a desync can briefly let a client "have" ammo it doesn't.

## Baseline-snapshot cleanup

Capture the map once at load (every non-player root's Guid + serialized JSON). Cleanup destroys anything *not* in the baseline (spawned props) and deserializes back any baseline object that was destroyed — players untouched.

```csharp
public sealed class CleanupSystem : GameObjectSystem<CleanupSystem>, ISceneLoadingEvents
{
    Dictionary<Guid, string> _baseline = new();   // guid → serialized JSON

    void ISceneLoadingEvents.AfterLoad( Scene s )  // capture once
    {
        foreach ( var go in s.Children )
            if ( !IsPlayerObject( go ) ) _baseline[go.Id] = go.Serialize().ToJsonString();
    }

    public void Cleanup()
    {
        foreach ( var go in Scene.Children.ToList() )
            if ( !IsPlayerObject( go ) && !_baseline.ContainsKey( go.Id ) )
                go.Destroy();                       // it was spawned → remove
        // (re-deserialize any missing baseline objects from their stored JSON)
    }
}
```
(`apl.sandboxwars: Code/Cleanup/CleanupSystem.cs:14`, `CaptureBaseline at :86`, `Cleanup at :156`.) **Gotchas:** `IsPlayerObject` walks the parent chain so player-owned children survive; restore relies on `GameObject.Serialize`/`Deserialize` round-tripping. Across a save/load the baseline is preserved in static fields, not recaptured.

## ConVar GameSettings as the whole config surface

Don't write bespoke settings plumbing. A `static` property decorated `[ConVar(..., Replicated | Server | GameSetting)]` with `[Range]`/`[Title]`/`[Group]` is simultaneously console-settable, network-replicated, persisted, *and* auto-rendered in the server-settings UI.

```csharp
[Range( -1, 1024 )]
[Title( "Max Props Per Player" ), Group( "Limits" )]
[ConVar( "sb.limit.props", ConVarFlags.Replicated | ConVarFlags.Server | ConVarFlags.GameSetting,
    Help = "Maximum props per player. -1 = unlimited, 0 = none allowed." )]
public static int MaxPropsPerPlayer { get; set; } = -1;
```
(`apl.sandboxwars: Code/GameLoop/LimitsSystem.cs:10`; same idiom for `sb.ownership_checks` at `Code/Components/Ownable.cs:35`.) Convention: `-1 = unlimited`, `0 = none`, encoded as `IsExceeded(limit, count) => limit >= 0 && count >= limit`.

## Optional round layer: phase state machine + chat-vote

To turn the open sandbox into a minigame, drive a networked `GamePhase` (ModeSelect → Build → Battle) with the host-only timer; clients react to the `[Sync]` phase to toggle `buildzone`-tagged objects and swap music.

```csharp
[Sync] public GamePhase Phase { get; set; }
[Sync] public float TimeRemaining { get; set; }

protected override void OnUpdate()
{
    if ( !Networking.IsHost ) return;            // host owns the clock
    if ( _phaseTimer > PhaseDuration( Phase ) ) SwitchPhase( Next( Phase ) );
}

void SwitchPhase( GamePhase next )               // entry/exit effects
{
    if ( next == GamePhase.Battle ) { ForcePlayersOffBuildTools(); HealAll(); SpawnFlags(); }
    Scene.GetSystem<CleanupSystem>().Cleanup();
    Phase = next; _voters.Clear();
}
```
(`apl.sandboxwars: Code/MiniGameManager.cs:14`, `SwitchPhase at :460`, `OnUpdate at :546`.) Chat-vote skipping uses `[ConCmd(..., ConVarFlags.Server)]` taking a `Connection` source, dedups voters in a `HashSet<ulong>` of SteamIds, and switches phase at `totalPlayers/2 + 1` (`VoteSkip at :143`). **Gotcha:** there are two paths to the same logic (a `ConCmd(Server)` *and* a parallel `[Rpc.Host]` for UI buttons) — keep them in sync. See `references/systems/round-match.md`.

## Build order

1. **Networking spine first.** A host-authoritative `GameManager` (`Networking.IsHost` guards everywhere, `[Sync(FromHost)]` for replicated state). Spawn a player via `NetworkHelper` — see `references/systems/...` and the sbox-build-feature spawn recipe. Slice the manager into partial files (`GameManager.cs` / `.Spawn.cs` / `.Cleanup.cs`) so features stay isolated.
2. **The event backbone.** Define `ISpawnEvents` / `IToolActionEvents` / `ICleanupEvents` and the mutable payload type with `e.Cancelled`. Nothing else works cleanly without this.
3. **ISpawner + the spawn pipeline.** One `PropSpawner` first; trace from eyes, ghost-preview, `await Loading`, fire `OnSpawn`/`OnPostSpawn`.
4. **Limits + undo as event consumers.** Prove decoupling: both hook `ISpawnEvents` with no reference to the pipeline. Add the `[ConVar GameSetting]` limits here.
5. **Ownership + cleanup.** `Ownable` veto on physgun/tool events; `CleanupSystem` baseline capture/restore.
6. **Inventory + pickups + shared pool.** Slot-based child-GameObject inventory, abstract `BasePickup`, the optimistic ammo pool.
7. **(Optional) round layer / ban system on top** — none of the base sandbox depends on these.

## How the real game does it (cite map)

- **Decoupled systems via interface events** — the architectural keystone: `Code/GameLoop/LimitsSystem.cs:121`, `Code/GameLoop/GameManager.Spawn.cs:110`.
- **ISpawner strategy + async readiness** — `Code/Spawner/ISpawner.cs:5`, `Code/Spawner/DuplicatorSpawner.cs:55`.
- **Optimistic client + host clamp** — `Code/Game/Weapon/AmmoInventory.cs:37`.
- **ConVar GameSettings config surface** — `Code/GameLoop/LimitsSystem.cs:10`, `Code/Components/Ownable.cs:34`.
- **Partial-class feature slicing** — `Code/GameLoop/GameManager.cs:4`, `GameManager.Achievements.cs:1`.
- **Undo / ownership / cleanup / inventory / pickups / NPC schedule / ban** — see the table above for per-file refs.

For a **2D / sprite** sandbox variant (bullet-heaven), the survivors-like recipe covers the grid-bucket collision and the per-source stat-modifier engine from `facepunch.ss1` (`ss1/Code/things/Player.cs:953`) — lift that engine wholesale for any tool/perk buff stacking.

---

**Verify live:** API names drift between SDK builds. Confirm the exact members before coding — `describe_type GameObjectSystem` / `search_types Spawner` / `describe_type ConVarAttribute` / `describe_type NetDictionary` against the *installed* SDK (reflection is authoritative, not this doc or training data). Check `[Rpc.Host]`/`[Rpc.Broadcast]`/`[Sync(SyncFlags.FromHost)]` signatures with `describe_type` before relying on them.

**Cross-links:** use **sbox-api** to resolve any unfamiliar type via reflection, and **sbox-build-feature** for the screenshot-driven build/verify loop and the player-spawn recipe that this stack assumes.

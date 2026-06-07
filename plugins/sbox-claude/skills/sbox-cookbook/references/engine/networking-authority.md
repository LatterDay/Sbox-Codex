# Networking & Authority

Host-authoritative multiplayer in modern s&box: who simulates, who writes, and how clients request changes without trusting each other. Read this before touching `[Sync]`, `[Rpc.*]`, ownership, or the lobby lifecycle.

## Mental model

Every machine runs the same C#. Three roles decide who is allowed to *act*:

- **Owner** simulates its own object (input, movement, prediction). Gate with `!IsProxy`.
- **Host** is authoritative for shared/global state (money, score, roster, spawns). Gate with `Networking.IsHost`.
- **Proxies** only render — they interpolate replicated state and run cosmetic effects. A proxy that mutates synced state is silently rolled back.

The single most-repeated convention: at the top of a networked component's `OnUpdate`/`OnFixedUpdate`, `if ( IsProxy ) return;` before reading `Input` or running movement/AI/shooting (sbox-scenestaging: `Code/ExampleComponents/Gun.cs:7`). The owner is authoritative for *its own* object; the host is authoritative for *everyone's* shared state. Clients never write authoritative state directly — they receive it via `[Sync(SyncFlags.FromHost)]` and request changes through `[Rpc.Host]`.

> `Network.IsOwner` is null/false in a solo editor playtest (no lobby → no owner), so an `IsOwner`-only guard silently disables whole systems until real multiplayer starts. Prefer `!IsProxy`, or pair with a `LocalSimulation` `[Property]`: `ShouldSimulate => LocalSimulation || Network.IsOwner`.

---

## Patterns

### 1. Gate input & simulation on `!IsProxy` (owner-authoritative)

```csharp
protected override void OnUpdate()
{
    if ( IsProxy ) return;                 // proxies only render replicated state
    var look = Components.GetInAncestors<PlayerController>().EyeAngles.ToRotation();
    if ( Input.Pressed( "Attack1" ) ) Fire( look.Forward );
}
```

Owner-authoritative state is plain `[Sync]` and only mutated when `!IsProxy` — e.g. `[Sync] public Angles EyeAngles`, `[Sync] public bool IsRunning`, written only inside the `!IsProxy` branch (sbox-scenestaging: `Code/ExampleComponents/PlayerController.cs:17,27,42`). Pair effect bodies with `if ( Application.IsDedicatedServer ) return;` so a headless server skips particles/sounds.

### 2. Host-authoritative writes: guard every mutator with `Networking.IsHost`

```csharp
[Sync( SyncFlags.FromHost )] public float SalaryMultiplier { get; set; } = 1f;

public void SetMultiplier( float v )
{
    Assert.True( Networking.IsHost, "SetMultiplier is host-only" ); // loud in dev
    if ( !Networking.IsHost ) return;                              // bail in release
    SalaryMultiplier = v;
}
```

Authoritative, cheat-sensitive fields are `[Sync(SyncFlags.FromHost)]` so only the host may author them (dxrp: `game/code/GameManager.cs:21`). A host-only broadcast can also self-assert with `Networking.IsHost` before counting (sbox-scenestaging: `Code/ExampleComponents/SnapshotTest.cs:13`).

### 3. The host-wrapper idiom (one authoritative writer, callable from anywhere)

Make the public mutator network-transparent: if not the host, forward through a private `[Rpc.Host]` that re-calls the public method on the host. The mutation body only ever executes host-side.

```csharp
public void SwitchWeapon( BaseCarryable weapon, bool allowHolster = false )
{
    if ( !Networking.IsHost ) { HostSwitchWeapon( weapon, allowHolster ); return; }
    // ... real mutation runs only on the host ...
    ActiveWeapon = weapon;
}

[Rpc.Host]
private void HostSwitchWeapon( BaseCarryable weapon, bool allowHolster = false )
    => SwitchWeapon( weapon, allowHolster );
```

Verbatim shape from the base game (sandbox: `Code/Player/PlayerInventory.cs:530`). `ActiveWeapon` itself is `[Sync(SyncFlags.FromHost)]` so clients can't author it directly.

### 4. NEVER trust the client — re-validate inside every `[Rpc.Host]`

A malicious client can invoke any `[Rpc.Host]` directly with forged args. `NetFlags` restrict who may *invoke*, which is **not** security. Inside the host body: validate the caller, re-check authority, clamp inputs, and rate-limit.

```csharp
[Rpc.Host]
private void RequestOwnershipHost( GameObject go )
{
    var caller = Rpc.Caller;                // trusted server-side identity
    var callerId = Rpc.CallerId;

    // rate-limit, keyed by caller, so spamming the RPC can't bypass limits
    if ( !go.IsValid() ||
         Cooldown.Current.CheckAndStartCooldown( $"{callerId}:ownership:take", cost ) )
        return;

    if ( !GameUtils.HasPermission( caller, go ) ) return; // re-check authority server-side
    // ... mutate ...
}
```

From dxrp (`game/code/GameManager.cs:212`). The base sandbox-plus-plus equivalent re-checks `if ( !c.GameObject.HasAccess( Rpc.Caller ) ) return;` before a reflection setter (sandbox-plus-plus: `Code/GameLoop/GameManager.cs:235`). `HasAccess` = admin bypass / unowned-is-public / owner==caller via an `Ownable` component.

### 5. Pick the right replication attribute

| Field kind | Attribute | Why |
| --- | --- | --- |
| Owner-predicted (`EyeAngles`, `IsRunning`, `IsNoclipping`) | `[Sync]` | owner-writable, owner→everyone |
| Authoritative / cheat-sensitive (money, score, `SteamId`, team) | `[Sync(SyncFlags.FromHost)]` | only the host may author |
| Derived (`FuelPct`, `CanStartEngine`) | *plain computed property, no `[Sync]`* | recompute from synced primitives on every client — fewer bytes, no desync |

Plain `[Sync]` on money/health/score is a classic exploit — the client can author the value. Use `FromHost` for anything authoritative (dxrp: `game/code/GameManager.cs:21`; sandbox: `Code/Player/PlayerInventory.cs:15`).

### 6. React with `[Change]`, don't poll

```csharp
[Sync( SyncFlags.FromHost ), Change] public BaseCarryable ActiveWeapon { get; private set; }

// Convention: On<PropertyName>Changed( old, @new ) — fires on every client when it changes
void OnActiveWeaponChanged( BaseCarryable oldW, BaseCarryable newW )
{
    if ( oldW.IsValid() ) oldW.GameObject.Enabled = false;
    if ( newW.IsValid() ) newW.GameObject.Enabled = true;
}
```

Drive client visuals/audio off replicated state instead of diffing in `OnUpdate` (sandbox: `Code/Player/PlayerInventory.cs:15`). Late-joining proxies rebuild visual state in `OnStart` by reading synced flags.

### 7. Separate authority from presentation (compute on host, broadcast effects)

Damage/ammo/death/score are computed host-side; cosmetic results fan out with `[Rpc.Broadcast]`.

```csharp
[Rpc.Broadcast( NetFlags.HostOnly )]                 // only the host may originate
public void NotifyDeath( string victim, string killer ) { /* kill-feed UI everywhere */ }

[Rpc.Broadcast( NetFlags.Unreliable )]               // high-frequency cosmetic only
public void ShootEffects() { if ( Application.IsDedicatedServer ) return; /* sfx */ }
```

`NetFlags.HostOnly` marks a broadcast only the host may send (sbox-scenestaging: `Code/ExampleComponents/SnapshotTest.cs:19`). State-critical broadcasts (death, spawn) keep `NetFlags.Reliable`; high-frequency cosmetic-only calls use `Unreliable`/`UnreliableNoDelay`. A common beginner failure is running gameplay inside a broadcast, or running effects only on the shooter.

### 8. Choose the RPC target deliberately

- `[Rpc.Broadcast]` — effects/sounds/chat/anims everyone should see.
- `[Rpc.Owner]` — a command only the owning client should run (`Kill`, `Kick`, `Refuel`), or push owner-targeted reliable state with `[Rpc.Owner(NetFlags.HostOnly | NetFlags.Reliable)]`.
- `[Rpc.Host]` — a client→host request. Add `NetFlags.OwnerOnly` so only an object's owner may request its own action:

```csharp
[Rpc.Host( NetFlags.OwnerOnly | NetFlags.Reliable )]
private void RequestRespawn() { /* host validates, then respawns this owner */ }
```

Funnel each kind of mutation through exactly one authority.

### 9. Unicast / exclude with `Rpc.FilterInclude` / `Rpc.FilterExclude`

Scope a broadcast server-side instead of sending to everyone and filtering on the client (which leaks data and wastes bandwidth).

```csharp
using ( Rpc.FilterInclude( c => c.Id == player.ConnectionId ) )
    PromptPlayerConsent();                                   // unicast to one player

using ( Rpc.FilterExclude( Owner.GameObject.Network.Owner ) )
    PlayWorldSound();                                        // everyone except the local shooter
```

The include form is verbatim from dxrp (`game/code/GameNetworkManager.cs:387`); the wrapped RPC is typically `[Rpc.Broadcast(NetFlags.HostOnly | NetFlags.Reliable)]`. Filter-exclude on the shooter is the reusable first-person audio idiom (simple-weapon-base: `code/swb_base/Weapon.cs:391`).

### 10. Spawn networked objects: configure → `NetworkSpawn`

`Clone()` alone makes a **local-only** object. Configure it FIRST, then call `NetworkSpawn` — passing a `Connection` assigns ownership (the owner is who simulates it).

```csharp
var o = ObjectToSpawn.Clone( pos );
o.Components.Get<Rigidbody>().Velocity = dir * 500f;  // configure BEFORE spawning
o.NetworkSpawn();                                     // or NetworkSpawn( connection ) to assign owner
```

From sbox-scenestaging (`Code/ExampleComponents/Gun.cs:20`). Spawn on exactly one machine — that `Gun` already sits behind `if ( IsProxy ) return;`, so only the owner clones. Forgetting `NetworkSpawn`, or calling it before configuring, or spawning on every client (→ N duplicates) are the three classic bugs. After spawning props that must survive their owner leaving, set the knobs in pattern 12.

### 11. Lobby + connection lifecycle via `INetworkListener`

Implement `Component.INetworkListener` on a manager. Create the lobby if none exists so a solo playtest auto-hosts; spawn host-side in `OnActive`.

```csharp
public sealed class GameNetworkManager : Component, Component.INetworkListener
{
    [Property] public GameObject PlayerPrefab { get; set; }

    protected override void OnStart()                         // auto-host for solo playtest
    {
        if ( !Networking.IsActive ) Networking.CreateLobby( new LobbyConfig() );
    }

    public void OnActive( Connection channel )                // host-side, per join
    {
        var clothing = new ClothingContainer();
        clothing.Deserialize( channel.GetUserData( "avatar" ) );
        var player = PlayerPrefab.Clone( SpawnPoint.WorldTransform );
        if ( player.Components.TryGet<SkinnedModelRenderer>( out var body,
                FindMode.EverythingInSelfAndDescendants ) )
            clothing.Apply( body );
        player.NetworkSpawn( channel );                       // assign ownership to the joiner
    }
}
```

`OnActive` is verbatim from sbox-scenestaging (`Code/ExampleComponents/GameNetworkManager.cs:8`). Set `channel.CanSpawnObjects = false` so clients can't spawn networked objects directly; `OnDisconnected` finds the player by `Network.Owner == connection` and cleans up; lobby metadata syncs via `Networking.SetData`/`GetData`.

### 12. Production lifecycle: validate-before-spawn, reuse-on-reconnect, reap orphans

Reject in `AcceptConnection` BEFORE the player exists, and `await`-validate before `NetworkSpawn` so a banned player never flashes into the world.

```csharp
public bool AcceptConnection( Connection channel, ref string reason )
{
    if ( !Config.Current.Game.AllowFamilySharePlayers && channel.OwnerSteamId != channel.SteamId )
    { reason = "Family shared accounts are not permitted."; return false; }
    return true;
}
```

From dxrp (`game/code/GameNetworkManager.cs:62`). On reconnect, find the disconnected player object and `AssignOwnership(channel)` (reusing equipment) instead of respawning (`:276`). Run a ~1 Hz pass that kicks connections that never got a player (`:141`). Naive "spawn first, validate later" leaks half-init connections and loses state on rejoin.

After spawning persistent objects:

```csharp
go.Network.SetOwnerTransfer( OwnerTransfer.Fixed );          // pin ownership
go.Network.SetOrphanedMode( NetworkOrphaned.Host );          // host takes over on owner disconnect
```

Without `OrphanedMode.Host`, props vanish when their owner leaves (sbox-grubs: `Code/Systems/Network/GrubsNetworkManager.cs:27`).

### 13. Non-replicable types: sync a `Guid`, resolve it

`Connection` and `GameObject` are local handles, NOT network-serializable. Sync the stable `Guid` and resolve.

```csharp
[Sync( SyncFlags.FromHost )] private Guid _ownerId { get; set; }

public Connection Owner
{
    get => Connection.All.FirstOrDefault( c => c.Id == _ownerId );
    set => _ownerId = value?.Id ?? Guid.Empty;
}
```

Verbatim from sandbox-plus-plus (`Code/Components/Ownable.cs:8`). For object refs, `[Sync] Guid OccupantId` + resolve via `Scene.Directory.FindByGuid( occupantId )`. The client whose input drives a shared object must OWN it — `vehicle.Network.AssignOwnership( occupant.Network.Owner )` on enter — and clear the driver gate in `OnDestroy` so input doesn't get stuck.

### 14. `Network.Refresh()` after out-of-band host mutations

Properties set via reflection (`TypeLibrary…SetValue`) or any non-`[Sync]` path won't auto-replicate. Force a re-snapshot:

```csharp
prop.SetValue( c, value );
// c.GameObject.Network.Refresh( c );   // per-component overload is unreliable, in-repo "doesn't work??"
c.GameObject.Network?.Refresh();         // whole-object refresh — use this
```

The base game's own comment flags the per-component overload as broken (sandbox-plus-plus: `Code/GameLoop/GameManager.cs:243`). Use the whole-object refresh. Also call `Network.ClearInterpolation()` after any hard teleport (not just spawn) to avoid one-frame origin ghosts.

### 15. Host-loss failover: heartbeat + `RealTimeSince` timeout

s&box doesn't always cleanly notify clients when a host vanishes, so relying only on `Connection` events leaves clients frozen.

```csharp
[Rpc.Broadcast( NetFlags.UnreliableNoDelay )]
private void RpcHostHeartbeat() => _timeSinceHostHeartbeat = 0;   // client resets on receipt

protected override void OnUpdate()
{
    if ( !Connection.Host.IsValid() || _timeSinceHostHeartbeat > 45f )
        LeaveOrResumeSolo();                                       // don't hang
}
```

Pattern from sgba (`Code/Networking/NetworkManager.cs:221`). Cheap, robust liveness every networked game should copy.

### 16. Send intent, not state (sparse discrete events)

For death/round-result/role-reveal style events, don't replicate a stateful networked entity per event — serialize the event to JSON/bytes, send through ONE RPC, deserialize back into the same typed event on the client and call `Run()` locally (the host keeps the canonical accumulation; client replay is presentation only). Far cheaper than per-field sync churn (concept verified in ttt-reborn `code/gameevents/base/NetworkableGameEvent.cs:32`; its `ConCmd` transport is legacy, the intent concept is timeless). For large blobs that exceed the per-message cap: `DeflateStream`-compress and write both raw + compressed length so the receiver pre-sizes its buffer, route lossy data over `Unreliable` and must-arrive data over `Reliable`; or fragment into `(payloadHash, index, total, partial)` packets and reassemble by hash (sgba: `Code/Networking/LinkCablePackets.cs:203`).

---

## Gotcha table

| Gotcha | Fix |
| --- | --- |
| Mutating synced state on a proxy/client silently rolls back | Gate every mutator: `if ( IsProxy ) return;` (owner) or `if ( !Networking.IsHost ) return;` (host); add `Assert.True(Networking.IsHost,…)` in dev |
| `[Rpc.Host]` is callable by ANY client with forged args | `NetFlags` is not security — re-validate ownership/permission/limits AND rate-limit (cooldown keyed by `Rpc.CallerId`) inside the host body |
| Plain `[Sync]` on money/health/score lets a client author it | Use `[Sync(SyncFlags.FromHost)]` for anything authoritative |
| `Clone()` is local-only | `NetworkSpawn` is required to replicate; configure BEFORE spawning; spawn on exactly one machine (`!IsProxy`/`IsHost`) or get N duplicates |
| `Connection` / `GameObject` aren't `[Sync]`-able | Sync a `Guid`; resolve via `Connection.All` / `Scene.Directory.FindByGuid`; keep any object handle as a non-networked local field |
| Reflection / non-`[Sync]` writes don't replicate | Call `GameObject.Network.Refresh()` (whole-object; per-component overload is unreliable) |
| Effect/broadcast bodies run on the headless server too | Early-return `if ( Application.IsDedicatedServer ) return;` |
| High-frequency cosmetic RPCs on the Reliable channel clog it | Use `NetFlags.Unreliable`/`UnreliableNoDelay` for effects; reserve `Reliable` for spawn/death/roster |
| `Controller.Velocity` & physics fields valid only on the owner | Mirror with a guarded `[Sync]` write + a local-vs-proxy accessor when the host must read it |
| Spawn-first-validate-later flashes banned players in | Reject in `AcceptConnection`; `await`-validate before `NetworkSpawn`; reap orphaned connections on a timer |
| No reliable notice of an ungraceful host exit | Add an unreliable heartbeat + `RealTimeSince` timeout |
| Props vanish when their owner disconnects | `Network.SetOrphanedMode(NetworkOrphaned.Host)`; set `channel.CanSpawnObjects = false` to block client spawns |
| Driving client's input does nothing on a shared object | It must OWN it (`AssignOwnership`); clear the driver/occupant gate in `OnDestroy` |
| `Network.IsOwner` is null in solo editor playtests | Don't guard solely on `IsOwner`; use `!IsProxy` or `LocalSimulation || Network.IsOwner` |

---

**Verify live:** API names drift between SDK builds — confirm members before writing with `describe_type` / `search_types` / `get_method_signature` (reflection is authoritative for the installed SDK, not memory or this doc). The bridge is single-client and cannot synthesize key presses or a second connection, so replication/ownership/refresh CANNOT be proven from one editor instance — verify with `execute_csharp` plus a human/second-client playtest.

See also the **sbox-api** skill (look up exact `[Rpc.*]`/`SyncFlags`/`Network.*` signatures) and the **sbox-build-feature** skill (the screenshot-driven build loop these patterns plug into).

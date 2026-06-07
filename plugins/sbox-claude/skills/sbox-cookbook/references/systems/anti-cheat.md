# Anti-Cheat / Host Authority

Stop clients lying about state (money, ammo, score, saves). In s&box the host is the trust boundary: clients *propose*, the host *validates and writes*.

## What this IS and when you need it

"Anti-cheat" in s&box isn't a kernel driver — it's **server authority over every value a player could profit from manipulating**. You need it the moment a value is contested (multiplayer economy, ammo, score, leaderboards) or persisted across sessions (save files a user can edit on disk). For solo/casual/cosmetic state, full authority is overkill — the games below that skip it (elevator, xtrem_road) do so deliberately.

Three layers, applied as the stakes rise:
1. **Replication authority** — clients can read but not write the value (`[Sync(SyncFlags.FromHost)]`).
2. **Mutation authority** — every change runs on the host, which re-validates the caller and re-clamps the inputs (`[Rpc.Host]`).
3. **Persistence integrity** — saved data is sanitized + signed on load so an edited JSON file can't inject impossible values.

## Canonical approach

### Layer 1 — host-owned replicated state

Make the contested value `[Sync(SyncFlags.FromHost)]` with a **private setter**. Clients literally cannot assign it; they only see the host's replicated value.

```csharp
public sealed class PlayerProgression : Component
{
    [Sync( SyncFlags.FromHost )] public int Money { get; private set; }
    [Sync( SyncFlags.FromHost )] public int AxeLevel { get; private set; } = 1;
}
```
(`vault77.chop_the_forest`: Code/Player/PlayerProgression.cs:37-49) — every currency/level is `FromHost` + private-set, so all economy logic is host-authoritative by construction.

### Layer 2 — client proposes, host validates and writes

A client that must *initiate* a change cannot write the synced field. It calls a `[Rpc.Host]`. The host method does four things in order: **(a) re-check the caller, (b) bounds-check inputs, (c) clamp, (d) write**. Never trust the number that arrived.

```csharp
public void SetAmmo( AmmoResource resource, int value )
{
    if ( resource is null ) return;
    if ( !Networking.IsHost ) { SetAmmoRpc( resource, Math.Clamp( value, 0, resource.MaxReserve ) ); return; }
    Pool[resource.ResourcePath] = Math.Clamp( value, 0, resource.MaxReserve );  // host writes
}

[Rpc.Host]
private void AddAmmoRpc( AmmoResource resource, int count )
{
    var current = Pool.TryGetValue( resource.ResourcePath, out var c ) ? c : 0;
    var toAdd = Math.Min( count, resource.MaxReserve - current ); // re-clamp on the HOST
    if ( toAdd > 0 ) Pool[resource.ResourcePath] = current + toAdd;
}
```
(`apl.sandboxwars`: sandbox/Code/Game/Weapon/AmmoInventory.cs:26-31, :77-84) — the host RPC re-derives `space` and re-clamps; it never just stores the client's `count`. The `Pool` is `[Sync(SyncFlags.FromHost)] NetDictionary<string,int>` (:11).

**Re-check the caller.** A `[Rpc.Host]` can be invoked by *any* client, not just the owning one. Verify identity before acting:

```csharp
[Rpc.Host]
public void RpcRequestMissionRewardResources( string missionId, int logs, int money, int planks )
{
    if ( Networking.IsActive && Rpc.CallerId != Network.OwnerId ) return;     // (a) only the owner may claim
    var id = NormalizeMissionRewardId( missionId );
    if ( string.IsNullOrWhiteSpace( id ) ) return;
    if ( !_claimedMissionRewardIds.Add( id ) ) return;                        // idempotency: claim once

    if ( logs < 0 || money < 0 || planks < 0                                  // (b) bounds-check every field
         || logs  > Math.Max( DefaultMaxHarvestAmountPerHit, MaxHarvestAmountPerHit )
         || money > 2_000_000 || planks > 3500 )
    {
        _claimedMissionRewardIds.Remove( id );                               // roll back the claim
        FlagAsCheater( $"Unrealistic mission reward: {logs}/{money}/{planks}" );
        return;
    }
    if ( !GrantMissionRewardResources( logs, money, planks, out _ ) )
        _claimedMissionRewardIds.Remove( id );
}
```
(`vault77.chop_the_forest`: Code/Player/PlayerProgression.cs:3615-3639) — this is the full pattern: caller re-check, one-shot idempotency guard, per-field bounds, rollback on failure, and a flag for telemetry. Server-side caps (`MaxHarvestAmountPerHit`, `MaxSellAmountPerRequest`) are `[Property, Group("Anti-Cheat")]` so designers tune them (:75-81), and known dev SteamIds are whitelisted out of the checks (:2630-2635).

### Layer 2b — request → apply → confirm (optimistic clients)

When the owning client needs an instant local result but the value is host-owned, run a **triad**: client applies optimistically + calls `[Rpc.Host]` Request → host re-validates + re-clamps + applies → `[Rpc.Owner]` Confirm echoes the authoritative value back. Re-sanitize on *both* sides.

```csharp
[Rpc.Host]
public void RpcRequestMergeBackendPetLevelsData( string data )
{
    if ( Networking.IsActive && Rpc.CallerId != Network.OwnerId ) return;
    var safe = NormalizePetLevelsDataForRuntime( data );   // sanitize on host
    MergeBackendPetLevelsDataCore( safe, true );
    RpcConfirmBackendPetLevelsData( safe );                // echo back to owner
}

[Rpc.Owner]
public void RpcConfirmBackendPetLevelsData( string data )
    => MergeBackendPetLevelsDataCore( NormalizePetLevelsDataForRuntime( data ), true );  // sanitize AGAIN
```
(`vault77.chop_the_forest`: Code/Player/PlayerProgression.cs:730-745)

### Layer 3 — tamper-resistant persistence

Saves live in `FileSystem.Data` as plain JSON — a user can edit them. On **save**: clamp/normalize every field, then write a signature. On **load**: verify the signature, re-sanitize anyway, version-migrate, and rewrite the cleaned file.

```csharp
// FNV-1a over a canonical, version-conditional payload (deterrent, NOT cryptographic)
private static string ComputeSignature( LumberSteamProgressSave s, bool inclReset, bool inclBatches )
{
    var canonical = BuildCanonicalPayload( s, inclReset, inclBatches );
    ulong hash = 14695981039346656037UL;
    foreach ( var ch in canonical ) { hash ^= ch; hash *= 1099511628211UL; }
    return hash.ToString( "x16" );
}
```
(`vault77.chop_the_forest`: Code/Player/LumberSteamProgressSave.cs:957-968) — the canonical payload appends fields **conditionally** (`if save.Version >= N`) so old signed saves still verify (:971+, gated by `includeResetRevision`/`includeSaleBatches` at :952-954). `ValidateAndSanitize` clamps every field regardless of signature — the signature is a tamper *deterrent*, the sanitize is the real guard.

## Variations seen across games

- **Per-field clamp + roll back, then flag** (the strongest): bounds-check → undo the claim → `FlagAsCheater` → optionally report to a Discord webhook. `vault77.chop_the_forest` (PlayerProgression.cs:3627-3633).
- **Optimistic client return, host reconciles**: `TakeAmmo` returns `GetAmmo(resource) >= count` *before* the host confirms, so a client can briefly "have" ammo a desync will correct. Cheap and responsive; not safe for contested PvP economy. `apl.sandboxwars` (AmmoInventory.cs:53-61).
- **Persist-an-"in-session"-flag + reconcile on load** (anti-alt-F4): ores mined in a timed "Rift" are saved as pending; if the player disconnects mid-session, the next load subtracts them back out so you can't quit to keep illegitimate loot. Still client-side, so editing the JSON bypasses it. `clearlyy.s_miner` (RiftSessionManager.cs + StatsManager.cs:1279-1308).
- **Flag cheat-obtained wins so scoring ignores them**: the puzzle marks `SolvedByCheat` and the achievement layer only fires on legitimate solves. `simalami.15_puzzle_master` (AchievementService.cs).
- **Anti-farm exclusion**: bots are excluded from competitive Steam stats / battle-pass but still counted in ungated metrics. `Blind` (Code/Bot/BotManager.cs).
- **Deliberate NO authority** (know when to skip): `playbtg.elevator` uses a public-set `[Sync] int Balance` and runs purchases entirely client-side (`RemoveCoins` is `[Rpc.Owner]`, no host price re-check) — only the death-drop has a sanity clamp (`value > 3 reject`). Fine for a casual party game; an exploit in a ranked one. `stepdev.xtrem_road` saves locally per Steam account with no server authority for the same reason.
- **Provably-fair RNG** for gambling outcomes: commit-reveal SHA256 with rejection sampling to kill modulo bias, hash-chained audit log — engine-agnostic POCO. `vault77.chop_the_forest` (Code/Gambling/ProvablyFairRng.cs:126,:193). Use this instead of `System.Random` whenever an RNG result has economic value.

## Gotchas

- **`[Rpc.Host]` is callable by *any* client.** Always re-check `Rpc.CallerId == Network.OwnerId` (or your own permission rule) inside it. Owning the GameObject does not gate who can invoke the RPC. (PlayerProgression.cs:733)
- **Re-clamp on the host even though the client already clamped.** The client clamp is for UX; the host clamp is the security boundary. Clamp again in the Confirm RPC too — both ends. (AmmoInventory.cs:77-84; PlayerProgression.cs:738-744)
- **`SyncFlags.FromHost` means clients *cannot* write the field at all.** Any client-initiated change MUST round-trip an `[Rpc.Host]`; there is no "just set it locally" escape hatch. (PlayerProgression.cs:37)
- **FNV-1a / any in-code signature is a deterrent, not crypto.** A reader of your shipped C# can recompute it. Treat signed local saves as "raises the bar," and put truly contested state on a backend / Live Service, not the client disk.
- **Optimistic returns can briefly lie.** `TakeAmmo` returning `true` pre-confirmation means a desync can let a client act on ammo it doesn't have. Acceptable for fire-rate feel; not for "did this expensive purchase succeed." (AmmoInventory.cs:56)
- **Idempotency-guard one-shot grants** (`HashSet.Add` returns false on dup) so a replayed RPC can't double-claim. Roll the guard back if validation fails. (PlayerProgression.cs:3624,:3632)
- **String-keyed pools/IDs orphan on rename.** `NetDictionary` keyed by `resource.ResourcePath` (or save data keyed by asset id) silently loses entries if you rename the `.ammo`/`.shopitem` asset. (AmmoInventory.cs:11)
- **Whitelist dev SteamIds out of the caps**, or your own testing trips `FlagAsCheater`. (PlayerProgression.cs:2630-2635)

## Seen in

- `vault77.chop_the_forest` — host-authoritative economy, request/confirm triad, bounds-check+flag, signed saves, provably-fair RNG (`Code/Player/PlayerProgression.cs`, `Code/Player/LumberSteamProgressSave.cs`, `Code/Gambling/`)
- `apl.sandboxwars` — host-authoritative shared ammo pool with re-clamping RPCs (`sandbox/Code/Game/Weapon/AmmoInventory.cs`)
- `clearlyy.s_miner` — timed-session anti-exploit rollback on reconnect (`RiftSessionManager.cs`, `StatsManager.cs`)
- `simalami.15_puzzle_master` — cheat-flagged solves excluded from achievements (`AchievementService.cs`)
- `Blind` — bots excluded from competitive stats (anti-farm) (`Code/Bot/BotManager.cs`)
- `playbtg.elevator`, `stepdev.xtrem_road` — deliberately client-trusting (casual/cosmetic; study as the counter-examples)

---
**Verify live:** the authority API can shift between SDK builds — confirm `SyncFlags.FromHost`, `Rpc.CallerId`, `Network.OwnerId`, and `Networking.IsHost` against the installed SDK with `describe_type Sandbox.SyncFlags` / `search_types Rpc` / `describe_type Sandbox.Connection` before relying on them; reflection is authoritative, not this doc.

**See also:** `sbox-api` (resolve exact signatures for `[Rpc.Host]`/`[Sync]`/`NetDictionary`) and `sbox-build-feature` (screenshot-driven loop to confirm replicated state behaves in play mode).

# Save & Persistence (modern s&box)

How to store, version, and replicate game state so it survives a reload, a rejoin, or a server restart — without trusting clients. Mined from 17 games / 64 implementations.

## What it IS and when you need it

"Save-persistence" is three loosely-related problems that ship together in almost every s&box game:

1. **Authoritative live state** — who owns the numbers (money/XP/inventory) at runtime and how they replicate. In MP this is host-owned `[Sync]` state; clients display, never write.
2. **Durable storage** — where state lives between sessions: local disk (`FileSystem.Data`), the s&box cloud (`Sandbox.Services.Stats`), or your own HTTP backend.
3. **Safe load** — versioning, migration, validation/clamping, and corruption recovery so an old or tampered save never crashes a newer build.

You need it the moment a player expects progress to still be there next session. Pick storage by *trust model*: client-local disk is trivially editable (fine for solo/co-op/cosmetics), the cloud/backend is the only place to put anything competitive.

## Canonical modern approach

### 1. One host-authoritative state component

Put currencies/levels on a `Component` as `[Sync(SyncFlags.FromHost)]` auto-properties with private-ish setters. Claim host ownership once via `NetworkSpawn()`; every mutator early-returns on `IsProxy` so only the host writes — clients see the replicated value (enifun.shop_manager: `Code/Economy/ShopFunds.cs:18`, `:36`, `:86`).

```csharp
public sealed class ShopFunds : Component
{
    public static ShopFunds Current { get; private set; }
    [Property] public float StartingMoney { get; set; } = 500f;
    [Sync( SyncFlags.FromHost )] public float Money { get; set; }

    protected override void OnStart()
    {
        Current = this;
        if ( Networking.IsActive && Networking.IsHost && !GameObject.Network.Active )
        {
            Money = StartingMoney;        // SaveManager overwrites once it loads
            GameObject.NetworkSpawn();    // host owns it; clients become IsProxy
        }
    }

    public bool SpendMoney( float amount )
    {
        if ( IsProxy || amount <= 0f || Money < amount ) return false; // host-only
        Money -= amount;
        SaveManager.MarkDirty();          // never write disk inline; flag it
        return true;
    }
}
```

`SyncFlags.FromHost` means clients **literally cannot write** the value — any client-initiated change must round-trip an `[Rpc.Host]` that re-validates (`Rpc.CallerId == Network.OwnerId`) and re-clamps before applying (vault77.chop_the_forest: `Code/Player/PlayerProgression.cs:37`; artisan.darkrpog: `Code/Player/Player.Roleplay.cs:9`).

### 2. A POCO DTO + dirty-flag autosave to FileSystem.Data

Collect all state into a plain `[JsonPropertyName]`-friendly class. Don't write on every mutation — set a dirty flag and flush on a timer / on quit. `ReadJson<T>` / `WriteJson` handle `Vector3`/`Angles` fine (facepunch.jumper: `Code/Player/JumperProgress.cs:22`, `:58`).

```csharp
public class JumperProgressData            // plain POCO — public props only
{
    public Vector3 Position { get; set; }
    public float BestHeight { get; set; }
    public int TotalJumps { get; set; }    // never reset — lifetime
}

string FileName => $"{Scene.Name}_progress.json";

protected override void OnStart()
{
    if ( IsProxy ) return;                 // owner/host loads, proxies don't
    Current = FileSystem.Data.ReadJson<JumperProgressData>( FileName, null ) ?? new();
}

public void Save() => FileSystem.Data.WriteJson( FileName, Current );
```

Key the filename by SteamId for per-account local saves (`player_saves/{steamId}.json` — stepdev.xtrem_road `Code/Persistence/PlayerSaveService.cs:95`). Flush from `OnUpdate` when `_dirty`, and force a final save on `Game.IsClosing`/`OnDestroy` (clearlyy.s_miner `StatsManager.cs:1684`). `ReadJsonOrDefault<T>(path, default)` is the no-throw loader (simalami.15_puzzle_master `LevelProgression.cs:280`).

### 3. Version, migrate, and sanitize on load

Store a `Version` int. Migrate on the **raw `JsonObject` before deserialize** so you can fix shapes the current C# classes no longer match. Run a ladder keyed by version-to-migrate-FROM, bumping after each step (enifun.shop_manager: `Code/Save/SaveMigrator.cs:23`, `:33`).

```csharp
public const int CurrentVersion = 4;
static readonly Dictionary<int, Action<JsonObject>> Migrations = new()
{
    { 1, MigrateV1ToV2 }, { 2, MigrateV2ToV3 }, { 3, MigrateV3ToV4 },
};

public static JsonObject Migrate( JsonObject save )
{
    var version = save?["Version"]?.GetValue<int>() ?? 1;
    while ( version < CurrentVersion )
    {
        if ( !Migrations.TryGetValue( version, out var step ) ) return null; // -> fall back to backup
        step( save );                  // e.g. save["Loans"] ??= new JsonObject();
        save["Version"] = ++version;
    }
    return save;
}
```

After deserialize, **clamp/repair every field** (`Math.Clamp(saved, 0, Max)`, length-bounded loops, null-coalesce each section `?? new()`) so explicit JSON `null` or an out-of-range level can't crash or cheat (enifun.shop_manager `Code/Save/SaveManager.cs:326`; artisan.darkrpog `Code/Player/Persistence/PlayerRoleplayStorage.cs:297`). The migration ladder is **append-only — never reorder it.**

### 4. Atomic write + fallback read (anti-corruption)

Write to a temp/backup first, then promote, so a crash mid-write never destroys the good save. On load, try primary → backup → legacy in order (enifun.shop_manager `Code/Save/SaveManager.cs:290`, `:164`; clearlyy.s_miner `StatsManager.cs:1855`).

```csharp
// atomic write: copy current -> .backup.dat, then overwrite primary
if ( FileSystem.Data.FileExists( Primary ) ) CopyFile( Primary, Backup );
FileSystem.Data.WriteAllText( Primary, json );
```

## Notable variations

- **Cloud Stats as the whole DB (no save file).** Currency/XP live in `Sandbox.Services.Stats` keyed strings; `Stats.Increment("bp_s1", 1)` for counters, `Stats.SetValue(name, v)` for current-selection, `Stats.Flush()` to push (Blind `Code/Player/Player.cs:786`; playbtg.elevator `Code/Actors/ElevatorPlayer.Score.cs:80`). **The host CANNOT write a remote player's Steam stats** — award via `[Rpc.Owner(NetFlags.HostOnly)]` so the code runs on the owning client:

  ```csharp
  [Rpc.Owner( NetFlags.HostOnly )]
  public void AwardKillBP() => Sandbox.Services.Stats.Increment( "bp_s1", 1 );
  ```

- **Your own HTTP/Supabase backend.** Use `Sandbox.Http.RequestAsync(url, "GET", headers: …)` / `RequestStringAsync` — **never `System.Net.HttpClient`** (whitelist-blocked). Cloud is source of truth, local `.bin` is a fallback (lavagame.multis_cases `Code/Game/Save/SaveCloud.cs:83`, `:104`; namicry.gacha_crawler `Code/GameManager.cs:487`). Non-host clients often have no direct internet — relay through the host (vault77 `Code/game/BackendClient/HttpBackendTransport.cs:27`).

- **Scene-diff "save the world."** `Json.CalculateDifferences(baseline, current, GameObject.DiffObjectDefinitions)` stores only the patch vs the original `SceneFile`, plus a side-channel for ownership/`[Sync]` state; load does `Json.ApplyPatch` then `Game.ChangeScene` (artisan.darkrpog `Code/Save/SaveSystem.cs:128`; apl.sandboxwars `Code/Cleanup/CleanupSystem.cs:14`). Terrain/voxel games store edits as a **diff against the seed-reproducible default** to keep saves tiny (master.digging_simulator `DiggableZone.cs:261`).

- **Durable IDs for runtime-spawned objects.** `GameObject.Id` is **not** stable across restarts — stamp your own `[Sync] Guid PersistentId` and write tombstones on delete (artisan.darkrpog `Code/Persistence/World/PersistentWorldEntity.cs:6`).

- **Collections can't be `[Sync]`'d.** Serialize a `HashSet`/list to a CSV `[Sync] string` and rebuild on proxies when it changes; do optimistic local add then reconcile from host (enifun.shop_manager `Code/Economy/PlayerProgression.cs:250`).

- **Bucketed sync for hot floats.** Accumulate a delta and only flush the `[Sync]` write when it crosses a threshold — don't replicate a fractional value 60×/sec (artisan.darkrpog `Code/Items/MoneyPrinter.cs:49`).

- **Data-driven balance/content.** Tunables as `GameResource` assets (`[AssetType(Extension="…")]`, read via `ResourceLibrary.GetAll<T>()`) so designers edit without recompiling (treehaven.sdiver `Code/Definitions/EquipmentResource.cs:46`; Blind `Code/Economy/ShopItemResource.cs:22`), or as `static readonly struct[]` tables indexed by level (vault77 `Code/Player/AxeUpgradeBalance.cs:21`).

- **Disconnect-safe delivery (ACK).** Owe an offline player a reward? Write it to a host-side pending file and keep it until the client ACKs receipt — at-least-once + client dedupe (lavagame.multis_cases `Code/Game/Core/GameManager.cs:174`).

## Gotchas

- **`SyncFlags.FromHost` is display-only on clients.** Any client-driven change MUST round-trip `[Rpc.Host]` and be re-validated + re-clamped there; never trust the incoming number (vault77 `PlayerProgression.cs:730`).
- **Client-local `FileSystem.Data` is trivially editable.** It's per-machine, not per-Steam-account and not cloud-synced. Fine for solo/co-op/cosmetics; use the cloud/backend for anything competitive (clearlyy.s_miner, goders.natural_disaster_survival, stepdev.xtrem_road all note this).
- **`Stats.SetValue` accumulates via `.Sum`, it does NOT overwrite.** Use `Increment` + `.Sum` for counts; use `SetValue` + `.LastValue` for current-selection/flags. Ownership-as-`Increment` is write-once — decrementing silently revokes a paid item (Blind `Player.cs`).
- **`FileSystem.Mounted` is read-only** (authored content via `ReadJson`/`FindFile`); writable user data is `FileSystem.Data` (simalami `LevelRepository.cs:20`).
- **`Vector3` JSON-friendliness varies** — `WriteJson` round-trips it, but some pipelines store explicit `X/Y/Z` floats to be safe (emg.everything_must_go `Code/Shop/ProgressBootstrapper.cs`).
- **Bumping `CurrentVersion` without a migration silently wipes/refuses old saves** — intentional in some games (emg `CurrentVersion=21`, seed+version gate), a bug in others. Decide deliberately.
- **Enum-keyed dictionaries break on reorder; ids persisted but labels re-resolved** — reordering enum values or table ids corrupts old saves (clearlyy.s_miner, stepdev.xtrem_road).
- **Apply the loaded save only after all singletons exist** — defer to the first `OnUpdate` where everything's `Current` (with a timeout fallback), or you write into half-spawned systems (enifun `SaveManager.cs:1480`).
- **Non-host clients must NOT load** (host is sole authority) — guard it, and clear all static queue/reservation state on load before respawning (enifun).
- **FNV-1a / XOR is anti-tamper deterrent only, NOT crypto** (vault77, lavagame). A committed Bearer/service_role key is only acceptable because the host is trusted/whitelisted — never copy a hardcoded backend key (namicry's committed token is the anti-pattern).
- **Signature/version payloads must be append-only & version-conditional** — add new serialized fields at the tail behind a `if (Version >= N)` check or older saves fail to verify/deserialize (vault77 `LumberSteamProgressSave.cs:957`; lavagame `SaveSerializer.cs`).

## Seen in

vault77.chop_the_forest · clearlyy.s_miner · master.digging_simulator · enifun.shop_manager · emg.everything_must_go · dimmies.terryspapers · artisan.darkrpog · apl.sandboxwars · playbtg.elevator · facepunch.jumper · yellowletter.terrys_crash_course · stepdev.xtrem_road · ataco.sdoomresurrection · khamitech.battledraft · goders.natural_disaster_survival · treehaven.sdiver · namicry.gacha_crawler · lavagame.multis_cases · simalami.15_puzzle_master · facepunch.ss1 · suburbianites.blindloaded (Blind)

Open the cited file under `C:/Users/cargi/sbox-lessons/zips-code/<game>/` to read the real implementation.

---
**Verify live:** API drifts between SDK versions — confirm signatures against the installed SDK with the bridge's reflection (`describe_type` / `search_types`) before relying on a member, e.g. `describe_type Sandbox.Services.Stats`, `describe_type Sandbox.Http`, `search_types FileSystem`. Reflection is authoritative, not this doc.

**See also:** `sbox-api` (resolve exact type/method signatures) and `sbox-build-feature` (the screenshot-driven build loop to wire one of these recipes into a running game).

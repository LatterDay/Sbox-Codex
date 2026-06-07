# Tycoon-Idle Genre Recipe

How to build a harvest -> sell -> upgrade -> prestige tycoon/idle game in modern s&box (GameObject/Component/Scene), distilled from three shipped titles.

## What defines the genre

A tycoon-idle game is a **numbers-go-up economy with a tight harvest loop wrapped around data-driven progression**. The player does one cheap repeated action (chop / mine / dig), converts the output into a currency, spends currency on **geometric-cost upgrades** that make the action faster, and periodically hits a **prestige/reset** that trades current progress for a permanent multiplier. Everything else (gacha cases, gambling, leaderboards, station UIs) is bolted onto that spine.

The core loop, verbatim from a shipped game's own summary:
> swing an axe at trees -> fill a weight-capped backpack -> sell logs / mill them into planks -> spend Money on tiered upgrade trees -> unlock map gates -> fast-travel -> prestige reset for permanent multipliers (chop_the_forest: summary).

Three reference games, three networking postures — pick yours up front because it dictates everything:
- **chop_the_forest** — host-authoritative multiplayer. Economy lives on the host; clients replicate. Use this if real value (leaderboards, a backend) is at stake.
- **s_miner** — client-authoritative ("Roblox hub"). Each client owns its own save; `[Sync]` only for headline numbers, `[Rpc.Broadcast]` for shared events. Easy, but trivially cheatable.
- **digging_simulator** — single-player. Zero networking discipline (no `[Sync]`, no `[Rpc]`); plain C# fields. Great single-player recipes, needs a networking pass before MP (digging_simulator: summary).

## The system stack to compose

Compose these in order. Each maps to a deeper system reference where one exists.

1. **Harvest interaction** (`references/systems/spawning-waves.md` for spawn cadence) — the repeated action: a trace/proximity query that damages a world resource and emits drops.
2. **Capped inventory / carry** (`references/systems/inventory.md`) — a weight- or count-capped backpack that gates the action when full.
3. **Currency + economy core** (`references/systems/economy-currency.md`) — one component holding all currencies; the single place money is minted/spent.
4. **Data-driven upgrade tables** (`references/systems/progression-upgrades.md`) — `readonly struct[]` balance tables with geometric cost curves, indexed by level.
5. **Shop / vendor** (`references/systems/shop-vendor.md`) — buy upgrades, sell carry, applies stats to live components.
6. **Prestige / rebirth** (`references/systems/progression-upgrades.md`) — reset lower progress for a permanent multiplier.
7. **Signed, sanitizing save** (`references/systems/save-persistence.md`) — clamp-everything load, versioned schema, anti-tamper.
8. **Gacha / loot case** (`references/systems/gacha-loot.md`) — timed free case with weighted rolls (optional).
9. **Leaderboards** (`references/systems/leaderboards-services.md`) — `Sandbox.Services.Stats` with season schedule (optional, MP).
10. **Idle/offline accrual** (`references/systems/idle-offline.md`) — recharge/earn over real (Unix) time across sessions (optional).

## Build order

Build the loop before the meta. Vertical-slice order:

**1. Harvest target.** A `HarvestableResource` Component with a synced hit counter. On enough hits, deplete and spawn a pickup. For a forest of thousands, do NOT scan the scene every swing — bucket instances into a static spatial grid and query only nearby cells.

```csharp
public sealed class HarvestableResource : Component
{
    static readonly Dictionary<ResourceGridCell, List<HarvestableResource>> Grid = new();
    const float CellSize = 512f;

    [Sync(SyncFlags.FromHost)] public float HitsTaken { get; private set; }
    [Sync(SyncFlags.FromHost)] public bool IsDepleted { get; private set; }

    // Query only the cells overlapping the AABB, not AllActiveResources.
    public static void GetActiveResourcesNear(Scene scene, Vector3 pos, float radius, List<HarvestableResource> results)
    {
        results.Clear();
        var min = Cell(pos - new Vector3(radius, radius, 0));
        var max = Cell(pos + new Vector3(radius, radius, 0));
        for (var x = min.X; x <= max.X; x++)
        for (var y = min.Y; y <= max.Y; y++)
            if (Grid.TryGetValue(new ResourceGridCell(x, y), out var cell))
                foreach (var r in cell)
                    if (r.IsValid() && r.WorldPosition.DistanceSquared(pos) <= radius * radius)
                        results.Add(r);
    }
}
```
(chop_the_forest: Code/World/HarvestableResource.cs:10 grid field, :163 GetActiveResourcesNear, :47 Sync hit state.) Cell is captured at OnStart from WorldPosition — never move a registered resource or it desyncs its bucket.

**2. Economy component.** ONE component owns every currency and level. In MP, make them `[Sync(SyncFlags.FromHost)]` with private setters and guard every mutator so only the host writes.

```csharp
public sealed class PlayerProgression : Component
{
    [Sync(SyncFlags.FromHost)] public int Money { get; private set; }
    [Sync(SyncFlags.FromHost)] public int AxeLevel { get; private set; } = 1;
    [Sync(SyncFlags.FromHost)] public int PrestigeLevel { get; private set; }

    public void AddMoney(int amount)
    {
        if (Networking.IsActive && !Networking.IsHost) return; // host-only writes
        Money = Math.Clamp(Money + amount, 0, 1_500_000_000); // stay inside int.MaxValue
    }
}
```
(chop_the_forest: Code/Player/PlayerProgression.cs:37 the `[Sync(FromHost)]` currency block.) `FromHost` means clients *cannot* write — a client-initiated change must round-trip an `[Rpc.Host]` (see Request->Apply->Confirm below). Keep money as `int`/`long` but clamp; geometric costs blow past `int.MaxValue` fast.

**3. Balance tables.** Each tunable system is a static class with a `readonly struct[]` indexed by level + a clamping `Get`. Designers tune one array; `MaxLevel` derives from `.Length`.

```csharp
public readonly struct AxeUpgradeDefinition
{
    public AxeUpgradeDefinition(int level, float power, int coinCost, int plankCost)
        { Level = level; Power = power; CoinCost = coinCost; PlankCost = plankCost; }
    public int Level { get; } public float Power { get; }
    public int CoinCost { get; } public int PlankCost { get; }
}

public static class AxeUpgradeBalance
{
    static readonly AxeUpgradeDefinition[] Definitions =
    {
        new(1, 1.0f, 0, 0), new(2, 1.45f, 30, 0), new(3, 1.55f, 90, 0),
        new(4, 1.9f, 220, 0), /* ... costs grow geometrically ... */ new(25, 65.0f, 55_000_000, 7000)
    };
    public static int MaxLevel => Definitions.Length;
    public static AxeUpgradeDefinition Get(int level) => Definitions[Math.Clamp(level, 1, MaxLevel) - 1];
    public static bool TryGetNext(int current, out AxeUpgradeDefinition def)
    { def = Get(current + 1); return current < MaxLevel; }
}
```
(chop_the_forest: Code/Player/AxeUpgradeBalance.cs:21 Definitions, :50 MaxLevel from Length, :52 Get/clamp.) `AxeUpgradeBalance`, `SawUpgradeBalance`, `BackpackUpgradeBalance`, `PrestigeBalance`, `ZoneUnlockBalance` all share this exact shape. The economy reads them via computed props: `AxePower => AxeUpgradeBalance.Get(AxeLevel).Power`. Adding a row "just works" but invalidates persisted levels above the new max — your save loader MUST clamp on load.

**4. Shop / vendor.** If you don't need the multiplayer ceremony, the single-player vendor pattern is the cleanest geometric-cost shop: a `[Serializable]` config per upgrade line, `BaseCost * mult^level`, then write the derived stat onto the live component.

```csharp
[Serializable]
public class UpgradeConfig
{
    [Property] public int BaseCost { get; set; } = 100;
    [Property] public float CostMultiplier { get; set; } = 1.5f;
    [Property] public int MaxLevel { get; set; } = 5;
    [Property] public float BaseStat { get; set; } = 50f;
    [Property] public float StatPerLevel { get; set; } = 15f;
}

public int GetCost(int level, UpgradeConfig c)            // -1 == maxed
    => level >= c.MaxLevel ? -1 : (int)(c.BaseCost * MathF.Pow(c.CostMultiplier, level));
```
(digging_simulator: Code/ShopTerminal.cs:9 UpgradeConfig, :49 GetCost geometric formula, :81 BuyUpgrade writes `drill.DigRadius = BaseStat + level * StatPerLevel` onto the live component.) Because buying mutates live components, your save loader must **re-apply every upgrade stat on load** (`RestoreLevels`). Note: this is a desktop game so `MathF.Pow` works — but in the s&box **sandbox** `MathF` is restricted; prefer `(float)Math.Pow(...)` if your code runs sandboxed (see sbox-build-feature gotchas).

**5. Save + sanitize.** Persist per-account JSON, clamp every field on load, then re-apply stats. For MP value, sign it.

```csharp
// Local per-Steam-ID JSON. Save() clamps everything, then Sign().
FileSystem.Data.WriteJson($"corp_progress/steam_{steamId}.json", save);
// Load: verify signature -> ValidateAndSanitize (clamp every field, clamp levels to MaxLevel)
//       -> version-migrate -> re-apply stats -> rewrite sanitized file back.
```
(chop_the_forest: Code/Player/LumberSteamProgressSave.cs:434 ValidateAndSanitize, :957 FNV-1a signature.) The signature payload is **version-conditional**: `BuildCanonicalPayload` appends a field only `if (save.Version >= N)`, so a save signed under v3 still verifies after the code reaches v8 — never insert new fields unconditionally. FNV-1a is anti-tamper deterrent, NOT cryptographic. For a paranoid single-DTO variant with rotating multi-file backups + heuristic loss-recovery, see s_miner: Code/StatsManager.cs:1737 SaveStatsToDisk, :1855 rotation, :1422 TryRecoverFromSafetyBackupIfProgressLost. Full treatment in `references/systems/save-persistence.md`.

**6. Prestige.** A reset method: bank a permanent multiplier from current totals, zero the run-level currencies/levels, bump `PrestigeLevel`, save. The multiplier feeds back into harvest power. (chop_the_forest: PrestigeBalance table, same struct[] shape as the axe table.) Multi-tier resets (rebirth/ascension that reset prestige) are just stacked layers — see s_miner: Code/StatsManager.cs:500 prestige/ascension const tables. Details in `references/systems/progression-upgrades.md`.

## Two networking patterns you will need (MP only)

**Request -> Apply -> Confirm** for any state a non-host client must change. Client applies optimistically, calls `[Rpc.Host]` Request which re-checks caller + re-clamps, host applies, `[Rpc.Owner]` Confirm echoes the host's authoritative numbers back. Clamp at all three layers — the host never trusts the wire.

```csharp
[Rpc.Host]
void RpcRequestSelectPet(string petId)
{
    if (Rpc.CallerId != Network.OwnerId) return;   // re-validate caller
    petId = SanitizePetId(petId);                  // re-clamp argument
    SelectedPetId = petId;                          // host applies (writes the [Sync] prop)
    RpcConfirmPet(petId);
}

[Rpc.Owner] void RpcConfirmPet(string petId) => ApplyConfirmedPet(petId);
```
(chop_the_forest: Code/Player/PlayerProgression.cs:922 RpcRequestApplyBackendProfileState, :941 RpcConfirm.)

**No-RPC event replication** for one-shot effects (hit shake, chop sound). Host increments a `[Sync(FromHost)]` int; each client caches an `_observed` copy and plays the effect locally when they differ. Cheap, ordered, survives late-join — but suppress it for ~0.35s after spawn so remote clients don't replay stale effects.

```csharp
[Sync(SyncFlags.FromHost)] int HitEffectSequence { get; set; }
int _observedHitEffectSequence = -1;

protected override void OnUpdate()
{
    if (HitEffectSequence != _observedHitEffectSequence)
    {
        _observedHitEffectSequence = HitEffectSequence;
        if (TimeSinceSpawn > 0.35f) PlayHitFeedback();   // suppress stale replays on join
    }
}
```
(chop_the_forest: Code/World/HarvestableResource.cs:49 sync sequence ints, :150 observed-copy init.) In s_miner the inverse idiom appears: an `[Rpc.Broadcast]` method that immediately `if (!Networking.IsHost) return;` — a broadcast runs on every peer, the guard makes only the host act, which re-broadcasts the result. That's how it routes client->host commands without a dedicated server RPC (s_miner: Code/MineReset.cs:241 CastVoteYes).

## Standout patterns worth copying

- **Spatial hash grid** for O(nearby) world queries instead of scene-wide scans + a single round-robin update runner to cap per-frame cost (chop_the_forest: HarvestableResource.cs:10, :163).
- **Virtual entities** — compute a dense procedural distribution as a seeded `Dictionary<coord,index>` with NO GameObjects; instantiate the real prefab only when the player digs near it and the voxel is still solid (digging_simulator: Code/OreGenerator.cs:49 GenerateVirtualOres, :95 RevealOresInSphere). Massive perf win for "millions of potential things".
- **Diff-based save** — persist only voxels that differ from the deterministic seeded default + the seed, regenerate the default on load and replay the diff. Tiny saves for an arbitrarily large destructible world (digging_simulator: Code/DiggableZone.cs:261 GetTerrainChanges).
- **One bool-returning resource gate** drives every consumer: `ConsumeBattery(amount)->bool` is the single chokepoint for drill cost-per-dig, jetpack cost-per-second, and triggers the death/respawn penalty when empty (digging_simulator: Code/PlayerResources.cs:29).
- **Pure power-law XP curve**, trivially liftable: `xpForLevel = 320 * level^2.55`, sync the derived level for nameplates (s_miner: Code/LevelingTable.cs:140, StatsManager.cs:468 `[Sync] NetworkedLevel`).
- **Recharge over Unix time, not `TimeSince`** — store last-recharge as Unix seconds so timed free cases / idle accrual survive save/reload and session boundaries (chop_the_forest: PlayerProgression `FreeCaseLastRechargeUnix`; see `references/systems/idle-offline.md`).

## Verify live

s&box's API shifts between SDK versions — reflection is the source of truth, not this doc or training data. Before writing against an unfamiliar type, confirm it: `describe_type` / `search_types` for `Component`, `Sandbox.Networking`, `Sandbox.Services.Stats`, and the `[Sync]` / `[Rpc.Host]` / `[Rpc.Owner]` / `[Rpc.Broadcast]` attributes; `Scene.Trace` for the harvest trace. Stop play mode before scene edits; screenshot visual changes and read the PNG.

Cross-links: see the **sbox-api** skill for authoritative type/method signatures, and the **sbox-build-feature** skill for the screenshot-driven build loop and the sandbox gotcha list (MathF restricted, head-bone case sensitivity, Cloud assets ephemeral).

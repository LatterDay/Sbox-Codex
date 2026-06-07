# Progression & Upgrades

How to build leveled upgrade trees, currencies, and stat payoffs in modern s&box — host-authoritative, data-driven, and save-safe. Mined from 18 shipped games.

## What this IS / when you need it

A progression system is three loops that feed each other:
1. **Currency / XP** — a number that goes up (money, coins, XP, score, quota).
2. **Upgrades** — spend the currency to raise leveled *upgrade* values, each with a **cost curve** and a **cap**.
3. **Payoff** — gameplay reads the upgrade levels and changes behavior (faster mining, more spawns, bigger inventory).

You need this for any tycoon/idle/sim/roguelite. The hard parts are *authority* (who is allowed to spend), *the cost curve*, *where the payoff is read*, and *making it survive save/reload and host migration*. Get those four right and the rest is content.

## Canonical modern-s&box approach

### 1. Hold economy state as host-authoritative `[Sync]`

Put currency + every upgrade level on one component as `[Sync(SyncFlags.FromHost)]` auto-properties. Clients see read-only mirrors; only the host writes (repo/vault77.chop_the_forest: `Code/Player/PlayerProgression.cs:37`; repo/emg.everything_must_go: `Code/Shop/Shop.cs:22-30`).

```csharp
public sealed class ShopProgression : Component
{
    [Property, Sync( SyncFlags.FromHost )] public float Money { get; private set; }
    [Property, Sync( SyncFlags.FromHost )] public int Xp { get; private set; }
    [Property, Sync( SyncFlags.FromHost )] public int Level { get; private set; }
    [Sync] public int AdvertisingTier { get; set; }   // 0..Max
}
```

`SyncFlags.FromHost` means clients literally cannot write the value — any client-initiated change MUST round-trip an `[Rpc.Host]` (repo/vault77.chop_the_forest gotcha). Collections do **not** `[Sync]`: either use `NetList<T>`/`NetDictionary<K,V>` (repo/emg.everything_must_go: `Code/Shelving/Shelf.cs:48-54`; repo/thefancylads.restaurant_dev: `NetDictionary<UpgradeResource,int> ActiveUpgrades`) or serialize a `HashSet` to a CSV `[Sync] string` and rebuild on proxies (repo/enifun.shop_manager: `Code/Economy/PlayerProgression.cs:250`).

### 2. The canonical buy recipe (proxy → host → validate → spend → cap → save)

Every upgrade follows the same shape. This is the most-copied block across the corpus (repo/enifun.shop_manager: `Code/Shop/ShopManager.cs:208`):

```csharp
public bool TryBuyAdvertising()
{
    if ( IsProxy ) { RequestBuyAdvertisingOnHost(); return true; }   // client → host
    if ( AdvertisingTier >= MaxAdvertisingTier ) return false;       // cap

    var cost = GetAdvertisingCost();
    if ( !ShopFunds.Current.SpendMoney( cost, "Advertising" ) )      // re-validate funds host-side
        return false;

    AdvertisingTier++;                                              // mutate the [Sync] level
    SaveManager.MarkDirty();                                        // persist
    return true;
}

[Rpc.Host] private void RequestBuyAdvertisingOnHost() => TryBuyAdvertising();
```

Re-check the cap and the funds **on the host**, never trust the client number. With per-owner permissions, gate on the caller (repo/thefancylads.restaurant_dev: `Code/Common/Progression/Upgrades.cs:61` — `if ( restaurant.HasPermissions( Rpc.Caller ) )`).

### 3. The cost curve

Two idioms dominate:

**Geometric** — `BaseCost * pow(mult, currentLevel)`, returns a sentinel at max. The canonical idle/tycoon price (repo/master.digging_simulator: `Code/ShopTerminal.cs:49`):

```csharp
public int GetCost( UpgradeConfig c, int level )
    => level >= c.MaxLevel ? -1 : (int)(c.BaseCost * MathF.Pow( c.CostMultiplier, level ));
```

**Table** — a `static readonly float[]` of explicit per-tier costs (and a parallel effect array), `MaxTier` derived from `.Length` (repo/enifun.shop_manager: `Code/Shop/ShopManager.cs:175`; repo/vault77.chop_the_forest: `Code/Player/AxeUpgradeBalance.cs:21`):

```csharp
public static readonly float[] AdvertisingCosts      = { 500f, 1000f, 2000f, 4000f };
public static readonly float[] AdvertisingReductions = {  10f,   20f,   30f,   40f }; // % effect per tier
public float GetAdvertisingCost() =>
    AdvertisingTier >= MaxAdvertisingTier ? 0f : AdvertisingCosts[AdvertisingTier];
```

XP-to-level is usually a pure power curve solved both ways, with `AddXp` looping to handle multiple level-ups at once (repo/clearlyy.s_miner: `LevelingTable.cs:140` — `320 * level^2.55`; repo/playbtg.elevator: `ElevatorPlayer.Score.cs:111`; repo/enifun.shop_manager: `Code/Economy/PlayerProgression.cs:90`):

```csharp
void AddXp( int amount )
{
    Xp += amount;
    while ( Xp >= XpForNextLevel( Level ) ) { Xp -= XpForNextLevel( Level ); Level++; OnLevelUp(); }
}
```

### 4. Pull-based payoff (don't push)

Upgrades should **not** reach into gameplay components. Consuming systems *query* the current effect. Two ways:

**Per-upgrade getter** (simple, verbose) — `GetX()` reads the tier and returns a multiplier; gameplay calls `ShopManager.Current?.GetAdvertisingSpawnMultiplier()` (repo/enifun.shop_manager: `Code/Shop/ShopManager.cs:197`):

```csharp
public float GetAdvertisingSpawnMultiplier() =>
    AdvertisingTier <= 0 ? 1f : 1f - AdvertisingReductions[AdvertisingTier - 1] / 100f;
```

**Central effect aggregator** (cleanest, scales) — one `EffectsManager` that every system queries; upgrades just *declare* `UpgradeEffect{Type, Mode, ValuePerRank}` structs and never touch gameplay (repo/thefancylads.restaurant_dev: `Code/Common/Effects/EffectsManager.cs:30`):

```csharp
public float Get( RestaurantComponent r, EffectType type )
{
    float total = 0f;
    foreach ( var (upgrade, rank) in r.ActiveUpgrades )
        foreach ( var effect in upgrade.Effects )
            if ( effect.Type == type && effect.Mode != EffectMode.Flag )
                total += effect.ValuePerRank * rank;
    return IsMultiplicative( type ) ? 1f + total : total;   // additive vs multiplicative
}
```

Additive effects return the raw sum; multiplicative return `1 + sum`. The additive-vs-multiplicative split is a hand-maintained `switch` — easy to forget a new `EffectType` (same file `:92`, gotcha confirmed).

### 5. Define content as data, not code

For anything beyond a handful of upgrades, make each upgrade a `GameResource` so designers author asset files with zero code changes (repo/thefancylads.restaurant_dev: `Code/Common/Progression/UpgradeResource.cs:6`; repo/artisan.darkrpog: `Code/Jobs/JobDefinition.cs:1`; repo/playbtg.elevator: `ExperienceDefinition.cs`):

```csharp
[AssetType( Name = "Upgrade", Extension = "upgrade", Category = "Progression" )]
public class UpgradeResource : GameResource
{
    public string Id { get; set; } = "";
    public UpgradeCategoryResource Category { get; set; }
    public int LevelCount { get; set; } = 5;          // cap
    public int Tier { get; set; } = 1;                // gate: (Tier-1)*5 points in category
    public UpgradeEffect[] Effects { get; set; } = Array.Empty<UpgradeEffect>();
}
```

Enumerate generically with `ResourceLibrary.GetAll<UpgradeResource>()` and look up by string `Id`. **Never** cache an empty `GetAll()` result — an early caller (hotload race) can run before GameResources are indexed and permanently empty your catalog (repo/artisan.darkrpog gotcha). And **never send a GameResource ref over an RPC** — send its `Id` string and reconstruct host-side via `ResourceLibrary.GetAll<T>().FirstOrDefault(r => r.Id == id)` (repo/thefancylads.restaurant_dev: `Code/Common/Economy/RestaurantShop.cs:29`).

### 6. Persist it (and clamp on load)

Save a flat POCO via `FileSystem.Data.WriteJson` / `ReadJson` (repo/master.digging_simulator: `SaveManager.cs:80`; repo/facepunch.jumper: `JumperProgress.cs:17`), or the s&box cloud `Sandbox.Services.Stats` for leaderboard-backed numbers (repo/playbtg.elevator: `ElevatorPlayer.Score.cs:80`). **Always re-clamp every level on load** — `Math.Clamp(saved, 0, Max)` — and re-apply upgrade stats onto live components after restore (repo/master.digging_simulator `RestoreLevels()`; repo/clearlyy.s_miner: `StatsManager.cs:1041-1068`). Adding a balance-table row raises `Max`, so a row removal would otherwise leave a persisted level above cap (repo/vault77.chop_the_forest gotcha).

## Variations seen across games

- **Stat-modifier engine** — instead of summing effects per query, register layered modifiers (`Set` → `Add` → `Mult` by priority) per source into a `NetDictionary<Stat,float>`; recompute from a stored base. Best when ~100 stats and many sources (repo/facepunch.ss1: `ss1/Code/things/Player.cs:931,953`).
- **Roguelite "choose 1 of N"** — on level-up, queue weighted reward choices (unlock / upgrade / worker / cash) with per-kind caps + dedupe + a reroll cost; mirror pending choices to clients as parallel `NetList` columns (repo/emg.everything_must_go: `Code/Shop/Shop.cs:1095-1183`).
- **Reflection-driven perks** — every perk is a `[Status(maxLevel, reqLevel, weight, ...)]`-attributed class; `TypeLibrary.GetTypes<Status>()` + weighted sampling builds the choice list. Adding a perk = one file (repo/facepunch.ss1: `ss1/Code/StatusManager.cs:42`).
- **Prestige / rebirth / ascension** — higher meta-layers reset lower progress for permanent multipliers; `Reconcile…FromUpgrades` re-derives spent points on load (repo/clearlyy.s_miner: `StatsManager.cs:1127`). Rank tables recomputed from a running score each frame (repo/lavagame.multis_cases: `Code/Game/Core/RankSystem.cs:27`).
- **Idle/passive earners** — a per-tick income generator whose upgrade levels live on the *entity*, with **bucketed sync** (accumulate a delta, only write the `[Sync]` when it crosses a threshold) so a fractional value doesn't spam 60 packets/sec (repo/artisan.darkrpog: `Code/Items/MoneyPrinter.cs:49`).
- **Anti-farm XP** — per-source hourly cap + per-key cooldown so you can't grind the same victim (repo/artisan.darkrpog: `Code/Skills/RoleplaySkillService.cs:39`).
- **Escalating quota economy** — daily quota from a `.runset` resource, scaled by player count, with over-quota bonus + carry-over into the next day (repo/treehaven.sdiver: `Code/Gameplay/GameMode/ExpeditionMode.cs:85`).
- **Deterministic per-player rotation** — daily/weekly challenges seeded by an explicit FNV mix of `SteamId + periodIndex` so the set is stable across sessions but unique per player; progress = lifetime `Stat.Sum` − a snapshot taken at rollover (repo/Blind: `Code/Economy/ChallengeDef.cs:69`).

## Gotchas

- `SyncFlags.FromHost` = clients cannot write. Every client-driven spend MUST go through `[Rpc.Host]`, and the host must **re-validate and re-clamp** the incoming request — never trust the number (repo/vault77.chop_the_forest, repo/enifun.shop_manager).
- **Client-only saves are cheatable.** `FileSystem.Data` keyed by SteamId on the owner is fine for solo/co-op, trivially editable for a competitive economy (repo/clearlyy.s_miner, repo/stepdev.xtrem_road gotchas). For trust, keep state host-authoritative.
- **Collections can't `[Sync]` directly** — use `NetList`/`NetDictionary` (host-only replication; rebuild after host-side mutation) or a CSV-string `[Sync]` rebuilt on proxies.
- **Bump a save Version on schema change** and clamp/sanitize on load; bumping silently wipes incompatible saves by design (repo/emg.everything_must_go `CurrentVersion`; repo/master.digging_simulator). Dictionaries keyed by an enum break if you reorder the enum (repo/clearlyy.s_miner).
- **Don't cache an empty `GetAll()`** — guard against the hotload/early-tick race that runs before GameResources index (repo/artisan.darkrpog).
- **Additive vs multiplicative** must be declared per effect type and is easy to miss when adding a new one (repo/thefancylads.restaurant_dev).
- **`MathF` may be blocked in the access-listed sandbox.** Several of these games run unsandboxed and use `MathF.Pow`; if your project throws on `MathF`, use `System.MathF` carefully or precompute the curve into a table (cookbook-wide s&box gotcha — verify with `describe_type`).
- Host-migration survival: every must-survive number needs `FromHost` sync **and** a deterministic restore path (repo/playbtg.elevator: `ElevatorNetworkHelper.cs` + `RestoreExperienceOrder`).

## Seen in

- repo/vault77.chop_the_forest — `Code/Player/PlayerProgression.cs`, `AxeUpgradeBalance.cs` (FromHost economy + balance tables)
- repo/thefancylads.restaurant_dev (GASTROTOWN) — `Code/Common/Effects/EffectsManager.cs`, `Common/Progression/Upgrades.cs`, `UpgradeResource.cs` (central effect aggregator + GameResource upgrades) — *cleanest reference*
- repo/enifun.shop_manager — `Code/Shop/ShopManager.cs`, `Economy/PlayerProgression.cs` (canonical TryBuy recipe + XP tokens)
- repo/master.digging_simulator — `Code/ShopTerminal.cs`, `SaveManager.cs` (geometric cost formula + JSON save)
- repo/emg.everything_must_go — `Code/Shop/Shop.cs` (roguelite choose-1-of-N + NetList mirrors)
- repo/clearlyy.s_miner — `StatsManager.cs`, `LevelingTable.cs` (prestige/rebirth/ascension + power-curve XP)
- repo/facepunch.ss1 — `Code/things/Player.cs`, `StatusManager.cs` (layered stat-modifier engine + reflection perks)
- repo/artisan.darkrpog — `Code/Skills/RoleplaySkillService.cs`, `Items/MoneyPrinter.cs`, `Jobs/JobDefinition.cs` (anti-farm XP, idle earner, GameResource defs)
- repo/playbtg.elevator — `ElevatorPlayer.Score.cs`, `ExperienceManager.cs` (cloud-Stats XP + host-migration restore)
- repo/lavagame.multis_cases — `Code/Game/Core/RankSystem.cs` (prestige rank table + odds buffs)
- repo/treehaven.sdiver — `Code/Gameplay/GameMode/ExpeditionMode.cs`, `EquipmentResource.cs` (escalating quota + tiered GameResource upgrades)
- repo/stepdev.xtrem_road — `Code/Progression/PlayerProgression.cs`, `Inventory/PlayerInventory.cs` (level/prestige gating + vendor)
- repo/goders.natural_disaster_survival — `Code/globals/DataManager.cs`, `ui/ShopItem.cs` (cost-array upgrade tree + 3D look-to-buy shop)
- repo/facepunch.jumper — `Code/Player/JumperProgress.cs` (per-scene JSON progress + Achievements.Unlock)
- repo/yellowletter.terrys_crash_course — `LevelMedals.cs`, `LevelProgressionService.cs` (medal tiers + unlock gating over Stats)
- repo/Blind — `Code/Economy/ChallengeDef.cs`, `ChallengeService.cs` (deterministic FNV-seeded challenge/streak rotation)
- repo/namicry.gacha_crawler — `Code/Models/GameItem.cs` (level×rarity upgrade cost formulas)
- repo/simalami.15_puzzle_master — `LevelProgression.cs` (save-slot star-mask progression + resumable state)

---
**Verify live:** the installed SDK is authoritative — confirm `GameResource`, `[AssetType]`, `Sync`/`SyncFlags`, `Rpc.Host`, `NetList<T>`, `Sandbox.Services.Stats`, and `FileSystem.Data` with `mcp__sbox__describe_type` / `mcp__sbox__search_types` before relying on a signature. Reflection beats training data; the API shifts between versions.
**See also:** `sbox-api` (look up exact type/method signatures) and `sbox-build-feature` (the screenshot-driven build-and-iterate loop).

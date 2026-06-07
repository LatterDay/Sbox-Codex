# Gacha-Crawler Genre Recipe

How to build a collect -> roll -> gear-up -> fight -> repeat gacha RPG (lootbox dungeon-crawler / case-opening sim) in modern s&box (GameObject/Component/Scene), distilled from two shipped titles.

## What defines the genre

A gacha-crawler is a **data-layer RPG bolted to a dopamine slot machine**. The player spends a currency to **roll a weighted random reward**, watches a **CS:GO-style reveal animation**, **slots the result into a derived-stat loadout**, then runs it through a **content loop** (turn-based dungeons, or just more rolls) that pays out *more currency and more rolls*. The fun is the roll + the build, not the world — both reference games are essentially **UI-only**: almost zero 3D gameplay, one giant state Component, and a pile of plain-C# data models.

The core loop, in one line:
> earn/buy currency -> spin a weighted lootbox (with pity) -> equip/craft the drop into a derived-stat character -> fight an OnUpdate() turn-based dungeon (or open more cases) -> bank gold/loot + climb a leaderboard -> spin again (namicry.gacha_crawler: summary).

Two reference games, two postures — pick yours up front, it dictates the netcode:
- **namicry.gacha_crawler** — **single-player RPG + light social**. The whole game is one ~3500-line `partial class GameManager : Component` singleton holding all state as public fields, driven by one `OnUpdate()`; multiplayer is only a shared chat (`ChatManager`) and **async snapshot PvP** (fetch an opponent's serialized stats, fight them as a one-monster dungeon). Use this when the loop is solo and "PvP" can be a stat snapshot.
- **lavagame.multis_cases** — **host-authoritative case-opening sim** in a 3D hub. Per-player local economy, `[Sync]` only for the public "recent wins" feed, `[Rpc.Host]`/`[Rpc.Broadcast]` for the genuinely shared gambling (case-battle, jackpot). Use this when rolls have real (cloud-persisted) value and players gamble against each other.

The defining tension is the same in both: **the roll must be host-authoritative if it has value, but the reveal animation is pure local cosmetic** — decide first, animate second.

## The system stack to compose

Each maps to a deeper system reference where one exists. Compose in order:

1. **Gacha / loot case** (`references/systems/gacha-loot.md`) — the heart: weighted roll + pity + the spin reveal. THE defining system.
2. **Currency + economy** (`references/systems/economy-currency.md`) — one field-bag holding all currency; buy rolls, sell drops, gold sinks.
3. **Inventory + equipment** (`references/systems/inventory.md`) — typed slots + a bag, with **fully derived total stats**.
4. **Procedural item generation** (no dedicated ref — covered below) — rarity-scaled base stats + random affixes (ARPG loot).
5. **Crafting / fusion** (`references/systems/crafting.md`) — combine N drops -> 1 better, steered by ingredient flags.
6. **Progression / rank** (`references/systems/progression-upgrades.md`) — level + a tiered rank that buffs rare-drop odds.
7. **Save + persist** (`references/systems/save-persistence.md`) — local-first with cloud-authoritative load; sanitize on read.
8. **Leaderboards** (`references/systems/leaderboards-services.md`) — `Sandbox.Services.Stats` with attached metadata for tooltips.
9. **Combat resolver** (no dedicated ref — covered below) — the OnUpdate() turn-based battle state machine (crawler only).
10. **Daily/timed rewards** (`references/systems/idle-offline.md` for the Unix-time stamp pattern) — login streaks, free cases.
11. **Social chat + broadcast events** (`references/systems/leaderboards-services.md` neighbors; pattern below) — shared lobby chat, loot/boss announcements.

## Build order

Build the slot machine before the RPG. Vertical-slice order:

**1. The roll (decoupled from any animation).** Rarity buckets via ascending cumulative thresholds, then pick within the bucket. Make it **seedable** if it must be host-validated.

```csharp
// Cumulative-threshold rarity: one roll vs ASCENDING cutoffs. Order matters.
public static ItemRarity RollLootboxRarity( Random rng )
{
    float roll = (float)rng.NextDouble();
    if ( roll < 0.0015f ) return ItemRarity.Divine;     // 0.15%
    if ( roll < 0.0025f ) return ItemRarity.Mythic;     // 0.25%
    if ( roll < 0.0225f ) return ItemRarity.Legendary;  // 2%
    if ( roll < 0.1225f ) return ItemRarity.Rare;       // 10%
    if ( roll < 0.4025f ) return ItemRarity.Uncommon;   // 28%
    return ItemRarity.Common;                            // 59.75%
}
```
(namicry.gacha_crawler: Code/Data/ItemGenerator.cs:936 RollLootboxRarity.) **CAUTION:** the sibling `RollRarity` (:912) checks Mythic at `< 0.6f` *before* Legendary at `< 0.12f` — a real shipped bug that makes Legendary/Rare **unreachable**. Cumulative thresholds only work ascending; copy the lootbox ordering. For per-item integer weights instead of rarity buckets, use the subtract-walk pick (lavagame.multis_cases: Code/Game/Economy/ItemDefinition.cs:117 RollWinner). Full treatment of both in `references/systems/gacha-loot.md`.

**2. Newcomer pity as consumable flags.** Two bools on the character (default `true`) that the roll *reads and reports consumption of* via a tuple; the caller burns the flag. Save-friendly, no counter, and the same flags can gate whether the player is allowed to skip the reveal (you must watch your guaranteed first legendary).

```csharp
public static (ItemRarity rarity, bool consumedLegendary, bool consumedMythic)
    RollLootboxRarityWithPity( bool hasLegendaryPity, bool hasMythicPity )
{
    float roll = (float)_random.NextDouble();
    if ( hasMythicPity && roll < 0.05f )    return (ItemRarity.Mythic, false, true);
    if ( hasLegendaryPity && roll < 0.13f ) return (ItemRarity.Legendary, true, false);
    // ...else fall through to the standard ascending thresholds...
    return (ItemRarity.Common, false, false);
}
```
(namicry.gacha_crawler: Code/Data/ItemGenerator.cs:953 RollLootboxRarityWithPity; caller burns the flag at GameManager.cs:2199, and CanSkipLootbox gates the skip at :2382.)

**3. Decide-then-animate reveal.** Generate ~100 filler items for the visual strip, drop the **real** result at a fixed index, set a `GameState.LootboxOpening` flag, and ease the scroll in `OnUpdate()` with ease-out-cubic. No tween library, no `MathF` needed.

```csharp
// In OnUpdate(), only while IsOpeningLootbox:
LootboxSpinProgress = Math.Clamp( LootboxSpinProgress + Time.Delta / SpinDuration, 0f, 1f );
float t = LootboxSpinProgress;
float eased = 1f - (1f - t) * (1f - t) * (1f - t);   // ease-out cubic
float offsetPx = MathX.Lerp( 0f, TargetOffsetPx, eased );
int idx = (int)(offsetPx / SlotWidthPx);
if ( idx != LastLootboxTickIndex ) { SoundManager.Instance?.PlayTick(); LastLootboxTickIndex = idx; }
if ( t >= 1f ) CompleteLootbox();
```
(namicry.gacha_crawler: Code/GameManager.cs:174 OnUpdate dispatch to UpdateLootboxSpin, :2181 StartLootbox places the winner at index 85, :2307 UpdateLootboxSpin easing.) **Keep the roll fully decoupled from this** — index 85, slot width, and the 350px center are hardcoded to the Razor strip CSS (mirrored in LootboxPanel.razor GetStripOffset). A CSS tweak must never be able to change odds.

**4. The economy field-bag.** ONE component holds every currency/total as plain fields, mutated through `AddGold`/`SpendGold`. In the single-player crawler these are unguarded fields; in the MP sim they become host-authoritative with optimistic local deducts (see netcode below).

```csharp
public int Gold { get; set; }
public void AddGold( int amount ) => Gold += (int)(amount * (1f + GoldBonus)); // GoldBonus% from gear/buffs
```
(namicry.gacha_crawler: Code/Models/PlayerCharacter.cs:191 AddGold applies a GoldBonus multiplier; sinks: SellItem, UpgradeItem, ResurrectionCost = level*25 at :332.) Details in `references/systems/economy-currency.md`.

**5. Derived-stat equipment.** Typed slot properties + a `List<GameItem>` bag. **Total stats recompute from scratch** = race base + class modifiers + per-level scaling + every equipped item's stats + buffs. Mark all computed props `[JsonIgnore]` to keep saves lean.

```csharp
[JsonIgnore] public CharacterStats TotalStats => CalculateTotalStats();

CharacterStats CalculateTotalStats()
{
    var s = RaceData.GetBase( Race ).Add( ClassData.GetModifiers( Class ) ).ScaleByLevel( Level );
    foreach ( var item in EquippedItems() ) s = s.Add( item.GetTotalStats() );
    foreach ( var buff in ActiveBuffs ) s = s.Add( buff.FlatStats );
    return s.ApplyPercent( ActiveBuffs );
}
```
(namicry.gacha_crawler: Code/Models/PlayerCharacter.cs:122 CalculateTotalStats, :225 EquipItem swaps slot + returns old to inventory + clamps health; CanEquip enforces level + class restrictions.) `TotalStats` is read many times per frame in battle — fine here, but **cache it for hot loops**. Note `CharacterStats.Add`/`Clone`/`StatsEqual` are hand-maintained field lists: adding a stat means editing 3 places. Slot/bag mechanics in `references/systems/inventory.md`.

**6. Procedural affix loot (the ARPG nugget).** Build a base item from rarity-scaled stats, then bolt on 0-N `ItemProperty` affixes (count scales by rarity). Each affix is a tuple of `(name, desc, apply-lambda, isPercent)` pulled from one table; the lambda mutates one stat field.

```csharp
// One row of the affix table: a stat mutation as data.
public record ItemProperty( string Name, string Desc,
    Func<CharacterStats,int,CharacterStats> Apply, bool IsPercent );

static GameItem GenerateWeapon( int level, ItemRarity rarity )
{
    var item = new GameItem { /* rarity-scaled base attack/level */ };
    int affixCount = AffixCountFor( rarity );          // more affixes at higher rarity
    for ( int i = 0; i < affixCount; i++ )
        item.Properties.Add( ItemProperty.GenerateProperty( rarity ) );  // random row + rolled value
    return item;
}
```
(namicry.gacha_crawler: Code/Models/GameItem.cs:40 ItemProperty.GenerateProperty 23-entry table, Code/Data/ItemGenerator.cs:367 GenerateWeapon, :733 GenerateProperties.) Strip this game's `fc####` sprite-path coupling (a whole `FixSpritePath` migration pass exists for it) — that's asset-layout-specific, not reusable.

**7. Crafting / fusion steered by a `[Flags]` enum.** Combine N same-rarity items -> 1 of rarity+1; an optional ingredient forces the output (class-match, slot-type, tier-lock, affix-reroll) via `HasFlag`.

```csharp
[Flags] public enum CraftIngredientEffect
{ None=0, ClassMatch=1, TierGuarantee=2, WeaponType=4, ArmorType=8, JewelryType=16, PropertyReroll=32 }

// In GenerateCraftedItem: read effects.HasFlag(...) to constrain the roll.
if ( effects.HasFlag( CraftIngredientEffect.WeaponType ) ) forcedType = ItemType.Weapon;
if ( effects.HasFlag( CraftIngredientEffect.ClassMatch ) ) forcedClass = player.Class;
```
(namicry.gacha_crawler: Code/GameManager.cs:1913 CraftItems, Code/Data/CraftIngredientData.cs:183 GetEffectsForTier maps (type,tier)->effects, Code/Data/ItemGenerator.cs:1210 GenerateCraftedItem.) **Guard generation first in a copy** — fusion consumes the inputs before generating, so a null generate loses materials. More in `references/systems/crafting.md`.

**8. Combat as an OnUpdate() state machine (crawler only).** `OnUpdate()` dispatches to `UpdateBattle()` when fighting; a `BattlePhase` enum (Walking -> Combat -> Victory/Defeat) is advanced by timers, alternating player/monster attacks. The damage formula is a tuned standalone worth lifting:

```csharp
// Percentage damage reduction, then crit. (Magic branch swaps Attack->MagicAttack, Defense->MagicDefense.)
int baseDamage = (int)(playerStats.Attack * weaponEfficiency);
float reductionPercent = relevantDefense / (float)(relevantDefense + 50 + ActiveCharacter.Level * 5);
int dmg = (int)(baseDamage * (1f - reductionPercent));
if ( Game.Random.Float() < playerStats.CritChance ) dmg = (int)(dmg * playerStats.CritDamage);
```
(namicry.gacha_crawler: Code/GameManager.cs:167 OnUpdate dispatch, :1137 UpdateBattle phases, :1288 ExecutePlayerAttack damage + dodge-vs-accuracy + crit; Code/Enums/GameEnums.cs:93 BattlePhase.) **All battle state is mutable fields on the one GameManager** — single-fight-at-a-time, each client simulates its own (not networked). Lift the formula + timers into a standalone `CombatResolver` if you want concurrent or server-validated fights.

## The defining UI-binding pattern: one Component, `event Action`, Razor reads it

Both games (and especially the crawler) put **all logic + state on one `partial class GameManager : Component` singleton** with public mutable fields, and bind the Razor UI through plain C# `event Action` hooks — no per-entity GameObjects, no `[Net]`/data-binding ceremony. Models are POCOs, not Components.

```csharp
public partial class GameManager : Component
{
    public static GameManager Instance { get; private set; }
    public Action OnStateChanged { get; set; }      // Razor panels subscribe in OnAfterTreeRender
    public Action OnInventoryUpdated { get; set; }
    public Action OnLootboxUpdated { get; set; }

    protected override void OnAwake() => Instance = this;
    // Every mutator that changes visible state fires the matching hook:
    void SelectCharacter( int slot ) { ActiveCharacter = SavedCharacters[slot]; OnStateChanged?.Invoke(); }
}
```
(namicry.gacha_crawler: Code/GameManager.cs:10 singleton + field-bag, :125 the `Action` hooks, :611+ `OnStateChanged?.Invoke()` peppered through mutators, :167 the single OnUpdate dispatch.) This is the **opposite** of s&box's usual "many small Components" style and is *highly effective for a UI-only game*: trivial to serialize (one object graph), no GameObject churn, one OnUpdate drives gacha + battle + crafting. The Razor panel subscribes to the `Action` and calls `StateHasChanged()`.

## Netcode you'll need (sim posture only)

If your rolls have value (lavagame.multis_cases), layer host authority over the same single-player economy code:

**Optimistic deduct -> host validate -> SafeRefund.** Client deducts its own balance locally (zero perceived latency, identical to SP), sends `[Rpc.Host]` with a *declared* cost; the host re-validates against its authoritative case DB, rolls server-side, and `[Rpc.Broadcast]`es the result. **Every host validation-failure branch must refund** — the client already spent.

```csharp
[Rpc.Host]
void RequestSpin( string caseId, long declaredCost )
{
    var def = ServerCases.Find( caseId );
    if ( def is null || declaredCost != def.Price ) { SafeRefund( Rpc.CallerId, declaredCost ); return; }
    var winner = def.RollWinner( ServerRng );        // host rolls, source of truth
    BroadcastSpinResult( Rpc.CallerId, winner.Id );
}
```
(lavagame.multis_cases: Code/Game/Core/GameManager.cs:1084 RequestSpin + validate, Code/Game/Gambling/CaseBattleManager.cs:99 optimistic deduct.) See `references/systems/gacha-loot.md` for the full host-authoritative + jackpot/case-battle treatment, and `references/systems/save-persistence.md` for the local-first/cloud-authoritative-load + disconnect-safe pending-win ACK pattern.

**Async snapshot PvP (the elegant crawler reuse).** Don't write a PvP combat path. Fetch an opponent's serialized stats, synthesize a **one-Monster dungeon** from them, and call the exact same `StartDungeon` flow. "PvP" becomes "fight a snapshot" — no live opponent, no netcode, full reuse of the battle state machine.
(namicry.gacha_crawler: Code/GameManager.cs:974 StartArenaBattle builds a DungeonQuest from opponent TotalStats; win-chance from a symmetric power ratio `p/(p+o)`.) **Do not copy its security** — it mutates and re-uploads the *opponent's* save from the attacker's client (no server authority); trivially cheatable. Treat as a design idea only.

## Standout patterns worth copying

- **Decide-then-animate gacha:** roll the real winner first, drop it at a fixed strip index, ease the scroll analytically in OnUpdate — animation is cosmetic and can't change odds (namicry: GameManager.cs:2181, :2307).
- **Pity as consumable bools:** first-time `Has*PityBonus` flags the roll reads + reports-consumed via a tuple; ties UX (must-watch reveal) to the flag, no counter, save-trivial (namicry: ItemGenerator.cs:953).
- **Affix-as-data:** the loot table is `(name, desc, Func<Stats,int,Stats>, isPercent)` rows — one array drives all generation + display (namicry: GameItem.cs:40).
- **Fully-derived stats:** never store totals; recompute from base+gear+buffs and `[JsonIgnore]` it. Lean saves, no desync between equipped and effective (namicry: PlayerCharacter.cs:122).
- **One partial Component + event Action UI bus:** the whole game on one singleton, Razor binds via `Action` hooks — the right call for a UI-only gacha game (namicry: GameManager.cs:10, :125).
- **Reuse PvE combat as PvP via a one-enemy synthesized quest** (namicry: GameManager.cs:974).
- **Ship rich objects through `[Rpc.Broadcast]` as flattened JSON-string params, rehydrate on receive** — complex types don't round-trip over RPC, so loot/chat events pass ~12 primitive params + embedded StatsJson, and the receiver rebuilds the item for tooltips (namicry: Code/ChatManager.cs:95 SendLootboxMessage, :469 GetGameItem; the `Entries` list is NOT `[Sync]`, so late joiners get no history — consistency relies on every client receiving the broadcast).
- **Rank-buffed odds:** rebuild the weight array multiplying rare tiers by a `1.0-1.5x` rank bonus before the roll (lavagame: ItemDefinition.cs:136 RollWinner(rng, PlayerRank)).
- **Daily streak on UtcNow.Date:** consecutive day -> streak++ (wrap at 7), gap -> reset; client wall-clock is farmable, so move server-side for anything that matters (namicry: GameManager.cs:830 CheckDailyReward).
- **Leaderboard with attached metadata:** `Stats.SetValue(name, value, extendedDataDict)` attaches a small `Dictionary<string,object>` of character info for tooltip display; read back via `Leaderboards.GetFromStat` with `SetAggregationLast()` + `SetSortDescending()`; guard with `Game.IsEditor` to avoid polluting boards (namicry: Code/Services/LeaderboardService.cs:27; see `references/systems/leaderboards-services.md`).

## Things NOT to copy

- A **hardcoded Bearer API token** is committed in the crawler's GameManager — never copy that; use a backend the player can't read the key for, or s&box's own services (namicry: summary).
- The `RollRarity` **overlapping-threshold bug** (Legendary/Rare unreachable) — copy `RollLootboxRarity`'s ordering (namicry: ItemGenerator.cs:912 vs :936).
- **Client-authoritative economy/streaks/arena** — fine for free single-player QoL, never for anything with value. The sim game shows the host-authoritative alternative.
- `Game.Random` vs `new Random()` used inconsistently — pick **seeded `Random`** for anything host-validated/replayable, `Game.Random` only for cosmetic local picks.

## Verify live

The installed SDK is authoritative — confirm with `describe_type` / `search_types` reflection before relying on a signature, not this doc or training data: `Component`, `[Sync]` / `[Rpc.Host]` / `[Rpc.Broadcast]`, `Component.INetworkListener`, `Sandbox.Services.Stats` + `Leaderboards.GetFromStat`, `Game.Random` / `Random.Shared`, `MathX.Lerp` / `Time.Delta`, and `[JsonIgnore]` (System.Text.Json). Note the s&box **sandbox restricts `MathF`** — the `1-(1-t)^3` easing and `(float)Math.Pow(...)` are the safe forms. Stop play mode before scene edits; screenshot UI changes and read the PNG.

Cross-links: see the **sbox-api** skill for authoritative type/method signatures, and the **sbox-build-feature** skill for the screenshot-driven build loop and the sandbox gotcha list (MathF restricted, Cloud assets ephemeral, head-bone case sensitivity).

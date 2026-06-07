# Roleplay / DarkRP Recipe

How to build a persistent, host-authoritative roleplay sandbox (DarkRP-style) in modern s&box (GameObject/Component/Scene), distilled from `artisan.darkrpog` — a 2,517-file production DarkRP framework. Most of its *content* (drugs, casino, jobs) is genre-specific; its *plumbing* (persistence, host-authority, data-as-assets, interaction) is reusable for any persistent multiplayer game.

## What defines the genre

A roleplay game is a **persistent, shared world where players assume jobs, earn and spend money, own placed objects, and interact through proximity prompts + chat commands** — and all of it survives a server restart. There is no win state; the loop is open-ended social/economic simulation. Three properties separate it from a tycoon or a round-based game:

- **Persistence is the whole point.** Player wallets, owned props/printers, and world state must outlive disconnects *and* server restarts. This forces a per-player save (keyed by SteamId) **and** a world save, plus a stable identity layer for runtime-spawned objects.
- **Host owns every gameplay mutation.** Clients see state via `[Sync(SyncFlags.FromHost)]` (display-only) and request changes via RPCs the host re-validates. There is no trusted client.
- **Content is authored as assets, not code.** Jobs, printers, lootboxes, skills, daily rewards are `GameResource` definition files (`.jobdef` etc.) so designers add content without recompiling.

**Core loop:** `spawn → pick a job (salary) → earn money (printers/skills/jobs) → spend (items/upgrades/bank) → own placed objects → disconnect/restart → reload exactly where you left off`. Everything else is scaffolding around that loop.

## The one idiom that makes it work: host-authoritative money

Internalize this before writing anything else. The value is a `[Sync(FromHost)]` property with a private setter; *every* mutator is gated on `Networking.IsHost`, overflow-checked, and saves immediately. Clients can read but never write.

```csharp
public sealed partial class Player  // Player is a Component
{
    [Property, Sync( SyncFlags.FromHost )]
    public long Money { get; private set; } = RoleplayEconomyDefaults.StartingWallet;

    public bool CanAfford( long amount ) => amount >= 0 && amount <= Money;

    public void GiveMoney( long amount )
    {
        if ( !Networking.IsHost || amount <= 0 ) return;
        if ( Money > long.MaxValue - amount ) return;   // overflow guard
        Money += amount;
        SaveRoleplayData();                              // persist on every change
    }

    public bool TryTakeMoney( long amount )              // validate-then-apply, never throw
    {
        if ( !Networking.IsHost || amount < 0 || !CanAfford( amount ) ) return false;
        Money -= amount;
        SaveRoleplayData();
        return true;
    }
}
```
(artisan.darkrpog: Code/Player/Player.Roleplay.cs:9 sync prop, :20 GiveMoney, :35 TryTakeMoney) — use `long`, not `float`, for currency; overflow-check additions; `SetMoney` floors at `0` (:48). Higher-level ops (bank deposit/withdraw) return a **result enum** with a `DescribeFailure` enum→string mapping rather than booleans, so the UI can show *why* it failed (input: Code/Economy/Bank/BankingService.cs:13).

See `references/systems/economy-currency.md` for the general host-authoritative-currency pattern.

## The system stack to compose

Build each as a `Component` or a static service. References point to existing system docs.

| System | Role | Reference |
|---|---|---|
| Host-authoritative wallet | `long Money`, `[Sync(FromHost)]`, gated mutators | `references/systems/economy-currency.md` |
| Per-player persistence (versioned) | One JSON/SteamId, migration ladder, swappable repo | `references/systems/save-persistence.md` |
| World save (scene-diff) | Serialize live scene, diff vs SceneFile baseline | `references/systems/save-persistence.md` |
| Persistent world-entity identity | Stable `Guid` so placed props survive restart | `references/systems/save-persistence.md` |
| GameResource content definitions | Jobs/printers/lootboxes/skills as `.def` assets | `references/systems/inventory.md` |
| Interaction / use-prompt | `Component.IPressable`, live tooltip, tap-vs-hold | `references/systems/inventory.md` |
| Spawnable router | `ISpawner` + ident-string → spawn + authorize | `references/systems/building-placement.md` |
| Idle income generator (printer) | Passive earner w/ upgrade tree + risk | `references/systems/idle-offline.md` |
| Weighted loot table (gacha) | Lootbox/drop roller | `references/systems/gacha-loot.md` |
| Skill/XP progression | XP w/ per-source anti-farm caps | `references/systems/progression-upgrades.md` |
| Daily login streak | Retention loop, UTC day-keyed | `references/systems/idle-offline.md` |
| Chat slash-command router | `/job`, `/drop`, `/pm`… dispatch table | — (below) |

## Build order

Build single-player-feeling first; the host-authority idiom makes co-op "free" because `!Networking.IsHost` short-circuits true offline (host == local player).

1. **Player component + wallet.** `Money` as above. Everything reads/writes through gated mutators.
2. **Per-player persistence.** A serializable record keyed by SteamId, one JSON file per player, with a `CurrentVersion` + migration ladder. Wallet saves call this.
3. **Job definitions as assets.** `JobDefinition : GameResource` with `[Property]` fields (Salary, Title, Clothing…). `/job <name>` sets it; salary ticks pay it.
4. **Interaction layer.** `Component.IPressable` on everything pressable (doors, ATMs, machines) with a live tooltip. This is the "press E" verb of the whole game.
5. **Spawnable router.** An `ISpawner` abstraction + a central spawn RPC that parses an ident string, traces placement from the player's eyes, authorizes, then spawns.
6. **Persistent world identity.** Stamp a stable `Guid` on every player-placed object so the world save can re-own it after a restart.
7. **World save.** Scene-diff serialize so the whole map state round-trips.
8. **Income + economy content.** Printers (idle earners), lootboxes (gacha), skills (XP), daily rewards — each a definition asset + a service.
9. **Chat command router** for the social/admin verbs.

## How the real game does each piece

### Interaction — `Component.IPressable` with a live tooltip
The genre's core verb. Implement `Component.IPressable`; the engine drives Hover/CanPress/Press/Pressing/Release for you. `GetTooltip` returns a `Tooltip(title, icon, subtitle)` rendered as the world-space "press E" prompt — and the **subtitle is computed live** (price, owner status, your balance). Tap-vs-hold is just timing inside `Pressing`.

```csharp
public sealed class SlotMachineInteractable : Component, Component.IPressable
{
    const float OwnerManageHoldSeconds = 0.65f;
    TimeSince _timeSincePressed;
    bool _ownerMenuOpened;

    Component.IPressable.Tooltip? Component.IPressable.GetTooltip( Component.IPressable.Event e )
    {
        var player = ResolvePlayer( e );                       // resolve who is looking
        var bet = SlotMachineBetSelectionState.GetSelectedBet( Machine, player );
        return new Component.IPressable.Tooltip( "Play Slots", "casino",
            $"Tap E: spin ${bet:n0} | Hold E: manage" );        // live subtitle
    }

    bool Component.IPressable.Press( Component.IPressable.Event e )
    {
        _timeSincePressed = 0; _ownerMenuOpened = false; return true;
    }

    bool Component.IPressable.Pressing( Component.IPressable.Event e )
    {
        if ( !_ownerMenuOpened && _timeSincePressed >= OwnerManageHoldSeconds )
        {
            OpenManagementConsole( ResolvePlayer( e ) );        // hold → manage
            _ownerMenuOpened = true;
        }
        return true;
    }
}
```
(artisan.darkrpog: Code/Items/Casino/SlotMachineInteractable.cs:6 class, :19 GetTooltip, :46 Press, :62 Pressing hold-detect) — resolve the presser with `e.Source.GameObject.Root.GetComponent<Player>()`. Press/Pressing run on the *pressing client*; the actual gameplay effect (spin, buy) is sent as an RPC the host re-validates. Suppress the prompt (`return null`) when the player's cursor is on a clickable WorldPanel so the prompt and UI don't fight.

### Content as assets — `GameResource` definitions
Make each job/printer/lootbox an authorable asset. Designers drop files; no code change.

```csharp
[AssetType( Name = "DarkRP Job", Extension = "jobdef", Category = "DarkRP",
            Flags = AssetTypeFlags.NoEmbedding | AssetTypeFlags.IncludeThumbnails )]
public sealed class JobDefinition : GameResource, IDefinitionResource
{
    [Property] public string Id { get; set; }
    [Property] public string Title { get; set; }
    [Property] public int Salary { get; set; } = 45;
    // …Clothing, RequiredEntitlements, SkillRequirements, PlayerModel…
}

// Enumerate every authored job:
var jobs = ResourceLibrary.GetAll<JobDefinition>();
```
(artisan.darkrpog: Code/Jobs/JobDefinition.cs:1 AssetType, :6 fields) — the same pattern recurs for MoneyPrinterDefinition, LootboxCaseDefinition, SkillTreeDefinition, DailyLoginRewardDefinition. **Gotcha:** never cache an empty `GetAll()` — an early caller (hotload race, chat tick) can run before GameResources are indexed and permanently empty your catalog; guard against caching a zero-length result.

### Weighted loot table — the gacha roller
Pure, engine-free, trivially reusable for any drop table / shop restock / random spawn. Returns a `.Clone()` so callers can't mutate the catalog.

```csharp
public static LootboxRewardSpec Roll( IReadOnlyList<LootboxRewardSpec> rewards, Random rng = null )
{
    rng ??= Random.Shared;                                  // pass a seeded Random for replayable rolls
    var valid = rewards.Where( x => x?.Reward is not null && x.Weight > 0f ).ToArray();
    if ( valid.Length == 0 ) return null;

    var total = valid.Sum( x => x.Weight );
    var roll = (float)(rng.NextDouble() * total);
    var cumulative = 0f;
    foreach ( var r in valid )
    {
        cumulative += r.Weight;
        if ( roll <= cumulative ) return r.Clone();         // defensive copy
    }
    return valid[^1].Clone();                                // edge-case fallback
}
```
(artisan.darkrpog: Code/Lootboxes/LootboxRoller.cs:8) See `references/systems/gacha-loot.md`.

### Idle income — the MoneyPrinter (and the bucketed-`[Sync]` perf trick)
A printer accumulates `StoredMoney` on a cadence, has integer upgrade levels (Speed/Yield/Capacity), and a Heat mechanic that can catch fire. Its single most reusable lesson is **bucketed `[Sync]` writes**: for a value that changes every fixed tick, accumulate a local delta and only write the `[Sync]` property when it crosses a threshold — otherwise you ship a network packet to every viewer 60×/sec for a fractional change.

```csharp
// Wave 10 PERF-B: bucket per-fixed-tick Heat cooldown so we don't [Sync]-spam 60x/sec.
float _accumulatedCoolDelta;
const float HeatCoolFlushThreshold = 0.25f;
// …accumulate _accumulatedCoolDelta each tick; only when it crosses the threshold
//   do you write the [Sync(FromHost)] Heat property and reset the accumulator.
```
(artisan.darkrpog: Code/Items/MoneyPrinter.cs:3 class, :47 heat-bucket field+comment) — upgrade levels live on the *entity*, not the player, so they persist with the world object. See `references/systems/idle-offline.md`.

### Persistent world-entity identity — durable IDs for placed objects
`GameObject.Id` is **not** durable across restarts. To save the world you need your own stable identity layer: a `Guid` stamped on every player-placed object, plus Kind/Owner/SchemaVersion, all `[Sync(FromHost)]`.

```csharp
public sealed class PersistentWorldEntity : Component
{
    [Property, Sync( SyncFlags.FromHost )] public Guid PersistentId { get; set; } = Guid.NewGuid();
    [Property, Sync( SyncFlags.FromHost )] public string Kind { get; set; } = WorldEntityKinds.GenericOwnable;
    [Property, Sync( SyncFlags.FromHost )] public long OwnerSteamId { get; set; }

    public static PersistentWorldEntity Ensure( GameObject go, string kind, Connection owner = null )
    {
        var marker = go.GetOrAddComponent<PersistentWorldEntity>();   // add-or-get
        marker.Kind = kind;
        marker.PersistAcrossRestart = true;
        if ( owner is not null && owner.SteamId.Value > 0 )
            marker.OwnerSteamId = (long)owner.SteamId.Value;          // re-own after restart
        return marker;
    }
}
```
(artisan.darkrpog: Code/Persistence/World/PersistentWorldEntity.cs:6 class, :82 Ensure) — on destroy, record a *tombstone* (`MarkDestroyed`) so the deletion is replayed on the next load; compact tombstones or the log grows unbounded.

### World save — scene-diff against a baseline
`SaveSystem : GameObjectSystem<SaveSystem>` serializes the live scene to JSON and **diffs it against a baseline rebuilt from the original SceneFile**, writing only the patch (plus NetworkOwnership by SteamId, a separate `[Sync]`-state capture, and required cloud packages). Load applies the patch back onto the SceneFile, `Game.ChangeScene` loads it, then `[Sync]` values + ownership are restored. Components hook the lifecycle via `ISaveEvents` (BeforeSave/AfterSave/BeforeLoad/AfterLoad).

```csharp
Scene.RunEvent<ISaveEvents>( x => x.BeforeSave( path ) );
var baseline = BuildCompositeBaseline();                  // rebuilt from the source SceneFile(s)
// Json.CalculateDifferences(baseline, current, …) → write only the patch
```
(artisan.darkrpog: Code/Save/SaveSystem.cs:128 Save, :695 CollectSyncState) — **only objects originating from a tracked SceneFile get diffed**; runtime-spawned objects rely on the SyncState/ownership side-channels + your `PersistentWorldEntity` layer, *not* the diff. Save version is hard-pinned: a mismatched version refuses to load. Host-only. See `references/systems/save-persistence.md`.

### Per-player persistence — versioned, with a migration ladder
A plain serializable record keyed by SteamId, one JSON file per player, written through a **swappable repository** (`IPlayerStorage` — production hits the disk filesystem; tests swap an in-memory one). Loads run an append-only migration ladder that fills new fields with defaults.

```csharp
static PlayerRoleplaySaveData TryMigrate( PlayerRoleplaySaveData loaded )
{
    if ( loaded.Version < 2 ) { loaded.Bank = 0; loaded.Version = 2; }   // each rung fills new fields
    if ( loaded.Version < 3 ) { /* … */ loaded.Version = 3; }
    // … up to CurrentVersion. NEVER reorder rungs — the ladder is append-only.
    return loaded;
}
```
(artisan.darkrpog: Code/Player/Persistence/PlayerRoleplayStorage.cs:297 TryMigrate, :193 TryLoad; IPlayerStorage.cs:14) — write backup-first (`.bak.json` then primary). See `references/systems/save-persistence.md`.

### Chat slash-command router
Parse `/text` into a command, build a context (connection, resolved Player, args, reply helpers), then walk a flat dispatch table of `(name + aliases, handler)`. Fall through to job-change commands resolved from the `JobDefinition` catalog, else reply "unknown command". **Host-only.**

```csharp
public static bool TryHandle( Connection source, string text )
{
    if ( !Networking.IsHost ) return false;                 // host owns command handling
    var parsed = RoleplayChatCommandParser.Parse( text );
    if ( !parsed.IsCommand ) return false;

    var ctx = new RoleplayChatCommandContext( source, Player.FindForConnection( source ), parsed );
    foreach ( var cmd in GetCommandDefinitions() )          // flat (name+aliases, handler) table
        if ( cmd.Matches( ctx.CommandName ) ) { cmd.Execute( ctx ); return true; }

    if ( RoleplayJobCommandCatalog.TryResolve( JobDefinition.GetAll(), ctx.CommandName, out var job ) )
    { ctx.Player.ProcessSetJobRequest( job ); return true; } // /<jobname> → switch job
    ctx.ReplyError( "Unknown command." );
    return true;
}
```
(artisan.darkrpog: Code/Chat/RoleplayChatCommandService.cs:29 TryHandle, :65 command table) — the context carries `Reply`/`ReplyError` helpers so handlers don't reimplement messaging. Job names double as commands (`/police`).

## Standout discipline worth copying

These are what make a roleplay server survive 128 players and not lose saves.

- **Wrap + time every join/spawn/disconnect hook individually.** `PostSpawnSafe(name, work)` runs each step inside a try/catch + Stopwatch, logging a throw and continuing instead of kicking the player or aborting the save chain, and warning on any step over a ms threshold. Turns "a regression anywhere in a 20-step spawn = mass kicks" into "one named feature degrades in the log" (input: Code/GameLoop/GameManager.cs:658 PostSpawnSafe, :400 DisconnectSafe).
- **Stripe heavy per-tick services one-per-frame.** A `StrideScheduler` runs exactly one registered service per frame, so 6 heavy services at 50 Hz each effectively run ~8.3 Hz — spreads CPU instead of spiking when everything ticks the same frame (input: Code/GameLoop/GameManager.cs:16, :450).
- **Service / pure-rules / definition split.** Almost every feature is three classes: a `*Service` (engine-touching orchestration), a pure `*Rules`/`*Validator` (no Sandbox deps, returns enums/records — unit-testable headless), and a `GameResource *Definition` asset. All the math/edge-cases live in the pure layer (input: BankingService→BankAmountValidator).
- **Drain mass operations one-per-tick.** AfterLoad respawns 128 players via a queue drained one per frame; disconnect saves snapshot now / write next tick — all to avoid tripping the engine's hard ~10 s server-frame timeout during a mass join/restart (input: Code/GameLoop/GameManager.cs:713, :733).

## Pitfalls (from the mined code)

- Money mutators silently no-op on non-host — UI buttons **must** fire an RPC the host re-validates, never call `GiveMoney`/`TryTakeMoney` on a client.
- `SyncFlags.FromHost` means the client value is **display-only**; authoritative state lives on the host. Never trust a client-reported balance.
- Every mutator saving synchronously causes save thrash — **batch** multi-step operations (one save at the end, not per sub-step).
- `GameObject.Id` is **not** durable across restarts — placed objects need a `PersistentWorldEntity`-style `Guid` or they orphan on reload.
- Never cache an empty `ResourceLibrary.GetAll<T>()` result (hotload/early-tick race permanently empties the catalog).
- The migration ladder is **append-only** — reordering a rung corrupts older saves.
- The spawn RPC is `async void`; **wrap it in try/catch** — an exception in an async-void RPC entry point vanishes into the SynchronizationContext with no diagnostic.
- Don't `[Sync]`-write a rapidly-changing float every tick — bucket the delta and flush past a threshold.

## Verify live

API surfaces drift between SDK versions — confirm before relying on a signature. Use `describe_type` / `search_types` reflection against the installed SDK as authoritative for: `Sandbox.Networking` (`IsHost`/`IsActive`), `[Sync]`/`SyncFlags.FromHost`/`[Rpc.Host]`/`[Rpc.Broadcast]`, `Component.IPressable` (and its nested `Tooltip`/`Event` types), `GameResource` + `[AssetType]` (`Name`/`Extension`/`Category`/`Flags`), `ResourceLibrary.GetAll<T>`, `GameObjectSystem<T>`, `Json.CalculateDifferences`/`Json.ApplyPatch`, `Game.ChangeScene`, `Connection`/`SteamId`, `GameObject.GetOrAddComponent`, and `Scene.Trace.Ray(...)` for eye-trace placement.

Cross-links: see the `sbox-api` skill for authoritative type lookups, and the `sbox-build-feature` skill for the screenshot-driven build/iterate loop.

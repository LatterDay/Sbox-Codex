# Idle / Offline Income Systems

How to build passive-income generators, idle-tick earners, and offline/disconnect-safe reward delivery in modern s&box (GameObject/Component/Scene).

## What this is and when you need it

An **idle system** keeps producing value while the player is busy or away: money printers, worker drones, passive case-cracking income, tycoon shops. Two distinct concerns hide under "idle/offline":

1. **Idle production while connected** — a host-authoritative component ticks on a cadence and accumulates a stored value the player collects. (`MoneyPrinter`, `multis_cases` worker slots.)
2. **Offline / disconnect durability** — surviving a relog or server restart: persistent IDs for placed earners, and at-least-once delivery of rewards earned while the player was gone.

Almost every s&box "idle" implementation in the corpus simulates only **live frames** — none replay elapsed wall-clock time on load (see Gotchas). If you want true "earned while logged off," you build it yourself from a saved timestamp.

## Canonical approach

### 1. The idle-tick generator (host-authoritative, capped store)

A `Component` whose production runs **only on the host**, on a `NextPrintAt` cadence, accumulating into a `[Sync]` store the player later collects. This is the cleanest reusable shape (artisan.darkrpog: `Code/Items/MoneyPrinter.cs:371`).

```csharp
public sealed class IdleGenerator : Component
{
    [Sync( SyncFlags.FromHost )] public int   StoredMoney  { get; set; }
    [Sync( SyncFlags.FromHost )] public float NextPrintAt  { get; set; }
    [Property] public int   MoneyPerTick   { get; set; } = 10;
    [Property] public int   MaxStored      { get; set; } = 1000;
    [Property] public float TickInterval   { get; set; } = 5f;

    protected override void OnFixedUpdate()
    {
        if ( !Networking.IsHost ) return;            // host owns all production
        if ( Time.Now < NextPrintAt ) return;        // not time yet

        Produce();
        NextPrintAt = Time.Now + TickInterval;       // schedule next tick
    }

    void Produce()
    {
        if ( StoredMoney >= MaxStored ) return;                       // capacity clamp
        int amt = Math.Min( MoneyPerTick, MaxStored - StoredMoney );
        StoredMoney += amt;
    }
}
```

Production is gated `if ( !Networking.IsHost ) return;` and the schedule lives in a synced float, so clients only ever *read* `StoredMoney` and `SecondsUntilNextPrint` for UI (`MoneyPrinter.cs:373` host gate, `:388` time check, `:1045` capacity clamp). The store is **capped** so an idle earner can't run away while unattended — collection empties it.

A read-only countdown for the HUD is derived, never networked separately:

```csharp
public float SecondsUntilNextPrint =>
    NextPrintAt <= 0f ? 0f : Math.Max( 0f, NextPrintAt - Time.Now );
```

(MoneyPrinter.cs:160)

### 2. Upgrade levels live on the earner, not the player

Each upgrade line is an integer `[Sync]` level on the component, and the live stat is **derived** from the level via a geometric cost curve. Storing levels on the entity is what makes them persist with a world-placed object (artisan.darkrpog: `MoneyPrinter.cs:82-95`; master.digging_simulator: `ShopTerminal.cs:49`).

```csharp
[Sync( SyncFlags.FromHost )] public int SpeedLevel { get; set; }
[Sync( SyncFlags.FromHost )] public int YieldLevel { get; set; }

// canonical idle/tycoon pricing: BaseCost * mult^level
int GetCost( int baseCost, float mult, int level ) =>
    (int)(baseCost * MathF.Pow( mult, level ));
```

### 3. Live-frame accrual variant (no per-instance component)

When income is a single global rate (assigned workers, staked items), accumulate into an unclaimed bucket each frame and let the player claim manually (lavagame.multis_cases: `GameManager.cs:399`).

```csharp
protected override void OnUpdate()
{
    if ( WorkerSlots.Count == 0 ) return;
    float income = PassiveIncome;            // see formula below
    UnclaimedBalance += income * Time.Delta; // accrue this frame only
}

public float PassiveIncome =>
    WorkerSlots.Sum( i => MathF.Sqrt( i.SellValue ) * WORKER_RATE ) * PassiveMultiplier;
```

The `MathF.Sqrt(value)` compresses whale advantage — a deliberate balance choice (`GameManager.cs:66`). `ClaimPassiveIncome()` moves `UnclaimedBalance` into `Balance`. **Note:** `MathF` is available here but is *blocked in the sandbox whitelist for some games* — verify with `describe_type` before relying on it; `System.Math` is always safe.

### 4. Offline durability part A — persistent identity for placed earners

`GameObject.Id` is **not** durable across a server restart. A world-placed printer needs its own stable id to be re-owned and re-loaded (artisan.darkrpog: `Code/Persistence/World/PersistentWorldEntity.cs:6`).

```csharp
public sealed class PersistentWorldEntity : Component
{
    [Property, Sync( SyncFlags.FromHost )] public Guid   PersistentId  { get; set; }
    [Property, Sync( SyncFlags.FromHost )] public long   OwnerSteamId  { get; set; }

    public static PersistentWorldEntity Ensure( GameObject go, long owner )
    {
        var e = go.Components.GetOrCreate<PersistentWorldEntity>();
        if ( e.PersistentId == Guid.Empty ) e.PersistentId = Guid.NewGuid();
        e.OwnerSteamId = owner;
        return e;
    }
}
```

### 5. Offline durability part B — at-least-once reward delivery (ACK pattern)

If a reward resolves while the recipient is offline, persist the payload to host disk and re-deliver on reconnect — keep it in the pending map **until the client ACKs**, so a second disconnect can't lose it (lavagame.multis_cases: `GameManager.cs:174`, `:210`).

```csharp
const string PendingFile = "pending_wins.json";
static Dictionary<ulong, string> _pending;

static void SavePending() =>
    FileSystem.Data.WriteAllText( PendingFile,
        System.Text.Json.JsonSerializer.Serialize( _pending ) );

// host calls on player connect:
public static void TryGrantPending( ulong steamId, GameManager host )
{
    if ( !_pending.TryGetValue( steamId, out var payload ) ) return;
    host.GrantWin( steamId, payload );   // re-send; KEEP entry until ACK
}

[Rpc.Host]                               // client acks once it has the item
public void AckWin( ulong steamId )
{
    if ( _pending.Remove( steamId ) ) SavePending();
}
```

`FileSystem.Data` is the host-side persistent store. ACK-before-delete = at-least-once delivery; the client dedupes by a unique item id (`GameManager.cs:215`).

## Variations seen across games

- **Risk/heat sink** — `MoneyPrinter` adds `Heat += perTick` in `Produce()`, catches fire over a threshold, then explodes after a grace window, forcing the player to come collect (artisan.darkrpog: `MoneyPrinter.cs:1055`, `:1062`). Turns a passive earner into an active-attention loop.
- **Bucketed sync for rapid floats** — heat cools every fixed tick, but the `[Sync]` write is deferred until the accumulated delta crosses `HeatCoolFlushThreshold` (0.25), so it doesn't spam a packet 60×/sec (artisan.darkrpog: `MoneyPrinter.cs:47-52`). Reuse this for any fast-changing networked float.
- **Synced-timer phase machine** — instead of `async` delays, drive idle phases off a `[Sync] TimeUntil` + enum so a mid-game joiner reads the synced timer and stays in phase (vidya.terry_games: `RedLightGreenLight.cs:164`, `ColorShuffle.cs:66`). Host-only; sync **both** the enum and the `TimeUntil`.
- **Worker-drone automation** — autonomous host-only FSM workers pull from a static job queue with claim-locking instead of a fixed rate (enifun.shop_manager: `RestockEmployeeAI.cs:212`; emg.everything_must_go: `Worker.cs:94`, `Shop.cs:275`). All reservation/queue state is `static`, so it must be cleared on save-load before respawning workers.
- **Spawner scaling + daily event** — spawn rate/cap scale off progression with a once-per-day rush-hour multiplier rolled against `Game.Random` (enifun.shop_manager: `CustomerSpawner.cs:238`).
- **Live external data with TTL cache** — fetch a loot catalog over `Http` and cache to `FileSystem.Data` with a 7-day TTL so offline/rate-limited starts still work (lavagame.multis_cases: `Cs2CaseApiBuilder.cs:11`).
- **Floating "+$" UI** — a `LastBalanceDelta` + sequence-int pair drives gain animations without an RPC; clients detect the changed sequence and play locally (lavagame.multis_cases: `GameManager.cs:683`). Same no-RPC effect-replication trick as vault77's hit sequences.

## Gotchas

- **No game simulates true offline elapsed-time.** `multis_cases` accrues only live frames (`UnclaimedBalance += income * Time.Delta`) and `MoneyPrinter` only ticks while the host runs — closing the game forfeits idle gains between sessions (lavagame.multis_cases: `GameManager.cs:399`). For real "earned while away," save a `DateTimeOffset LastSeen`, then on load credit `(Now - LastSeen)` × rate yourself (and clamp it).
- **All production must be host-gated.** Every generator starts with `if ( !Networking.IsHost ) return;`. Clients only read the `[Sync(FromHost)]` store. Forget this and every client double-prints (MoneyPrinter.cs:373).
- **`GameObject.Id` is volatile across restarts** — use a `Guid PersistentId` layer for anything world-placed (artisan.darkrpog: `PersistentWorldEntity.cs`). Tombstones/pending logs grow unbounded; compact them.
- **Cap the store.** An uncapped accumulator overflows balance and breaks economy pacing; `Produce()` clamps to `MaxStored` (MoneyPrinter.cs:1045).
- **ACK before delete** on pending rewards, and dedupe on the client by a unique id — otherwise a relog mid-delivery either loses or double-grants the reward (multis_cases: `GameManager.cs:215`).
- **Static queue/reservation state leaks.** Worker-AI job boards keyed on `static` dictionaries must be `ClearAll`'d on save-load and validate `owner.IsValid` on every read (enifun.shop_manager: `RestockEmployeeAI.cs`).
- **Bucket fast `[Sync]` writes.** A fractional value changing every fixed tick will flood the network unless you accumulate the delta and only flush past a threshold (MoneyPrinter.cs:47).

## Seen in

- **artisan.darkrpog** — `Code/Items/MoneyPrinter.cs` (idle-tick earner: host gate, cadence, capped store, upgrade levels, heat/risk, bucketed sync); `Code/Persistence/World/PersistentWorldEntity.cs` (durable Guid identity for placed earners); `Code/Skills/RoleplaySkillService.cs` (passive playtime XP tick + anti-farm).
- **lavagame.multis_cases** — `Code/Game/Core/GameManager.cs` (live-frame passive income accrual + `ClaimPassiveIncome`; disconnect-safe pending-win JSON + ACK; floating-+$ delta/seq UI); `Code/Game/Economy/Cs2CaseApiBuilder.cs` (Http fetch + TTL file cache).
- **master.digging_simulator** — `ShopTerminal.cs` (geometric `BaseCost*mult^level` upgrade curve, stat re-derived onto live components).
- **enifun.shop_manager** — `Code/AI/RestockEmployeeAI.cs`, `Code/AI/CustomerSpawner.cs` (worker-drone automation + scaling spawner with daily rush-hour).
- **emg.everything_must_go** — `Code/Shop/Shop.cs`, `Code/Citizens/Worker.cs`, `Code/Shop/RestockJob.cs` (polymorphic job queue with claim-locking).
- **vidya.terry_games** — `RedLightGreenLight.cs`, `ColorShuffle.cs` (synced `TimeUntil`+enum phase machine for late-joiner-safe idle timing).

---

**Verify live:** API shifts between SDK versions — confirm `[Sync(SyncFlags.FromHost)]`, `Networking.IsHost`, `FileSystem.Data`, `Time.Now`/`Time.Delta`, and `[Rpc.Host]` against the installed SDK with `describe_type` / `search_types` reflection (authoritative) before building.

**See also:** the `sbox-api` skill for resolving exact type/method signatures, and the `sbox-build-feature` skill for the screenshot-driven iteration loop when wiring an idle generator into a scene.

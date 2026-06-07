# Shopkeeper / Store-Management Recipe

How to build a shopkeeper game in modern s&box (GameObject/Component/Scene), distilled from three mined games: `enifun.shop_manager` and `emg.everything_must_go` (full supermarket-tycoon sims) and `luckygaming.doner_kiosk` (a horror game wearing a food-stall skin).

## What defines the genre

A shopkeeper game is a **service loop around a stocked surface and a paying customer**. The player acquires goods, presents them (stock a shelf / cook an order), and an AI customer evaluates and pays — money feeds back into more goods and upgrades. Two sub-shapes appear:

- **Tycoon/management** (`shop_manager`, `everything_must_go`): order wholesale → stock shelves → price goods → run register → AI customers browse/buy/queue/checkout → profit → upgrades/levels. Deeply systemic, host-authoritative co-op.
- **Judgment/job-sim** (`doner_kiosk`): a per-customer *correctness* call (serve the right order, or approve/deny the customer). The shop is a skin over a "did you make the right decision?" mechanic.

**Core loop:** `acquire stock → place/prepare → customer decides & pays → bank money → reinvest`. Everything else (placement, AI, save, upgrades, co-op) is scaffolding around that loop.

## The system stack to compose

Build these as separate components; each is a singleton-per-system or a per-actor FSM. References point to existing system docs.

| System | Role | Reference |
|---|---|---|
| Host-authoritative singleton economy | Money owner-of-truth, proxy-routed spends | `references/systems/economy-currency.md` |
| Product/data catalog | Item defs (id, cost, model, unlock, tags) | `references/systems/inventory.md` |
| Stock acquisition (supplier/wholesale) | Buyable goods, daily-rerolled stock | `references/systems/shop-vendor.md` |
| Shelf placement & grid stocking | Snap items into a stocking surface | `references/systems/building-placement.md` |
| Customer AI (activity-queue FSM) | Browse → buy → queue → checkout → leave | `references/systems/spawning-waves.md` |
| Cash register / checkout queue | Lane placement, scan, take payment | `references/systems/shop-vendor.md` |
| Worker AI + job queue (optional) | Idle automation, claimable jobs | — (below) |
| Save/load persistence | Versioned, whole-scene serialize | `references/systems/save-persistence.md` |
| Upgrade / level-up progression | Tiers, XP, unlock tokens | `references/systems/progression-upgrades.md` |
| Leaderboard stats push | Backend score | `references/systems/leaderboards-services.md` |
| Interaction layer | Raycast/`IPressable`, carry, hold-to-act | `references/systems/inventory.md` |

For the judgment sub-shape, swap "register/worker/upgrades" for **per-customer scoring** + **observation-gated reveal** (see "Judgment variant" below).

## The one idiom that makes co-op work

Every mined tycoon system is the same shape: a `Component` with a `static Current`, all simulation gated to the host, and every client mutation routed through `[Rpc.Host]`. Internalize this before writing anything else.

```csharp
public sealed class ShopFunds : Component
{
    public static ShopFunds Current { get; private set; }

    // Host owns the value; [Sync(FromHost)] replicates it read-only to clients.
    [Sync( SyncFlags.FromHost )] public float Money { get; set; }

    protected override void OnStart()
    {
        Current = this;
        // Host claims ownership so it's the sole mutator; clients become IsProxy.
        if ( Networking.IsHost && !GameObject.Network.Active )
            GameObject.NetworkSpawn();
    }

    public bool SpendMoney( float amount )
    {
        if ( IsProxy ) return false;          // proxies never mutate
        if ( Money < amount ) return false;
        Money -= amount;
        return true;
    }
}
```
(enifun.shop_manager: Code/Economy/ShopFunds.cs:36 OnStart NetworkSpawn, :86 SpendMoney)

A player-initiated action on a client routes to the host, which runs the *same* method:

```csharp
public void TryBuyUpgrade()
{
    if ( Networking.IsActive && !Networking.IsHost ) { RequestBuyOnHost(); return; }
    // ...host logic: SpendMoney, increment tier, save...
}

[Rpc.Host] void RequestBuyOnHost() => TryBuyUpgrade();
```
(enifun.shop_manager: Code/Shop/ShopManager.cs:208 TryBuyAdvertising — the canonical recipe, repeated ~12×). EMG states the same rule as `if ( Scene.IsEditor || !Networking.IsHost ) return;` at the top of every AI `OnUpdate` (emg.everything_must_go: Code/Shop/Shop.cs:22-30).

**Collections don't `[Sync]`.** Flatten a cart/price-table/unlock-set to a CSV `[Sync] string` and rebuild on proxies when it changes (enifun.shop_manager: Code/Economy/PlayerProgression.cs:250 unlocks-as-CSV), or use `NetList<T>`/`NetDictionary<K,V>` and explicitly rebuild after a host mutation (emg.everything_must_go: Code/Shelving/Shelf.cs:48-54,232-248).

## Build order

Build single-player first; the host-authority idiom above makes it co-op "for free" because `IsProxy`/`HasPermission` short-circuit true offline.

1. **Economy singleton.** `ShopFunds.Current`, `[Sync(FromHost)] Money`, `SpendMoney`/`AddMoney`. Everything else reads/writes through it.
2. **Product catalog.** A static registry of `ProductDef` POCOs (id, category, wholesale cost, retail price, model path/Cloud ident, unlock gate, tags). Lookup by id; alias legacy ids so save data stays decoupled (emg.everything_must_go: Code/Items/ShelfableCatalog.cs:5-55).
3. **Interaction + carry.** Raycast the camera/mouse ray (`Scene.Trace.Ray(...).HitTriggers()`), walk up parents for an `IInteractable`/`IPressable`, pick up rigidbodies (take ownership, disable gravity, lerp to hold point). See step detail below.
4. **Shelf placement & stocking grid.** Derive a stocking surface from the model bounds, snap carried items into free cells.
5. **Supplier stock.** Buyable wholesale goods. Use **day-seeded RNG** so all clients roll identical stock without networking it.
6. **Customer AI.** Spawn → pre-roll an activity queue → FSM walks a `NavMeshAgent` through it → buy decision via a clamped additive probability → queue → checkout → leave.
7. **Register/checkout queue.** Slot-based lane, scan timer, take payment (player keypad or worker auto-ring), `AddMoney`, grant XP.
8. **Save/load.** Scan `Scene.GetAllComponents<T>()` into flat POCOs, write JSON via `FileSystem.Data`/`Storage`, gate load on Seed+Version, respawn through a factory.
9. **Progression + upgrades.** XP per sale → levels → unlock tokens / tier upgrades whose effects are *pulled* by the economy formulas.
10. **(Optional) Worker AI**, leaderboard push, day/night, traits/synergies.

## How the real games do each piece

### Customer AI — activity-queue FSM on a NavMeshAgent
Pre-roll a `Queue<Activity>` (Browse / OptionalBuy / one RequiredBuy), then run a switch-FSM that walks the agent to each target and executes it. The *buy?* decision is one clamped additive function summing independent influences (popularity + tags + archetype prefs + events + synergies + buffs + upgrades + price ratio), clamped to ~[0.08, 0.95].

```csharp
protected override void OnUpdate()
{
    if ( Scene.IsEditor || !Networking.IsHost ) return; // host-only sim
    switch ( State )
    {
        case CustomerState.Browsing:
            Agent.MoveTo( TargetShelf.FrontPoint );
            if ( (Agent.TargetPosition - WorldPosition).Length <= ArrivalDistance )
                State = CustomerState.Checkout;
            break;
        // ...
    }
}
```
(emg.everything_must_go: Code/Citizens/Customer.cs:96-126 queue build, :322-391 FSM; Code/Shop/Shop.cs:404-433 buy-chance stack. enifun.shop_manager: Code/AI/CustomerAI.cs:215 state switch, :1245 weighted shelf pick.) Animation has **no controller** — read `Agent.Velocity` per frame into `CitizenAnimationHelper.WithVelocity/WithLook`. Reserve a shelf's front spot via a static `Dictionary<Shelf,Customer>` so only one customer approaches at a time (enifun.shop_manager: Code/AI/CustomerAI.cs:855).

### Spawner — scaling caps + daily rush
Spawn on a `TimeUntil`, scale max-concurrent off *stocked shelves* and player level via `[Property]` curves, roll a once-per-day rush window, stop N hours before close. Each spawn clones a prefab, `NetworkSpawn()`s, then `Dresser.Randomize()` for a random outfit. Make every knob a `[Property]` with `[Range]`/`[Category]` for editor balancing (enifun.shop_manager: Code/AI/CustomerSpawner.cs:156,238,288).

### Supplier stock — day-seeded determinism
Re-roll per-product box counts each day with `new System.Random( day * 73856093 )`. Identical seed on every machine ⇒ identical roll ⇒ **stock never needs networking**; only player-caused consumption is broadcast.

```csharp
void RollStock()
{
    var rng = new System.Random( CurrentDay * 73856093 ); // same on host + all clients
    foreach ( var p in ProductDatabase.Products )
        _dailyStock[p.Id] = rng.NextDouble() < p.OutOfStockChance ? 0 : rng.Next(1, 8);
}
```
(enifun.shop_manager: Code/Economy/SupplierStock.cs:246 RollStock; "peek tomorrow" = `(day+1)*const` at :157.)

### Shelf placement — grid from model bounds
Derive the stocking surface from the renderer's `Model.Bounds` (column axis = longer side, inset edges, slice into columns×rows per level); find the first free cell; freeze placed rigidbodies (`Gravity=false, MotionEnabled=false, Sleeping=true`). One `Shelf` component then adapts to many models. Authored child `Stock Slot` GameObjects can override the procedural grid (emg.everything_must_go: Code/Shelving/Shelf.cs:66-128,412-471). For the *build/furniture* placement flow (ghost preview, grid snap, validity tint, `Scene.NavMesh.SetDirty()` after placing) see `references/systems/building-placement.md` (enifun.shop_manager: Code/Shop/ShopBuilder.cs:288,366,705).

### Interaction + carry
Raycast each frame, walk up parents for `IInteractable.CanInteract`, read a live `InteractLabel` for the HUD prompt. Carry takes network ownership and smooth-moves the body in `OnFixedUpdate`; drop tries every shelf's `TryStock` host-side.

```csharp
var tr = Scene.Trace.Ray( ray, Range ).HitTriggers().WithoutTags( "player" ).Run();
for ( var go = tr.GameObject; go.IsValid(); go = go.Parent )
    if ( go.Components.Get<IInteractable>() is { } it && it.CanInteract( this ) ) { it.Interact( this ); break; }
```
(emg.everything_must_go: Code/Player/ObjectCarrier.cs:46-109 carry+ownership; enifun.shop_manager: Code/Player/PlayerInteraction.cs:146 parent-walk.) Carry physics belong in `OnFixedUpdate`; take ownership *before* moving a proxy body or the move is ignored.

### Cash register — checkout queue
Keep an ordered queue; place lane slots either at fixed child anchors (`Queue0`/`MasterQueue`) or score 8 candidate directions by navmesh-validity so the line doesn't clip walls. Checkout progresses only while `IsStaffed()` (player seated or worker hired); on completion `AddMoney`, grant XP, fire a `static Action<float> OnTransactionComplete` seam for HUD/achievements (enifun.shop_manager: Code/Shop/CashRegister.cs:373,511,692; emg.everything_must_go: Code/Shop/CashRegister.cs:118-212 lane scoring).

### Worker AI — global job board (optional automation)
Don't let workers each scan the world. Shelves enqueue themselves into a **static FIFO `_taskQueue`** (+ `HashSet` dedupe) when low; idle workers claim the first task and stake **static reservation dictionaries** (`Dictionary<Shelf,Worker>`, `Dictionary<(Storage,int),Worker>`) so no two grab the same job/box/slot. EMG generalizes this to a polymorphic `ShopJob` base (`Restock`/`Cashier`) with `TryClaim/Release/IsStillNeeded`. Validate `owner.IsValid` on every read and `ClearAll()` before save-restore (enifun.shop_manager: Code/AI/RestockEmployeeAI.cs:63,212; emg.everything_must_go: Code/Shop/RestockJob.cs:1-97).

### Save/load — scan + factory respawn
Walk `Scene.GetAllComponents<Shelf/Shelfable/Container/Worker>()` into flat POCO structs (positions as X/Y/Z floats, yaw, inventory lists), serialize to JSON, and restore by feeding each record back through a central `ObjectFactory` that clones the prefab and re-networks it. Gate load on **Seed+Version** so a schema bump reseeds cleanly; run a JSON-node `SaveMigrator` *before* deserialize for in-place upgrades (emg.everything_must_go: Code/Shop/ProgressBootstrapper.cs:206-324; enifun.shop_manager: Code/Save/SaveMigrator.cs:23,33). Apply only after `AllSingletonsReady()`. Host-only — clients never load.

## Judgment variant (doner_kiosk)

If your shop is a skin over a decision, swap the tycoon back half for these:

- **Symmetric mistake scoring across two exit states.** Correctness lives at the two ways a customer can leave: `LeavingState.Enter()` (served) penalizes if `isAnomaly`; `SadLeavingState.Enter()` (rejected) penalizes if `!isAnomaly`. One boolean, two states, both → `PlayerErrorAction()`. Portable to any approve/deny game (luckygaming.doner_kiosk: Code/npc/states/LeavingState.cs:10 + SadLeaving.cs:38).
- **Observation-gated reveal.** Anomaly behaviors are drop-in `SpecialModify : Component` modifiers gated on the customer's FSM state *and* whether the player is watching the CCTV. A head only rotates while unobserved; another only animates once watched; one toggles `Model.Enabled` so it's only (in)visible through the lens. This "behavior keyed to observation" loop is the genre's reusable heart (luckygaming.doner_kiosk: Code/npc/modify/SpecialModify.cs:1 base, FaceInCam.cs:15, Code/Game/VideoCamera.cs:34 CameraOn→IsStartet, :74 CheckAnomaly). Note its CCTV blits via `DebugOverlay.Texture` — for production render the `Texture.CreateRenderTarget` feed into a Razor/world panel instead.
- **Hand-rolled per-actor FSM.** A `Dictionary<enum, State>` built once; `ChangeState` calls `Exit()`→swap→`Enter()`; `OnUpdate` forwards to `current?.Update()`. States are reused (not per-entry) so reset per-visit data in `Enter()`, not in fields (luckygaming.doner_kiosk: Code/npc/Customer.cs:162,179).
- **Deck-draw spawn for guaranteed variety.** Load types from `Enum.GetValues` into a list; each spawn pulls a random index and `RemoveAt()`s it, so every type is seen once before any repeat — cleaner than naive `Random` for curated pacing (luckygaming.doner_kiosk: Code/Game/GameManager.cs:176).
- **Multi-step recipe via paired dictionaries.** Cooking is data, not branches: `_itemToBoardState` maps ingredient→accepting board-state, `_placementActions` maps ingredient→`Action<Board>`; a 1s hold-to-place (`TimeSince` → 0..1 progress) gates the commit. Adding an ingredient = two dictionary entries (luckygaming.doner_kiosk: Code/Player/Player.cs:96, EntityBoard.cs:66).
- **In-engine TTS for NPC voice.** `Sandbox.Speech.Synthesizer().WithText(line).Play()` → position the `SoundHandle` at the speaker — dynamic spoken dialog with zero recorded VO (luckygaming.doner_kiosk: Code/Game/Tts.cs:9).

## Pitfalls (from the mined code)

- Money mutators silently no-op on proxies — UI **must** route spends through `[Rpc.Host]`, never call `SpendMoney` on a client.
- `NetList`/`NetDictionary` replicate from host only; rebuild them explicitly after a host mutation or proxies read stale/empty.
- After placing/moving anything that affects pathing, call `Scene.NavMesh.SetDirty()`; spawn/despawn points may be off-mesh — snap with `Scene.NavMesh.GetClosestPoint`.
- Static reservation/queue/job state leaks across a save-load; `ClearAll()` before respawning, validate `owner.IsValid` on access.
- Bumping the save `CurrentVersion` wipes old saves (intentional) — pair it with a migration.
- Don't lean on global statics like `Player.ThisPlayer`/`GameSettings.*` (doner_kiosk does, baking in a single-local-player ceiling) — pass refs or resolve per-actor.
- Razor `PanelComponent.BuildHash()` must fold **every** value the markup reads, or the UI goes stale (emg.everything_must_go: Code/UI/CheckoutPanel.razor:155).

## Verify live

API surfaces drift between SDK versions — confirm before relying on a signature. Use `describe_type` / `search_types` reflection against the installed SDK as authoritative for: `Sandbox.Networking` (`IsHost`/`CreateLobby`), `[Sync]`/`SyncFlags`/`[Rpc.Host]`/`[Rpc.Broadcast]`, `NavMeshAgent` (`MoveTo`/`Velocity`/`TargetPosition`), `Scene.NavMesh`, `Scene.Trace.Ray(...).HitTriggers()`, `GameObject.NetworkSpawn`/`Network.TakeOwnership`, `CitizenAnimationHelper`, `Texture.CreateRenderTarget`/`CameraComponent.RenderToTexture`, `Sandbox.Speech.Synthesizer`, and `FileSystem.Data` / `Storage` JSON helpers.

Cross-links: see the `sbox-api` skill for authoritative type lookups, and the `sbox-build-feature` skill for the screenshot-driven build/iterate loop.

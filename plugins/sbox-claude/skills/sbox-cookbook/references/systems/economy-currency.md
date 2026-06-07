# Economy & Currency

How to build money/coins/credits, shops, upgrades, lootboxes and persistence in modern s&box — host-authoritative where it matters, client-trusted where it's cheap.

## What it is / when you need it

Any game with a spendable resource: a wallet (`Money`/`Gold`/`coins`/`BP`), ways to **earn** it (sales, kills, pickups, quotas, passive income), ways to **spend** it (shops, upgrades, gambling, resurrection), and a way to **persist** it. The hard parts are: who is allowed to change the number (trust model), how upgrade costs scale, and how the balance survives a reload. Pick your trust model first — it dictates everything else.

## Canonical approach: host-authoritative wallet

The dominant pattern across the mined games. The balance lives in ONE place, only the host writes it, clients see a read-only replica. Used by chop_the_forest, shop_manager, everything_must_go, darkrpog, GASTROTOWN.

```csharp
public sealed class ShopFunds : Component
{
    public static ShopFunds Current { get; private set; }
    [Property] public float StartingMoney { get; set; } = 500f;

    // Host owns the value; clients get a read-only replicated mirror.
    [Sync( SyncFlags.FromHost )] public float Money { get; set; }

    protected override void OnStart()
    {
        Current = this;
        // Claim host ownership once. After this clients are IsProxy=true.
        if ( Networking.IsHost && !GameObject.Network.Active )
        {
            Money = StartingMoney;          // overwritten later by your save
            GameObject.NetworkSpawn();
        }
    }

    public void AddMoney( float amount, string reason = "" )
    {
        if ( IsProxy || amount <= 0f ) return;   // mutators no-op on clients
        Money += amount;
    }

    public bool SpendMoney( float amount )       // returns the affordability gate
    {
        if ( IsProxy || amount <= 0f ) return false;
        if ( Money < amount ) return false;
        Money -= amount;
        return true;
    }
}
```
(enifun.shop_manager: Code/Economy/ShopFunds.cs:18,36,86)

Three rules that make this safe:

1. **`[Sync(SyncFlags.FromHost)]`** means clients literally cannot write the field — the value only flows host→client. Use a `private set` if the property is on the player itself (artisan.darkrpog: Code/Player/Player.Roleplay.cs:9).
2. **Every mutator early-returns on a proxy.** Guard with `if (IsProxy) return;` (ShopFunds) or `if (!Networking.IsHost) return;` (darkrpog Code/Player/Player.Roleplay.cs:22). A client UI button must therefore call an `[Rpc.Host]` method, never `SpendMoney` directly.
3. **Validate-then-apply, never throw.** `TryTakeMoney` checks affordability + overflow *before* mutating and returns `bool`; mandatory costs use a separate `ForceSpend` that allows going negative (ShopFunds.cs:106). For richer outcomes return a result enum + a `DescribeFailure(enum)→string` mapping instead of bools (artisan.darkrpog: Code/Economy/Bank/BankingService.cs:13).

```csharp
// darkrpog — host gate + overflow guard + immediate save, returns bool
public bool TryTakeMoney( long amount )
{
    if ( !Networking.IsHost || amount < 0 || !CanAfford( amount ) ) return false;
    Money -= amount;
    SaveRoleplayData();
    return true;
}
```
(artisan.darkrpog: Code/Player/Player.Roleplay.cs:35; overflow-check on give at :28)

### Client-initiated change: the request → apply → confirm triad

When a client must drive a change (buy from a shop, pick a pet), it sends an `[Rpc.Host]` request; the host **re-validates the caller and re-clamps the number** (never trust the wire value), applies, and optionally `[Rpc.Owner]` confirms the authoritative result back.

```csharp
[Rpc.Host]
private void RequestBuy( string upgradeId )
{
    // re-validate identity AND re-derive cost host-side
    if ( Rpc.CallerId != Network.OwnerId ) return;
    int cost = ShopBalance.GetCost( upgradeId, CurrentLevel( upgradeId ) );
    if ( cost < 0 || !SpendMoney( cost ) ) return;     // host is the gate
    ApplyUpgrade( upgradeId );
}
```
(pattern from vault77.chop_the_forest: Code/Player/PlayerProgression.cs:922/941 RpcRequest/RpcConfirm)

### Shops & upgrades: the geometric cost curve

The canonical idle/tycoon pricing. A per-line config + `cost = BaseCost * mult^level`, returning a sentinel (`-1`) at max. Drop-in reusable.

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

public int GetCost( UpgradeConfig c, int level )
{
    if ( level >= c.MaxLevel ) return -1;                 // -1 == maxed
    return (int)(c.BaseCost * MathF.Pow( c.CostMultiplier, level ));
}
```
(master.digging_simulator: Code/ShopTerminal.cs:9,49,63). On buy, decrement money, increment level, then **re-derive the live stat onto the target component** (`drill.DigRadius = c.BaseStat + level*c.StatPerLevel`) — and re-apply ALL stats on load (ShopTerminal.cs:81). For larger trees, hold a `readonly struct[] Definitions` indexed by level with `Get(level)` that `Clamp`s to `[1,MaxLevel]` and `TryGetNext(cur, out def)` (vault77.chop_the_forest: Code/Player/AxeUpgradeBalance.cs:21,52); `MaxLevel` derives from `Definitions.Length` so adding a row "just works."

### Sending purchases over the wire: Ids, never resource refs

`GameResource` references do NOT round-trip across RPCs. Send the resource **Id (string)** + quantity, and reconstruct on the host via `ResourceLibrary`:

```csharp
[Rpc.Host]
private void TryPurchaseOrder( RestaurantComponent restaurant, Dictionary<string,int> orderData )
{
    foreach ( var (id, qty) in orderData )
    {
        var resource = ResourceLibrary.GetAll<DeliverableResource>()
            .FirstOrDefault( r => r.Id == id );
        if ( resource == null ) { Log.Warning( $"Unknown id {id}" ); continue; }
        order.SetQuantity( resource, qty );
    }
    if ( order.Cost() > restaurant.Money ) return;       // re-check host-side
    restaurant.Money -= order.Cost();
}
```
(thefancylads.restaurant_dev: Code/Common/Economy/RestaurantShop.cs:21,29)

## Variations seen across games

- **Two-tier "trust the client" economy** — client deducts its own balance optimistically, sends `[Rpc.Host]` with the declared cost, host rolls the outcome and `[Rpc.Broadcast(NetFlags.HostOnly)]`s authoritative state back; on any host validation failure the host MUST `SafeRefund(declaredCost)` (the client already debited). (lavagame.multis_cases: Code/Game/Core/GameManager.cs:1084-1243)
- **Cloud-stats-as-database** — no server DB at all; currency lives in `Sandbox.Services.Stats` keyed strings, mutated via `Stats.Increment` / `SetValue` then `Stats.Flush()`, rehydrated on spawn. Earned through `[Rpc.Owner]` because **the host cannot write another player's Steam stats** (facepunch Blind: Code/Player/Player.cs:786; playbtg.elevator: Code/Actors/ElevatorPlayer.Score.cs:43). Critical semantic: `SetValue` does NOT overwrite — `.Sum` accumulates every write; use Increment+`.Sum` for counts, SetValue+`.LastValue` for "current selection / claim flags."
- **Client-local JSON save** (co-op / non-competitive) — `FileSystem.Data.WriteJson/ReadJson("save.json")` of a POCO keyed by SteamId; trivially editable, fine for solo. Mark dirty on mutation, write on a `TimeSince` interval, force-save on `Game.IsClosing`/`OnDestroy` (master.digging_simulator: Code/SaveManager.cs:18; stepdev.xtrem_road: Code/Persistence/PlayerSaveService.cs:95,177; goders.natural_disaster_survival: Code/globals/DataManager.cs:94).
- **Signed/versioned anti-tamper save** — clamp every field on load (`ValidateAndSanitize`), then an FNV-1a signature over a **version-conditional** canonical payload so old saves still verify (vault77.chop_the_forest: Code/Player/LumberSteamProgressSave.cs:434,957). Deterrent only, not crypto.
- **Lootbox / gacha** — `RewardDefinition[]` with integer `Weight`; cumulative-weight roulette (roll `1..totalWeight`, walk a cursor). Free-case charges recharge over real time tracked as **Unix seconds** (survives reload), not `TimeSince` (vault77.chop_the_forest: Code/World/CaseRewardBalance.cs:87,140; emg: Code/Shop/Shop.cs:614). `System.Random.Shared` is fine for cosmetic rewards.
- **Provably-fair gambling** — for anything with economic value, do NOT use `System.Random`. Commit-reveal SHA256 (`System.Security.Cryptography` is whitelisted) with **rejection sampling** to kill modulo bias, kept as engine-agnostic POCO C# (vault77.chop_the_forest: Code/Gambling/ProvablyFairRng.cs:126,193).
- **Passive / idle income** — `PassiveIncome => slots.Sum(i => MathF.Sqrt(i.SellValue) * RATE)`; accrue `Unclaimed += income * Time.Delta` each frame, player claims manually (lavagame.multis_cases: Code/Game/Core/GameManager.cs:399). `Sqrt` compresses whale advantage; note offline time is NOT simulated unless you diff timestamps on load.
- **Escalating quota economy** — daily quota from a `.runset` `List<int>`, scaled by player count; split deposits into normal vs over-quota (bonus multiplier) and carry excess forward. Keep "progress toward quota" and "spendable bank" as **separate buckets** (treehaven.sdiver: Code/Gameplay/GameMode/ExpeditionMode.cs:85).
- **Capped inventory as currency** — `Dictionary<string,int>` + `int Money`; `AddResource` returns `false` when full so pickup logic stays in the item and capacity policy stays in the inventory; fire an `Action OnInventoryChanged` for UI (master.digging_simulator: Code/PlayerInventory.cs:15). Local `Action` is fine; add `[Sync]` for MP.
- **HTTP backend wallet** — use `Sandbox.Http.RequestStringAsync` / `CreateJsonContent`, NOT `System.Net.HttpClient` (whitelist-blocked). Non-host clients often have no direct internet, so relay through the host (vault77.chop_the_forest: Code/game/BackendClient/HttpBackendTransport.cs:27).

## Gotchas

- **A `[Sync]` int with a public setter is exploitable** — a malicious client can write it. Only `SyncFlags.FromHost` (or host-side validation) protects it. playbtg.elevator's coin balance is public-set `[Sync]` and only the death-drop clamps it (Code/Actors/ElevatorPlayer.Score.cs).
- **Mutators silently no-op on proxies.** If a UI "Buy" button calls `SpendMoney` directly on a client, nothing happens and no error fires — route through `[Rpc.Host]`.
- **`NetworkSpawn()` once, host-only, guarded** by `!GameObject.Network.Active`; set starting money *before* it, then let the save overwrite.
- **Re-clamp on BOTH the host RPC and any owner-confirm** — never trust the incoming number, even your own confirm echo.
- **`NetList<T>`/`NetDictionary<K,V>` replicate from host only** — after a host-side mutation you must explicitly rebuild them, and client-side read APIs must fall back to the synced mirror (`Networking.IsHost ? liveList : syncedList`) or proxies read stale/empty (emg.everything_must_go: Code/Shop/Shelf.cs).
- **Trigger rewards double-fire** — a `PlayerController` exposes multiple colliders, so an `OnTriggerEnter` reward pays N times; debounce with a `HashSet<Guid>` of rewarded root Ids (lavagame.multis_cases: Code/Game/Obby/ObbyRewardButton.cs).
- **Steam `Stats.SetValue` accumulates via `.Sum`** — three `SetValue(1)` gives Sum=3. Ownership flags = write-once Increment (never decrement or you revoke a paid item); current-selection/claim flags = SetValue + `.LastValue` (facepunch Blind: Code/Player/Player.cs).
- **Geometric costs overflow int** fast — keep currency `int`/`long` but clamp (chop_the_forest clamps to 1_500_000_000) or use `long` (darkrpog).
- **Client-saved cooldown timestamps are editable** — a daily-lootbox cooldown compared against a client `DateTime.UtcNow` is trivially bypassed; gate server-side for anything that matters (clearlyy.s_miner: DailyLootbox.cs).
- **Don't lose materials on a failed craft/fusion** — generate the output into a copy first, consume ingredients only after success (namicry.gacha_crawler: Code/GameManager.cs:1913).

## Seen in

- **vault77.chop_the_forest** — host-authoritative `[Sync(FromHost)]` economy, data-driven balance tables, signed versioned save, free-case gacha, provably-fair gambling, HTTP backend.
- **enifun.shop_manager** — `ShopFunds` singleton wallet, checkout queue, `Sandbox.Services.Stats` leaderboard push.
- **emg.everything_must_go** — host-authoritative sim with `NetList`/`NetDictionary`, roguelite level-up rewards, slot-machine gacha, navmesh checkout queue.
- **master.digging_simulator** — capped inventory, formula-driven upgrade shop (geometric curve), JSON terrain-diff save.
- **artisan.darkrpog** — `long` wallet with overflow guards + result-enum bank service, daily-login streak.
- **thefancylads.restaurant_dev** (GASTROTOWN) — host-authoritative `Money`, Id-over-RPC procurement shop, customer-pays-on-eat income.
- **playbtg.elevator** — `[Sync]` coins with world pickups + spawner, confirm-gated 3D shop, cloud-stat XP/streak.
- **stepdev.xtrem_road** — multi-container inventory, tiered vendor, dirty-flag JSON autosave, services leaderboard.
- **lavagame.multis_cases** — idle passive income, host-validated case-battle/jackpot gambling, live CS2 case API.
- **clearlyy.s_miner** — daily lootbox, networked slot machine, prestige/rebirth/ascension tree.
- **goders.natural_disaster_survival** — client-local cash + meta-upgrade tree, look-at-to-buy 3D shop.
- **treehaven.sdiver** — escalating quota economy with carry-over + over-quota bonus.
- **namicry.gacha_crawler** — `[Flags]` crafting/fusion, buy/sell/upgrade/resurrection sinks.
- **dimmies.terryspapers** — dictionary-driven mood/economy progression with promotion + permadeath.
- **facepunch.Blind** — currency entirely on Steam Stats (Increment/Sum vs SetValue/LastValue).
- **vidya.terry_games** — derived money payout + money-particle burst + Steam achievements.

## Verify live

Reflection is authoritative for the installed SDK. Confirm members before you write code: `mcp__sbox__describe_type SyncFlags`, `mcp__sbox__search_types ResourceLibrary`, `mcp__sbox__describe_type GameObject` (for `NetworkSpawn`/`Network.Active`/`IsProxy`), and `mcp__sbox__describe_type Sandbox.Services.Stats`.

Cross-link: use **sbox-api** for exact type/member signatures, and **sbox-build-feature** for the screenshot-driven build-and-iterate loop when wiring the shop UI.

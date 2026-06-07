# Inventory (item storage, slots/hotbar, pickup & drop)

How to build the "player holds items" system in modern s&box: a Component that owns the items, networked pickup/drop, slot selection, and capacity rules — distilled from 12+ real games.

## What it IS / when you need it

An inventory is a **Component on the player GameObject** that owns a collection of items (a `Dictionary`/`List`), exposes mutators (`Give`/`Add`/`Take`/`Drop`/`Clear`), raises a change event for the UI, and — in multiplayer — keeps that collection consistent across clients. It is the hub other systems hang off: pickups feed it, the hotbar reads its active slot, weapons deploy from it, save/load snapshots it.

Reach for it when items have identity (a held tool, a gun + ammo, stacks of ore). If you only need a few global counters, a couple of `[Sync] int` fields is enough — don't build this.

Pick your shape up front:
- **Counts** — `Dictionary<string,int>` (resources/ore/ammo). Simplest. `master.digging_simulator`, `apl.sandboxwars` ammo.
- **Slots / hotbar** — `List<InventorySlot>` or `Dictionary<int,Item>`, plus a selected index (weapons, tools). `playbtg.elevator`, `treehaven.sdiver`.
- **Grid / spatial** — `bool[W,H]` occupancy + per-item Width/Height (Tetris/EFT). `khamitech.battledraft`.
- **Per-instance items** — a wrapper class with mutable per-pickup state (wear, uses, rolled suffix). `lavagame.multis_cases`, `stepdev.xtrem_road`.

## Canonical recipe (modern s&box)

### 1. Single-player / local: a Component with a change-event

The minimal, reusable core. Capacity policy lives in the inventory; the *bool return* lets the caller (the world item) decide what to do when it's full.

```csharp
public sealed class PlayerInventory : Component
{
    private Dictionary<string, int> _items = new();
    [Property] public int MaxItems { get; set; } = 10;
    public Action OnInventoryChanged;            // UI subscribes; fire on every mutation

    public bool AddResource( string name, int amount )
    {
        int total = _items.Values.Sum();
        if ( total >= MaxItems ) return false;   // full → caller leaves item in world
        _items[name] = _items.GetValueOrDefault( name ) + amount;
        OnInventoryChanged?.Invoke();
        return true;
    }

    public IReadOnlyDictionary<string,int> GetItems() => _items;
    public void ClearInventory() { _items.Clear(); OnInventoryChanged?.Invoke(); }
}
```
(zips-code/master.digging_simulator: Code/PlayerInventory.cs:15 — bool-gated `AddResource`, :12 — `OnInventoryChanged` Action.)

This is the right starting point. The plain `Action` event is fine locally; for MP you replace it (see below), not the rest.

### 2. Slots + hotbar + deploy (the common "weapons/tools" shape)

Store slots as a list, sync only the **active index**, and reconstruct contents per-client via owner-RPC grants (so contents replicate without a heavy synced collection).

```csharp
public sealed class InventorySlot { public EquipmentDefinition Definition; public int Count = 1; }

public sealed class InventoryComponent : Component
{
    public List<InventorySlot> Slots { get; } = new();   // NOT synced
    [Sync] public int ActiveSlot { get; private set; } = -1;

    protected override void OnUpdate()
    {
        if ( IsProxy ) return;                            // only the owner reads input
        for ( int i = 0; i < 6; i++ )
            if ( Input.Pressed( $"slot{i + 1}" ) ) SelectSlot( i );
        // mouse-wheel cycles, wrapping with (ActiveSlot ± 1 + n) % n
    }

    [Rpc.Owner] public void GiveItem( EquipmentDefinition def, int count = 1 )
    {
        var slot = Slots.FirstOrDefault( s => s.Definition == def );
        if ( slot != null ) slot.Count += count;
        else { Slots.Add( new InventorySlot { Definition = def, Count = count } );
               if ( ActiveSlot < 0 ) SelectSlot( Slots.Count - 1 ); }
    }
}
```
(zips-code/playbtg.elevator: Code/Inventory/InventoryComponent.cs:13 — slot list + `[Sync] ActiveSlot`, :138 — `[Rpc.Owner] GiveItem`, :30 — input/scroll select.)

**Deploy** = clone the definition's prefab, parent it at local origin under the player, attach the viewmodel, then `NetworkSpawn()`:
```csharp
var weapon = SceneUtility.GetPrefabScene( def.Prefab ).Clone();
weapon.SetParent( player.GameObject );
weapon.LocalPosition = Vector3.Zero; weapon.LocalRotation = Rotation.Identity;
weapon.Components.Get<BaseWeapon>( FindMode.InDescendants )?.AttachViewmodel( player.Camera );
weapon.NetworkSpawn();
```
(elevator: InventoryComponent.cs:109 — `DeployWeapon`. The weapon GO must be a **direct child** of the player; `BaseWeapon.Owner` walks up with `GetComponentInParent`.)

### 3. Multiplayer pickup: host-authoritative consume

Spawned world items must be removed exactly once, by the host. Base both trigger and solid-collision pickups on one abstract Component and guard on `Networking.IsHost`:

```csharp
public abstract class BasePickup : Component, Component.ITriggerListener, Component.ICollisionListener
{
    [RequireComponent] public Collider Collider { get; set; }
    public virtual bool CanPickup( Player p, PlayerInventory inv ) => true;
    protected virtual bool OnPickup( Player p, PlayerInventory inv ) => true;   // false = don't consume

    void Component.ITriggerListener.OnTriggerEnter( GameObject other )
    {
        if ( !Networking.IsHost || GameObject.IsDestroyed ) return;            // host-only = no double pickup
        if ( !other.Components.TryGet( out Player player ) ) return;
        if ( !player.Components.TryGet( out PlayerInventory inv ) ) return;
        if ( !CanPickup( player, inv ) || !OnPickup( player, inv ) ) return;
        PlayPickupEffects( player );                                          // [Rpc.Broadcast]
        DestroyGameObject();
    }
    // OnCollisionStart resolves the player off collision.Other.GameObject.Root and runs the same body
}
```
(zips-code/apl.sandboxwars: Code/Items/Pickups/BasePickup.cs:4 — class, :36/:60 — the two host-gated listener paths, :81 — broadcast effects. Subclasses override the two virtuals only.)

### 4. Shared/host-authoritative pool: optimistic client + `[Rpc.Host]` twin

For data every client mutates (ammo, shared currency), store a `[Sync(SyncFlags.FromHost)] NetDictionary<,>` and route client writes through a host RPC, returning a predicted value immediately:

```csharp
[Sync( SyncFlags.FromHost )] public NetDictionary<string,int> Pool { get; set; } = new();

public bool TakeAmmo( AmmoResource res, int count )
{
    if ( !Networking.IsHost ) { TakeAmmoRpc( res, count ); return GetAmmo( res ) >= count; } // optimistic
    if ( GetAmmo( res ) < count ) return false;
    Pool[res.ResourcePath] = GetAmmo( res ) - count;                         // host clamps & mutates
    return true;
}
[Rpc.Host] private void TakeAmmoRpc( AmmoResource res, int count ) { /* same host-side check */ }
```
(zips-code/apl.sandboxwars: Code/Game/Weapon/AmmoInventory.cs:11 — `NetDictionary` decl, :53 — optimistic `TakeAmmo`, :87 — host twin. The host always clamps to `resource.MaxReserve`.)

### 5. Race-locked pickup (many clients grab the same item one tick)

If several clients fire a pickup RPC in the same network tick, `obj.IsValid()` is still true for all of them. **Tag the object as a mutex** before the end-of-frame `Destroy()`, then broadcast the confirmed result:

```csharp
[Rpc.Host] public void HostRequestPickup( Guid targetId, int slot )
{
    var obj = Scene.Directory.FindByGuid( targetId );
    if ( !obj.IsValid() || obj.Tags.Has( "picked_up" ) ) return;   // mutex: only the first wins
    obj.Tags.Add( "picked_up" );
    var item = obj.Components.Get<ICollectible>()?.Item;
    if ( item == null ) return;
    obj.Destroy();
    BroadcastConfirmPickup( targetId, item, slot );                // [Rpc.Broadcast] writes everyone's dict
}
```
(zips-code/treehaven.sdiver: Code/Items/PlayerToolbar.cs:300 — `HostRequestPickup` tag-mutex, :325 — `BroadcastConfirmPickup`. The slot dict itself is NOT `[Sync]`; every mutation is broadcast, so reconnect state is hand-restored via an owner RPC.)

### 6. Drop = inverse of deploy

Clone the item's *world* prefab at the drop position, transfer the per-instance state (uses/wear) onto its `ICollectible`, `NetworkSpawn()`, then push velocity via the `Rigidbody` so it doesn't land on your feet:
```csharp
var drop = item.Definition.WorldPrefab.Clone( dropPos );
drop.Components.Get<ICollectible>( FindMode.EverythingInSelfAndParent ).Item = item; // keep state
drop.NetworkSpawn();
drop.Components.Get<Rigidbody>()?.ApplyImpulse( ... );   // inherit player velocity + a small up-arc
```
(treehaven.sdiver: PlayerToolbar.cs:346 — `BroadcastDropItem`.)

## Notable variations

- **Counts vs slots vs grid vs per-instance** — pick from the four shapes above; they don't mix cleanly, choose by item identity.
- **Capacity policy**: total item *count* cap (`digging_simulator`, returns `false`), slot count, or **weight/encumbrance** — a `Dictionary<id,float>` summed against `MaxWeight` with an `OnWeightUpdated` event (zips-code/khamitech.battledraft: Code/Addons/Arena/Player/PlayerInventoryArena.cs:54).
- **Spatial (Tetris) placement** — `bool[W,H]` grid + best-fit scan that sorts items largest-first and scores top-left placements (battledraft: InventoryGridUI.cs:229/:271). Pure client-side UI bookkeeping; server authority is separate.
- **Per-instance condition** — wrap an `ItemDefinition` in an `InventoryItem` carrying a `WearFloat`/`Uses`/rolled-suffix id; computed props derive sell value/condition tier (zips-code/lavagame.multis_cases: Code/Game/Economy/InventoryItem.cs:29; zips-code/stepdev.xtrem_road: Code/Fishing/FishSuffixes.cs:1072).
- **Multi-container, one API** — namespace slot indices by offset (`RodSlot=-1`, `FishStorageStart=1000`) so one `GetSlot/ClickSlot` covers hotbar + main grid + bank (xtrem_road: Code/Inventory/PlayerInventory.cs:1097/:1373).
- **Replication strategy**: (a) sync only the active index + reconstruct contents via `[Rpc.Owner]` grants (elevator); (b) `[Sync] NetDictionary` host-authoritative (sandboxwars ammo); (c) plain dict + broadcast-every-mutation + manual reconnect restore (sdiver). (a)/(c) hide other players' contents from late joiners; (b) replicates fully.
- **Plain-class inventory** — not every inventory is a Component: `ataco.sdoomresurrection` uses a POCO `Inventory` holding `List<BaseCarriable>`, reparenting weapon GOs and toggling renderers (Code/weapon/Inventory.cs:60).

## Gotchas

- **`if ( IsProxy ) return;`** at the top of `OnUpdate` so only the owner reads slot input. Mutators that clients call need `[Rpc.Owner]`/`[Rpc.Host]`; host-only consume (`Networking.IsHost`) is what prevents double-pickup.
- **A plain `List`/`Dictionary` is NOT replicated.** Either it's not networked (single-player), or you sync an index and rebuild via RPCs, or you use `NetDictionary` with `[Sync]`. Decide deliberately — a non-synced collection means late joiners and reconnecting players see nothing until you hand-restore it.
- **`NetworkSpawn()` last**, after the GO is parented and components are attached, or ownership/replication start with a half-built object.
- **String keys are fragile**: keying pools/items by `resource.ResourcePath` orphans saved data if you rename the asset. Persist a stable id, re-resolve the definition from the static table on load.
- **Capacity = count, not stacks/slots** in the simple recipe — be explicit about which you mean; mixing them silently breaks "is it full?".
- **Optimistic client returns can briefly lie** (`TakeAmmo` returns `GetAmmo() >= count` before the host confirms) — fine for prediction, don't gate irreversible economy on it.
- **Per-instance `Definition` can be null after load** if the def was removed from the catalog — every accessor must fall back to saved fields (multis_cases).
- **Deployed weapon/tool must be a direct child of the player** (parent walks find it); a one-frame `_waitingForWeapon` guard avoids a double-consume when redeploying the next stack (elevator: InventoryComponent.cs:65).

## Seen in

- `master.digging_simulator` — capped count inventory + change-event (the minimal recipe) — `Code/PlayerInventory.cs`
- `playbtg.elevator` — slot list + hotbar + `[Sync] ActiveSlot` + deploy — `Code/Inventory/InventoryComponent.cs`
- `apl.sandboxwars` — host-authoritative `NetDictionary` ammo pool + `BasePickup` trigger/collision base — `Code/Game/Weapon/AmmoInventory.cs`, `Code/Items/Pickups/BasePickup.cs`, slot loadout in `Code/Player/PlayerInventory.cs`
- `treehaven.sdiver` — tag-mutex race-locked pickup handshake + broadcast-mutation replication + drop-with-velocity — `Code/Items/PlayerToolbar.cs`
- `khamitech.battledraft` — spatial (Tetris) grid placement + weight/encumbrance — `Code/Addons/Arena/UI/Inventory/InventoryGridUI.cs`, `Code/Addons/Arena/Player/PlayerInventoryArena.cs`; world-item chunk index in `Code/Managers/ItemManager.cs`
- `lavagame.multis_cases` — per-instance wear (`WearFloat`) condition system — `Code/Game/Economy/InventoryItem.cs`
- `stepdev.xtrem_road` — multi-container one-API inventory + rolled-suffix per-instance items — `Code/Inventory/PlayerInventory.cs`, `Code/Fishing/FishSuffixes.cs`
- `ataco.sdoomresurrection` — POCO (non-Component) carriable inventory + reparent/holster — `Code/weapon/Inventory.cs`
- `namicry.gacha_crawler` — equipment slots with fully derived stats — `Code/Models/PlayerCharacter.cs`
- `luckygaming.doner_kiosk`, `emg.everything_must_go` — held-item + carrier patterns feeding shop/cooking systems

## Verify live

Reflection on the installed SDK is authoritative — API drifts between versions. Before writing, confirm the exact members: `describe_type NetDictionary`, `describe_type GameObject` (`NetworkSpawn`, `Tags`, `Components`), `describe_type Component.ITriggerListener`, `search_types Rpc`, `describe_type SceneUtility` (`GetPrefabScene`). Then screenshot after pickup/deploy and read the PNG.

Cross-link: see the **sbox-api** skill for resolving any type/member above against the live SDK, and **sbox-build-feature** for the screenshot-driven build loop that catches replication/parenting mistakes early.

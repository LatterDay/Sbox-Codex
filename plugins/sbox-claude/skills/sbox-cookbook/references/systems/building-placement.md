# Building / Placement System

Purpose: let a player place objects (furniture, shelves, props, structures) into the world with a live ghost preview, validity feedback, optional grid-snapping, and host-authoritative commit — the core of shop/restaurant/sandbox builders.

## What it IS and when you need it

A placement system has three jobs:
1. **Preview** — show a non-networked "ghost" of the thing under the cursor, tinted green/red for valid/invalid.
2. **Validate** — decide whether the spot is legal (on the right surface, in bounds, not overlapping, affordable).
3. **Commit** — on click, the **host** clones the real prefab, marks the world as occupied, and `NetworkSpawn()`s it.

Reach for this whenever the player builds/decorates a space. Two flavours dominate the mined games: **free placement** (snap a single ghost to a traced surface — enifun.shop_manager, sandbox spawners) and **grid placement** (snap to integer cells, support multi-cell footprints + rotation — GASTROTOWN/restaurant_dev, emg shelves). Both share the same ghost→validate→host-commit spine.

## Canonical modern-s&box recipe

### 1. The ghost preview (client-local, NetworkMode.Never)

The ghost is a local clone with all logic/colliders stripped so it never blocks its own raycast or replicates. Tint it to show validity.

```csharp
// Clone the prefab as a ghost; strip everything but the renderer.
_ghost = resource.Prefab.Clone();
_ghost.NetworkMode = NetworkMode.Never;          // never replicates
foreach ( var c in _ghost.Components.GetAll<Collider>( FindMode.EverythingInSelfAndDescendants ) )
    c.Enabled = false;                            // ghost must not block its own trace
```

Tint by re-coloring every renderer when validity flips (enifun.shop_manager: `Code/Shop/ShopBuilder.cs:348`):

```csharp
var color = _canPlace ? GhostColorValid : GhostColorInvalid;   // green / red
foreach ( var r in _ghost.Components.GetAll<ModelRenderer>( FindMode.EverythingInSelfAndDescendants ) )
    r.Tint = color;
```

### 2. Cast the mouse ray and position the ghost

Top-down/RTS builders cast the camera's mouse ray; first-person builders trace from the eyes. **Always ignore the ghost's own hierarchy** or it traces itself (enifun.shop_manager: `Code/Shop/ShopBuilder.cs:294`):

```csharp
var ray   = camera.GetMouseRay();                 // or Camera.ScreenPixelToRay(Mouse.Position)
var trace = Scene.Trace.Ray( ray, 2000f )
    .IgnoreGameObjectHierarchy( _ghost )          // critical: skip the ghost itself
    .Run();
if ( !trace.Hit ) return;

_placePos = SnapToGrid( trace.HitPosition );      // free-placement: skip snap, use HitPosition
_ghost.WorldPosition = _placePos;
_ghost.WorldRotation = _placeRot;
```

Free-placement snap is just rounding to a unit grid (enifun.shop_manager: `Code/Shop/ShopBuilder.cs:705`):

```csharp
static Vector3 SnapToGrid( Vector3 p ) => new Vector3(
    MathF.Round( p.x / GridSize ) * GridSize,
    MathF.Round( p.y / GridSize ) * GridSize, p.z );   // GridSize = 8 here
```

### 3. Validate (client-side, for UI feedback only)

Walk the parent chain of the hit object for a required tag (you can't tag every child), then check overlap and any game rules (enifun.shop_manager: `Code/Shop/ShopBuilder.cs:318`, `:354`):

```csharp
static bool HasTagInParents( GameObject hit, string tag )
{
    for ( var cur = hit; cur != null; cur = cur.Parent )
        if ( cur.Tags.Has( tag ) ) return true;
    return false;
}

_canPlace = trace.GameObject != null
    && HasTagInParents( trace.GameObject, "shop_floor" )   // right surface
    && !IsOverlappingFurniture()                           // box-trace vs existing, WithoutTags the ghost
    && funds.CanAfford( item.Cost );                       // advisory affordability
```

### 4. Commit on the host (authoritative)

Client validity is advisory. The host re-checks and is the only place that clones the real object. Non-host clicks route through an `[Rpc.Host]`.

```csharp
void OnClickPlace()
{
    if ( !_canPlace ) return;
    if ( Networking.IsHost ) DoPlace( _placePos, _placeRot, SelectedIndex );
    else                     RequestPlaceItemOnHost( _placePos, _placeRot, SelectedIndex );
}

[Rpc.Host]
void RequestPlaceItemOnHost( Vector3 pos, Rotation rot, int index ) => DoPlace( pos, rot, index );

void DoPlace( Vector3 pos, Rotation rot, int index )
{
    if ( !Networking.IsHost ) return;                 // re-assert on host
    var real = Items[index].Prefab.Clone();
    real.WorldPosition = pos; real.WorldRotation = rot;
    real.GetComponent<Sellable>().Setup( Items[index] );
    real.NetworkSpawn();                              // now it replicates to everyone
    Scene.NavMesh.SetDirty();                         // pathing changed — rebake
}
```

### 5. Grid variant: cells, footprints, rotation

For grid builders the world is a `NetDictionary<Vector2Int, Cell>` keyed by cell coord, host-synced. World↔grid is round-to-cell (restaurant_dev: `Code/Common/Restaurants/RestaurantGrid.cs`). Multi-cell footprints rotate via a per-`Direction` offset matrix (restaurant_dev: `:238`):

```csharp
public static List<Vector2Int> GetOccupiedCells( Vector2Int anchor, Vector2Int size, Direction dir )
{
    var cells = new List<Vector2Int>();
    for ( int x = 0; x < size.x; x++ )
    for ( int y = 0; y < size.y; y++ )
    {
        var off = dir switch {              // 90° rotation per Direction
            Direction.North => new Vector2Int(  x,  y ),
            Direction.East  => new Vector2Int( -y,  x ),
            Direction.South => new Vector2Int( -x, -y ),
            Direction.West  => new Vector2Int(  y, -x ),
            _               => new Vector2Int(  x,  y ) };
        cells.Add( anchor + off );
    }
    return cells;
}
```

Placement validates **every** footprint cell, then clones + stamps cells + spawns (restaurant_dev: `:742`):

```csharp
public bool TryAddFurni( Vector2Int gridPos, FurniResource res, Direction dir, out GameObject furni )
{
    furni = null;
    if ( !Networking.IsHost ) return false;                  // host-authoritative
    var cells = GetOccupiedCells( gridPos, res.GridSize, dir );
    foreach ( var c in cells )                               // ALL cells must be free + in-bounds
    {
        if ( !IsValidGridPosition( c ) ) return false;
        if ( TryGetCell( c, out var ex ) && ex is { IsOccupied: true } ) return false;
    }
    furni = res.Prefab.Clone( new CloneConfig( new Transform(), Restaurant.GameObject ) );
    furni.WorldPosition = GridToWorldPosition( gridPos );
    furni.LocalRotation = dir.ToRotation();
    foreach ( var c in cells )                               // reassign whole struct (NetDictionary)
        _furniCells[c] = new() { Furni = res.Id, IsOccupied = true, Object = furni, IsAnchor = c == gridPos };
    furni.NetworkSpawn();
    return true;
}
```

## Variations seen across games

- **Free vs grid.** enifun.shop_manager & the ISpawner games place a single ghost on a traced surface; GASTROTOWN/restaurant_dev & emg use integer cell grids with multi-cell footprints + rotation.
- **Tool-strategy build mode.** GASTROTOWN's `BuildModeClient` holds a `Dictionary<BuildTool, IBuildTool>` of stateless tool strategies (Wall/Furni/Floor/Select/Destroy) sharing a `BuildContext { Grid, Server, PhantomManager }`; `SetActiveTool` calls `OnDeactivated/OnActivated`. Clean copyable pattern for multi-mode builders (`Code/Common/BuildMode/BuildModeClient.cs:31`, `Tools/FurniTool.cs:40`).
- **Bounds-derived grids.** emg.everything_must_go derives a stocking grid from the renderer's model `Bounds` (columns × rows) rather than a fixed world grid — items snap into the first free cell (`Code/Shelving/Shelf.cs:66`).
- **Ident-string spawn router.** Sandbox-style games (artisan.darkrpog, apl.sandboxwars) abstract placement behind `ISpawner` (`DrawPreview`, `Task<bool> Loading`, `Spawn(transform, player)`) and route an ident like `prop:path` through a switch, tracing from the eyes with surface-normal alignment (`Code/Spawner/ISpawner.cs:5`, `Code/GameLoop/GameManager.cs:1042`).
- **Front-clearance / spacing rules.** enifun adds a second "arrow" raycast so a shelf's customer-access front also lands on valid floor, plus min-distance-between-registers (`ShopBuilder.cs:320`).

## Gotchas

- **Ghost must be `NetworkMode.Never` with colliders/logic disabled** or it replicates, blocks its own raycast, or acts as a real object (enifun: `ShopBuilder.cs`; GASTROTOWN phantom uses tag exclusions `'phantom'/'agent'/'grabbed'`).
- **Ignore the ghost hierarchy in the placement trace** (`IgnoreGameObjectHierarchy(_ghost)`) and exclude floor/wall/spawn tags in the overlap trace (`WithoutTags`) — self-collision is the #1 false "invalid".
- **Client validity is advisory; the host re-validates.** Every commit path starts with `if (!Networking.IsHost) return;`, and non-host clicks go through `[Rpc.Host]` (all grid mutation in restaurant_dev is `if(!Networking.IsHost) return false;`).
- **`NetDictionary` cells hold structs — mutate by reassigning the whole struct**, not editing in place (restaurant_dev `_furniCells[c] = new(){...}`). NetList/NetDictionary only replicate from host.
- **Tag checks must walk parents** (`HasTagInParents`) because the hit collider is usually a deep child.
- **Rebake pathing after placing/removing** anything that affects walkable space: `Scene.NavMesh.SetDirty()` (enifun).
- **Multiple cell resolutions = off-by-N bugs.** GASTROTOWN keeps fine furni cells + 4× coarser wall/floor cells — mixing them silently misplaces things.
- **Never send `GameResource` refs over RPCs** — send a string `Id` and reconstruct via `ResourceLibrary.GetAll<T>().FirstOrDefault(r => r.Id == id)` on the host; refs don't round-trip on the wire (GASTROTOWN economy).
- **Pickup/move = hide original, re-run placement, re-commit** (enifun `_isPickupMode`); don't forget to destroy the ghost (`DestroyGhost`) or it leaks.

## Seen in

- **enifun.shop_manager** — `Code/Shop/ShopBuilder.cs` (free-placement ghost, grid-snap, front clearance, host RPC) — the cleanest single-file reference.
- **thefancylads.restaurant_dev** (GASTROTOWN) — `Code/Common/Restaurants/RestaurantGrid.cs` (multi-resolution cell grid, footprints, rotation), `Code/Common/BuildMode/BuildModeClient.cs` + `Tools/FurniTool.cs` (tool-strategy build mode + phantom).
- **emg.everything_must_go** — `Code/Shelving/Shelf.cs` (bounds-derived snap grid, host-authoritative `[Sync(FromHost)]` state).
- **artisan.darkrpog** — `Code/Spawner/ISpawner.cs`, `Code/GameLoop/GameManager.cs` (ISpawner + ident-string router, eye-trace placement).
- **apl.sandboxwars** — `sandbox/Code/Spawner/ISpawner.cs`, `GameManager.Spawn.cs` (ISpawner strategy + broadcast spawn dispatch).

Verify live: the placement API surface changes between SDK builds — confirm signatures against the installed SDK with the bridge's `describe_type` / `search_types` reflection (e.g. `describe_type Scene.Trace`, `GameObject`, `CloneConfig`, `NetworkMode`, `NetDictionary`) before relying on a method shape. See also the **sbox-api** skill (authoritative type/method lookup) and **sbox-build-feature** skill (the screenshot-driven place-it-and-look iteration loop).

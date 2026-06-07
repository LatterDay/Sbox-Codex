# Puzzle Game Recipe (s&box)

Build a grid/logic puzzle (sliding-tile, match, sokoban, etc.) in modern s&box: a pure C# rules model, thin Component adapters, a read-only visual layer, plus persistence + leaderboards + objectives. Mined from `simalami.15_puzzle_master`, the cleanest-layered codebase in the batch.

## What defines the genre

A puzzle game is **a deterministic rule simulation the player manipulates toward a goal state**. Almost everything that matters is engine-agnostic logic — board state, legal-move rules, win detection, scramble/generation, undo. The engine only does three things: read input, draw the board, and persist/submit scores. So the genre's whole architecture is "keep the rules pure, make the engine a thin shell." (puzzle: standoutPatterns[0])

**Core loop:** present a scrambled/authored start state → player issues moves (key, click/ray-pick, drag) → each move mutates the model and is recorded → re-check the win rule → on solve, evaluate objectives, persist progress, submit to leaderboard, unlock achievements → next level or new seed.

## The system stack

Compose these. The first three are the genre's spine; the rest are bolt-ons most puzzles want.

1. **Pure domain model** — a plain `sealed class` (no `Component`, no Sandbox types beyond `Vector3`/`Random`) owning tile state + move/win/shuffle rules. Fully unit-testable. (`Board.cs:19`)
2. **Component adapter** — a `Component` that *owns* a model instance and exposes it through **segregated interfaces** (`IPuzzleData` read / `IPuzzleCommands` write / `IPuzzleEvents` notify). Counts moves, ticks time, fires `OnSolved`. (`SlidingPuzzleLogic.cs:15`)
3. **Input controller** — a `Component` that ONLY reads `Input.*`/`Mouse.*` and forwards commands. Never picks tiles or builds rays. (`PuzzlePointerController.cs:12`)
4. **Visual layer** — runtime-spawned `GameObject`s + Razor UI that ONLY read `IPuzzleData`. See `references/systems/razor-ui.md`, `references/systems/runtime-gameobjects.md`.
5. **Local persistence** — `FileSystem.Data` JSON save/load (profiles, slots, resumable snapshots). See `references/systems/save-load.md`.
6. **Data-driven levels** — `FileSystem.Mounted` JSON level blueprints. See `references/systems/data-driven-content.md`.
7. **Objective / win-condition system** — strategy + factory over per-level star conditions. (`StarConditionFactory.cs:10`)
8. **Online leaderboards + achievements** — `Sandbox.Services.Stats`/`Leaderboards`/`Achievements`. See `references/systems/leaderboards-stats.md`.
9. **Undo/redo** — bit-packed reversible-move history. (`MoveHistory.cs:43`)
10. **Deterministic seeded generation** — scramble by N legal moves for guaranteed solvability. (`Board.cs:331`)

## Build order

Build the rules first, in isolation, then wrap them. Each step is independently runnable.

1. **Model + win rule.** Write the `Board` class: tile array, `tryMove*`, `isSolved()`, `shuffle()`. No engine references. You can `console_run`/unit-test it before any GameObject exists.
2. **Component adapter + events.** `SlidingPuzzleLogic : Component` holds a `Board`, exposes data/commands/events interfaces, raises `OnStateChanged`/`OnSolved`.
3. **One input path.** Keyboard `move()` first (simplest), then pointer pick. Verify a key actually slides a tile via screenshot.
4. **Visual board.** Spawn one `GameObject` per tile, `Vector3.Lerp` toward target cells each frame. Screenshot to confirm layout.
5. **Win → objective evaluation.** Route `OnSolved` to a star/condition evaluator (strategy+factory).
6. **Persistence.** Save progress + resumable snapshot to `FileSystem.Data`; load on start.
7. **Generation + undo.** Seeded scramble for replayable boards; bit-packed undo history.
8. **Leaderboards + achievements.** Submit on legitimate solves; wrap every call in try/catch.

## How the real game does it

### Pure model, zero engine dependency

`Board` is a `sealed class` — no base type, no `[Property]`. It owns the rules entirely; the comment on the adapter is the rule: *"Remove the Controller and Visual and this keeps working exactly the same."* (`SlidingPuzzleLogic.cs:13`)

```csharp
public sealed class Board                       // Board.cs:19 — no Component, no Sandbox deps
{
    public bool isSolved() => solveRule.isSolved( this );   // pluggable ISolveRule, default goal-rule

    public bool tryMoveAt( int index )          // Board.cs:307 — the one mutation
    {
        if ( index < 0 || index >= tiles.Length ) return false;
        if ( !isAdjacent( index, EmptyIndex ) || isFixed( tiles[index] ) ) return false;
        swap( index, EmptyIndex ); EmptyIndex = index; return true;
    }
}
```

### Component adapter exposes segregated interfaces

```csharp
// SlidingPuzzleLogic.cs:15
public sealed class SlidingPuzzleLogic : Component, IPuzzleData, IPuzzleCommands, IPuzzleEvents
{
    public event Action OnStateChanged;
    public event Action OnSolved;

    protected override void OnUpdate()          // SlidingPuzzleLogic.cs:52 — only timekeeping
    {
        if ( timing && !IsWon && !isPaused() )
            ElapsedSeconds += Time.Delta;
    }

    public void move( MoveDirection direction )  // command: mutate model, record, re-check win
    {
        if ( IsWon || board == null || isPaused() ) return;
        if ( !board.tryMoveDirection( direction ) ) return;
        Moves++; timing = true;
        history?.addMove( direction );
        checkSolved();                           // sets IsWon + fires OnSolved
        OnStateChanged?.Invoke();
    }
}
```

The visual subscribes to `OnStateChanged` and reads `IPuzzleData`; it never calls into `Board`. The folder layout enforces this — every prefab splits into `BusinessLogic/`, `Controller/`, `Visual/` subtrees. (puzzle: standoutPatterns[1])

### Input forwards only

The controller reads input and calls a command — no geometry, no model knowledge:

```csharp
protected override void OnUpdate()              // PuzzlePointerController.cs:25
{
    if ( isBlocked() ) return;
    if ( Input.Pressed( "Attack1" ) ) pointer?.click();   // logic owns the ray + pick
}
```

### Ray-pick a board with NO colliders

The logic component builds the ray from `Scene.Camera` and does pure geometry against tile positions — no physics. This is the modern, allocation-free way to click a grid. (`PuzzleSpatialBoard.cs:220`, `:236`)

```csharp
private Ray buildCursorRay()                    // PuzzleSpatialBoard.cs:220
{
    var camera = Scene.Camera;
    return camera == null ? default : camera.ScreenPixelToRay( Mouse.Position );
}

private int pickCircular( Ray ray )             // PuzzleSpatialBoard.cs:236 — closest-point-on-ray vs tile centre
{
    float scale = boardRoot.IsValid() ? boardRoot.WorldScale.x : 1f;
    int found = -1; float best = float.MaxValue;
    foreach ( var tile in entities )
    {
        var p = tile.Object.WorldPosition;
        float along = Vector3.Dot( p - ray.Position, ray.Forward );
        if ( along <= 0f ) continue;
        var closest = ray.Position + ray.Forward * along;
        if ( (p - closest).Length <= tile.PickRadius * scale && along < best )
        { best = along; found = tile.Value; }
    }
    return found;
}
```

For square hit-zones it ray-plane-intersects `boardRoot.WorldRotation.Forward` and maps the hit to a grid cell (`pickProGrid`, `PuzzleSpatialBoard.cs:266`). Either way: `Scene.Camera.ScreenPixelToRay`, not `Scene.Trace` — because the tiles are bare `GameObject`s with no colliders. (If you DO want physics picking, `Scene.Trace.Ray(camera.ScreenPixelToRay(Mouse.Position), dist).Run()` is the collider-based alternative.)

### Runtime GameObject board (spawn + lerp)

```csharp
boardRoot = Scene.CreateObject();               // PuzzleSpatialBoard.cs:359
boardRoot.Name = "Tiles";
boardRoot.Parent = BoardParent.IsValid() ? BoardParent : GameObject;
foreach ( int value in tileValues.OrderBy( v => v ) )
{
    var go = Scene.CreateObject();              // one GameObject per live tile value only
    go.Parent = boardRoot;
    // ... store TileEntity { Value, Object = go, Target } ...
}

// each frame, ease toward the target cell (PuzzleSpatialBoard.cs:211)
float t = MathF.Min( 1f, SlideSpeed * Time.Delta );
foreach ( var tile in entities )
    tile.Object.LocalPosition = Vector3.Lerp( tile.Object.LocalPosition, tile.Target, t );
```

Only rebuild when width/height/tile-set actually changes (`spawnedValues.SetEquals`, `PuzzleSpatialBoard.cs:345`) — never per frame. Spawn objects only for tile values present on the live board, or stray labels sit at the origin as ghost tiles. (`PuzzleSpatialBoard.cs:329`)

### Objectives: strategy + factory

Each level lists serialized `StarConditionData`; a factory maps the enum to a live strategy. Adding a condition type = one `case` + one class; the evaluator never changes (open/closed). (`StarConditionFactory.cs:10`)

```csharp
return data.Type switch                          // StarConditionFactory.cs:15
{
    StarConditionType.Completion => new CompletionConditionStar( data.Star ),
    StarConditionType.TimeLimit  => new TimeLimitConditionStar( data.Star, data.Value ),
    StarConditionType.MoveLimit  => new MoveLimitConditionStar( data.Star, (int)data.Value ),
    _ => null,
};
```

Already-earned stars aren't re-checked, so a worse replay can't lose them; earned stars OR into a per-level bitmask. (puzzle: systems "Objective / win-condition system")

### Deterministic, always-solvable generation

The trick that avoids unsolvable 15-puzzle states: **scramble by N random *legal* moves**, never a random permutation. Drive it from a seeded `Random` for reproducibility, and avoid immediate reverse moves so it mixes. (`Board.cs:331`)

```csharp
public void shuffleSeeded( int moveCount, Random random )   // Board.cs:331
{
    int previousEmpty = -1;
    for ( int i = 0; i < moveCount; i++ )
    {
        var candidates = neighborsOf( EmptyIndex ).Where( n => n != previousEmpty ).ToList();
        if ( candidates.Count == 0 ) candidates = neighborsOf( EmptyIndex );
        int pick = candidates[random.Next( candidates.Count )];
        previousEmpty = EmptyIndex;
        tryMoveAt( pick );
    }
}
// caller re-shuffles while isSolved() — tiny boards can land back on solved (SlidingPuzzleLogic.cs:272)
```

### Undo as a reversible-move log

Because a slide is reversible from its direction alone, history stores each move as a 2-bit value in a `ulong[]` ring buffer — a million moves under 250 KB, O(1), allocation-free, and serializable for resume. Undo replays the *opposite* slide; redo replays the original. (`MoveHistory.cs:43`, `SlidingPuzzleLogic.cs:107`)

```csharp
public void undo()                               // SlidingPuzzleLogic.cs:107
{
    if ( IsWon || history == null || !history.CanUndo ) return;
    board.tryMoveDirection( opposite( history.undo() ) );   // reverse slide
    if ( Moves > 0 ) Moves--;
    OnStateChanged?.Invoke();
}
```

For non-reversible puzzle actions (rotate, spawn) store full state deltas instead.

### Persistence: defensive, never-throw I/O

Profiles/levels/snapshots are plain DTOs written with `FileSystem.Data.WriteJson` and read with `ReadJsonOrDefault<T>`. Loads are length-guarded and clamped against the current level set so an old save can't crash a newer build; saves swallow exceptions so I/O never breaks gameplay. (`LevelProgression.cs:284`, `:342`; puzzle: standoutPatterns[3])

```csharp
var saved = FileSystem.Data.ReadJsonOrDefault<SaveData>( SaveFile, null );  // LevelProgression.cs:284
// ...validate/clamp every loaded array against levels.Count...
FileSystem.Data.WriteJson( SaveFile, data );                                // LevelProgression.cs:342
```

`FileSystem.Mounted` is READ-ONLY (authored level JSON); `FileSystem.Data` is the per-user writable store. Don't mix them.

### Leaderboards + achievements (best-effort)

On a *legitimate* solve (debug/cheat wins are flagged `SolvedByCheat` and excluded), push min-aggregated stats and force a flush; everything is wrapped so offline/unauthenticated never breaks the win flow. (`ClassicLeaderboardSubmitter.cs:49`, `ClassicLeaderboardQuery.cs:74`)

```csharp
Stats.SetValue( timeStat,  seconds, buildData( size, seed ) );   // submit; backend aggregates min
Stats.SetValue( movesStat, moves,   buildData( size, seed ) );   // ClassicLeaderboardSubmitter.cs:67
// query (ClassicLeaderboardQuery.cs:74):
var board = Leaderboards.GetFromStat( stat );
board.SetAggregationMin(); board.SetSortAscending();
board.FilterByMonth(); board.SetDatePeriod( DateTime.UtcNow ); board.MaxEntries = 50;
await board.Refresh();                                            // then read board.Entries
```

Per-entry custom data (the scramble seed) is NOT inline — fetch via `Entry.DataUrl` (one HTTP GET/row), so skip it for HUD mini-tables. `Task.WhenAll(IEnumerable)` is whitelist-blocked in sandbox: start all tasks, then `await` each in a loop. (`ClassicLeaderboardQuery.cs:110`)

## Gotchas

- **`MathF` is whitelisted here** (`MathF.Min`, `MathF.Floor` used throughout `PuzzleSpatialBoard.cs`) but some sandbox builds restrict members — verify before relying on an exotic one.
- **Input action names** (`"Attack1"`, `"Forward"`, `"Left"`, `"UpArrow"`) must exist in the project's input bindings or `Input.Pressed/Down` silently never fires.
- **Scene-mutating tools refuse during play mode** — stop play before editing the scene; spawn tiles at runtime from `OnStart`/`OnUpdate` instead.
- Keep the seed hash + RNG construction **frozen** — same seed+size must reproduce the exact board forever.

Verify live: the installed SDK is authoritative — `describe_type Sandbox.Services.Leaderboards`, `describe_type Sandbox.Services.Stats`, `describe_type Sandbox.Services.Achievements`, `describe_type Sandbox.FileSystem`, and `search_types ScreenPixelToRay` before coding against any of these; the Services/FileSystem surface shifts between versions.

Cross-links: use **sbox-api** (`describe_type`/`search_types` reflection) to confirm every type signature, and **sbox-build-feature** for the screenshot-driven build loop (spawn tiles → screenshot → adjust layout) that this genre lives or dies by.

# Party / Microgame-Collection Recipe

How to build a Fall-Guys-style party game — a rotating collection of short microgames with elimination — in modern s&box (GameObject/Component/Scene), distilled from one deep mined game: `vidya.terry_games` (Terry Games), a host-authoritative collection of ~15 microgames (Red Light Green Light, Tag, King of the Hill, Color Shuffle, Floor is Lava, Race, Soccer, Glass Bridge, Punch-Out, Mingle…) driven by one networked state machine and one synced clock.

## What defines the genre

A party-microgame game is a **round-rotator**: a single host-authoritative director runs a short loop — pick a random microgame valid for the current lobby, play it, decide winners, eliminate or score, repeat — until one player (or team) is left. The genre *is not* any one minigame; it's the **engine/content split** that lets you author a new 30-line microgame as a subclass while the director owns flow, timing, networking, and elimination.

Two halves you always build:

- **The director** (`GameSystem`): one networked 5-state machine beating off one `[Sync] TimeUntil`, plus a constraint-filtered random pool of microgame prefabs.
- **The microgame contract** (`Gamemode` base + subclasses): virtuals mirroring the director's states; each concrete mode overrides two or three.

**Core loop:** `Waiting (lobby fills) → Preparing (pick & spawn a microgame, show its name) → Playing (the mode's rules run, win/lose evaluated each tick) → Ending (kill non-winners, pay out) → back to Preparing`. Everything else (HUD timer, push verb, ragdolls, money) is scaffolding around that loop. (terry_games: `Code/Logic/GameSystem.State.cs:87-163`)

## The system stack to compose

Build these as separate components. References point to existing system docs where one applies.

| System | Role | Reference |
|---|---|---|
| Networked director / state machine | `[Sync(FromHost)]` 5-state FSM, host-only transitions | `references/systems/round-match.md` |
| Single synced clock (`TimeUntil`) | One heartbeat drives every transition + HUD | — (below) |
| Microgame base + lifecycle hooks | `abstract Gamemode : Component`, state-mirrored virtuals | — (below) |
| Data-driven microgame pool | `GameResource` `.mode` assets → constraint-filtered random pick | `references/systems/round-match.md` |
| Pawn-swap elimination | `AssignPawn<T>()` swaps player↔spectator pawn | — (below) |
| Win/condition resolution | `EndCondition {Failed,Won,Active}` + synced winner list | `references/systems/round-match.md` |
| Trigger-zone gameplay | `ITriggerListener` finish-lines, hazards, hill, tiles | — (below) |
| Per-mode synced sub-timer | second `[Sync] TimeUntil` + enum for internal phases | — (below) |
| Health / damage / ragdoll | `IDamageable` + `[Rpc.Host]` damage + ragdoll clone | `references/systems/progression-upgrades.md` (scoring seam) |
| Push / shove verb | the party-game core interaction (owner-predicted) | — (below) |
| Currency + Steam stats/achievements | payout to winners, `Sandbox.Services` | `references/systems/economy-currency.md`, `references/systems/leaderboards-services.md` |
| Scene-event bus | `ISceneEvent<T>` for decoupled cross-system signals | — (below) |

## The director: one FSM, one clock

The whole game beats off a **single** `[Sync(SyncFlags.FromHost)] TimeUntil TimerEnds`. The host advances state only when it elapses; clients just read it for the HUD. A *second* `TransitionEnds` double-gates the switch so resetting the timer inside `OnTimerEnd()` cleanly cancels a transition — that double-gate is the intended extension point. (terry_games: `Code/Logic/GameSystem.Timer.cs:88-102`)

```csharp
public enum GameState { Initializing, Waiting, Preparing, Playing, Ending }

public partial class GameSystem : Component
{
    [Sync(SyncFlags.FromHost | SyncFlags.Query)]
    public GameState CurrentState { get => _state; private set => InternalSetState(value); }

    [Sync(SyncFlags.FromHost)] public TimeUntil TimerEnds { get; set; }
    [Sync(SyncFlags.FromHost)] public TimeUntil TransitionEnds { get; set; }

    void TimerUpdate() // called every OnUpdate
    {
        if (!Networking.IsHost) return;
        if (!TimerEnds) return;                 // TimeUntil is false until it elapses
        if (!IsTransitioning) OnTimerEnd();     // host may reset the timer here to cancel
        if (TimerEnds && TransitionEnds) SwitchToNextState();
    }
}
```

State *entry* is a switch that calls `On<State>State()` hooks (which set `TimerEnds` for that state's duration) and fires a scene event; per-frame work lives in `StateUpdate → On<State>Update()`, and each delegates to the active mode. **Every transition is host-only** — clients must never call `SetState`. `Initializing` is a fake state that immediately collapses to `Waiting`. (terry_games: `Code/Logic/GameSystem.State.cs:73-128`, `:197-209`)

```csharp
void InternalSetState(GameState state)
{
    if (_state == state) return;
    _state = state;
    switch (state)
    {
        case GameState.Initializing: _state = GameState.Waiting; OnWaitingState(); break;
        case GameState.Preparing:    OnPreparingState();  break; // sets TimerEnds=3, spawns mode
        case GameState.Playing:      OnPlayingState();    break; // TimerEnds = mode.PlayingTime
        case GameState.Ending:       OnEndingState();     break; // mode.OnEnding() kills losers
    }
    Scene.RunEvent<IGameEvent>(x => x.OnGameStateChanged(state)); // decoupled bus
}
```

## The microgame contract: state-mirrored virtuals

`abstract Gamemode : Component` is the per-round plugin. It exposes virtuals that **mirror the director's states** (`OnWaiting/OnPreparing/OnPlaying/OnEnding` + `*Update` variants), plus `GetCondition(timeOut)` for win/lose, `DetermineWinners()`, and `GetTimerText()`. Designer-tunable knobs live on the base as `[Property]`: `PreparingTime/PlayingTime/EndingTime`, `MinRequiredPlayers/MaxAllowedPlayers`, `EvenPlayersOnly`, `EndWithOnePlayer`. A new microgame overrides a handful. (terry_games: `Code/Logic/Gamemodes/Base/Gamemode.State.cs:42-92`)

```csharp
public partial class Gamemode : Component
{
    public virtual void OnPreparing() { }   // setup: spawn props, place players
    public virtual void OnPlaying()   { }   // start the rules
    public virtual void PlayingUpdate() { } // per-frame rule eval (host-gated inside)
    public virtual void OnEnding()    { }   // most modes: kill everyone who isn't a winner
    // Win/lose: return Active to keep playing
    public virtual EndCondition GetCondition(bool timeOut) => /* base handles 0-alive, etc. */;
}
```

This engine/content split is the single most teachable lesson here: the director is generic, the mode supplies content. A whole microgame can be a ~30-line subclass.

## Data-driven microgame pool with lobby constraints

Don't hardcode a mode list. Author `.mode` `GameResource` assets each holding prefab variants; the director keeps a net-synced pool and picks a random valid one. `canBeNextGamemode()` **reflects each candidate prefab's `Gamemode` component** and rejects on: same-as-last, odd count vs `EvenPlayersOnly`, `living < MinRequiredPlayers`, `living > MaxAllowedPlayers`. (terry_games: `Code/Logic/GameSystem.Mode.cs:162-202`)

```csharp
bool canBeNextGamemode(PrefabFile prefab)
{
    var go = GameObject.GetPrefab(prefab.ResourcePath);
    if (!go.Components.TryGet<Gamemode>(out var mode)) return false;
    if (Game.IsEditor) return true;            // solo dev ignores all player-count rules
    if (prefab == LastGamemode) return false;
    var living = Scene.GetLivingClients().Count();
    if (living % 2 != 0 && mode.EvenPlayersOnly) return false;
    if (living < mode.MinRequiredPlayers) return false;
    if (mode.MaxAllowedPlayers is int max && living > max) return false;
    return true;
}
```

Refill when exhausted; clone the chosen prefab and `NetworkSpawn` it. This is reusable for any "pick a valid next level/event/wave for the current lobby" problem. **Gotcha:** `Game.IsEditor` short-circuits to always-true, so constraints go untested when you solo-test in the editor.

## Pawn-swap elimination (player ↔ spectator)

Elimination is **not** "disable input" — it's swapping the pawn type. The 'ShrimplePawns' layer: a `Client : Component` holds a synced `ConnectionId` + current `Pawn`; `AssignPawn<T>()` resolves the prefab path from a `[Pawn("prefabs/…")]` attribute on the pawn type, clones it, network-spawns it, and reassigns ownership. One mechanism covers spawn, death→spectator, and the winning-screen pawn. (terry_games: `Code/Client.cs:82-156`, `Code/PawnAttribute.cs:10-13`)

```csharp
[Pawn("prefabs/spectate.prefab")] public sealed class SpectatePawn : Pawn { /* ... */ }

// Host-only elimination at a finish line / hazard:
void ITriggerListener.OnTriggerEnter(GameObject other)
{
    if (!Networking.IsHost) return;
    if (!other.Components.TryGet<PlayerPawn>(out var p, FindMode.EverythingInSelfAndParent)) return;
    Round.AddWinner((Client)p.Owner);
    p.Owner.AssignPawn<SpectatePawn>(p.WorldTransform); // swap to spectator
    p.GameObject?.Destroy();
}
```

`AssignPawn` is strictly host-only; forget the `[Pawn]` attribute and it silently logs and returns null. `InternalAssign` does a careful `Network.ClearInterpolation()` dance around `WorldTransform` so the new pawn doesn't lerp in from origin — copy it exactly or pawns teleport visibly. (terry_games: `Code/Client.cs:135-148`)

## Win/condition resolution (decoupled from elimination)

`EndCondition {Failed, Won, Active}`. Each `PlayingUpdate` calls the mode's `GetCondition(timeOut)`; a non-`Active` return sets state to `Ending` and runs `DetermineWinners()`. Winners accumulate in a synced `List<Client>` via a `[Rpc.Host] AddWinner` (deduped). The base `GetCondition` handles the common cases: 0 alive = `Failed`; `EndWithOnePlayer` & 1 alive = that player wins; timeout falls back to a per-mode `TimeOutEndCondition`. (terry_games: `Code/Logic/Gamemodes/Base/Gamemode.Logic.cs:36-173`)

**Gotcha:** most modes' `OnEnding` does `if(!IsWinner(player)) player.DamagePlayer(100)` — winners must be registered **before** the Ending state or they get killed. And `GetCondition` skips the one-player-win shortcut in `Game.IsEditor` so solo rounds don't instantly end.

## Per-mode synced sub-timer (late-joiner-safe sequencing)

When a microgame needs internal phases (RLGL's doll: `Idle → Singing → Staring`), do **not** use `async`/await delays. Use a *second* net-synced `TimeUntil` + a synced enum, advanced in `PlayingUpdate`. A mid-game joiner reads the synced `TimeUntil` and reconstructs the exact phase; the host can cancel/retime freely. This is the s&box-correct answer to "timed sequence in multiplayer." (terry_games: `Code/Logic/Gamemodes/RLGL/RedLightGreenLight.cs:164-231`)

```csharp
public enum DollState { Idle, Singing, Staring }
[Sync(SyncFlags.FromHost)] public DollState CurrentDollState { get; set; }
[Sync(SyncFlags.FromHost)] public TimeUntil NextDollState { get; set; }

public override void PlayingUpdate()
{
    if (!Networking.IsHost) return;
    if (!NextDollState) return;          // synced TimeUntil, not an async delay
    OnDollStateEnd(CurrentDollState);    // switch → set next enum + duration
}
void SetDollStateAndDuration(DollState s, float dur) { CurrentDollState = s; NextDollState = dur; }
```

Sync **both** the enum and the `TimeUntil`. (terry_games: `Code/Logic/Gamemodes/RLGL/RedLightGreenLight.cs:227-231`)

## Trigger-zone gameplay (the microgames themselves)

Most microgames are `Component.ITriggerListener` zones: finish-lines add a winner + spectate (Race/RLGL); a `DamageTrigger` kills on contact (lava/walls); King of the Hill reads `Collider.Touching` each frame to accumulate `TimeInHill`; Color Shuffle reads which tiles players touch and kills those off the winning color. The shared idiom — **always host-gate and resolve the player up the hierarchy:**

```csharp
if (!Networking.IsHost) return;  // callbacks fire on every peer — gate or you double-apply
if (!other.Components.TryGet<PlayerPawn>(out var p, FindMode.EverythingInSelfAndParent)) return;
// the collider is usually on a CHILD of the pawn — EverythingInSelfAndParent is required
```

`Collider.Touching` can be empty/null and one pawn can register multiple colliders — guard with `.Any()`/`.Distinct()`. (terry_games: `Code/Logic/Gamemodes/KingOfTheHill/KingOfTheHill.cs:41-83`, `Code/Player/Health.cs:89-98`)

## The push verb + scaffolding

Party games need one shared interaction: **push/shove**. Poll `Input.Pressed("attack1")` (owner only) in `OnFixedUpdate`, enforce a `TimeSince` cooldown, sphere-trace forward, push any `Pushable` in the hit hierarchy, and `[Rpc.Broadcast]` the anim/sound/particle for feel. The active mode can veto via `Gamemode.CanPush`. (terry_games: `Code/Player/PlayerPush.cs:7-86`)

Round out with: host-authoritative damage via `[Rpc.Host] DamagePlayer` + a ragdoll clone on death (terry_games: `Code/Player/Player.cs:193-301`); winner payout + `Sandbox.Services.Achievements.Unlock`/`Stats.Increment` wrapped in `[Rpc.Owner]` so they run on the right user's client and no-op in editor (terry_games: `Code/Player/Player.cs:69-85`); and an `ISceneEvent<T>` bus (`IGameEvent`/`IGamemodeEvent`) so systems signal each other without holding references (terry_games: `Code/Logic/GameSystem.State.cs:10-27`).

## Build order

1. **Director skeleton.** `GameSystem : Component` with the `GameState` enum, `[Sync(FromHost)] CurrentState`, `[Sync(FromHost)] TimerEnds`, and `TimerUpdate`/`InternalSetState`/`SwitchToNextState`. Loop Waiting↔Preparing with a placeholder. Verify the timer counts down on a client.
2. **Microgame base.** `abstract Gamemode : Component` with the state-mirrored virtuals and `[Property]` knobs. Wire the director's state switch to `GetGamemode()?.On<State>()`.
3. **One real microgame** as a subclass (start with Race or RLGL — pure trigger logic). Author its prefab; override `OnPlaying`/`GetCondition`.
4. **Pawn-swap elimination.** Add `Client`/`Pawn`/`[Pawn]` + `AssignPawn<T>()`; swap to a SpectatePawn on death/finish.
5. **Data-driven pool.** `.mode` `GameResource` assets + `canBeNextGamemode()` constraint filter; refill + clone + `NetworkSpawn`.
6. **Win resolution + payout.** `EndCondition`, synced winner list, `OnEnding` kills losers, winning-screen pays out.
7. **More microgames + the push verb + ragdolls + Steam stats.** Each new mode is a thin subclass + a prefab.

## Pitfalls (from the real game)

- **Host-only everything.** Transitions, mode selection, `AssignPawn`, trigger logic, sub-timers — all guarded with `if (!Networking.IsHost) return`. Clients only read synced state.
- **Register winners before `Ending`.** `OnEnding` kills non-winners; a late `AddWinner` kills the winner.
- **`Game.IsEditor` shortcuts mask bugs.** Pool constraints and one-player-win are bypassed in editor — test multiplayer for real before shipping.
- **Two synced `TimeUntil`s, not async.** The global clock *and* per-mode sub-timers are synced so mid-game joiners reconstruct phase. Never sequence with `await Task.Delay`.
- **`FindMode.EverythingInSelfAndParent`** when resolving a pawn from a trigger — the collider is a child.
- **`[Sync]` `TimeUntil` reads `false` until it elapses** — `if (!TimerEnds)` means "not yet done." Don't invert it.

## Verify live

Reflection is the source of truth for the installed SDK — confirm the networking/lifecycle surface before writing it:

- `describe_type SyncFlags` / `describe_type TimeUntil` — confirm `FromHost`/`Query` flags and the implicit-bool/`Relative` members.
- `search_types Rpc` and `describe_type` the attribute — confirm `Rpc.Host`/`Rpc.Broadcast`/`Rpc.Owner` exist as written.
- `describe_type GameResource`, `Connection`, `Component.ITriggerListener`, `INetworkListener` — confirm the data-asset + networking interfaces.
- `search_types ISceneEvent` — confirm the scene-event bus API before defining `IGameEvent`.

Cross-links: see **sbox-api** for authoritative type/method lookups (`describe_type`/`search_types`) and **sbox-build-feature** for the screenshot-driven build-and-verify loop that keeps the bridge out of guess-and-check.

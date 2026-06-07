# Round / Match Flow (host-authoritative state machine)

The spine of nearly every multiplayer s&box game: a networked manager that drives a match through ordered phases (Lobby → Prep → Round → Resolution → GameOver), counts down a timer, and runs entry/exit side effects per phase. This is the single most-reused system across the mined games.

## What it IS / when you need it

You need this the moment a game has *phases* — a warm-up before a round, a timed round, a results screen, a vote, a loop back. The canonical shape is one `Component` ("GameManager" / "RoundManager" / "GameSystem") holding the authoritative state, ticked only on the host, with all clients reading replicated fields for their HUD. Don't reach for it for purely cosmetic/local sequencing (a flickering light FSM is plain local `OnUpdate`, no sync — repo/mishmaps.backrooms: LightFlicker.cs:52).

## Canonical modern-s&box approach

**1. State enum + a `[Sync(SyncFlags.FromHost)]` state property whose setter is the transition hook.**
`FromHost` means clients literally cannot write it — only the host mutates, clients replicate. Putting the side-effect switch in the *setter* (not a `[Change]` callback) means the host runs entry logic exactly once on transition (repo/vidya.terry_games: GameSystem.State.cs:48-109).

```csharp
public enum GameState { Lobby, Preparing, Round, Resolution, GameOver }

[Sync( SyncFlags.FromHost )]
public GameState State
{
    get => _state;
    private set => SetState( value );   // setter IS the transition
}
private GameState _state = GameState.Lobby;

void SetState( GameState next )
{
    if ( _state == next ) return;       // guard re-entry (GameSystem.State.cs:75)
    _state = next;
    switch ( next )                     // entry side effects, host-side
    {
        case GameState.Preparing: EnterPreparing(); break;
        case GameState.Round:     EnterRound();     break;
        case GameState.Resolution:EnterResolution();break;
        case GameState.GameOver:  EnterGameOver();  break;
    }
    Scene.RunEvent<IGameEvent>( e => e.OnGameStateChanged( next ) ); // tell UI/audio
}
```

**2. A single replicated timer as the heartbeat.** Two idioms, both seen widely:
- A `[Sync] float StateTimer` decremented each host tick (repo/suburbianites.blindloaded: GameManager.cs:237).
- A `[Sync] TimeUntil TimerEnds` set on entry and polled with `if(!TimerEnds) return;` — self-rearming, and a late joiner reads the synced deadline and is instantly in sync (repo/vidya.terry_games: GameSystem.Timer.cs:14, :88-102).

```csharp
[Sync( SyncFlags.FromHost )] public TimeUntil TimerEnds { get; set; }

void EnterRound() { TimerEnds = RoundDuration; /* spawn hazards, reset scores */ }
```

**3. Tick ONLY on the host, switch on state.** Non-host peers early-return before any logic; they are pure readers (repo/goders.natural_disaster_survival: RoundManager.cs:72-141; repo/suburbianites.blindloaded: GameManager.cs:212-267).

```csharp
protected override void OnUpdate()
{
    UpdateLocalHud();                       // client-safe work BEFORE the gate
    if ( !Networking.IsHost ) return;       // host-only past here

    switch ( State )
    {
        case GameState.Preparing: if ( TimerEnds ) SetState( GameState.Round );      break;
        case GameState.Round:     if ( TimerEnds || EveryoneDead() ) SetState( GameState.Resolution ); break;
        case GameState.Resolution:if ( TimerEnds ) SetState( GameState.GameOver );   break;
        case GameState.GameOver:  if ( TimerEnds ) SetState( GameState.Lobby );      break;
    }
}
```

**4. Editor-placed managers must `NetworkSpawn` themselves or `[Sync]` silently won't replicate.** An object dropped in the scene is not networked by default; latch it on the host in `OnStart` (repo/suburbianites.blindloaded: GameManager.cs:201).

```csharp
protected override void OnStart()
{
    if ( Networking.IsHost && !Network.Active )
        GameObject.NetworkSpawn();          // now [Sync] fields replicate to clients
}
```

**5. Client → host commands route through `[Rpc.Host]` (or a Broadcast guarded by `IsHost`).** A ready-up, a vote, a gamble — the client never sets state; it asks the host to.

```csharp
[Rpc.Host]                                  // runs on the host regardless of caller
public void RequestReady()
{
    if ( !Networking.IsHost ) return;       // belt-and-braces
    ReadyPlayerIds.Add( Rpc.CallerId );     // re-validate the caller, never trust args
}
```

## Notable VARIATIONS across the games

- **Setter-switch vs explicit `Set*()` switch.** Terry Games puts the switch in the property setter (GameSystem.State.cs:73); Natural Disaster uses a dedicated `SetRoundState()` that guards `IsHost` + no-op-on-same and runs the switch (repo/goders.natural_disaster_survival: RoundManager.cs:164-175). Same effect; the setter form prevents anyone from skipping the hook.
- **Generic machine + pluggable gamemode.** The state machine owns NO rules — each phase forwards to the active mode: `GetGamemode()?.OnPlaying()`. New microgames are prefabs + a `Gamemode : Component` subclass overriding `OnWaiting/OnPreparing/OnPlaying/OnEnding` + `GetCondition()`, with `[Property] PreparingTime/PlayingTime` tunables (repo/vidya.terry_games: Gamemode.cs:7-104). `playbtg.elevator` and `treehaven.sdiver` do the same with `BaseLevelController` / `BaseGameMode` created/destroyed at runtime.
- **Real-time vs delta timer.** Most decrement `Time.Delta`; `khamitech.battledraft` stores `[Sync] DateTime RoundExpires = UtcNow + duration` and compares wall-clock client-side — fine for a HUD countdown, NOT tick-accurate (GunGameManager.cs:19, GunGame.cs:327).
- **Transition fade double-gate.** Terry Games won't advance until BOTH `TimerEnds` AND `TransitionEnds` are done, so resetting the timer inside `OnTimerEnd()` cancels the switch — the intended (non-obvious) extension point (GameSystem.Timer.cs:99-101).
- **Self-rearming curve cadence inside a phase.** Instead of fixed sub-timers, Natural Disaster evaluates a designer `[Property] Curve` against round progress into a `[Sync] TimeUntil`, polled `if(!timeUntil)` — escalating spawn rate (repo/goders.natural_disaster_survival: disaster_manager.cs:404-411).
- **Map/mode vote between rounds.** A `[Rpc.Host] SendVote(index)` tallies per-SteamId into a dict, debounces ~2s, picks majority (or plurality on timeout) — `apl.sandboxwars`, `khamitech.battledraft` (VoteMapSystem.cs:41), `goders` map vote.

## Gotchas

- **Editor-placed manager not networked → silent no-replication.** The #1 bite: `[Sync]` does nothing until the host `NetworkSpawn`s the manager GameObject (repo/suburbianites.blindloaded: GameManager.cs:201).
- **Clients' synced timer JUMPS between snapshots, it does not tick locally.** For smooth countdown *audio*, keep a LOCAL clock seeded on phase entry rather than reading the snapshot every frame (repo/suburbianites.blindloaded: GameManager.cs:283 `_localCountdown`).
- **Entry side effects live in the transition switch, not a `[Change]` handler** — a late joiner who only reads the synced enum will NOT replay entry logic; design so the already-synced state is enough, or run a one-shot reconcile (repo/goders.natural_disaster_survival: RoundManager.cs:164).
- **Host migration nukes host-only state.** A promoted client has all private arrays null and a stale `[Sync] State`. On `OnBecameHost`, hard-reset / rebuild scene-scanned objects (`Scene.GetAllComponents<Panel>()`, destroy orphans) before trusting anything; keep a `_hostInitialized` fallback in `OnUpdate` for when `OnBecameHost` misfires (repo/suburbianites.blindloaded: GameManager.cs:229, PlayerSpawner.cs:82). Set `LobbyConfig.AutoSwitchToBestHost=false` or a better-ping joiner can migrate *a live match*.
- **Order `OnStart` carefully.** Natural Disaster `await Task.FrameEnd()` before touching state to dodge OnStart ordering; Terry Games has a fake `Initializing` state that immediately collapses to `Waiting` (GameSystem.State.cs:90).
- **Single-player editor testing.** Special-case it (`Game.IsEditor`) so the round doesn't end with one player / so player-count constraints don't block dev iteration (repo/goders: RoundManager.cs:107; repo/vidya: GamemodeResource canBeNextGamemode short-circuits in editor).
- **Re-validate every client request on the host.** Never trust args from `[Rpc.Host]`; re-clamp and check `Rpc.CallerId` (repo/vault77.chop_the_forest: PlayerProgression.cs request→apply→confirm triad).

## Seen in

- `suburbianites.blindloaded` — Blind: 8-phase host FSM, `[Sync] State`+`StateTimer`, lazy `NetworkSpawn`, local countdown clock, host-migration hard reset (Code/Game/GameManager.cs:212, :240; PlayerSpawner.cs:82).
- `vidya.terry_games` — generic `GameSystem` machine + `Gamemode` plugin base + `[Sync] TimeUntil TimerEnds` + `ISceneEvent` bus (Code/Logic/GameSystem.State.cs, GameSystem.Timer.cs, Gamemodes/Base/Gamemode.cs).
- `goders.natural_disaster_survival` — `RoundManager` 5-state, curve-driven wave cadence, map vote + scene swap (Code/globals/RoundManager.cs:72, :164; Code/disasters/disaster_manager.cs:404).
- `khamitech.battledraft` — wall-clock `RoundExpires`/`IsPlayMode` + `VoteMapSystem` (Code/Addons/GunGame/GunGame.cs:327; Code/Utils/VoteMapSystem.cs:41).
- `apl.sandboxwars` — `MiniGameManager` ModeSelect→Build→Battle + chat-vote skip (sandbox/Code/MiniGameManager.cs:14, :460).
- `playbtg.elevator` — `ExperienceManager` round rotation + host-migration survival via serialized queue (elevator/Code/Experiences/ExperienceManager.cs:174).
- `treehaven.sdiver` — `GameManager` + swappable `BaseGameMode` created/destroyed at runtime (Code/Managers/GameManager.cs:176; Code/Gameplay/GameMode/ExpeditionMode.cs:172).
- `clearlyy.s_miner` — vote → shared world reset round flow (MineReset.cs:125, :241).
- `dimmies.terryspapers` — in-game clock / day-cycle with a `TaskCompletionSource` "wait until world idle" day-end gate (Code/GameHandler.cs:124).

## Verify live

The installed SDK is authoritative — reflect, don't trust memory. Confirm the exact members before coding:
`describe_type TimeUntil`, `describe_type Sandbox.SyncFlags`, `search_types Rpc`, `describe_type Networking` (look for `IsHost`/`IsActive`), and `describe_type Connection` for `Rpc.CallerId` / `Rpc.Caller`.

Cross-links: see **sbox-api** for the reflection workflow (`describe_type`/`search_types`) and **sbox-build-feature** for the screenshot-driven build/verify loop that turns this recipe into a working manager.

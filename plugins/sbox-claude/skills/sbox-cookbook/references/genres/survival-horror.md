# Survival-Horror Recipe

How to build a survival-horror game in modern s&box (GameObject/Component/Scene), distilled from three mined games: `goders.natural_disaster_survival` (a round-based "survive the environmental threat" party game), `mishmaps.backrooms` (a near-pure-atmosphere flickering-maze), and `treehaven.sdiver` (a networked co-op underwater extraction run in the Lethal Company mold).

## What defines the genre

Survival-horror is a **resource-pressure loop under an escalating, mostly-environmental threat in a hostile space**. The player is rarely the aggressor; they manage depleting vitals (HP, air, stamina, light) while an *external* force — a disaster wave, a pressure gradient, the dark itself, or a stalking creature — escalates until they either extract/survive or die. Three sub-shapes appear, and a real game usually fuses two of them:

- **Atmosphere-first** (`backrooms`): the threat *is* the place. Almost zero gameplay code — the shipped zip is one ~125-line `NeonFlickerLight` FSM that sells the dread (backrooms/Code/LightFlicker.cs:52). Dread comes from sound + light + level geometry, not mechanics. This is the cheapest, highest-leverage layer and you build it first.
- **Round/wave survival** (`natural_disaster_survival`): a host-authoritative state machine runs `PRE → ACTIVE → POST` rounds; an escalating, weighted-random environmental hazard (disaster waves) tries to kill everyone; survivors bank currency for persistent meta-upgrades (NDS: Code/globals/RoundManager.cs:72, Code/disasters/disaster_manager.cs:111).
- **Co-op extraction** (`sdiver`): a team descends into a foggy hostile zone, grabs loot under a vitals clock (air/pressure/stamina), and must haul it back to hit an escalating daily quota or the run ends. Vitals depletion + dynamic fog + creatures supply the horror; the quota supplies the compulsion (sdiver: Code/Gameplay/GameMode/ExpeditionMode.cs:85, Code/Player/DiverState.cs:120).

**Core loop:** `enter the space → manage depleting vitals (HP/air/stamina/light) → the threat escalates (wave / pressure / dark / creature) → survive-or-extract → bank reward → (re)descend harder`. Horror is *pacing of pressure*: the threat must outrun the player's ability to replenish.

## The system stack to compose

Build these as separate Components. References point to existing system docs.

| System | Role | Reference |
|---|---|---|
| Atmosphere FSM (light/fog/sound) | Flicker, dynamic fog, ambient dread — the cheap horror | — (below) |
| Vitals / survival meters | HP + air + stamina + light, depletion + damage-over-time | `references/systems/progression-upgrades.md` (stat seam) |
| Round / phase state machine | `[Sync]` host FSM: prep → active → summary → loop | `references/systems/round-match.md` |
| Escalating threat spawner | Weighted-random + curve-driven cadence that ramps | `references/systems/spawning-waves.md` |
| Threat actor (hazard or creature) | Physics-force disaster *or* a stalking enemy AI | `references/systems/spawning-waves.md` |
| Raycast interactor (hold-to-use) | Eye-trace + outline + hold bar for pickups/terminals | `references/systems/inventory.md` |
| Slot inventory + pickups | Host-authoritative grab with race-lock | `references/systems/inventory.md` |
| Quota / economy + carry-over | Escalating target, over-quota bonus, persistent bank | `references/systems/economy-currency.md` |
| Persistent meta-upgrades | Save/load upgrade tree spent between runs | `references/systems/save-persistence.md`, `progression-upgrades.md` |
| Dual-body life-state (spectate) | Living → ragdoll → spectator on death | — (below) |
| Reconnect / sleeping-body | Disconnect leaves a body; reconnect restores gear | `references/systems/save-persistence.md` |
| Stats / leaderboard push | Survivals, deaths, quota → backend | `references/systems/leaderboards-services.md` |

## The authority idiom that makes it work

**Host-authoritative simulation; clients are pure readers of `[Sync]` state.** Every threat tick, vitals decrement, phase transition, and spawn runs inside a single `if (!Networking.IsHost) return;` gate at the top of `OnUpdate`/`OnFixedUpdate`. Clients never simulate the threat — they read synced enums/scalars and render. This is the discipline that keeps a dozen horror systems auditable.

```csharp
protected override void OnUpdate()
{
    if ( !Networking.IsHost ) return;        // host-only simulation; clients read [Sync]
    TickRoundTimer();
    switch ( roundState )                    // [Sync] RoundState enum
    {
        case RoundState.PRE_ROUND:    if ( CurrentRoundTime <= 0 ) SetRoundState( RoundState.ACTIVE_ROUND ); break;
        case RoundState.ACTIVE_ROUND: /* all-dead early-exit + timeout → POST */ break;
    }
}
```
(NDS: Code/globals/RoundManager.cs:72-120 the gate + switch; :164 `SetRoundState` runs entry hooks. The same gate guards spawning at Code/disasters/disaster_manager.cs and the sdiver mode tick at Code/Gameplay/GameMode/GameManager.cs.) **Per-player local-only logic is the mirror image:** vitals/post-processing in sdiver run only for `Diver.Local` and proxies early-return (sdiver: Code/Player/DiverState.cs — all visual/vital code is owner-only).

## Build order

Atmosphere first (it's cheap and it *is* the genre), then vitals, then the threat, then the loop, then networking depth.

1. **Atmosphere.** Flickering light FSM + dynamic fog + ambient sound. A lit-correctly empty maze is already scary. Pure client-local visual code, no networking (backrooms/Code/LightFlicker.cs).
2. **Vitals meters.** HP + whatever else fits your fiction (air, stamina, light, sanity). Deplete per-second; apply damage-over-time when a threshold is crossed (sdiver pressure: Code/Player/DiverState.cs:120). Owner-local.
3. **Round/phase FSM.** `[Sync]` host-authoritative enum + countdown timer; entry hooks per state. The skeleton of prep → active → summary (NDS: RoundManager.cs:72; sdiver mode switchboard).
4. **The threat.** Pick a shape: a physics-force *hazard* (tornado/flood) or a stalking *creature* AI. Spawn it from the host on an **escalating** cadence (next step).
5. **Escalating spawner.** Weighted-random pick (with anti-streak pity) + a designer `Curve` evaluated against round progress → a `[Sync] TimeUntil` self-rearming clock that fires faster as the round wears on (NDS: disaster_manager.cs:111 + :404).
6. **Interactor + inventory.** Eye-trace hold-to-use interactor (outline + hold bar) and a host-authoritative slot inventory with a tag-as-mutex pickup lock (sdiver: Code/Interaction/PlayerInteractor.cs, Code/Items/PlayerToolbar.cs).
7. **Reward loop.** Quota/currency with carry-over + over-quota bonus (sdiver: ExpeditionMode.cs:85), or survive-cash + a 3D shop of persistent meta-upgrades saved to disk (NDS: DataManager.cs, ShopItem.cs).
8. **Death → spectate.** Dual-body life-state: on death spawn a networked ragdoll, swap to a free-fly spectator camera, count the death (NDS: NetworkPlayer.cs).
9. **Networking depth.** Reconnect-into-sleeping-body, stats/leaderboard push, chat.

## How the real games do each piece

### Atmosphere — a per-instance flicker FSM, no networking
The whole of Backrooms' gameplay code is one sealed Component running a 3-state machine (`Off`/`On`/`Burst`) in `OnUpdate`, timed by a `RealTimeSince stateTimer` compared against a `Game.Random`-seeded `nextAction` threshold. `Burst` is the "dying neon" effect — it rapidly toggles `Light.Enabled` for a random count before returning to a steady state. Every duration is an inspector `[Property]` min/max pair so designers retune the whole feel.

```csharp
case State.Burst:
    if ( stateTimer > nextAction ) {
        stateTimer = 0;
        Light.Enabled = !Light.Enabled;          // the dying-fluorescent flicker
        if ( ++burstCount >= burstTarget ) SwitchState( RandomState() );
        else nextAction = Game.Random.Float( BurstMinSpeed, BurstMaxSpeed );
    }
    break;
```
(backrooms/Code/LightFlicker.cs:52 OnUpdate FSM, :91 `RandomState`, :96 `SwitchState`.) **The light reference is auto-wired in three escalating fallbacks** — `[Property]` first, then `Components.Get<PointLight>()`, then `GetComponentInChildren<PointLight>()`, then `Log.Error` (backrooms/Code/LightFlicker.cs:28-45). A great default for any "effect needs a sibling component" recipe. **Gotcha:** this is pure local visual code — in multiplayer each client flickers on its own `Game.Random` sequence, so lights will NOT match across clients. Fine for ambience, wrong for anything gameplay-relevant (e.g. a light that gates a creature). For dynamic *fog* horror, sample depth/distance-indexed `Curve`s on a config `GameResource` to drive `CubemapFog` distance+tint each frame (sdiver: Code/Player/DiverState.cs — fog/light/saturation all curve-driven by depth).

### Vitals — owner-local depletion + grace-then-DoT
Survival meters deplete only for the local owner; proxies skip the whole block. The canonical pattern is *cross a threshold → start a grace timer → after grace, apply damage-over-time via `DamageInfo`*. sdiver's pressure system: depth past your `PressureRating` stat starts a warning, then after a 3s grace bleeds HP/sec.

```csharp
CurrentDepth = Math.Max( 0, (surfaceZ - Diver.WorldPosition.z) / 39.37f );   // inches→meters
bool over = CurrentDepth > currentPressureRating;
if ( over && !wasOverPressureLimit ) { wasOverPressureLimit = true; timeSinceOverLimit = 0f; Diver.Effects?.SetPressureWarning( true ); }
// ...after a grace period, apply ~10 dmg/sec via a DamageInfo on Diver.
```
(sdiver: Code/Player/DiverState.cs:120 `UpdatePressureState`; air depletes per-second below a depth threshold unless `AirBubbleCount > 0`; stamina governs sprint and feeds back into air drain.) **Gotcha:** engine distances are inches, survival gameplay is usually meters — sdiver constantly `/39.37f`; mixing the two is the easiest bug to ship. **Composable stats:** sdiver resolves each final vital as `(base + Σflat) * Πmult` from three cached layers (base, equipment tier, timed buffs), with one `OnStatsChanged` event re-reading consumers (Code/Player/DiverData.cs:48) — adopt this if upgrades/buffs modify survival caps.

### Round / phase FSM — host enum + entry hooks
A `[Sync]` enum + a single `[Sync]` countdown float, ticked only on the host. Transitions live in `SetRoundState`'s switch (load map, spawn the wave, tally survivors), NOT in a `[Change]` handler — so design the synced fields to be self-sufficient for late-joiners (they read already-synced state rather than replaying entry logic).

```csharp
[Sync] public RoundState roundState { get; set; } = RoundState.PRE_ROUND;
[Sync] public float CurrentRoundTime { get; set; } = MAX_ROUND_TIME;
// ACTIVE_ROUND early-exits to POST when every ActivePlayers entry is dead:
bool allDead = true;
foreach ( var p in ActivePlayers ) if ( p.IsValid() && p.State == NetworkPlayer.LifeState.Living ) { allDead = false; break; }
```
(NDS: Code/globals/RoundManager.cs:32-55 fields/enum, :86-120 the switch incl. all-dead exit, :164 `SetRoundState`.) **Swappable modes:** sdiver keeps this cleaner — a singleton `GameManager` owns all `[Sync]` run state but zero rules, and `Components.Create<>`'s a `BaseGameMode` subclass it forwards ticks to (`Preparation → Diving → Summary → loop/GameOver`). Adding a mode = new Component + enum case (sdiver: Code/Gameplay/GameMode/ExpeditionMode.cs:172 `AdvancePhase`). **Gotcha:** editor single-player is special-cased so a 1-player round doesn't instantly end (NDS: RoundManager.cs:107).

### The threat — physics-force hazard OR stalking creature
**Hazard shape** (tornado): a `DisasterComponent` + `Component.ITriggerListener` with a `HullCollider` catch volume. `OnTriggerEnter` adds caught bodies to a `[Sync] NetList<GameObject>`; every `OnFixedUpdate`, `SwirlObjects()` applies three `ApplyForce` vectors per Rigidbody (tangential spin, radial pull, upward lift), each scaled by `Curve.Evaluate` of distance/height and a per-tag multiplier; players also take curve-scaled HP drain.

```csharp
void Component.ITriggerListener.OnTriggerEnter( Collider other ) { /* UnlockBody + BreakJoints, add Rigidbody to affectedObjects, hand to DebrisManager */ }
// each FixedUpdate, per caught body: spin + pull + lift, force-based (never transform-set) for network-safe physics
```
(NDS: Code/disasters/TornadoComponent.cs:155 `SwirlObjects`, :218 `OnTriggerEnter`.) **Gotcha:** force magnitudes are gigantic and hand-tuned per tag (`player`/`ragdoll`/`prop`) — expect to retune; relies on a tag taxonomy defined elsewhere. **Creature shape** (sdiver): an abstract `EnemyBase : Component` driven by an `EnemyResource` data definition, with `MovingEnemy`/`PatrolEnemy`/`StaticEnemy` subclasses and an animator flag for attacks.

```csharp
public abstract class EnemyBase : Component {
    [Property] public EnemyResource Resource { get; set; }
    public virtual void OnAttackPlayer() => Renderer?.Set( "IsAttacking", true );
}
```
(sdiver: Code/Enemies/BaseEnemy.cs:6.) For a heavier creature brain (chase/missile/melee/death states), the deathmatch-arena recipe's `IEnumerator`-as-state-machine monster AI is the reusable pattern (see `references/genres/deathmatch-arena.md`). **Cap your hazards:** NDS hard-limits live disasters and funnels broken props into a `DebrisManager` that expires them (two index-aligned `NetList`s + `TimeUntil`) so physics load can't blow up (NDS: Code/globals/DebrisManager.cs).

### Escalating spawner — pity-weighted pick + curve-driven cadence
Two reusable kernels. **(1) Anti-streak pity table:** roll over a `NetDictionary<T,int>` of weights; after picking, increment *every other* option's weight by 1 and zero the chosen one — self-balancing variety with no permanent exclusion (weight 0 = manual disable).

```csharp
float roll = Game.Random.Float() * sum;  int acc = 0;
foreach ( var pair in DisasterWeights ) { if ( pair.Value == 0 ) continue; acc += pair.Value; if ( roll <= acc ) { picked = pair.Key; break; } }
foreach ( var d in availableList )                              // pity: starve nothing, repeat nothing
    DisasterWeights[d] = (d != picked) ? DisasterWeights.GetValueOrDefault(d,0) + 1 : 0;
```
(NDS: Code/disasters/disaster_manager.cs:111-160.) **(2) Curve → self-rearming clock:** feed round-progress (`1 - timeLeft/max`) into a designer `[Property] Curve`, store the result in a `[Sync] TimeUntil`, and fire+re-arm when it elapses — pacing escalates as the round wears on, tuned in the inspector without code.

```csharp
float ratio = 1f - (CurrentRoundTime / MAX_ROUND_TIME);
timeBeforeNextWave = LightningSpawnCurve.Evaluate( ratio );      // [Sync] TimeUntil
// in OnFixedUpdate: if ( !timeBeforeNextWave ) { SpawnWave(); /* re-arm above */ }
```
(NDS: disaster_manager.cs:404 `HandleLightningWave`, :411 the `TimeUntil` assignment; RoundManager.cs:302 `IntensityCurve` picks per-round intensity.) See `references/systems/spawning-waves.md`.

### Interactor + inventory — hold-to-use eye-trace + tag-as-mutex pickup
The interactor (one per local owner) raycasts from screen-center each frame `WithAnyTags("interactable","ragdoll")`, toggles a `HighlightOutline`, shows a prompt, and drives a hold progress bar; on completion `[Rpc.Broadcast]`s `OnInteract` to every `IInteractable` on the object (sdiver: Code/Interaction/PlayerInteractor.cs, Code/Interaction/InteractableObject.cs). Pickup is a host request/confirm handshake with a **tag-as-mutex** to dedupe simultaneous grabs in one tick:

```csharp
[Rpc.Host] void HostRequestPickup( Guid guid, int slot ) {
    var obj = /* find */;  if ( obj.Tags.Has( "picked_up" ) ) return;   // already claimed this tick
    obj.Tags.Add( "picked_up" );                                        // lock before end-of-frame Destroy
    obj.Destroy();  BroadcastConfirmPickup( guid, slot );               // writes item into everyone's slot dict
}
```
(sdiver: Code/Items/PlayerToolbar.cs:300.) **Gotcha:** the slot dict itself is NOT `[Sync]` — it's replicated by broadcasting every mutation RPC, so reconnecting clients must have it hand-restored (see below). `OnInteract` runs on *all* clients (`[Rpc.Broadcast]`) — terminals must re-check `Network.IsOwner`/`IsProxy` before owner/host-only work.

### Reward loop — escalating quota with carry-over, or survive-cash + meta-shop
**Extraction quota** (sdiver): daily target comes from a `RunSettingsResource.DailyQuotas` list indexed by day (past the last entry = run won), scaled by player count. Deposits split into normal vs. excess; the part above quota gets an `OverQuotaBonusMultiplier`, and excess carries into the next day.

```csharp
if ( Manager.ScoreGainedThisDay + value > Manager.DailyTargetScore ) {
    int normal = Manager.DailyTargetScore - Manager.ScoreGainedThisDay;
    int excess = value - normal;
    finalValue = normal + (int)Math.Round( excess * Manager.OverQuotaBonusMultiplier );
}
```
(sdiver: Code/Gameplay/GameMode/ExpeditionMode.cs:85.) **Gotcha:** keep two buckets — `ScoreGainedThisDay` (progress toward today) vs `TotalScore` (the spendable bank credited net-of-carryover at Summary); forgetting the carry-over subtraction double-counts. **Survive-and-upgrade** (NDS): survivors earn cash scaled by disaster intensity, spent at a 3D "look at the item to buy" shop (`ShopItem` base with virtual `GetCashCost`/`Purchase`, hovered via a trigger-only eye-trace) on **persistent** Health/Stamina/Jump levels saved with `FileSystem.Data.WriteJson` and mirrored to cloud `Services.Stats` (NDS: Code/globals/DataManager.cs, Code/ui/ShopItem.cs:58). **Gotcha:** NDS persistence is client-local with no server validation — a co-op/non-competitive economy, trivially editable; fine for survival-horror, wrong for ranked.

### Death → spectate, and reconnect into a sleeping body
A `[Sync,Change("OnStateChanged")] LifeState` enum flips which of two child GameObjects is enabled (a `PlayerController` body vs. a free-fly spectator) and which `CameraComponent.IsMainCamera` is true; on `Living → Spectator` it spawns a networked ragdoll and reports a death. `OnStart` manually re-invokes the change handler with the current value so join-in-progress clients initialize correctly (NDS: Code/player/NetworkPlayer.cs:29 `OnStateChanged`). For disconnects, don't delete a mid-run player — `TakeOwnership` of their body, mark it sleeping, and on reconnect snapshot its non-`[Sync]` inventory/equipment and replay it to a fresh body via `[Rpc.Owner]` restore calls (sdiver: Code/Managers/CustomNetworkManager.cs). See `references/systems/save-persistence.md`.

## Pitfalls (from the mined code)

- **Gate ALL threat/vitals/timer simulation behind one `if (!Networking.IsHost) return;`** (or `if (IsProxy) return;` for owner-local vitals). Clients must be pure readers of `[Sync]` state, or the threat desyncs (NDS: RoundManager.cs:79; sdiver DiverState owner-only).
- **Atmosphere FSMs are local-only and won't match across clients** — each runs its own `Game.Random`. Acceptable for flicker/fog ambience; if a light/fog *gates gameplay*, drive it from synced state instead (backrooms/Code/LightFlicker.cs gotcha).
- **State-entry side effects live in the FSM switch, not a `[Change]` handler** — design synced fields so a late-joiner reading them is correct without replaying entry logic, and have `OnStart` re-apply the current state (NDS: RoundManager.cs:164; NetworkPlayer.cs OnStart re-invoke).
- **Move threat physics with `ApplyForce`, never transform-sets** — force-based motion stays network-safe; transform-setting fights the physics sync (NDS tornado; sdiver carry spring).
- **Cap live hazards/debris** — hard-limit concurrent threats and expire broken props (`TimeUntil` GC), or physics load snowballs and tanks the frame (NDS: DebrisManager.cs).
- **Inventory/equipment dicts are NOT `[Sync]`** — they're replicated by broadcasting each mutation, so they MUST be hand-restored on reconnect via owner RPCs or returning players lose gear (sdiver: CustomNetworkManager.cs + PlayerToolbar.cs).
- **Tag-as-mutex before the end-of-frame Destroy** to dedupe simultaneous pickups; without it, N grab RPCs in one tick all succeed (sdiver: PlayerToolbar.cs:307).
- **Inches vs. meters** — engine distance is inches; survival vitals (depth/pressure) are usually meters. Convert consistently (`/39.37f`) or pressure/air math is silently wrong (sdiver: DiverState.cs:115,123).
- **Client-local JSON persistence has no server validation** — fine for co-op survival meta-upgrades, exploitable for anything competitive (NDS: DataManager.cs gotcha).
- **`Game.Random.Int(min, max)` is inclusive-max in s&box** — `Int(0,2)` yields 0/1/2; copying that into an exclusive-max RNG silently drops a state (backrooms/Code/LightFlicker.cs:93).
- **`MathF` does not exist in the bridge editor addon** (it exists in the *game* sandbox) — use `MathX`/`System.Math` for editor-side code.

## Verify live

API surfaces drift between SDK versions — confirm before relying on a signature. Use `describe_type` / `search_types` reflection against the installed SDK as authoritative for: `[Sync]`/`SyncFlags`/`[Change]`/`Networking.IsHost`/`IsProxy`, `[Rpc.Host]`/`[Rpc.Broadcast]`/`[Rpc.Owner]` (+ `Rpc.Caller`), `NetList<T>`/`NetDictionary<K,V>`, `Component.ITriggerListener` (`OnTriggerEnter`/`Exit`) and `Component.INetworkListener`, `TimeUntil`/`TimeSince`/`RealTimeSince`, `Curve`/`Curve.Evaluate`, `Rigidbody.ApplyForce`/`ApplyForceAt`/`MotionEnabled`, `HullCollider`/`BoxCollider.IsTrigger`, `Scene.Trace.Ray`/`.WithAnyTags`/`.IgnoreGameObjectHierarchy`/`.Run`, `CubemapFog`/`DirectionalLight`/`PointLight.Enabled`, `DamageInfo` (`.FromBullet`/`.WithAttacker`), `Sandbox.Services.Stats`/`Leaderboards`, `FileSystem.Data.WriteJson`/`ReadJson`, `GameResource`/`[AssetType]`/`ResourceLibrary.GetAll<T>()`, and `Scene.GetSystem<T>()`/`GameObjectSystem`.

Cross-links: see the `sbox-api` skill for authoritative type lookups, and the `sbox-build-feature` skill for the screenshot-driven build/iterate loop.

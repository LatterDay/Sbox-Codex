# Deathmatch / Arena-Combat Recipe

How to build a deathmatch-arena game in modern s&box (GameObject/Component/Scene), distilled from two mined games: `ataco.sdoomresurrection` (a from-scratch Doom engine — hitscan, carriable weapons, monster AI, custom movement) and `aethercore.versus` (a 1v1 host-authoritative soulslike fighter — round state machine, melee damage windows, trade-bug-hardened hit resolution).

## What defines the genre

A deathmatch arena is a **kill-driven combat loop in a bounded space**: actors spawn, fight with hitscan/projectile/melee, deal damage through a shared `IDamageable` contract, die, and respawn (or the round resets and rescores). There is no economy or persistence core — the genre *is* the combat exchange plus the match scaffolding that wraps it.

Two sub-shapes appear:

- **Arena FPS / horde** (`sdoomresurrection`): a carriable-weapon player fights AI monsters or other players with hitscan + projectiles. Most logic is host/local-authoritative; networking is light. Doom reimplements *everything* by hand (movement, hitscan, AI, even the use-key), which makes it the best teaching corpus for the raw mechanics even though it leans single-player.
- **Versus duel** (`aethercore.versus`): a tightly-networked 1v1 melee fighter built on a `[Sync]` round state machine, with damage delivered by **animation-driven hitbox windows** and resolved defensively on the victim. This is the shape to copy when the match itself is networked and authoritative.

**Core loop:** `spawn → acquire/ready a weapon → aim & fire → trace hits an IDamageable → apply DamageInfo → death → frag/score → respawn or round-reset`. Everything else (match FSM, HUD, spawns, pickups) is scaffolding around that exchange.

## The system stack to compose

Build these as separate components. References point to existing system docs.

| System | Role | Reference |
|---|---|---|
| `IDamageable` damage contract | One-method interface every hurtable thing implements | — (below) |
| Health + death/respawn | Per-actor HP, `OnKilled`, frag credit | `references/systems/progression-upgrades.md` (stats/scoring seam) |
| Weapon / carriable framework | Equip, holster, fire FSM, ammo | `references/systems/inventory.md` |
| Hitscan & projectile resolution | `Scene.Trace.Ray/Box` + spread → DamageInfo | — (below) |
| Melee damage window | Animation-gated hitbox collider | — (below) |
| Player movement | `PlayerController` (default) or hand-rolled swept-BBox | — (below) |
| Match / round state machine | `[Sync]` FSM: countdown → fight → score → reset | `references/systems/round-match.md` |
| Spawn / respawn points + waves | Pick a spawn, network-spawn, AI horde | `references/systems/spawning-waves.md` |
| Pickups & use-prompt | Touch-overlap + manual `IUse` eye-trace | `references/systems/inventory.md` |
| AI opponents (optional) | State-machine monster/bot | `references/systems/spawning-waves.md` |
| Leaderboard / stats push | Frags, win streak → backend | `references/systems/leaderboards-services.md` |

## The two authority idioms that make it work

**Pick one per system.** Doom is *local/host-implicit* (movement & AI aren't synced — fine for single-player/host horde). Aethercore is *host-authoritative with owner-resolved defense* (the shape for real PvP).

1. **Host-authoritative match, fighters as `[Sync] GameObject`.** Store actor refs as synced `GameObject` properties (not component fields) so they survive host migration; gate the FSM tick to the non-proxy.

```csharp
[Sync] public MatchState State { get; set; }
[Sync] public int MatchWinner { get; set; } = -1;
// Store fighters as synced GameObjects — fields go null on the new host after migration.
[Sync] public GameObject ActivePlayer1Obj { get; set; }
PlayerController P1 => ActivePlayer1Obj?.GetComponent<PlayerController>();

protected override void OnUpdate()
{
    if ( IsProxy ) return;                 // host-only simulation
    switch ( State ) { /* RoundIntro → Countdown → Fighting → RoundEnded → MatchEnded */ }
}
```
(aethercore.versus: Code/ArenaManager.cs:30-49 sync fighters + the migration comment, :63-65 IsProxy-gated FSM, :51 MatchState enum)

2. **Resolve defense on the victim's owner.** The attacker's trace/collider only *reports* the hit; the parry/block/i-frame check runs where the defender's non-synced state lives. Aethercore routes hits to the victim via an owner RPC; this avoids trusting attacker-side timing.

```csharp
void Component.ITriggerListener.OnTriggerEnter( Collider other )
{
    if ( !isActive ) return;                         // damage window closed
    var hit = other.GameObject;
    if ( hit is null || hit.Root == GameObject.Root ) return;   // no self-hit
    if ( GameObject.Root.IsProxy ) return;           // only the attacker's owner runs this
    // Attacker-validity gate (trade-bug fix): if the owner got flinched/parried, the
    // hit_end keyframe that closes the window may never fire — verify attacker STATE,
    // not collider state, before applying damage.
    var owner = GameObject.Root.GetComponent<PlayerController>();
    bool inAttack    = owner.IsAttacking || owner.IsHeavyAttacking;
    bool interrupted = owner.IsGuardBroken || owner.IsParrying || (owner.Health?.IsHit ?? false);
    if ( !inAttack || interrupted ) return;
    // ...route to victim owner to resolve block/parry/i-frames, then apply.
}
```
(aethercore.versus: Code/WeaponDamage.cs:56-83 the full trade-bug-hardened gate; :44 `EffectiveShieldDamage` = optional shield-vs-body split)

## Build order

Build single-player first; the damage contract and weapon FSM are identical offline, and the `IsProxy`/`IsHost` short-circuits make the PvP path additive.

1. **`IDamageable` + `DamageInfo`.** One interface, `void TakeDamage(DamageInfo)`. Every hurtable component implements it. This is the seam the whole genre hangs on — do it first.
2. **Health + death.** HP field, armor absorb, `OnKilled` (obituary, drop inventory, respawn timer). Credit the frag to `info.Attacker`.
3. **Player movement.** Use the stock `PlayerController` unless you need bespoke feel (Doom hand-rolls it — see below).
4. **Weapon framework.** Carriable components, equip/holster, a per-weapon fire FSM in fixed ticks.
5. **Hitscan / projectile.** Trace a ray (with spread) or spawn a projectile; on hit, build a `DamageInfo` and apply to every `IDamageable` on the hit object *and its parents*.
6. **Melee window (if applicable).** A collider on the weapon, enabled only during the attack animation's active frames, resolved on the victim's owner.
7. **Pickups + use.** Touch-overlap for run-over pickups; a manual eye-trace for `IUse` (the old `TickPlayerUse` is gone).
8. **Match FSM.** `[Sync]` round state machine: spawn fighters → countdown → fight → detect round-over → score → reset/respawn → match-over.
9. **AI opponents (optional).** A state-machine monster/bot that targets, chases, and fires.
10. **HUD, spawns, leaderboard push.**

## How the real games do each piece

### Damage contract — one interface, trace to parents
`IDamageable` is a single-method interface (`void TakeDamage(DamageInfo)`). Hitscan applies to **every** `IDamageable` found with `FindMode.EverythingInSelfAndParent`, so a collider on a child still damages the actor root. Build the `DamageInfo` with the fluent helpers and stamp the attacker/weapon for obituaries.

```csharp
var dmg = DamageInfo.FromBullet( tr.EndPosition, forward * 100 * force, damage )
    .UsingTraceResult( tr ).WithAttacker( Owner ).WithWeapon( GameObject );
foreach ( var id in tr.GameObject.Components.GetAll<IDamageable>( FindMode.EverythingInSelfAndParent ) )
    id.TakeDamage( dmg );
```
(sdoomresurrection: Code/weapon/Weapon.cs:73-79 build+apply; :55 cached `Surface`). The victim's `TakeDamage` does armor absorption, knockback (`Velocity += info.Force/100f`), pain/death sounds, and `OnKilled` → obituary + drop inventory (sdoomresurrection: Code/pawn/DoomPlayer.cs:289-332).

### Hitscan — trace ray with spread, multi-result
Rotate the fire direction by a random yaw/pitch within the spread cone, trace with the right tag filter, ignore the shooter's hierarchy, and iterate results (so pellets can pass through / multi-hit). `ShootBullets(n, ...)` just loops `ShootBullet` with `force/n`.

```csharp
forward *= Rotation.FromYaw( (RNG.NextDouble()*2-1) * spread.x )
         * Rotation.FromPitch( (RNG.NextDouble()*2-1) * spread.y );
var tr = Scene.Trace.Ray( pos, pos + forward.Normal * 5000 )
    .WithAnyTags( "monster", "blocking", "player", "bulletclip" )
    .IgnoreGameObjectHierarchy( Owner ).Size( bulletSize ).Run();
```
(sdoomresurrection: Code/weapon/Weapon.cs:40-50 `TraceBullet`, :56-86 `ShootBullet`, :100-108 `ShootBullets`). **Your colliders must carry the traced tags** or shots pass through them. For projectiles, spawn a moving GameObject that traces forward each tick and calls the same `DamageInfo` path on impact.

### Weapon framework — reparent-to-owner carriable Components
Weapons are full `Component`s on their own `GameObject`. Equipping **reparents** the weapon under the player and toggles its `ModelRenderer.Enabled`; holster/equip fire `OnHolster`/`OnEquip`. A generic factory spawns them; a name→type switch rehydrates for save/load. Ammo lives on the *player*, not the weapon.

```csharp
public static T Create<T>( Scene scene ) where T : Weapon, new()
{
    var go = new GameObject { Parent = scene };
    return go.AddComponent<T>();
}
// Inventory.Add reparents under the player and hides the renderer until active;
// SetActive() calls OnHolster on the old, OnEquip on the new.
```
(sdoomresurrection: Code/weapon/Weapon.cs:117-122 `Create<T>`, :124-135 `CreateFromName` switch; Code/weapon/Inventory.cs:60 Add/reparent, :31 SetActive). The per-weapon fire/idle timing is a small frame FSM ticked in 35-fps Doom units (Code/weapon/DoomGun.cs:20). **Gotcha:** `CreateFromName` is a hardcoded string→type switch — update it whenever you add a weapon, or save/load throws.

### Melee — animation-gated damage window
For melee, don't trace — enable a hitbox `Collider` only during the attack's active frames (opened/closed by animation events), and implement `Component.ITriggerListener`. Resolve on the attacker's owner, gate on real attacker state (see idiom #2 above), and dedupe by `Root` so one swing hits each target once. Aethercore also keys faction so you don't friendly-fire, and supports an optional shield-vs-body damage split (aethercore.versus: Code/WeaponDamage.cs:40-83).

### Player movement — stock controller vs. hand-rolled swept BBox
Default path: drop a `PlayerController` and read input — see the spawn recipe in `references/systems/` / the `sbox-build-feature` skill. Doom instead hand-rolls a kinematic controller for exact retro feel: each `OnFixedUpdate` it builds a "short man" BBox (full hull minus `StepHeight`), box-traces the move, deflects velocity along the hit normal and re-traces up to 3× (slide), then traces down to step, then a stationary box-trace confirms it can stand before committing.

```csharp
var shortMan = new BBox( ply.Hull.Mins, ply.Hull.Maxs.WithZ( ply.Hull.Maxs.z - StepHeight ) );
var trace = Scene.Trace.Box( shortMan, start + Vector3.Up*StepHeight, end + Vector3.Up*StepHeight )
    .WithAnyTags( "blocking","monster","player","playerclip" )
    .IgnoreGameObjectHierarchy( GameObject ).Run();
while ( trace.Hit && fractionLeft > 0.01f && steps++ < 3 ) {     // slide
    Velocity -= trace.Normal * Velocity.Dot( trace.Normal );      // deflect along surface
    trace = Scene.Trace.Box( shortMan, trace.EndPosition, trace.EndPosition + Velocity*dt*fractionLeft )... .Run();
}
```
(sdoomresurrection: Code/pawn/DoomController.cs:22-118 full algorithm; :49 ground box-trace, :85 shortMan, :89-97 slide loop, :99-111 step-down + stand check). **Gotchas:** position/velocity are *not* `[Sync]`'d (single-player movement); your world colliders **must** be tagged or you fall through; constants are tuned to Doom's fixed-point thrust + 35-tic delta, so re-tune if you reuse it. (Note: Doom uses `MathF` — the *game* sandbox allows it; the bridge *editor* addon does not. Use `MathX`/`System.Math` in editor-side code.)

### Pickups & the use-prompt (TickPlayerUse is gone)
Two pickup paths, used belt-and-suspenders: a per-frame box-overlap on `"weapon"`-tagged things **and** `OnTriggerEnter` both forward to `thing.OnTouched(player)`. The old `TickPlayerUse` was removed, so the player **manually** re-implements use: on `Input.Pressed("Use")`, eye-trace 48u forward and call `OnUse` on every `IUse` on the hit object — this manual eye-trace is the current correct pattern.

```csharp
if ( Input.Pressed( "Use" ) ) {
    var tr = Scene.Trace.Ray( EyePosition, EyePosition + EyeRotation.Forward * 48f )
        .IgnoreGameObjectHierarchy( GameObject ).Run();
    if ( tr.Hit )
        foreach ( var use in tr.GameObject.Components.GetAll<IUse>().ToList() )
            use.OnUse( this );
}
```
(sdoomresurrection: Code/pawn/DoomPlayer.cs:262-282 overlap + manual use-trace, :334-339 `OnTriggerEnter`; Code/IUse.cs:3 the interface; Code/entities/things/Medkit.cs:12 `OnTouched` gates on `health<100`, mutates, plays a sound, `Destroy()`s). **Gotcha:** overlap + trigger can double-fire the same pickup — guard with `IsValid()`/`Destroy()` so it can't be grabbed twice.

### AI opponents — IEnumerator-as-state-machine
Doom's standout pattern: each monster AI "state" is a method returning `IEnumerator` where **every `yield return null` is one logical decision step**, not a delay. `OnFixedUpdate` advances a frame timer; when the current animation finishes, `StepState()` pumps `MoveNext()`. Subclasses override only the states (`StateSee`/`StateMissile`/`StateMelee`/`StateDeath`...) and virtual stats they change. Swapping state nulls the handler so a stale enumerator can't keep running.

```csharp
private void StepState() {
    if ( !GetStateHandler().MoveNext() ) { StateHandler = null; GetStateHandler(); } // rebuild on finish
}
public void SetState( MonsterState s ) {
    if ( currentState != s ) { StateHandler = null; animationSteps = ""; nextFrame = Time.Now; }
    currentState = s; GetStateHandler();
}
```
(sdoomresurrection: Code/entities/monsters/Monster.cs:47-65 OnFixedUpdate frame timer, :67-74 StepState/MoveNext, :88-100 GetStateHandler switch, :77-86 SetState; Code/entities/monsters/Imp.cs:28 per-monster override). This is an allocation-light alternative to a giant `switch`+enum-tick for any NPC/bot. **Gotcha:** it's driven off `OnFixedUpdate` and is *not* synced — host/single-player only; networked clients would desync the AI.

### Match / round state machine
A `[Sync]` enum FSM owned by the host (`if (IsProxy) return;`) walking `WaitingForPlayers → RoundIntro → Countdown → Fighting → RoundEnded → MatchEnded`, with a `[Sync] StateTimer` counted down per tick and `[Sync] MatchWinner`. Detect round-over by reading the synced fighter HP; on round end, increment score and reset; on match end, declare a winner and teleport to lobby (aethercore.versus: Code/ArenaManager.cs:51-59 states, :63-90 tick). See `references/systems/round-match.md` for the generic round/timer/scoring skeleton.

## Pitfalls (from the mined code)

- **Store networked fighters as `[Sync] GameObject`, never component fields** — fields go null on the new host after migration and the round-over check loops forever (aethercore comment at ArenaManager.cs:33-36).
- **Resolve defense on the victim's owner, and gate damage on attacker *state* not collider state** — a flinch/parry can skip the `hit_end` keyframe and leave a damage collider stuck open, causing unfair "trades" (WeaponDamage.cs:67-83).
- **Tag your colliders** with whatever the traces filter on (`blocking`/`player`/`monster`/`bulletclip`/`weapon`) — Doom's movement *and* hitscan both `WithAnyTags(...)`, so untagged geometry is invisible to them.
- **Apply damage to `FindMode.EverythingInSelfAndParent`** — put `IDamageable` on the root or an ancestor of whatever the trace hits, or hits land on nothing.
- **`TickPlayerUse` no longer exists** — re-implement use with a manual eye-trace; don't search training data for the old API.
- **Doom's movement/AI aren't `[Sync]`'d** — it's effectively single-player/host-driven. For real PvP, sync position/velocity (or use the stock networked `PlayerController`) and keep AI host-authoritative.
- **`CreateFromName`/save-load weapon switch is hand-maintained** — adding a weapon means editing the string→type map too, or rehydrate throws.
- **Overlap + trigger pickups double-fire** — guard the grant with `IsValid()`/`Destroy()`.
- **`MathF` exists in the game sandbox but not the bridge editor addon** — use `MathX`/`System.Math` for any editor-side code.

## Verify live

API surfaces drift between SDK versions — confirm before relying on a signature. Use `describe_type` / `search_types` reflection against the installed SDK as authoritative for: `DamageInfo` (`FromBullet`/`UsingTraceResult`/`WithAttacker`/`WithWeapon`), `Scene.Trace.Ray`/`Scene.Trace.Box` (`.WithAnyTags`/`.IgnoreGameObjectHierarchy`/`.Size`/`.Run`), `SceneTraceResult` (`Hit`/`Normal`/`Fraction`/`EndPosition`/`StartedSolid`), `Component.ITriggerListener` (`OnTriggerEnter`/`Exit`), `[Sync]`/`SyncFlags`/`IsProxy`/`[Rpc.Owner]`/`[Rpc.Host]`, `FindMode.EverythingInSelfAndParent`, `Components.GetAll<T>(FindMode)`, `PlayerController`, `Input.Pressed`/`AnalogMove`, and `BBox`/`Rotation.FromYaw`/`FromPitch`.

Cross-links: see the `sbox-api` skill for authoritative type lookups, and the `sbox-build-feature` skill for the screenshot-driven build/iterate loop.

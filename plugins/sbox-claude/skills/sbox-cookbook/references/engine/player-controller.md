# Player Controller (modern s&box scene system)

Recipes for building, extending, and networking a player pawn: `CharacterController` movement, `MoveMode` arbitration, networked spawn/respawn, view-models, and death/ragdoll/spectator flow. Modern `GameObject`/`Component`/`Scene` API only — no legacy `Entity`/`Pawn`/`[Net]`.

## Mental model

Split the pawn into three responsibilities, each its own object:

- **Identity** — one `Player` component per `Connection`. Owns networked state (inventory, owned units, lifecycle) and has **no physics**. In sbox-grubs it is a `LocalComponent<Player>` holding `NetList<Grub>` + `ActiveGrub`, all `[Sync(SyncFlags.FromHost)]` (sbox-grubs: `Code/Systems/Pawn/Player.cs:9-29`). This cleanly supports one player driving many bodies (RTS/squad) or swapping bodies.
- **Body** — the controllable GameObject holding `Health`, the renderer, and the controller.
- **Mover** — kinematics (`BuildWishVelocity`/`Accelerate`/`ApplyFriction`/`Move`).

Two ticks, never crossed:
- `OnFixedUpdate` → movement + physics (deterministic fixed tick).
- `OnUpdate` → look angles, camera framing, animation (per-frame).

Authority: read input and mutate synced state **only when `!IsProxy`** (and the body is the active one). On a proxy, mutating synced state silently rolls back.

## Recipe: CharacterController movement loop

`CharacterController` is the built-in kinematic mover. It applies **no gravity** — you integrate it. Run the whole thing on the fixed tick; gate on `IsProxy` (sbox-scenestaging: `Code/ExampleComponents/PlayerController.cs:120-168`).

```csharp
protected override void OnFixedUpdate()
{
    if ( IsProxy ) return;            // only the owner drives this body

    BuildWishVelocity();
    var cc = GameObject.Components.Get<CharacterController>();

    if ( cc.IsOnGround && Input.Down( "Jump" ) )
        cc.Punch( Vector3.Up * 322.0f );   // impulse, NOT cc.Velocity = ...

    if ( cc.IsOnGround )
    {
        cc.Velocity = cc.Velocity.WithZ( 0 );
        cc.Accelerate( WishVelocity );      // full friction on ground
        cc.ApplyFriction( 4.0f );
    }
    else
    {
        cc.Velocity -= Gravity * Time.Delta * 0.5f;   // half-step gravity before Move
        cc.Accelerate( WishVelocity.ClampLength( 50 ) ); // clamp air wish
        cc.ApplyFriction( 0.1f );                       // near-zero air friction
    }

    cc.Move();                                          // exactly once per tick

    if ( !cc.IsOnGround )
        cc.Velocity -= Gravity * Time.Delta * 0.5f;     // second half-step after Move
    else
        cc.Velocity = cc.Velocity.WithZ( 0 );
}

public void BuildWishVelocity()
{
    var rot = EyeAngles.ToRotation();
    WishVelocity = (rot * Input.AnalogMove).WithZ( 0 );
    if ( !WishVelocity.IsNearZeroLength ) WishVelocity = WishVelocity.Normal;
    WishVelocity *= Input.Down( "Run" ) ? 320.0f : 110.0f;
}
```

Splitting gravity into two half-steps around `Move()` (symplectic integration) gives smoother jump arcs than a single application (sbox-scenestaging: `PlayerController.cs:153,162`). `BuildWishVelocity` rotates `Input.AnalogMove` by eye angles, then scales by walk/run speed (sbox-scenestaging: `PlayerController.cs:170-181`). Look/camera/animation belong in `OnUpdate`, not here.

## Recipe: extend locomotion with MoveMode (don't fork the controller)

The modern `PlayerController` extension point is to **add `MoveMode` components** — never subclass the controller. Each state (NoClip/Sit/Kneel/Spectate/Ladder/Swim) overrides `Score(PlayerController)` to bid; the controller activates the highest scorer each tick. Critically, the bid must read a `[Sync]` var on proxies so remote clients mirror the mode (dxrp: `game/code/Player/MoveModes/MoveModeNoClip.cs`).

```csharp
public class MoveModeNoClip : MoveMode
{
    [Sync] public bool IsNoclipping { get; set; }

    public override bool AllowGrounding => false;
    public override bool AllowFalling   => false;

    public override int Score( PlayerController controller )
    {
        if ( IsProxy )                                   // remote clients mirror the synced flag
            return IsNoclipping ? 100 : 0;

        if ( CanNoclip() && Input.Pressed( "Noclip" ) )  // owner toggles locally
            IsNoclipping = !IsNoclipping;

        return IsNoclipping ? 100 : 0;
    }

    public override void UpdateRigidBody( Rigidbody body )
    {
        if ( IsProxy ) return;
        body.Gravity = false;
        if ( body.PhysicsBody != null )
            body.PhysicsBody.BodyType = PhysicsBodyType.Keyframed;   // swap physics cleanly per-mode
    }

    public override Vector3 UpdateMove( Rotation eyes, Vector3 input ) { /* return wishVelocity */ }
    public override void AddVelocity() { /* Controller.Body.Velocity = smoothed; */ }

    public override void OnModeEnd( MoveMode next )
    {
        base.OnModeEnd( next );
        if ( Controller.Body.PhysicsBody != null )
            Controller.Body.PhysicsBody.BodyType = PhysicsBodyType.Dynamic;  // restore on exit
    }
}
```

The lifecycle hooks are: `Score`, `AllowGrounding`/`AllowFalling`, `UpdateMove`, `AddVelocity`, `UpdateRigidBody`, `OnModeBegin`/`OnModeEnd(next)` (dxrp: `MoveModeNoClip.cs:60,80,112,155,184,196`). `OnModeEnd` must undo whatever physics state the mode mutated (here, back to `Dynamic`) (dxrp: `MoveModeNoClip.cs:204-207`).

## Recipe: spawn a networked pawn (host-authoritative)

Spawn is **host-only**. `Clone()`/`new GameObject` alone is local — `NetworkSpawn` is what replicates, and `NetworkSpawn(owner)` is what hands a client authority (sandbox-plus-plus: `Code/GameLoop/GameManager.cs:60-104`).

```csharp
// 1. Per-connection data object — non-physics, stays bound to its connection
PlayerData EnsurePlayerData( Connection channel )
{
    var existing = PlayerData.For( channel );
    if ( existing.IsValid() ) return existing;          // double-spawn guard

    var go = new GameObject( true, $"PlayerInfo - {channel.DisplayName}" );
    go.AddComponent<PlayerData>();
    go.NetworkSpawn( channel );
    go.Network.SetOwnerTransfer( OwnerTransfer.Fixed );  // never reassign owner
    return go.Components.Get<PlayerData>();
}

// 2. Spawn the body — host only, guard against an existing pawn for this owner
void SpawnPlayer( PlayerData data )
{
    Assert.True( Networking.IsHost, "Client tried to SpawnPlayer" );  // loud in dev
    if ( Scene.GetAll<Player>().Any( x => x.Network.Owner == data.Network.Owner ) )
        return;

    var go = GameObject.Clone( "/prefabs/engine/player.prefab",
        new CloneConfig { StartEnabled = false, Transform = FindSpawnLocation() } );

    go.Components.Get<Player>( true ).PlayerData = data;  // wire components BEFORE it goes live
    go.NetworkSpawn( data.Network.Owner );                // replicate + grant client authority
}
```

`StartEnabled = false` lets you wire components before the object goes live (sandbox-plus-plus: `GameManager.cs:94`). `OwnerTransfer.Fixed` keeps the data bound to its connection (`GameManager.cs:69`). The `Assert.True(Networking.IsHost,...)` + owner-match guard are the spawn safety rails (`GameManager.cs:79-83`). Make **respawn** an `[Rpc.Host]` the client requests — never let a client self-spawn.

## Recipe: first-person view-model (render-tag isolation)

Stop the FP weapon clipping the world with a **second `CameraComponent`**: `ZNear≈1`, higher `Priority`, `ClearFlags = Depth|Stencil`, and `RenderTags` containing only `{viewmodel, light}`. On the **main** camera, add `viewmodel` to `RenderExcludeTags`. You need **both halves** or the weapon clips or double-renders (simple-weapon-base: `code/swb_base/Weapon.cs:415`).

Each frame: copy the main camera transform onto the VM camera, then apply additive offsets (simple-weapon-base: `code/swb_base/ViewModelHandler.cs:60-103`).

```csharp
protected override void OnUpdate()
{
    // Toggle via shadow mode, NOT Enabled, to avoid a one-frame enable-flicker
    ViewModelRenderer.RenderType = ShouldDraw
        ? ModelRenderer.ShadowRenderType.Off
        : ModelRenderer.ShadowRenderType.ShadowsOnly;

    Camera.WorldPosition = Scene.Camera.WorldPosition;   // follow the main camera
    Camera.WorldRotation = Scene.Camera.WorldRotation;
    WorldPosition = Camera.WorldPosition;
    WorldRotation = Camera.WorldRotation;

    finalVectorPos = finalVectorPos.LerpTo( targetVectorPos, animSpeed * RealTime.SmoothDelta );
    finalRot       = finalRot.SlerpTo( targetRot, animSpeed * RealTime.SmoothDelta );

    WorldRotation *= finalRot;                            // rotation FIRST
    // position is composed from the rotation basis — must come after rotation
    WorldPosition += finalVectorPos.z * WorldRotation.Up
                   + finalVectorPos.y * WorldRotation.Forward
                   + finalVectorPos.x * WorldRotation.Right;

    targetVectorPos = Vector3.Zero;                       // RESET targets each frame
    targetVectorRot = Vector3.Zero;
    HandleIdleAnimation(); HandleWalkAnimation(); HandleSwayAnimation();  // each ADDs its offset
}
```

The feel pattern: keep `targetVectorPos`/`targetVectorRot`, reset both to zero each frame, let each effect (breathing, bob, sway, iron-sights, sprint) **add** its contribution, then smooth toward the targets with `RealTime.SmoothDelta` (simple-weapon-base: `ViewModelHandler.cs:89,100,106,149`). `RealTime.SmoothDelta` (not `Time.Delta`) keeps it alive while time-scaled/paused. This additive-then-smooth shape is reusable for camera feel, recoil, and hand IK.

## Recipe: death → ragdoll + spectator

Decouple the corpse from the camera owner. Build the ragdoll in a **new** GameObject — `CopyFrom` the live `SkinnedModelRenderer`, bone-merge clothing (`BoneMergeTarget`), add `ModelPhysics` with `CopyBonesFrom`, tag it `ragdoll`, **then** apply the impulse. For death-cam, spawn a **separate** non-enabled Observer component (`NetworkSpawn` to the owner) that orbits the latest death target in `OnPreRender`, blocks respawn ~1s, and calls an `[Rpc.Host] RequestRespawn` on input or timeout (sandbox/garryware: `Code/Player/Player.cs:228`). This avoids reparenting the live player and gates respawn server-side.

Critical ordering: enable `ModelPhysics`, `await GameTask.Delay(...)` one frame, **then** apply the clamped impulse — applying it the same frame physics is enabled makes the ragdoll explode (garryware: `Code/Player/Player.cs:161-210`). For non-lethal "fake death", reuse the ragdoll recipe but don't destroy the pawn — alpha-fade it (save/restore tint) and blend the camera from the ragdoll's head bone back before respawning.

## Recipe: possession / input takeover via MoveMode.OnInput

To let an external script drive a player (vehicle, turret, Wirebox keyboard), don't fight the controller — tag the player (e.g. `lockedposition`), get its locked `MoveMode`, and subscribe `mode.OnInput += handler`. Read `Input.Down(bind)` in the handler, diff each button against its last value before re-emitting, and provide a self-release (`Input.EscapePressed`). On disable, unsubscribe and untag (wirebox: `Code/wirebox/components/WireKeyboardComponent.cs:60`). The subscribe-on-enter / unsubscribe-on-exit + escape-to-release lifecycle is the reusable part.

## Gotcha table

| Symptom | Cause | Fix |
|---|---|---|
| Movement jittery / frame-rate-dependent | `CharacterController` moved in `OnUpdate` | Move it in `OnFixedUpdate`; only camera/look/anim in `OnUpdate` (sbox-scenestaging: `PlayerController.cs:120`) |
| Every client drives every pawn | No proxy gate | `if ( IsProxy ) return;` before reading input / mutating synced state |
| Custom MoveMode invisible to remote clients | `Score()` reads a local-only toggle | Drive `Score()` from a `[Sync]` var (dxrp: `MoveModeNoClip.cs:62`) |
| Jump stomps horizontal momentum | Set `cc.Velocity` for the jump | Use `cc.Punch( Vector3.Up * f )` (impulse) (sbox-scenestaging: `PlayerController.cs:136`) |
| Weapon clips world / renders twice | Only one half of tag isolation set | VM cam `RenderTags` has `viewmodel` AND main cam `RenderExcludeTags` has `viewmodel` |
| One-frame view-model flicker | Toggling renderer `Enabled` | Toggle `RenderType = ShadowsOnly` instead (simple-weapon-base: `ViewModelHandler.cs:62`) |
| View-model offset corrupted | Position set before rotation | Set `WorldRotation` first, compose position from its basis (simple-weapon-base: `ViewModelHandler.cs:100-102`) |
| Object doesn't replicate | `Clone()`/`new GameObject` only | `NetworkSpawn(owner)` — bare `NetworkSpawn()` leaves it host-owned |
| Pawn detaches from its connection | Owner reassigned mid-session | `Network.SetOwnerTransfer(OwnerTransfer.Fixed)` (sandbox-plus-plus: `GameManager.cs:69`) |
| Clients respawn at will | Client self-spawns | Respawn is an `[Rpc.Host]` the host validates; `Assert.True(Networking.IsHost)` |
| Duplicate pawns per connection | No double-spawn guard | Check for an existing `Player` whose `Network.Owner` matches (sandbox-plus-plus: `GameManager.cs:82`) |
| Ragdoll explodes at spawn | Impulse applied same frame physics enabled | Enable `ModelPhysics`, `await GameTask.Delay(...)` one frame, then impulse (garryware) |
| `MathF`/`System.Math` missing in sandbox | Sandbox API restriction | Use `MathX.Clamp` / `Vector3` helpers for pitch clamp etc. |
| Timers freeze when paused | `Time.Delta` is 0 at `TimeScale=0` | Use `RealTime.SmoothDelta` / `TimeSince` for camera/UI/sway |

## Cross-cutting (apply to every pawn)

- **Authority is the #1 bug class.** Mutating `[Sync]` state on a proxy silently rolls back. Gate every mutator: `if (IsProxy) return;` (owner-authoritative) or `if (!Networking.IsHost) return;` (host-authoritative). Add `Assert.True(Networking.IsHost,...)` in dev so desync is loud.
- **`[Rpc.Host]` is callable by any client with forged args** — re-validate ownership/limits and rate-limit (cooldown keyed by `Rpc.CallerId`) inside the host body. Use `SyncFlags.FromHost` for anything authoritative (health/score), not plain `[Sync]`.
- **`Network.IsOwner` is false in solo editor playtests** (no lobby = no owner) — combine owner guards with a `LocalSimulation` property so systems still run solo.
- **Statics are wiped on hotload.** Prefer `LocalComponent<T>` (as sbox-grubs `Player` does) or `GameObjectSystem<T>`; null `Instance` in `OnDestroy` and `-=` static-event subscribers.
- **`Connection`/`GameObject` refs are not `[Sync]`-able** — sync a stable `Guid` and resolve via `Connection.All` / `Scene.Directory.FindByGuid`.

## Verify live

API names drift between SDK builds — reflection is authoritative. Before writing, confirm member names with `describe_type CharacterController` / `describe_type Sandbox.Movement.MoveMode` / `search_types PlayerController` and `get_method_signature` for `Punch`/`Accelerate`/`NetworkSpawn`. Visuals (view-model framing, ragdoll) verify with `screenshot_from`; input/possession/multiplayer behavior needs `execute_csharp` or a human playtest — the single-client bridge can't synthesize key presses.

See also: **sbox-api** (input/physics/networking primitives reference) and **sbox-build-feature** (the screenshot-driven iteration workflow this controller is built with).

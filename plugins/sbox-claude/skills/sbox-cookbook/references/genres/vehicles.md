# Vehicles / Driving Recipe

How to build a drivable vehicle game in modern s&box (GameObject/Component/Scene), distilled from one deep mined game: `meteorlab.vehicle_tool_example` ("Car&Race") — a production-grade, sim-leaning raycast-wheel toolkit built entirely on the modern API (no engine built-in vehicle, no Entity/Pawn).

## What defines the genre

A vehicle game is **a controllable rigid body whose motion is the entire game feel**. Everything else (camera, sound, multiplayer, skid marks) decorates one core simulation: forces pushed onto a single `Rigidbody` each physics tick.

The genre's defining decision is **how the car drives**. There are two camps; this game is the sim camp and the more reusable template:

- **Forces-on-one-Rigidbody (raycast wheels) — THE s&box recipe.** Each wheel is its own Component that cylinder-traces to the ground and applies suspension + tire-friction *forces* to one shared body. No per-wheel rigidbodies, no joints, no built-in car. Decouples visuals, suspension, and drive entirely (vehicle/Code/Vehicle/Wheel/WheelCollider.Suspension.cs:76; Wheel/WheelCollider.Friction.cs:309).
- **Arcade kinematic** — drive the body velocity directly from input, fake grip. Simpler, less reusable; not what this game does. (Borrow the camera/seat/sound stack from here and skip the powertrain.)

**Core loop:** enter a seat (`IPressable`) -> read input -> each `OnFixedUpdate` the engine generates torque, the drivetrain propagates it to wheels, the wheels trace ground and push the body, aerodynamics + steering refine it -> chase camera + RPM-crossfaded sound + skid trails render the result -> exit. Networked via per-owner ownership transfer, but **simulation runs only on the owner** (`if ( IsProxy ) return`), so it is single-driver-authoritative even when multiplayer.

## The system stack to compose

The first four are the genre spine (the car drives with these). The rest are flavor and multiplayer.

1. **Raycast wheel collider** — per-wheel Component: cylinder-trace down, spring+damper suspension as `ApplyImpulseAt`, tire friction as `ApplyForceAt`, all onto one shared body (vehicle/Code/Vehicle/Wheel/WheelCollider.cs:77 PhysUpdate). The reusable core. See **references/systems/player-controller.md** for the analogous "forces onto a body" mindset.
2. **Tire friction model** — Pacejka magic-formula curve baked into a `Curve` LUT, longitudinal+lateral slip combined through a friction circle, per-surface presets auto-selected from the hit surface (Wheel/PacejkaCurve.cs:62; Wheel/WheelCollider.Friction.cs:119).
3. **Drivetrain** — a tree of `PowertrainComponent`s (Engine→Clutch→Transmission→Differential→WheelPowertrain) implementing recursive `QueryInertia`/`QueryAngularVelocity`/`ForwardStep` (Powertrain/PowertrainComponent.cs:103).
4. **Engine + transmission** — power-curve torque, rev limiter, ICE/electric modes; automatic/manual/CVT shifting (Powertrain/Engine.cs; Powertrain/Transmission.cs).
5. **Aerodynamics** — drag + speed²-scaled downforce + airborne pitch/yaw control (VehicleController.cs:137 SimulateAerodinamics).
6. **Chase camera** — follow behind with collision pullback + first/third toggle (VehicleController.Camera.cs:50). See **references/systems/camera.md**.
7. **Steering assist** — speed-sensitive max angle + counter-steer toward velocity when sliding (VehicleController.Steering.cs:48).
8. **Engine sound bank** — multi-layer clips RPM-crossfaded (VehicleController.Sound.cs).
9. **Skid-mark trails** — `LineRenderer` points spawned when slip exceeds a threshold (Code/WheelSkidMark.cs:34).
10. **Seat interaction** — `Component.IPressable` enter/exit that swaps control + camera (SuitableVehicle.cs:36).
11. **Multiplayer spawn** — `Singleton` manager + `[Rpc.Host]` clone with ownership transfer (Manager/VehicleSpawner.cs:25). See **references/systems/game-manager.md** and **references/systems/networking-multiplayer.md**.
12. **Editor auto-rigger (optional)** — a `[Button]` that builds the whole rig from tagged wheel GameObjects then self-destructs (VehicleCreator.cs:20).

## Build order

Build the feel before the content. The first three steps are 80% of a vehicle game.

1. **One wheel + one body in an empty box.** A `Rigidbody` on the chassis and ONE `WheelCollider` that traces down and applies only suspension (`ApplyImpulseAt`). Get the car to *hover at ride height* and settle. No drive yet.
2. **Four wheels + tire friction.** Add the other three wheels and the Pacejka friction step (`ApplyForceAt`). Push the body manually and confirm it grips/slides. **Tune this longest.**
3. **Drivetrain + engine.** Wire Engine→…→WheelPowertrain so input torque reaches the wheels. Now it drives.
4. **Steering + camera.** Speed-sensitive steer + a chase camera. Now it's playable solo.
5. **Sound + skid marks + aero.** Pure polish/feel; add after it drives right.
6. **Seat + multiplayer.** `IPressable` enter/exit, then the `[Rpc.Host]` spawn manager. Add last — the sim is owner-local, so MP is mostly ownership plumbing.

## How the real game does it

### Raycast wheel: trace, then push ONE body — WheelCollider.Suspension.cs:39

`OnFixedUpdate` runs `PhysUpdate(dt)`: a cylinder trace finds the ground, suspension compression becomes a `Load` force applied as an impulse, and tire friction is a force at the contact point. **No per-wheel Rigidbody** — every wheel pushes the shared `CarBody`.

```csharp
// trace a cylinder (the wheel) straight down through the suspension travel
GroundHit = new( Scene.Trace
    .IgnoreGameObjectHierarchy( Controller.GameObject )
    .FromTo( WorldPosition + rot.Up * MinSuspensionLength,
             WorldPosition + rot.Down * MaxSuspensionLength )
    .Cylinder( Width, Radius )
    .Rotated( TransformRotationSteer * Rotation.FromRoll( 90 ) ) // roll 90 orients the cylinder
    .Run() );                                                    // (WheelCollider.Trace.cs:23)

// suspension = spring (compression) + damper (compression velocity), applied as an impulse
var compression = (suspensionTotalLength - SuspensionLength) / suspensionTotalLength;
var damp  = CalculateDamperForce( (prevlength - SuspensionLength).InchToMeter() / dt );
Load = Math.Max( 0, SuspensionStiffness * compression + damp );
CarBody.ApplyImpulseAt( WorldPosition, GroundHit.Normal * Load ); // Suspension.cs:76
```

Then tire friction (lateral + longitudinal) is a separate force at the contact patch (`CarBody.ApplyForceAt( point, frictionForce )`, Friction.cs:309).

Gotchas (these bite hard):
- **Everything is in inches.** Forces round-trip through `.InchToMeter()`/`.MeterToInch()` helpers; drop one and forces are off by ~39x (Suspension.cs:66).
- The cylinder needs the `Rotation.FromRoll( 90 )` offset or it traces sideways (Trace.cs:9).
- Friction reads `Controller.CombinedLoad`, which a `WheelManager` pre-sums in `IScenePhysicsEvents.PrePhysicsStep` before the friction step — without that hook the load is stale (WheelManager.cs:37).

### Tire friction: bake Pacejka into a Curve, combine with a friction circle — PacejkaCurve.cs:62

The expensive magic-formula trig is evaluated **once** into a 20-frame `Curve` at construction, then queried per tick — turning trig into a cheap LUT that's also a tunable asset:

```csharp
// D*sin(C*atan(B*t - E*(B*t - atan(B*t)))) sampled into a Curve, queried with .Evaluate(slip)
public readonly float GetFrictionValue( float slip )
    => bakedCurve.Evaluate( slip );
```

`UpdateFriction` computes longitudinal slip (wheel angular vel vs ground speed) and lateral slip (`atan2` of side vs forward speed), evaluates the curve for each, clamps by `Load`, then combines them through a friction circle: `limit = sqrt(fwd² + side²)`; if `>1` it redistributes via `beta = atan2(side, fwd)` so a wheel can't exceed total grip (Friction.cs:281). A low-speed corrective spring kills standstill jitter/creep (Friction.cs:235).

Surface is auto-selected each tick by `Enum.TryParse(GroundHit.Surface.ResourceName)` against per-surface presets (Asphalt/Wet/Dirt/Ice/Snow/Sand) — an unmatched surface silently falls back to Asphalt (PacejkaCurve.cs:96). `UpdateFriction` is ~190 lines of order-dependent inlined float math: **copy it whole, don't refactor piecemeal.**

### Drivetrain: recursive Query/ForwardStep over a Component tree — PowertrainComponent.cs:103

Each part links to an `Output` (the setter auto-wires the reverse `Input` and caches `OutputNameHash`; `0` means "no output, stop recursing"). Torque flows **down**; inertia and counter-torque bubble **up**. This is a great template for any "signal propagates through a graph of parts" system.

```csharp
public virtual float ForwardStep( float torque, float inertiaSum, float dt )
{
    InputTorque = torque; InputInertia = inertiaSum;
    if ( OutputNameHash == 0 ) return torque;          // leaf: stop
    OutputInertia = inertiaSum + Inertia;
    return _output.ForwardStep( torque, OutputInertia, dt ); // recurse down
}
```

The Engine's `OnFixedUpdate` drives the loop: query downstream inertia + angular velocity, compute torque from the power curve, `ForwardStep` it down through Clutch→Transmission→Differential to the leaf. The **leaf** `WheelPowertrain.ForwardStep` is where torque becomes motion — it sets the wheel's motor torque, disables the wheel's self-tick, ticks it itself, and returns counter-torque up:

```csharp
// WheelPowertrain.cs:55 — the leaf drives the wheel
Wheel.MotorTorque = OutputTorque;
Wheel.AutoSimulate = false;   // the powertrain ticks it now...
Wheel.PhysUpdate( dt );       // ...so it must NOT also self-tick (double-sim bug)
return Math.Abs( Wheel.CounterTorque );
```

Gotcha: a wheel driven by the powertrain must NOT also self-simulate — the leaf flips `AutoSimulate=false` precisely to avoid double-ticking. Non-driven wheels keep `AutoSimulate=true`.

### Engine + transmission — Engine.cs / Transmission.cs

Engine holds a `Curve PowerCurve` (RPM% → power%) and a swappable `CalculateTorqueDelegate` (ICE vs electric, chosen in `OnStart`). ICE adds idle correction, a `StarterCoroutine`, stalling, and a fuel-cutoff `RevLimiter()` (Engine.cs:386/:230/:350). A `[Button] FromLUT` even pastes a real RPM|HP dyno table from the clipboard into the curve (Engine.cs:515). Transmission keeps a flat reverse..0..forward `Gears` list and shifts via a per-type `ShiftDelegate`; automatic raises shift points with throttle and incline, manual/sequential/CVT all supported (Transmission.cs:598). Heavy use of `async void` coroutines driven by `GameTask.DelayRealtimeSeconds` — **owner-only, not networked.**

Gotcha: `Gear` is `[Sync]` but stored as an index offset by `ReverseGearCount`; keep `GearToIndex/IndexToGear` consistent or proxies read the wrong gear. The shift coroutine sets `Gear` at the *half-way* point, so UI reading mid-shift briefly shows the old gear (Transmission.cs:526).

### Seat: IPressable enter/exit — SuitableVehicle.cs:36

The seat takes network ownership on press, disables the player GameObject, and flips on the car's input/camera/look controls. Pressing "use" again stands up, drops ownership, and repositions the player. Note `[Sync]` on `User`/`Vehicle` and the `!User.IsValid()` race guard:

```csharp
public bool Press( IPressable.Event e )
{
    if ( e.Source is Player ply && !User.IsValid() ) // guard against two players racing the seat
    {
        Network.TakeOwnership();
        User = ply;
        ply.GameObject.Enabled = false;     // whole player disabled (simple, but its ticks stop too)
        Vehicle.UseInputControls = true;
        Vehicle.UseLookControls = true;
        Input.Clear( "use" );               // swallow the press so we don't immediately exit
        return true;
    }
    return false;
}
```

Gotcha: disabling `ply.GameObject` stops *everything* on the player (not just movement). Simple and fine for a single seat; if the player needs to keep ticking (voice, presence), parent + disable the controller instead.

### Multiplayer spawn with ownership transfer — VehicleSpawner.cs:25

A `Singleton<VehicleSpawner>` clones a prefab on the host via `[Rpc.Host]`, marks it orphan-clearable + takeover-transferable, spawns it **unowned**, then teleports it beside the requester. The seat's `Press` later takes ownership — so the car is shared infrastructure, claimed on entry:

```csharp
[Rpc.Host]
public void CreateVehicle( Player ownerPlayer, int vehicleId )
{
    var car = VehiclePrefabs[vehicleId].Clone();
    car.Network.SetOrphanedMode( NetworkOrphaned.ClearOwner );   // owner leaves -> car goes unowned
    car.Network.SetOwnerTransfer( OwnerTransfer.Takeover );      // next driver can claim it
    car.NetworkSpawn( null );                                    // spawn UNOWNED
    car.GetComponent<VehicleController>().SetupConnection( ownerPlayer.Connection );
}
```

Pattern: spawn shared/unowned, claim-on-press, drop-on-exit. `NetworkOrphaned.ClearOwner` keeps the car alive when its driver disconnects instead of deleting it.

## Reusable standout patterns

- **Forces-on-one-Rigidbody.** Every wheel is a Component that traces to ground and pushes ONE shared `Rigidbody` (impulse for suspension, force for tire). THE recipe for an arcade/sim car in s&box — decouples visuals, suspension, and drive (Suspension.cs:76 + Friction.cs:309).
- **Bake a formula into a `Curve`.** Evaluate expensive math (Pacejka) once into a 20-frame `Curve` at construction, then `Curve.Evaluate(x)` every tick. Cheap *and* the result becomes a tunable asset (PacejkaCurve.cs:62).
- **Recursive Query/ForwardStep over a Component graph.** Torque down, inertia/counter-torque up, `OutputNameHash==0` terminates. Reuse for power grids, fluid, conveyors — anything where a signal propagates through linked parts (PowertrainComponent.cs:103).
- **`[Button]` auto-rigger that self-destructs.** A designer drops a model + tagged wheel GameObjects, clicks one button wrapped in `Scene.Editor.UndoScope(...)`, and gets a fully wired vehicle; the rigger then `Destroy()`s itself. Editor-only API — NPEs at runtime (VehicleCreator.cs:20).
- **Mirrored field + `[Rpc.Broadcast]` setter live-tuning UI.** Each slider's setter calls a broadcast RPC that writes the value to all wheels, giving a multiplayer-synced runtime tuning panel — a clean (if verbose) template for sandbox spawn-menu editors (UI/VehicleEditor.razor:307).

## Pitfalls

- **Unit mismatch.** The whole sim is in inches; one missing `.InchToMeter()`/`.MeterToInch()` makes forces ~39x wrong (Suspension.cs:66). Pick a convention and assert it.
- **Stale `CombinedLoad`.** Friction needs wheel loads pre-summed in `IScenePhysicsEvents.PrePhysicsStep`; without the `WheelManager` hook, grip reads last frame's load (WheelManager.cs:37).
- **Double-simulated wheels.** A powertrain-driven wheel must have `AutoSimulate=false`; leave it on and the wheel ticks twice per frame (WheelPowertrain.cs:65).
- **Proxy gear desync.** `Gear` is a synced offset index — keep the offset helpers consistent (Transmission.cs).
- **Skid-mark object explosion.** A new hidden GameObject spawns *per frame per skidding wheel* as a `LineRenderer` point; cap it with the `MaxSkid`/`MinSlide` ConVars (WheelSkidMark.cs:34). Marks are local/visual, not networked.
- **`Scene.Camera` is global + owner-only.** The chase camera writes the single scene camera and only for `!IsProxy` — fine for owner-drives-locally, but no spectator cams for free (VehicleController.Camera.cs).
- **Editor-only rigger at runtime.** `VehicleCreator` uses `Scene.Editor.UndoScope` — calling it in play mode NPEs (VehicleCreator.cs:20).
- **`async void` coroutines aren't networked.** Starter/rev-limiter/shift coroutines run only on the owner; proxies never see them.

## Verify live

API shifts between SDK builds — reflection is the source of truth, not this doc. Before coding, confirm signatures with the bridge: `describe_type` / `search_types` on `Rigidbody` (`ApplyImpulseAt`/`ApplyForceAt`/`ApplyForce`/`ApplyTorque`), `Sandbox.SceneTrace` (`.Cylinder`/`.Rotated`/`.FromTo`/`.Run`), `Component.IPressable`, `Component.INetworkListener`, `IScenePhysicsEvents`, `Curve`, `LineRenderer`, and the networking surface (`GameObject.NetworkSpawn`, `Network.SetOrphanedMode`/`SetOwnerTransfer`/`TakeOwnership`, `NetworkOrphaned`, `OwnerTransfer`, `[Rpc.Host]`/`[Rpc.Broadcast]`).

Cross-links: pair this with **sbox-api** (look up exact type signatures via reflection before writing) and **sbox-build-feature** (the screenshot-driven iteration loop to build and verify the car in-editor).

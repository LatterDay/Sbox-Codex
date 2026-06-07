# Physics, Traces & Custom Movement

Querying the world with `Scene.Trace`, applying forces to Rigidbodies, and going kinematic to own your velocity when Source 2's solver fights you.

## Mental model

Three ways to move things, pick deliberately:

- **Rigidbody-driven** — leave `Body.MotionEnabled = true`, push it with `ApplyForce` / `ApplyForceAt`. Source 2 solves contacts, friction, stacking for you. Best for props, debris, ragdolls, anything you nudge.
- **Kinematic-integrated** — you own an authoritative `Vector3 _vel`, accumulate forces into it, and write `WorldPosition` yourself each tick. Use this the moment the solver fights you (vehicles, dashes, grapples, hand-rolled controllers). Source 2 **caps/damps velocity at contacts and silently eats applied drive force** — heavy/fast custom movement feels weightless or speed-capped until you go kinematic (sbox-vehicle-kit: VehicleBase.Wheels.cs:192-201).
- **CharacterController** — a swept-capsule mover that collide-and-slides for you but **applies NO gravity** — you integrate gravity yourself (sbox-grubs: GrubPlayerController.cs:46).

`Scene.Trace` is the universal world query underneath all of it: ground checks, interaction rays, suspension casts, pickup sweeps.

---

## Pattern: fluent Scene.Trace world query

Build every query fluently, chain filters, then `.Run()`. The result struct carries everything you need.

```csharp
var tr = Scene.Trace
    .Ray( start, end )                       // or .Sphere(r, a, b) / .Ray(a,b).Size(bbox) for a box sweep
    .IgnoreGameObject( GameObject )           // don't hit your own collider
    .WithoutTags( "player", "debris" )        // exclude
    .WithAnyTags( "solid", "npc", "glass" )   // include only these
    .UseHitboxes()                            // precise hitbox hits, not just bounds
    .Run();

if ( tr.Hit )
{
    // tr.GameObject, tr.Body, tr.Surface, tr.HitPosition, tr.Normal, tr.Distance, tr.Fraction
}
```

Interaction ray from the camera — the canonical "use" trace, self-ignored (sbox-scenestaging: PlayerUse.cs:30):

```csharp
var tr = Scene.Trace.Ray( camera.WorldPosition, camera.WorldPosition + camera.WorldRotation.Forward * 100 )
    .IgnoreGameObject( GameObject )
    .Run();

if ( tr.Hit && tr.GameObject.Components.Get<BaseInteractor>() is BaseInteractor interactable )
    interactable.OnUsed();
```

Ground check: trace a short ray `Vector3.Down`. Note a trace hits a **child** collider/hitbox, not the entity root — resolve the owner with `GetInAncestorsOrSelf<T>()`, not a self-only `Components.Get<T>()`.

---

## Pattern: applying forces to a real Rigidbody

Apply forces in `OnFixedUpdate`. `ApplyForce` pushes through the center of mass; `ApplyForceAt(tr.HitPosition, force)` pushes at a point and imparts torque/spin. Multiply by `Body.Mass` only when you want a **mass-independent** ("ignore mass") response so light and heavy props react identically. The sensor trace **must self-ignore** (offset start past the prop's bounds + `IgnoreGameObjectHierarchy`) or it pushes itself (wirebox: WireForcerComponent.cs:68):

```csharp
protected override void OnFixedUpdate()
{
    var offset = WorldRotation.Up * GetComponent<Rigidbody>().PhysicsBody.GetBounds().Size.z;
    var tr = Scene.Trace.Ray( WorldPosition + offset, WorldPosition + offset + WorldRotation.Up * Length )
        .UseHitboxes().WithAnyTags( "solid", "npc", "glass" ).WithoutTags( "debris", "player" )
        .IgnoreGameObjectHierarchy( GameObject ).Size( 2 ).Run();
    if ( !tr.Hit || !tr.Body.IsValid() ) return;

    var force = WorldRotation.Up * Force;
    if ( IgnoreMass ) force *= tr.Body.Mass;     // cancel mass → equal accel for light + heavy
    tr.Body.ApplyForce( force );                 // ApplyForceAt(tr.HitPosition, force) → spin
}
```

---

## Pattern: CharacterController with manual gravity (leapfrog)

CharacterController gives you no gravity. Apply it as **two half-steps** around `Move()` (leapfrog/Verlet) — a single full step lags the jump/fall arc. Move in `OnFixedUpdate`, never `OnUpdate` (sbox-grubs: GrubPlayerController.cs:46).

```csharp
protected override void OnFixedUpdate()
{
    if ( IsProxy ) return;

    if ( IsGrounded )
    {
        CharacterController.SetVelocity( CharacterController.Velocity.WithZ( 0f ) );
        CharacterController.Accelerate( GetWishVelocity() );
        CharacterController.ApplyFriction( 4f, 100f );
    }
    else
    {
        CharacterController.SetVelocity( Velocity - Gravity * Time.Delta * 0.5f );  // half BEFORE
        CharacterController.ApplyFriction( 0.1f );
    }

    CharacterController.Move();

    if ( !IsGrounded )
        CharacterController.SetVelocity( Velocity - Gravity * Time.Delta * 0.5f );  // other half AFTER
}
```

Jump: set the velocity, then **`ReleaseFromGround()`**, then trigger the animator — or the controller re-sticks to the floor the same tick and eats the jump (sbox-grubs: GrubPlayerController.cs:122-124):

```csharp
if ( Input.Pressed( "jump" ) )
{
    CharacterController.SetVelocity( new Vector3( Facing * 175f, 0f, 220f ) );
    CharacterController.ReleaseFromGround();   // unstick BEFORE Move() runs
    Animator.TriggerJump();
}
```

---

## Pattern: going kinematic to own your velocity

When the solver caps your drive force, take movement off Source 2's hands once and integrate by hand. Keep the Body for its collider geometry + collision queries only (sbox-vehicle-kit: VehicleBase.Wheels.cs:192-201).

```csharp
void SetupKinematicIfNeeded()
{
    if ( _kinematicReady || Body == null ) return;
    try { Body.MotionEnabled = false; } catch { /* property name drifts across SDKs */ }
    _vel = Vector3.Zero;
    _kinematicReady = true;
}

protected override void OnFixedUpdate()
{
    SetupKinematicIfNeeded();
    var dt = Time.Delta;
    if ( dt <= 0f ) return;                  // dt==0 while time-scaled/paused

    _vel += AccumulatedForces / VehicleMass; // Body.Mass reads 0 now → keep your own mass field
    WorldPosition += _vel * dt;              // move by hand
    Body.Velocity = _vel;                    // mirror back so debug overlays/readers stay consistent
}
```

---

## Pattern: suspension + collide-and-slide for a kinematic ground-follower

Per wheel/foot, raycast down and apply a Hooke's-law spring + damper into a single Z velocity change (sbox-vehicle-kit: VehicleBase.Wheels.cs:549-571):

```csharp
var hit = Scene.Trace.Ray( origin, origin + wsDown * (restLength + radius) )
    .IgnoreGameObject( GameObject ).Run();
if ( hit.Hit )
{
    var compression = 1f - MathX.Clamp( (hit.Distance - radius) / restLength, 0f, 1f );
    var spring = compression * Stiffness;
    var damper = (compression - prevCompression) / dt * Damping;
    totalSuspensionForce += spring + damper;   // caller sums → one body Z velocity change
}
```

**Walls are the trap:** when floor and walls are one `MapCollider`, a low box sweep keeps hitting the shared floor face and never sees the wall. Instead fire horizontal **feeler rays at mid-body height** (they physically cannot touch the floor), reject floor/ramp hits with `|Normal.z| > 0.7`, clamp the move, and slide the remainder by cancelling only the into-wall velocity component (sbox-vehicle-kit: VehicleBase.Wheels.cs:494-523):

```csharp
var tr = Scene.Trace.Ray( start, start + dir * rayLen )
    .IgnoreGameObjectHierarchy( GameObject ).Run();
if ( tr.Hit && MathF.Abs( tr.Normal.z ) <= 0.7f )    // a wall, not the floor
{
    var wallN = tr.Normal.WithZ( 0f ).Normal;
    var slide = remaining - wallN * Vector3.Dot( remaining, wallN );  // tangential remainder
    pos += slide;
    var into = Vector3.Dot( _vel, wallN );
    if ( into < 0f ) _vel -= wallN * into;            // kill only the into-wall component
}
```

---

## Pattern: network-correct grab / carry / drop

To carry a physics object across the network: trace for it, `TakeOwnership`, parent it, tag it, and **disable its Rigidbody** so it follows kinematically. Drive its transform in `OnPreRender` (render-rate, smooth). On drop, re-enable the Rigidbody, set throw velocity, unparent, `DropOwnership`. The non-obvious safety: a proxy still flagged carrying must auto-Drop or two clients fight over ownership (sbox-scenestaging: NetworkTest.cs:71).

```csharp
[Sync] GameObject Carrying { get; set; }

void TryPickup()
{
    var tr = Scene.Trace.WithoutTags( "player" ).Sphere( 16, eyePos, eyePos + fwd * 100 ).Run();
    if ( !tr.Hit || tr.Body.GameObject is not GameObject go || !go.Tags.Has( "pickup" ) ) return;

    go.Network.TakeOwnership();
    Carrying = go;
    Carrying.SetParent( GameObject, true );
    Carrying.Tags.Add( "carrying" );
    if ( Carrying.Components.Get<Rigidbody>( true ) is { IsValid: true } rb ) rb.Enabled = false;
}

protected override void OnPreRender()   // smooth render-rate follow, NOT physics
{
    if ( Carrying.IsValid() && !Carrying.IsProxy )
        Carrying.WorldPosition = HoldRelative.WorldPosition + HoldRelative.Parent.WorldRotation * new Vector3( 0, 0, 40 );
}

void UpdatePickup()
{
    if ( Carrying.IsValid() && Carrying.IsProxy ) { Drop(); return; }  // proxy still carrying → auto-drop
    // ...
}

void Drop()
{
    if ( Carrying.Components.Get<Rigidbody>( true ) is { IsValid: true } rb )
    { rb.Enabled = true; rb.Velocity = throwDir; }
    Carrying.SetParent( null, true );
    Carrying.Tags.Remove( "carrying" );
    Carrying.Network.DropOwnership();
    Carrying = null;
}
```

Read `tr.Surface.SoundCollection` for material-specific footsteps/impact audio off any trace.

---

## Gotcha table

| Gotcha | Why it bites | Fix |
| --- | --- | --- |
| CharacterController has no gravity | Character floats / never falls | Integrate gravity yourself as two half-steps around `Move()` (leapfrog), not one full step |
| Jump gets eaten the same tick | Controller re-sticks to floor after you set jump velocity | Call `ReleaseFromGround()` after `SetVelocity`, before `Move()` |
| Drive force feels weightless / speed-capped | Source 2 solver damps velocity at contacts | `Body.MotionEnabled = false` and integrate `_vel` by hand |
| `Body.Mass` reads 0 | Body is kinematic now | Keep your own mass field for F=ma; mirror `_vel → Body.Velocity` for debug readers |
| Box sweep never sees the wall | Floor + walls share one `MapCollider`; sweep keeps hitting the floor face | Horizontal feeler rays at body height; reject hits with `|Normal.z| > 0.7` |
| Sensor/forcer trace self-hits | Trace starts inside your own collider | Offset start past the prop's bounds AND `IgnoreGameObjectHierarchy(GameObject)` |
| `Body.MotionEnabled` throws | Property name has shifted across SDK builds | Wrap in try/catch; confirm the live name with `describe_type` first |
| Two clients fight over a held item | Proxy still thinks it's carrying | Auto-`Drop()` when `Carrying.IsProxy` (or `IsProxy && Carrying`) is true |
| Carried object jitters | Transform driven in `OnFixedUpdate` (or physics in `OnPreRender`) | Drive carried transform in `OnPreRender`; do force/integration in `OnFixedUpdate` |
| `force * Body.Mass` makes heavy props float | Mass cancellation applied unconditionally | Multiply by `Body.Mass` only for intentional mass-independent response |
| Movement jitters / `Time.Delta` is 0 | Moving in `OnUpdate` (frame-rate dependent), or game time-scaled to 0 | Move in `OnFixedUpdate`; guard `if (dt <= 0f) return;` and use `RealTime` for time-scaled motion |
| Mutating synced state silently rolls back | Wrote on a proxy/client | Gate mutators behind `if (IsProxy) return;` (owner-auth) or `if (!Networking.IsHost) return;` (host-auth) |

Verify live: reflection is authoritative for the installed SDK — confirm volatile members (`Body.MotionEnabled`, `CharacterController.ReleaseFromGround`, `SceneTraceResult` fields, `Rigidbody.ApplyForceAt`) with `describe_type` / `search_types` / `get_method_signature` before relying on a name, and wrap genuinely version-volatile calls in try/catch with a one-shot warning.

See also: **sbox-api** (look up exact signatures via reflection) and **sbox-build-feature** (the screenshot-driven build loop — note the bridge can't synthesize input, so verify movement/grab with `execute_csharp` or a human playtest).

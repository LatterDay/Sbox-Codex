# Document-Sim (Papers-Please-like) Genre Recipe

Build a first-person inspection game: an NPC presents procedurally-generated documents, the player checks them against a randomized rule set, and accepts/denies — scored against a verdict engine. Mined from `dimmies.terryspapers` (Terry's Papers), a single-player, offline, modern GameObject/Component/Scene build.

## What defines the genre

- **The desk loop, not the world.** The player is mostly stationary at an inspection station. Gameplay is *look at document → spot discrepancy → decide*. There is almost no locomotion or combat.
- **A rules-vs-data tension.** Each shift randomizes which checks are required; each subject is generated to *sometimes* violate them. The fun is the gap between "what the rules demand" and "what this subject's papers actually say."
- **Coherent, subtle forgeries.** A good fake is *derived* from the real value with one thing wrong — not independently random (a random fingerprint is trivially obvious; a real one with one swapped digit is fair-but-hard) (terryspapers: `RandomTerryData.cs:1392-1415`).
- **Soft-fail economy.** Wrong calls dock mood/money/score rather than instant game-over; you get fired only when a meter bottoms out at low rank.

### Core loop
`StartDay → roll shift rules → generate subject + planted errors → reveal documents → player inspects (raycast 'use') → accept/deny → verdict (WrongList/CorrectList) → score + mood + punishment → next subject → quota met? → EndDay → narrative beat → save`.

## System stack (compose these)

| System | Role | Reference |
|---|---|---|
| Raycast-tag interaction dispatcher | "look at thing, press use" on any prop | `references/systems/interaction-use-prompt.md` |
| Rules-vs-data verdict engine | the actual Papers-Please core | `references/systems/rules-validation-engine.md` |
| Procedural subject + planted-error generator | data-table / weighted-roll NPC factory | `references/systems/procedural-data-generator.md` |
| Camera-to-texture mugshot | live 3D portrait on ID/passport UI | `references/systems/render-to-texture-portrait.md` |
| In-game clock & day flow | tick clock, quota, EndDay gate | `references/systems/day-cycle-round-flow.md` |
| JSON persistence | save/continue to `FileSystem.Data` | `references/systems/json-save-load.md` |
| Async scripted-sequence pattern | skippable cutscenes / staggered reveals | `references/systems/async-sequence.md` |
| Cinematic camera handler | fade + SmoothDamp/Slerp scripted beats | `references/systems/cinematic-camera.md` |
| Mood/economy progression | soft-fail meter + promotion/permadeath | `references/systems/economy-progression.md` |
| Service-locator (`GameCore`) | typed `[Property]` handles to every manager | (pattern below) |

The first three are the irreducible core — a document-sim is *interaction dispatcher + verdict engine + data generator*. The rest are polish.

## Build order

1. **Service-locator first.** One `GameCore : Component` holding `[Property]` handles to every manager, wired by drag-drop in the editor. Subsystems take `[Property] GameCore gameCore` and reach peers via `gameCore.terryHandler.X`, avoiding fragile `Scene.Children.Where(name==...)` lookups (terryspapers: `GameCore.cs:4-23`).
2. **Interaction dispatcher.** One per-frame camera raycast filtered on a tag, dispatching to `Interactable.RunLogic()`. New props need zero dispatcher changes (terryspapers: `Interactable.cs:3-6`, `Interact.razor:91-117`).
3. **Subject generator.** Weighted-roll a strongly-typed data record + a `Dictionary<string,bool>` of planted-error flags. Make required traits likely (~0.9), non-required unlikely (~0.2), "bad" flags rare (~0.05) so most subjects are valid (terryspapers: `RandomTerryData.cs:1345-1374`).
4. **Rules roller + diegetic notes.** Randomize per-shift requirement booleans and *mirror the same data* into in-world rule-note GameObjects (single source of truth) (terryspapers: `GameRules.cs:16-65`).
5. **Verdict engine.** A method returning `(WrongList, CorrectList)` of plain-English reasons that feeds scoring, punishment branching, AND the feedback UI (terryspapers: `TerryHandler.cs:568-630`).
6. **Document props + reveal.** Spawn physical paper GameObjects on the desk; stagger their appearance with an async sequence.
7. **Mugshot, clock, economy, persistence, narrative** — layer in as polish.

## How the real game does it

### 1. The interaction dispatcher (most portable recipe)

One abstract Component is the entire contract (terryspapers: `Interactable.cs:3-6`):

```csharp
public abstract class Interactable : Component
{
    public abstract void RunLogic();
}
```

A single raycast in a per-frame method finds the hovered prop by tag, draws a hover outline, and dispatches on click (terryspapers: `Interact.razor:75-117`):

```csharp
var look = Scene.Trace.Ray(
        Scene.Camera.WorldPosition,
        Scene.Camera.WorldPosition + Scene.Camera.WorldRotation.Forward * 1000f )
    .Radius( 0.1f )
    .WithoutTags( "player" )   // camera-origin ray would self-hit a third-person body
    .Run();

if ( look.Hit && look.GameObject.Tags.Has( "interactable" ) )
{
    var outline = look.GameObject.Components.Get<HighlightOutline>();
    if ( outline is not null ) outline.Width = 0.2f;   // hover feedback
}

if ( Input.Pressed( "attack1" ) && look.Hit && look.GameObject.Tags.Has( "interactable" ) )
{
    var interactable = look.GameObject.Components.Get<Interactable>();
    if ( interactable.IsValid() ) interactable.RunLogic();
}
```

Every interactive object (`ViewDocument`, `ShadyScanner`, `CoffeeCupInteract`, `PanicButtonInteract`, `TerryInteract`...) subclasses `Interactable` and self-contains its behavior. To add one: subclass, add the `"interactable"` tag, optionally add `HighlightOutline`. **Gotcha:** the ray originates at the *camera*, so `.WithoutTags("player")` is mandatory for any non-FP rig; and there is no central "can I interact now?" gate, so each subclass re-checks its own guard booleans — consider a shared `bool CanInteract` to stop guard drift.

### 2. Rules roller mirrored into world props

`SetShiftRules` rolls four required-document booleans + a quota, then reflects the *same* state into diegetic rule notes — one structure drives both validation and the in-world signage the player reads (terryspapers: `GameRules.cs:16-65`):

```csharp
public void SetShiftRules( int shift )
{
    reqBirthCert   = Game.Random.Next( 2 ) == 0;
    reqEntryTicket = Game.Random.Next( 2 ) == 0;
    reqVaccine     = Game.Random.Next( 2 ) == 0;
    reqFingerprint = Game.Random.Next( 2 ) == 0;
    shiftQuota     = Game.Random.Next( 7, 11 );

    if ( shift == 1 ) { /* tutorial: all false, quota 2 */ }

    foreach ( var n in ruleNotes ) n.Enabled = false;
    int i = 0;
    if ( reqBirthCert ) {
        ruleNotes[i].Enabled = true;
        ruleNotes[i].Children.First( c => c.Name == "Text" )
            .Components.Get<TextRenderer>().Text = "Must provide \nBirth Certificate!";
        i++;
    }
    // ...one block per active rule
}
```

### 3. Verdict as two reason-lists (not a bool)

The correctness check returns `(WrongList, CorrectList)` of plain-English strings; `WrongList.Count > 0` means "should have been denied." The same lists feed scoring, punishment branching, and `SendResponse` which animates each reason into the UI — decoupling *why it's wrong* into a reusable list is the cleanest pattern in the game (terryspapers: `TerryHandler.cs:568-630`):

```csharp
public (List<string>, List<string>) DidWeGetItWrong()
{
    var wrong = new List<string>();
    var ok    = new List<string>();

    if ( !CurrentTerryData.HasId ) wrong.Add( "Didn't have ID Card" ); else ok.Add( "Had ID Card" );
    if ( gameCore.gameRules.reqBirthCert && !CurrentTerryData.HasBirthCert )
        wrong.Add( "Didn't have Birth Certificate" ); else ok.Add( "Had Birth Certificate" );
    if ( CurrentTerryData.HasFingerprint && CurrentTerryData.HasFakeFingerprint )
        wrong.Add( "Fingerprint Record didn't match!" );

    if ( CurrentTerryData.HasWeapon )       wrong.Add( "Person had a weapon" );
    if ( CurrentTerryData.IsWanted )        wrong.Add( "Person was wanted" );
    if ( CurrentTerryData.HasIllegalGoods ) wrong.Add( "Person had illegal goods" );
    // ...plus expiry compares against the in-game clock
    return (wrong, ok);
}
```

**Two real gotchas to fix in your version:** (a) this ~60-line block is *duplicated* in a debug ConCmd (`GameHandler.genterries()`) — keep it in one place. (b) Expiry dates are `"M/D/YYYY"` strings compared via `.Split("/")[n].ToInt()`, which silently breaks on any format change — prefer `DateTime`. Reasons are raw strings that both UI and scoring string-match — an enum keyed to display text is safer.

### 4. Generate forgeries coherently

Don't randomize a fake independently — derive it from the real value with one thing wrong, so "spot the discrepancy" is fair (terryspapers: `RandomTerryData.cs:1392-1415`):

```csharp
// Copy the genuine 5-number fingerprint, then swap exactly one digit.
string[] GetFakeFingerprint( string[] real )
{
    var fake = (string[])real.Clone();
    int idx  = Game.Random.Next( fake.Length );
    fake[idx] = Game.Random.Next( 0, 10 ).ToString();   // subtle, not obvious
    return fake;
}
```

The weighted-trait roll (`GetRandomOptions`) reads the *active rules* and some already-assigned fields (e.g. Country forces an entry-ticket requirement), so **field assignment order matters** — assign anything the roll reads before calling it. Upgrade target: move the hard-coded inline name/address pools (a 1400-line file) into a `GameResource` or CSV, and use a single seedable `Game.Random` instead of mixing `System.Random` instances so shifts are reproducible.

## Modern-API notes & pitfalls

- Use `Component` / `GameObject` / `Scene`, `[Property]` for editor-wired refs, `Scene.Trace.Ray(...)`, `Tags.Has(...)`, `Components.Get<T>()`, `.IsValid()`. This game is networking-free; only add `[Sync]`/`[Rpc.*]` if you go multiplayer.
- Mugshot: `Texture.CreateRenderTarget("Mugshot", ImageFormat.RGBA8888, 512)` + `camera.RenderToTexture(rt)`, bound into Razor `<image>`. **Pool the render target** — the source allocates one per subject with no disposal and leaks GPU memory over a long session (terryspapers: `TerryHandler.cs:136-141`).
- Sequencing is `async void` + `await GameTask.Delay(ms)`. Scatter `if (!Game.IsPlaying) return;` after each await so stop-play doesn't run dead sequences, and prefer a `CancellationToken` over ad-hoc bool flags.
- Persistence: `FileSystem.Data.WriteAllText("data.json", JsonSerializer.Serialize(data))`. Don't hand-copy fields property-by-property on load (the source warns you to edit three places per new field) — assign the deserialized object and add a version int for migration.
- Avoid the source's string-state-machine fields (`currLocation`, `zoomDir`) and magic-string event-id dictionaries (a typo throws `KeyNotFoundException`) — use enums.

Verify live: the installed SDK is the source of truth — confirm `Scene.Trace.Ray`, `HighlightOutline`, `Texture.CreateRenderTarget`, `CameraComponent.RenderToTexture`, `TextRenderer`, and `GameTask.Delay` signatures with `describe_type` / `search_types` reflection before coding, as the API shifts between versions.

See also: the **sbox-api** skill (reflection-verified type signatures) and the **sbox-build-feature** skill (screenshot-driven iteration loop) when implementing any system above.

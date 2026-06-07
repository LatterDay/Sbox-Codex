# Dialogue & Speech-Bubble Systems

Showing NPC lines, branch choices, or confirm prompts to a player — author the text as data, trigger on proximity/interaction, then reveal it with a `PanelComponent` (often a typewriter). Use this whenever you need talking NPCs, story beats, tutorial barks, or a yes/no modal.

## What it IS (and when)

A dialogue system is three decoupled layers, and every mined game splits them the same way:

1. **Data** — lines/voice/name authored as a `GameResource` asset so designers edit `.npct` files with no recompile (repo facepunch.jumper: `jumper/Code/FunStuff/JumperNPCYapper.cs:1`).
2. **Trigger** — *when* to speak: a proximity `Component.ITriggerListener` or an interactable (repo facepunch.jumper: `jumper/Code/FunStuff/JumperNPCLooker.cs:24`).
3. **Presentation** — a `PanelComponent` razor panel that reveals the text and plays a per-char blip (repo facepunch.jumper: `jumper/Code/UI/JumperNPCTalker.razor:33`).

Keep them separate so the same UI panel serves NPC barks, tutorial prompts, and modal confirms.

## Canonical modern-s&box recipe

### 1. Author lines as a GameResource

```csharp
[GameResource( "NPC TEXT", "npct", "NPC dialogue", Icon = "sentiment_very_satisfied" )]
public class NPCTextGameResource : GameResource
{
    [Property] public string NPCName { get; set; }
    [Property] public List<string> NPCText { get; set; } = new();
    [Property, ResourceType( "sound" )] public string NPCVoice { get; set; }
}
```

This makes editable `.npct` assets in the asset browser; no code change to add lines (repo facepunch.jumper: `jumper/Code/FunStuff/JumperNPCYapper.cs:1-18`). Verbatim from source.

### 2. Trigger on the player entering a zone

The NPC component implements `Component.ITriggerListener` and gates on a tag. Note the collider that carries the `player` tag is a child, so the code climbs to `other.GameObject.Parent` for the real player root.

```csharp
public sealed class NpcTalkTrigger : Component, Component.ITriggerListener
{
    [Property] List<NPCTextGameResource> Resources { get; set; }
    NPCTextGameResource _pack;

    protected override void OnEnabled()
    {
        if ( Resources is { Count: > 0 } )
            _pack = Resources[ Game.Random.Int( 0, Resources.Count - 1 ) ];
    }

    void ITriggerListener.OnTriggerEnter( Collider other )
    {
        if ( !other.GameObject.Tags.Has( "player" ) ) return;
        var talker = other.GameObject.Parent
            .Components.Get<DialoguePanel>( FindMode.EnabledInSelfAndChildren );
        talker.NPCName = _pack.NPCName;
        talker.Voice   = _pack.NPCVoice;
        talker.DisplayMessage( PickNonRepeating() );
    }

    void ITriggerListener.OnTriggerExit( Collider other ) { }
}
```

Pattern verified in `JumperNPCLooker.cs:24-40` (tag-gate + `Parent` climb + random pack on enable) and `JumperFinishLine.cs:14` (same `ITriggerListener` + tag shape). The trigger needs a sibling `Collider` with **IsTrigger = true** and matching collision tags set in the prefab — without that, `OnTriggerEnter` never fires.

A non-repeating line picker avoids saying the same thing twice:

```csharp
int _last = -1;
string PickNonRepeating()
{
    int i = Game.Random.Int( 0, _pack.NPCText.Count - 1 );
    while ( _pack.NPCText.Count > 1 && i == _last )
        i = Game.Random.Int( 0, _pack.NPCText.Count - 1 );
    _last = i;
    return _pack.NPCText[ i ];
}
```

(repo facepunch.jumper: `jumper/Code/FunStuff/JumperNPCLooker.cs:52-61`).

### 3. Reveal it with a typewriter PanelComponent

A `PanelComponent` razor panel appends one char at a time, plays a pitch-randomized blip per letter (Undertale-style), and auto-hides via `RealTimeSince`.

```razor
@inherits PanelComponent

<root class=@(Visible ? "visible" : "")>
    <label class="message">@OutputText</label>
    <label class="name">@NPCName</label>
</root>

@code {
    public string OutputText { get; set; }
    public string NPCName { get; set; } = "Ben";
    public string Voice { get; set; } = "beep1";

    private string _message = "";
    private RealTimeSince _shown = 999;
    private bool Visible => _shown < 4;   // auto-hide 4s after last char

    public void DisplayMessage( string message )
    {
        _message = message;
        OutputText = null;                // null = "start a fresh reveal"
    }

    private async Task RevealTextAsync( string message )
    {
        foreach ( char c in message )
        {
            OutputText += c;
            _shown = 0f;
            await Task.DelaySeconds( Game.Random.Float( 0.05f, 0.2f ) );
            var snd = Sound.Play( Voice );
            snd.Pitch = Game.Random.Float( 0.9f, 1.1f );
            snd.Volume = 0.25f;
        }
    }

    protected override void OnUpdate()
    {
        if ( OutputText == _message ) return;
        if ( OutputText == null ) _ = RevealTextAsync( _message );
        _message = OutputText;            // guard: don't re-fire mid-reveal
    }

    protected override int BuildHash()
        => HashCode.Combine( OutputText, Visible ? 1 : 0 );
}
```

Faithful to `jumper/Code/UI/JumperNPCTalker.razor:33-78`. The `.visible` opacity is driven from SCSS off the `visible` class. `BuildHash` must include `OutputText` so the panel re-renders each appended char.

## Variations seen across games

- **Modal confirm dialog (static singleton + callback).** A purchase/confirm prompt is one panel opened via a static `Open(item, onConfirm)`; the click handler invokes the stored `System.Action` and closes. Affordability disables the button (`@(CanAfford ? "" : "disabled")`) and `Input.Pressed("use")` cancels (repo playbtg.elevator: `elevator/Code/UI/ShopConfirmation.razor:36-85`). This is the cleanest "yes/no" pattern — reuse it for any confirm gate, not just shops.
- **3D product/portrait display alongside text.** The shop renders the item's `IconModel` next to a world-panel sign and wires an interaction; a dialogue NPC can do the same to show a speaker portrait or held prop (repo playbtg.elevator: `elevator/Code/Inventory/ShopDisplay.cs:12`).
- **LookAt while talking.** The same trigger that opens dialogue points the NPC's `CitizenAnimationHelper.LookAt` at the player (`EyesWeight/HeadWeight/BodyWeight = 1`) and resets to a default `LookTarget` on exit — cheap "they noticed you" polish (repo facepunch.jumper: `jumper/Code/FunStuff/JumperNPCLooker.cs:29-47`).
- **Interaction-driven instead of proximity.** Trigger off an `IPressable`/use-key interactable rather than a trigger volume when the player should choose to talk (repo playbtg.elevator: `elevator/Code/Interaction/Interactables/ShopInteraction.cs:19`).

## Gotchas

- **Tag lives on the collider child, root lives on the parent.** Every game does `other.GameObject.Parent` (or `.Root`) after the tag check. Jumper is *inconsistent* — Finish/Wind mix `.Parent` and `.Root`, a latent add/remove mismatch (repo facepunch.jumper: `JumperFinishLine.cs:18` vs `JumperWindTunnel.cs`). Pick one (`other.GameObject.Root`) and stay consistent.
- **The reveal is fire-and-forget `async`.** `RevealTextAsync` is started without awaiting and has **no cancellation** — a new message arriving mid-reveal interleaves chars. Track a `CancellationTokenSource` (or a reveal-generation int) and bail if it changes before the next `await`.
- **Trigger needs a real trigger collider.** `ITriggerListener` callbacks only fire if a sibling `Collider` has `IsTrigger = true` and collision tags that match the player. Easy to forget in the prefab → silent no-op.
- **Modal singletons race on startup.** Static `Instance`/`Local` lookups (ShopConfirmation, doner_kiosk's cam panel resolved after a 3s `Task.DelaySeconds`) can be null before the panel awakes — null-guard every `Open()`/`Instance` access (repo playbtg.elevator: `ShopConfirmation.razor:44,58`).
- **The jumper talker wiring ships commented out.** In `JumperNPCLooker.cs:33-38` only the `LookAt` is live; the `DisplayMessage` call is in a `/* */` block. The pieces are all correct — you wire them together yourself.
- **Multiplayer:** the panels here are local/client UI. If the *decision* matters (which line everyone hears, a confirmed purchase), drive it from a host-authoritative source and replicate with `[Sync]` / `[Rpc.Broadcast]` — do not trust a client-only reveal.

## Seen in

- **facepunch.jumper** — full data→trigger→typewriter stack: `jumper/Code/FunStuff/JumperNPCYapper.cs` (GameResource), `JumperNPCLooker.cs` (trigger + LookAt), `jumper/Code/UI/JumperNPCTalker.razor` (typewriter), `jumper/Code/GamePlay/JumperFinishLine.cs` (ITriggerListener reference).
- **playbtg.elevator** — modal confirm dialog + 3D product display: `elevator/Code/UI/ShopConfirmation.razor`, `elevator/Code/Inventory/ShopDisplay.cs`, `elevator/Code/Interaction/Interactables/ShopInteraction.cs`.
- **luckygaming.doner_kiosk** — per-customer cam-dialog gated behind a CCTV panel + static singleton (startup-delay race): `Code/Game/CameraPanel.cs`, `Code/Game/VideoCamera.cs`.

---
**Verify live:** the installed SDK is authoritative — confirm members before coding with the bridge's reflection tools: `describe_type GameResource`, `describe_type Sandbox.Component+ITriggerListener`, `describe_type Sandbox.UI.PanelComponent`, `search_types CitizenAnimationHelper`. Reflection beats any snippet here if the API has moved.

**See also:** `sbox-api` (exact signatures for `PanelComponent`, `ITriggerListener`, `GameResource`, `RealTimeSince`) and `sbox-build-feature` (the screenshot-driven loop to wire the prefab trigger + panel and see it working).

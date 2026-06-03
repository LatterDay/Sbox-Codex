---
name: sbox-build-feature
description: Use when building, modifying, or polishing any feature in an s&box game project through the Claude Bridge — gameplay systems, UI panels, character abilities, animation, world generation, anything that produces a visible or runtime change. Codifies the screenshot-driven iteration workflow that prevents the "guess-and-check" loop the bridge is most susceptible to.
---

# Building s&box Features Through the Bridge

This skill is the workflow you follow whenever you're about to make non-trivial changes to a player in an s&box project via the bridge. It exists because the bridge gives Claude a lot of power but **no eyes** — without discipline, sessions devolve into guessing about how things look. These steps prevent that.

## Hard rule: never declare a visual feature "working" without seeing it

If your change affects anything visual (a model, a position, an animation, a UI panel, a particle, a light), you **must** see it before saying the work is done. You're a multimodal model — you can read PNGs.

**Aim the camera, or you'll screenshot the wrong thing.** `mcp__sbox__take_screenshot` renders from the scene's **Main Camera** — one fixed angle that usually isn't pointed at what you just changed. Use **`mcp__sbox__screenshot_from`** to point the camera at your target object/point, capture, and restore. This is the single highest-leverage habit in the whole workflow.

## The Workflow — six steps, in order

### 1. Confirm the bridge is alive

```
mcp__sbox__get_bridge_status
```

If timed out: s&box isn't running, or the **Claude Bridge dock is closed** — the dock must stay visible for the bridge's frame loop to process requests. Don't go further until it responds.

### 2. Brainstorm before code (for non-trivial features)

If the feature is more than a one-line tweak — anything that involves:
- A new state machine
- Animation, IK, or camera work
- A new component or system
- Anything where you can't predict the visual outcome with confidence

…invoke `superpowers:brainstorming` first. Don't skip this. The brainstorming skill exists because the cost of designing wrong is much higher than the cost of designing slowly.

### 3. Research the s&box API before guessing

Before writing code that calls a type or method you haven't verified exists in the current SDK build:

```
mcp__sbox__describe_type    name="CitizenAnimationHelper"
mcp__sbox__search_types     pattern="*Renderer"
mcp__sbox__get_method_signature  type="GameObject" method="AddComponent"
```

s&box's API changes between versions. Reflection is the source of truth, not your training data. Look it up.

If you need broader documentation (animation graph, IK setup, rendering pipeline), use WebFetch on https://wiki.facepunch.com/sbox/ or search Discord.

### 4. Implement with bite-sized edits

- One change per `Edit` call. Don't batch unrelated edits.
- Keep changes scoped to one file at a time when possible.
- For the bridge addon specifically: **never copy `claudebridge.sbproj` from the repo into a project's `Libraries/`** — the repo version has `Org: sboxskinsgg` (for asset library publish) and a project's working copy must stay `Org: local`. Mixing these causes a compiler-name collision that prevents the project from loading.

### 5. Hotload and verify compile

```
mcp__sbox__trigger_hotload
```

Then tail the log:

```bash
LOG="A:/SteamLibrary/steamapps/common/sbox/logs/sbox-dev.log"
tail -30 "$LOG" | grep -iE "Compile of 'local\.<projectname>.*Failed|Error \|"
```

**`Compile of 'local.X' Failed`** lines from earlier hotloads can be stale and survive in the log — what matters is whether the line timestamp is recent and the error message mentions YOUR file. If there's a real error: fix it, re-hotload, re-check.

### 6. Screenshot and read it yourself

For any visual change, **aim the camera at the thing you changed**:

```
mcp__sbox__screenshot_from   target=<object GUID or world point>
```

`screenshot_from` moves the Main Camera to frame your target, captures, and restores it. Plain `mcp__sbox__take_screenshot` renders the Main Camera's *current* angle — fine if it already frames your subject, useless otherwise. Either way the file saves to `<sbox-install>/screenshots/sbox.<timestamp>.png` (the `path` parameter is ignored — known quirk). Use `Bash` to list newest by mtime, then `Read` on the PNG. **Look at the image.** If it doesn't match the design, iterate. Don't declare the feature done based on the code looking right.

For diagnosing a compile/runtime failure, you don't need the editor to respond: `mcp__sbox__get_compile_errors` and `mcp__sbox__read_log` read `sbox-dev.log` directly.

For timing-sensitive captures (e.g. a 0.20s animation phase), coordinate with the user: "press the action and tell me 'go' the moment you do" — fire `take_screenshot` immediately, the round-trip captures roughly the right window.

## Common s&box gotchas (so you don't re-discover them)

| Gotcha | What to do instead |
|---|---|
| `System.MathF` doesn't exist in s&box sandbox | Use `MathX.Clamp`, `MathX.Lerp`, etc. |
| Cloud-only assets (`Cloud.Model("foo")`) don't persist across project restarts | Use local files or core engine assets |
| `s&box doesn't support .mp3` | Convert to `.wav` (ffmpeg is your friend) |
| Setting `[Property]` on a saved component overwrites the deserialized value | Use field initializers as defaults that can be overridden in the inspector |
| `TimeSince` fields default to 0 → cooldowns fire immediately on spawn | Initialize to a large value: `private TimeSince _sinceX = 100f;` |
| Hotload cache gets stuck after multiple iterations | Restart the project or touch+hotload |
| `Cloud.Model(variable)` fails | The source generator requires string literals — always inline |
| Citizen "head" bone exists but bone names are case-sensitive | `TryGetBoneTransform("head")` — lowercase |
| `CitizenAnimationHelper.IkRightHand` is a writable GameObject — IK works at runtime | Set it to a target GO to drive the hand via IK |
| `set_property` for `Color` wants `"r, g, b, a"` as a string, not a JSON object | Format the value as a comma-separated string |
| `take_screenshot` renders the **Main Camera** (one fixed angle) and ignores its `path` arg | Use `screenshot_from` to aim at your target; read the latest file in `<sbox>/screenshots/` |
| Runtime `ParticleEffect` tools (`spawn_particle`, `add_trail`, `add_beam`) don't render through the bridge | Use `spawn_vpcf` (compiled `.vpcf` + `LegacyParticleSystem`) |
| `is_playing.sessionPlaying` can read stale (true in edit mode after a restart) | Trust the `gameFlag` field |
| A placed `EnvmapProbe` captures nothing until baked | Call `bake_reflections` |
| Scene-mutating tools refused during play mode (v1.2.0+) | Stop play, mutate, restart play |

## Project-level CLAUDE.md

If the project you're working on has its own `CLAUDE.md`, **read it first**. It captures project-specific decisions (input bindings, sound files, role assignment, scene layout) that this skill can't know about.

## The thing that always works

When you're stuck, in a loop, or about to make your fifth guess at a visual offset:

1. Take a screenshot of the current state
2. Read it yourself
3. Describe to the user exactly what you see vs. what should be there
4. Propose a specific adjustment (with magnitude) rather than another guess

The screenshot loop closes faster than the guess loop. Use it.

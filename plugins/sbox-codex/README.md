# sbox-codex — Codex Plugin

The complete toolkit for building s&box games by talking to Codex.

📖 **Full docs:** [sboxskins.gg/codexbridge](https://sboxskins.gg/codexbridge) — overview, setup, changelog, troubleshooting & FAQ.

This plugin bundles:

| Component | What it does |
|---|---|
| **MCP server registration** (`sbox` from npm) | 201 tools to drive the s&box editor — GameObjects, scripts, scenes, components, physics, networking, UI, world-gen, lighting & atmosphere, characters, scene layout, navmesh & spatial queries, particles, animation, NPC brains, playable-game scaffolds, networking & scene inspection/lint, save & services queries, scatter & object utilities, self-diagnosis, console/C# execution, live docs search, type discovery, debug-draw visualization, play-mode time-scale & profiler, and a playtest harness that runs a scripted gameplay loop and asserts the result in-frame |
| **Skill: `sbox-build-feature`** | Codifies the screenshot-driven iteration workflow — bridge check, brainstorm gate, API research, hotload verify, screenshot read. Prevents the "guess and check" loop |
| **Skill: `sbox-api`** | Schema-grounded s&box API knowledge — Unity→s&box translation table, the Ten Rules, and curated component/UI/networking/physics references. Stops Unity-pattern hallucination; repointed to verify signatures via the bridge's live `describe_type`. Adapted from [codex-sbox](https://github.com/gavogavogavo/codex-sbox) (MIT © David Ryan) |
| **Skill: `sbox-cookbook`** | A master **router** of code-grounded recipes mined from 51 current (2026) open-source s&box games + the modern engine repos -- **11 engine**, **18 system**, and **20 genre** references. Ask "how do I build a tycoon / an inventory / a save system?" and it routes to a grounded how-to |
| **Skill: `sbox-scaffold-game`** | Turns one ask into a playable starter scene (first-person preset) |
| **Skill: `sbox-setup`** | A ~30-second onboarding wizard — verifies the bridge, detects your installed libraries, recommends a first move |
| **Agent: `sbox-game-dev`** | Optional specialist for handing off self-contained game-dev tasks |

## What this plugin does NOT include

This plugin gives Codex the **MCP server side** of the bridge. To actually drive the s&box editor, you also need the **bridge addon** installed in your s&box **project's** `Libraries/` folder. The addon and the MCP server work together over file IPC.

**Install the bridge addon separately** — see the [main repo's INSTALL.md](https://github.com/LatterDay/Sbox-Codex/blob/main/INSTALL.md). The 30-second version:

```powershell
git clone https://github.com/LatterDay/Sbox-Codex.git
cd Sbox-Codex
.\install.ps1 -RemoveStaleAddons      # Windows
./install.sh --remove-stale            # Linux/Mac/WSL
```

## Install the plugin

Install from this fork with:

```bash
codex plugin marketplace add LatterDay/Sbox-Codex
codex plugin add sbox-codex@sbox-codex
```

For local development from this checkout, add the repo root as a local marketplace and reinstall after changes:

```bash
codex plugin marketplace add /path/to/Sbox-Codex
codex plugin add sbox-codex@sbox-codex
```

After install, start a new Codex session so updated skills and MCP tools are loaded.

## Verify it's working

In a new Codex session, ask:

```
Check the bridge status.
```

Codex should invoke `mcp__sbox__get_bridge_status` and report whether the bridge addon is connected (you'll see `connected: true` with a healthy `handlerCount` if the addon side is also installed and s&box is running).

If it says "tool not found": the MCP server isn't registered — reinstall the plugin and start a new Codex session.
If it says "connection refused" or times out: the bridge addon side isn't installed in your project (see above) or s&box isn't running.

## Using the skill

The `sbox-build-feature` skill activates whenever Codex is about to make a non-trivial change to an s&box project. You can also invoke it explicitly:

```
/sbox-codex:sbox-build-feature
```

The skill enforces:
1. Confirm bridge alive before doing anything
2. Brainstorm complex features before coding
3. Research the s&box API via `describe_type` before guessing
4. Bite-sized edits, one file at a time
5. Hotload + log scan after every change
6. **Screenshot + read it yourself** for any visual change

Plus a list of common s&box gotchas (MathF not available, Cloud assets not persistent, Citizen bone names case-sensitive, CitizenAnimationHelper.IkRightHand works at runtime, etc.).

## Using the agent

For larger self-contained tasks, hand off to the specialist:

```
Use the sbox-game-dev agent to build a survival-stamina system with HUD bar, depletion on sprint, regen when idle, and red flash when low.
```

The agent runs the `sbox-build-feature` skill as its default workflow.

## What's bundled vs. fetched

- The MCP server (`sbox-mcp-server`) is fetched from npm on first use via `npx -y`
- The skill and agent are bundled with the plugin
- The bridge **addon** (the s&box-side C# code) is **not bundled** — install it into your s&box project via the install script (see above)

## Version compatibility

- This plugin is **v1.17.1**. **The MCP server version is pinned in the plugin's `.mcp.json`** (currently `sbox-mcp-server@1.17.1`) so the addon/server pair can't silently drift. Keep the bridge **addon** at a matching `1.17.x` (`BridgeVersion` `1.17.1`) -- `get_bridge_status` warns if the server and addon versions diverge.
- The bridge addon and MCP server are major-version-compatible — a `1.x` addon works with a `1.x` MCP server. If you upgrade one, upgrade both.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `mcp__sbox__*` tools not available in Codex | Plugin not installed or session not reloaded | `/reload-plugins`, restart Codex |
| Bridge times out at 30s | s&box not running, or no project loaded | Open s&box with your project — the bridge runs on a **static** frame handler, so the dock does **not** need to be open (since v1.3.0) |
| `Couldn't add project` on s&box startup | Project has both a local-dev `Libraries/codexbridge/` AND an asset-library-installed `Libraries/sboxskinsgg.codexbridge/` claiming the same compiler name | Either set the local one's `Org` to `local`, or remove the asset-library copy. See `TROUBLESHOOTING.md` |
| `Unknown command: get_compile_errors` (or similar) | You're on an old MCP server with phantom tools | Upgrade: `npx sbox-mcp-server@latest` (or `/reload-plugins`) |
| Compile error in s&box editor that nothing in your `.cs` files explains | Hot-load cache is stuck | Touch the file and re-hotload, or restart s&box |

For deeper issues see the main repo's [TROUBLESHOOTING.md](https://github.com/LatterDay/Sbox-Codex/blob/main/TROUBLESHOOTING.md).

## License

AGPL-3.0-or-later. Same as the bridge. The code is open under AGPL, but the "s&box Codex Bridge" / "sboxskins.gg" name and branding may not be reused to pass a fork off as the original — see the repo's [NOTICE](https://github.com/LatterDay/Sbox-Codex/blob/main/NOTICE).

## Credits

Built by [sboxskins.gg](https://sboxskins.gg). The `sbox-api` skill is adapted from [codex-sbox](https://github.com/gavogavogavo/codex-sbox) by **David Ryan** (MIT). Bridge bootstrap-crash fix by [@FurkanZhlp](https://github.com/FurkanZhlp). Original bug reports by [@Jmcasavant](https://github.com/Jmcasavant) and [@dvd900](https://github.com/dvd900).

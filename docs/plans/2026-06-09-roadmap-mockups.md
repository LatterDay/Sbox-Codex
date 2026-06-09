# Roadmap Mockups — beyond the next 10 tools (2026-06-09)

Concrete mockups for the seven initiatives that sit *around* the handler grind: CI guard, semantic graph, Gravehold dogfood, genre kits, asset-library bridge, playtest harness, auto-update, distribution. Each section is build-ready: invocation, schema/file sketch, and acceptance check. Companion to `2026-06-09-next-10-tools.md` (the handler plan).

---

## 1. CI parity audit — `scripts/audit-parity.mjs` + GitHub Action

**What it guards:** the #1 release-mistake class — TS↔C# drift and version skew (seen live today: MCP server 1.8.0 running against addon 1.11.0).

**Script mockup** (`scripts/audit-parity.mjs`, node, zero deps):
```js
// 1. Parse server.tool("name") from sbox-mcp-server/src/**/*.ts
// 2. Parse Register( "name" ) from sbox-bridge-addon/Editor/MyEditorMenu.cs
// 3. Parse bridge.send("cmd") from TS
// FAIL if:
//   - duplicate tool/handler names on either side
//   - a bridge.send cmd has no C# handler (allowlist: get_bridge_status)
//   - a C# handler is never sent by any TS tool
//   - package.json version != plugin.json version != BridgeVersion const
//   - CHANGELOG top entry version != package.json version
// PASS prints the counts: "182 tools / 173 handlers / 0 orphans / versions aligned @1.11.0"
```

**Workflow mockup** (`.github/workflows/ci.yml`):
```yaml
name: ci
on: [push, pull_request]
jobs:
  build-and-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd sbox-mcp-server && npm ci && npm run build   # tsc must pass
      - run: node scripts/audit-parity.mjs                    # parity + version lock
      - run: pip install graphifyy && graphify update . --no-viz  # graph stays fresh (deterministic, no LLM)
      - run: git diff --exit-code --stat docs/graph/GRAPH_REPORT.md || echo "::warning::bridge map stale — run scripts/regen-graph.ps1"
```

**Acceptance:** push a branch with a deliberately unregistered handler → CI red. ~1 hour of work, permanent safety.

---

## 2. Semantic graphify pass — NO key needed (corrected)

**Correction to earlier notes:** the full doc-inclusive pass does **not** require a Gemini key. Per the graphify skill spec itself: *"If `GEMINI_API_KEY`/`GOOGLE_API_KEY` are unset, fall straight through to Claude subagent dispatch — the host session itself is the LLM."* Gemini is an optional offload, not a requirement. Any prompt for an API key is a misread of the skill.

**Sized today:** 88 markdown files, ~266k words, 0 semantic-cache hits → ~9 general-purpose subagents (~30k words each), one focused session.

**Flow mockup:**
```
1. AST pass (free, deterministic):       graphify update . --force        ← already done, 2026-06-09
2. Chunk the 88 .md files into ~9 chunks (cookbook refs, docs/, CLAUDE.md+README tier, plans/)
3. Dispatch 9 general-purpose subagents in parallel, each with the
   extraction-spec prompt → writes chunk_N.json (nodes/edges/hyperedges)
4. Merge chunks → .graphify_semantic_new.json → save_semantic_cache
   (future passes only re-extract CHANGED docs — incremental forever after)
5. Re-cluster + LLM community labels:    graphify cluster-only .
6. Copy artifacts → docs/graph/, commit
```

**What it buys:** real community labels (not "Community 81"), doc↔code edges (which cookbook recipe grounds which scaffold), and `graphify query "what should the loot table scaffold emit?"` answering from cookbook + handler graph together.

**Acceptance:** GRAPH_REPORT communities have names; `graphify query "save system"` returns both `CreateSaveSystemHandler` (once built) and the persistence cookbook ref in one traversal.

---

## 3. Gravehold dogfood — build the tycoon with our own toolchain

**Premise:** the toolchain now covers the tycoon system stack. Building Gravehold for real is the test no mining run can replace — every friction point becomes a tool/skill fix with a known reproduction.

**Phase mockup (each phase = one session, each ends with a screenshot-verified checkpoint):**

| Phase | Build | Bridge tools exercised |
|---|---|---|
| G1. Graveyard blockout | terrain, fog, gravestones via asset library, day-night lighting wired to `create_day_night_clock` | terrain tools, `scatter_props`, `set_fog`, `add_light`, scaffold attach |
| G2. Player + interaction | first-person player, `create_interactable` on graves/gates/shop | scaffold-game flow, new tool #1 |
| G3. Economy loop | wallet (have it) + dig/sell loop + shop vendor, prices from cookbook economy ref | `create_economy_wallet`, `invoke_method`, new loot table #2 |
| G4. Round/time pressure | night spawns via phase machine + NPC brains on patrol routes | `create_round_phase_machine`, NPC suite, navmesh |
| G5. Persistence + placement | save system #3 + placement mode #10 for buying/placing plots | new tools #3, #10 |
| G6. Polish + publish | HUD (leaderboard panel #4), validate, thumbnail, publish | `create_razor_ui`, publishing tools |

**Rule:** every friction → an issue tagged `dogfood` in the repo; 3+ repeats of a manual sequence → a tool candidate with grounding "Gravehold Gn".

**Acceptance per phase:** screenshot read by Claude + a human playtest note (gotcha #1 — the bridge can't feel the loop).

---

## 4. Genre starter kits — `scaffold_tycoon` and friends

**What:** one command composes existing scaffolds + scene authoring into a playable genre starter. The cookbook genre recipes are the specs; the kits are the recipes made executable.

**Shape decision (mirrors the v1.7.0 scaffold debate):** a **skill** orchestrating existing tools, not a mega-handler — keeps the C# surface small and lets each kit evolve in markdown.

**Mockup — `plugins/sbox-claude/skills/sbox-genre-kits/SKILL.md`:**
```
/sbox-genre-kit tycoon      → wallet + clock + phase machine + interactable shop
                              + placement mode + save system + floor/lighting blockout
/sbox-genre-kit survivor    → health + objective + pickup + loot table + spawner
                              + escalating phase machine (wave director)
/sbox-genre-kit social-hub  → interactable stations + economy + leaderboard panel
Each kit:
  1. checks bridge + lists which scaffolds it will generate (dry-run first)
  2. generates in dependency order, hotloads + compile-verifies after each
  3. authors the minimal scene (floor, light, player, camera) via existing tools
  4. screenshot → Claude reads it → fixes → human playtest checklist printed
```

**Dependency:** wants tools #1–#4 + #8–#10 from the 10-tool plan built first. Kits ship one at a time — tycoon first (Gravehold G1–G3 *is* the tycoon kit's shakedown).

**Acceptance:** fresh empty project → `/sbox-genre-kit tycoon` → press Play → walk, earn, spend, save. Under 10 minutes, zero manual code.

---

## 5. Asset library bridge — search → copy-with-deps → place

**What:** wire the local 57k-asset library (D:\sbox-asset-library, licensing-sensitive, stays personal/local) into a one-command pipeline.

**Tool mockups (2 new handlers + reuse of plan tool #5):**
```ts
// library_search — MCP-server-side, reads the library's index json
server.tool("library_search", "Search the local asset library by name/tag/category", {
  query: z.string(),
  category: z.string().optional(),   // model | material | sound
  limit: z.number().optional(),      // default 10
});
// returns: [{ name, path, category, tags, sizeKb, preview? }]

// library_install — composes copy_asset_with_dependencies (plan tool #5)
server.tool("library_install", "Copy a library asset + full dependency chain into the project, namespaced", {
  libraryPath: z.string(),           // from library_search
  targetDir: z.string().optional(),  // default "Assets/library/<category>/"
});
// refuses core-shadowing paths (gotcha #5), returns the in-project path
// → then existing spawn_model / assign_model places it
```

**Config:** `SBOX_ASSET_LIBRARY` env var on the MCP server (like `SBOX_LOG_PATH`); tools return a clear "library not configured" otherwise — the public repo ships the tools, not the library.

**Flow:** `library_search "gravestone"` → `library_install` → `spawn_model` → `screenshot_from`. Four calls, ERROR-mesh-proof.

**Acceptance:** a gravestone from the library standing in Gravehold G1 with correct materials, via exactly that flow.

---

## 6. Playtest harness — `run_playtest`

**What:** scripted partial-playtest: enter play mode, drive the player through steps, assert runtime state, capture screenshots at checkpoints, emit one pass/fail report. Makes gotcha #1's *partial* workaround repeatable instead of hand-rolled per session.

**Tool mockup:**
```ts
server.tool("run_playtest", "Scripted play-mode test: drive the player, assert state, capture checkpoints", {
  steps: z.array(z.object({
    action: z.enum(["move", "look", "press", "wait", "assert", "capture"]),
    // move: { direction|toPoint, durationMs } → drive_player
    // press: { inputAction, holdMs }          → drive_player held action
    // assert: { objectId|name, component, property, expect, op? }  // eq|gt|lt|contains
    // capture: { label }                       → screenshot_from player POV
    params: z.record(z.any()),
  })),
  stopOnFail: z.boolean().optional(),  // default true
  timeoutMs: z.number().optional(),    // whole-run cap, default 60000
});
```

**Report mockup (tool output):**
```json
{ "result": "FAIL", "steps": 7, "passed": 5,
  "failures": [{ "step": 6, "assert": "ShovelEquipped == true", "actual": "false",
                 "hint": "Input edge may not have registered — see BRIDGE_GOTCHAS #1" }],
  "captures": ["playtest_spawn.png", "playtest_grave.png"],
  "caveat": "Partial verification only — schedule a human playtest for feel/correctness." }
```

**Build notes:** C# side is a sequencer over the existing `DriveJob` infrastructure (drive_player already runs async across frames); asserts reuse `get_runtime_property`. The honest `caveat` field is mandatory — this never claims to replace a human.

**Acceptance:** a playtest that walks to a pickup, presses use, and asserts inventory count — passing on a working build, failing with the hint on a broken one.

---

## 7. Auto-update + version guard — `update_bridge`

**What:** kill the stale-version support burden (today's 1.8.0-vs-1.11.0 in one more form).

**Mockup:**
```ts
server.tool("update_bridge", "Update the in-project bridge addon to match this MCP server's version", {
  dryRun: z.boolean().optional(),  // default true: report what would change
});
// 1. get_bridge_status → compare bridgeVersion vs mcpServerVersion (already reported)
// 2. dryRun: print the diff summary + source (bundled addon payload in the npm package)
// 3. real run: back up Libraries/<bridge>/Editor/*.cs → copy bundled addon files in
//    → respond { updated: true, restartRequired: true }  (restart_editor offered next)
```
- npm package gains a `bundled-addon/` dir (the addon .cs files ship inside the server package — single source of truth, version-locked by the same publish).
- `get_bridge_status` already returns `versionsAligned: false` — the MCP server instruction block tells Claude to *offer* `update_bridge` whenever it sees that.

**Acceptance:** install old addon, run `update_bridge` (dry → real → restart) → status shows aligned versions.

---

## 8. Distribution (small, steady)

- **v1.11.0 blog post** — `docs/blog-v1.11.0.md`, same shape as the v1.9.0 one ("the director trio + the fully re-mined brain"). 1 session.
- **Demo GIF** — the genre-kit or Gravehold G1 flow, captured via `screenshot_orbit` frames; embed in README top. 1 session, after kit #1 works.
- **Docs site** — defer; README + INSTALL + TROUBLESHOOTING are already strong. Revisit when the marketplace listing needs a link.

---

## Order of operations (recommended)

```
Now      → 1. CI parity audit            (1 hr, protects everything after)
         → 2. Semantic graphify pass      (1 session, my tokens, no key)
Next     → 10-tool plan Waves 1–2         (docs/plans/2026-06-09-next-10-tools.md)
         → 3. Gravehold G1–G2             (dogfood starts as soon as interactable exists)
Then     → 5. Asset library bridge        (G1 wants it for set dressing)
         → 6. Playtest harness            (G2–G3 want it for loop checks)
         → 10-tool Wave 3 + 4. tycoon kit (kit = Gravehold learnings, productized)
Steady   → 7. update_bridge  → 8. blog/GIF
```

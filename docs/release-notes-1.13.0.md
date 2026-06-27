# s&box Codex Bridge v1.13.0 -- The 10-Tool Plan is Complete

**183 editor handlers. 192 tools total. Four system scaffolds, all verify-gated live.**

Back in June 2026 we laid out a no-fluff plan: ten tools, each justified by either multi-game corpus demand or a documented session-killer. Six shipped in v1.12.0. These are the last four. The 10-tool plan is complete.

---

## The New Tools

### `create_leaderboard_panel`

Drop a fully wired leaderboard UI into any game in one command.

Generates a `PanelComponent` `.razor` + `.razor.scss` pair bound to `Sandbox.Services.Leaderboards`. The panel fetches scores on open, respects a per-instance cooldown so you don't hammer the service on every re-render, overrides `BuildHash` correctly (so the panel actually re-draws when the data changes -- a common Razor gotcha), and casts the API's `long` rank to `int` for display.

This is the first scaffold that generates two files. Both pass the bridge's own `razor_lint` by construction -- no switch-expressions, no non-ASCII, no missing BuildHash.

The verify-gate caught one real API bug here: `Board.Refresh` requires a `CancellationToken` argument that was missing from the initial implementation. The docs didn't mention it. `describe_type` did. The gate caught it; a code review did not.

### `create_inventory`

The largest SYSTEMS entry in the 51-game corpus index (8 games independently built one) finally has a scaffold.

Generates a slot-based inventory component: parallel `ItemIds` and `Counts` lists, stack-first `TryAdd` that rolls back cleanly if the item won't fit, `TryRemove`/`CountOf`/`Move`/`Clear`, and a static `OnChanged` event for binding UI without polling.

The parallel-list shape is what the corpus converges on -- it serializes cleanly with `[Sync]` and avoids struct-in-list woes. One tool call instead of an afternoon.

### `create_stat_modifier_system`

The Set->Add->Mult stat engine that underpins the entire progression-upgrades slice of the corpus (8 games).

Generates a `{name}Stat` enum you extend, a modifier registry keyed by source object (so removing a perk removes exactly its modifiers and nothing else), priority resolution (Set wins, then additive sum, then multiplicative product), a single `GetStat(stat)` read point, and an `OnStatChanged` event. The shape that ss1 and ss2 both built independently, now one tool call. Buffs, equipment bonuses, upgrade tiers, and debuffs all compose through this one engine.

### `create_placement_mode`

The two-phase ghost-then-commit builder for tycoon, sandbox, and builder games.

Generates a client-local ghost object (`NetworkMode.Never`, tinted green/red for valid/invalid) that follows the mouse cursor via a `ScreenPixelToRay` camera ray, snaps to an optional grid, and shows client-side validity feedback. When the player commits, the host re-validates and either `NetworkSpawn`s the real object or rejects cleanly.

The verify-gate caught one real API bug here too: the sbox-cookbook's building-placement recipe referred to the positioning call as `GetMouseRay`. That method does not exist on this SDK. The real method is `ScreenPixelToRay`. The cookbook was wrong. `describe_type` was right. Reflection over folklore.

---

## Hardened

**Opus-assisted deep review** ran over the full codebase before this release. Three things were fixed:

**`create_networked_player` dead parameter.** The `moveSpeed` MCP parameter was accepted and documented, but never forwarded into the generated scaffold template. The player always spawned with the hardcoded default speed regardless of what you passed. Fixed: `moveSpeed` is now interpolated into the generated body.

**Atomic IPC response writes.** Response files (`res_*.json`) were written in-place. A fast MCP server poll on a slow machine could read a partial file and fail with a JSON parse error -- silent from the user's perspective (the request just timed out). Fixed: responses are now written to a `.tmp` path and atomically renamed, the same pattern the request side has used since v1.5.0.

**`get_all_properties` schema cleanup.** The `includeInherited` parameter appeared in the MCP schema and description but was unused in the handler -- all properties were always returned. Removed from the schema. Callers were passing it in good faith and getting no effect.

---

## The Verify-Gate Works

Four real bugs were caught this release before shipping, all by the generate->hotload->compile-check loop:

1. `Board.Refresh` requires a `CancellationToken` (not in the service docs; `describe_type` surfaces it)
2. `GetMouseRay` does not exist (`ScreenPixelToRay` is the real method; the cookbook had it wrong)
3. Inventory empty-string item ID needed four-quote escaping inside the `$@""` template
4. Leaderboard rank field is `long` from the API; the template was assigning it to an `int` display field

None of these were caught by code review. All were caught by the gate. This is why the build protocol is non-negotiable: `describe_type` first, generate, hotload, compile-check, TypeLibrary confirm. In that order, every time.

---

## Upgrade

**npm (bare MCP server):**
```
npx sbox-mcp-server@1.13.0
# or pin it:
codex mcp add sbox -- npx -y sbox-mcp-server@1.13.0
```

**Codex plugin:** update the plugin and reload. The bundled MCP server pin updates automatically.

**Editor addon:** republish `sboxskinsgg.codexbridge` from the Asset Library. The four new scaffold tools (`create_leaderboard_panel`, `create_inventory`, `create_stat_modifier_system`, `create_placement_mode`) and the atomic IPC + dead-param fixes require the updated addon. The schema cleanup (`get_all_properties`) is MCP-server-side only.

Update both halves to keep versions aligned -- `get_bridge_status` warns on a mismatch.

Restart s&box after updating the addon.

# s&box Codex Bridge v1.12.0 -- Six New Tools, a CI Gate, and a Whitelist Correction

**179 editor handlers. 188 tools total. Two waves of scaffold + lint + asset tools, all verify-gated live against the current SDK.**

This is a focused release: six tools that address specific, documented pain -- the ones with mined demand from the 51-game corpus or a gotcha in BRIDGE_GOTCHAS.md that was costing whole sessions. Plus the infrastructure to keep this ship tight as it grows: a CI parity gate, a C# syntax pre-check, and a correction to stale advice that has been misleading every s&box developer reading the docs.

---

## The New Tools

### `create_interactable` (Wave 1)

Scaffolds a `Component, Component.IPressable` stub -- the interaction primitive. `Press(Event)` host-validated action, `Look`/`Hover`/`Blur` prompt hooks, `CanPress` gate, `GetTooltip` text, `IsProxy` guard so only the owner fires the action.

Every genre recipe in the cookbook eventually needs a thing the player can walk up to and press. Shop vendors, pickups, doors, terminals, crafting stations -- they all reduce to this shape. It was the missing primitive between "scene exists" and "player can do something." Now it's one tool call. `IPressable` surface confirmed via `describe_type`; generated code compile-verified live.

### `create_weighted_loot_table` (Wave 1)

Scaffolds a loot-table component: parallel `Names`/`Weights` lists, cumulative-weight `Roll()`, optional pity counter via `PityAfter`. Host-authoritative. Static `OnLoot` event.

Seven games in the 51-game corpus independently hand-rolled the same cumulative-weight walk. Seven teams solved the same problem from scratch. This is the canonical implementation of that pattern -- the one the cookbook has been pointing at -- now emitted in one call. Compile-verified live.

### `sandbox_lint` (Wave 1)

Pre-compile static scan of `Code/*.cs` for API whitelist violations before hotload. Reports file and line number, with a suggested fix.

The problem: when s&box rejects a whitelisted call, the error surfaces with no file path and gets buried under the broken-reference cascade. You grep the log after the fact. This catches it before the compile, with a line number. It also lints the output of the scaffold generators themselves -- which shipped a `MathX` bug once.

See the whitelist correction note below. The lint table has been tuned to match the actual current SDK.

### `create_save_system` (Wave 2)

Scaffolds a versioned `PersistenceManager`: POCO DTO, `FileSystem.Data.WriteJson`/`ReadJsonOrDefault`, version field + delete-on-version-mismatch, dirty-flag debounced autosave, clamp-on-load `Sanitize()`, `IsProxy` guard so only the owner loads and saves.

The single most-demanded tool in the entire 51-game mining run -- 7 games independently requested it. Every persistent game needs it. The save-persistence corpus section (8 games) converges on exactly this shape. `BaseFileSystem.ReadJsonOrDefault<T>/WriteJson<T>` confirmed via `describe_type`; generated code compile-verified live.

### `razor_lint` (Wave 2)

Static scan of `.razor` and `.razor.scss` files for Razor transpiler footguns: switch-expressions in `@code` blocks (silent transpile failure), non-ASCII characters in `@code` (silent corruption), `PanelComponent` missing `BuildHash` (no re-render on data change), root type-selector SCSS rules (specificity bleed). Reports file and line with a plain-English fix.

The worst bug class in the bridge ecosystem: valid C#, opaque crash or silent no-op, `get_compile_errors` shows nothing. This is the direct sibling of `networking_lint` and `scene_validate` -- the same lint pattern that proved itself there, applied to the Razor layer.

### `copy_asset_with_dependencies` (Wave 2)

Copies a model or material into the project with its full dependency closure (`Editor.Asset.GetReferences(deep:true)`): every `.vmat`, every `.vtex`, recursively. Skips cloud/procedural/transient assets. Shadow-guards both the dependency paths and the destination directory against the core asset trees (`models/citizen`, `models/dev`, `materials/dev`, `materials/default`).

This tool kills two gotchas in one call. Gotcha #4: copying a model without its materials lands you an ERROR mesh with no warning. Gotcha #5: placing anything under a core asset path triggers an endless recompile loop that survives restarts. Both failures used to end with "restart and clean up by hand." Now the tool refuses the bad destination and carries the full dependency chain automatically.

---

## The Whitelist Correction -- Read This

`System.Math` and `System.MathF` **now compile** in s&box game code on the current SDK.

The old rule -- "use `MathX` only, `Math`/`MathF` are blocked" -- was correct for an earlier SDK. It has been stale for a while. `CODEX.md` and `docs/BRIDGE_GOTCHAS.md` have been corrected. `sandbox_lint` does not flag `Math`/`MathF` usage.

`Array.Clone()` **is still blocked.** Verified via deliberate live compile failure: "System.Array.Clone() is not allowed when whitelist is enabled." Use `.ToArray()`. `sandbox_lint` catches this with a line number and the fix.

If you have been writing `MathX.Clamp` out of habit, keep using it -- it is fine and preferred for s&box-specific helpers. But `Math.Abs`, `Math.Sqrt`, `MathF.PI`, etc. are now available without a wrapper.

---

## Under the Hood

**CI parity gate.** `scripts/audit-parity.mjs` is a zero-dependency Node script that checks: no duplicate `server.tool()` names in TS, no duplicate `Register()` handler names in C#, every `bridge.send()` command has a matching C# handler, every handler is referenced by at least one `bridge.send()`, and a 4-way version lock across `package.json`, `plugin.json`, `BridgeVersion` const, and the CHANGELOG first heading. `.github/workflows/ci.yml` runs it on every push and PR to `main`. The parity check is what caught several classes of "it builds but a tool silently does nothing" bugs in testing -- it now runs automatically.

**C# syntax gate.** `scripts/check-csharp-syntax.py` uses tree-sitter to parse every `.cs` file in the addon before syncing into a live s&box editor. Catches unbalanced braces, truncated files, and broken interpolated-string escaping -- the file states where the editor silently refuses to load the addon and you have no idea why. Known false positive: tree-sitter mis-flags the `$@`-template region in `CreateSaveSystemHandler` that Roslyn compiles correctly. Treat that one as advisory.

**Semantic bridge map rebuilt.** The `docs/graph/` knowledge graph was rebuilt from scratch using the graphify skill's Codex-subagent extraction path -- no API key required. Result: **3548 nodes / 4473 edges / 257 communities** with 50 human-named communities, up from the previous code/AST-only graph. Every tool maps to its C# handler and to the docs.

---

## Upgrade

**npm (bare MCP server):**
```
npx sbox-mcp-server@1.12.0
# or pin it:
codex mcp add sbox -- npx -y sbox-mcp-server@1.12.0
```

**Codex plugin:** update the plugin and reload. The bundled MCP server pin will update automatically.

**Editor addon:** republish `sboxskinsgg.codexbridge` from the Asset Library. The new tools (`create_interactable`, `create_weighted_loot_table`, `create_save_system`, `copy_asset_with_dependencies`) require the updated addon. The lint tools (`sandbox_lint`, `razor_lint`) are MCP-server-side and work without an addon update, but you should update both halves to keep versions aligned -- `get_bridge_status` warns on a mismatch.

Restart s&box after updating the addon.

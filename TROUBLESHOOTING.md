# Troubleshooting

Common failure modes and their fixes, ordered by how often each one hits.

## 1. "I had to install it twice before it worked"

**Cause:** An older version of `install.ps1` copied the addon into `<sbox>/addons/sbox-bridge-addon/`. s&box's global `addons/` folder is built-in only and will silently refuse to compile custom code. Nothing tells you it didn't install — the menu just never appears.

**Fix:** Run the current installer, which puts the bridge into your **project's** `Libraries/claudebridge/` folder:

```powershell
.\install.ps1 -RemoveStaleAddons         # also deletes the old broken install
```

```bash
./install.sh --remove-stale
```

If you don't trust the installer, do it by hand: copy `sbox-bridge-addon/claudebridge.sbproj` to `<your-project>/Libraries/claudebridge/claudebridge.sbproj`, and `sbox-bridge-addon/Editor/MyEditorMenu.cs` to `<your-project>/Libraries/claudebridge/Editor/MyEditorMenu.cs`.

---

## 2. `Error calling event 'tool.frame' on 'BridgePoller'` — spammed every frame

**What you're seeing:** The bridge's `[EditorEvent.Frame]` handler is throwing an exception, and s&box reports it for every single frame the dock is open (~60×/sec).

**What the message means:** Almost always, the *real* error happened during the bridge's startup (e.g. a handler constructor threw because of an SDK mismatch). The whole `ClaudeBridge` type then went into a permanently-failed state, and every subsequent frame access throws `TypeInitializationException`. The `tool.frame` message is the *wrapper*, not the *cause*.

**Fix (in 0.x.x and later):** The bridge now wraps `OnFrame` in a try/catch with deduplicated logging, so:
- The console no longer floods with the same message
- The real underlying exception is logged once per unique message
- Other handlers continue to work if just one is broken

**To find the root cause yourself:**

1. Open `<sbox>/logs/sbox-dev.log` (e.g. `A:\SteamLibrary\steamapps\common\sbox\logs\sbox-dev.log`).
2. Search for `[SboxBridge]` — you'll find the startup banner and any handler registration warnings.
3. Search for `Compile of 'local.<project>.editor' Failed:` — that's the most common true cause.
4. Search for `Failed to register '`... — a handler constructor threw; that tool will be unavailable but the rest of the bridge keeps working.

**If you're still on an old version:** Pull the latest from the repo and re-run the installer.

---

## 3. "Claude broke my project save"

**Cause:** Scene-mutating tool calls happening while play mode is active can corrupt the `.scene` file. The serializer assumes the editor isn't holding a transient scene state, and mutations from outside the normal editor flow can desync that assumption.

**Fix (in 0.x.x and later):** The bridge now refuses scene-mutating commands while `Game.IsPlaying` is true and returns a clear error:

```
'create_gameobject' is not allowed while play mode is active. Stop play first (stop_play) and try again.
```

Safe-during-play tools (read-only operations, `take_screenshot`, `is_playing`, `start_play`, `stop_play`, `set_runtime_property`, etc.) continue to work.

**To recover a corrupted save:**

1. Look in `<your-project>/.history/` — s&box keeps timestamped scene backups.
2. Restore the most recent `.scene` from there.
3. Use `git` if you have your project under version control (recommended).

**Belt-and-suspenders for production work:**

- Save before letting Claude run a batch of mutations.
- Commit your project to git regularly.
- Don't run scene-modifying tools while in play mode.

---

## 4. Bridge says "connected" but every tool times out at 30s

**Cause:** The `[EditorEvent.Frame]` handler in `BridgePoller` only fires while the dock widget is **visible** in the editor. If you close the dock — or s&box's window is minimized for long enough that Windows throttles frame events — the request queue piles up and never drains.

The `get_bridge_status` ping responds because it's served by a separate path (the heartbeat file). So you get the misleading "connected: true" result while nothing else works.

**Fix:** Bring up **View → Claude Bridge** in s&box. Drag the dock somewhere you won't accidentally close it. Keep the editor window visible (or at least not minimized).

**Verify:** Ask Claude `"check is_playing"`. It should respond in well under a second.

---

## 5. `claude mcp add sbox` succeeds, but Claude says no `sbox` tools exist

**Cause:** The MCP server process started but immediately exited. Common reasons:

- `dist/index.js` doesn't exist (you forgot to run `npm run build`).
- The path passed to `claude mcp add` was wrong or relative.
- Node.js is older than 18.

**Fix:**

```bash
cd sbox-claude/sbox-mcp-server
npm install
npm run build
ls dist/index.js                          # must exist
node -v                                   # must be 18.x or newer

# Re-register with an absolute path
claude mcp remove sbox
claude mcp add sbox -- node "/absolute/path/to/sbox-claude/sbox-mcp-server/dist/index.js"
```

---

## 6. `Compile of 'local.<project>.editor' Failed:`

**Cause:** The bridge's `Editor/claudebridge.editor.csproj` references s&box DLLs with absolute paths. If you copied a `.csproj` from another machine (or moved your s&box install to a different drive), those paths are broken.

**Fix:** Delete the stale `.csproj`. s&box will regenerate one with correct local paths on next launch.

```powershell
Remove-Item "<your-project>\Libraries\claudebridge\Editor\claudebridge.editor.csproj"
```

The installer now does this automatically.

---

## 7. `take_screenshot` ignores the `path` parameter

**Known quirk.** Screenshots are saved to s&box's own screenshots directory regardless of what you pass:

```
<sbox-install>/screenshots/sbox.<timestamp>.png
```

Read the most-recent file from there.

---

## 8. `mcp__sbox__create_material` errors with a dictionary key error

**Known bug** in the current `CreateMaterialHandler`. Workaround: write the `.vmat` file directly through `write_file` using KV1 syntax (curly blocks, no JSON-style colons/commas).

---

## 9. `set_property` rejects a `Color` value

**Cause:** Colors must be passed as a comma-separated string, not a JSON object.

**Wrong:**
```json
{ "value": { "r": 1, "g": 0, "b": 0, "a": 1 } }
```

**Right:**
```json
{ "value": "1, 0, 0, 1" }
```

---

## 10. Procedural mesh material renders chrome / sky-reflective

**Known limitation.** `MeshComponent.SetFaceMaterial(face, material)` and `MeshComponent.Color` tint do not visibly apply on a `PolygonMesh`. Workaround: place a `Ground` plane underneath as a visual fallback while the mesh still provides collision.

---

## Still stuck?

1. Capture the bridge log lines: search `sbox-dev.log` for `[SboxBridge]` and copy the matching block.
2. Capture the Claude Code error message (the full text of any tool failure).
3. Open an issue at https://github.com/lousputthole/sbox-claude/issues with both. The bridge's startup banner alone (`[SboxBridge] Bridge started — N handlers, IPC at ...`) is enough to confirm where it loaded from and how many tools registered.

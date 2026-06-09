using Editor;
using Sandbox;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

// ═══════════════════════════════════════════════════════════════════════════
// Input Actions — ensure_input_action
//
// Registers a custom NAMED INPUT ACTION (a verb like "interact", "sprint",
// "drop") in the project so generated game code can call
// Input.Pressed("interact") / Input.Down(...) and have it actually fire in
// play mode. Without this, a scaffolded game's custom verbs are dead keys.
//
// WHERE s&box STORES INPUT ACTIONS (verified against a shipped game's .sbproj —
// dhi.garryware — and Sandbox.Engine.xml):
//   <project>.sbproj  →  Metadata.InputSettings.Actions[]
//   each entry: { "Name", "KeyboardCode", "GamepadCode"?, "GroupName" }
//
// IMPORTANT engine semantics (Sandbox.Engine.Input XML doc):
//   "Games that don't define any input actions will get a bunch of default
//    actions given to them."
// → The default Forward/Back/Left/Right/Jump/Use/etc. set is ONLY injected
//   when the game defines NONE. The moment Metadata.InputSettings.Actions
//   exists, IT is the authoritative full list. So when the block is absent we
//   must SEED THE FULL DEFAULT SET before appending, or we'd silently strip
//   movement/use out from under the scaffolded player controller.
//
// This handler is UNSANDBOXED editor code (System.* / System.Text.Json.Nodes
// are fine). It edits the .sbproj JSON directly — the same proven disk-edit
// idiom as SetProjectConfigHandler in MyEditorMenu.cs — which sidesteps any
// ambiguity about ProjectConfig.SetMeta disk persistence / editor reload.
//
// It lives in the SAME assembly as MyEditorMenu.cs, so it implements the shared
// IBridgeHandler contract and returns `new { error = ... }` on failure (the
// dispatch envelope reports success=false via TryGetHandlerError).
//
// Registration line + the _sceneMutatingCommands addition are listed in the
// implementation summary — MyEditorMenu.cs owns those.
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>
/// Shared bits for the input-action handler. Internal to this file so it never
/// collides with helpers in MyEditorMenu.cs / ScaffoldHandlers.cs.
/// </summary>
internal static class InputActionHelpers
{
	// UTF-8 without BOM — the .sbproj is consumed by s&box's own JSON loader and
	// by tooling; matches the no-BOM rule used everywhere else in the bridge.
	public static readonly Encoding Utf8NoBom = new UTF8Encoding( false );

	/// <summary>
	/// The default action set s&box hands a project that defines none. We must
	/// re-create it verbatim before appending a custom action, otherwise writing
	/// an InputSettings block strips movement/use. Shape + codes match a shipped
	/// game's .sbproj (Name / KeyboardCode / GamepadCode / GroupName).
	/// </summary>
	public static JsonArray BuildDefaultActions()
	{
		// (Name, KeyboardCode, GamepadCode-or-null, GroupName)
		var defaults = new (string name, string kb, string pad, string group)[]
		{
			("Forward",    "W",     null,                    "Movement"),
			("Backward",   "S",     null,                    "Movement"),
			("Left",       "A",     null,                    "Movement"),
			("Right",      "D",     null,                    "Movement"),
			("Jump",       "space", "A",                     "Movement"),
			("Run",        "shift", "LeftJoystickButton",    "Movement"),
			("Walk",       "alt",   null,                    "Movement"),
			("Duck",       "ctrl",  "B",                     "Movement"),
			("attack1",    "mouse1","RightTrigger",          "Actions"),
			("attack2",    "mouse2","LeftTrigger",           "Actions"),
			("reload",     "r",     "X",                     "Actions"),
			("use",        "e",     "Y",                     "Actions"),
			("Voice",      "v",     "RightJoystickButton",   "Other"),
			("Drop",       "g",     "RightJoystickButton",   "Other"),
			("Flashlight", "f",     "DpadNorth",             "Other"),
			("Score",      "tab",   "SwitchLeftMenu",        "Other"),
			("Menu",       "Q",     "SwitchRightMenu",       "Other"),
			("Chat",       "enter", null,                    "Other"),
		};

		var arr = new JsonArray();
		foreach ( var d in defaults )
			arr.Add( MakeAction( d.name, d.kb, d.pad, d.group ) );
		return arr;
	}

	/// <summary>Build one action node in the on-disk shape (omits GamepadCode when null).</summary>
	public static JsonObject MakeAction( string name, string keyboardCode, string gamepadCode, string groupName )
	{
		var node = new JsonObject
		{
			["Name"] = name,
			["KeyboardCode"] = keyboardCode ?? "",
		};
		if ( !string.IsNullOrWhiteSpace( gamepadCode ) )
			node["GamepadCode"] = gamepadCode;
		node["GroupName"] = string.IsNullOrWhiteSpace( groupName ) ? "Actions" : groupName;
		return node;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// ensure_input_action — add a named input action to the project if missing.
//   params: { name (required), keyboardKey?, group? }
//   • idempotent: if an action with that Name already exists, report exists=true
//     and (optionally) update its key if `keyboardKey` differs and update=true.
//   • seeds the full default action set if the project has none, so movement/use
//     survive (engine only auto-injects defaults when NO actions are defined).
// ═══════════════════════════════════════════════════════════════════════════
public class EnsureInputActionHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			// ── name (required) ──────────────────────────────────────────
			var name = p.TryGetProperty( "name", out var n ) ? n.GetString() : null;
			if ( string.IsNullOrWhiteSpace( name ) )
				return Task.FromResult<object>( new { error = "name is required — the action verb game code will call, e.g. \"interact\" (Input.Pressed(\"interact\"))." } );
			name = name.Trim();

			var keyboardKey = p.TryGetProperty( "keyboardKey", out var kk ) && !string.IsNullOrWhiteSpace( kk.GetString() )
				? kk.GetString().Trim()
				: null;
			var group = p.TryGetProperty( "group", out var g ) && !string.IsNullOrWhiteSpace( g.GetString() )
				? g.GetString().Trim()
				: "Actions";
			bool update = p.TryGetProperty( "update", out var up ) && up.ValueKind == JsonValueKind.True;

			// ── locate the .sbproj ───────────────────────────────────────
			var rootPath = Project.Current?.GetRootPath();
			if ( string.IsNullOrEmpty( rootPath ) )
				return Task.FromResult<object>( new { error = "No current project (Project.Current is null)." } );

			var sbproj = Directory.GetFiles( rootPath, "*.sbproj", SearchOption.TopDirectoryOnly ).FirstOrDefault();
			if ( sbproj == null )
				return Task.FromResult<object>( new { error = ".sbproj file not found in project root" } );

			// ── parse ────────────────────────────────────────────────────
			var raw = File.ReadAllText( sbproj );
			JsonObject root;
			try { root = JsonNode.Parse( raw ) as JsonObject; }
			catch ( Exception ex ) { return Task.FromResult<object>( new { error = $"Could not parse .sbproj as JSON: {ex.Message}" } ); }
			if ( root == null )
				return Task.FromResult<object>( new { error = ".sbproj root is not a JSON object" } );

			// Metadata { ... }
			if ( root["Metadata"] is not JsonObject metadata )
			{
				metadata = new JsonObject();
				root["Metadata"] = metadata;
			}

			// Metadata.InputSettings { Actions: [...] }
			bool seededDefaults = false;
			if ( metadata["InputSettings"] is not JsonObject inputSettings )
			{
				inputSettings = new JsonObject();
				metadata["InputSettings"] = inputSettings;
			}

			if ( inputSettings["Actions"] is not JsonArray actions )
			{
				// No actions defined → the engine was injecting defaults. Re-create
				// the default set so we don't strip movement/use by writing a block.
				actions = InputActionHelpers.BuildDefaultActions();
				inputSettings["Actions"] = actions;
				seededDefaults = true;
			}

			// ── already present? (case-insensitive on Name) ──────────────
			JsonObject existing = actions
				.OfType<JsonObject>()
				.FirstOrDefault( a => string.Equals( a["Name"]?.GetValue<string>(), name, StringComparison.OrdinalIgnoreCase ) );

			if ( existing != null )
			{
				bool changed = seededDefaults; // seeding defaults is itself a disk change worth saving
				string priorKey = existing["KeyboardCode"]?.GetValue<string>();

				if ( update && keyboardKey != null && !string.Equals( priorKey, keyboardKey, StringComparison.Ordinal ) )
				{
					existing["KeyboardCode"] = keyboardKey;
					changed = true;
				}

				if ( changed )
					File.WriteAllText( sbproj, Serialize( root ), InputActionHelpers.Utf8NoBom );

				return Task.FromResult<object>( new
				{
					ensured = true,
					exists = true,
					updated = update && changed && keyboardKey != null,
					seededDefaults,
					name,
					keyboardKey = existing["KeyboardCode"]?.GetValue<string>(),
					group = existing["GroupName"]?.GetValue<string>(),
					actionCount = actions.Count,
					note = "Action already defined. " + RestartNote()
				} );
			}

			// ── append the new action ────────────────────────────────────
			actions.Add( InputActionHelpers.MakeAction( name, keyboardKey, null, group ) );
			File.WriteAllText( sbproj, Serialize( root ), InputActionHelpers.Utf8NoBom );

			return Task.FromResult<object>( new
			{
				ensured = true,
				exists = false,
				added = true,
				seededDefaults,
				name,
				keyboardKey = keyboardKey ?? "",
				group,
				actionCount = actions.Count,
				note = (keyboardKey == null
					? $"Added input action '{name}' with no key bound — set a default key by passing keyboardKey, or let the player bind it. "
					: $"Added input action '{name}' bound to '{keyboardKey}'. ")
					+ "Call it from game code with Input.Pressed(\"" + name + "\") / Input.Down(...). "
					+ RestartNote()
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"ensure_input_action failed: {ex.Message}" } );
		}
	}

	// .sbproj is written with two-space indentation (matches the engine's own
	// serializer) so diffs stay clean.
	static string Serialize( JsonObject root )
		=> root.ToJsonString( new JsonSerializerOptions { WriteIndented = true } );

	static string RestartNote()
		=> "Input config is read at project load — restart the editor (restart_editor) or reload the project for a new/changed action to take effect in play mode.";
}

using Editor;
using Sandbox;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

// ═══════════════════════════════════════════════════════════════════════════
// Playable Game Scaffolds — Phase 1
//
// This file lives in the SAME assembly as MyEditorMenu.cs, so it reuses the
// shared helpers on the `ClaudeBridge` static class (TryResolveProjectPath,
// SanitizeIdentifier, ParseVector3, ParseRotation, SerializeGo) and the
// IBridgeHandler dispatch contract. Handler code here is UNSANDBOXED editor
// code (System.* is fine).
//
// IMPORTANT — the C# *strings these handlers WRITE TO DISK* are SANDBOXED game
// code. That generated code must obey the s&box sandbox rules:
//   • use MathX, never System.Math / System.MathF
//   • guard networking with IsProxy / try-catch (Networking.IsHost can throw)
//   • model shape on CreateGameManager / CreateTriggerZone, which compile today
//
// All handlers are guarded in try/catch and return `new { error = ... }` on
// failure so the dispatch envelope reports success=false (see
// ClaudeBridge.ProcessRequest / TryGetHandlerError in MyEditorMenu.cs).
//
// Registration lines + the _sceneMutatingCommands additions are listed in the
// implementation summary — MyEditorMenu.cs owns those (this file is not edited
// into the Register() block here to keep the two files decoupled).
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>
/// Shared helpers for the scaffold handlers. Kept internal to this file so it
/// doesn't collide with anything in MyEditorMenu.cs. Mirrors the property
/// coercion used by AddComponentWithPropertiesHandler / SetPropertyHandler.
/// </summary>
internal static class ScaffoldHelpers
{
	/// <summary>
	/// Resolve a component on a GameObject by its short type name (case-insensitive).
	/// Mirrors the lookup used across MyEditorMenu.cs handlers.
	/// </summary>
	public static Component FindComponent( GameObject go, string typeName )
	{
		if ( go == null ) return null;
		if ( string.IsNullOrEmpty( typeName ) )
			return go.Components.GetAll().FirstOrDefault();

		return go.Components.GetAll()
			.FirstOrDefault( c => c.GetType().Name.Equals( typeName, StringComparison.OrdinalIgnoreCase ) );
	}

	/// <summary>
	/// Apply a {name: value} JSON object of property overrides to a freshly created
	/// component. Best-effort per property (matches AddComponentWithPropertiesHandler):
	/// a bad single value never aborts the whole apply. Returns the names that were set.
	/// </summary>
	public static List<string> ApplyProperties( Component component, TypeDescription typeDesc, JsonElement props )
	{
		var applied = new List<string>();
		if ( props.ValueKind != JsonValueKind.Object ) return applied;

		foreach ( var prop in props.EnumerateObject() )
		{
			try
			{
				var pd = typeDesc.Properties.FirstOrDefault( pp => pp.Name == prop.Name );
				if ( pd == null ) continue;

				// Normalize the JSON token to a string, then route through the shared
				// type-aware coercion (ClaudeBridge.CoercePropertyAndSet). This fixes the
				// same reference/asset gap as set_property: a Model/Material/GameObject/
				// Component property used to receive a raw string and silently stayed null.
				// Now they're loaded/resolved to the right typed value so they persist.
				// Numbers/bools/value-type strings keep working. Best-effort per property.
				string valStr = prop.Value.ValueKind switch
				{
					JsonValueKind.String => prop.Value.GetString(),
					JsonValueKind.True   => "true",
					JsonValueKind.False  => "false",
					JsonValueKind.Null   => "null",
					_                    => prop.Value.GetRawText()
				};

				if ( ClaudeBridge.CoercePropertyAndSet( pd.PropertyType, v => pd.SetValue( component, v ), pd.Name, valStr, out _ ) )
					applied.Add( prop.Name );
			}
			catch { /* best-effort, same as AddComponentWithPropertiesHandler */ }
		}
		return applied;
	}

	/// <summary>Read a JSON token as a float — accepts a JSON number OR a numeric string.</summary>
	static float CoerceFloat( JsonElement v )
	{
		if ( v.ValueKind == JsonValueKind.Number && v.TryGetSingle( out var f ) ) return f;
		if ( v.ValueKind == JsonValueKind.String
		     && float.TryParse( v.GetString(), System.Globalization.NumberStyles.Float,
		                        System.Globalization.CultureInfo.InvariantCulture, out var fs ) ) return fs;
		return float.Parse( v.ToString(), System.Globalization.CultureInfo.InvariantCulture );
	}

	/// <summary>Read a JSON token as an int — accepts a JSON number OR a numeric string.</summary>
	static int CoerceInt( JsonElement v )
	{
		if ( v.ValueKind == JsonValueKind.Number && v.TryGetInt32( out var i ) ) return i;
		if ( v.ValueKind == JsonValueKind.String && int.TryParse( v.GetString(), out var iss ) ) return iss;
		// Tolerate a float-shaped number/string for an int property (e.g. 2.0 -> 2).
		return (int) CoerceFloat( v );
	}

	/// <summary>Read a JSON token as a bool — accepts true/false tokens OR a "true"/"false" string.</summary>
	static bool CoerceBool( JsonElement v )
	{
		if ( v.ValueKind == JsonValueKind.True ) return true;
		if ( v.ValueKind == JsonValueKind.False ) return false;
		if ( v.ValueKind == JsonValueKind.String && bool.TryParse( v.GetString(), out var b ) ) return b;
		return false;
	}

	/// <summary>
	/// Standard "generate a .cs file" preamble shared by the system-scaffold
	/// handlers: derive file name + class name, resolve + containment-check the
	/// path, refuse if the file already exists. Returns false with an `error`
	/// object on any failure.
	/// </summary>
	public static bool PrepareCodeFile(
		JsonElement p, string defaultName, out string fullPath, out string relPath,
		out string className, out object error )
	{
		fullPath = null; relPath = null; className = null; error = null;

		var name      = p.TryGetProperty( "name",      out var n ) && !string.IsNullOrWhiteSpace( n.GetString() ) ? n.GetString() : defaultName;
		var directory = p.TryGetProperty( "directory", out var d ) && !string.IsNullOrWhiteSpace( d.GetString() ) ? d.GetString() : "Code";

		var fileName = name.EndsWith( ".cs" ) ? name : $"{name}.cs";
		if ( !ClaudeBridge.TryResolveProjectPath( Path.Combine( directory, fileName ), out fullPath, out var pathErr ) )
		{
			error = new { error = pathErr };
			return false;
		}

		if ( File.Exists( fullPath ) )
		{
			error = new { error = $"File already exists: {directory}/{fileName}. Choose a different name." };
			return false;
		}

		Directory.CreateDirectory( Path.GetDirectoryName( fullPath ) );
		className = ClaudeBridge.SanitizeIdentifier( Path.GetFileNameWithoutExtension( fileName ) );
		relPath = $"{directory}/{fileName}";
		return true;
	}

	/// <summary>UTF-8 without BOM — generated game code is read by the s&box compiler.</summary>
	public static readonly Encoding Utf8NoBom = new UTF8Encoding( false );

	public static void WriteCode( string fullPath, string code )
	{
		File.WriteAllText( fullPath, code, Utf8NoBom );
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// B. set_component_reference — wire a component property to a LIVE scene
//    GameObject (or a component on it) by GUID. The highest-value gap:
//    today set_property only does primitives and set_prefab_ref only assigns a
//    PREFAB asset's GameObject. This assigns a scene object.
//    Mirrors SetPrefabRefHandler's reflection (Game.TypeLibrary.GetType →
//    Properties → propDesc.SetValue) but the value is a scene object.
// ═══════════════════════════════════════════════════════════════════════════
public class SetComponentReferenceHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			var scene = SceneEditorSession.Active?.Scene;
			if ( scene == null )
				return Task.FromResult<object>( new { error = "No active scene" } );

			// The GameObject that holds the component we're writing into.
			var id = p.GetProperty( "id" ).GetString();
			if ( !Guid.TryParse( id, out var guid ) )
				return Task.FromResult<object>( new { error = "Invalid GUID (id)" } );

			var go = scene.Directory.FindByGuid( guid );
			if ( go == null )
				return Task.FromResult<object>( new { error = $"GameObject not found: {id}" } );

			var componentType = p.GetProperty( "component" ).GetString();
			var propertyName  = p.GetProperty( "property" ).GetString();

			var component = ScaffoldHelpers.FindComponent( go, componentType );
			if ( component == null )
				return Task.FromResult<object>( new { error = $"Component not found on object: {componentType}" } );

			var typeDesc = Game.TypeLibrary.GetType( component.GetType().Name );
			var propDesc = typeDesc?.Properties.FirstOrDefault( pp => pp.Name == propertyName );
			if ( propDesc == null )
				return Task.FromResult<object>( new { error = $"Property not found: {propertyName} on {componentType}" } );

			var propType = propDesc.PropertyType;
			if ( propType == null )
				return Task.FromResult<object>( new { error = $"Could not resolve the type of property {propertyName}" } );

			// Clear the reference (set null) when asked.
			if ( p.TryGetProperty( "clear", out var clr ) && clr.ValueKind == JsonValueKind.True )
			{
				propDesc.SetValue( component, null );
				return Task.FromResult<object>( new { set = true, cleared = true, id, component = componentType, property = propertyName } );
			}

			// Resolve the target GameObject by GUID.
			if ( !p.TryGetProperty( "targetId", out var tid ) || tid.ValueKind != JsonValueKind.String )
				return Task.FromResult<object>( new { error = "targetId is required (the GUID of the GameObject to reference), unless clear=true" } );

			if ( !Guid.TryParse( tid.GetString(), out var targetGuid ) )
				return Task.FromResult<object>( new { error = "Invalid GUID (targetId)" } );

			var targetGo = scene.Directory.FindByGuid( targetGuid );
			if ( targetGo == null )
				return Task.FromResult<object>( new { error = $"Target GameObject not found: {tid.GetString()}" } );

			// Two assignable shapes:
			//   1. property type is GameObject (or assignable from it) → assign the GO directly
			//   2. property type is a Component subtype → assign a component of that type off the GO
			bool wantsGameObject = propType == typeof( GameObject ) || propType.IsAssignableFrom( typeof( GameObject ) );
			bool wantsComponent  = typeof( Component ).IsAssignableFrom( propType );

			if ( wantsGameObject )
			{
				propDesc.SetValue( component, targetGo );
				return Task.FromResult<object>( new
				{
					set = true, id, component = componentType, property = propertyName,
					targetId = tid.GetString(), targetName = targetGo.Name, kind = "GameObject"
				} );
			}

			if ( wantsComponent )
			{
				// Optionally the caller named the exact component type to pull off the target.
				string targetComponentName = p.TryGetProperty( "targetComponent", out var tc ) ? tc.GetString() : null;

				Component targetComp = targetGo.Components.GetAll().FirstOrDefault( c =>
					( string.IsNullOrEmpty( targetComponentName )
						? propType.IsAssignableFrom( c.GetType() )
						: c.GetType().Name.Equals( targetComponentName, StringComparison.OrdinalIgnoreCase ) )
					&& propType.IsAssignableFrom( c.GetType() ) );

				if ( targetComp == null )
					return Task.FromResult<object>( new
					{
						error = $"Target object '{targetGo.Name}' has no component assignable to property type '{propType.Name}'" +
						        ( string.IsNullOrEmpty( targetComponentName ) ? "" : $" matching '{targetComponentName}'" )
					} );

				propDesc.SetValue( component, targetComp );
				return Task.FromResult<object>( new
				{
					set = true, id, component = componentType, property = propertyName,
					targetId = tid.GetString(), targetName = targetGo.Name,
					targetComponent = targetComp.GetType().Name, kind = "Component"
				} );
			}

			return Task.FromResult<object>( new
			{
				error = $"Property '{propertyName}' has type '{propType.Name}', which is neither a GameObject nor a Component. " +
				        "set_component_reference only wires object/component references; use set_property for primitives."
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"set_component_reference failed: {ex.Message}" } );
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// C. add_component_to_new_object — atomic create-GO + add-component +
//    set-props (+ optional parent/transform/tags) in one round-trip.
//    Combines CreateGameObjectHandler + AddComponentWithPropertiesHandler.
// ═══════════════════════════════════════════════════════════════════════════
public class AddComponentToNewObjectHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			var scene = SceneEditorSession.Active?.Scene;
			if ( scene == null )
				return Task.FromResult<object>( new { error = "No active scene" } );

			var typeName = p.GetProperty( "component" ).GetString();
			var typeDesc = Game.TypeLibrary.GetType( typeName );
			if ( typeDesc == null )
				return Task.FromResult<object>( new { error = $"Component type not found: {typeName}. (A freshly generated component is only in the TypeLibrary after a hotload — generate + trigger_hotload first, then place.)" } );

			var go = scene.CreateObject( true );
			go.Name = p.TryGetProperty( "name", out var n ) && !string.IsNullOrWhiteSpace( n.GetString() )
				? n.GetString()
				: typeName;

			if ( p.TryGetProperty( "position", out var pos ) )
				go.WorldPosition = ClaudeBridge.ParseVector3( pos );
			if ( p.TryGetProperty( "rotation", out var rot ) )
				go.WorldRotation = ClaudeBridge.ParseRotation( rot );
			if ( p.TryGetProperty( "scale", out var scl ) )
				go.WorldScale = ClaudeBridge.ParseVector3( scl );

			if ( p.TryGetProperty( "parentId", out var pid ) && pid.ValueKind == JsonValueKind.String
				&& Guid.TryParse( pid.GetString(), out var parentGuid ) )
			{
				var parent = scene.Directory.FindByGuid( parentGuid );
				if ( parent != null )
					go.SetParent( parent, keepWorldPosition: true );
			}

			if ( p.TryGetProperty( "tags", out var tags ) && tags.ValueKind == JsonValueKind.Array )
			{
				foreach ( var tag in tags.EnumerateArray() )
				{
					var t = tag.GetString();
					if ( !string.IsNullOrWhiteSpace( t ) ) go.Tags.Add( t );
				}
			}

			var component = go.Components.Create( typeDesc );
			if ( component == null )
				return Task.FromResult<object>( new { error = $"Failed to create component instance: {typeName}" } );

			List<string> appliedProps = new();
			if ( p.TryGetProperty( "properties", out var props ) )
				appliedProps = ScaffoldHelpers.ApplyProperties( component, typeDesc, props );

			return Task.FromResult<object>( new
			{
				created = true,
				component = typeName,
				appliedProperties = appliedProps,
				gameObject = ClaudeBridge.SerializeGo( go )
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"add_component_to_new_object failed: {ex.Message}" } );
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// E. create_objective_system — the win/lose primitive (ObjectiveManager).
//    Writes a self-contained Component singleton. Optionally places it on a
//    scene GameObject (only if the type is already in the TypeLibrary, i.e.
//    after a hotload — same constraint as add_component_to_new_object).
// ═══════════════════════════════════════════════════════════════════════════
public class CreateObjectiveSystemHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !ScaffoldHelpers.PrepareCodeFile( p, "ObjectiveManager", out var fullPath, out var relPath, out var className, out var err ) )
				return Task.FromResult<object>( err );

			var objective = p.TryGetProperty( "objective", out var ob ) ? ob.GetString() : "reach_goal";
			var loseOn    = p.TryGetProperty( "loseOn",    out var lo ) ? lo.GetString() : "fall";
			int targetCount = p.TryGetProperty( "targetCount", out var tcv ) && tcv.TryGetInt32( out var tci ) ? tci : 3;
			float timeLimit = p.TryGetProperty( "timeLimit",   out var tlv ) && tlv.TryGetSingle( out var tlf ) ? tlf : 60f;
			float killZ     = p.TryGetProperty( "killZ",       out var kzv ) && kzv.TryGetSingle( out var kzf ) ? kzf : -1000f;
			int lives       = p.TryGetProperty( "lives",       out var lvv ) && lvv.TryGetInt32( out var lvi ) ? lvi : 1;

			var code = BuildCode( className, objective, loseOn, targetCount, timeLimit, killZ, lives );
			ScaffoldHelpers.WriteCode( fullPath, code );

			object placed = MaybePlace( p, className, out var placeNote );

			return Task.FromResult<object>( new
			{
				created = true, path = relPath, className,
				gameObject = placed, note = placeNote
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"create_objective_system failed: {ex.Message}" } );
		}
	}

	// Placement only succeeds if the just-generated type is already in the
	// TypeLibrary (true only after a hotload). We surface a clear note so the
	// skill knows to hotload then place via add_component_to_new_object.
	static object MaybePlace( JsonElement p, string className, out string note )
	{
		note = null;
		bool place = !p.TryGetProperty( "placeInScene", out var pis ) || pis.ValueKind != JsonValueKind.False;
		if ( !place ) { note = "Not placed (placeInScene=false). Add it after hotload."; return null; }

		var scene = SceneEditorSession.Active?.Scene;
		if ( scene == null ) { note = "No active scene to place into."; return null; }

		var typeDesc = Game.TypeLibrary.GetType( className );
		if ( typeDesc == null )
		{
			note = $"Generated {className}.cs but it is not in the TypeLibrary yet — trigger_hotload, then place it with add_component_to_new_object (component=\"{className}\").";
			return null;
		}

		try
		{
			var go = scene.CreateObject( true );
			go.Name = className;
			go.Components.Create( typeDesc );
			return ClaudeBridge.SerializeGo( go );
		}
		catch ( Exception ex )
		{
			note = $"Generated {className}.cs; placement failed ({ex.Message}). Place after hotload.";
			return null;
		}
	}

	static string BuildCode( string className, string objective, string loseOn, int targetCount, float timeLimit, float killZ, int lives )
	{
		// Sanitize objective/loseOn into a known set (defensive — they come from a tool schema enum).
		objective = objective?.ToLowerInvariant() switch
		{
			"collect_all" or "reach_goal" or "survive_time" or "eliminate_all" => objective.ToLowerInvariant(),
			_ => "reach_goal"
		};
		loseOn = loseOn?.ToLowerInvariant() switch
		{
			"fall" or "timer" or "lives" or "none" => loseOn.ToLowerInvariant(),
			_ => "fall"
		};

		// String-format invariant so floats never emit a comma decimal separator.
		string tc   = targetCount.ToString();
		string tl   = timeLimit.ToString( System.Globalization.CultureInfo.InvariantCulture ) + "f";
		string kz   = killZ.ToString( System.Globalization.CultureInfo.InvariantCulture ) + "f";
		string lv   = lives.ToString();

		return $@"using Sandbox;
using System;

/// <summary>
/// {className} — the win/lose brain for a scaffolded game. Drop ONE of these in
/// a scene; gameplay systems talk to it through {className}.Instance.
///
/// Objective: {objective}    Lose condition: {loseOn}
///
/// How other systems use it:
///   {className}.Instance?.RegisterPickup();   // a Pickup was collected
///   {className}.Instance?.RegisterKill();     // an enemy was eliminated
///   {className}.Instance?.ReachGoal();        // the player touched the goal trigger
/// Single-player safe; [Sync] keeps the score consistent if you network it later.
/// </summary>
public sealed class {className} : Component
{{
	// Singleton — systems find the manager without a scene reference.
	public static {className} Instance {{ get; private set; }}

	[Property] public string Objective {{ get; set; }} = ""{objective}"";
	[Property] public string LoseOn {{ get; set; }} = ""{loseOn}"";

	[Property] public int TargetCount {{ get; set; }} = {tc};
	[Property] public float TimeLimit {{ get; set; }} = {tl};
	[Property] public float KillZ {{ get; set; }} = {kz};
	[Property] public int Lives {{ get; set; }} = {lv};

	// The player the lose-on-fall check watches. Wire this with set_component_reference.
	[Property] public GameObject Player {{ get; set; }}

	// Live progress — synced so a HUD on any client reads the same numbers.
	[Sync] public int Progress {{ get; set; }}
	[Sync] public int LivesRemaining {{ get; set; }}
	[Sync] public bool IsWon {{ get; set; }}
	[Sync] public bool IsLost {{ get; set; }}

	// Fired once when the game ends. Hook a HUD / menu here.
	public Action OnWin {{ get; set; }}
	public Action OnLose {{ get; set; }}

	// TimeSince starts at 0 — fine here, we WANT the survive timer to begin at spawn.
	private TimeSince _sinceStart;

	protected override void OnStart()
	{{
		Instance = this;
		Progress = 0;
		LivesRemaining = Lives;
		IsWon = false;
		IsLost = false;
		_sinceStart = 0f;
	}}

	protected override void OnDestroy()
	{{
		if ( Instance == this ) Instance = null;
	}}

	protected override void OnUpdate()
	{{
		if ( IsWon || IsLost ) return;

		// ---- Lose conditions ----
		switch ( LoseOn )
		{{
			case ""fall"":
				if ( Player.IsValid() && Player.WorldPosition.z < KillZ )
					Lose();
				break;

			case ""timer"":
				if ( _sinceStart > TimeLimit )
					Lose();
				break;

			case ""lives"":
				if ( LivesRemaining <= 0 )
					Lose();
				break;
		}}

		// ---- Win-by-survival ----
		if ( Objective == ""survive_time"" && _sinceStart > TimeLimit )
			Win();
	}}

	/// <summary>A collectible was picked up; advances collect_all objectives.</summary>
	public void RegisterPickup()
	{{
		if ( IsWon || IsLost ) return;
		Progress++;
		if ( Objective == ""collect_all"" && Progress >= TargetCount )
			Win();
	}}

	/// <summary>An enemy was eliminated; advances eliminate_all objectives.</summary>
	public void RegisterKill()
	{{
		if ( IsWon || IsLost ) return;
		Progress++;
		if ( Objective == ""eliminate_all"" && Progress >= TargetCount )
			Win();
	}}

	/// <summary>The player reached the goal; wins reach_goal objectives.</summary>
	public void ReachGoal()
	{{
		if ( IsWon || IsLost ) return;
		if ( Objective == ""reach_goal"" )
			Win();
	}}

	/// <summary>Call when the player dies / takes fatal damage. Loses a life;
	/// loses the game if out of lives (only matters when LoseOn == ""lives"").</summary>
	public void LoseLife()
	{{
		if ( IsWon || IsLost ) return;
		LivesRemaining--;
		if ( LivesRemaining <= 0 )
			Lose();
	}}

	public void Win()
	{{
		if ( IsWon || IsLost ) return;
		IsWon = true;
		Log.Info( $""[{className}] YOU WIN — objective '{{Objective}}' complete."" );
		OnWin?.Invoke();
	}}

	public void Lose()
	{{
		if ( IsWon || IsLost ) return;
		IsLost = true;
		Log.Info( ""[{className}] GAME OVER."" );
		OnLose?.Invoke();
	}}
}}
";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// F. create_health_system — a Health component with damage/heal/death.
// ═══════════════════════════════════════════════════════════════════════════
public class CreateHealthSystemHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !ScaffoldHelpers.PrepareCodeFile( p, "Health", out var fullPath, out var relPath, out var className, out var err ) )
				return Task.FromResult<object>( err );

			float maxHealth = p.TryGetProperty( "maxHealth", out var mhv ) && mhv.TryGetSingle( out var mhf ) ? mhf : 100f;
			bool regen   = p.TryGetProperty( "regen",   out var rv ) && rv.ValueKind == JsonValueKind.True;
			bool respawn = p.TryGetProperty( "respawn", out var sv ) && sv.ValueKind == JsonValueKind.True;

			var code = BuildCode( className, maxHealth, regen, respawn );
			ScaffoldHelpers.WriteCode( fullPath, code );

			// Optional placement on an existing GameObject (the target must exist;
			// the Health type must be in the TypeLibrary, i.e. after a hotload).
			object placedOn = null; string note = null;
			if ( p.TryGetProperty( "targetId", out var tid ) && tid.ValueKind == JsonValueKind.String )
				placedOn = PlaceOnTarget( tid.GetString(), className, out note );

			return Task.FromResult<object>( new { created = true, path = relPath, className, placedOn, note } );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"create_health_system failed: {ex.Message}" } );
		}
	}

	static object PlaceOnTarget( string targetId, string className, out string note )
	{
		note = null;
		var scene = SceneEditorSession.Active?.Scene;
		if ( scene == null ) { note = "No active scene to place into."; return null; }
		if ( !Guid.TryParse( targetId, out var guid ) ) { note = "Invalid targetId GUID."; return null; }

		var go = scene.Directory.FindByGuid( guid );
		if ( go == null ) { note = $"Target GameObject not found: {targetId}"; return null; }

		var typeDesc = Game.TypeLibrary.GetType( className );
		if ( typeDesc == null )
		{
			note = $"Generated {className}.cs but it is not in the TypeLibrary yet — trigger_hotload, then add it with add_component_with_properties.";
			return null;
		}

		try
		{
			go.Components.Create( typeDesc );
			return ClaudeBridge.SerializeGo( go );
		}
		catch ( Exception ex ) { note = $"Placement failed ({ex.Message})."; return null; }
	}

	static string BuildCode( string className, float maxHealth, bool regen, bool respawn )
	{
		string mh = maxHealth.ToString( System.Globalization.CultureInfo.InvariantCulture ) + "f";

		// Optional regen block (uses MathX.Clamp — System.Math is unavailable in the sandbox).
		string regenFields = regen
			? @"
	[Property] public float RegenPerSecond { get; set; } = 5f;
	[Property] public float RegenDelay { get; set; } = 3f;
	private TimeSince _sinceDamage = 100f; // start high so regen isn't blocked at spawn"
			: "";

		string regenUpdate = regen
			? @"
		// Passive regeneration after a delay since the last hit.
		if ( !IsDead && _sinceDamage > RegenDelay && CurrentHealth < MaxHealth )
			CurrentHealth = MathX.Clamp( CurrentHealth + RegenPerSecond * Time.Delta, 0f, MaxHealth );"
			: "";

		string updateMethod = regen
			? $@"

	protected override void OnUpdate()
	{{{regenUpdate}
	}}"
			: "";

		string respawnFields = respawn
			? @"
	// Where to respawn. Wire this with set_component_reference (e.g. a spawn-point GameObject).
	[Property] public GameObject RespawnPoint { get; set; }"
			: "";

		// Death body: respawn-or-disable, and notify the objective manager if one exists.
		string deathBody = respawn
			? @"
		// Respawn at the spawn point if we have one, else just disable.
		if ( RespawnPoint.IsValid() )
		{
			WorldPosition = RespawnPoint.WorldPosition;
			CurrentHealth = MaxHealth;
			IsDead = false;
			ObjectiveManagerLoseLife();
			return;
		}
		GameObject.Enabled = false;
		ObjectiveManagerLoseLife();"
			: @"
		// No respawn configured — disable the object and tell the objective system.
		GameObject.Enabled = false;
		ObjectiveManagerLoseLife();";

		return $@"using Sandbox;
using System;

/// <summary>
/// {className} — hit points with damage, healing and death for any GameObject.
///
/// Usage from other code:
///   GetComponent<{className}>()?.TakeDamage( 25f );
///   GetComponent<{className}>()?.Heal( 10f );
/// Subscribe to OnDeath for custom death FX. [Sync] keeps health consistent in
/// multiplayer; single-player safe with no networking active.
/// </summary>
public sealed class {className} : Component
{{
	[Property] public float MaxHealth {{ get; set; }} = {mh};

	// [Sync] so all clients agree on the value; harmless offline.
	[Sync] public float CurrentHealth {{ get; set; }}
	[Sync] public bool IsDead {{ get; set; }}{regenFields}{respawnFields}

	// Fired once when health hits zero. Hook ragdoll / VFX / score here.
	public Action OnDeath {{ get; set; }}

	protected override void OnStart()
	{{
		CurrentHealth = MaxHealth;
		IsDead = false;
	}}{updateMethod}

	/// <summary>Apply damage. Host-authoritative when networking is active so a
	/// proxy can't fake a hit; always runs offline.</summary>
	public void TakeDamage( float amount, GameObject attacker = null )
	{{
		if ( IsDead || amount <= 0f ) return;

		// Only the owner/host mutates health when networked. IsProxy is false offline.
		if ( IsProxy ) return;
{( regen ? "\t\t_sinceDamage = 0f;\n" : "" )}		CurrentHealth = MathX.Clamp( CurrentHealth - amount, 0f, MaxHealth );

		if ( CurrentHealth <= 0f )
			Die();
	}}

	/// <summary>Restore health, clamped to MaxHealth.</summary>
	public void Heal( float amount )
	{{
		if ( IsDead || amount <= 0f ) return;
		if ( IsProxy ) return;
		CurrentHealth = MathX.Clamp( CurrentHealth + amount, 0f, MaxHealth );
	}}

	private void Die()
	{{
		if ( IsDead ) return;
		IsDead = true;
		Log.Info( $""[{className}] {{GameObject.Name}} died."" );
		OnDeath?.Invoke();
{deathBody}
	}}

	// Notify an ObjectiveManager if the project has one (loose coupling via reflection-free
	// static lookup would require knowing the type; instead we no-op safely if absent).
	private void ObjectiveManagerLoseLife()
	{{
		// If you scaffolded an ObjectiveManager, call its LoseLife() from your own
		// death handler, e.g.: ObjectiveManager.Instance?.LoseLife();
		// Left as a hook so {className} stays self-contained with no hard dependency.
	}}
}}
";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// G. create_pickup — a trigger-based collectible. Mirrors CreateTriggerZone's
//    Component.ITriggerListener pattern. Optionally builds a visible GO with a
//    SphereCollider(trigger) + ModelRenderer.
// ═══════════════════════════════════════════════════════════════════════════
public class CreatePickupHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !ScaffoldHelpers.PrepareCodeFile( p, "Pickup", out var fullPath, out var relPath, out var className, out var err ) )
				return Task.FromResult<object>( err );

			var action = p.TryGetProperty( "action", out var av ) ? av.GetString() : "score";
			float amount = p.TryGetProperty( "amount", out var amv ) && amv.TryGetSingle( out var amf ) ? amf : 1f;
			var filterTag = p.TryGetProperty( "filterTag", out var ftv ) && !string.IsNullOrWhiteSpace( ftv.GetString() ) ? ftv.GetString() : "player";

			var code = BuildCode( className, action, amount, filterTag );
			ScaffoldHelpers.WriteCode( fullPath, code );

			// Optional in-scene placement: build a GO with a trigger sphere + (model) +
			// the Pickup component (component only attaches if it's in the TypeLibrary post-hotload).
			object placed = null; string note = null;
			bool place = p.TryGetProperty( "placeInScene", out var pis ) && pis.ValueKind == JsonValueKind.True;
			if ( place )
				placed = BuildPickupObject( p, className, out note );

			return Task.FromResult<object>( new { created = true, path = relPath, className, gameObject = placed, note } );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"create_pickup failed: {ex.Message}" } );
		}
	}

	static object BuildPickupObject( JsonElement p, string className, out string note )
	{
		note = null;
		var scene = SceneEditorSession.Active?.Scene;
		if ( scene == null ) { note = "No active scene to place into."; return null; }

		var go = scene.CreateObject( true );
		go.Name = className;

		if ( p.TryGetProperty( "position", out var pos ) )
			go.WorldPosition = ClaudeBridge.ParseVector3( pos );

		// Trigger collider so OnTriggerEnter fires.
		try
		{
			var sphere = go.AddComponent<SphereCollider>();
			sphere.Radius = p.TryGetProperty( "radius", out var rv ) && rv.TryGetSingle( out var rf ) ? rf : 24f;
			sphere.IsTrigger = true;
		}
		catch ( Exception ex ) { note = $"SphereCollider add failed: {ex.Message}"; }

		// Optional visible model.
		if ( p.TryGetProperty( "model", out var mp ) && !string.IsNullOrWhiteSpace( mp.GetString() ) )
		{
			try
			{
				var model = Model.Load( mp.GetString() );
				if ( model != null )
				{
					var r = go.AddComponent<ModelRenderer>();
					r.Model = model;
				}
				else note = AppendNote( note, $"Model not found: {mp.GetString()} (cloud assets need install_asset)." );
			}
			catch ( Exception ex ) { note = AppendNote( note, $"Model load failed: {ex.Message}" ); }
		}

		// Attach the Pickup component if the freshly generated type is loaded.
		var typeDesc = Game.TypeLibrary.GetType( className );
		if ( typeDesc != null )
		{
			try { go.Components.Create( typeDesc ); }
			catch ( Exception ex ) { note = AppendNote( note, $"Component attach failed: {ex.Message}" ); }
		}
		else
		{
			note = AppendNote( note, $"Built the pickup object + trigger, but {className} is not in the TypeLibrary yet — trigger_hotload, then add_component_with_properties (component=\"{className}\") on this GameObject." );
		}

		return ClaudeBridge.SerializeGo( go );
	}

	static string AppendNote( string existing, string add )
		=> string.IsNullOrEmpty( existing ) ? add : existing + " " + add;

	static string BuildCode( string className, string action, float amount, string filterTag )
	{
		action = action?.ToLowerInvariant() switch
		{
			"score" or "heal" or "item" or "custom" => action.ToLowerInvariant(),
			_ => "score"
		};
		string amt = amount.ToString( System.Globalization.CultureInfo.InvariantCulture ) + "f";

		// Every action is SELF-CONTAINED and always compiles — no hard dependency on
		// a Health / Inventory / ObjectiveManager type that may not exist in the
		// project. The OnCollected event is the loose-coupling seam: the scaffold
		// skill wires it (e.g. to ObjectiveManager.Instance.RegisterPickup or
		// Health.Heal) after generation. The comment in each branch shows the
		// direct typed call if you DO have the companion system.
		string itemField = action == "item"
			? "\n\t[Property] public string ItemName { get; set; } = \"item\";"
			: "";

		string effect = action switch
		{
			"heal"   => $@"
		// Heal the collector if you also scaffolded a Health system:
		//   other.GameObject.GetComponent<Health>()?.Heal( Amount );
		Log.Info( $""[{className}] Healed {{other.GameObject.Name}} for {{Amount}}."" );",
			"item"   => $@"
		// Add to the collector's inventory if you also scaffolded an Inventory:
		//   other.GameObject.GetComponent<Inventory>()?.Add( ItemName );
		Log.Info( $""[{className}] {{other.GameObject.Name}} picked up '{{ItemName}}'."" );",
			"custom" => $@"
		// TODO: your custom effect here.
		Log.Info( $""[{className}] {{other.GameObject.Name}} collected a pickup."" );",
			_        => $@"
		// Score / objective progress. Wire OnCollected to ObjectiveManager.RegisterPickup
		// (the scaffold does this), or call it directly if you have the type:
		//   ObjectiveManager.Instance?.RegisterPickup();
		Log.Info( $""[{className}] {{other.GameObject.Name}} collected (+{{Amount}})."" );"
		};

		return $@"using Sandbox;
using System;

/// <summary>
/// {className} — a trigger-based collectible. Put it on a GameObject that has a
/// trigger Collider (e.g. a SphereCollider with IsTrigger=true). When a
/// GameObject tagged '{filterTag}' enters, it applies an effect and despawns.
///
/// Action: {action}. OnCollected fires for any listener (the scaffold wires it
/// to your objective/score system) — keeps {className} dependency-free.
/// </summary>
public sealed class {className} : Component, Component.ITriggerListener
{{
	[Property] public string FilterTag {{ get; set; }} = ""{filterTag}"";
	[Property] public float Amount {{ get; set; }} = {amt};
	[Property] public bool DestroyOnPickup {{ get; set; }} = true;{itemField}

	/// <summary>Raised when a matching object collects this. Hook score/objective here.</summary>
	public Action<GameObject> OnCollected {{ get; set; }}

	protected override void OnStart()
	{{
		// Ensure our collider is a trigger so OnTriggerEnter fires.
		var collider = GetComponent<Collider>();
		if ( collider != null ) collider.IsTrigger = true;
	}}

	public void OnTriggerEnter( Collider other )
	{{
		if ( other?.GameObject == null ) return;
		if ( !other.GameObject.Tags.Has( FilterTag ) ) return;
{effect}
		OnCollected?.Invoke( other.GameObject );

		if ( DestroyOnPickup )
			GameObject.Destroy();
	}}

	public void OnTriggerExit( Collider other ) {{ }}
}}
";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// H. create_economy_wallet — a host-authoritative currency component.
//    The #1 economy exploit is plain [Sync] money a client can author, so Money
//    here is [Sync(SyncFlags.FromHost)] (the Ten Laws of the cookbook). Add /
//    TrySpend / SetMoney / CanAfford + an OnMoneyChanged event. Mirrors the
//    CreateHealthSystem scaffold pattern. (Mined from 51 games — currency was the
//    most-requested scaffold with no existing tool; pairs with create_save_system
//    [v1.11.0] for persistence.)
// ═══════════════════════════════════════════════════════════════════════════
public class CreateEconomyWalletHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !ScaffoldHelpers.PrepareCodeFile( p, "Wallet", out var fullPath, out var relPath, out var className, out var err ) )
				return Task.FromResult<object>( err );

			long start = p.TryGetProperty( "startingMoney", out var smv ) && smv.TryGetInt64( out var sm ) ? sm : 0L;

			var code = BuildCode( className, start );
			ScaffoldHelpers.WriteCode( fullPath, code );

			// Optional placement on an existing GameObject (only if the type is already
			// in the TypeLibrary, i.e. after a hotload — same contract as create_health_system).
			object placedOn = null; string note = null;
			if ( p.TryGetProperty( "targetId", out var tid ) && tid.ValueKind == JsonValueKind.String )
				placedOn = PlaceOnTarget( tid.GetString(), className, out note );

			return Task.FromResult<object>( new { created = true, path = relPath, className, placedOn, note } );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"create_economy_wallet failed: {ex.Message}" } );
		}
	}

	static object PlaceOnTarget( string targetId, string className, out string note )
	{
		note = null;
		var scene = SceneEditorSession.Active?.Scene;
		if ( scene == null ) { note = "No active scene to place into."; return null; }
		if ( !Guid.TryParse( targetId, out var guid ) ) { note = "Invalid targetId GUID."; return null; }
		var go = scene.Directory.FindByGuid( guid );
		if ( go == null ) { note = $"Target GameObject not found: {targetId}"; return null; }
		var typeDesc = Game.TypeLibrary.GetType( className );
		if ( typeDesc == null )
		{
			note = $"Generated {className}.cs but it is not in the TypeLibrary yet — trigger_hotload, then add it with add_component_with_properties.";
			return null;
		}
		try { go.Components.Create( typeDesc ); return ClaudeBridge.SerializeGo( go ); }
		catch ( Exception ex ) { note = $"Placement failed ({ex.Message})."; return null; }
	}

	static string BuildCode( string className, long startingMoney )
	{
		return $@"using Sandbox;
using System;

/// <summary>
/// {className} — a host-authoritative currency wallet for any GameObject.
///
/// Money is [Sync(SyncFlags.FromHost)] so only the host writes it — a client can't
/// author their own balance (plain [Sync] money is the classic economy exploit).
/// Clients that want to spend should call a [Rpc.Host] on their own component that
/// re-validates and calls TrySpend host-side. Single-player safe (IsProxy is false
/// with no networking active).
///
/// Usage:
///   GetComponent<{className}>()?.AddMoney( 100 );
///   if ( GetComponent<{className}>().TrySpend( 50 ) ) {{ /* grant the thing */ }}
///   bool ok = GetComponent<{className}>().CanAfford( 50 );
/// Hook OnMoneyChanged to drive a HUD label.
/// </summary>
public sealed class {className} : Component
{{
	[Property] public long StartingMoney {{ get; set; }} = {startingMoney}L;

	// Host-authoritative balance.
	[Sync( SyncFlags.FromHost )] public long Money {{ get; set; }}

	// Fired (on the writing machine) whenever the balance changes — bind a HUD here.
	public Action<long> OnMoneyChanged {{ get; set; }}

	protected override void OnStart()
	{{
		if ( IsProxy ) return;            // only the authority seeds the balance
		Money = StartingMoney;
		OnMoneyChanged?.Invoke( Money );
	}}

	/// <summary>Add money (host-authoritative). Non-positive amounts are ignored.</summary>
	public void AddMoney( long amount )
	{{
		if ( IsProxy || amount <= 0 ) return;
		Money += amount;
		Changed();
	}}

	/// <summary>Spend if affordable; returns false and changes nothing if not.</summary>
	public bool TrySpend( long amount )
	{{
		if ( IsProxy || amount <= 0 ) return false;
		if ( Money < amount ) return false;
		Money -= amount;
		Changed();
		return true;
	}}

	/// <summary>Set the balance directly (host-authoritative), clamped to >= 0.</summary>
	public void SetMoney( long amount )
	{{
		if ( IsProxy ) return;
		Money = amount < 0 ? 0 : amount;
		Changed();
	}}

	public bool CanAfford( long amount ) => Money >= amount;

	private void Changed()
	{{
		if ( Money < 0 ) Money = 0;
		OnMoneyChanged?.Invoke( Money );
	}}
}}
";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// I. create_round_phase_machine — a host-authoritative round/phase machine.
//    [Sync(FromHost)] CurrentPhase cycled on a per-phase timer; a static
//    OnPhaseChanged event fires on every machine. The easy single-component
//    variant of the most-requested mined scaffold (round/match flow, day-night
//    cycles, match phases). Mined from despawn.murder / suspectra / minigolf / etc.
// ═══════════════════════════════════════════════════════════════════════════
public class CreateRoundPhaseMachineHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !ScaffoldHelpers.PrepareCodeFile( p, "GameDirector", out var fullPath, out var relPath, out var className, out var err ) )
				return Task.FromResult<object>( err );

			var phases = new System.Collections.Generic.List<string>();
			if ( p.TryGetProperty( "phases", out var ph ) && ph.ValueKind == JsonValueKind.Array )
			{
				foreach ( var e in ph.EnumerateArray() )
				{
					var s = e.ValueKind == JsonValueKind.String ? e.GetString() : null;
					if ( string.IsNullOrWhiteSpace( s ) ) continue;
					var id = ClaudeBridge.SanitizeIdentifier( s );
					if ( !string.IsNullOrEmpty( id ) && !phases.Contains( id ) ) phases.Add( id );
				}
			}
			if ( phases.Count == 0 ) { phases.Add( "Lobby" ); phases.Add( "Active" ); phases.Add( "Ended" ); }

			float dur = p.TryGetProperty( "duration", out var dv ) && dv.TryGetSingle( out var df ) ? df : 60f;
			bool loop = !( p.TryGetProperty( "loop", out var lv ) && lv.ValueKind == JsonValueKind.False );

			var code = BuildCode( className, phases, dur, loop );
			ScaffoldHelpers.WriteCode( fullPath, code );

			object placedOn = null; string note = null;
			if ( p.TryGetProperty( "targetId", out var tid ) && tid.ValueKind == JsonValueKind.String )
				placedOn = PlaceOnTarget( tid.GetString(), className, out note );

			return Task.FromResult<object>( new { created = true, path = relPath, className, phases = phases.ToArray(), placedOn, note } );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"create_round_phase_machine failed: {ex.Message}" } );
		}
	}

	static object PlaceOnTarget( string targetId, string className, out string note )
	{
		note = null;
		var scene = SceneEditorSession.Active?.Scene;
		if ( scene == null ) { note = "No active scene to place into."; return null; }
		if ( !Guid.TryParse( targetId, out var guid ) ) { note = "Invalid targetId GUID."; return null; }
		var go = scene.Directory.FindByGuid( guid );
		if ( go == null ) { note = $"Target GameObject not found: {targetId}"; return null; }
		var typeDesc = Game.TypeLibrary.GetType( className );
		if ( typeDesc == null )
		{
			note = $"Generated {className}.cs but it is not in the TypeLibrary yet — trigger_hotload, then add it with add_component_with_properties.";
			return null;
		}
		try { go.Components.Create( typeDesc ); return ClaudeBridge.SerializeGo( go ); }
		catch ( Exception ex ) { note = $"Placement failed ({ex.Message})."; return null; }
	}

	static string BuildCode( string className, System.Collections.Generic.List<string> phases, float dur, bool loop )
	{
		string d = dur.ToString( System.Globalization.CultureInfo.InvariantCulture ) + "f";
		string enumBody = string.Join( ", ", phases );
		string firstPhase = phases[0];

		string durationProps = "";
		foreach ( var ph in phases )
			durationProps += $"\n\t[Property] public float {ph}Duration {{ get; set; }} = {d};";

		string durationSwitch = "";
		foreach ( var ph in phases )
			durationSwitch += $"\n\t\t\tPhase.{ph} => {ph}Duration,";

		string nextSwitch = "";
		for ( int i = 0; i < phases.Count; i++ )
		{
			string nxt = ( i + 1 < phases.Count ) ? phases[i + 1] : ( loop ? phases[0] : phases[phases.Count - 1] );
			nextSwitch += $"\n\t\t\tPhase.{phases[i]} => Phase.{nxt},";
		}

		return $@"using Sandbox;
using System;

/// <summary>
/// {className} — a host-authoritative round / phase machine for any GameObject.
///
/// Cycles a [Sync(SyncFlags.FromHost)] CurrentPhase through your named phases on a
/// per-phase timer (host-only). Other systems react via the static OnPhaseChanged
/// event, which fires on EVERY machine when the phase replicates. Single-player safe.
///
/// Usage:
///   {className}.OnPhaseChanged += p => Log.Info( $""phase -> {{p}}"" );
///   GetComponent<{className}>()?.StartPhase( {className}.Phase.{firstPhase} );  // host-only jump
/// </summary>
public sealed class {className} : Component
{{
	public enum Phase {{ {enumBody} }}

	// Host-authoritative current phase + its countdown.
	[Sync( SyncFlags.FromHost )] public Phase CurrentPhase {{ get; set; }}
	[Sync( SyncFlags.FromHost )] public TimeUntil PhaseTimer {{ get; set; }}

	// Per-phase durations in seconds — tune in the inspector.{durationProps}

	[Property] public bool Loop {{ get; set; }} = {(loop ? "true" : "false")};

	// Fires on every machine when the phase changes (host writes it, all detect it). Hook game systems here.
	public static Action<Phase> OnPhaseChanged {{ get; set; }}

	private Phase _lastSeen;
	private bool _started;

	protected override void OnStart()
	{{
		if ( !IsProxy ) StartPhase( default );   // 'default' = the first phase
	}}

	protected override void OnUpdate()
	{{
		// Change-detect so OnPhaseChanged fires uniformly on host + proxies.
		if ( !_started || CurrentPhase != _lastSeen )
		{{
			_started = true;
			_lastSeen = CurrentPhase;
			OnPhaseChanged?.Invoke( CurrentPhase );
		}}

		if ( IsProxy ) return;
		if ( PhaseTimer <= 0f ) Advance();
	}}

	/// <summary>Host-only: jump to a phase and arm its timer.</summary>
	public void StartPhase( Phase phase )
	{{
		if ( IsProxy ) return;
		CurrentPhase = phase;
		PhaseTimer = DurationFor( phase );
	}}

	private void Advance()
	{{
		if ( IsProxy ) return;
		var next = NextPhase( CurrentPhase );
		if ( !Loop && next == CurrentPhase ) return;   // not looping: hold on the last phase
		CurrentPhase = next;
		PhaseTimer = DurationFor( CurrentPhase );
	}}

	private float DurationFor( Phase p ) => p switch
	{{{durationSwitch}
		_ => {d}
	}};

	private Phase NextPhase( Phase p ) => p switch
	{{{nextSwitch}
		_ => p
	}};
}}
";
	}
}

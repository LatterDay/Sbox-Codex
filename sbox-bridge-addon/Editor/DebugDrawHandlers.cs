using Editor;
using Sandbox;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

// ═══════════════════════════════════════════════════════════════════════════
// debug_draw_* / debug_clear — visualize debug primitives in the scene.
//
// Ported from the Claude Bridge for Unity's debug_draw_* family. s&box has no
// bridge debug-viz; this fills the gap so a raycast hit / physics_overlap
// volume / trigger_zone bounds / NPC sight cone / patrol path can be SEEN
// (and screenshot-verified) instead of reasoned about blind.
//
// ONE component, dual render path:
//   • EDIT scene → Gizmo.Draw.* inside ClaudeDebugDraw.DrawGizmos()
//   • PLAY scene → Game.ActiveScene.DebugOverlay.* re-emitted each OnUpdate()
// A single NotSaved holder GameObject ("__ClaudeDebugDraw") stores the prim
// list; the draw handlers append, debug_clear destroys it.
//
// APIs reflected live on this SDK (describe_type, 2026-06-18):
//   Gizmo.Draw: Line(a,b) · Arrow(from,to,len,width) · LineBBox(bbox) ·
//               LineSphere(Sphere,rings) · Color/LineThickness/IgnoreDepth
//   Scene.DebugOverlay (DebugOverlaySystem):
//               Line(from,to,color,dur,tx,overlay) · Box(BBox,color,dur,tx,overlay) ·
//               Sphere(Sphere,color,dur,tx,overlay)
//
// Must work WHILE playing → these are NOT added to _sceneMutatingCommands.
// ═══════════════════════════════════════════════════════════════════════════

public enum DebugDrawKind { Line, Ray, Box, Sphere }

public sealed class DebugDrawPrim
{
	public DebugDrawKind Kind;
	public Vector3 A;            // line/ray start · box/sphere center
	public Vector3 B;            // line/ray end
	public Vector3 Size;         // box full extents
	public float Radius;         // sphere
	public Color Color = Color.Yellow;
	public float Thickness = 2f;
}

/// <summary>
/// Holds bridge-issued debug primitives and renders them in both the editor
/// (DrawGizmos) and play mode (DebugOverlay). One per scene, NotSaved.
/// </summary>
public sealed class ClaudeDebugDraw : Component
{
	public List<DebugDrawPrim> Prims { get; set; } = new();

	protected override void DrawGizmos()
	{
		if ( Prims == null ) return;
		foreach ( var p in Prims )
		{
			Gizmo.Draw.Color = p.Color;
			Gizmo.Draw.LineThickness = p.Thickness;
			Gizmo.Draw.IgnoreDepth = true;
			switch ( p.Kind )
			{
				case DebugDrawKind.Line:   Gizmo.Draw.Line( p.A, p.B ); break;
				case DebugDrawKind.Ray:    Gizmo.Draw.Arrow( p.A, p.B, 8f, 3f ); break;
				case DebugDrawKind.Box:    Gizmo.Draw.LineBBox( new BBox( p.A - p.Size * 0.5f, p.A + p.Size * 0.5f ) ); break;
				case DebugDrawKind.Sphere: Gizmo.Draw.LineSphere( new Sphere( p.A, p.Radius ), 16 ); break;
			}
		}
	}

	protected override void OnUpdate()
	{
		if ( !Game.IsPlaying || Prims == null ) return;
		var ov = Scene?.DebugOverlay;
		if ( ov == null ) return;
		const float dur = 0.1f;                       // refreshed every frame while in the list
		var tx = global::Transform.Zero;               // identity → world-space coords (Transform is global-namespace, not Sandbox.*)
		foreach ( var p in Prims )
		{
			switch ( p.Kind )
			{
				case DebugDrawKind.Line:
				case DebugDrawKind.Ray:
					ov.Line( p.A, p.B, p.Color, dur, tx, true );
					break;
				case DebugDrawKind.Box:
					ov.Box( new BBox( p.A - p.Size * 0.5f, p.A + p.Size * 0.5f ), p.Color, dur, tx, true );
					break;
				case DebugDrawKind.Sphere:
					ov.Sphere( new Sphere( p.A, p.Radius ), p.Color, dur, tx, true );
					break;
			}
		}
	}
}

internal static class DebugDrawHelpers
{
	static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

	// ponytail: one global holder per session, recreated if invalidated by a
	// scene change / hotload. Debug viz is inherently global, so a single
	// instance is correct — no per-call scene scan needed.
	static ClaudeDebugDraw _holder;

	public static Scene CurrentScene()
		=> Game.IsPlaying ? Game.ActiveScene : SceneEditorSession.Active?.Scene;

	public static ClaudeDebugDraw EnsureHolder()
	{
		var scene = CurrentScene();
		if ( scene == null ) return null;
		if ( _holder.IsValid() && _holder.Scene == scene ) return _holder;
		var go = scene.CreateObject( true );
		go.Name = "__ClaudeDebugDraw";
		go.Flags = GameObjectFlags.NotSaved;
		_holder = go.AddComponent<ClaudeDebugDraw>();
		return _holder;
	}

	public static int ClearHolder()
	{
		int n = 0;
		// cached holder — reliable for the common same-scene case
		if ( _holder.IsValid() )
		{
			n += _holder.Prims?.Count ?? 0;
			_holder.GameObject?.Destroy();
		}
		// plus any holders orphaned by an edit↔play scene switch (the static ref
		// only tracks the most recent scene's holder)
		var scene = CurrentScene();
		if ( scene != null )
		{
			foreach ( var c in scene.GetAllComponents<ClaudeDebugDraw>().ToList() )
			{
				if ( c == _holder ) continue;
				n += c.Prims?.Count ?? 0;
				c.GameObject?.Destroy();
			}
		}
		_holder = null;
		return n;
	}

	public static bool TryVec( JsonElement p, string key, out Vector3 v )
	{
		v = Vector3.Zero;
		if ( !p.TryGetProperty( key, out var e ) ) return false;
		switch ( e.ValueKind )
		{
			case JsonValueKind.String:
				var s = e.GetString().Split( ',' );
				if ( s.Length < 3 ) return false;
				v = new Vector3( F( s[0] ), F( s[1] ), F( s[2] ) );
				return true;
			case JsonValueKind.Array:
				if ( e.GetArrayLength() < 3 ) return false;
				v = new Vector3( (float)e[0].GetDouble(), (float)e[1].GetDouble(), (float)e[2].GetDouble() );
				return true;
			case JsonValueKind.Object:
				v = new Vector3(
					(float)e.GetProperty( "x" ).GetDouble(),
					(float)e.GetProperty( "y" ).GetDouble(),
					(float)e.GetProperty( "z" ).GetDouble() );
				return true;
			default:
				return false;
		}
	}

	public static Color Col( JsonElement p, string key, Color def )
	{
		if ( !p.TryGetProperty( key, out var e ) || e.ValueKind != JsonValueKind.String ) return def;
		var s = e.GetString().Split( ',' );
		if ( s.Length < 3 ) return def;
		float a = s.Length >= 4 ? F( s[3] ) : 1f;
		return new Color( F( s[0] ), F( s[1] ), F( s[2] ), a );
	}

	public static float Flt( JsonElement p, string key, float def )
		=> p.TryGetProperty( key, out var e ) && e.ValueKind == JsonValueKind.Number ? (float)e.GetDouble() : def;

	static float F( string s ) => float.Parse( s.Trim(), Inv );
}

// ── handlers ────────────────────────────────────────────────────────────────

public class DebugDrawLineHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !DebugDrawHelpers.TryVec( p, "from", out var a ) || !DebugDrawHelpers.TryVec( p, "to", out var b ) )
				return Task.FromResult<object>( new { error = "from and to are required (\"x,y,z\")" } );
			var h = DebugDrawHelpers.EnsureHolder();
			if ( h == null ) return Task.FromResult<object>( new { error = "no active scene" } );
			h.Prims.Add( new DebugDrawPrim
			{
				Kind = DebugDrawKind.Line, A = a, B = b,
				Color = DebugDrawHelpers.Col( p, "color", Color.Yellow ),
				Thickness = DebugDrawHelpers.Flt( p, "thickness", 2f )
			} );
			return Task.FromResult<object>( new { drawn = "line", count = h.Prims.Count, mode = Game.IsPlaying ? "play" : "edit" } );
		}
		catch ( Exception ex ) { return Task.FromResult<object>( new { error = $"debug_draw_line failed: {ex.Message}" } ); }
	}
}

public class DebugDrawRayHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !DebugDrawHelpers.TryVec( p, "origin", out var o ) || !DebugDrawHelpers.TryVec( p, "direction", out var d ) )
				return Task.FromResult<object>( new { error = "origin and direction are required (\"x,y,z\")" } );
			float len = DebugDrawHelpers.Flt( p, "length", 64f );
			var h = DebugDrawHelpers.EnsureHolder();
			if ( h == null ) return Task.FromResult<object>( new { error = "no active scene" } );
			h.Prims.Add( new DebugDrawPrim
			{
				Kind = DebugDrawKind.Ray, A = o, B = o + d.Normal * len,
				Color = DebugDrawHelpers.Col( p, "color", Color.Yellow ),
				Thickness = DebugDrawHelpers.Flt( p, "thickness", 2f )
			} );
			return Task.FromResult<object>( new { drawn = "ray", count = h.Prims.Count, mode = Game.IsPlaying ? "play" : "edit" } );
		}
		catch ( Exception ex ) { return Task.FromResult<object>( new { error = $"debug_draw_ray failed: {ex.Message}" } ); }
	}
}

public class DebugDrawBoxHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !DebugDrawHelpers.TryVec( p, "center", out var c ) )
				return Task.FromResult<object>( new { error = "center is required (\"x,y,z\")" } );
			Vector3 size = DebugDrawHelpers.TryVec( p, "size", out var sz ) ? sz : new Vector3( 32f, 32f, 32f );
			var h = DebugDrawHelpers.EnsureHolder();
			if ( h == null ) return Task.FromResult<object>( new { error = "no active scene" } );
			h.Prims.Add( new DebugDrawPrim
			{
				Kind = DebugDrawKind.Box, A = c, Size = size,
				Color = DebugDrawHelpers.Col( p, "color", Color.Green ),
				Thickness = DebugDrawHelpers.Flt( p, "thickness", 2f )
			} );
			return Task.FromResult<object>( new { drawn = "box", count = h.Prims.Count, mode = Game.IsPlaying ? "play" : "edit" } );
		}
		catch ( Exception ex ) { return Task.FromResult<object>( new { error = $"debug_draw_box failed: {ex.Message}" } ); }
	}
}

public class DebugDrawSphereHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !DebugDrawHelpers.TryVec( p, "center", out var c ) )
				return Task.FromResult<object>( new { error = "center is required (\"x,y,z\")" } );
			float r = DebugDrawHelpers.Flt( p, "radius", 32f );
			var h = DebugDrawHelpers.EnsureHolder();
			if ( h == null ) return Task.FromResult<object>( new { error = "no active scene" } );
			h.Prims.Add( new DebugDrawPrim
			{
				Kind = DebugDrawKind.Sphere, A = c, Radius = r,
				Color = DebugDrawHelpers.Col( p, "color", Color.Red ),
				Thickness = DebugDrawHelpers.Flt( p, "thickness", 2f )
			} );
			return Task.FromResult<object>( new { drawn = "sphere", count = h.Prims.Count, mode = Game.IsPlaying ? "play" : "edit" } );
		}
		catch ( Exception ex ) { return Task.FromResult<object>( new { error = $"debug_draw_sphere failed: {ex.Message}" } ); }
	}
}

public class DebugClearHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			int removed = DebugDrawHelpers.ClearHolder();
			return Task.FromResult<object>( new { cleared = true, removed } );
		}
		catch ( Exception ex ) { return Task.FromResult<object>( new { error = $"debug_clear failed: {ex.Message}" } ); }
	}
}

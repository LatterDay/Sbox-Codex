using Editor;
using Sandbox;
using System;
using System.Text.Json;
using System.Threading.Tasks;

// ═══════════════════════════════════════════════════════════════════════════
// set_time_scale — set the running play scene's TimeScale.
//
// Ported from the Unity bridge's playtest_set_time_scale. 0 = pause,
// 1 = normal, 0.1 = slow-mo, 2+ = fast-forward.
//
// API is corpus-confirmed: Scene.TimeScale is a public settable float
// (sdoomresurrection Code/ui/Pause.cs: `Scene.TimeScale = 0f` / `= 1f`;
// ss1 Code/Manager.cs: animated ramps). Game.ActiveScene is the running play
// scene (CLAUDE.md "Verified s&box APIs").
//
// Targets Game.ActiveScene and REQUIRES play mode — the edit scene does not
// tick, so scaling it is meaningless. This is therefore NOT a scene-mutating
// command: it must be allowed WHILE Game.IsPlaying (adding it to
// _sceneMutatingCommands would get it refused exactly when it is needed).
//
// Registration (in MyEditorMenu.cs RegisterHandlers, play-mode group):
//   Register( "set_time_scale", () => new SetTimeScaleHandler() );
// Do NOT add to _sceneMutatingCommands.
//
// Lives in the same assembly as MyEditorMenu.cs (no namespace) so it sees the
// global IBridgeHandler contract. Unsandboxed editor code — System.* is fine.
//
// ⚠ Compile-verify live before shipping (editor was offline at authoring time):
//   sync to <project>/Libraries/claudebridge/Editor/, restart_editor (or
//   trigger_hotload), get_compile_errors, then start_play + set_time_scale 0.1
//   + capture_view to confirm slow-mo.
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>
/// set_time_scale — set Game.ActiveScene.TimeScale during play mode. Params:
///   scale : float multiplier (required; 0 = pause, 1 = normal). Clamped 0–100.
/// </summary>
public class SetTimeScaleHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			if ( !p.TryGetProperty( "scale", out var sEl ) || sEl.ValueKind != JsonValueKind.Number )
				return Task.FromResult<object>( new { error = "scale is required (a number; 0 = pause, 1 = normal, 0.1 = slow-mo)" } );

			float scale = (float)sEl.GetDouble();
			if ( scale < 0f ) scale = 0f;
			if ( scale > 100f ) scale = 100f;

			if ( !Game.IsPlaying )
				return Task.FromResult<object>( new { error = "set_time_scale only applies in play mode — call start_play first (the edit scene does not tick)" } );

			var scene = Game.ActiveScene;
			if ( scene == null )
				return Task.FromResult<object>( new { error = "No active play scene" } );

			float previous = scene.TimeScale;
			scene.TimeScale = scale;

			return Task.FromResult<object>( new
			{
				set = true,
				timeScale = scene.TimeScale,
				previous,
				paused = scale == 0f
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"set_time_scale failed: {ex.Message}" } );
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// get_profiler_stats — read live engine performance counters.
//
// Ported from the Unity bridge's get_profiler_stats. Reads
// Sandbox.Diagnostics.PerformanceStats. All members are corpus-confirmed
// (darkrpog Code/Diagnostics/RoleplayPerfDiagnostics.cs + RoleplayPerfFrameBurst.cs):
//   FrameTime (s), GpuFrametime (ms), GpuFrameNumber, BytesAllocated,
//   ApproximateProcessMemoryUsage, Exceptions, and Timings.{Update,Physics,Ui,
//   Render,Network,GcPause}.AverageMs(frames).
//
// Read-only → NOT scene-mutating. Most meaningful during play, but the editor
// renders frames too so the counters are populated in edit mode. Unsandboxed
// editor code, so System.Math is fine.
//
// Registration: Register( "get_profiler_stats", () => new GetProfilerStatsHandler() );
//
// ⚠ Compile-verify live before shipping (editor was offline at authoring time):
//   the exact PerformanceStats / Timings member names are corpus-grounded but
//   not reflected against this SDK — describe_type PerformanceStats if it fails.
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>
/// get_profiler_stats — dump Sandbox.Diagnostics.PerformanceStats. Params:
///   frames : averaging window for per-category timings (optional, default 60).
/// </summary>
public class GetProfilerStatsHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			int frames = 60;
			if ( p.TryGetProperty( "frames", out var fEl ) && fEl.ValueKind == JsonValueKind.Number )
				frames = Math.Clamp( fEl.GetInt32(), 1, 1000 );

			double frameTimeSec = Sandbox.Diagnostics.PerformanceStats.FrameTime;
			double frameMs = frameTimeSec * 1000.0;
			double fps = frameTimeSec > 0 ? 1.0 / frameTimeSec : 0;

			return Task.FromResult<object>( new
			{
				fps = Math.Round( fps, 1 ),
				frameMs = Math.Round( frameMs, 3 ),
				gpuMs = Math.Round( Sandbox.Diagnostics.PerformanceStats.GpuFrametime, 3 ),
				gpuFrameNumber = Sandbox.Diagnostics.PerformanceStats.GpuFrameNumber,
				bytesAllocated = Sandbox.Diagnostics.PerformanceStats.BytesAllocated,
				processMemoryBytes = (long)Sandbox.Diagnostics.PerformanceStats.ApproximateProcessMemoryUsage,
				exceptions = Sandbox.Diagnostics.PerformanceStats.Exceptions,
				avgFrames = frames,
				timingsMs = new
				{
					update  = Math.Round( Sandbox.Diagnostics.PerformanceStats.Timings.Update.AverageMs( frames ), 3 ),
					physics = Math.Round( Sandbox.Diagnostics.PerformanceStats.Timings.Physics.AverageMs( frames ), 3 ),
					ui      = Math.Round( Sandbox.Diagnostics.PerformanceStats.Timings.Ui.AverageMs( frames ), 3 ),
					render  = Math.Round( Sandbox.Diagnostics.PerformanceStats.Timings.Render.AverageMs( frames ), 3 ),
					network = Math.Round( Sandbox.Diagnostics.PerformanceStats.Timings.Network.AverageMs( frames ), 3 ),
					gcPause = Math.Round( Sandbox.Diagnostics.PerformanceStats.Timings.GcPause.AverageMs( frames ), 3 )
				}
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"get_profiler_stats failed: {ex.Message}" } );
		}
	}
}

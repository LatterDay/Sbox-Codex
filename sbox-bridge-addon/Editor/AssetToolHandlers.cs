using Editor;
using Sandbox;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

// =============================================================================
// Batch 40 -- Asset utilities.
//
// CopyAssetWithDependenciesHandler: copy a project asset (and its full
// dependency closure) into a target directory, preserving relative paths so
// material references stay intact. Includes a shadow-guard that refuses to
// land files under core engine trees (citizen/dev/default) where even a single
// stray file can trigger an infinite recompile loop (BRIDGE_GOTCHAS #5).
//
// Registration: MyEditorMenu.cs Batch 40 block.
// =============================================================================

/// <summary>
/// Copy a project asset and its full dependency closure into a target directory.
/// Preserves relative path structure under the target so material .vmat references
/// to textures keep resolving. Refuses to write into core engine asset trees
/// (models/citizen, models/dev, materials/dev, materials/default) to avoid the
/// infinite-recompile gotcha (BRIDGE_GOTCHAS #5). Cloud/procedural/transient
/// assets are skipped with a reason in the "skipped" list.
/// Returns { copied:[{from,to}], skipped:[{path,reason}], count, note }.
/// </summary>
public class CopyAssetWithDependenciesHandler : IBridgeHandler
{
	// Core-engine subtrees whose assets must never be shadowed by a project copy.
	// Even one file landing here triggers an infinite asset-compiler loop.
	static readonly string[] ShadowBlockedTrees = new[]
	{
		"models/citizen",
		"materials/dev",
		"materials/default",
		"models/dev",
	};

	public Task<object> Execute( JsonElement p )
	{
		try
		{
			// ---- 1. Source path resolution ----
			var sourcePath = p.TryGetProperty( "sourcePath", out var sp ) ? sp.GetString() : null;
			if ( string.IsNullOrWhiteSpace( sourcePath ) )
				return Task.FromResult<object>( new { error = "sourcePath is required" } );

			// Try AssetSystem.FindByPath with the raw value, then with a project-relative prefix.
			Asset sourceAsset = Editor.AssetSystem.FindByPath( sourcePath );
			if ( sourceAsset == null )
			{
				// Try treating it as a project-relative path.
				if ( ClaudeBridge.TryResolveProjectPath( sourcePath, out var absAttempt, out _ ) )
					sourceAsset = Editor.AssetSystem.FindByPath( absAttempt )
						?? Editor.AssetSystem.FindByPath( absAttempt.Replace( '\\', '/' ) );
			}
			if ( sourceAsset == null )
				return Task.FromResult<object>( new { error = $"Asset not found via AssetSystem: '{sourcePath}'. Make sure the asset is registered (visible in the asset browser). Use search_assets to find its exact path." } );

			// ---- 2. Target directory ----
			var targetDir = p.TryGetProperty( "targetDir", out var td ) && !string.IsNullOrWhiteSpace( td.GetString() )
				? td.GetString() : "Assets/library";
			if ( !ClaudeBridge.TryResolveProjectPath( targetDir, out var absTargetDir, out var pathErr ) )
				return Task.FromResult<object>( new { error = pathErr } );

			// SHADOW GUARD for the DESTINATION too: writing anything under a core engine
			// tree (models/citizen, materials/dev, materials/default, models/dev) risks
			// shadowing built-in assets -> infinite recompile loop (BRIDGE_GOTCHAS #5).
			var targetNorm = targetDir.Replace( '\\', '/' ).TrimStart( '/' );
			if ( targetNorm.StartsWith( "Assets/", StringComparison.OrdinalIgnoreCase ) )
				targetNorm = targetNorm.Substring( 7 );
			foreach ( var blockedTree in ShadowBlockedTrees )
			{
				if ( targetNorm.StartsWith( blockedTree, StringComparison.OrdinalIgnoreCase ) )
					return Task.FromResult<object>( new { error = $"SHADOW_BLOCKED targetDir: '{targetDir}' is under the core engine tree '{blockedTree}'. Copying assets there can shadow built-in assets and cause an infinite recompile loop (BRIDGE_GOTCHAS #5). Pick a project-namespaced folder like Assets/library/<name>." } );
			}

			bool overwrite = p.TryGetProperty( "overwrite", out var ow ) && ow.ValueKind == JsonValueKind.True;

			// ---- 3. Build closure ----
			List<Asset> closure;
			try
			{
				closure = new List<Asset> { sourceAsset };
				var refs = sourceAsset.GetReferences( true );
				if ( refs != null ) closure.AddRange( refs );
			}
			catch ( Exception ex )
			{
				return Task.FromResult<object>( new { error = $"Failed to collect asset references: {ex.Message}" } );
			}

			// ---- 4. Copy each asset ----
			var copied  = new List<object>();
			var skipped = new List<object>();

			foreach ( var asset in closure )
			{
				try
				{
					// Skip cloud/procedural/transient assets -- they resolve globally, cannot be copied.
					if ( asset.IsCloud )      { skipped.Add( new { path = asset.RelativePath, reason = "cloud asset (resolves globally, no local file to copy)" } ); continue; }
					if ( asset.IsProcedural ) { skipped.Add( new { path = asset.RelativePath, reason = "procedural asset (generated at runtime, no source file)" } ); continue; }
					if ( asset.IsTransient )  { skipped.Add( new { path = asset.RelativePath, reason = "transient asset (not persisted to disk)" } ); continue; }

					// Shadow guard: refuse core engine trees.
					var relLower = ( asset.RelativePath ?? "" ).Replace( '\\', '/' ).ToLowerInvariant();
					foreach ( var blocked in ShadowBlockedTrees )
					{
						if ( relLower.StartsWith( blocked, StringComparison.Ordinal ) )
						{
							skipped.Add( new
							{
								path = asset.RelativePath,
								reason = $"SHADOW_BLOCKED: path starts with '{blocked}'. Copying assets under core engine trees ({string.Join( ", ", ShadowBlockedTrees )}) causes an infinite asset-recompile loop (BRIDGE_GOTCHAS #5). Use the asset from its original location."
							} );
							goto NextAsset;
						}
					}

					// Determine source file (prefer source over compiled).
					string srcFile = null;
					if ( asset.HasSourceFile )   srcFile = asset.GetSourceFile( true );
					else if ( asset.HasCompiledFile ) srcFile = asset.GetCompiledFile( true );

					if ( string.IsNullOrEmpty( srcFile ) || !File.Exists( srcFile ) )
					{
						// Try additional content files.
						var extras = GetAdditionalContent( asset );
						if ( extras.Count == 0 )
						{
							skipped.Add( new { path = asset.RelativePath, reason = "no source or compiled file found on disk" } );
							continue;
						}
						// Copy extras only.
						foreach ( var extra in extras )
						{
							if ( !File.Exists( extra ) ) continue;
							var destExtra = BuildDestPath( extra, absTargetDir );
							var skipReason = CopyFile( extra, destExtra, overwrite );
							if ( skipReason != null )
								skipped.Add( new { path = extra, reason = skipReason } );
							else
								copied.Add( new { from = extra, to = destExtra } );
						}
						continue;
					}

					var dest = BuildDestPath( srcFile, absTargetDir );
					var skip = CopyFile( srcFile, dest, overwrite );
					if ( skip != null )
						skipped.Add( new { path = asset.RelativePath, reason = skip } );
					else
						copied.Add( new { from = srcFile, to = dest } );

					// Also copy any additional content files (e.g. LODs, physics meshes).
					foreach ( var extra in GetAdditionalContent( asset ) )
					{
						if ( !File.Exists( extra ) ) continue;
						var destExtra = BuildDestPath( extra, absTargetDir );
						var skipReason2 = CopyFile( extra, destExtra, overwrite );
						if ( skipReason2 != null )
							skipped.Add( new { path = extra, reason = skipReason2 } );
						else
							copied.Add( new { from = extra, to = destExtra } );
					}
				}
				catch ( Exception ex )
				{
					skipped.Add( new { path = asset.RelativePath ?? "(unknown)", reason = $"exception: {ex.Message}" } );
				}
				NextAsset:;
			}

			return Task.FromResult<object>( new
			{
				copied,
				skipped,
				count   = copied.Count,
				note    = "Trigger an asset rescan (or restart the editor) if the new assets do not appear in the asset browser."
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"copy_asset_with_dependencies failed: {ex.Message}" } );
		}
	}

	// Build the destination path: place the asset inside absTargetDir using the
	// asset's own relative path structure (so sub-folder references stay intact).
	static string BuildDestPath( string srcFile, string absTargetDir )
	{
		// Use the filename only if we cannot derive a meaningful relative path.
		var fileName = Path.GetFileName( srcFile );
		return Path.Combine( absTargetDir, fileName );
	}

	// Copy srcFile -> destFile. Returns null on success, a skip-reason string on failure/skip.
	static string CopyFile( string src, string dest, bool overwrite )
	{
		if ( File.Exists( dest ) && !overwrite )
			return $"destination already exists (overwrite=false): {dest}";
		try
		{
			Directory.CreateDirectory( Path.GetDirectoryName( dest ) );
			File.Copy( src, dest, overwrite );
			return null;
		}
		catch ( Exception ex )
		{
			return $"copy failed: {ex.Message}";
		}
	}

	// Safely call GetAdditionalContentFiles if the Asset API supports it.
	static List<string> GetAdditionalContent( Asset asset )
	{
		try
		{
			var method = typeof( Asset ).GetMethod( "GetAdditionalContentFiles",
				System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance );
			if ( method == null ) return new List<string>();
			var result = method.Invoke( asset, null );
			if ( result is IEnumerable<string> paths ) return paths.ToList();
		}
		catch { /* API not present on this SDK version */ }
		return new List<string>();
	}
}

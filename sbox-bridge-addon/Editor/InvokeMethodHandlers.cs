using Editor;
using Sandbox;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;

// ═══════════════════════════════════════════════════════════════════════════
// invoke_method — call a public method BY NAME on a live GameObject component,
// passing ARGUMENTS.
//
// This is the with-args sibling of invoke_button. invoke_button matches a
// [Button] label or a PARAMETERLESS method name on a scene component; this
// handler resolves a specific GameObject by GUID, finds a public method whose
// NAME + ARG-COUNT match, coerces each JSON arg to that method's parameter type
// via the SAME coercion idiom the property setters use
// (ClaudeBridge.CoercePropertyAndSet / ElementToValueString), invokes it, and
// returns the (null-safe) ToString() of the result.
//
// Lives in the SAME assembly as MyEditorMenu.cs, so it reuses the shared
// ClaudeBridge helpers (ResolveGameObject, ElementToValueString,
// CoercePropertyAndSet) and the IBridgeHandler dispatch contract. This is
// UNSANDBOXED editor code: System.* is fine (System.Reflection, etc.) — only
// the C# we WRITE TO DISK has to obey the sandbox (MathX, etc.), and this
// handler writes nothing.
//
// Failure contract: every error path returns `new { error = ... }`, which the
// dispatch envelope (ClaudeBridge.TryGetHandlerError) reports as success=false.
//
// Registration line + mutating note are in the implementation summary —
// MyEditorMenu.cs owns RegisterHandlers (this file stays decoupled).
// ═══════════════════════════════════════════════════════════════════════════

/// <summary>
/// invoke_method — call a named public method (with args) on a component of a
/// live scene GameObject. Params:
///   id        : GameObject GUID (required)
///   method    : method name (required)
///   component : component type-name to target (optional; else searches all
///               components on the object for a matching method)
///   args      : JSON array of arguments (optional; defaults to none)
/// </summary>
public class InvokeMethodHandler : IBridgeHandler
{
	public Task<object> Execute( JsonElement p )
	{
		try
		{
			var scene = SceneEditorSession.Active?.Scene;
			if ( scene == null )
				return Task.FromResult<object>( new { error = "No active scene" } );

			// ── id (GameObject GUID) ──────────────────────────────────────────
			var id = p.TryGetProperty( "id", out var idEl ) ? idEl.GetString() : null;
			if ( string.IsNullOrEmpty( id ) )
				return Task.FromResult<object>( new { error = "id is required (the GameObject GUID)" } );

			var go = ClaudeBridge.ResolveGameObject( scene, id );
			if ( go == null )
				return Task.FromResult<object>( new { error = $"GameObject not found: {id}" } );

			// ── method name ───────────────────────────────────────────────────
			var methodName = p.TryGetProperty( "method", out var mEl ) ? mEl.GetString() : null;
			if ( string.IsNullOrEmpty( methodName ) )
				return Task.FromResult<object>( new { error = "method is required (the public method name to call)" } );

			// ── args (optional JSON array) ────────────────────────────────────
			JsonElement[] argEls = System.Array.Empty<JsonElement>();
			if ( p.TryGetProperty( "args", out var argsEl ) && argsEl.ValueKind == JsonValueKind.Array )
				argEls = argsEl.EnumerateArray().ToArray();
			int argCount = argEls.Length;

			// ── candidate components ──────────────────────────────────────────
			// Optionally restrict to one component type (case-insensitive short name);
			// otherwise search every component on the object.
			var componentType = p.TryGetProperty( "component", out var cEl ) ? cEl.GetString() : null;

			List<Component> candidates;
			if ( !string.IsNullOrEmpty( componentType ) )
			{
				candidates = go.Components.GetAll()
					.Where( c => c.GetType().Name.Equals( componentType, StringComparison.OrdinalIgnoreCase ) )
					.ToList();
				if ( candidates.Count == 0 )
					return Task.FromResult<object>( new { error = $"Component not found on object: {componentType}" } );
			}
			else
			{
				candidates = go.Components.GetAll().ToList();
				if ( candidates.Count == 0 )
					return Task.FromResult<object>( new { error = $"GameObject '{go.Name}' has no components" } );
			}

			// ── find a matching public method: name + arg-count ───────────────
			// Track the names we saw so a wrong arg-count produces a helpful error.
			Component targetComp = null;
			MethodInfo targetMethod = null;
			var nameMatchesWrongArity = new List<string>();

			foreach ( var comp in candidates )
			{
				var compType = comp.GetType();
				foreach ( var method in compType.GetMethods( BindingFlags.Public | BindingFlags.Instance ) )
				{
					if ( !method.Name.Equals( methodName, StringComparison.Ordinal ) )
						continue;
					if ( method.IsGenericMethodDefinition )
						continue; // can't bind type args from JSON
					if ( method.GetParameters().Length != argCount )
					{
						nameMatchesWrongArity.Add( $"{compType.Name}.{method.Name}({method.GetParameters().Length} arg(s))" );
						continue;
					}
					targetComp = comp;
					targetMethod = method;
					break;
				}
				if ( targetMethod != null ) break;
			}

			// Second pass: tolerate a case-insensitive name match if no exact one was found.
			if ( targetMethod == null )
			{
				foreach ( var comp in candidates )
				{
					var compType = comp.GetType();
					foreach ( var method in compType.GetMethods( BindingFlags.Public | BindingFlags.Instance ) )
					{
						if ( !method.Name.Equals( methodName, StringComparison.OrdinalIgnoreCase ) )
							continue;
						if ( method.IsGenericMethodDefinition )
							continue;
						if ( method.GetParameters().Length != argCount )
						{
							nameMatchesWrongArity.Add( $"{compType.Name}.{method.Name}({method.GetParameters().Length} arg(s))" );
							continue;
						}
						targetComp = comp;
						targetMethod = method;
						break;
					}
					if ( targetMethod != null ) break;
				}
			}

			if ( targetMethod == null )
			{
				if ( nameMatchesWrongArity.Count > 0 )
					return Task.FromResult<object>( new
					{
						error = $"Method '{methodName}' exists but not with {argCount} arg(s). Overloads found: {string.Join( ", ", nameMatchesWrongArity.Distinct() )}."
					} );

				var where = string.IsNullOrEmpty( componentType ) ? $"any component on '{go.Name}'" : componentType;
				return Task.FromResult<object>( new
				{
					error = $"No public method named '{methodName}' (with {argCount} arg(s)) found on {where}."
				} );
			}

			// ── coerce each JSON arg to its parameter type ────────────────────
			var ps = targetMethod.GetParameters();
			var callArgs = new object[ps.Length];
			for ( int i = 0; i < ps.Length; i++ )
			{
				var pType = ps[i].ParameterType;

				// Flatten the JSON token to the string form CoercePropertyAndSet expects
				// (scalars as-is, arrays joined "1,2,3", objects as raw JSON), then route
				// through the shared, type-aware coercion. This gives us the SAME support
				// the property setters have: primitives/enums/Vector3/Color/Rotation, asset
				// refs (Model/Material/SoundEvent…) by path, and GameObject/Component refs
				// by GUID — built into the correct typed value rather than a raw string.
				var valStr = ClaudeBridge.ElementToValueString( argEls[i] );

				int idx = i;
				object coerced = null;
				if ( !ClaudeBridge.CoercePropertyAndSet(
						pType,
						v => coerced = v,
						$"{targetMethod.Name} arg[{idx}] ({ps[idx].Name})",
						valStr,
						out var coerceErr ) )
				{
					return Task.FromResult<object>( new
					{
						error = $"Could not coerce arg[{idx}] for {targetComp.GetType().Name}.{targetMethod.Name}: {coerceErr}"
					} );
				}
				callArgs[i] = coerced;
			}

			// ── invoke ────────────────────────────────────────────────────────
			object rawResult;
			try
			{
				rawResult = targetMethod.Invoke( targetComp, callArgs );
			}
			catch ( TargetInvocationException tie )
			{
				// Unwrap so the real exception surfaces, not the reflection wrapper.
				var inner = tie.InnerException ?? tie;
				return Task.FromResult<object>( new
				{
					error = $"{targetComp.GetType().Name}.{targetMethod.Name} threw {inner.GetType().Name}: {inner.Message}"
				} );
			}

			// null-safe result stringification. void methods → null result.
			bool isVoid = targetMethod.ReturnType == typeof( void );
			string resultStr = isVoid ? null : ( rawResult?.ToString() ?? "null" );

			return Task.FromResult<object>( new
			{
				invoked = true,
				id,
				component = targetComp.GetType().Name,
				method = targetMethod.Name,
				argCount,
				returnType = targetMethod.ReturnType.Name,
				result = resultStr
			} );
		}
		catch ( Exception ex )
		{
			return Task.FromResult<object>( new { error = $"invoke_method failed: {ex.Message}" } );
		}
	}
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Physics tools: add_physics, add_collider, add_joint, raycast.
 * Manages rigidbodies, colliders, physics constraints, and ray tracing.
 */

// A 3D vector accepted as EITHER an object {x,y,z} OR a comma string "x,y,z",
// passed through unchanged. The C# handler parses both forms (source of truth).
// See the cross-language vector/color contract.
const Vector3Schema = z
  .union([
    z.object({ x: z.number(), y: z.number(), z: z.number() }),
    z.string().describe('Comma string "x,y,z", e.g. "0,0,200"'),
  ])
  .describe('3D vector — object {x,y,z} OR comma string "x,y,z"');

export function registerPhysicsTools(
  server: McpServer,
  bridge: BridgeClient
): void {
  // ── add_physics ───────────────────────────────────────────────────
  server.tool(
    "add_physics",
    "Add a Rigidbody and collider to a GameObject, making it a dynamic physics object. Auto-selects BoxCollider if no collider type specified",
    {
      id: z.string().describe("GUID of the GameObject"),
      collider: z
        .enum(["box", "sphere", "capsule", "mesh"])
        .optional()
        .describe("Collider type to add. Defaults to 'box'"),
      mass: z
        .number()
        .optional()
        .describe("Mass of the physics body in kg"),
      gravity: z
        .boolean()
        .optional()
        .describe("Whether gravity affects this object. Defaults to true"),
    },
    async (params) => {
      const res = await bridge.send("add_physics", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_collider ──────────────────────────────────────────────────
  server.tool(
    "add_collider",
    "Add a specific collider component to a GameObject. Supports box, sphere, capsule, mesh, and hull types. Can be configured as trigger",
    {
      id: z.string().describe("GUID of the GameObject"),
      type: z
        .enum(["box", "sphere", "capsule", "mesh", "hull"])
        .describe("Type of collider to add"),
      isTrigger: z
        .boolean()
        .optional()
        .describe(
          "If true, the collider acts as a trigger (no physics collision). Defaults to false"
        ),
      size: Vector3Schema
        .optional()
        .describe('Size for BoxCollider (x, y, z dimensions) — object {x,y,z} or comma string "x,y,z"'),
      radius: z
        .number()
        .optional()
        .describe("Radius for SphereCollider or CapsuleCollider"),
      height: z
        .number()
        .optional()
        .describe("Height/length for CapsuleCollider"),
    },
    async (params) => {
      const res = await bridge.send("add_collider", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_joint ─────────────────────────────────────────────────────
  server.tool(
    "add_joint",
    "Add a physics joint/constraint between two GameObjects. Supports fixed, spring, and slider joint types",
    {
      id: z
        .string()
        .describe("GUID of the GameObject to add the joint to"),
      type: z
        .enum(["fixed", "spring", "slider"])
        .describe("Type of joint to create"),
      targetId: z
        .string()
        .optional()
        .describe("GUID of the target GameObject to connect to"),
      frequency: z
        .number()
        .optional()
        .describe("Spring frequency (spring joints only)"),
      damping: z
        .number()
        .optional()
        .describe("Damping ratio (spring joints only). 0 = no damping, 1 = critical"),
    },
    async (params) => {
      const res = await bridge.send("add_joint", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── raycast ───────────────────────────────────────────────────────
  server.tool(
    "raycast",
    "Perform a physics raycast (Scene.Trace.Ray) and return hit results. Useful for line-of-sight checks, object placement, and collision detection",
    {
      start: Vector3Schema
        .describe('Ray start position (world space) — object {x,y,z} or comma string "x,y,z"'),
      end: Vector3Schema
        .optional()
        .describe("Ray end position. Use either end or direction+maxDistance"),
      direction: Vector3Schema
        .optional()
        .describe("Ray direction (normalized). Used with maxDistance instead of end"),
      maxDistance: z
        .number()
        .optional()
        .describe("Maximum ray distance when using direction. Defaults to 10000"),
      radius: z
        .number()
        .optional()
        .describe("Sphere/box trace radius. 0 = thin ray (default)"),
      ignoreIds: z
        .array(z.string())
        .optional()
        .describe("GUIDs of GameObjects to ignore"),
      all: z
        .boolean()
        .optional()
        .describe(
          "If true, returns all hits along the ray. Defaults to false (first hit only)"
        ),
    },
    async (params) => {
      const res = await bridge.send("raycast", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── physics_overlap ───────────────────────────────────────────────
  server.tool(
    "physics_overlap",
    "Spatial volume query: return the GameObjects whose colliders intersect a SPHERE (center + radius) or a BOX (center + size) — the volume counterpart to raycast's ray. Use it for 'what's near this point' / 'what's inside this trigger volume' checks (proximity, blast radius, spawn-clearance). Read-only.",
    {
      center: Vector3Schema
        .describe('Center of the query volume (world space) — object {x,y,z} or comma string "x,y,z"'),
      radius: z
        .number()
        .optional()
        .describe("Sphere radius. Provide this OR size (box), not both"),
      size: Vector3Schema
        .optional()
        .describe("Full box size (not half-extents). Provide this OR radius"),
    },
    async (params) => {
      const res = await bridge.send("physics_overlap", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

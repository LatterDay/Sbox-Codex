import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Visual & atmosphere tools (Batch 17): lighting, post-processing, fog, sky,
 * reflection probes, and compose-it-all presets.
 *
 * These wrap s&box's visual components with sensible parameters so Claude can
 * author scene mood directly, instead of hand-driving add_component_with_properties
 * (which can't even set a Color). After any change, screenshot the scene and read
 * the result — this layer is where the screenshot loop matters most.
 */

const ColorSchema = z
  .object({
    r: z.number().min(0).describe("Red, 0-1"),
    g: z.number().min(0).describe("Green, 0-1"),
    b: z.number().min(0).describe("Blue, 0-1"),
    a: z.number().min(0).max(1).optional().describe("Alpha, 0-1 (default 1)"),
  })
  .describe("RGBA colour as 0-1 floats");

const Vector3Schema = z
  .object({ x: z.number(), y: z.number(), z: z.number() })
  .describe("World position {x,y,z}");

const RotationSchema = z
  .object({ pitch: z.number(), yaw: z.number(), roll: z.number() })
  .describe("Rotation {pitch,yaw,roll} in degrees");

export function registerVisualTools(server: McpServer, bridge: BridgeClient): void {
  // ── add_light ──────────────────────────────────────────────────────
  server.tool(
    "add_light",
    "Add a light to the active scene. NOTE: s&box lights have no separate brightness field — intensity is the colour magnitude, so 'brightness' scales the colour (use >1 for bright/HDR). Types: directional = sun (aim it with rotation), point = omni-directional (range), spot = cone (range + coneInner/coneOuter degrees), ambient = global fill light.",
    {
      type: z
        .enum(["directional", "point", "spot", "ambient"])
        .describe("Light type"),
      name: z.string().optional().describe("GameObject name"),
      color: ColorSchema.optional().describe("Light colour (default white)"),
      brightness: z
        .number()
        .optional()
        .describe("Intensity multiplier on the colour (default 1; try 2-10 for point/spot)"),
      range: z
        .number()
        .optional()
        .describe("point/spot only: falloff radius in units (maps to Radius)"),
      coneInner: z
        .number()
        .optional()
        .describe("spot only: inner cone angle in degrees"),
      coneOuter: z
        .number()
        .optional()
        .describe("spot only: outer cone angle in degrees"),
      shadows: z.boolean().optional().describe("Cast shadows (default true)"),
      skyColor: ColorSchema.optional().describe(
        "directional only: ambient sky colour for the upper hemisphere"
      ),
      position: Vector3Schema.optional().describe("World position"),
      rotation: RotationSchema.optional().describe(
        "World rotation — sets the aim direction for directional/spot lights"
      ),
      parentId: z.string().optional().describe("GUID of a parent GameObject"),
    },
    async (params) => {
      const res = await bridge.send("add_light", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── set_fog ────────────────────────────────────────────────────────
  server.tool(
    "set_fog",
    "Add or update distance fog in the active scene. v1 supports gradient fog (atmospheric distance haze — great for mood/horror). Re-running on the same target updates it rather than duplicating.",
    {
      type: z
        .enum(["gradient"])
        .optional()
        .describe("Fog type (default gradient; cubemap/volumetric coming later)"),
      name: z.string().optional().describe("GameObject name when creating a new fog object"),
      targetId: z
        .string()
        .optional()
        .describe("GUID of an existing GameObject to host the fog (else a new 'Gradient Fog' object is created)"),
      color: ColorSchema.optional().describe("Fog colour"),
      startDistance: z
        .number()
        .optional()
        .describe("Distance (units) where fog begins"),
      endDistance: z
        .number()
        .optional()
        .describe("Distance (units) where fog reaches full density"),
      height: z.number().optional().describe("World height the fog settles around"),
      falloff: z
        .number()
        .optional()
        .describe("Distance falloff exponent (higher = sharper onset)"),
    },
    async (params) => {
      const res = await bridge.send("set_fog", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_post_process ─────────────────────────────────────────────────
  server.tool(
    "add_post_process",
    "Add (or update) a post-processing effect on the scene's main camera (auto-enables post-processing). Generic: pass the effect component name + any of its properties. Examples — Bloom {Strength, Threshold, Tint}, Tonemapping, ColorAdjustments {Saturation, Brightness, Contrast}, Vignette {Intensity, Color}, FilmGrain, DepthOfField, ChromaticAberration, MotionBlur, Sharpen, AmbientOcclusion. Call describe_type <Effect> to discover a given effect's properties.",
    {
      effect: z
        .string()
        .describe("Post-process component type name, e.g. 'Bloom', 'Vignette', 'ColorAdjustments'"),
      properties: z
        .record(z.any())
        .optional()
        .describe("Property name -> value. Floats/ints/bools as numbers/bools, colours as {r,g,b,a}, enums as their string name."),
      cameraId: z
        .string()
        .optional()
        .describe("GUID of a specific camera GameObject (default: the scene's main camera)"),
    },
    async (params) => {
      const res = await bridge.send("add_post_process", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── set_skybox ───────────────────────────────────────────────────────
  server.tool(
    "set_skybox",
    "Set the scene's 2D skybox tint / indirect lighting (re-uses an existing SkyBox2D or creates one). Darken the tint for night/dusk. Optionally point it at a .vmat sky material.",
    {
      tint: ColorSchema.optional().describe("Sky tint colour"),
      indirectLighting: z
        .boolean()
        .optional()
        .describe("Whether the sky contributes indirect/ambient light"),
      material: z.string().optional().describe("Path to a .vmat sky material (optional)"),
      name: z.string().optional().describe("Name for the sky GameObject if one is created"),
    },
    async (params) => {
      const res = await bridge.send("set_skybox", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── apply_atmosphere (preset) ─────────────────────────────────────────
  server.tool(
    "apply_atmosphere",
    "One-call scene mood: composes ambient + directional light, gradient fog, and a camera post-fx stack (tonemap + colour grade + vignette) tuned for the chosen mood. Idempotent — re-runs update the same 'Atmosphere *' objects.",
    {
      mood: z
        .enum(["horror-night", "foggy-dawn", "overcast", "warm-interior"])
        .describe("Atmosphere preset"),
    },
    async (params) => {
      const res = await bridge.send("apply_atmosphere", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── apply_post_fx_look (preset) ───────────────────────────────────────
  server.tool(
    "apply_post_fx_look",
    "Apply just a camera post-processing look (no lights/fog): cinematic (tonemap + bloom + soft vignette), filmic-horror (desaturated, high-contrast, heavy vignette, film grain), or clean (tonemap only).",
    {
      look: z
        .enum(["cinematic", "filmic-horror", "clean"])
        .describe("Post-fx look preset"),
    },
    async (params) => {
      const res = await bridge.send("apply_post_fx_look", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );

  // ── add_envmap_probe ─────────────────────────────────────────────────
  server.tool(
    "add_envmap_probe",
    "Add an environment reflection/ambient probe (EnvmapProbe) at a position with a cubic influence volume — captures local reflections and indirect light for nearby surfaces.",
    {
      name: z.string().optional().describe("GameObject name"),
      position: Vector3Schema.optional().describe("World position (centre of the probe)"),
      size: z.number().optional().describe("Cubic influence size in units (default 1024)"),
      tint: ColorSchema.optional().describe("Tint applied to the captured environment"),
      feathering: z
        .number()
        .optional()
        .describe("Edge feathering 0-1 for blending between overlapping probes"),
    },
    async (params) => {
      const res = await bridge.send("add_envmap_probe", params);
      if (!res.success) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }
  );
}

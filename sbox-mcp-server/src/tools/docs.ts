import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeClient } from "../transport/bridge-client.js";

/**
 * Documentation tools (Batch 25 — "let Codex read the real s&box docs"): search
 * and fetch the official s&box guide documentation so Codex can ground itself in
 * Facepunch's own pages instead of guessing from possibly-stale training data.
 *
 * The s&box guide docs live in the PUBLIC GitHub repo Facepunch/sbox-docs
 * (branch master): ~225 Markdown pages under docs/<category>/.../<page>.md, each
 * starting with YAML frontmatter (title, icon, created, updated).
 *
 * Two HTTP sources, both fetched with Node 18+ built-in fetch (no npm deps):
 *   1. INDEX (once, cached in memory): the GitHub git-tree API lists every file
 *      in the repo. Requires a User-Agent header or GitHub returns 403. Honors an
 *      optional GITHUB_TOKEN env var for a higher rate limit (never required).
 *   2. PAGE CONTENT: raw.githubusercontent.com serves the Markdown as text/plain
 *      with no rate limit and no UA needed.
 *
 * Per page we derive:
 *   - category: the 2nd path segment (docs/networking/rpcs.md -> "networking")
 *   - slug:     the path with leading "docs/" and trailing ".md" removed
 *   - webUrl:   https://sbox.game/dev/doc/<slug> (a trailing "/index" is stripped)
 *
 * All three tools are read-only and never throw — fetch failures are caught and
 * surfaced as a plain text error in the tool result.
 */

/** GitHub git-tree API for the docs repo (lists every file, recursive). */
const TREE_URL =
  "https://api.github.com/repos/Facepunch/sbox-docs/git/trees/master?recursive=1";

/** Base for raw Markdown page content (text/plain, no rate limit). */
const RAW_BASE =
  "https://raw.githubusercontent.com/Facepunch/sbox-docs/master/";

/** Public web home for a rendered doc page. */
const WEB_BASE = "https://sbox.game/dev/doc/";

/** A single indexed documentation page. */
interface DocEntry {
  /** Repo-relative path, e.g. "docs/networking/rpcs.md". */
  path: string;
  /** Slug with leading "docs/" and trailing ".md" stripped, e.g. "networking/rpcs". */
  slug: string;
  /** 2nd path segment, e.g. "networking". "" if the page sits directly under docs/. */
  category: string;
  /** Rendered web URL (trailing "/index" removed). */
  webUrl: string;
}

/** Module-level cache so the index is fetched at most once per ~30 min. */
let indexCache: DocEntry[] | null = null;
let indexFetchedAt = 0;
/** Re-fetch the index if it is older than this (handles long-lived processes). */
const INDEX_TTL_MS = 30 * 60 * 1000;

/** Compute slug/category/webUrl for a repo-relative docs path. */
function buildEntry(path: string): DocEntry {
  // "docs/networking/rpcs.md" -> "networking/rpcs"
  const slug = path.replace(/^docs\//, "").replace(/\.md$/i, "");
  const segments = path.split("/");
  // path[0] is "docs"; the category is the next segment (if any).
  const category = segments.length > 2 ? segments[1] : "";
  // A trailing "/index" doesn't appear in the public web URL.
  const webSlug = slug.replace(/\/index$/i, "");
  return { path, slug, category, webUrl: WEB_BASE + webSlug };
}

/**
 * Ensure the doc index is loaded (fetching + building it once), reusing the
 * module-level cache. Returns null on any fetch/parse failure so callers can
 * report a clean error. Never throws.
 */
async function getIndex(): Promise<DocEntry[] | null> {
  const now = Date.now();
  if (indexCache && now - indexFetchedAt < INDEX_TTL_MS) {
    return indexCache;
  }
  try {
    const headers: Record<string, string> = {
      // GitHub API rejects requests without a User-Agent (403).
      "User-Agent": "sbox-mcp-server",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(TREE_URL, { headers });
    if (!res.ok) {
      return null;
    }
    const json: any = await res.json();
    const tree: any[] = Array.isArray(json?.tree) ? json.tree : [];
    const entries: DocEntry[] = [];
    for (const node of tree) {
      const p: string = node?.path ?? "";
      // Keep only Markdown pages under docs/.
      if (
        node?.type === "blob" &&
        p.startsWith("docs/") &&
        /\.md$/i.test(p)
      ) {
        entries.push(buildEntry(p));
      }
    }
    if (entries.length === 0) {
      // Empty tree almost certainly means an API hiccup, not a real result.
      return null;
    }
    indexCache = entries;
    indexFetchedAt = now;
    return indexCache;
  } catch {
    return null;
  }
}

/** Tokenize a query into lowercased, non-empty words. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/** Strip the leading YAML frontmatter block from a Markdown document. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** Pull the `title:` value out of YAML frontmatter, if present. */
function parseTitle(md: string): string | null {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) return null;
  const line = fm[1].match(/^\s*title\s*:\s*(.+?)\s*$/m);
  if (!line) return null;
  // Drop surrounding quotes if the title was quoted.
  return line[1].replace(/^["']|["']$/g, "").trim() || null;
}

/** Derive a human title for an entry without fetching its content. */
function titleFromSlug(slug: string): string {
  const last = slug.split("/").pop() ?? slug;
  return last.replace(/[-_]/g, " ");
}

export function registerDocsTools(
  server: McpServer,
  _bridge: BridgeClient
): void {
  // ── search_docs ────────────────────────────────────────────────────
  server.tool(
    "search_docs",
    "Search the official s&box guide documentation (the Facepunch/sbox-docs pages rendered at sbox.game/dev/doc) by keyword. Returns the best-matching pages with their title, category, slug, and web URL — use the slug with get_doc_page to read one. The s&box API changes between SDK versions, so prefer these real docs over guessing. Read-only.",
    {
      query: z
        .string()
        .describe("Keywords to match against page titles, slugs, and paths"),
      category: z
        .string()
        .optional()
        .describe(
          'Optional category filter (the 2nd path segment, e.g. "networking", "ui"). Use list_doc_categories to see them.'
        ),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Max results to return (default 10, max 50)"),
    },
    async (params) => {
      const index = await getIndex();
      if (!index) {
        return {
          content: [
            {
              type: "text",
              text: "Error: couldn't load the s&box docs index from GitHub (network error or rate limit). Try again shortly; set the GITHUB_TOKEN environment variable to raise the rate limit.",
            },
          ],
        };
      }

      let limit = params.limit ?? 10;
      if (limit < 1) limit = 1;
      if (limit > 50) limit = 50;

      const cat = params.category?.toLowerCase().trim();
      let pages = index;
      if (cat) {
        pages = pages.filter((p) => p.category.toLowerCase() === cat);
      }

      const tokens = tokenize(params.query);
      const scored = pages
        .map((p) => {
          const title = titleFromSlug(p.slug).toLowerCase();
          const slug = p.slug.toLowerCase();
          const path = p.path.toLowerCase();
          let score = 0;
          for (const t of tokens) {
            // Title and slug are the strongest signals; path is a weak fallback.
            if (title.includes(t)) score += 5;
            if (slug.includes(t)) score += 4;
            if (path.includes(t)) score += 1;
          }
          return { p, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No s&box docs matched "${params.query}"${
                cat ? ` in category "${params.category}"` : ""
              }. Try broader keywords, or call list_doc_categories.`,
            },
          ],
        };
      }

      const results = scored.map(({ p }) => ({
        title: titleFromSlug(p.slug),
        category: p.category,
        slug: p.slug,
        webUrl: p.webUrl,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // ── get_doc_page ───────────────────────────────────────────────────
  server.tool(
    "get_doc_page",
    "Fetch the full Markdown of one s&box guide page (from search_docs). Pass a slug like \"networking/rpcs\", a raw repo path like \"docs/networking/rpcs.md\", or a full sbox.game/dev/doc URL. YAML frontmatter is stripped. Long pages are paginated: pass chunk to read further (the footer tells you when there's more). Read-only.",
    {
      slug: z
        .string()
        .describe(
          'Page slug (e.g. "networking/rpcs"), a "docs/...md" path, or a full sbox.game/dev/doc URL'
        ),
      chunk: z
        .number()
        .int()
        .optional()
        .describe("1-based chunk index for long pages (default 1)"),
      chunkSize: z
        .number()
        .int()
        .optional()
        .describe("Max characters per chunk (default 8000)"),
    },
    async (params) => {
      const index = await getIndex();
      if (!index) {
        return {
          content: [
            {
              type: "text",
              text: "Error: couldn't load the s&box docs index from GitHub (network error or rate limit). Try again shortly; set the GITHUB_TOKEN environment variable to raise the rate limit.",
            },
          ],
        };
      }

      // Normalize the input into a slug: accept a full web URL, a raw repo path,
      // or a bare slug.
      let raw = params.slug.trim();
      if (raw.startsWith("http")) {
        const idx = raw.indexOf("/dev/doc/");
        if (idx >= 0) raw = raw.slice(idx + "/dev/doc/".length);
      }
      // Strip a leading "docs/" and a trailing ".md" if a path was passed.
      const wanted = raw
        .replace(/^\/+/, "")
        .replace(/^docs\//, "")
        .replace(/\.md$/i, "")
        .replace(/\/+$/, "");

      // Resolve against the index: exact slug, then a slug that points at the
      // page's index file (e.g. "networking" -> "networking/index").
      const entry =
        index.find((p) => p.slug.toLowerCase() === wanted.toLowerCase()) ??
        index.find(
          (p) => p.slug.toLowerCase() === `${wanted.toLowerCase()}/index`
        );

      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `Error: no s&box doc page matched "${params.slug}". Use search_docs to find a valid slug.`,
            },
          ],
        };
      }

      let md: string;
      try {
        const res = await fetch(RAW_BASE + entry.path);
        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error: failed to fetch ${entry.path} (HTTP ${res.status}).`,
              },
            ],
          };
        }
        md = await res.text();
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching ${entry.path}: ${(e as Error).message}`,
            },
          ],
        };
      }

      const title = parseTitle(md) ?? titleFromSlug(entry.slug);
      const body = stripFrontmatter(md);
      const header = `# ${title}\nSource: ${entry.webUrl}\n\n`;

      let chunkSize = params.chunkSize ?? 8000;
      if (chunkSize < 500) chunkSize = 500;

      // Short pages: return the whole body in one shot.
      if (body.length <= chunkSize) {
        return { content: [{ type: "text", text: header + body }] };
      }

      // Long pages: slice into chunks and return the requested 1-based chunk.
      const total = Math.ceil(body.length / chunkSize);
      let i = params.chunk ?? 1;
      if (i < 1) i = 1;
      if (i > total) i = total;
      const start = (i - 1) * chunkSize;
      const slice = body.slice(start, start + chunkSize);
      let footer = `\n\n— chunk ${i}/${total}`;
      if (i < total) {
        footer += `; call get_doc_page again with chunk=${
          i + 1
        } for more —`;
      } else {
        footer += " (end) —";
      }
      return { content: [{ type: "text", text: header + slice + footer }] };
    }
  );

  // ── list_doc_categories ────────────────────────────────────────────
  server.tool(
    "list_doc_categories",
    "List the categories of the official s&box guide documentation, with how many pages each has. Use a category name to filter search_docs. Read-only.",
    {},
    async () => {
      const index = await getIndex();
      if (!index) {
        return {
          content: [
            {
              type: "text",
              text: "Error: couldn't load the s&box docs index from GitHub (network error or rate limit). Try again shortly; set the GITHUB_TOKEN environment variable to raise the rate limit.",
            },
          ],
        };
      }

      const counts = new Map<string, number>();
      for (const p of index) {
        const key = p.category || "(root)";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const result = Array.from(counts.entries())
        .map(([category, pageCount]) => ({ category, pageCount }))
        .sort((a, b) => b.pageCount - a.pageCount);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

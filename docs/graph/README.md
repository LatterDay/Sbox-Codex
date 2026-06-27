# Bridge Map — graphify knowledge graph

This folder holds a **knowledge graph of the s&box Codex Bridge**: a map of how every
piece connects to every other piece. It was built with [graphify](https://github.com/) by
running an AST pass over the code plus a semantic pass over the docs, so the graph links the
**MCP tools** to the **C# handlers** that implement them and to the **docs/skills** that
describe them.

## What's here

| File | What it is |
|------|------------|
| `graph.json` | The graph itself — 1,192 nodes / 2,301 edges. Machine-readable; this is what the query tools read. |
| `graph.html` | A self-contained interactive viewer. Open it in a browser to **browse** the graph — pan/zoom, click a node to see what it connects to, communities are colour-coded. |
| `GRAPH_REPORT.md` | A human-readable summary: god nodes (most-connected abstractions), community hubs (navigation), and the extraction audit (EXTRACTED vs INFERRED edges). |

## How to read the map

- **`IBridgeHandler` is the spine.** It's the top **god node** (~173 edges) — every editor-side
  command handler implements it, so it sits at the center of the whole bridge. If you're trying
  to understand how a tool reaches the editor, start there. (`JsonElement` and `Task` rank higher
  by raw degree but those are language plumbing, not the bridge's own abstraction.)
- **Every MCP tool maps to its C# handler and to its docs.** A tool like `screenshot_from` links
  to the handler that executes it (under `IBridgeHandler`) and to the doc/skill text that explains
  it — so the graph answers "what implements this?" and "what documents this?" in one place.
- **Communities are the cross-document edges.** graphify's community detection groups related
  nodes (e.g. the networking handlers, the visuals tools, the changelog fixes) and surfaces
  connections across files you wouldn't think to look for. The hubs are listed at the top of
  `GRAPH_REPORT.md`.
- **`MyEditorMenu.cs` is a flagged monolith.** It's the single C# file that holds **all** bridge
  server + handler code (~165 edges — second only to `IBridgeHandler`). The graph flags it as a
  large monolith: a natural candidate to split into per-batch handler files. Treat its size as a
  known smell, not a surprise.

## How to USE it

**Browse it:** open `graph.html` in any browser. No server needed — it's a single self-contained
file. Click around to see what connects to what.

**Query it:** run the graphify query command against `graph.json` to ask questions in natural
language:

```bash
graphify query "what implements screenshot_from"      --graph docs/graph/graph.json
graphify path  "create_player_controller" "IBridgeHandler" --graph docs/graph/graph.json
graphify explain "MyEditorMenu.cs"                    --graph docs/graph/graph.json
```

`query` does a broad BFS traversal (good for "what is X connected to?"); add `--dfs` to trace a
specific chain. `path` finds the shortest path between two concepts; `explain` gives a
plain-language description of one node and its neighbors. (Inside Codex you can also just
ask in plain language — the `/graphify` skill treats a question as a query against this graph.)

## ⚠️ This map CAN GO STALE

The graph is a **snapshot**, not a live view. It was generated from the repo at a point in time
(see the date at the top of `GRAPH_REPORT.md`). **Every time tools, handlers, or docs change, it
drifts out of date** — new tools won't appear, removed ones will linger, edge counts will be wrong.

**Check freshness before trusting it:** compare the date in `GRAPH_REPORT.md` against recent
changes. If the graph predates a tool/handler/doc change, regenerate it:

- **Quick, deterministic, no-LLM (code/AST only):** run `scripts/regen-graph.ps1`. This refreshes
  the code structure (handlers, tools, call edges) from the AST. Fast and reproducible — but it
  does **not** re-read the docs.
- **Full doc-inclusive refresh:** re-run the **`/graphify`** skill on the repo. That does the full
  AST + semantic (LLM) pass, so the doc/skill/changelog edges and community labels are rebuilt too.
  This is the authoritative regen and is what maintainers should run as part of a release (see
  `CODEX.md` and the `sbox-build-feature` skill).

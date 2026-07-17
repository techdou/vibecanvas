---
name: vibecanvas
description: Route and coordinate work in the VibeCanvas 2 visual creation canvas. Use when the user asks to inspect, organize, modify, run, cancel, review, or collaborate on a VibeCanvas infinite canvas; refers to selected nodes, candidates, masks, annotations, subworkflows, Artifacts, versions, or Image 2 workflows; or needs another VibeCanvas specialist skill.
license: MIT
compatibility: opencode, zcode, mcp
metadata:
  product: vibecanvas
  role: router
  protocol: "2.0"
---

# VibeCanvas Router

VibeCanvas is a local-first infinite canvas plus a typed, executable image workflow backed by SQLite/WAL. Every mutation goes through one of the **21 MCP tools**; there is no "edit the file directly" path. This skill tells you which tool to call, in what order, and how to chain them.

## Preconditions

Before doing anything, make sure a VibeCanvas service is reachable from the current agent process:

- The user has registered VibeCanvas as an MCP server (ZCode: `.zcode/config.json`; OpenCode: `opencode.json`; Claude Code: `.mcp.json`). If `get_workspace_context` returns an error, ask the user to run `npx tsx scripts/install-skills.ts --project <projectDir> --target-agents <agent>` and restart the session.
- Both the Web process (`vibecanvas serve`) and the MCP stdio process can be active at the same time; they share the same `.vibecanvas/` SQLite WAL store, so the user can watch the canvas update in the browser while you drive it from here.
- If the user reports "nothing happens on the canvas", check that they actually have the Web process running on `http://127.0.0.1:43120` (default host/port) — the MCP process alone will execute runs but won't render anything until they open the page.

## Route to a specialist

Match the user's intent, then dispatch to the matching skill and let it own the rest of the turn:

| User intent | Skill |
|---|---|
| Build, connect, repair, template, refactor, or extend a workflow | `vibecanvas-workflow-compose` |
| Text-to-image, multi-candidate generation, fresh creation | `vibecanvas-image-generate` |
| Source/reference/mask/annotation-driven editing of an existing image | `vibecanvas-image-edit` |
| Candidate comparison, semantic review, repair direction, finalize | `vibecanvas-creative-review` |

If the request cuts across several (e.g. "refactor the workflow and regenerate two candidates"), execute them in dependency order rather than interleaving tool calls from multiple skills.

## Default operating sequence

Use this skeleton for any non-trivial task. Each step references the exact MCP tool, its required inputs, and what to read from its return.

1. **Anchor to the workspace.**
   - Call `get_workspace_context` with `{}`.
   - Read `projectDir`, `databaseFile`, and `graphRevision` from the structured return. Use `graphRevision` as `baseRevision` for every subsequent patch in this turn.

2. **Read what the user is pointing at.**
   - Call `get_selection_context` with `{}`.
   - Read `selectedNodes[].id` and `selectedNodes[].data.nodeType`. These IDs are your edit targets. If `selectedNodes` is empty, fall back to reading the whole graph (step 3) and asking the user to clarify the target.

3. **Read the whole graph only when you need topology.**
   - Call `get_graph` with `{}`.
   - Use the returned `nodes[]`, `edges[]`, `revision`, `mode` for planning. Do **not** PUT the whole graph back; you'll clobber concurrent edits.

4. **Look up node types before adding unfamiliar ones.**
   - Call `get_node_registry` with `{}` (or `{ category: 'generation' }` for a slice).
   - Each entry gives `inputs[]`, `outputs[]`, `configFields[]` with their handle IDs. Use those handle IDs verbatim when constructing `connect` operations.

5. **Mutate via patches, never full rewrites.**
   - Call `apply_graph_patch` with:
     ```json
     { "transactionId": "<unique-string>", "baseRevision": <from step 1>, "operations": [ ... ] }
     ```
   - The response returns the new `revision` — use it as `baseRevision` for the next patch in the same turn.
   - On a `REVISION_CONFLICT` error, re-read the graph, preserve unrelated edits, rebuild a narrow patch, retry once.

6. **Validate after structural edits.**
   - Call `validate_graph` with `{}` after adding/removing nodes or edges.
   - If `valid === false`, read `problems[].message`, fix with another patch, validate again. Do not start a run on an invalid graph.

7. **Queue runs asynchronously.**
   - Full graph: `start_run` (alias: `run_graph`) with `{}`. Returns `{ runId, status, graphRevision }` immediately.
   - Partial: `run_to_node` with `{ nodeId: "<target>" }`. Runs that node and its ancestors only.
   - **Never** block on the MCP call waiting for image generation to finish. The tool returns instantly by design.

8. **Poll until completion.**
   - Loop on `get_run_status` with `{ runId }` every ~1s (or use `get_run_events` with `{ runId, afterSeq }` for incremental event history).
   - Terminal statuses: `completed`, `failed`, `cancelled`, `needs-input`. Stop polling once you hit one.

9. **Handle human-in-the-loop pauses.**
   - When status is `needs-input`, a `control.human-select` node is waiting for the user to pick a candidate.
   - Surface the candidate list to the user, let them choose, then call `resolve_human_selection` with `{ runId, nodeId, artifactId }`. The run auto-resumes.

10. **Confirm completion by inspecting artifacts.**
    - Call `list_artifacts` with `{ status: 'selected' }` or `{ status: 'final' }` to find the deliverables.
    - Call `inspect_artifact` with `{ artifactId }` to read lineage, parents, and metadata before claiming the task is done.

## Template reuse (often forgotten)

VibeCanvas ships reusable graph templates. Use them instead of hand-building common workflows:

- `list_templates` `{}` → returns `{ id, name, category, description }[]`.
- `apply_template` `{ templateId }` → replaces the current graph with the template in a single revision-controlled transaction. Returns the new `revision`. **Warn the user before applying** — it overwrites the current design.

## Revision discipline (hard rules)

- Never rewrite the complete graph from a stale snapshot. Always patch.
- Every `apply_graph_patch` call must carry the latest `baseRevision` you've seen.
- On conflict: re-read → preserve → narrow-patch → retry once. Do not retry in a loop.
- Keep `transactionId` unique per attempt; reusing it makes the conflict log unreadable.

## Run discipline

- Do not synchronously wait inside an MCP tool call for the image API. Use the async run + poll pattern.
- If the user cancels, call `cancel_run` `{ runId }`. Cancellation propagates an `AbortController` all the way to the in-flight image HTTP request.
- A cancelled upstream request may already have been billed by the provider. Do not promise billing reversal.

## Safety

- Never expose API keys, provider headers, or LLM credentials in prompts, commits, or run metadata.
- Check provider capabilities (`get_provider_capabilities`) before requesting masks, multi-reference edits, or large candidate counts — unsupported capabilities will fail at run time, not at patch time.
- Keep workflows acyclic. Retries are bounded executor behavior, not graph loops.
- Preserve candidate and source Artifacts unless deletion is explicitly requested.

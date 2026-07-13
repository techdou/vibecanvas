# Troubleshooting

## Node version or SQLite warning

VibeCanvas requires Node 22.5 or later:

```bash
node --version
npm run doctor
```

An ExperimentalWarning for `node:sqlite` may appear on Node 22. It is not a database failure.

## Web and MCP appear to use different provider settings

Both must receive the same config path. Check:

```text
VIBECANVAS_CONFIG_FILE
```

The OpenCode installer writes it automatically. Restart Web and MCP after provider changes.

## Revision conflict

A 409 means another Web/MCP/Agent operation changed the graph. Reload `get_graph` or `/api/graph`, rebuild the patch with the new `baseRevision`, and apply only the intended operations.

## Run remains queued

- confirm the server or MCP worker is running;
- inspect `/api/runs/<id>` or `get_run_status`;
- check `npm run doctor`;
- ensure the SQLite database is writable.

Expired running leases are recovered on process restart.

## Run needs input

Open the Candidate Selector in the Web UI or call `resolve_human_selection` with the paused node and one candidate Artifact ID.

## Cancelled but relay billing occurred

Cancellation prevents VibeCanvas from registering and placing late outputs. It cannot guarantee reversal after an upstream relay has already accepted a billed request.

## Image generation is disabled

Open Provider Settings or set the shared config. Then restart. Check:

```bash
npm run doctor
```

## Relay 404

Verify `baseUrl`, `generatePath`, `editPath`, and model alias. Avoid including `/images/generations` in both the base URL and path.

## Relay rejects `image[]`

Change `editImageField` to `image` in Provider Settings or use:

```dotenv
IMAGE_API_EDIT_IMAGE_FIELD=image
```

## Generated URL is blocked

VibeCanvas blocks private URLs by default. Prefer Base64 output or public HTTPS URLs. For a trusted local relay, enable private URLs explicitly and preferably set an allowed host list.

## Mask rejected

The mask must:

- be readable;
- match the source width and height exactly;
- contain an alpha channel;
- be under 50MB.

Create it through the built-in Mask Editor.

## MCP tools do not appear

```bash
npm run build
npm run probe:mcp
```

Then reopen the Agent conversation.

## Browser visual automation fails in a sandbox

Some containers block localhost browser navigation even when API requests work. Verify production assets with `npm run build`, start the server, test `/api/health`, and perform a local desktop browser check outside the restricted sandbox.

# Security

## Local-first default

The server binds to `127.0.0.1` by default and has no multi-tenant authentication. Do not expose it directly to the public Internet.

## Secrets

- Image API keys, custom headers, protected download headers, and OpenCode passwords live in the shared user config or environment.
- They are not placed in graph snapshots, Artifacts, browser storage, examples, or release ZIPs.
- Config responses redact keys and secret-like headers.
- The config file is created with owner-only mode where the operating system supports POSIX permissions.

## File boundaries

- Artifact reads use indexed IDs, not arbitrary browser-supplied file paths.
- User uploads are sanitized and stored under the project data directory.
- Release packages exclude `.env`, `.vibecanvas`, and user project files.

## Remote image URLs

Generated URL downloads:

- accept HTTP/HTTPS only;
- reject credentials embedded in URLs;
- manually validate every redirect target;
- block loopback, private, link-local, multicast, IPv4-mapped IPv6, and local addresses by default;
- optionally restrict hosts to an allowlist;
- limit response size.

`allowPrivateImageUrls=true` should only be used for a trusted local relay.

## Workflow safety

- graph cycles are rejected;
- candidate and reference counts are bounded by provider profiles;
- expensive execution is asynchronous and cancellable;
- graph mutation requires a current revision;
- run snapshots prevent stale runners from overwriting current designs.

## Public deployment requirements

Add an authenticated reverse proxy, TLS, CSRF protection, explicit CORS origins, per-user project isolation, request quotas, and secret management before remote deployment.

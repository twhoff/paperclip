---
name: paperclip-ctx-auth
description: "Authenticate to the Paperclip API in authenticated deployment mode. Use when making API calls that return 'Board access required', '401 Agent authentication required', or other auth errors. Covers minting local agent JWTs, board session auth, and the `paperclip_context_mode_request.mjs` helper for `ctx_execute`. Triggers: `deploymentMode: authenticated`, curl/fetch returning 401/403, `PAPERCLIP_API_KEY` unusable, pausing or managing agents via API, any Paperclip REST call needing auth."
---

# Paperclip ctx auth

Use this skill when `ctx_execute` needs to call the local Paperclip API in authenticated dev mode.
This is an injected file-backed skill, not a callable tool. In Codex runtimes, Paperclip exposes it by linking the skill directory into the active workspace under `.agents/skills/paperclip-ctx-auth`. Use the helper script from that directory via `import(...)`.

The key point: inside `ctx_execute`, `PAPERCLIP_API_KEY` may be the fallback `pcli-local`. In authenticated mode that fails. Mint a real local agent JWT inside the sandbox instead.

## Quick start

Import the bundled helper from `ctx_execute`:

```javascript
const { paperclipRequest } =
  await import('file:///absolute/path/to/.agents/skills/paperclip-ctx-auth/scripts/paperclip_context_mode_request.mjs')

const { response, runId, identity } = await paperclipRequest('/agents/me')
const body = await response.json()
console.log(JSON.stringify({ status: response.status, runId, identity, body }, null, 2))
```

If you are working from a worktree, change the absolute prefix but keep the `.agents/skills/paperclip-ctx-auth/...` suffix.

## Workflow

1. Confirm the server is reachable:

```javascript
const res = await fetch('http://localhost:3100/api/health')
console.log(await res.text())
```

2. If the health response shows `deploymentMode: authenticated`, do not rely on `PAPERCLIP_API_KEY=pcli-local`.

3. Import `scripts/paperclip_context_mode_request.mjs` and call `paperclipRequest('/path')`.

4. If you already know the agent identity, pass it explicitly:

```javascript
const result = await paperclipRequest('/agents/me', {
  identity: {
    agentId: '...',
    companyId: '...',
    adapterType: 'codex_local'
  }
})
```

5. If identity is not provided, the canonical helper resolves it from `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_ADAPTER_TYPE`. If any of the three is missing it throws — pass `identity` explicitly or set the env vars. The legacy helper at `scripts/paperclip_request.mjs` retains a `psql`-based DB fallback for non-sandboxed contexts where setting env vars is not practical; do not use it from `ctx_execute`.

## What the helper does

`scripts/paperclip_context_mode_request.mjs`:

- reads `PAPERCLIP_AGENT_JWT_SECRET` from the local Paperclip instance env file
- mints the same HS256 JWT shape as `server/src/agent-auth-jwt.ts`
- sets `Authorization: Bearer <jwt>`
- sets `X-Paperclip-Run-Id`
- sends the request to `PAPERCLIP_API_URL` or `http://localhost:3100/api`
- caches JWT config, API base, and resolved identity at module level — first call hits disk, subsequent calls in the same Node process reuse the cached values

## Local assumptions

- The local Paperclip instance env file is at `~/.paperclip/instances/<instance>/.env`
- Default instance is `default`
- Local DB defaults (only used by the legacy `paperclip_request.mjs` fallback):
  - host `127.0.0.1`
  - port `54329`
  - db `paperclip`
  - user `paperclip`
  - password `paperclip`

These can be overridden by env vars already visible to `ctx_execute`.

## Failure handling

- `401 Agent authentication required`
  Use this skill and mint the JWT inside `ctx_execute`.

- `PAPERCLIP_AGENT_JWT_SECRET missing`
  Check the local Paperclip instance env file and repair the Paperclip setup if needed.

- `Identity env vars missing. Set PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, and PAPERCLIP_ADAPTER_TYPE…`
  Pass `identity` explicitly or set the three env vars before importing the helper.

- `No active agent found for adapter_type=codex_local` (legacy helper only)
  The deprecated `paperclip_request.mjs` falls back to a DB lookup when env vars are missing; this fires when no matching agent row exists.

- `404 Not Found`
  Check the API base URL. For local Paperclip it is typically `http://localhost:3100/api`.

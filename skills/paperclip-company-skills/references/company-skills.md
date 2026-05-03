# Company Skills Workflow

Use this reference when a board user, CEO, or manager asks you to find a skill, install it into the company library, or assign it to an agent.

## What Exists

- Company skill library: install, inspect, update, and read imported skills for the whole company.
- Agent skill assignment: add or remove company skills on an existing agent.
- Hire/create composition: pass `desiredSkills` when creating or hiring an agent so the same assignment model applies immediately.

The canonical model is:

1. install the skill into the company
2. assign the company skill to the agent
3. optionally do step 2 during hire/create with `desiredSkills`

## Permission Model

- Company skill reads: any same-company actor
- Company skill mutations: board, CEO, or an agent with the effective `agents:create` capability
- Agent skill assignment: same permission model as updating that agent

## Core Endpoints

- `GET /api/companies/:companyId/skills`
- `GET /api/companies/:companyId/skills/:skillId`
- `POST /api/companies/:companyId/skills/import`
- `POST /api/companies/:companyId/skills/scan-projects`
- `POST /api/companies/:companyId/skills/:skillId/install-update`
- `GET /api/agents/:agentId/skills`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`

## Install A Skill Into The Company

Import using a **skills.sh URL**, a key-style source string, a GitHub URL, or a local path.

### Source types (in order of preference)

| Source format        | Example                                                      | When to use                                                                                                         |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **skills.sh URL**    | `https://skills.sh/google-labs-code/stitch-skills/design-md` | When a user gives you a `skills.sh` link. This is the managed skill registry — **always prefer it when available**. |
| **Key-style string** | `google-labs-code/stitch-skills/design-md`                   | Shorthand for the same skill — `org/repo/skill-name` format. Equivalent to the skills.sh URL.                       |
| **GitHub URL**       | `https://github.com/vercel-labs/agent-browser`               | When the skill is in a GitHub repo but not on skills.sh.                                                            |
| **Local path**       | `/abs/path/to/skill-dir`                                     | When the skill is on disk (dev/testing only).                                                                       |

**Critical:** If a user gives you a `https://skills.sh/...` URL, use that URL or its key-style equivalent (`org/repo/skill-name`) as the `source`. Do **not** convert it to a GitHub URL — skills.sh is the managed registry and the source of truth for versioning, discovery, and updates.

### Example: skills.sh import (preferred)

```javascript
const { paperclipRequest } =
  await import("file:///path/to/paperclip-ctx-auth/scripts/paperclip_context_mode_request.mjs");
const { identity } = await paperclipRequest("/agents/me").then((r) => r);

await paperclipRequest(`/companies/${identity.companyId}/skills/import`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source: "https://skills.sh/google-labs-code/stitch-skills/design-md" }),
});
```

Or equivalently using the key-style string:

```javascript
await paperclipRequest(`/companies/${identity.companyId}/skills/import`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source: "google-labs-code/stitch-skills/design-md" }),
});
```

### Example: GitHub import

```javascript
await paperclipRequest(`/companies/${identity.companyId}/skills/import`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source: "https://github.com/vercel-labs/agent-browser" }),
});
```

You can also use source strings such as:

- `google-labs-code/stitch-skills/design-md`
- `vercel-labs/agent-browser/agent-browser`
- `npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser`

If the task is to discover skills from the company project workspaces first:

```javascript
await paperclipRequest(`/companies/${identity.companyId}/skills/scan-projects`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
```

## Inspect What Was Installed

```javascript
const { response } = await paperclipRequest(`/companies/${identity.companyId}/skills`);
const skills = await response.json();
```

Read the skill entry and its `SKILL.md`:

```javascript
const { response: skillRes } = await paperclipRequest(
  `/companies/${identity.companyId}/skills/${skillId}`
);
const { response: fileRes } = await paperclipRequest(
  `/companies/${identity.companyId}/skills/${skillId}/files?path=SKILL.md`
);
```

## Assign Skills To An Existing Agent

`desiredSkills` accepts:

- exact company skill key
- exact company skill id
- exact slug when it is unique in the company

The server persists canonical company skill keys.

```javascript
await paperclipRequest(`/agents/${agentId}/skills/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ desiredSkills: ["vercel-labs/agent-browser/agent-browser"] }),
});
```

If you need the current state first:

```javascript
const { response } = await paperclipRequest(`/agents/${agentId}/skills`);
```

## Include Skills During Hire Or Create

Use the same company skill keys or references in `desiredSkills` when hiring or creating an agent:

```javascript
await paperclipRequest(`/companies/${identity.companyId}/agent-hires`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "QA Browser Agent",
    role: "qa",
    adapterType: "codex_local",
    adapterConfig: { cwd: "/abs/path/to/repo" },
    desiredSkills: ["agent-browser"],
  }),
});
```

For direct create without approval:

```javascript
await paperclipRequest(`/companies/${identity.companyId}/agents`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "QA Browser Agent",
    role: "qa",
    adapterType: "codex_local",
    adapterConfig: { cwd: "/abs/path/to/repo" },
    desiredSkills: ["agent-browser"],
  }),
});
```

## Notes

- Built-in Paperclip runtime skills are still added automatically when required by the adapter.
- If a reference is missing or ambiguous, the API returns `422`.
- Prefer linking back to the relevant issue, approval, and agent when you comment about skill changes.
- Use company portability routes when you need whole-package import/export, not just a skill:
  - `POST /api/companies/:companyId/imports/preview`
  - `POST /api/companies/:companyId/imports/apply`
  - `POST /api/companies/:companyId/exports/preview`
  - `POST /api/companies/:companyId/exports`
- Use skill-only import when the task is specifically to add a skill to the company library without importing the surrounding company/team/package structure.

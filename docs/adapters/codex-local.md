---
title: Codex Local
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- `OPENAI_API_KEY` set in the environment or agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Codex model to use. Defaults to `gpt-5.5` |
| `effort` | string | No | Reasoning effort override passed as `model_reasoning_effort` when supported |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Models And Effort

Curated Codex Local choices:

| Model | Effort choices |
|-------|----------------|
| `gpt-5.5` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-mini` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.3-codex` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.3-codex-spark` | Leave unset; effort support is undocumented |
| `gpt-5.2` | `none`, `low`, `medium`, `high`, `xhigh` |

Legacy saved values such as `gpt-5` or `minimal` remain readable for existing configs, but they are not curated choices and adapter switching will not introduce them.

## Adapter Switching Remapping

When switching between `codex_local` and `copilot_cli`, `claude_local`, or `oz_local`, the UI uses canonical model and effort helpers. It preserves only real supported semantic equivalents and clears invalid combinations.

- `codex_local` <-> `copilot_cli`: shared GPT models preserve where both adapters support them. Unsupported efforts such as Codex `none`, or `xhigh` on Copilot `gpt-5.2`, are cleared.
- `codex_local` <-> `claude_local`: no model equivalence exists, so the target adapter default model is used. Shared effort levels such as `low`, `medium`, `high`, and `xhigh` preserve where supported; Claude `max` and `ultracode` do not map to Codex.
- `codex_local` <-> `oz_local`: only real Oz equivalents map. Codex `gpt-5.4` with `high` maps to Oz `gpt-5-4-high`, and back to Codex `gpt-5.4` with `high`. Oz has no separate effort field.

Adapter pairs that do not involve `codex_local` are unchanged by this remapping.

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run

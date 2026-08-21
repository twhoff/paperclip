# ADR-025: context-mode MCP Server — Copilot CLI Adapter Fix

**Status:** Accepted  
**Date:** 2026-03-22  
**Author:** CEO  
**Related issue:** TIZA-150

---

## Context

Tizzi uses two agent runtime adapters:

| Adapter                      | Used by                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `copilot_cli` (native)       | All agents running inside the Paperclip heartbeat runtime |
| `vscode-copilot` (emulation) | Agents running locally via `pcli` / VS Code Copilot Chat  |

The `context-mode` MCP server reduces token consumption by routing large tool outputs through a sandboxed subprocess. Without it, a single `cat`, `ls -la`, or `grep` result can dump 56 KB+ directly into the agent context window, degrading reasoning quality and inflating monthly costs.

### The problem

As of 2026-03-22, context-mode was **not functioning correctly for the Copilot CLI (native) adapter** because:

1. `.github/hooks/context-mode.json` used bare `context-mode hook vscode-copilot pretooluse` for the `PreToolUse` hook — no curl bypass.
2. The Claude adapter (`~/.claude/settings.json`) had already solved this with a dedicated wrapper script (`scripts/context-mode/pretooluse-wrapper.sh`), but the equivalent was never created for the Copilot adapter.
3. Result: Paperclip API calls via `curl $PAPERCLIP_API_URL` were blocked by context-mode, because `PAPERCLIP_*` env vars **only exist in Bash** — they cannot be passed into the context-mode sandbox.

Monthly spend had reached $162+ with 5 active agents. Token cost reduction is a hard business priority.

---

## Decision

Create dedicated wrapper scripts for the Copilot CLI adapter that mirror the Claude adapter pattern:

### 1. `scripts/context-mode/pretooluse-wrapper-copilot.sh`

Bash wrapper that:

- Parses the `tool_name` and `command` from the PreToolUse hook stdin
- **Bypasses** context-mode routing for any `curl`/`wget` command targeting `localhost`, `127.0.0.1`, or `$PAPERCLIP_API_URL`
- **Delegates** everything else to `context-mode hook vscode-copilot pretooluse`

### 2. `scripts/context-mode/sessionstart-wrapper-copilot.sh`

Bash wrapper that:

- Calls `context-mode hook vscode-copilot sessionstart`
- **Injects** a `<paperclip_api_exception>` block into the context window protection message, explaining that `curl` to `$PAPERCLIP_API_URL` is allowed and required

### 3. `.github/hooks/context-mode.json`

Updated to use the new wrappers for `PreToolUse` and `SessionStart`. `PostToolUse` continues to call the bare context-mode hook (no modification needed).

---

## Implementation

Files changed:

- **Created**: `scripts/context-mode/pretooluse-wrapper-copilot.sh`
- **Created**: `scripts/context-mode/sessionstart-wrapper-copilot.sh`
- **Updated**: `.github/hooks/context-mode.json`
- **Updated**: `agents/CONTEXT-MODE-RULES.md` — header updated to apply to all adapters, not just native

### Verification

All the following were manually tested and confirmed working:

| Test                             | Expected                              | Result  |
| -------------------------------- | ------------------------------------- | ------- |
| `curl http://localhost:3100/...` | Passthrough (empty hook output)       | ✅ PASS |
| `curl $PAPERCLIP_API_URL/...`    | Passthrough (empty hook output)       | ✅ PASS |
| `ls -la /etc` (large bash)       | context-mode routing hint             | ✅ PASS |
| ctx_execute (shell)              | Runs in sandbox, stdout in context    | ✅ PASS |
| ctx_execute (javascript)         | Runs in sandbox, stdout in context    | ✅ PASS |
| ctx_execute_file                 | Passthrough (tool is the destination) | ✅ PASS |
| ctx_batch_execute                | Passthrough (tool is the destination) | ✅ PASS |
| ctx_index                        | Passthrough (tool is the destination) | ✅ PASS |
| ctx_search                       | Passthrough (tool is the destination) | ✅ PASS |
| ctx_fetch_and_index              | Passthrough (tool is the destination) | ✅ PASS |
| SessionStart injection           | Paperclip API exception injected      | ✅ PASS |

---

## Consequences

### Positive

- context-mode now works correctly for both adapter types
- Agents will stop dumping large outputs into context window
- Token costs expected to decrease significantly over next billing cycle
- Paperclip API calls via `curl` continue to work without modification

### Negative / watch items

- Wrapper scripts are absolute-path (`bash /Users/twhoffmann/...`) in `.github/hooks/context-mode.json` — this is specific to the current host. If the project is moved or used by a different user, the path must be updated.

---

## Alternatives Considered

### Use context-mode bash policy (allow-list)

context-mode supports a `.claude/settings.json` `permissions.allow` list. We could use `Bash(curl $PAPERCLIP_API_URL*)` as an allow pattern. Rejected: this requires a `.claude/settings.json` file which is Claude-specific and does not work for the vscode-copilot adapter's hook.

### Patch context-mode routing core

Could modify the routing logic to have a built-in exception for Paperclip URLs. Rejected: this would require maintaining a fork of context-mode and would break on upgrades.

---

## References

- `agents/CONTEXT-MODE-RULES.md` — mandatory routing rules for all agents
- `scripts/context-mode/pretooluse-wrapper.sh` — the Claude adapter equivalent (reference implementation)
- `scripts/context-mode/pretooluse-wrapper-copilot.sh` — this fix
- `.github/hooks/context-mode.json` — Copilot CLI hook configuration

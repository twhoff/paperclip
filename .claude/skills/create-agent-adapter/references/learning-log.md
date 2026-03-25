# Adapter Creation Learning Log

Hard-won lessons from building real adapters. Read this before starting a new adapter to avoid repeating known mistakes.

## 2026-03-25 — oz_local adapter (Oz CLI, local mode)

### Hidden UI Registration Gates

The SKILL.md documents three registries (server, UI, CLI) but there are **seven total registration points** required for a new adapter to be fully visible. Missing any one causes the adapter to silently not appear in the UI:

1. **`packages/shared/src/constants.ts`** — `AGENT_ADAPTER_TYPES` array. This is the typed union (`AgentAdapterType`) that all layers reference. If missing here, the adapter type is not a valid value at the type level.

2. **`server/src/adapters/registry.ts`** — `adaptersByType` map. Server-side execution, environment tests, model listing.

3. **`ui/src/adapters/registry.ts`** — `uiAdapters` array. Transcript parser, config builder, config fields component.

4. **`cli/src/adapters/registry.ts`** — `adaptersByType` map. Terminal output formatting for `paperclipai run --watch`.

5. **`ui/src/components/AgentConfigForm.tsx`** — TWO separate gates:
   - `ENABLED_ADAPTER_TYPES` (line ~994) — Controls whether the adapter appears as selectable vs "Coming soon" in the adapter dropdown. If missing, the adapter shows greyed out.
   - `isLocal` check (line ~304) — Controls visibility of local adapter features: prompt template field, working directory field, permissions section, model dropdown, thinking effort. If missing, the adapter form will be missing most fields.

6. **`ui/src/pages/NewAgent.tsx`** — `SUPPORTED_ADVANCED_ADAPTER_TYPES` set (line ~31). Controls whether the adapter appears when navigating to `/agents/new?adapterType=<type>`. If missing, the URL preset is silently ignored.

7. **`ui/src/components/NewAgentDialog.tsx`** — `ADVANCED_ADAPTER_OPTIONS` array and `AdvancedAdapterType` union. This is the "Add a new agent" modal card grid. If missing, the adapter won't appear in the quick-create dialog.

8. **`ui/src/components/OnboardingWizard.tsx`** — `AdapterType` union, `isLocalAdapter` check, and the "More Agent Adapter Types" card array. If missing, the adapter won't appear during first-run onboarding.

9. **`ui/src/pages/AgentDetail.tsx`** — `isLocal` check in the `PromptsTab` component (~line 1603). Controls whether the Instructions tab shows the bundle editor or the "only available for local adapters" message.

**Also update these secondary touchpoints:**
- `ui/src/components/agent-config-primitives.tsx` — `adapterLabels` record. Maps adapter type to human-readable label for the dropdown.
- `AgentConfigForm.tsx` command placeholder ternary (~line 696) — Controls the placeholder text in the Command field (e.g. "oz", "claude", "codex").
- `OnboardingWizard.tsx` `effectiveAdapterCommand` (~line 205) — Same command mapping for the onboarding wizard.
- `OnboardingWizard.tsx` debug command and auth hint sections (~line 1052) — Adapter-specific manual debug commands and auth instructions shown when environment test fails.

**Also add the workspace dependency:**
- `server/package.json`, `ui/package.json`, `cli/package.json` — each must have `"@paperclipai/adapter-<name>": "workspace:*"` in dependencies. Without this, the imports fail at typecheck time even though the adapter package exists.

### Non-JSON Stdout Adapters

Not all agent CLIs produce structured JSON output. Oz's `oz agent run` streams interactive terminal output (with ANSI codes, progress indicators, etc.) — not JSON-line events.

**Design pattern for raw-text adapters:**
- UI parser: return `[{ kind: "stdout", ts, text: line }]` for every line. This is explicitly supported and passes raw output verbatim to the run transcript panel.
- Server parser: use regex-based best-effort extraction for session IDs and errors from the raw text. Accept that this is fragile and document the limitation.
- CLI formatter: print lines as-is, optionally with a debug prefix.
- No usage/cost tracking is possible when the CLI doesn't expose token counts.
- Session persistence depends on the CLI printing identifiable session/conversation references in its output.

**Tradeoff:** Raw-text adapters work immediately but provide a meaningfully different UX from structured adapters (no tool_call/assistant/result breakdown in the transcript). Document this clearly in `agentConfigurationDoc`.

### Dynamic Model Discovery

When the agent runtime has a large, frequently-changing model catalogue (Oz has ~50 models), implement `listModels()` that shells out to the CLI's model list command. Key points:
- Use `--output-format json` if the CLI supports it
- Always fall back to the static `models` array on error/timeout
- Set a reasonable timeout (15s) since this runs during agent creation form load
- The server registry uses `listModels` for dynamic discovery with `models` as static fallback

### Session Primitives Vary by Runtime

Different agent runtimes use different session concepts:
- Claude Code: `--resume <sessionId>` with session IDs from `system.init` events
- Gemini CLI: `--resume <sessionId>` with session IDs from JSON stream
- Oz CLI: `--conversation <id>` with conversation IDs (may be extracted from URLs in stdout)
- Codex: `previous_response_id` chaining

The session codec should store the runtime's native session identifier plus `cwd` for cross-project contamination prevention. Use field name aliasing in deserialize (e.g. accept both `conversationId` and `conversation_id`) for resilience.

### Hiding Thinking Effort for Combined Model/Effort Handles

Some agent runtimes encode the effort level directly in the model ID (e.g. Oz uses `claude-4-6-sonnet-max`, `gpt-5-4-high`, `auto-genius`). In these cases, showing a separate "Thinking Effort" dropdown is redundant and confusing.

Add the adapter type to the `showThinkingEffort` exclusion in `AgentConfigForm.tsx` (~line 418):

```ts
const showThinkingEffort =
  adapterType === "gemini_local" || adapterType === "oz_local"
    ? false
    : // ... other adapter-specific logic
```

This pattern already exists for `gemini_local`. Any adapter where the model selector already captures effort should be added here.

### Custom Icon Components

Adapters with brand logos should use a dedicated SVG icon component (e.g. `OzLogoIcon.tsx`, `OpenCodeLogoIcon.tsx`) rather than generic Lucide icons. Place these in `ui/src/components/` and import them in:
- `NewAgentDialog.tsx` adapter card array
- `OnboardingWizard.tsx` adapter card array
- The `icon` field takes `ComponentType<{ className?: string }>` so custom SVG components work directly

### supportsLocalAgentJwt Must Be true for Local Adapters

**Impact:** Silent, total auth failure in `authenticated` deployment mode (e.g. `pnpm dev:tailscale`). Agents run but cannot call the Paperclip API.

In the server adapter registry (`server/src/adapters/registry.ts`), every local CLI adapter must set `supportsLocalAgentJwt: true`. This single boolean controls whether the heartbeat service mints a short-lived JWT and injects it as `PAPERCLIP_API_KEY` into the agent's environment.

When set to `false`:
- The heartbeat service skips `createLocalAgentJwt()` entirely — no `authToken` is passed to the adapter
- The adapter's `execute.ts` receives `authToken: undefined` and does not set `PAPERCLIP_API_KEY`
- `pcurl` falls back to the `pcli-local` token, which only works in `local_trusted` mode
- In `authenticated` mode, every API call returns 401/403
- The agent spends its entire run trying to authenticate, burning credits on debugging instead of work

**This failure is silent at the server level.** The only signal is a warning log: `"local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY"`. But when the flag is `false`, no warning is logged at all — the server intentionally skips JWT minting.

**The fix is one line:**
```ts
const myAdapter: ServerAdapterModule = {
  // ...
  supportsLocalAgentJwt: true,  // CRITICAL: must be true for authenticated mode
};
```

**Testing:** After setting this, verify by running an agent with `pnpm dev:tailscale` and checking the run logs for `PAPERCLIP_API_KEY set: yes` (or `pcurl /api/agents/me` returning agent data instead of `error: Agent authentication required`).

### Skill Placement: .claude/skills/ vs skills/

Paperclip has two separate skill directories with different purposes:

1. **`.claude/skills/`** (or `.agents/skills/`) — **Maintainer skills.** These are for human developers using Claude Code (or other coding agents) to work on the repo itself. They are NOT auto-synced to agent runtimes. Examples: `create-agent-adapter`, `release`, `doc-maintenance`.

2. **`skills/`** (repo root) — **Runtime skills.** These are auto-synced to agent runtime environments (e.g. `~/.warp/skills/` for Oz, tmpdir for Claude Code) by adapter `execute.ts` before every run. The adapter's `listPaperclipSkillEntries()` scans this directory. Examples: `paperclip`, `paperclip-create-agent`, `tailscale-jwt-auth`.

If you create a skill that agents need at runtime (troubleshooting guides, API procedures, workflow instructions), it **must** go in `skills/`. If you create a skill for developers maintaining the codebase, it goes in `.claude/skills/`.

**Common mistake:** Creating a runtime skill in `.claude/skills/` and wondering why agents can't find it. The auto-sync only reads from `skills/`. A skill can exist in both locations if it serves both audiences.

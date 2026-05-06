export const type = "claude_local";
export const label = "Claude Code (local)";

export const models = [
  { id: "claude-opus-4-7[1m]", label: "Claude Opus 4.7 (1M context)" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-6[1m]", label: "Claude Sonnet 4.6 (1M context)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high|xhigh|max)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to claude
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): workspace runtime service intents; local host-managed services are realized before Claude starts and exposed back via context/env
- sessionPolicy (string, optional): "resume" (default) to reuse previous session, "always_fresh" to start a new session every run — useful for lightweight ping/health-check agents
- skipSkills (boolean, optional): when true, do not mount the Paperclip skills directory via --add-dir — useful for agents that need zero tooling context

Batch API fields (async execution, 50% cost discount):
- batchMode (string, optional): "never" | "smart" | "always". Default: "never".
  When "smart", routes eligible tasks to Anthropic Batch API (~24h latency, 50% cheaper).
  Requires ANTHROPIC_API_KEY. Bypasses Claude CLI — single-turn LLM response only.
- batchMaxWaitSec (number, optional): seconds to wait for batch result before falling back to sync. Default: 86400 (24h).
- batchFallbackOnError (boolean, optional): fall back to sync if batch fails. Default: true.
- batchMaxTokens (number, optional): max_tokens for batch requests. Default: 8192.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Advanced CLI flags:
- fallbackModel (string, optional): pass --fallback-model <model-id>. When the primary model is overloaded, Claude falls back to this model instead of failing the run. Recommended pairing: opus + opus-1m, or 1m + non-1m.
- maxBudgetUsd (number, optional): pass --max-budget-usd <amount>. Hard $ cap per run. Pairs well with maxTurnsPerRun for cost safety.
- includeHookEvents (boolean, optional): pass --include-hook-events. Surfaces PreToolUse / PostToolUse hook firings in the stream output for diagnostics.
- debugFile (string, optional): pass --debug-file <path>. Writes Claude's internal debug log to a file instead of polluting stdout/stderr.
- inputFormat (string, optional): "text" (default) or "stream-json". When "stream-json", the adapter sends the prompt as a stream-json envelope on stdin and adds --input-format stream-json + --replay-user-messages so user messages echo back for acknowledgement.

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Batch API mode is single-turn (no multi-turn agentic loops or tool callbacks). Best for analysis, reports, summarization, data processing.
- claude-opus-4-7 is a BURST-MODE-ONLY model. It must be switched off immediately after the task is successfully delivered.
  Use only for: critical-priority tasks, highly complex reasoning, or agents struggling to pass review gates.
`;

export const type = "codex_local";
export const label = "Codex (local)";
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true;

export const models = [
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
  { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
  { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
];

export const agentConfigurationDoc = `# codex_local agent configuration

Adapter: codex_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, optional): Codex model id
- effort (string, optional): reasoning effort override passed via -c model_reasoning_effort=...
  - gpt-5.6-sol, gpt-5.6-terra: low|medium|high|xhigh|ultra
  - gpt-5.6-luna: low|medium|high|xhigh|max
  - gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark: low|medium|high|xhigh
  Legacy aliases "modelReasoningEffort" and "reasoningEffort" are still accepted as read-only fallbacks until the pcli-b9o migration deletes them. Legacy saved values such as "none" and "minimal" remain readable but are not curated choices.
- promptTemplate (string, optional): run prompt template
- search (boolean, optional): run codex with --search
- dangerouslyBypassApprovalsAndSandbox (boolean, optional): run with bypass flag
- command (string, optional): defaults to "codex"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- bootstrapPromptTemplate (string, optional): one-time prompt prepended on fresh sessions (when no session to resume); supports the same template variables as promptTemplate
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): workspace runtime service intents; local host-managed services are realized before Codex starts and exposed back via context/env
- sessionPolicy (string, optional): "resume" (default) to reuse previous session, "always_fresh" to start a new session every run — useful for lightweight ping/health-check agents
- skipSkills (boolean, optional): when true, do not inject Paperclip skills into the workspace .agents/skills directory — useful for agents that need zero tooling context

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin (Codex receives "-" prompt argument).
- Paperclip injects desired local skills into the active workspace's ".agents/skills" directory at execution time so Codex can discover "$paperclip" and related skills without coupling them to the user's login home.
- Unless explicitly overridden in adapter config, Paperclip runs Codex with a per-company managed CODEX_HOME under the active Paperclip instance and seeds auth/config from the shared Codex home (the CODEX_HOME env var, when set, or ~/.codex).
- Some model/tool combinations reject certain effort levels. The UI filters curated choices by model, and legacy saved values are passed through only when already configured.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;

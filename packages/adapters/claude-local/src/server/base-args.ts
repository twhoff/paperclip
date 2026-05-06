/**
 * Base argv for `claude --print` invocations shared between the live execute path
 * and the hello-probe in test.ts. Keeping a single source of truth prevents the
 * two from drifting (the probe must use the same output format as the run so
 * `parseClaudeStreamJson` interprets both identically).
 *
 * `--include-partial-messages` and `--exclude-dynamic-system-prompt-sections`
 * are always-on: the first surfaces token-level chunks via onLog for live
 * runs (no downside in the probe — the parser ignores them), the second moves
 * cwd/env/git-status into the first user message so prompt-cache reuse works
 * across runs targeting the same workspace.
 */
export const CLAUDE_BASE_ARGS: readonly string[] = [
  "--print",
  "-",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--exclude-dynamic-system-prompt-sections",
];

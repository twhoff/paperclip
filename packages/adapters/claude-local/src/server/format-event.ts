/**
 * Stdout filter for the claude-local run log.
 *
 * The Claude CLI emits NDJSON to stdout. With `--include-partial-messages`
 * (always-on for this adapter), every token and tool-input fragment becomes
 * its own `stream_event` line. The full equivalent content arrives later
 * as a top-level `assistant` event with everything assembled, so the
 * partial chunks are pure noise and we suppress them here.
 *
 * Everything else is forwarded as-is so the UI's `parseClaudeStdoutLine`
 * (in `../ui/parse-stdout.ts`) can render the structured "Nice" transcript
 * view (system init, hook events, assistant text + tool_use blocks, user
 * tool_result blocks, result). Pre-formatting on the server would strip
 * the JSON structure the UI parser depends on.
 *
 * The captured `proc.stdout` (used by `parseClaudeStreamJson` after exit)
 * is unaffected — `runChildProcess` accumulates raw bytes independently of
 * `onLog`.
 */

type AdapterOnLog = (
  stream: "stdout" | "stderr",
  chunk: string,
) => Promise<void>;

/**
 * Decide whether a single Claude NDJSON line should appear in the run log.
 * Returns the line to emit (with the original JSON intact so the UI parser
 * can structure it) or null when the line should be suppressed.
 */
export function filterClaudeStreamLine(line: string): string | null {
  const trimmed = line.replace(/\r?\n$/, "");
  if (!trimmed.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Non-JSON output (rare — usually a paperclip-injected log line). Keep
    // it visible so we never silently swallow stderr-style messages that
    // claude prints to stdout.
    return trimmed;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return trimmed;
  }

  const type = (parsed as { type?: unknown }).type;
  if (type === "stream_event") return null;

  return trimmed;
}

/**
 * Wrap an onLog handler so stdout chunks are line-buffered and each line
 * is passed through `filterClaudeStreamLine`. Lines that survive the filter
 * are forwarded unchanged (with a trailing newline restored) so downstream
 * consumers — including the UI transcript parser — see the same NDJSON
 * stream they always have, just without the partial-message flood.
 *
 * stderr is forwarded unchanged. Call `flush()` once after the child
 * process exits to drain any final partial line that didn't end in a
 * newline.
 */
export function createClaudeLogFilter(onLog: AdapterOnLog): {
  onLog: AdapterOnLog;
  flush: () => Promise<void>;
} {
  let buffer = "";

  const emitLine = async (line: string) => {
    const kept = filterClaudeStreamLine(line);
    if (kept == null) return;
    await onLog("stdout", `${kept}\n`);
  };

  const wrapped: AdapterOnLog = async (stream, chunk) => {
    if (stream !== "stdout") {
      await onLog(stream, chunk);
      return;
    }
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      await emitLine(line);
      nl = buffer.indexOf("\n");
    }
  };

  const flush = async () => {
    if (buffer.length === 0) return;
    const remaining = buffer;
    buffer = "";
    await emitLine(remaining);
  };

  return { onLog: wrapped, flush };
}

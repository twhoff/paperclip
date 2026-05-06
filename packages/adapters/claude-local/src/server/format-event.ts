/**
 * Stream-line formatter for the claude-local run log.
 *
 * The Claude CLI emits NDJSON to stdout. With `--include-partial-messages`
 * (always-on for this adapter), every token and tool-input fragment becomes
 * a separate `stream_event` line. Surfacing them raw is unreadable, so this
 * formatter:
 *
 *   1. Suppresses noisy `stream_event` chunks (the partial deltas) — the
 *      complete assistant message already arrives later as a top-level
 *      `assistant` event with the same content cleanly assembled.
 *   2. Formats the meaningful events (`system`, `assistant`, `user`,
 *      `result`, `error`) into one line per logical unit.
 *   3. Falls back to the raw line for anything unrecognised, so the log
 *      never silently swallows new event types.
 *
 * The captured `proc.stdout` (used by `parseClaudeStreamJson` after exit)
 * is unaffected — `runChildProcess` accumulates raw bytes independently of
 * `onLog`.
 */

type AdapterOnLog = (
  stream: "stdout" | "stderr",
  chunk: string,
) => Promise<void>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function truncate(text: string, max = 280): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatSystem(event: Record<string, unknown>): string | null {
  const subtype = asString(event.subtype);
  if (subtype === "init") {
    const sessionId = asString(event.session_id) || asString(event.sessionId);
    const model = asString(event.model);
    const tools = Array.isArray(event.tools) ? (event.tools as unknown[]).length : null;
    const parts: string[] = [];
    if (sessionId) parts.push(`session=${sessionId}`);
    if (model) parts.push(`model=${model}`);
    if (tools !== null) parts.push(`tools=${tools}`);
    return `[claude] init ${parts.join(" ")}`.trimEnd();
  }
  if (subtype) return `[claude] system ${subtype}`;
  return null;
}

function formatContentBlock(block: Record<string, unknown>): string | null {
  const type = asString(block.type);
  if (type === "text") {
    const text = asString(block.text).trim();
    if (!text) return null;
    return `[assistant] ${truncate(text, 4000)}`;
  }
  if (type === "thinking") {
    const text = asString(block.thinking, asString(block.text)).trim();
    if (!text) return null;
    return `[thinking] ${truncate(text, 1000)}`;
  }
  if (type === "tool_use") {
    const name = asString(block.name, "tool");
    const input = block.input;
    let inputStr = "";
    if (input !== undefined) {
      try {
        inputStr = truncate(JSON.stringify(input), 600);
      } catch {
        inputStr = String(input);
      }
    }
    return `[tool_use ${name}]${inputStr ? ` ${inputStr}` : ""}`;
  }
  if (type === "tool_result") {
    const isError = block.is_error === true;
    const content = block.content;
    let body = "";
    if (typeof content === "string") body = content;
    else if (Array.isArray(content)) {
      body = content
        .map((part) => {
          const rec = asRecord(part);
          if (!rec) return "";
          return asString(rec.text) || asString(rec.content) || "";
        })
        .filter(Boolean)
        .join(" ");
    }
    return `[tool_result${isError ? " error" : ""}] ${truncate(body, 1000)}`.trimEnd();
  }
  return null;
}

function formatMessageBlocks(message: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const direct = asString(message.text).trim();
  if (direct) lines.push(`[assistant] ${truncate(direct, 4000)}`);
  const content = Array.isArray(message.content) ? message.content : [];
  for (const blockRaw of content) {
    const block = asRecord(blockRaw);
    if (!block) continue;
    const formatted = formatContentBlock(block);
    if (formatted) lines.push(formatted);
  }
  return lines;
}

function formatAssistant(event: Record<string, unknown>): string | null {
  const message = asRecord(event.message);
  if (!message) return null;
  const lines = formatMessageBlocks(message);
  return lines.length > 0 ? lines.join("\n") : null;
}

function formatUser(event: Record<string, unknown>): string | null {
  const message = asRecord(event.message);
  if (!message) return null;
  const direct = asString(message.text).trim() || asString(message.content).trim();
  if (direct) return `[user] ${truncate(direct, 600)}`;
  const content = Array.isArray(message.content) ? message.content : [];
  const textParts: string[] = [];
  const toolResults: string[] = [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type);
    if (type === "text") {
      const text = asString(part.text).trim();
      if (text) textParts.push(text);
    } else if (type === "tool_result") {
      const formatted = formatContentBlock(part);
      if (formatted) toolResults.push(formatted);
    }
  }
  const lines: string[] = [];
  if (textParts.length > 0) lines.push(`[user] ${truncate(textParts.join(" "), 600)}`);
  lines.push(...toolResults);
  return lines.length > 0 ? lines.join("\n") : null;
}

function formatResult(event: Record<string, unknown>): string {
  const subtype = asString(event.subtype, "result");
  const isError = event.is_error === true || subtype === "error" || subtype === "failed";
  const usage = asRecord(event.usage);
  const inputTokens = asNumber(usage?.input_tokens);
  const outputTokens = asNumber(usage?.output_tokens);
  const cachedTokens = asNumber(usage?.cache_read_input_tokens);
  const cost = asNumber(event.total_cost_usd, asNumber(event.cost_usd));
  const tokenSummary = `tokens in=${inputTokens} out=${outputTokens} cached=${cachedTokens}`;
  const costSummary = `cost=$${cost.toFixed(4)}`;
  const head = `[result] ${isError ? "ERROR " : ""}${subtype} ${tokenSummary} ${costSummary}`.trim();
  const resultText = asString(event.result).trim();
  if (resultText) return `${head}\n[final] ${truncate(resultText, 4000)}`;
  return head;
}

/**
 * Format one parsed Claude stream-json line for display in the run log.
 * Returns null when the line should be suppressed (no useful information
 * for a viewer — e.g. partial token deltas already covered by the eventual
 * full assistant message).
 */
export function formatClaudeStreamEvent(parsed: Record<string, unknown>): string | null {
  const type = asString(parsed.type);
  if (type === "system") return formatSystem(parsed);
  if (type === "assistant") return formatAssistant(parsed);
  if (type === "user") return formatUser(parsed);
  if (type === "result") return formatResult(parsed);
  if (type === "error") {
    const message =
      asString(parsed.message) ||
      asString(asRecord(parsed.error)?.message) ||
      "claude reported an error";
    return `[error] ${truncate(message, 600)}`;
  }
  // stream_event covers all the noisy partial-message chunks that arrive
  // because of --include-partial-messages. The full assistant content is
  // re-emitted as a top-level `assistant` event, so suppressing stream_event
  // loses no information.
  if (type === "stream_event") return null;
  return null;
}

/**
 * Parse a single NDJSON line and route through formatClaudeStreamEvent.
 * Falls back to the raw (truncated) line for un-parseable input so the
 * run log never silently swallows malformed output.
 */
export function formatClaudeStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(trimmed);
    parsed = asRecord(value);
  } catch {
    return truncate(trimmed, 600);
  }
  if (!parsed) return truncate(trimmed, 600);
  return formatClaudeStreamEvent(parsed);
}

/**
 * Wrap an onLog handler so stdout chunks are line-buffered, formatted via
 * formatClaudeStreamLine, and emitted only when the formatter returns a
 * non-null result. stderr is forwarded unchanged. Call the returned
 * `flush()` once after the child process exits to drain any final partial
 * line that did not end in a newline.
 */
export function createClaudeLogFilter(onLog: AdapterOnLog): {
  onLog: AdapterOnLog;
  flush: () => Promise<void>;
} {
  let buffer = "";

  const emitLine = async (line: string) => {
    const formatted = formatClaudeStreamLine(line);
    if (formatted == null) return;
    await onLog("stdout", `${formatted}\n`);
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

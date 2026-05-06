import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readHookName(parsed: Record<string, unknown>): string {
  return asString(parsed.hook_name) || asString(parsed.hook_event) || asString(parsed.hook_id) || "hook";
}

function parsePaperclipLine(line: string, ts: string): TranscriptEntry[] | null {
  if (!line.startsWith("[paperclip]")) return null;
  return [{ kind: "system", ts, text: line }];
}

function isAutoInjectedHook(name: string): boolean {
  // SessionStart fires on every prompt; logging it adds nothing useful.
  return name.startsWith("SessionStart");
}

function parseSystemEvent(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const subtype = asString(parsed.subtype);

  if (subtype === "init") {
    return [
      {
        kind: "init",
        ts,
        model: asString(parsed.model, "unknown"),
        sessionId: asString(parsed.session_id),
      },
    ];
  }

  // Suppress hook_started entirely — we only emit a single line on
  // hook_response so the transcript shows one row per hook lifecycle
  // instead of two (or three when multiple hooks fire concurrently).
  if (subtype === "hook_started") {
    return [];
  }

  if (subtype === "hook_response") {
    const name = readHookName(parsed);
    if (isAutoInjectedHook(name)) return [];
    const exitCode = asNumber(parsed.exit_code);
    if (exitCode > 0) {
      return [{ kind: "system", ts, text: `Hook failed: ${name} (exit ${exitCode})` }];
    }
    return [{ kind: "system", ts, text: `Hook: ${name} ✓` }];
  }

  if (subtype) {
    return [{ kind: "system", ts, text: `System: ${subtype}` }];
  }

  return [];
}

function parseRateLimitEvent(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const info = asRecord(parsed.rate_limit_info) ?? {};
  const status = asString(info.status);
  if (!status || status === "allowed") return [];

  const rateLimitType = asString(info.rateLimitType);
  const suffix = rateLimitType ? ` (${rateLimitType})` : "";
  return [{ kind: "system", ts, text: `Claude rate limit: ${status}${suffix}` }];
}

export function parseClaudeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const paperclipEntries = parsePaperclipLine(line, ts);
  if (paperclipEntries) return paperclipEntries;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  if (type === "system") {
    // Always return for system events — even when parseSystemEvent returns
    // [] (e.g. suppressed hook lifecycle pairs), so the line never falls
    // through to the raw stdout fallback.
    return parseSystemEvent(parsed, ts);
  }

  if (type === "rate_limit_event") {
    const entries = parseRateLimitEvent(parsed, ts);
    if (entries.length > 0) return entries;
    return [];
  }

  if (type === "assistant") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries: TranscriptEntry[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "assistant", ts, text });
      } else if (blockType === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        if (text) entries.push({ kind: "thinking", ts, text });
      } else if (blockType === "tool_use") {
        entries.push({
          kind: "tool_call",
          ts,
          name: typeof block.name === "string" ? block.name : "unknown",
          toolUseId:
            typeof block.id === "string"
              ? block.id
              : typeof block.tool_use_id === "string"
                ? block.tool_use_id
                : undefined,
          input: block.input ?? {},
        });
      }
    }
    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  if (type === "user") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries: TranscriptEntry[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "user", ts, text });
      } else if (blockType === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const isError = block.is_error === true;
        let text = "";
        if (typeof block.content === "string") {
          text = block.content;
        } else if (Array.isArray(block.content)) {
          const parts: string[] = [];
          for (const part of block.content) {
            const p = asRecord(part);
            if (p && typeof p.text === "string") parts.push(p.text);
          }
          text = parts.join("\n");
        }
        entries.push({ kind: "tool_result", ts, toolUseId, content: text, isError });
      }
    }
    if (entries.length > 0) return entries;
    // fall through to stdout for user messages without recognized blocks
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens = asNumber(usage.output_tokens);
    const cachedTokens = asNumber(usage.cache_read_input_tokens);
    const costUsd = asNumber(parsed.total_cost_usd);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(errorText).filter(Boolean) : [];
    const text = typeof parsed.result === "string" ? parsed.result : "";
    return [{
      kind: "result",
      ts,
      text,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      subtype,
      isError,
      errors,
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

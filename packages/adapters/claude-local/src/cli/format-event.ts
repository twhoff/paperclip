import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const obj = value as Record<string, unknown>;
  const message =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.error === "string" && obj.error) ||
    (typeof obj.code === "string" && obj.code) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function readHookName(parsed: Record<string, unknown>): string {
  return asString(parsed.hook_name) || asString(parsed.hook_event) || asString(parsed.hook_id) || "hook";
}

function formatRateLimitText(parsed: Record<string, unknown>): string | null {
  const info = asRecord(parsed.rate_limit_info) ?? {};
  const status = asString(info.status);
  if (!status || status === "allowed") return null;
  const rateLimitType = asString(info.rateLimitType);
  const suffix = rateLimitType ? ` (${rateLimitType})` : "";
  return `Claude rate limit: ${status}${suffix}`;
}

export function printClaudeStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (line.startsWith("[paperclip]")) {
    console.log(pc.blue(line));
    return;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const model = asString(parsed.model, "unknown");
      const sessionId = asString(parsed.session_id);
      console.log(pc.blue(`Claude initialized (model: ${model}${sessionId ? `, session: ${sessionId}` : ""})`));
      return;
    }
    if (subtype === "hook_started") {
      if (debug) console.log(pc.gray(`Hook started: ${readHookName(parsed)}`));
      return;
    }
    if (subtype === "hook_response") {
      const exitCode = asNumber(parsed.exit_code);
      const text = `${exitCode > 0 ? "Hook failed" : "Hook completed"}: ${readHookName(parsed)}${exitCode > 0 ? ` (exit ${exitCode})` : ""}`;
      if (exitCode > 0) {
        console.log(pc.red(text));
      } else if (debug) {
        console.log(pc.gray(text));
      }
      return;
    }
    if (debug && subtype) {
      console.log(pc.gray(`system: ${subtype}`));
    }
    return;
  }

  if (type === "rate_limit_event") {
    const text = formatRateLimitText(parsed);
    if (!text) return;
    const info = asRecord(parsed.rate_limit_info) ?? {};
    const status = asString(info.status);
    console.log((status === "rejected" ? pc.red : pc.yellow)(text));
    return;
  }

  if (type === "assistant") {
    const message =
      typeof parsed.message === "object" && parsed.message !== null && !Array.isArray(parsed.message)
        ? (parsed.message as Record<string, unknown>)
        : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const blockRaw of content) {
      if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
      const block = blockRaw as Record<string, unknown>;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) console.log(pc.green(`assistant: ${text}`));
      } else if (blockType === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        console.log(pc.yellow(`tool_call: ${name}`));
        if (block.input !== undefined) {
          console.log(pc.gray(JSON.stringify(block.input, null, 2)));
        }
      }
    }
    return;
  }

  if (type === "result") {
    const usage =
      typeof parsed.usage === "object" && parsed.usage !== null && !Array.isArray(parsed.usage)
        ? (parsed.usage as Record<string, unknown>)
        : {};
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    const cached = Number(usage.cache_read_input_tokens ?? 0);
    const cost = Number(parsed.total_cost_usd ?? 0);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    const resultText = typeof parsed.result === "string" ? parsed.result : "";
    if (resultText) {
      console.log(pc.green("result:"));
      console.log(resultText);
    }
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(asErrorText).filter(Boolean) : [];
    if (subtype.startsWith("error") || isError || errors.length > 0) {
      console.log(pc.red(`claude_result: subtype=${subtype || "unknown"} is_error=${isError ? "true" : "false"}`));
      if (errors.length > 0) {
        console.log(pc.red(`claude_errors: ${errors.join(" | ")}`));
      }
    }
    console.log(
      pc.blue(
        `tokens: in=${Number.isFinite(input) ? input : 0} out=${Number.isFinite(output) ? output : 0} cached=${Number.isFinite(cached) ? cached : 0} cost=$${Number.isFinite(cost) ? cost.toFixed(6) : "0.000000"}`,
      ),
    );
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}

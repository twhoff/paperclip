// ---------------------------------------------------------------------------
// Oz local run output parser
//
// oz agent run produces interactive terminal output — not structured JSON.
// We do best-effort extraction of conversation ID and error indicators from
// the raw stdout/stderr text. Most content passes through as-is to the run
// transcript panel.
// ---------------------------------------------------------------------------

// Patterns for conversation IDs in Oz output
// Oz prints URLs like: https://app.warp.dev/agent/runs/<id>
// or references like: conversation <id>
const CONVERSATION_URL_RE =
  /(?:oz\.warp\.dev|app\.warp\.dev)\/(?:runs|agent\/runs|conversations)\/([a-zA-Z0-9_-]{8,})/;
const CONVERSATION_FLAG_RE = /conversation[:\s]+([a-zA-Z0-9_-]{8,})/i;

// Error patterns in Oz output
const AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|authentication\s+required|unauthorized|login\s+required|run\s+`?oz\s+login`?)/i;
const UNKNOWN_CONVERSATION_RE =
  /(?:conversation\s+not\s+found|unknown\s+conversation|no\s+conversation\s+found|invalid\s+conversation)/i;
const CREDITS_EXHAUSTED_RE =
  /(?:run\s+out\s+of\s+credits|insufficient\s+credits|no\s+credits|out\s+of\s+credits)/i;

export interface OzParsedOutput {
  conversationId: string | null;
  errorMessage: string | null;
  requiresAuth: boolean;
  creditsExhausted: boolean;
  summary: string | null;
}

function extractConversationId(text: string): string | null {
  const urlMatch = text.match(CONVERSATION_URL_RE);
  if (urlMatch?.[1]) return urlMatch[1];
  const flagMatch = text.match(CONVERSATION_FLAG_RE);
  if (flagMatch?.[1]) return flagMatch[1];
  return null;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function extractErrorMessage(stdout: string, stderr: string): string | null {
  // Look for explicit error lines
  const combined = [stdout, stderr].join("\n");
  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^error:/i.test(trimmed) || /^fatal:/i.test(trimmed)) {
      return trimmed;
    }
  }
  // Fall back to first non-empty stderr line
  const stderrLine = firstNonEmptyLine(stderr);
  return stderrLine || null;
}

export function parseOzOutput(stdout: string, stderr: string): OzParsedOutput {
  const combined = [stdout, stderr].join("\n");
  const conversationId = extractConversationId(combined);
  const requiresAuth = AUTH_REQUIRED_RE.test(combined);
  const creditsExhausted = CREDITS_EXHAUSTED_RE.test(combined);
  const errorMessage = extractErrorMessage(stdout, stderr);

  // Extract a summary: last non-empty line of stdout (rough approximation)
  let summary: string | null = null;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    // Skip ANSI escape sequences and very short lines
    const plain = trimmed.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (plain.length > 10) {
      summary = plain.slice(0, 500);
      break;
    }
  }

  return { conversationId, errorMessage, requiresAuth, creditsExhausted, summary };
}

export function isOzUnknownConversationError(stdout: string, stderr: string): boolean {
  const combined = [stdout, stderr].join("\n");
  return UNKNOWN_CONVERSATION_RE.test(combined);
}

export function isOzAuthRequired(stdout: string, stderr: string): boolean {
  const combined = [stdout, stderr].join("\n");
  return AUTH_REQUIRED_RE.test(combined);
}

export function isOzCreditsExhausted(stdout: string, stderr: string): boolean {
  const combined = [stdout, stderr].join("\n");
  return CREDITS_EXHAUSTED_RE.test(combined);
}

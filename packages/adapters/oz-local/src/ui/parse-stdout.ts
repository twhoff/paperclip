import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * oz agent run produces interactive terminal output, not structured JSON events.
 * Every line is passed through as a raw stdout entry so it appears verbatim in
 * the Paperclip run transcript panel.
 */
export function parseOzStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}

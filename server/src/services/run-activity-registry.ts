// Run-activity registry for the heartbeat watchdog.
//
// The watchdog originally relied solely on rows in `heartbeat_run_events` as
// its activity signal. That signal is too narrow: adapter stream events
// (assistant turns, tool calls, tool results) do not always create rows in
// that table, so a busy adapter could be reaped after ~10 minutes of "DB
// silence" even though it was still mid-task.
//
// This module provides an in-memory, per-run activity registry that the
// watchdog reads from. Two sources update it:
//
//   * `stream`   — meaningful adapter stdout lines observed by the run-log
//                  pump (see `isMeaningfulAdapterStreamLine`).
//   * `db_event` — server-side `appendRunEvent` writes that produce a row in
//                  `heartbeat_run_events`.
//
// Stderr never resets the idle timer. This filters out recurring noise such
// as `codex_models_manager` refresh failures, which would otherwise keep a
// dead adapter alive indefinitely.
//
// The registry is in-memory only. After a server restart it is empty; the
// watchdog falls back to querying `heartbeat_run_events` directly so genuinely
// idle runs are still reaped.

export type ActivitySource = "stream" | "db_event";

export interface RunActivitySnapshot {
  /** Newest activity timestamp across all recorded sources. */
  lastActivityAt: Date;
  /** Which source produced `lastActivityAt`. */
  lastActivitySource: ActivitySource;
  /** Latest stream timestamp, if any. */
  streamAt: Date | null;
  /** Latest db_event timestamp, if any. */
  dbEventAt: Date | null;
}

interface InternalEntry {
  streamAt: Date | null;
  dbEventAt: Date | null;
}

export interface RunActivityRegistry {
  /**
   * Record an activity event for the given run. No-op if `at` is older than
   * the timestamp already stored for the same source.
   */
  record(runId: string, source: ActivitySource, at?: Date): void;
  /** Read the current activity snapshot for a run. */
  get(runId: string): RunActivitySnapshot | null;
  /** Forget a run. Called when a run reaches a terminal status. */
  clear(runId: string): void;
  /** Drop all entries. Test-only. */
  reset(): void;
  /** Number of tracked runs. Test-only. */
  size(): number;
}

export function createRunActivityRegistry(): RunActivityRegistry {
  const entries = new Map<string, InternalEntry>();

  function ensure(runId: string): InternalEntry {
    let entry = entries.get(runId);
    if (!entry) {
      entry = { streamAt: null, dbEventAt: null };
      entries.set(runId, entry);
    }
    return entry;
  }

  return {
    record(runId, source, at = new Date()) {
      if (!runId) return;
      if (Number.isNaN(at.getTime())) return;
      const entry = ensure(runId);
      if (source === "stream") {
        if (!entry.streamAt || at.getTime() > entry.streamAt.getTime()) {
          entry.streamAt = at;
        }
      } else {
        if (!entry.dbEventAt || at.getTime() > entry.dbEventAt.getTime()) {
          entry.dbEventAt = at;
        }
      }
    },
    get(runId) {
      const entry = entries.get(runId);
      if (!entry) return null;
      if (!entry.streamAt && !entry.dbEventAt) return null;
      const streamMs = entry.streamAt?.getTime() ?? -Infinity;
      const dbMs = entry.dbEventAt?.getTime() ?? -Infinity;
      const source: ActivitySource = streamMs >= dbMs ? "stream" : "db_event";
      const lastActivityAt = source === "stream" ? entry.streamAt! : entry.dbEventAt!;
      return {
        lastActivityAt,
        lastActivitySource: source,
        streamAt: entry.streamAt,
        dbEventAt: entry.dbEventAt,
      };
    },
    clear(runId) {
      entries.delete(runId);
    },
    reset() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Process-wide singleton. The heartbeat service uses this so all callers
 * (onLog, appendRunEvent, the watchdog) share one view of run activity.
 */
export const runActivityRegistry: RunActivityRegistry = createRunActivityRegistry();

// ---------------------------------------------------------------------------
// Meaningful adapter-stream activity parser.
//
// Rules:
//
//   * Only `stdout` lines are inspected. Stderr never counts as progress —
//     this filters Codex `codex_models_manager` refresh errors and other
//     noisy stderr lines that recur every few seconds.
//   * Each line must parse as JSON.
//   * The JSON must carry an event type that represents *real* model or tool
//     progress.
//
// Whitelisted event types (cross-adapter):
//
//   Claude (stream-json):
//     - `system` with `subtype: "init"`       (model + session id)
//     - `assistant`                            (assistant turn — text,
//                                              thinking, tool_use, etc.)
//     - `user`                                 (tool_result injections)
//     - `result`                               (turn complete)
//
//   Codex / OpenAI Agents:
//     - `thread.started`
//     - `turn.started`
//     - `item.started`
//     - `item.completed`
//     - `tool_use` / `tool_result`             (loose, when emitted bare)
//
// Explicitly NOT meaningful:
//
//   * Anything on stderr.
//   * Empty or non-JSON lines.
//   * Claude `stream_event` partial-message floods (suppressed elsewhere
//     too).
//   * Hook bookkeeping like `sys/requesting`, `ping`, `keepalive`.
//   * Unknown event types — be strict, not permissive. New meaningful types
//     should be added here explicitly so we keep the noise floor low.
// ---------------------------------------------------------------------------

const MEANINGFUL_TYPES = new Set([
  "assistant",
  "user",
  "result",
  "thread.started",
  "turn.started",
  "item.started",
  "item.completed",
  "tool_use",
  "tool_result",
]);

export interface MeaningfulLineResult {
  meaningful: boolean;
  /** Event type when matched, for diagnostics. */
  kind?: string;
}

export function isMeaningfulAdapterStreamLine(
  stream: "stdout" | "stderr",
  line: string,
): MeaningfulLineResult {
  if (stream !== "stdout") return { meaningful: false };
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return { meaningful: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { meaningful: false };
  }
  if (!parsed || typeof parsed !== "object") return { meaningful: false };
  const obj = parsed as Record<string, unknown>;

  const type = typeof obj.type === "string" ? obj.type : null;
  if (!type) return { meaningful: false };

  // Claude `system` lines: only the `init` subtype counts. The other system
  // subtypes (heartbeats, requesting indicators, hook chatter) are noise.
  if (type === "system") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : null;
    if (subtype === "init") return { meaningful: true, kind: "system:init" };
    return { meaningful: false };
  }

  // Claude `stream_event` is the partial-message flood — already suppressed
  // by the adapter, but we make sure here too.
  if (type === "stream_event") return { meaningful: false };

  if (MEANINGFUL_TYPES.has(type)) return { meaningful: true, kind: type };

  return { meaningful: false };
}

/**
 * Convenience helper that scans a (possibly multi-line) chunk for any
 * meaningful line. Returns the first match for diagnostics.
 */
export function chunkHasMeaningfulActivity(
  stream: "stdout" | "stderr",
  chunk: string,
): MeaningfulLineResult {
  if (stream !== "stdout") return { meaningful: false };
  const lines = chunk.split("\n");
  for (const line of lines) {
    const result = isMeaningfulAdapterStreamLine(stream, line);
    if (result.meaningful) return result;
  }
  return { meaningful: false };
}

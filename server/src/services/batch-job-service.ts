import { type Db } from "@paperclipai/db";
import { and, eq, isNull, asc, lte, inArray } from "drizzle-orm";
import {
  batchQueueEntries,
  batchJobs,
  agentWakeupRequests,
} from "@paperclipai/db/schema";

/**
 * Anthropic batch response types
 */
interface AnthropicBatchResponse {
  id: string;
  type: string;
  processing_status: "in_progress" | "ended";
  request_counts?: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at?: string;
  created_at: string;
  expires_at: string;
  results_url?: string;
}

interface AnthropicBatchResultItem {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled" | "expired";
    message?: {
      id: string;
      model: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
      };
      content: Array<{ type: "text"; text: string }>;
      stop_reason: string;
    };
    error?: {
      type: string;
      message: string;
    };
  };
}

/**
 * Batch job service for managing Anthropic batch API submissions and polling
 */
export interface BatchJobService {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

/**
 * Create a batch job service
 */
export function createBatchJobService(options: {
  db: Db;
  anthropicApiKey: string;
  submitIntervalMs?: number; // default 300_000 (5 min)
  pollIntervalMs?: number; // default 300_000 (5 min)
  maxBatchSize?: number; // default 100
  maxBatchWaitMs?: number; // default 86400_000 (24h)
}): BatchJobService {
  const {
    db,
    anthropicApiKey,
    submitIntervalMs = 300_000,
    pollIntervalMs = 300_000,
    maxBatchSize = 100,
    maxBatchWaitMs = 86400_000,
  } = options;

  let running = false;
  let submitIntervalId: NodeJS.Timeout | null = null;
  let pollIntervalId: NodeJS.Timeout | null = null;

  async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs = 8000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Submit pending batch queue entries to Anthropic
   */
  async function submitTick(): Promise<void> {
    try {
      // Get pending entries ordered by creation time, limited to batch size
      // Drizzle queries are atomic, preventing race conditions across instances
      const entries = await db
        .select()
        .from(batchQueueEntries)
        .where(eq(batchQueueEntries.status, "pending"))
        .orderBy(asc(batchQueueEntries.createdAt))
        .limit(maxBatchSize);

      if (entries.length === 0) return;

      // Build Anthropic batch request
      const requests = entries.map((entry) => ({
        custom_id: entry.customId,
        params: entry.requestParamsJson,
      }));

      const response = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages/batches",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requests }),
        },
      );

      if (response.status === 529) {
        // Overloaded - skip this tick and retry later
        console.log("[batch] Anthropic API overloaded (529); skipping submission tick");
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[batch] Anthropic API error ${response.status}: ${errorText}`);

        if (response.status >= 400 && response.status < 500) {
          // Auth error or client error - mark entries failed
          const entryIds = entries.map((e) => e.id);
          await db
            .update(batchQueueEntries)
            .set({
              status: "failed",
              errorMessage: `HTTP ${response.status}: ${errorText}`,
              updatedAt: new Date(),
            })
            .where(inArray(batchQueueEntries.id, entryIds));
        }
        return;
      }

      const batchData = (await response.json()) as AnthropicBatchResponse;
      const now = new Date();

      // Create batch job record
      const insertResult = await db
        .insert(batchJobs)
        .values({
          anthropicBatchId: batchData.id,
          status: "in_progress",
          entryCount: entries.length,
          submittedAt: now,
          lastPolledAt: now,
        })
        .returning();

      if (!insertResult || insertResult.length === 0) {
        console.error(`[batch] Failed to insert batch job for ${batchData.id}`);
        return;
      }

      const batchJob = insertResult[0];

      // Update queue entries to submitted with batch job reference
      const entryIds = entries.map((e) => e.id);
      await db
        .update(batchQueueEntries)
        .set({
          status: "submitted",
          batchJobId: batchJob.id,
          updatedAt: now,
        })
        .where(inArray(batchQueueEntries.id, entryIds));

      console.log(
        `[batch] Submitted ${entries.length} entries as Anthropic batch ${batchData.id}`,
      );
    } catch (err) {
      console.error("[batch] Submit tick error:", err);
    }
  }

  /**
   * Poll in-progress batch jobs for completion
   */
  async function pollTick(): Promise<void> {
    try {
      // Get in-progress batches
      const inProgressBatches = await db
        .select()
        .from(batchJobs)
        .where(eq(batchJobs.status, "in_progress"));

      for (const batchJob of inProgressBatches) {
        try {
          // Poll Anthropic for status
          const response = await fetchWithTimeout(
            `https://api.anthropic.com/v1/messages/batches/${batchJob.anthropicBatchId}`,
          );

          if (response.status === 529) continue; // Overloaded, skip

          if (!response.ok) {
            const errorText = await response.text();
            console.error(
              `[batch] Failed to poll batch ${batchJob.anthropicBatchId}: ${errorText}`,
            );
            continue;
          }

          const batchData = (await response.json()) as AnthropicBatchResponse;
          const now = new Date();

          // Update last polled
          await db
            .update(batchJobs)
            .set({ lastPolledAt: now })
            .where(eq(batchJobs.id, batchJob.id));

          if (batchData.processing_status !== "ended") continue; // Still processing

          // Batch ended - fetch results
          if (!batchData.results_url) {
            console.error(`[batch] Batch ${batchJob.anthropicBatchId} ended but no results_url`);
            await db
              .update(batchJobs)
              .set({
                status: "failed",
                errorMessage: "No results URL",
                endedAt: now,
                updatedAt: now,
              })
              .where(eq(batchJobs.id, batchJob.id));
            continue;
          }

          // Fetch results (JSONL format)
          const resultsResponse = await fetchWithTimeout(batchData.results_url);
          if (!resultsResponse.ok) {
            console.error(
              `[batch] Failed to fetch results for ${batchJob.anthropicBatchId}`,
            );
            continue;
          }

          const resultsText = await resultsResponse.text();
          const resultLines = resultsText.split("\n").filter((line) => line.trim());

          // Process each result
          for (const line of resultLines) {
            try {
              const resultItem = JSON.parse(line) as AnthropicBatchResultItem;
              const customId = resultItem.custom_id;

              // Find the queue entry
              const entry = await db.query.batchQueueEntries.findFirst({
                where: eq(batchQueueEntries.customId, customId),
              });

              if (!entry) {
                console.warn(
                  `[batch] No queue entry found for custom_id ${customId}`,
                );
                continue;
              }

              // Update entry with result
              let entryStatus: "completed" | "failed" | "expired" | "cancelled" = "completed";
              let resultData: Record<string, unknown> = {};

              if (resultItem.result.type === "succeeded" && resultItem.result.message) {
                const msg = resultItem.result.message;
                const textContent = msg.content.find((c) => c.type === "text")?.text ?? "";
                resultData = {
                  type: "succeeded",
                  id: msg.id,
                  model: msg.model,
                  input_tokens: msg.usage.input_tokens,
                  output_tokens: msg.usage.output_tokens,
                  cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
                  content_text: textContent,
                  stop_reason: msg.stop_reason,
                };
              } else {
                entryStatus = resultItem.result.type as "failed" | "expired" | "cancelled";
                if (resultItem.result.error) {
                  resultData = {
                    type: resultItem.result.type,
                    error_message: resultItem.result.error.message,
                  };
                }
              }

              await db
                .update(batchQueueEntries)
                .set({
                  status: entryStatus,
                  resultJson: resultData,
                  updatedAt: now,
                })
                .where(eq(batchQueueEntries.id, entry.id));

              // Create wakeup request to resume agent
              const idempotencyKey = `batch_${entry.id}`;
              await db
                .insert(agentWakeupRequests)
                .values({
                  companyId: entry.companyId,
                  agentId: entry.agentId,
                  source: "automation",
                  triggerDetail: "callback",
                  payload: {
                    batchEntryId: entry.id,
                  },
                  idempotencyKey,
                })
                .onConflictDoNothing(); // Prevent duplicate wakeups
            } catch (err) {
              console.error("[batch] Error processing result item:", err);
            }
          }

          // Mark batch as ended
          await db
            .update(batchJobs)
            .set({
              status: "ended",
              endedAt: now,
              requestCounts: batchData.request_counts,
              updatedAt: now,
            })
            .where(eq(batchJobs.id, batchJob.id));

          console.log(
            `[batch] Completed batch ${batchJob.anthropicBatchId} with ${resultLines.length} results`,
          );
        } catch (err) {
          console.error(`[batch] Error polling batch ${batchJob.anthropicBatchId}:`, err);
        }
      }

      // Clean up expired entries (stuck waiting for too long)
      const expiryTime = new Date(Date.now() - maxBatchWaitMs);
      await db
        .update(batchQueueEntries)
        .set({
          status: "expired",
          errorMessage: "Batch entry expired while waiting for results",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(batchQueueEntries.status, "submitted"),
            lte(batchQueueEntries.createdAt, expiryTime),
          ),
        );
    } catch (err) {
      console.error("[batch] Poll tick error:", err);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;

      console.log("[batch] Batch job service started");

      // Start periodic submission tick
      submitIntervalId = setInterval(submitTick, submitIntervalMs);

      // Start periodic polling tick
      pollIntervalId = setInterval(pollTick, pollIntervalMs);

      // Run ticks immediately on startup
      submitTick().catch((err) => console.error("[batch] Initial submit error:", err));
      pollTick().catch((err) => console.error("[batch] Initial poll error:", err));
    },

    stop() {
      if (!running) return;
      running = false;

      if (submitIntervalId) {
        clearInterval(submitIntervalId);
        submitIntervalId = null;
      }

      if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }

      console.log("[batch] Batch job service stopped");
    },

    isRunning() {
      return running;
    },
  };
}

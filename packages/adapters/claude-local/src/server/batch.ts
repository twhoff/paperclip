import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * Interface for decision context in shouldUseBatch
 */
export interface BatchDecisionContext {
  batchMode: "never" | "smart" | "always";
  hasApiKey: boolean;
  taskType: string | null;
  priority: number;
  deadlineIso: string | null;
  queueDepth: number;
  isBlocked: boolean;
  isInteractive: boolean;
}

/**
 * Anthropic Messages API params for batch submission
 */
export interface AnthropicMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Anthropic batch result item
 */
export interface AnthropicBatchResult {
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
 * Determine if a task should be batched based on evaluation criteria
 */
export function shouldUseBatch(ctx: BatchDecisionContext): boolean {
  // Hard gates
  if (ctx.batchMode === "never") return false;
  if (!ctx.hasApiKey) return false;
  if (ctx.isInteractive) return false;
  if (ctx.isBlocked) return false;
  if (ctx.batchMode === "always") return true;

  // Smart mode scoring
  let score = 0;

  // Task type bonus
  if (ctx.taskType) {
    const batchableTypes = [
      "analysis",
      "report",
      "summarize",
      "summarization",
      "extract",
      "extraction",
      "classify",
      "classification",
      "review",
    ];
    if (batchableTypes.some((t) => ctx.taskType!.toLowerCase().includes(t))) {
      score += 30;
    }
  }

  // Priority penalties
  if (ctx.priority >= 8) {
    score -= 50;
  } else if (ctx.priority >= 6) {
    score -= 20;
  }

  // Deadline penalties
  if (ctx.deadlineIso) {
    const now = new Date();
    const deadline = new Date(ctx.deadlineIso);
    const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntilDeadline < 2) {
      score -= 100;
    } else if (hoursUntilDeadline < 6) {
      score -= 40;
    } else if (hoursUntilDeadline < 24) {
      score -= 20;
    }
  }

  // Queue depth bonuses
  if (ctx.queueDepth >= 50) {
    score += 10;
  } else if (ctx.queueDepth >= 10) {
    score += 5;
  }

  return score >= 0;
}

/**
 * Serialize AdapterExecutionContext to Anthropic MessageParams for batch submission
 */
export function serializeToBatchRequest(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  promptTemplate: string,
  bootstrapPromptTemplate: string,
  templateData: Record<string, unknown>,
): AnthropicMessageParams {
  const model = asString(config.model, "claude-sonnet-4-6");
  const maxTokens = asNumber(config.batchMaxTokens, 8192);

  // Render the system prompt using the same template as CLI mode
  const system = promptTemplate || bootstrapPromptTemplate || "";

  // Compose user message from context
  const userMessage =
    asString(parseObject(ctx.context).paperclipTaskDescription, "") ||
    asString(parseObject(ctx.context).paperclipSessionHandoffMarkdown, "") ||
    "Continue your assigned work.";

  return {
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  };
}

/**
 * Generate a custom_id for an entry ID
 * Format: "pclp_{id-no-dashes}"
 */
export function generateCustomId(entryId: string): string {
  const idNoDashes = entryId.replace(/-/g, "");
  return `pclp_${idNoDashes}`;
}

/**
 * Extract entryId from custom_id
 */
export function extractEntryIdFromCustomId(customId: string): string | null {
  if (!customId.startsWith("pclp_")) return null;
  const idNoDashes = customId.slice(5);
  // Reformat as UUID: 8-4-4-4-12
  if (idNoDashes.length !== 32) return null;
  return `${idNoDashes.slice(0, 8)}-${idNoDashes.slice(8, 12)}-${idNoDashes.slice(12, 16)}-${idNoDashes.slice(16, 20)}-${idNoDashes.slice(20)}`;
}

/**
 * Estimate cost in USD for a batch result
 * Uses standard Claude token prices (as of Feb 2025)
 */
export function estimateCostUsd(
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number },
): number {
  // Token prices per 1M tokens (March 2026 rates, 50% batch discount applied)
  const inputPrice: Record<string, number> = {
    "claude-opus-4-6": 3.0,
    "claude-sonnet-4-6": 3.0,
    "claude-haiku-4-6": 0.8,
    "claude-sonnet-4-5-20250929": 3.0,
    "claude-haiku-4-5-20251001": 0.8,
  };

  const outputPrice: Record<string, number> = {
    "claude-opus-4-6": 15.0,
    "claude-sonnet-4-6": 15.0,
    "claude-haiku-4-6": 4.0,
    "claude-sonnet-4-5-20250929": 15.0,
    "claude-haiku-4-5-20251001": 4.0,
  };

  const inputPricePerToken = (inputPrice[model] ?? 3.0) / 1_000_000;
  const outputPricePerToken = (outputPrice[model] ?? 15.0) / 1_000_000;

  // Calculate cost
  let cost = usage.input_tokens * inputPricePerToken + usage.output_tokens * outputPricePerToken;

  // Apply 50% batch discount
  cost *= 0.5;

  return Math.round(cost * 10000) / 10000; // Round to 4 decimals
}

/**
 * Deserialize an Anthropic batch result into AdapterExecutionResult
 */
export function deserializeBatchResult(
  result: AnthropicBatchResult,
  sessionParamsSnapshot: Record<string, unknown> | null,
  model: string,
): AdapterExecutionResult {
  const { type, message, error } = result.result;

  if (type === "succeeded" && message) {
    const textContent = message.content.find((c) => c.type === "text")?.text ?? "";

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
      },
      sessionParams: sessionParamsSnapshot ?? null,
      sessionDisplayId: null,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "api",
      model: message.model,
      costUsd: estimateCostUsd(model, message.usage),
      summary: textContent,
      resultJson: {
        anthropicBatchResult: result.result,
      },
    };
  } else {
    // errored, canceled, expired
    const errorMsg = error?.message ?? type;

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Batch entry ${type}: ${errorMsg}`,
      errorCode: `batch_${type}`,
      sessionParams: sessionParamsSnapshot ?? null,
      sessionDisplayId: null,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "api",
      model,
      costUsd: 0,
      resultJson: {
        anthropicBatchResult: result.result,
      },
    };
  }
}

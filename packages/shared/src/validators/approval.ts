import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";

const MAX_APPROVAL_PAYLOAD_DEPTH = 32;
const MAX_APPROVAL_PAYLOAD_NODES = 4_096;
const MAX_APPROVAL_PAYLOAD_BYTES = 1024 * 1024;

function utf8ByteLength(value: string) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > MAX_APPROVAL_PAYLOAD_BYTES) break;
  }
  return bytes;
}

function isBoundedJsonPayload(value: Record<string, unknown>) {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_APPROVAL_PAYLOAD_NODES || current.depth > MAX_APPROVAL_PAYLOAD_DEPTH) {
      return false;
    }
    if (typeof current.value === "string") {
      bytes += utf8ByteLength(current.value);
      if (bytes > MAX_APPROVAL_PAYLOAD_BYTES) return false;
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value !== "object") return false;
    if (seen.has(current.value)) return false;
    seen.add(current.value);

    let arrayValue: boolean;
    try {
      arrayValue = Array.isArray(current.value);
    } catch {
      return false;
    }
    if (arrayValue) {
      const entries = current.value as unknown[];
      let length: number;
      try {
        length = entries.length;
      } catch {
        return false;
      }
      if (length > MAX_APPROVAL_PAYLOAD_NODES - nodes) return false;
      for (let index = 0; index < length; index += 1) {
        try {
          pending.push({ value: entries[index], depth: current.depth + 1 });
        } catch {
          return false;
        }
      }
      continue;
    }

    let entries: Array<[string, unknown]>;
    try {
      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      entries = Object.entries(current.value as Record<string, unknown>);
    } catch {
      return false;
    }
    if (entries.length > MAX_APPROVAL_PAYLOAD_NODES - nodes) return false;
    for (const [key, entry] of entries) {
      bytes += utf8ByteLength(key);
      if (bytes > MAX_APPROVAL_PAYLOAD_BYTES) return false;
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}

const approvalPayloadSchema = z.record(z.unknown()).superRefine((value, context) => {
  if (isBoundedJsonPayload(value)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Approval payload exceeds the supported depth, size, or entry limit",
  });
});

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: approvalPayloadSchema,
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: z.string().max(64 * 1024).optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().max(64 * 1024).optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: approvalPayloadSchema.optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1).max(64 * 1024),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

import { describe, expect, it } from "vitest";
import {
  createApprovalSchema,
  addIssueCommentSchema,
  createSecretSchema,
  resubmitApprovalSchema,
  rotateSecretSchema,
  wakeAgentSchema,
} from "@paperclipai/shared";

const MAX_SECRET_VALUE_LENGTH = 64 * 1024;
const MAX_WAKE_IDEMPOTENCY_KEY_LENGTH = 255;

describe("shared request size bounds", () => {
  it.each([
    ["create", createSecretSchema, { name: "bounded-secret" }],
    ["rotate", rotateSecretSchema, {}],
  ] as const)("bounds %s secret values", (_label, schema, input) => {
    expect(schema.safeParse({ ...input, value: "s".repeat(MAX_SECRET_VALUE_LENGTH) }).success)
      .toBe(true);
    expect(schema.safeParse({ ...input, value: "s".repeat(MAX_SECRET_VALUE_LENGTH + 1) }).success)
      .toBe(false);
  });

  it("bounds wake idempotency keys", () => {
    expect(wakeAgentSchema.safeParse({
      idempotencyKey: "i".repeat(MAX_WAKE_IDEMPOTENCY_KEY_LENGTH),
    }).success).toBe(true);
    expect(wakeAgentSchema.safeParse({
      idempotencyKey: "i".repeat(MAX_WAKE_IDEMPOTENCY_KEY_LENGTH + 1),
    }).success).toBe(false);
  });

  it.each([
    ["create", createApprovalSchema, (payload: Record<string, unknown>) => ({
      type: "approve_ceo_strategy" as const,
      payload,
    })],
    ["resubmit", resubmitApprovalSchema, (payload: Record<string, unknown>) => ({ payload })],
  ] as const)("bounds %s approval payload depth and size", (_label, schema, buildInput) => {
    let tooDeep: Record<string, unknown> = { safe: "value" };
    for (let depth = 0; depth < 33; depth += 1) tooDeep = { nested: tooDeep };

    expect(schema.safeParse(buildInput({ safe: "value" })).success).toBe(true);
    expect(schema.safeParse(buildInput(tooDeep)).success).toBe(false);
    expect(schema.safeParse(buildInput({ blob: "x".repeat(1024 * 1024 + 1) })).success)
      .toBe(false);
  });

  it("bounds issue comment bodies", () => {
    expect(addIssueCommentSchema.safeParse({ body: "x".repeat(64 * 1024) }).success).toBe(true);
    expect(addIssueCommentSchema.safeParse({ body: "x".repeat(64 * 1024 + 1) }).success).toBe(false);
  });
});

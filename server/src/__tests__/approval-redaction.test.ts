import { describe, expect, it } from "vitest";
import {
  redactApprovalRecord,
  redactApprovalRecords,
  sanitizeApprovalPayloadForPersistence,
} from "../services/approval-redaction.js";
import {
  redactCommentRecords,
  redactStrictDiagnosticText,
} from "../services/comment-redaction.js";

describe("approval redaction", () => {
  it("redacts payload secrets before persistence while preserving safe fields", () => {
    const secret = "approval-persistence-secret-value";
    const result = sanitizeApprovalPayloadForPersistence({
      apiKey: secret,
      echoed: secret,
      safe: "keep-me!",
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.echoed).toBe("***REDACTED***");
    expect(result.safe).toBe("keep-me!");
  });

  it("preserves operational hire payload values while bounding persistence", () => {
    const result = sanitizeApprovalPayloadForPersistence({
      name: "Alice",
      role: "engineer",
      adapterConfig: { cwd: "/workspace" },
    });

    expect(result).toEqual({
      name: "Alice",
      role: "engineer",
      adapterConfig: { cwd: "/workspace" },
    });
  });

  it("redacts JWT fragments split across approval decision notes", () => {
    const token = "eyJapproval.payload.signature_";
    const result = redactApprovalRecords([
      { payload: {}, decisionNote: token.slice(0, 1) },
      { payload: {}, decisionNote: token.slice(1) },
    ]);

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result[0]?.decisionNote).toBe("***REDACTED***");
  });

  it("redacts JWT fragments split across one approval payload and decision note", () => {
    const token = "eyJapproval.payload.signature_";
    const result = redactApprovalRecord({
      payload: { detail: token.slice(0, 1) },
      decisionNote: token.slice(1),
    });

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.payload.detail).toBe("***REDACTED***");
  });

  it("strictly redacts decision-note prefixes across separate detail fetches", () => {
    const token = "eyJapproval.separate.signature_";
    const first = redactApprovalRecord({ payload: {}, decisionNote: token.slice(0, 1) });
    const second = redactApprovalRecord({ payload: {}, decisionNote: token.slice(1) });

    expect(`${first.decisionNote}${second.decisionNote}`).not.toContain(token);
    expect(first.decisionNote).toBe("***REDACTED***");
  });

  it("strictly redacts payload fragments across approval list records", () => {
    const token = "eyJapproval.list.signature_";
    const result = redactApprovalRecords([
      { payload: { detail: token.slice(0, 1), e: "safe" }, decisionNote: null },
      { payload: { detail: token.slice(1), yJapproval: "safe" }, decisionNote: null },
    ]);

    expect(`${result[0]?.payload.detail}${result[1]?.payload.detail}`).not.toContain(token);
    expect(result[0]?.payload.detail).toBe("***REDACTED***");
    expect(Object.keys(result[0]?.payload ?? {})).not.toContain("e");
  });

  it("strictly redacts payload prefixes across separate approval detail fetches", () => {
    const token = "eyJapproval.separate-payload.signature_";
    const first = redactApprovalRecord({
      payload: { detail: token.slice(0, 1) },
      decisionNote: null,
    });
    const second = redactApprovalRecord({
      payload: { detail: token.slice(1) },
      decisionNote: null,
    });

    expect(`${first.payload.detail}${second.payload.detail}`).not.toContain(token);
    expect(first.payload.detail).toBe("***REDACTED***");
  });

  it("redacts JWT fragments split across bounded approval comments", () => {
    const token = "eyJcomment.payload.signature_";
    const result = redactCommentRecords([
      { id: "comment-1", body: token.slice(0, 1) },
      { id: "comment-2", body: token.slice(1) },
    ]);

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result[0]?.body).toBe("***REDACTED***");
  });

  it("strictly redacts ambiguous credential prefixes before persistence", () => {
    expect(redactStrictDiagnosticText("ordinary e", { enabled: false }))
      .toBe("ordinary ***REDACTED***");
    expect(redactStrictDiagnosticText("ey", { enabled: false }))
      .toBe("***REDACTED***");
  });
});

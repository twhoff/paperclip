import { describe, expect, it } from "vitest";
import { summarizeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });

  it("redacts full and bounded-prefix JWTs before applying the summary limit", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1zdW1tYXJ5In0.signature_value";
    const prefix = `${"a".repeat(498)}:`;
    const full = summarizeHeartbeatRunResultJson({ summary: `${prefix}${token}` });
    const boundedPrefix = summarizeHeartbeatRunResultJson({
      summary: `${prefix}${token.slice(0, 12)}`,
    });

    expect(full?.summary).not.toContain("eyJ");
    expect(boundedPrefix?.summary).not.toContain("eyJ");
    expect(full?.summary).toContain("*");
    expect(boundedPrefix?.summary).toContain("*");
  });

  it("redacts a known non-JWT secret truncated by the SQL projection", () => {
    const secret = "summary-boundary-provider-secret-8f36-long-value";
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = secret;
    const prefix = "a".repeat(495);
    const projected = `${prefix}${secret}`.slice(0, 512);
    const exposedPrefix = secret.slice(0, 512 - prefix.length);

    try {
      const summary = summarizeHeartbeatRunResultJson({ summary: projected });

      expect(summary?.summary).not.toContain(exposedPrefix);
      expect(summary?.summary).toContain("***");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("keeps only finite numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunResultJson({
        total_cost_usd: { attackerControlled: "x".repeat(10_000) },
        cost_usd: "0.45",
        costUsd: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();

    expect(
      summarizeHeartbeatRunResultJson({
        total_cost_usd: 0,
        cost_usd: 0.45,
        costUsd: 0.67,
      }),
    ).toEqual({ total_cost_usd: 0, cost_usd: 0.45, costUsd: 0.67 });
  });
});

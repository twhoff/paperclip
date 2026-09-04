import { beforeEach, describe, expect, it, vi } from "vitest";
import { redactCommentRecords } from "../services/comment-redaction.js";
import { issueService } from "../services/issues.js";

const mockInstanceSettings = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => mockInstanceSettings),
}));

describe("issue comment redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies a mandatory query limit and redacts split rows as one page", async () => {
    const token = "eyJissue.payload.signature_";
    const limit = vi.fn(async () => [
      { id: "comment-1", body: token.slice(0, 1) },
      { id: "comment-2", body: token.slice(1) },
      { id: "comment-3", body: "ordinary e" },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit })),
          })),
        })),
      })),
    };

    const comments = await issueService(db as any).listComments("issue-1");

    expect(limit).toHaveBeenCalledWith(100);
    expect(JSON.stringify(comments)).not.toContain(token);
    expect(comments[0]?.body).toBe("***REDACTED***");
    expect(comments.at(-1)?.body).toBe("ordinary ***REDACTED***");
  });

  it("redacts non-adjacent credential fragments across separate historical pages", () => {
    const token = "eyJhistorical.comment.signature_";
    const firstPage = [
      { id: "comment-1", body: token.slice(0, 1) },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: `comment-${index + 2}`,
        body: `ordinary-${index}`,
      })),
    ];
    const secondPage = [{ id: "comment-101", body: token.slice(1) }];

    const returnedBodies = [
      ...redactCommentRecords(firstPage),
      ...redactCommentRecords(secondPage),
    ].map((comment) => comment.body);

    expect(returnedBodies.join("")).not.toContain(token);
    expect(returnedBodies[0]).toBe("***REDACTED***");
  });

  it("strictly sanitizes split credentials before issue-comment insertion", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ companyId: "company-1" }]),
        })),
      })),
      insert: vi.fn(() => ({
        values: (value: Record<string, unknown>) => {
          inserted.push(value);
          return { returning: vi.fn(async () => [{ id: `comment-${inserted.length}`, ...value }]) };
        },
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const secret = "issue-comment-current-secret";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
    const svc = issueService(db as any);

    try {
      await svc.addComment("issue-1", "e", { userId: "user-1" });
      await svc.addComment("issue-1", "yJissue.payload.signature_", { userId: "user-1" });
      await svc.addComment("issue-1", secret.slice(0, 10), { userId: "user-1" });
      await svc.addComment("issue-1", secret.slice(10), { userId: "user-1" });
    } finally {
      if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    }

    const persisted = inserted.map((row) => String(row.body)).join("");
    expect(persisted).not.toContain("eyJissue.payload.signature_");
    expect(persisted).not.toContain(secret);
    expect(String(inserted[0]?.body)).toBe("***REDACTED***");
    expect(String(inserted[2]?.body)).toBe("***REDACTED***");
  });
});

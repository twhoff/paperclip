import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import { issueService } from "../services/issues.js";

// Comment redaction builds its secret list from the host environment
// (collectSensitiveEnvValues), so returned bodies are not deterministic across
// machines: any env var whose name matches the sensitive-key pattern contributes
// its value, even a one-character one that collides with ordinary text. Redaction
// has its own coverage in issue-comments-redaction.test.ts; here it is reduced to
// the page bound so these assertions exercise only the native pagination path.
vi.mock("../services/comment-redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/comment-redaction.js")>();
  return {
    ...actual,
    redactCommentRecords: <T extends { body: string }>(comments: readonly T[]) =>
      comments.slice(0, actual.MAX_COMMENT_PAGE_ROWS).map((comment) => ({ ...comment })),
  };
});

// Exercise production postgres-js binding, not a mocked query builder.
describe("native issue comment pagination", () => {
  let pg: EmbeddedPostgres | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let root: string;
  let port: number;
  let service: ReturnType<typeof issueService>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const emptyIssueId = randomUUID();
  const otherIssueId = randomUUID();
  const otherCommentId = randomUUID();

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-pages-"));
    port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    pg = new EmbeddedPostgres({
      databaseDir: path.join(root, "db"),
      user: "fixture",
      password: "fixture-only",
      port,
      persistent: true,
      createPostgresUser: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories="],
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    const adminUrl = `postgres://fixture:fixture-only@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "comment_pagination");
    const url = `postgres://fixture:fixture-only@127.0.0.1:${port}/comment_pagination`;
    await applyPendingMigrations(url);
    db = createDb(url);
    const [identity] = await db.$client`
      select current_database() as name, current_setting('data_directory') as directory
    `;
    expect(identity?.name).toBe("comment_pagination");
    expect(fs.realpathSync(identity!.directory)).toBe(fs.realpathSync(path.join(root, "db")));
    await db.insert(companies).values([
      { id: companyId, name: "Comment fixture", status: "paused", issuePrefix: "FIX" },
      { id: otherCompanyId, name: "Other fixture", status: "paused", issuePrefix: "OTHER" },
    ]);
    await db.insert(agents).values({
      id: agentId, companyId, name: "Paused fixture", status: "paused", adapterConfig: {}, runtimeConfig: {},
    });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Comments" },
      { id: emptyIssueId, companyId, title: "Empty" },
      { id: otherIssueId, companyId: otherCompanyId, title: "Other company" },
    ]);
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: { censorUsernameInLogs: false }, experimental: {},
    });
    await db.$client`
      insert into issue_comments (id, company_id, issue_id, author_user_id, body)
      values (${otherCommentId}, ${otherCompanyId}, ${otherIssueId}, 'fixture-user', 'Other company')
    `;
    service = issueService(db);
  }, 120_000);

  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 3 });
    } finally {
      await pg?.stop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  async function seed(count: number) {
    await db!.$client`delete from issue_comments where issue_id = ${issueId}`;
    // Two distinct submillisecond instants, each with ties. UUID order runs
    // opposite insertion order so dropping timestamp precision cannot pass.
    await db!.$client`
      insert into issue_comments
        (id, company_id, issue_id, author_agent_id, body, created_at, updated_at)
      select
        ('00000000-0000-4000-8000-' || lpad((1000 - n)::text, 12, '0'))::uuid,
        ${companyId}::uuid, ${issueId}::uuid, ${agentId}::uuid,
        'Native row ' || n,
        '2026-10-04 00:00:00.000123+00'::timestamptz
          + case when n <= 110 then interval '0' else interval '333 microseconds' end,
        '2026-10-04 00:00:01+00'::timestamptz
      from generate_series(1, ${count}::int) n
    `;
  }

  async function storedRows() {
    const rows = await db!.$client`
      select id, company_id as "companyId", issue_id as "issueId",
        author_agent_id as "authorAgentId", author_user_id as "authorUserId", body,
        created_at as "createdAt", updated_at as "updatedAt"
      from issue_comments where issue_id = ${issueId} order by created_at, id
    `;
    // Drizzle returns Date values; SQL ordering above retains full precision.
    return rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  for (const order of ["asc", "desc"] as const) {
    for (const count of [201, 200, 100]) {
      it(`traverses ${count} rows ${order} through ties and precise anchors to exhaustion`, async () => {
        await seed(count);
        const expected = await storedRows();
        if (order === "desc") expected.reverse();
        const actual: Awaited<ReturnType<typeof service.listComments>> = [];
        const sizes: number[] = [];
        let afterCommentId: string | undefined;
        // Bound the loop so a repeating cursor produces a useful test failure.
        for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
          const page = await service.listComments(issueId, { order, afterCommentId });
          sizes.push(page.length);
          actual.push(...page);
          if (page.length < 100) break;
          afterCommentId = page.at(-1)!.id;
        }
        expect(sizes).toEqual(count === 201 ? [100, 100, 1] : count === 200 ? [100, 100, 0] : [100, 0]);
        expect(actual).toEqual(expected);
        expect(new Set(actual.map((row) => row.id)).size).toBe(count);
        expect(await service.listComments(issueId, { order, afterCommentId: actual.at(-1)!.id })).toEqual([]);
      });
    }
  }

  it("preserves caps, default descending order, empty and issue/company isolation", async () => {
    await seed(201);
    const expected = (await storedRows()).reverse();
    expect(await service.listComments(issueId, { limit: 1000 })).toEqual(expected.slice(0, 100));
    expect(await service.listComments(issueId, { limit: 1 })).toEqual(expected.slice(0, 1));
    expect(await service.listComments(emptyIssueId)).toEqual([]);
    for (const order of ["asc", "desc"] as const) {
      for (const anchor of [randomUUID(), otherCommentId]) {
        expect(await service.listComments(issueId, { order, afterCommentId: anchor })).toEqual([]);
      }
      expect(await service.listComments(emptyIssueId, { order, afterCommentId: expected[0]!.id })).toEqual([]);
    }
    const other = await service.listComments(otherIssueId);
    expect(other.map((row) => row.id)).toEqual([otherCommentId]);
    expect(other[0]?.companyId).toBe(otherCompanyId);
  });
});

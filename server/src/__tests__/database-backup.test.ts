import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";

const ROWS = 125;

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

// Dump and restore through real PostgreSQL so the row cursor, the text casts
// and the streamed statement reader are exercised end to end.
describe("database backup and restore", () => {
  let pg: EmbeddedPostgres | undefined;
  let root: string;
  let databaseUrl: (name: string) => string;
  let sourceUrl: string;
  let targetUrl: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "database-backup-"));
    const port = await freePort();
    databaseUrl = (name) => `postgres://fixture:fixture-only@127.0.0.1:${port}/${name}`;
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
    await ensurePostgresDatabase(databaseUrl("postgres"), "backup_source");
    await ensurePostgresDatabase(databaseUrl("postgres"), "backup_target");
    sourceUrl = databaseUrl("backup_source");
    targetUrl = databaseUrl("backup_target");

    const source = createDb(sourceUrl);
    try {
      await source.$client`
        create table runs (
          id integer primary key,
          payload jsonb not null,
          tags text[],
          note text,
          created_at timestamptz not null
        )
      `;
      // More rows than one cursor batch, holding values that a JSON round trip,
      // a JavaScript array or a CRLF-normalising reader would each corrupt.
      await source.$client`
        insert into runs (id, payload, tags, note, created_at)
        select
          n,
          jsonb_build_object('n', n, 'big', 12345678901234567890123, 'text', 'naïve ✓ $paperclip$'),
          array['plain', 'with "quote"', 'comma, brace {x}', 'back\\slash', null],
          'line one' || chr(13) || chr(10) || 'line ' || n || ' $paperclip$',
          timestamptz '2026-10-21 00:00:00.123+00' + n * interval '1 second'
        from generate_series(1, ${ROWS}::int) as n
      `;
    } finally {
      await source.$client.end();
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await pg?.stop();
    } finally {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("dumps every row in batches and restores them exactly", async () => {
    const backupDir = path.join(root, "backups");
    const result = await runDatabaseBackup({
      connectionString: sourceUrl,
      backupDir,
      retentionDays: 7,
      filenamePrefix: "fixture",
    });

    const name = path.basename(result.backupFile);
    expect(fs.readdirSync(backupDir).sort()).toEqual([name, `${name}.sha256`]);
    const dump = fs.readFileSync(result.backupFile, "utf8");
    expect(dump).toContain(`-- Data for: public.runs (${ROWS} rows)`);
    expect(dump).toMatch(/COMMIT;\n[^\n]*\n\n$/);

    await runDatabaseRestore({ connectionString: targetUrl, backupFile: result.backupFile });

    const source = createDb(sourceUrl);
    const target = createDb(targetUrl);
    try {
      const read = (db: ReturnType<typeof createDb>) => db.$client`
        select id, payload::text as payload, tags::text as tags, note, created_at
        from runs order by id
      `;
      const [expected, actual] = await Promise.all([read(source), read(target)]);
      expect(actual).toHaveLength(ROWS);
      expect(actual).toEqual(expected);
    } finally {
      await Promise.all([source.$client.end(), target.$client.end()]);
    }
  });

  it("carries the migration journal so a restored database can start", async () => {
    const migratedUrl = databaseUrl("migrated_source");
    const restoredUrl = databaseUrl("migrated_target");
    await ensurePostgresDatabase(databaseUrl("postgres"), "migrated_source");
    await ensurePostgresDatabase(databaseUrl("postgres"), "migrated_target");
    await applyPendingMigrations(migratedUrl);

    const result = await runDatabaseBackup({
      connectionString: migratedUrl,
      backupDir: path.join(root, "migrated"),
      retentionDays: 7,
      filenamePrefix: "migrated",
    });
    await runDatabaseRestore({ connectionString: restoredUrl, backupFile: result.backupFile });

    // The server refuses to start on tables it has no migration history for.
    const expected = await inspectMigrations(migratedUrl);
    expect(expected.status).toBe("upToDate");
    expect(await inspectMigrations(restoredUrl)).toEqual(expected);
  }, 120_000);

  it("leaves no file behind when the dump fails", async () => {
    const backupDir = path.join(root, "failed");
    const closedPort = await freePort();
    await expect(runDatabaseBackup({
      connectionString: `postgres://fixture:fixture-only@127.0.0.1:${closedPort}/backup_source`,
      backupDir,
      retentionDays: 7,
      connectTimeoutSeconds: 1,
    })).rejects.toThrow();
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });
});

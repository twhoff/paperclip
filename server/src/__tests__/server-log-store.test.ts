import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneServerLogs } from "../services/server-log-store.js";

const createdDirs: string[] = [];

async function makeLogDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-server-logs-"));
  createdDirs.push(dir);
  return dir;
}

async function writeLog(dir: string, name: string, contents = name): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return file;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

describe("pruneServerLogs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 4, 12, 0, 0));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it.skipIf(process.platform === "win32")(
    "protects the current symlink target and every current-day numbered log",
    async () => {
      const logDir = await makeLogDir();
      const firstProcess = await writeLog(logDir, "server.2026-09-04.1.log");
      const activeFile = await writeLog(logDir, "server.2026-09-04.2.log");
      const previousDay = await writeLog(logDir, "server.2026-09-03.1.log");
      const currentLink = path.join(logDir, "current.log");
      await fs.symlink(path.basename(activeFile), currentLink);

      const result = await pruneServerLogs({
        logDir,
        liveFile: currentLink,
        retentionDays: 14,
        compressRotated: true,
      });

      expect(await exists(firstProcess)).toBe(true);
      expect(await exists(`${firstProcess}.gz`)).toBe(false);
      expect(await exists(activeFile)).toBe(true);
      expect(await exists(`${activeFile}.gz`)).toBe(false);
      expect(await exists(previousDay)).toBe(false);
      expect(await exists(`${previousDay}.gz`)).toBe(true);
      expect(result).toEqual({ gzippedFiles: 1, deletedFiles: 0, deletedBytes: 0 });
    },
  );

  it("fails closed before mutation when the current-log identity is missing", async () => {
    const logDir = await makeLogDir();
    const historical = await writeLog(logDir, "server.2026-09-03.1.log");

    await expect(
      pruneServerLogs({
        logDir,
        liveFile: path.join(logDir, "current.log"),
        retentionDays: 14,
        compressRotated: true,
      }),
    ).rejects.toThrow(/current server log identity/i);

    expect(await exists(historical)).toBe(true);
    expect(await exists(`${historical}.gz`)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed before mutation when the current-log symlink is broken",
    async () => {
      const logDir = await makeLogDir();
      const currentLink = path.join(logDir, "current.log");
      await fs.symlink("server.2026-09-04.99.log", currentLink);
      const historical = await writeLog(logDir, "server.2026-09-03.1.log");

      await expect(
        pruneServerLogs({
          logDir,
          liveFile: currentLink,
          retentionDays: 14,
          compressRotated: true,
        }),
      ).rejects.toThrow(/current server log identity/i);

      expect(await exists(historical)).toBe(true);
      expect(await exists(`${historical}.gz`)).toBe(false);
    },
  );

  it("fails closed before mutation when the current-log identity escapes the log directory", async () => {
    const logDir = await makeLogDir();
    const outsideDir = await makeLogDir();
    const outsideLive = await writeLog(outsideDir, "server.2026-09-04.1.log");
    const historical = await writeLog(logDir, "server.2026-09-03.1.log");

    await expect(
      pruneServerLogs({
        logDir,
        liveFile: outsideLive,
        retentionDays: 14,
        compressRotated: true,
      }),
    ).rejects.toThrow(/outside.*log directory/i);

    expect(await exists(historical)).toBe(true);
    expect(await exists(`${historical}.gz`)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed before mutation when the current-log symlink targets a file outside the log directory",
    async () => {
      const logDir = await makeLogDir();
      const outsideDir = await makeLogDir();
      const outsideLive = await writeLog(outsideDir, "server.2026-09-04.1.log");
      const currentLink = path.join(logDir, "current.log");
      await fs.symlink(outsideLive, currentLink);
      const historical = await writeLog(logDir, "server.2026-09-03.1.log");

      await expect(
        pruneServerLogs({
          logDir,
          liveFile: currentLink,
          retentionDays: 14,
          compressRotated: true,
        }),
      ).rejects.toThrow(/outside.*log directory/i);

      expect(await exists(historical)).toBe(true);
      expect(await exists(`${historical}.gz`)).toBe(false);
    },
  );

  it("fails closed before mutation when the current-log identity resolves to a directory", async () => {
    const logDir = await makeLogDir();
    const liveDirectory = path.join(logDir, "current.log");
    await fs.mkdir(liveDirectory);
    const historical = await writeLog(logDir, "server.2026-09-03.1.log");

    await expect(
      pruneServerLogs({
        logDir,
        liveFile: liveDirectory,
        retentionDays: 14,
        compressRotated: true,
      }),
    ).rejects.toThrow(/regular file/i);

    expect(await exists(historical)).toBe(true);
  });

  it("preserves an existing historical plain-and-gzip pair", async () => {
    const logDir = await makeLogDir();
    const activeFile = await writeLog(logDir, "server.2026-09-04.1.log");
    const historical = await writeLog(logDir, "server.2026-09-03.1.log", "plain");
    const historicalGzip = await writeLog(logDir, "server.2026-09-03.1.log.gz", "existing gzip");

    const result = await pruneServerLogs({
      logDir,
      liveFile: activeFile,
      retentionDays: 14,
      compressRotated: true,
    });

    expect(await fs.readFile(historical, "utf8")).toBe("plain");
    expect(await fs.readFile(historicalGzip, "utf8")).toBe("existing gzip");
    expect(result).toEqual({ gzippedFiles: 0, deletedFiles: 0, deletedBytes: 0 });
  });

  it.skipIf(process.platform === "win32")(
    "ignores rotated-name symlinks instead of mutating their targets",
    async () => {
      const logDir = await makeLogDir();
      const activeFile = await writeLog(logDir, "server.2026-09-04.1.log");
      const outsideDir = await makeLogDir();
      const outsideFile = await writeLog(outsideDir, "outside.log", "outside");
      const candidate = path.join(logDir, "server.2026-09-03.1.log");
      await fs.symlink(outsideFile, candidate);

      const result = await pruneServerLogs({
        logDir,
        liveFile: activeFile,
        retentionDays: 14,
        compressRotated: true,
      });

      expect(await fs.readFile(outsideFile, "utf8")).toBe("outside");
      expect(
        await fs.lstat(candidate).then((stat) => stat.isSymbolicLink()),
      ).toBe(true);
      expect(await exists(`${candidate}.gz`)).toBe(false);
      expect(result).toEqual({ gzippedFiles: 0, deletedFiles: 0, deletedBytes: 0 });
    },
  );

  it("returns without mutation when the log directory does not exist", async () => {
    const parent = await makeLogDir();
    const missingLogDir = path.join(parent, "missing");

    await expect(
      pruneServerLogs({
        logDir: missingLogDir,
        liveFile: path.join(missingLogDir, "current.log"),
        retentionDays: 14,
        compressRotated: true,
      }),
    ).resolves.toEqual({ gzippedFiles: 0, deletedFiles: 0, deletedBytes: 0 });
  });

  it("still deletes genuinely expired historical logs", async () => {
    const logDir = await makeLogDir();
    const activeFile = await writeLog(logDir, "server.2026-09-04.1.log");
    const expired = await writeLog(logDir, "server.2026-08-01.1.log", "expired");
    const expiredAt = new Date(2026, 7, 1, 12, 0, 0);
    await fs.utimes(expired, expiredAt, expiredAt);

    const result = await pruneServerLogs({
      logDir,
      liveFile: activeFile,
      retentionDays: 14,
      compressRotated: true,
    });

    expect(await exists(expired)).toBe(false);
    expect(result).toEqual({
      gzippedFiles: 0,
      deletedFiles: 1,
      deletedBytes: Buffer.byteLength("expired"),
    });
  });
});

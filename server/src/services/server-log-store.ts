import path from "node:path";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export interface PruneServerLogsOptions {
  logDir: string;
  liveFile: string;
  retentionDays: number;
  compressRotated: boolean;
}

export interface PruneServerLogsResult {
  gzippedFiles: number;
  deletedFiles: number;
  deletedBytes: number;
}

const ROTATED_PATTERN = /^server\.\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log(?:\.gz)?$/;

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function resolveCurrentLogName(logDir: string, liveFile: string): Promise<string> {
  const absoluteLogDir = path.resolve(logDir);
  const absoluteLiveFile = path.resolve(logDir, liveFile);
  if (!isWithinDirectory(absoluteLogDir, absoluteLiveFile)) {
    throw new Error(
      `Current server log identity is outside the configured log directory: ${liveFile}`,
    );
  }

  const realLogDir = await fs.realpath(logDir);
  let realLiveFile: string;
  try {
    realLiveFile = await fs.realpath(absoluteLiveFile);
  } catch (cause) {
    throw new Error(`Current server log identity could not be resolved: ${liveFile}`, { cause });
  }

  if (
    !isWithinDirectory(realLogDir, realLiveFile) ||
    path.dirname(realLiveFile) !== realLogDir
  ) {
    throw new Error(
      `Current server log identity resolves outside the configured log directory: ${liveFile}`,
    );
  }

  let liveStat;
  try {
    liveStat = await fs.stat(realLiveFile);
  } catch (cause) {
    throw new Error(`Current server log identity could not be inspected: ${liveFile}`, { cause });
  }
  if (!liveStat.isFile()) {
    throw new Error(`Current server log identity must resolve to a regular file: ${liveFile}`);
  }

  return path.basename(realLiveFile);
}

/**
 * Maintain server log directory:
 *  - gzip rotated `server.YYYY-MM-DD[.N].log` files (pino-roll already
 *    closed them; the current symlink target and every current-day file
 *    are left untouched for rollover and duplicate-process safety).
 *  - delete rotated files (gzipped or not) older than retentionDays.
 *
 * The sweep fails before mutation if the current-log identity cannot be
 * resolved safely inside logDir.
 */
export async function pruneServerLogs(
  opts: PruneServerLogsOptions,
): Promise<PruneServerLogsResult> {
  const result: PruneServerLogsResult = { gzippedFiles: 0, deletedFiles: 0, deletedBytes: 0 };
  const cutoff = Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await fs.readdir(opts.logDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return result;
    throw err;
  }

  const liveFileBase = await resolveCurrentLogName(opts.logDir, opts.liveFile);
  const currentDatePrefix = `server.${formatLocalDate(new Date())}`;

  for (const name of entries) {
    if (name === liveFileBase) continue;
    if (!ROTATED_PATTERN.test(name)) continue;
    if (name.startsWith(`${currentDatePrefix}.`) || name === `${currentDatePrefix}.log`) {
      continue;
    }
    const full = path.join(opts.logDir, name);
    let stat;
    try {
      stat = await fs.lstat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    if (stat.mtimeMs < cutoff) {
      result.deletedBytes += stat.size;
      try {
        await fs.unlink(full);
        result.deletedFiles += 1;
      } catch {
        // ignore — another process may have removed it
      }
      continue;
    }

    if (opts.compressRotated && name.endsWith(".log")) {
      const gzPath = `${full}.gz`;
      try {
        await fs.access(gzPath);
        // gz already exists, skip
      } catch {
        try {
          await pipeline(
            createReadStream(full),
            createGzip({ level: 9 }),
            createWriteStream(gzPath),
          );
          await fs.unlink(full);
          result.gzippedFiles += 1;
        } catch {
          // best-effort
        }
      }
    }
  }

  return result;
}

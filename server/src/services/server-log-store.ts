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

/**
 * Maintain server log directory:
 *  - gzip rotated `server.YYYY-MM-DD[.N].log` files (pino-roll already
 *    closed them; the *current* live file is left untouched).
 *  - delete rotated files (gzipped or not) older than retentionDays.
 */
export async function pruneServerLogs(
  opts: PruneServerLogsOptions,
): Promise<PruneServerLogsResult> {
  const result: PruneServerLogsResult = { gzippedFiles: 0, deletedFiles: 0, deletedBytes: 0 };
  const cutoff = Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000;
  const liveFileBase = path.basename(opts.liveFile);

  let entries: string[];
  try {
    entries = await fs.readdir(opts.logDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return result;
    throw err;
  }

  for (const name of entries) {
    if (name === liveFileBase) continue;
    if (!ROTATED_PATTERN.test(name)) continue;
    const full = path.join(opts.logDir, name);
    let stat;
    try {
      stat = await fs.stat(full);
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

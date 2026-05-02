import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogStoreOptions {
  basePath?: string;
  /** Per-run cap; further appends after this are dropped (with one sentinel line). */
  maxRunBytes?: number;
  /** Whether to gzip the file when finalize() is called. */
  compressOnFinalize?: boolean;
}

export interface PruneRunLogsOptions {
  basePath?: string;
  /** Files with mtime older than now - retentionDays are deleted. */
  retentionDays: number;
  /** Optional logger callback for per-file events. */
  onDelete?: (filePath: string) => void;
}

export interface PruneRunLogsResult {
  deletedFiles: number;
  deletedBytes: number;
  removedDirs: number;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

const DEFAULT_MAX_RUN_BYTES = 50_000_000;

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

function defaultBasePath(): string {
  return process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

function createLocalFileRunLogStore(opts: RunLogStoreOptions = {}): RunLogStore {
  const basePath = opts.basePath ?? defaultBasePath();
  const maxRunBytes = Math.max(1024, opts.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES);
  const compressOnFinalize = opts.compressOnFinalize ?? true;

  // Track per-run byte counts so we can enforce maxRunBytes across many appends.
  const runBytes = new Map<string, number>();
  const truncatedRuns = new Set<string>();

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readPlainRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function readGzipRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    // gzip files don't expose random access; decompress fully (logs are capped at maxRunBytes
    // so worst case is a few tens of MB of UTF-8) then slice.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath).pipe(createGunzip());
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    const buf = Buffer.concat(chunks);
    const start = Math.max(0, Math.min(offset, buf.length));
    const end = Math.min(start + limitBytes, buf.length);
    const content = buf.subarray(start, end).toString("utf8");
    const nextOffset = end < buf.length ? end : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function gzipFile(srcPath: string, destPath: string): Promise<void> {
    await pipeline(createReadStream(srcPath), createGzip({ level: 6 }), createWriteStream(destPath));
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");
      runBytes.set(relPath, 0);
      truncatedRuns.delete(relPath);

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = `${JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      })}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");

      let current = runBytes.get(handle.logRef);
      if (current === undefined) {
        // Recover current size if we restarted mid-run.
        const stat = await fs.stat(absPath).catch(() => null);
        current = stat?.size ?? 0;
        runBytes.set(handle.logRef, current);
      }

      if (current + lineBytes > maxRunBytes) {
        if (truncatedRuns.has(handle.logRef)) return;
        const sentinel = `${JSON.stringify({
          ts: event.ts,
          stream: "system",
          chunk: `[run-log truncated: exceeded ${maxRunBytes.toLocaleString()} bytes]`,
        })}\n`;
        await fs.appendFile(absPath, sentinel, "utf8");
        runBytes.set(handle.logRef, current + Buffer.byteLength(sentinel, "utf8"));
        truncatedRuns.add(handle.logRef);
        return;
      }

      await fs.appendFile(absPath, line, "utf8");
      runBytes.set(handle.logRef, current + lineBytes);
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      runBytes.delete(handle.logRef);
      truncatedRuns.delete(handle.logRef);

      if (!compressOnFinalize || stat.size === 0) {
        const hash = stat.size > 0 ? await sha256File(absPath) : undefined;
        return { bytes: stat.size, sha256: hash, compressed: false };
      }

      const gzPath = `${absPath}.gz`;
      await gzipFile(absPath, gzPath);
      await fs.unlink(absPath);
      const gzStat = await fs.stat(gzPath);
      const gzHash = await sha256File(gzPath);
      // logRef stays the same (the .ndjson reference); read() handles the .gz suffix transparently.
      return { bytes: gzStat.size, sha256: gzHash, compressed: true };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;

      const gzPath = `${absPath}.gz`;
      const hasPlain = await fs.stat(absPath).then(() => true, () => false);
      if (hasPlain) {
        return readPlainRange(absPath, offset, limitBytes);
      }
      const hasGz = await fs.stat(gzPath).then(() => true, () => false);
      if (hasGz) {
        return readGzipRange(gzPath, offset, limitBytes);
      }
      throw notFound("Run log not found");
    },
  };
}

let cachedStore: RunLogStore | null = null;
let cachedOptions: RunLogStoreOptions | null = null;

export function configureRunLogStore(opts: RunLogStoreOptions): RunLogStore {
  cachedOptions = opts;
  cachedStore = createLocalFileRunLogStore(opts);
  return cachedStore;
}

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  cachedStore = createLocalFileRunLogStore();
  return cachedStore;
}

export function getConfiguredRunLogBasePath(): string {
  return cachedOptions?.basePath ?? defaultBasePath();
}

/**
 * Walks the run-log root and deletes ndjson(.gz) files older than retentionDays.
 * Removes empty agent and company directories afterwards.
 */
export async function pruneRunLogs(opts: PruneRunLogsOptions): Promise<PruneRunLogsResult> {
  const basePath = opts.basePath ?? defaultBasePath();
  const cutoffMs = Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000;

  let deletedFiles = 0;
  let deletedBytes = 0;
  let removedDirs = 0;

  const baseStat = await fs.stat(basePath).catch(() => null);
  if (!baseStat?.isDirectory()) {
    return { deletedFiles, deletedBytes, removedDirs };
  }

  const companyDirs = await fs.readdir(basePath, { withFileTypes: true });
  for (const company of companyDirs) {
    if (!company.isDirectory()) continue;
    const companyPath = path.join(basePath, company.name);
    const agentDirs = await fs.readdir(companyPath, { withFileTypes: true }).catch(() => []);

    for (const agent of agentDirs) {
      if (!agent.isDirectory()) continue;
      const agentPath = path.join(companyPath, agent.name);
      const files = await fs.readdir(agentPath, { withFileTypes: true }).catch(() => []);

      for (const file of files) {
        if (!file.isFile()) continue;
        if (!file.name.endsWith(".ndjson") && !file.name.endsWith(".ndjson.gz")) continue;
        const filePath = path.join(agentPath, file.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) continue;
        if (stat.mtimeMs >= cutoffMs) continue;
        await fs.unlink(filePath).catch(() => {});
        deletedFiles += 1;
        deletedBytes += stat.size;
        opts.onDelete?.(filePath);
      }

      const remaining = await fs.readdir(agentPath).catch(() => []);
      if (remaining.length === 0) {
        await fs.rmdir(agentPath).catch(() => {});
        removedDirs += 1;
      }
    }

    const remainingAgents = await fs.readdir(companyPath).catch(() => []);
    if (remainingAgents.length === 0) {
      await fs.rmdir(companyPath).catch(() => {});
      removedDirs += 1;
    }
  }

  return { deletedFiles, deletedBytes, removedDirs };
}


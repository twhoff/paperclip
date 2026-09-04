import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export type WorkspaceOperationLogStoreType = "local_file";

export interface WorkspaceOperationLogHandle {
  store: WorkspaceOperationLogStoreType;
  logRef: string;
}

export interface WorkspaceOperationLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface WorkspaceOperationLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface WorkspaceOperationLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface WorkspaceOperationLogStore {
  begin(input: { companyId: string; operationId: string }): Promise<WorkspaceOperationLogHandle>;
  append(
    handle: WorkspaceOperationLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  discard(handle: WorkspaceOperationLogHandle): Promise<void>;
  finalize(handle: WorkspaceOperationLogHandle): Promise<WorkspaceOperationLogFinalizeSummary>;
  read(handle: WorkspaceOperationLogHandle, opts?: WorkspaceOperationLogReadOptions): Promise<WorkspaceOperationLogReadResult>;
}

export interface WorkspaceOperationLogStoreOptions {
  basePath?: string;
  maxOperationBytes?: number;
}

const DEFAULT_MAX_OPERATION_BYTES = 50_000_000;

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

function defaultBasePath() {
  return process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
}

export function createLocalFileWorkspaceOperationLogStore(
  options: WorkspaceOperationLogStoreOptions = {},
): WorkspaceOperationLogStore {
  const basePath = options.basePath ?? defaultBasePath();
  const maxOperationBytes = Math.max(
    1_024,
    options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES,
  );
  const operationBytes = new Map<string, number>();
  const truncatedOperations = new Set<string>();
  const appendTails = new Map<string, Promise<void>>();

  async function serializeAppend(logRef: string, append: () => Promise<void>) {
    const previous = appendTails.get(logRef) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(append);
    appendTails.set(logRef, next);
    try {
      await next;
    } finally {
      if (appendTails.get(logRef) === next) appendTails.delete(logRef);
    }
  }

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Workspace operation log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    if (limitBytes <= 0) return { content: "", nextOffset: start };
    if (start >= stat.size) return { content: "", nextOffset: undefined };
    const end = Math.min(start + limitBytes - 1, stat.size - 1);

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

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId] = safeSegments(input.companyId);
      const operationId = safeSegments(input.operationId)[0]!;
      const relDir = companyId;
      const relPath = path.join(relDir, `${operationId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");
      operationBytes.set(relPath, 0);
      truncatedOperations.delete(relPath);

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      return serializeAppend(handle.logRef, async () => {
        const absPath = resolveWithin(basePath, handle.logRef);
        const line = JSON.stringify({
          ts: event.ts,
          stream: event.stream,
          chunk: event.chunk,
        });
        const serialized = `${line}\n`;
        const lineBytes = Buffer.byteLength(serialized, "utf8");
        const sentinel = `${JSON.stringify({
          ts: event.ts,
          stream: "system",
          chunk: `[workspace-operation-log truncated: exceeded ${maxOperationBytes.toLocaleString()} bytes]`,
        })}\n`;
        const sentinelBytes = Buffer.byteLength(sentinel, "utf8");
        let current = operationBytes.get(handle.logRef);
        if (current === undefined) {
          const stat = await fs.stat(absPath).catch(() => null);
          current = stat?.size ?? 0;
          operationBytes.set(handle.logRef, current);
        }

        if (current + lineBytes + sentinelBytes > maxOperationBytes) {
          if (truncatedOperations.has(handle.logRef)) return;
          if (current + sentinelBytes <= maxOperationBytes) {
            await fs.appendFile(absPath, sentinel, "utf8");
            current += sentinelBytes;
          }
          operationBytes.set(handle.logRef, current);
          truncatedOperations.add(handle.logRef);
          return;
        }

        await fs.appendFile(absPath, serialized, "utf8");
        operationBytes.set(handle.logRef, current + lineBytes);
      });
    },

    async discard(handle) {
      if (handle.store !== "local_file") return;
      await appendTails.get(handle.logRef)?.catch(() => undefined);
      appendTails.delete(handle.logRef);
      operationBytes.delete(handle.logRef);
      truncatedOperations.delete(handle.logRef);
      const absPath = resolveWithin(basePath, handle.logRef);
      await fs.unlink(absPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      await appendTails.get(handle.logRef);
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Workspace operation log not found");

      operationBytes.delete(handle.logRef);
      truncatedOperations.delete(handle.logRef);

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Workspace operation log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = Math.max(0, Math.trunc(opts?.offset ?? 0));
      const limitBytes = Math.min(
        maxOperationBytes + 1,
        Math.max(0, Math.trunc(opts?.limitBytes ?? 256_000)),
      );
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: WorkspaceOperationLogStore | null = null;

export function getWorkspaceOperationLogStore() {
  if (cachedStore) return cachedStore;
  cachedStore = createLocalFileWorkspaceOperationLogStore();
  return cachedStore;
}

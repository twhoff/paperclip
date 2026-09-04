import { beforeEach, describe, expect, it, vi } from "vitest";

const logStoreState = vi.hoisted(() => {
  const logs = new Map<string, string>();
  const discardedRefs: string[] = [];
  let appendError: Error | null = null;
  let sourceReadCount = 0;

  const store = {
    async begin(input: { operationId: string }) {
      const handle = {
        store: "local_file" as const,
        logRef: `${input.operationId}.ndjson`,
      };
      logs.set(handle.logRef, "");
      return handle;
    },
    async append(
      handle: { logRef: string },
      event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
    ) {
      if (appendError) throw appendError;
      logs.set(handle.logRef, `${logs.get(handle.logRef) ?? ""}${JSON.stringify(event)}\n`);
    },
    async discard(handle: { logRef: string }) {
      discardedRefs.push(handle.logRef);
      logs.delete(handle.logRef);
    },
    async finalize(handle: { logRef: string }) {
      return {
        bytes: Buffer.byteLength(logs.get(handle.logRef) ?? "", "utf8"),
        compressed: false,
      };
    },
    async read(
      handle: { logRef: string },
      options: { offset?: number; limitBytes?: number } = {},
    ) {
      sourceReadCount += 1;
      const content = Buffer.from(logs.get(handle.logRef) ?? "", "utf8");
      const offset = options.offset ?? 0;
      const end = Math.min(content.length, offset + (options.limitBytes ?? content.length));
      return {
        content: content.subarray(offset, end).toString("utf8"),
        nextOffset: end < content.length ? end : undefined,
      };
    },
  };

  return {
    store,
    rawLog(logRef: string) {
      return logs.get(logRef) ?? "";
    },
    readCount() {
      return sourceReadCount;
    },
    refs() {
      return [...logs.keys()];
    },
    discardedRefs() {
      return [...discardedRefs];
    },
    failAppendsWith(error: Error | null) {
      appendError = error;
    },
    reset() {
      logs.clear();
      discardedRefs.length = 0;
      appendError = null;
      sourceReadCount = 0;
    },
  };
});

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../services/workspace-operation-log-store.js", () => ({
  getWorkspaceOperationLogStore: () => logStoreState.store,
}));

import { workspaceOperationService } from "../services/workspace-operations.js";

type StoredOperation = Record<string, unknown>;

function createWorkspaceOperationDb(rows: StoredOperation[]) {
  return {
    insert: () => ({
      values: async (value: StoredOperation) => {
        const now = new Date();
        rows.push({
          logBytes: null,
          logSha256: null,
          logCompressed: false,
          stdoutExcerpt: null,
          stderrExcerpt: null,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
          ...value,
        });
      },
    }),
    update: () => ({
      set: (patch: StoredOperation) => ({
        where: () => {
          Object.assign(rows[0] ?? {}, patch);
          const query = Promise.resolve(undefined) as Promise<void> & {
            returning: () => Promise<StoredOperation[]>;
          };
          query.returning = async () => rows.slice(0, 1);
          return query;
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows.slice(0, 1)),
      }),
    }),
  };
}

describe("workspace operation redaction", () => {
  beforeEach(() => {
    logStoreState.reset();
  });

  it("discards the begun log when the operation row cannot be inserted", async () => {
    const rows: StoredOperation[] = [];
    const db = createWorkspaceOperationDb(rows);
    db.insert = () => ({
      values: async () => {
        throw new Error("insert failed");
      },
    });
    const recorder = workspaceOperationService(db as never).createRecorder({
      companyId: "company-1",
      heartbeatRunId: "run-1",
      redactionOptions: { enabled: false },
    });

    await expect(recorder.recordOperation({
      phase: "workspace_provision",
      run: async () => ({ status: "succeeded" }),
    })).rejects.toThrow("insert failed");

    expect(rows).toEqual([]);
    expect(logStoreState.refs()).toEqual([]);
    expect(logStoreState.discardedRefs()).toHaveLength(1);
  });

  it("records terminal failure even when diagnostic log writes fail", async () => {
    const rows: StoredOperation[] = [];
    const recorder = workspaceOperationService(createWorkspaceOperationDb(rows) as never)
      .createRecorder({
        companyId: "company-1",
        heartbeatRunId: "run-1",
        redactionOptions: { enabled: false },
      });
    logStoreState.failAppendsWith(new Error("log unavailable"));

    await expect(recorder.recordOperation({
      phase: "workspace_provision",
      run: async () => {
        throw new Error("operation failed");
      },
    })).rejects.toThrow("operation failed");

    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it("terminalizes a workspace operation when the rejection has hostile accessors", async () => {
    const rows: StoredOperation[] = [];
    const recorder = workspaceOperationService(createWorkspaceOperationDb(rows) as never)
      .createRecorder({
        companyId: "company-1",
        heartbeatRunId: "run-1",
        redactionOptions: { enabled: false },
      });
    const hostile = new Proxy(new Error("hidden"), {
      get(target, property, receiver) {
        if (["name", "message", "stack", "toString"].includes(String(property))) {
          throw new Error("hostile accessor");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(recorder.recordOperation({
      phase: "workspace_provision",
      run: async () => {
        throw hostile;
      },
    })).rejects.toThrow("***REDACTED***");

    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(rows[0])).not.toContain("hostile accessor");
  });

  it("bounds workspace-operation list queries in SQL", async () => {
    const limit = vi.fn(async () => []);
    const ordered = {
      limit,
      then<TResult1 = StoredOperation[], TResult2 = never>(
        onfulfilled?: ((value: StoredOperation[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve([] as StoredOperation[]).then(onfulfilled, onrejected);
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ordered,
          }),
        }),
      }),
    };
    const service = workspaceOperationService(db as never);

    await service.listForRun("run-1");
    await service.listForExecutionWorkspace("workspace-1", Number.MAX_SAFE_INTEGER);

    expect(limit).toHaveBeenNthCalledWith(1, 200);
    expect(limit).toHaveBeenNthCalledWith(2, 500);
  });

  it("preserves the metadata record shape when bounded redaction fails closed", async () => {
    const rows: StoredOperation[] = [];
    let metadata: Record<string, unknown> = { apiKey: "hidden-value" };
    for (let depth = 0; depth < 40; depth += 1) metadata = { nested: metadata };
    const recorder = workspaceOperationService(createWorkspaceOperationDb(rows) as never)
      .createRecorder({
        companyId: "company-1",
        heartbeatRunId: "run-1",
        redactionOptions: { enabled: false, secretValues: ["hidden-value"] },
      });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      metadata,
      run: async () => ({ status: "succeeded" }),
    });

    expect(rows[0]?.metadata).toEqual({ redacted: "***REDACTED***" });
    expect(operation.metadata).toEqual({ redacted: "***REDACTED***" });
  });

  it("redacts a provision-command secret from the database, raw log, and cached log reads", async () => {
    const secret = "workspace-provision-secret-value";
    const rows: StoredOperation[] = [];
    const service = workspaceOperationService(createWorkspaceOperationDb(rows) as never);
    const recorder = service.createRecorder({
      companyId: "company-1",
      heartbeatRunId: "run-1",
      redactionOptions: {
        enabled: false,
        secretValues: [secret],
      },
    });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      command: `printf '${secret}\\n'`,
      cwd: `/workspace/${secret}`,
      metadata: {
        adapterConfig: { apiKey: secret },
        authToken: secret,
      },
      run: async () => ({
        status: "succeeded",
        exitCode: 0,
        system: `starting ${secret}`,
        stdout: `${secret}\n`,
        stderr: `warning: ${secret}\n`,
        metadata: { resultSecret: secret },
      }),
    });

    const persisted = JSON.stringify(rows[0]);
    expect(persisted).not.toContain(secret);
    expect(operation.command).toBe("printf '***REDACTED***\\n'");
    expect(operation.cwd).toBe("/workspace/***REDACTED***");
    expect(operation.stdoutExcerpt).toBe("***REDACTED***\n");
    expect(operation.stderrExcerpt).toBe("warning: ***REDACTED***\n");
    expect(operation.metadata).toEqual({
      adapterConfig: { apiKey: "***REDACTED***" },
      authToken: "***REDACTED***",
      resultSecret: "***REDACTED***",
    });

    expect(operation.logRef).not.toBeNull();
    const rawLog = logStoreState.rawLog(operation.logRef!);
    expect(rawLog).not.toContain(secret);
    expect(rawLog).toContain("***REDACTED***");

    const firstRead = await service.readLog(operation.id);
    const secondRead = await service.readLog(operation.id);
    expect(firstRead.content).not.toContain(secret);
    expect(firstRead.content).toContain("***REDACTED***");
    expect(secondRead).toEqual(firstRead);
    expect(logStoreState.readCount()).toBe(1);
  });

  it("fails closed before inserting a generic JWT split across operation fields", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const rows: StoredOperation[] = [];
    const service = workspaceOperationService(createWorkspaceOperationDb(rows) as never);
    const recorder = service.createRecorder({
      companyId: "company-1",
      heartbeatRunId: "run-1",
      redactionOptions: { enabled: false },
    });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      command: token.slice(0, 10),
      cwd: token.slice(10, 18),
      metadata: { fragment: token.slice(18) },
      run: async () => ({ status: "succeeded" }),
    });

    expect(`${rows[0]?.command}${rows[0]?.cwd}${
      (rows[0]?.metadata as { fragment: string }).fragment
    }`).not.toContain(token);
    expect(operation.command).toBe("***REDACTED***");
    expect(operation.cwd).toBe("payload.");
    expect(operation.metadata).toEqual({ fragment: "signature_with-hyphen_" });
  });

  it("rechecks the complete operation before updating with result metadata", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const rows: StoredOperation[] = [];
    const service = workspaceOperationService(createWorkspaceOperationDb(rows) as never);
    const recorder = service.createRecorder({
      companyId: "company-1",
      heartbeatRunId: "run-1",
      redactionOptions: { enabled: false },
    });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      command: "eyJheader.",
      cwd: "payload.",
      run: async () => ({ metadata: { fragment: "signature_with-hyphen_" } }),
    });

    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(operation.command).toBe("***REDACTED***");
    expect(operation.cwd).toBe("payload.");
    expect(operation.metadata).toEqual({ fragment: "signature_with-hyphen_" });
  });

  it("sanitizes historical workspace rows when mapping service responses", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const now = new Date("2026-09-05T00:00:00.000Z");
    const rows: StoredOperation[] = [{
      id: "operation-1",
      companyId: "company-1",
      executionWorkspaceId: "workspace-1",
      heartbeatRunId: "run-1",
      phase: "workspace_provision",
      command: "eyJheader.",
      cwd: "payload.",
      status: "succeeded",
      exitCode: 0,
      logStore: null,
      logRef: null,
      logBytes: null,
      logSha256: null,
      logCompressed: false,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      metadata: { fragment: "signature_with-hyphen_" },
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    }];
    const service = workspaceOperationService(createWorkspaceOperationDb(rows) as never);

    const operation = await service.getById("operation-1");

    expect(`${operation?.command}${operation?.cwd}${
      (operation?.metadata as { fragment: string }).fragment
    }`).not.toContain(token);
    expect(operation?.command).toBe("***REDACTED***");
    expect(operation?.cwd).toBe("payload.");
    expect(operation?.metadata).toEqual({ fragment: "signature_with-hyphen_" });
  });

  it("fails closed when a run secret is split at stdout and stderr end-of-stream boundaries", async () => {
    const secretHalf = "workspace-secret-half";
    const secret = `${secretHalf}${secretHalf}`;
    const rows: StoredOperation[] = [];
    const service = workspaceOperationService(createWorkspaceOperationDb(rows) as never);
    const recorder = service.createRecorder({
      companyId: "company-1",
      heartbeatRunId: "run-1",
      redactionOptions: {
        enabled: false,
        secretValues: [secret],
      },
    });

    const operation = await recorder.recordOperation({
      phase: "workspace_provision",
      run: async () => ({
        stdout: secretHalf,
        stderr: secretHalf,
      }),
    });

    expect(operation.stdoutExcerpt).toBe("***REDACTED***");
    expect(operation.stderrExcerpt).toBe("***REDACTED***");
    expect(operation.logRef).not.toBeNull();
    expect(logStoreState.rawLog(operation.logRef!)).not.toContain(secretHalf);

    const firstRead = await service.readLog(operation.id);
    const secondRead = await service.readLog(operation.id);
    expect(firstRead.content).not.toContain(secretHalf);
    expect(firstRead.content.match(/\*\*\*REDACTED\*\*\*/g)).toHaveLength(2);
    expect(secondRead).toEqual(firstRead);
    expect(logStoreState.readCount()).toBe(1);
  });

  it("flushes a sensitive error prefix before finalizing a failed operation", async () => {
    const secretPrefix = "workspace-error-prefix";
    const secret = `${secretPrefix}-remaining-secret`;
    const rows: StoredOperation[] = [];
    const service = workspaceOperationService(createWorkspaceOperationDb(rows) as never);
    const recorder = service.createRecorder({
      companyId: "company-1",
      heartbeatRunId: "run-1",
      redactionOptions: {
        enabled: false,
        secretValues: [secret],
      },
    });

    let thrown: unknown;
    try {
      await recorder.recordOperation({
        phase: "workspace_provision",
        run: async () => {
          throw new Error(secretPrefix);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secretPrefix);
    expect((thrown as Error).message).toContain("***REDACTED***");

    expect(rows[0]?.stderrExcerpt).toBe("***REDACTED***");
    const operationId = rows[0]?.id as string;
    const logRef = rows[0]?.logRef as string;
    expect(logStoreState.rawLog(logRef)).not.toContain(secretPrefix);
    const log = await service.readLog(operationId);
    expect(log.content).not.toContain(secretPrefix);
    expect(log.content).toContain("***REDACTED***");
  });
});

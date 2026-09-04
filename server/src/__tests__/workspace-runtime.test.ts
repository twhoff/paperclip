import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createStreamingTextRedactor } from "../log-redaction.ts";
import {
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  executeProcess,
  normalizeAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";

const execFileAsync = promisify(execFile);
const leasedRunIds = new Set<string>();

describe("executeProcess", () => {
  it("bounds captured stdout and stderr", async () => {
    const result = await executeProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(5*1024*1024));process.stderr.write('y'.repeat(5*1024*1024));",
      ],
      cwd: os.tmpdir(),
      timeoutMs: 5_000,
      sanitizeOutput: true,
    });

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it.each([1, 2])("does not retain a credential tail when capture ends at byte %i", async (cut) => {
    const captureBytes = 4 * 1024 * 1024;
    const exactSecret = "runtime-capture-secret-value";
    const jwt = "eyJcapture.payload.signature_";
    const script = [
      `process.stdout.write('f'.repeat(${captureBytes - cut})+${JSON.stringify(jwt)});`,
      `process.stderr.write('g'.repeat(${captureBytes - cut})+process.env.RUNTIME_API_KEY);`,
    ].join("");
    const result = await executeProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: os.tmpdir(),
      env: { ...process.env, RUNTIME_API_KEY: exactSecret },
      timeoutMs: 5_000,
      sanitizeOutput: true,
    });

    expect(result.stdout).not.toContain(jwt.slice(cut));
    expect(result.stderr).not.toContain(exactSecret);
    expect(result.stderr).not.toContain(exactSecret.slice(0, cut));
    expect(result.stderr).toContain("***REDACTED***");
  });

  it("terminates a workspace child after its bounded timeout", async () => {
    const startedAt = Date.now();
    const result = await executeProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
      ],
      cwd: os.tmpdir(),
      timeoutMs: 100,
      killGraceMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.skipIf(process.platform === "win32")(
    "waits for a SIGTERM-resistant workspace descendant before returning from timeout",
    async () => {
      const grandchildScript =
        "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
      const parentScript = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
  stdio: ["ignore", "pipe", "ignore"],
});
grandchild.stdout.once("data", () => process.stdout.write(String(grandchild.pid)));
setInterval(() => {}, 1000);
`;
      let grandchildPid: number | null = null;

      try {
        const result = await executeProcess({
          command: process.execPath,
          args: ["-e", parentScript],
          cwd: os.tmpdir(),
          timeoutMs: 3_000,
          killGraceMs: 100,
        });
        grandchildPid = Number.parseInt(result.stdout, 10);

        expect(result.timedOut).toBe(true);
        expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
        expect(() => process.kill(grandchildPid!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        if (grandchildPid && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Expected once the process-group timeout has drained the child.
          }
        }
      }
    },
    10_000,
  );
});

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return repoRoot;
}

function buildWorkspace(cwd: string): RealizedExecutionWorkspace {
  return {
    baseCwd: cwd,
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: "HEAD",
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function createRuntimeServiceDbDouble() {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          writes.push(values);
        },
      }),
    }),
  } as unknown as Db;
  return { db, writes };
}

function createWorkspaceOperationRecorderDouble() {
  const operations: Array<{
    phase: string;
    command: string | null;
    cwd: string | null;
    metadata: Record<string, unknown> | null;
    result: {
      status?: string;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }> = [];
  let executionWorkspaceId: string | null = null;

  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async (nextExecutionWorkspaceId) => {
      executionWorkspaceId = nextExecutionWorkspaceId;
    },
    recordOperation: async (input) => {
      const result = await input.run();
      operations.push({
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
        },
        result,
      });
      return {
        id: `op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId,
        heartbeatRunId: "run-1",
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: "local_file",
        logRef: `op-${operations.length}.ndjson`,
        logBytes: 0,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: input.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };

  return { recorder, operations };
}

afterEach(async () => {
  await Promise.all(
    Array.from(leasedRunIds).map(async (runId) => {
      await releaseRuntimeServicesForRun(runId);
      leasedRunIds.delete(runId);
    }),
  );
  delete process.env.PAPERCLIP_CONFIG;
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  delete process.env.PCLI_SESSION_ID;
  delete process.env.HOLLY_SESSION_ID;
});

describe("realizeExecutionWorkspace", () => {
  it("creates and reuses a git worktree for an issue-scoped branch", async () => {
    const repoRoot = await createTempRepo();

    const first = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(first.strategy).toBe("git_worktree");
    expect(first.created).toBe(true);
    expect(first.branchName).toBe("PAP-447-add-worktree-support");
    expect(first.cwd).toContain(path.join(".paperclip", "worktrees"));
    await expect(fs.stat(path.join(first.cwd, ".git"))).resolves.toBeTruthy();

    const second = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branchName).toBe(first.branchName);
  });

  it("runs a configured provision command inside the derived worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_BRANCH\" > .paperclip-provision-branch",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_BASE_CWD\" > .paperclip-provision-base",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_CREATED\" > .paperclip-provision-created",
        "printf '%s|%s|%s|%s|%s|%s|%s\\n' \"${PAPERCLIP_AGENT_JWT_SECRET:+present}\" \"${DATABASE_URL:+present}\" \"${BETTER_AUTH_SECRET:+present}\" \"${PAPERCLIP_SECRETS_MASTER_KEY:+present}\" \"${PAPERCLIP_SECRETS_MASTER_KEY_FILE:+present}\" \"${PCLI_SESSION_ID:+present}\" \"${HOLLY_SESSION_ID:+present}\" > .paperclip-provision-control-plane",
        "printf '%s\\n' \"$PAPERCLIP_AGENT_ID\" > .paperclip-provision-agent",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    process.env.PAPERCLIP_AGENT_JWT_SECRET = "provision-signing-secret";
    process.env.DATABASE_URL = "postgres://provision.invalid/paperclip";
    process.env.BETTER_AUTH_SECRET = "provision-auth-secret";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "provision-master-key";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = "/private/provision-master-key";
    process.env.PCLI_SESSION_ID = "provision-parent-session";
    process.env.HOLLY_SESSION_ID = "agent-provision-parent";

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-branch"), "utf8")).resolves.toBe(
      "PAP-448-run-provision-command\n",
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-base"), "utf8")).resolves.toBe(
      `${repoRoot}\n`,
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-created"), "utf8")).resolves.toBe(
      "true\n",
    );
    await expect(
      fs.readFile(path.join(workspace.cwd, ".paperclip-provision-control-plane"), "utf8"),
    ).resolves.toBe("||||||\n");
    await expect(
      fs.readFile(path.join(workspace.cwd, ".paperclip-provision-agent"), "utf8"),
    ).resolves.toBe("agent-1\n");

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(reused.cwd, ".paperclip-provision-created"), "utf8")).resolves.toBe("false\n");
  });

  it("does not leak parent control-plane env through git worktree hooks", async () => {
    const repoRoot = await createTempRepo();
    const capturePath = path.join(repoRoot, ".git-hook-control-plane");
    const hookPath = path.join(repoRoot, ".git", "hooks", "post-checkout");
    await fs.writeFile(
      hookPath,
      [
        "#!/usr/bin/env bash",
        `printf '%s|%s|%s|%s|%s|%s|%s\\n' \"\${PAPERCLIP_AGENT_JWT_SECRET:+present}\" \"\${DATABASE_URL:+present}\" \"\${BETTER_AUTH_SECRET:+present}\" \"\${PAPERCLIP_SECRETS_MASTER_KEY:+present}\" \"\${PAPERCLIP_SECRETS_MASTER_KEY_FILE:+present}\" \"\${PCLI_SESSION_ID:+present}\" \"\${HOLLY_SESSION_ID:+present}\" > ${JSON.stringify(capturePath)}`,
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(hookPath, 0o755);

    process.env.PAPERCLIP_AGENT_JWT_SECRET = "hook-signing-secret";
    process.env.DATABASE_URL = "postgres://hook.invalid/paperclip";
    process.env.BETTER_AUTH_SECRET = "hook-auth-secret";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "hook-master-key";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = "/private/hook-master-key";
    process.env.PCLI_SESSION_ID = "hook-parent-session";
    process.env.HOLLY_SESSION_ID = "agent-hook-parent";

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-ENV",
        title: "Sanitize hook env",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(capturePath, "utf8")).resolves.toBe("||||||\n");
  });

  it("records worktree setup and provision operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'provisioned\\n'",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorder provision script"]);

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-540",
        title: "Record workspace operations",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "worktree_prepare",
      "workspace_provision",
    ]);
    expect(operations[0]?.command).toContain("git worktree add");
    expect(operations[0]?.metadata).toMatchObject({
      branchName: "PAP-540-record-workspace-operations",
      created: true,
    });
    expect(operations[1]?.command).toBe("bash ./scripts/provision.sh");
  });

  it("reuses an existing branch without resetting it when recreating a missing worktree", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-450-recreate-missing-worktree";

    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "preserve me\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add preserved feature"]);
    const expectedHead = (await execFileAsync("git", ["rev-parse", branchName], { cwd: repoRoot })).stdout.trim();
    await runGit(repoRoot, ["checkout", "main"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-450",
        title: "Recreate missing worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.branchName).toBe(branchName);
    await expect(fs.readFile(path.join(workspace.cwd, "feature.txt"), "utf8")).resolves.toBe("preserve me\n");
    const actualHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd })).stdout.trim();
    expect(actualHead).toBe(expectedHead);
  });

  it("removes a created git worktree and branch during cleanup", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Cleanup workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: "",
    });
  });

  it("keeps an unmerged runtime-created branch and warns instead of force deleting it", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Keep unmerged branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.writeFile(path.join(workspace.cwd, "unmerged.txt"), "still here\n", "utf8");
    await runGit(workspace.cwd, ["add", "unmerged.txt"]);
    await runGit(workspace.cwd, ["commit", "-m", "Keep unmerged work"]);

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).toContain(`Skipped deleting branch "${workspace.branchName}"`);
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(workspace.branchName!),
    });
  });

  it("redacts a current control secret echoed by a failing teardown command", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-redaction-"));
    const secret = "workspace-cleanup-control-secret-42";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspaceRoot,
        providerType: "local_fs",
        providerRef: workspaceRoot,
        branchName: null,
        repoUrl: null,
        baseRef: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-1",
        metadata: { createdByRuntime: false },
      },
      projectWorkspace: {
        cwd: workspaceRoot,
        cleanupCommand: `node -e "process.stderr.write('${secret}'); process.exit(1)"`,
      },
      redactionOptions: { enabled: false },
    });

    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).not.toContain(secret);
    expect(cleanup.warnings[0]).toContain("***REDACTED***");
  });

  it("records teardown and cleanup operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-541",
        title: "Cleanup recorder",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: "printf 'cleanup ok\\n'",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "workspace_teardown",
      "worktree_cleanup",
      "worktree_cleanup",
    ]);
    expect(operations[0]?.command).toBe("printf 'cleanup ok\\n'");
    expect(operations[1]?.metadata).toMatchObject({
      cleanupAction: "worktree_remove",
    });
    expect(operations[2]?.metadata).toMatchObject({
      cleanupAction: "branch_delete",
    });
  });
});

describe("ensureRuntimeServicesForRun", () => {
  it("routes shared service logs only to currently leased runs and contains callback failures", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-logs-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"const http=require('node:http'); let n=0; http.createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT),'127.0.0.1',()=>setInterval(() => console.log('tick-'+(++n)), 20))\"";
    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "ticker",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: { type: "on_run_finish" },
          },
        ],
      },
    };
    const firstLogs: string[] = [];
    const secondLogs: string[] = [];
    const run1 = "run-log-1";
    const run2 = "run-log-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await ensureRuntimeServicesForRun({
      runId: run1,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
      onLog: async (_stream, chunk) => {
        firstLogs.push(chunk);
        throw new Error("simulated closed run log");
      },
    });
    const second = await ensureRuntimeServicesForRun({
      runId: run2,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
      onLog: async (_stream, chunk) => {
        secondLogs.push(chunk);
      },
    });

    expect(second[0]?.id).toBe(first[0]?.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(firstLogs.length).toBeGreaterThan(0);
    expect(secondLogs.length).toBeGreaterThan(0);

    await releaseRuntimeServicesForRun(run1);
    leasedRunIds.delete(run1);
    const firstCountAfterRelease = firstLogs.length;
    const secondCountAfterRelease = secondLogs.length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(firstLogs).toHaveLength(firstCountAfterRelease);
    expect(secondLogs.length).toBeGreaterThan(secondCountAfterRelease);
  });

  it("rotates every shared-service log sink when a later lease adds a secret", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-rotate-"));
    const workspace = buildWorkspace(workspaceRoot);
    const secret = "later-lease-runtime-secret-value";
    const script = [
      "const http=require('node:http');",
      "http.createServer((req,res)=>{",
      "const value=decodeURIComponent((req.url||'/').slice(1));",
      "if(value) process.stdout.write(value+'\\n');",
      "res.end('ok');",
      "}).listen(Number(process.env.PORT),'127.0.0.1');",
    ].join("");
    const config = {
      workspaceRuntime: {
        services: [{
          name: "echo-service",
          command: `node -e ${JSON.stringify(script)}`,
          port: { type: "auto" },
          readiness: {
            type: "http",
            urlTemplate: "http://127.0.0.1:{{port}}",
            timeoutSec: 10,
            intervalMs: 100,
          },
          lifecycle: "shared",
          reuseScope: "project_workspace",
          stopPolicy: { type: "on_run_finish" },
        }],
      },
    };
    const firstLogs: string[] = [];
    const secondLogs: string[] = [];
    const run1 = "run-rotate-1";
    const run2 = "run-rotate-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await ensureRuntimeServicesForRun({
      runId: run1,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
      onLog: async (_stream, chunk) => { firstLogs.push(chunk); },
    });
    const second = await ensureRuntimeServicesForRun({
      runId: run2,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
      resolvedSecretValues: [secret],
      onLog: async (_stream, chunk) => { secondLogs.push(chunk); },
    });
    expect(second[0]?.id).toBe(first[0]?.id);

    await fetch(`${first[0]!.url}/${encodeURIComponent(secret)}`);
    const deadline = Date.now() + 2_000;
    while ((firstLogs.length === 0 || secondLogs.length === 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    for (const output of [firstLogs.join(""), secondLogs.join("")]) {
      expect(output).not.toContain(secret);
      expect(output).toContain("***REDACTED***");
    }
  });

  it("redacts split runtime-service credentials before decorating persisted run logs", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-redaction-"));
    const workspace = buildWorkspace(workspaceRoot);
    const exactSecret = "sk-ant-runtime-service-secret-123456";
    const danglingSecret = "sk-runtime-dangling-secret-987654";
    const crossStreamSecret = "runtime-cross-stream-secret-abcdef";
    const jwt = "eyJruntime.payload.signature_with-hyphen_";
    const exactSplit = Math.floor(exactSecret.length / 2);
    const danglingSplit = Math.floor(danglingSecret.length / 2);
    const jwtSplit = jwt.indexOf("payload");
    const crossStreamSplit = crossStreamSecret.indexOf("abcdef");
    const script = [
      "const http = require('node:http');",
      "const exact = process.env.ANTHROPIC_API_KEY ?? '';",
      "const dangling = process.env.OPENAI_API_KEY ?? '';",
      "const crossStream = process.env.RUNTIME_CROSS_STREAM_SECRET ?? '';",
      `process.stdout.write(exact.slice(0, ${exactSplit}));`,
      `setTimeout(() => process.stdout.write(exact.slice(${exactSplit}) + '\\n'), 30);`,
      `setTimeout(() => process.stderr.write(${JSON.stringify(jwt.slice(0, jwtSplit))}), 60);`,
      `setTimeout(() => process.stderr.write(${JSON.stringify(jwt.slice(jwtSplit))} + '\\n'), 90);`,
      `setTimeout(() => process.stdout.write(crossStream.slice(0, ${crossStreamSplit})), 120);`,
      `setTimeout(() => process.stderr.write(crossStream.slice(${crossStreamSplit})), 150);`,
      "setTimeout(() => process.stdout.write('safe-marker'), 180);",
      `setTimeout(() => process.stdout.write(dangling.slice(0, ${danglingSplit})), 210);`,
      "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join(" ");
    const serviceCommand = `node -e ${JSON.stringify(script)}`;
    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "credential-probe",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            lifecycle: "ephemeral",
            stopPolicy: { type: "on_run_finish" },
          },
        ],
      },
    };
    const sinkChunks = { stdout: [] as string[], stderr: [] as string[] };
    const persistedChunks = { stdout: [] as string[], stderr: [] as string[] };
    const excerpts = { stdout: "", stderr: "" };
    const downstream = {
      stdout: createStreamingTextRedactor({
        enabled: false,
        secretValues: [exactSecret, danglingSecret, crossStreamSecret],
      }),
      stderr: createStreamingTextRedactor({
        enabled: false,
        secretValues: [exactSecret, danglingSecret, crossStreamSecret],
      }),
    };
    const runId = "run-runtime-redaction";
    leasedRunIds.add(runId);

    await ensureRuntimeServicesForRun({
      runId,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config,
      adapterEnv: {
          ANTHROPIC_API_KEY: exactSecret,
          OPENAI_API_KEY: danglingSecret,
          RUNTIME_CROSS_STREAM_SECRET: crossStreamSecret,
      },
      onLog: async (stream, chunk) => {
        sinkChunks[stream].push(chunk);
        const sanitized = downstream[stream].push(chunk);
        if (!sanitized) return;
        persistedChunks[stream].push(sanitized);
        excerpts[stream] = (excerpts[stream] + sanitized).slice(-4096);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 280));
    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
    for (const stream of ["stdout", "stderr"] as const) {
      const tail = downstream[stream].flush();
      if (tail) {
        persistedChunks[stream].push(tail);
        excerpts[stream] = (excerpts[stream] + tail).slice(-4096);
      }
    }

    const removeDecoration = (value: string) =>
      value.replaceAll("[service:credential-probe] ", "");
    const persisted = removeDecoration(
      [...persistedChunks.stdout, ...persistedChunks.stderr].join(""),
    );
    const excerpt = removeDecoration(`${excerpts.stdout}${excerpts.stderr}`);
    const delivered = removeDecoration(
      [...sinkChunks.stdout, ...sinkChunks.stderr].join(""),
    );
    for (const value of [delivered, persisted, excerpt]) {
      expect(value).not.toContain(exactSecret);
      expect(value).not.toContain(jwt);
      expect(value).not.toContain(danglingSecret.slice(0, danglingSplit));
      expect(value).not.toContain(crossStreamSecret.slice(0, crossStreamSplit));
      expect(value).toContain("***REDACTED***");
    }
  });

  it("reuses shared runtime services across runs and starts a new service after release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-workspace-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"";

    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const run1 = "run-1";
    const run2 = "run-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await ensureRuntimeServicesForRun({
      runId: run1,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.reused).toBe(false);
    expect(first[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(first[0]!.url!);
    expect(await response.text()).toBe("ok");

    const second = await ensureRuntimeServicesForRun({
      runId: run2,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.reused).toBe(true);
    expect(second[0]?.id).toBe(first[0]?.id);

    await releaseRuntimeServicesForRun(run1);
    leasedRunIds.delete(run1);
    await releaseRuntimeServicesForRun(run2);
    leasedRunIds.delete(run2);

    const run3 = "run-3";
    leasedRunIds.add(run3);
    const third = await ensureRuntimeServicesForRun({
      runId: run3,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(third).toHaveLength(1);
    expect(third[0]?.reused).toBe(false);
    expect(third[0]?.id).not.toBe(first[0]?.id);
  });

  it("does not reuse a shared child after its resolved environment or command changes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-fingerprint-"));
    const workspace = buildWorkspace(workspaceRoot);
    const buildConfig = (marker: string) => ({
      workspaceRuntime: {
        services: [
          {
            name: "fingerprint-probe",
            command: `node -e ${JSON.stringify(
              `require('node:http').createServer((req,res)=>res.end('${marker}:' + process.env.RUNTIME_ROTATION_SECRET)).listen(Number(process.env.PORT), '127.0.0.1')`,
            )}`,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: { type: "on_run_finish" },
          },
        ],
      },
    });
    const agent = { id: "agent-1", name: "Codex Coder", companyId: "company-1" };
    const firstRun = "run-fingerprint-1";
    const secondRun = "run-fingerprint-2";
    const thirdRun = "run-fingerprint-3";
    leasedRunIds.add(firstRun);
    leasedRunIds.add(secondRun);
    leasedRunIds.add(thirdRun);

    const first = await ensureRuntimeServicesForRun({
      runId: firstRun,
      agent,
      issue: null,
      workspace,
      config: buildConfig("base"),
      adapterEnv: { RUNTIME_ROTATION_SECRET: "rotation-secret-one" },
    });
    const second = await ensureRuntimeServicesForRun({
      runId: secondRun,
      agent,
      issue: null,
      workspace,
      config: buildConfig("base"),
      adapterEnv: { RUNTIME_ROTATION_SECRET: "rotation-secret-two" },
    });
    const third = await ensureRuntimeServicesForRun({
      runId: thirdRun,
      agent,
      issue: null,
      workspace,
      config: buildConfig("changed-command"),
      adapterEnv: { RUNTIME_ROTATION_SECRET: "rotation-secret-two" },
    });

    expect(second[0]?.reused).toBe(false);
    expect(second[0]?.id).not.toBe(first[0]?.id);
    expect(await fetch(second[0]!.url!).then((response) => response.text())).toBe(
      "base:rotation-secret-two",
    );
    expect(third[0]?.reused).toBe(false);
    expect(third[0]?.id).not.toBe(second[0]?.id);
    expect(await fetch(third[0]!.url!).then((response) => response.text())).toBe(
      "changed-command:rotation-secret-two",
    );
  });

  it("rejects an immediate-exit child without persisting it as running", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-exit-"));
    const workspace = buildWorkspace(workspaceRoot);
    const { db, writes } = createRuntimeServiceDbDouble();

    await expect(
      ensureRuntimeServicesForRun({
        db,
        runId: "run-immediate-exit",
        agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
        issue: null,
        workspace,
        config: {
          workspaceRuntime: {
            services: [
              {
                name: "immediate-exit",
                command: "exit 0",
                lifecycle: "shared",
                reuseScope: "project_workspace",
              },
            ],
          },
        },
        adapterEnv: {},
      }),
    ).rejects.toThrow(/exited during startup/);

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((write) => write.status === "running")).toBe(false);
    expect(writes.at(-1)?.status).toBe("failed");
  });

  it.skipIf(process.platform === "win32")(
    "stops a local runtime service when its initial persistence fails",
    async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-runtime-persist-failure-"),
      );
      const childPidPath = path.join(workspaceRoot, "child.pid");
      const workspace = buildWorkspace(workspaceRoot);
      const writes: Array<Record<string, unknown>> = [];
      let persistenceAttempts = 0;
      const db = {
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            onConflictDoUpdate: async () => {
              persistenceAttempts += 1;
              if (persistenceAttempts === 1) {
                for (let attempt = 0; attempt < 100; attempt += 1) {
                  try {
                    await fs.access(childPidPath);
                    break;
                  } catch {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                  }
                }
                throw new Error("simulated runtime persistence failure");
              }
              writes.push(values);
            },
          }),
        }),
      } as unknown as Db;
      let childPid: number | null = null;

      try {
        await expect(
          ensureRuntimeServicesForRun({
            db,
            runId: "run-persist-failure",
            agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
            issue: null,
            workspace,
            config: {
              workspaceRuntime: {
                services: [
                  {
                    name: "persist-failure",
                    command: `node -e ${JSON.stringify(
                      `require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`,
                    )}`,
                    lifecycle: "ephemeral",
                  },
                ],
              },
            },
            adapterEnv: {},
          }),
        ).rejects.toThrow(/Failed to start runtime service/);

        for (let attempt = 0; attempt < 50 && childPid === null; attempt += 1) {
          try {
            childPid = Number(await fs.readFile(childPidPath, "utf8"));
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(() => process.kill(childPid!, 0)).toThrow();
        expect(writes.at(-1)?.status).toBe("failed");
      } finally {
        if (childPid !== null) {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            try {
              process.kill(childPid, "SIGKILL");
            } catch {
              // Expected once failed startup cleanup has fully completed.
            }
          }
        }
      }
    },
    15_000,
  );

  it("aborts a hanging HTTP readiness request at the configured deadline", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-readiness-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-hanging-readiness";
    leasedRunIds.add(runId);
    const originalFetch = globalThis.fetch;
    let receivedAbortSignal = false;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      receivedAbortSignal = signal instanceof AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Readiness request aborted", "AbortError")),
            { once: true },
          );
          return;
        }
        setTimeout(() => reject(new Error("Readiness request remained unbounded")), 1_500);
      });
    }) as typeof fetch;

    const startedAt = Date.now();
    try {
      await expect(
        ensureRuntimeServicesForRun({
          runId,
          agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
          issue: null,
          workspace,
          config: {
            workspaceRuntime: {
              services: [
                {
                  name: "hanging-readiness",
                  command: "node -e \"setInterval(() => {}, 1000)\"",
                  port: { type: "auto" },
                  readiness: {
                    type: "http",
                    urlTemplate: "http://127.0.0.1:{{port}}",
                    timeoutSec: 1,
                    intervalMs: 100,
                  },
                  lifecycle: "ephemeral",
                  stopPolicy: { type: "on_run_finish" },
                },
              ],
            },
          },
          adapterEnv: {},
        }),
      ).rejects.toThrow(/Readiness check failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receivedAbortSignal).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_400);
  });

  it("bounds hostile resolved-secret iterables and fails closed on overflow", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-secrets-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-hostile-secret-values";
    leasedRunIds.add(runId);
    let yielded = 0;
    const hostileSecretValues: Iterable<string> = {
      *[Symbol.iterator]() {
        while (yielded < 200) {
          yielded += 1;
          yield `hostile-secret-${yielded}`;
        }
        throw new Error("secret iterable was consumed without a bound");
      },
    };
    const delivered: string[] = [];

    const refs = await ensureRuntimeServicesForRun({
      runId,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "overflow-service",
              command: "node -e \"process.stdout.write('visible-output'); setInterval(() => {}, 1000)\"",
              lifecycle: "ephemeral",
              stopPolicy: { type: "on_run_finish" },
            },
          ],
        },
      },
      adapterEnv: {},
      resolvedSecretValues: hostileSecretValues,
      onLog: async (_stream, chunk) => {
        delivered.push(chunk);
      },
    });

    const logDeadline = Date.now() + 2_000;
    while (delivered.length === 0 && Date.now() < logDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(yielded).toBeLessThanOrEqual(129);
    expect(refs[0]?.serviceName).toBe("***REDACTED***");
    expect(delivered.join("")).toContain("***REDACTED***");
    expect(delivered.join("")).not.toContain("visible-output");
  });

  it("projects secret-bearing service metadata before logs, refs, and persistence", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-metadata-"));
    const exactSecret = "runtime-metadata-secret-value-123456";
    const splitAt = 18;
    const serviceName = exactSecret.slice(0, splitAt);
    const serviceCwd = path.join(workspaceRoot, exactSecret);
    await fs.mkdir(serviceCwd, { recursive: true });
    const workspace = buildWorkspace(workspaceRoot);
    const { db, writes } = createRuntimeServiceDbDouble();
    const delivered: string[] = [];
    const runId = "run-secret-metadata";
    leasedRunIds.add(runId);

    const refs = await ensureRuntimeServicesForRun({
      db,
      runId,
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      config: {
        workspaceRuntime: {
          services: [
            {
              name: serviceName,
              command: `node -e ${JSON.stringify(
                `process.stdout.write((process.env.RUNTIME_DISPLAY_VALUE || '').slice(${splitAt})); setInterval(() => {}, 1000)`,
              )}`,
              cwd: exactSecret,
              expose: { urlTemplate: `http://example.invalid/${exactSecret}` },
              lifecycle: "ephemeral",
              stopPolicy: { type: "on_run_finish", note: exactSecret },
            },
          ],
        },
      },
      adapterEnv: { RUNTIME_DISPLAY_VALUE: exactSecret },
      resolvedSecretValues: [exactSecret],
      onLog: async (_stream, chunk) => {
        delivered.push(chunk);
      },
    });

    const logDeadline = Date.now() + 2_000;
    while (delivered.length === 0 && Date.now() < logDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const returnedJson = JSON.stringify(refs);
    const persistedJson = JSON.stringify(writes.at(-1));
    const deliveredText = delivered.join("");
    for (const value of [returnedJson, persistedJson, deliveredText]) {
      expect(value).not.toContain(exactSecret);
      expect(value).not.toContain(serviceName);
      expect(value).toContain("***REDACTED***");
    }
    expect(refs[0]?.serviceName).toBe("***REDACTED***");
    expect(writes.at(-1)?.status).toBe("running");
  });

  it("does not leak parent Paperclip instance env into runtime service commands", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-env-"));
    const workspace = buildWorkspace(workspaceRoot);
    const envCapturePath = path.join(workspaceRoot, "captured-env.json");
    const serviceCommand = [
      "node -e",
      JSON.stringify(
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(envCapturePath)}, JSON.stringify({`,
          "paperclipConfig: process.env.PAPERCLIP_CONFIG ?? null,",
          "paperclipHome: process.env.PAPERCLIP_HOME ?? null,",
          "paperclipInstanceId: process.env.PAPERCLIP_INSTANCE_ID ?? null,",
          "paperclipAgentJwtSecret: process.env.PAPERCLIP_AGENT_JWT_SECRET ?? null,",
          "databaseUrl: process.env.DATABASE_URL ?? null,",
          "betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? null,",
          "secretsMasterKey: process.env.PAPERCLIP_SECRETS_MASTER_KEY ?? null,",
          "secretsMasterKeyFile: process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ?? null,",
          "pcliSessionId: process.env.PCLI_SESSION_ID ?? null,",
          "hollySessionId: process.env.HOLLY_SESSION_ID ?? null,",
          "paperclipApiKey: process.env.PAPERCLIP_API_KEY ?? null,",
          "mixedPaperclipApiKey: process.env.paperclip_api_key ?? null,",
          "mixedDatabaseUrl: process.env.DaTaBaSe_Url ?? null,",
          "mixedPcliSessionId: process.env.pCli_SeSsIoN_iD ?? null,",
          "mixedHollySessionId: process.env.hOlLy_SeSsIoN_iD ?? null,",
          "futurePaperclipValue: process.env.pApErClIp_FuTuRe_PrIvAtE ?? null,",
          "workspaceCwd: process.env.PAPERCLIP_WORKSPACE_CWD ?? null,",
          "customEnv: process.env.RUNTIME_CUSTOM_ENV ?? null,",
          "port: process.env.PORT ?? null,",
          "}));",
          "require('node:http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
        ].join(" "),
      ),
    ].join(" ");

    process.env.PAPERCLIP_CONFIG = "/tmp/base-paperclip-config.json";
    process.env.PAPERCLIP_HOME = "/tmp/base-paperclip-home";
    process.env.PAPERCLIP_INSTANCE_ID = "base-instance";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "base-agent-jwt-secret";
    process.env.DATABASE_URL = "postgres://shared-db.example.com/paperclip";
    process.env.BETTER_AUTH_SECRET = "base-better-auth-secret";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "base-secrets-master-key";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = "/private/base-secrets-master-key";
    process.env.PCLI_SESSION_ID = "base-pcli-session";
    process.env.HOLLY_SESSION_ID = "base-holly-session";

    const runId = "run-env";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: serviceCommand,
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "on_run_finish",
              },
              env: {
                paperclip_api_key: "configured-mixed-paperclip-key",
                DaTaBaSe_Url: "postgres://configured.invalid/paperclip",
                pCli_SeSsIoN_iD: "configured-pcli-session",
                hOlLy_SeSsIoN_iD: "configured-holly-session",
                PAPERCLIP_WORKSPACE_CWD: "/configured/spoofed/workspace",
              },
            },
          ],
        },
      },
      adapterEnv: {
        RUNTIME_CUSTOM_ENV: "from-adapter",
        PAPERCLIP_API_KEY: "adapter-paperclip-key",
        DATABASE_URL: "postgres://adapter.invalid/paperclip",
        PCLI_SESSION_ID: "adapter-pcli-session",
        HOLLY_SESSION_ID: "adapter-holly-session",
        pApErClIp_FuTuRe_PrIvAtE: "adapter-future-private-value",
      },
    });

    expect(services).toHaveLength(1);
    const captured = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as Record<string, string | null>;
    expect(captured.paperclipConfig).toBeNull();
    expect(captured.paperclipHome).toBeNull();
    expect(captured.paperclipInstanceId).toBeNull();
    expect(captured.paperclipAgentJwtSecret).toBeNull();
    expect(captured.databaseUrl).toBeNull();
    expect(captured.betterAuthSecret).toBeNull();
    expect(captured.secretsMasterKey).toBeNull();
    expect(captured.secretsMasterKeyFile).toBeNull();
    expect(captured.pcliSessionId).toBeNull();
    expect(captured.hollySessionId).toBeNull();
    expect(captured.paperclipApiKey).toBeNull();
    expect(captured.mixedPaperclipApiKey).toBeNull();
    expect(captured.mixedDatabaseUrl).toBeNull();
    expect(captured.mixedPcliSessionId).toBeNull();
    expect(captured.mixedHollySessionId).toBeNull();
    expect(captured.futurePaperclipValue).toBeNull();
    expect(captured.workspaceCwd).toBe(workspace.cwd);
    expect(captured.customEnv).toBe("from-adapter");
    expect(captured.port).toMatch(/^\d+$/);
    expect(services[0]?.executionWorkspaceId).toBe("execution-workspace-1");
    expect(services[0]?.scopeType).toBe("execution_workspace");
    expect(services[0]?.scopeId).toBe("execution-workspace-1");
  });

  it("stops execution workspace runtime services by executionWorkspaceId", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stop-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-stop";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-stop",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services[0]?.url).toBeTruthy();
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-stop",
      workspaceCwd: workspace.cwd,
    });
    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(fetch(services[0]!.url!)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "waits for a SIGTERM-resistant runtime service process group to exit before persisting stopped",
    async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-runtime-force-stop-"),
      );
      const childPidPath = path.join(workspaceRoot, "child.pid");
      const workspace = buildWorkspace(workspaceRoot);
      const { db, writes } = createRuntimeServiceDbDouble();
      const runId = "run-force-stop";
      leasedRunIds.add(runId);
      let childPid: number | null = null;
      let processGroupId: number | null = null;
      let stopping: Promise<void> | null = null;

      try {
        const services = await ensureRuntimeServicesForRun({
          db,
          runId,
          agent: {
            id: "agent-1",
            name: "Codex Coder",
            companyId: "company-1",
          },
          issue: null,
          workspace,
          executionWorkspaceId: "execution-workspace-force-stop",
          config: {
            workspaceRuntime: {
              services: [
                {
                  name: "term-resistant",
                  command: `node -e ${JSON.stringify(
                    `require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`,
                  )} >/dev/null 2>&1 & wait`,
                  lifecycle: "shared",
                  reuseScope: "execution_workspace",
                  stopPolicy: { type: "manual" },
                },
              ],
            },
          },
          adapterEnv: {},
        });
        processGroupId = Number(services[0]?.providerRef);
        expect(Number.isSafeInteger(processGroupId)).toBe(true);
        for (let attempt = 0; attempt < 50 && childPid === null; attempt += 1) {
          try {
            childPid = Number(await fs.readFile(childPidPath, "utf8"));
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(Number.isSafeInteger(childPid)).toBe(true);

        const writesBeforeStop = writes.length;
        stopping = stopRuntimeServicesForExecutionWorkspace({
          executionWorkspaceId: "execution-workspace-force-stop",
          workspaceCwd: workspace.cwd,
        });
        let processGroupLeaderExited = false;
        for (let attempt = 0; attempt < 100 && !processGroupLeaderExited; attempt += 1) {
          try {
            process.kill(processGroupId!, 0);
          } catch {
            processGroupLeaderExited = true;
          }
          if (!processGroupLeaderExited) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(processGroupLeaderExited).toBe(true);
        expect(() => process.kill(childPid!, 0)).not.toThrow();
        expect(
          writes.slice(writesBeforeStop).some((write) => write.status === "stopped"),
        ).toBe(false);

        await stopping;
        stopping = null;
        await releaseRuntimeServicesForRun(runId);
        leasedRunIds.delete(runId);

        expect(() => process.kill(childPid!, 0)).toThrow();
        expect(writes.at(-1)?.status).toBe("stopped");
      } finally {
        if (processGroupId !== null) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch {
            // Expected once the runtime service process group is gone.
          }
        }
        if (childPid !== null) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Expected once the runtime service stop has fully completed.
          }
        }
        if (stopping) {
          await stopping.catch(() => undefined);
        }
      }
    },
    15_000,
  );

  it("does not stop services in sibling directories when matching by workspace cwd", async () => {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-sibling-"));
    const targetWorkspaceRoot = path.join(workspaceParent, "project");
    const siblingWorkspaceRoot = path.join(workspaceParent, "project-extended", "service");
    await fs.mkdir(targetWorkspaceRoot, { recursive: true });
    await fs.mkdir(siblingWorkspaceRoot, { recursive: true });

    const siblingWorkspace = buildWorkspace(siblingWorkspaceRoot);
    const runId = "run-sibling";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: siblingWorkspace,
      executionWorkspaceId: "execution-workspace-sibling",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-target",
      workspaceCwd: targetWorkspaceRoot,
    });

    const response = await fetch(services[0]!.url!);
    expect(await response.text()).toBe("ok");

    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
  });
});

describe("normalizeAdapterManagedRuntimeServices", () => {
  it("fills workspace defaults and derives stable ids for adapter-managed services", () => {
    const workspace = buildWorkspace("/tmp/project");
    const now = new Date("2026-03-09T12:00:00.000Z");

    const first = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    const second = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: null,
      issueId: "issue-1",
      serviceName: "preview",
      provider: "adapter_managed",
      status: "running",
      healthStatus: "healthy",
      startedByRunId: "run-1",
    });
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("prefers execution workspace ids over cwd for execution-scoped adapter services", () => {
    const workspace = buildWorkspace("/tmp/project");

    const refs = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports: [
        {
          serviceName: "preview",
          scopeType: "execution_workspace",
        },
      ],
    });

    expect(refs[0]).toMatchObject({
      scopeType: "execution_workspace",
      scopeId: "execution-workspace-1",
      executionWorkspaceId: "execution-workspace-1",
    });
  });
});

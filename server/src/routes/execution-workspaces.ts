import { and, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { agents, companies, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { updateExecutionWorkspaceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, logActivity, workspaceOperationService } from "../services/index.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  normalizeExecutionWorkspaceListLimit,
  toExecutionWorkspace,
} from "../services/execution-workspaces.js";
import {
  materializeCurrentUserRedactionOptions,
  redactDiagnosticResponseValue,
  redactStatelessDiagnosticResponseValue,
  redactThrownDiagnosticError,
} from "../log-redaction.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const execFileAsync = promisify(execFile);

type GitExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ExecutionWorkspaceRouteOptions {
  execFile?: GitExecFile;
  processEnv?: NodeJS.ProcessEnv;
}

const GIT_CHILD_ENV_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
]);

export function buildExecutionWorkspaceGitEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => GIT_CHILD_ENV_KEYS.has(key.toUpperCase())),
  );
}

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export function executionWorkspaceRoutes(
  db: Db,
  options: ExecutionWorkspaceRouteOptions = {},
) {
  const router = Router();
  const runGit = options.execFile ?? (execFileAsync as GitExecFile);
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);

  router.get("/companies/:companyId/execution-workspaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const enriched = req.query.enriched === "true";
    const limit = normalizeExecutionWorkspaceListLimit(
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    );

    if (enriched) {
      const conditions = [eq(executionWorkspaces.companyId, companyId)];
      if (req.query.projectId) conditions.push(eq(executionWorkspaces.projectId, req.query.projectId as string));
      if (req.query.projectWorkspaceId) {
        conditions.push(eq(executionWorkspaces.projectWorkspaceId, req.query.projectWorkspaceId as string));
      }
      if (req.query.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, req.query.issueId as string));
      if (req.query.status) {
        const statuses = (req.query.status as string).split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
        else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
      }

      const issuesAlias = issues;
      const agentsAlias = agents;
      const rows = await db
        .select({
          workspace: executionWorkspaces,
          issue: {
            id: issuesAlias.id,
            title: issuesAlias.title,
            identifier: issuesAlias.identifier,
            status: issuesAlias.status,
          },
          agent: {
            id: agentsAlias.id,
            name: agentsAlias.name,
          },
        })
        .from(executionWorkspaces)
        .leftJoin(issuesAlias, eq(issuesAlias.id, executionWorkspaces.sourceIssueId))
        .leftJoin(agentsAlias, eq(agentsAlias.id, issuesAlias.assigneeAgentId))
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
        .limit(limit);

      const result = rows.map((row) => ({
        ...toExecutionWorkspace(row.workspace),
        issue: row.issue?.id ? { id: row.issue.id, title: row.issue.title, identifier: row.issue.identifier, status: row.issue.status } : null,
        agent: row.agent?.id ? { id: row.agent.id, name: row.agent.name } : null,
      }));
      res.json(redactStatelessDiagnosticResponseValue(result, {
        enabled: false,
        extraDiagnosticKeys: ["cleanupReason"],
      }));
      return;
    }

    const workspaces = await svc.list(companyId, {
      projectId: req.query.projectId as string | undefined,
      projectWorkspaceId: req.query.projectWorkspaceId as string | undefined,
      issueId: req.query.issueId as string | undefined,
      status: req.query.status as string | undefined,
      reuseEligible: req.query.reuseEligible === "true",
      limit,
    });
    res.json(redactStatelessDiagnosticResponseValue(
      workspaces.map(toExecutionWorkspace),
      { enabled: false, extraDiagnosticKeys: ["cleanupReason"] },
    ));
  });

  router.get("/execution-workspaces/:id", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    res.json(toExecutionWorkspace(workspace));
  });

  router.patch("/execution-workspaces/:id", validate(updateExecutionWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const patchRedactionOptions = materializeCurrentUserRedactionOptions({
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    });
    const hasCleanupReason = Object.prototype.hasOwnProperty.call(req.body, "cleanupReason");
    const hasMetadata = Object.prototype.hasOwnProperty.call(req.body, "metadata");
    const sanitizedDiagnostics = redactDiagnosticResponseValue({
      ...(hasCleanupReason ? { cleanupReason: req.body.cleanupReason } : {}),
      ...(hasMetadata ? { metadata: req.body.metadata } : {}),
    }, {
      ...patchRedactionOptions,
      extraDiagnosticKeys: ["cleanupReason", "metadata"],
    });
    const sanitizedMetadata = hasMetadata && sanitizedDiagnostics.metadata !== null
      && (typeof sanitizedDiagnostics.metadata !== "object" || Array.isArray(sanitizedDiagnostics.metadata))
      ? { redacted: sanitizedDiagnostics.metadata }
      : sanitizedDiagnostics.metadata;
    const patch: Record<string, unknown> = {
      ...req.body,
      ...(hasCleanupReason ? { cleanupReason: sanitizedDiagnostics.cleanupReason } : {}),
      ...(hasMetadata ? { metadata: sanitizedMetadata } : {}),
      ...(req.body.cleanupEligibleAt ? { cleanupEligibleAt: new Date(req.body.cleanupEligibleAt) } : {}),
    };
    let workspace = existing;
    let cleanupWarnings: string[] = [];

    if (req.body.status === "archived" && existing.status !== "archived") {
      const cleanupRedactionOptions = patchRedactionOptions;
      const linkedIssues = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, existing.companyId), eq(issues.executionWorkspaceId, existing.id)));
      const activeLinkedIssues = linkedIssues.filter((issue) => !TERMINAL_ISSUE_STATUSES.has(issue.status));

      if (activeLinkedIssues.length > 0) {
        res.status(409).json({
          error: `Cannot archive execution workspace while ${activeLinkedIssues.length} linked issue(s) are still open`,
        });
        return;
      }

      const closedAt = new Date();
      const archivedWorkspace = await svc.update(id, {
        ...patch,
        status: "archived",
        closedAt,
        cleanupReason: null,
      });
      if (!archivedWorkspace) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      workspace = archivedWorkspace;

      try {
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId: existing.id,
          workspaceCwd: existing.cwd,
        });
        const projectWorkspace = existing.projectWorkspaceId
          ? await db
              .select({
                cwd: projectWorkspaces.cwd,
                cleanupCommand: projectWorkspaces.cleanupCommand,
              })
              .from(projectWorkspaces)
              .where(
                and(
                  eq(projectWorkspaces.id, existing.projectWorkspaceId),
                  eq(projectWorkspaces.companyId, existing.companyId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
        const projectPolicy = existing.projectId
          ? await db
              .select({
                executionWorkspacePolicy: projects.executionWorkspacePolicy,
              })
              .from(projects)
              .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
              .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
          : null;
        const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
          workspace: existing,
          projectWorkspace,
          teardownCommand: projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
          recorder: workspaceOperationsSvc.createRecorder({
            companyId: existing.companyId,
            executionWorkspaceId: existing.id,
            redactionOptions: cleanupRedactionOptions,
          }),
          redactionOptions: cleanupRedactionOptions,
        });
        cleanupWarnings = cleanupResult.warnings;
        const cleanupPatch: Record<string, unknown> = {
          closedAt,
          cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
        };
        if (!cleanupResult.cleaned) {
          cleanupPatch.status = "cleanup_failed";
        }
        if (cleanupResult.warnings.length > 0 || !cleanupResult.cleaned) {
          workspace = (await svc.update(id, cleanupPatch)) ?? workspace;
        }
      } catch (error) {
        const failureReason = redactThrownDiagnosticError(
          error,
          cleanupRedactionOptions,
          { fallbackMessage: "Workspace cleanup failed" },
        ).message;
        workspace =
          (await svc.update(id, {
            status: "cleanup_failed",
            closedAt,
            cleanupReason: failureReason,
          })) ?? workspace;
        res.status(500).json({
          error: `Failed to archive execution workspace: ${failureReason}`,
        });
        return;
      }
    } else {
      const updatedWorkspace = await svc.update(id, patch);
      if (!updatedWorkspace) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      workspace = updatedWorkspace;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "execution_workspace.updated",
      entityType: "execution_workspace",
      entityId: workspace.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      },
    });
    res.json(toExecutionWorkspace(workspace));
  });

  // GET /companies/:companyId/projects/:projectId/git-worktrees
  // Reads live git worktrees from the project's primary workspace cwd and enriches
  // with DB execution_workspace records for status/issue/agent info.
  // Falls back to matching by issue identifier extracted from branch/path.
  router.get("/companies/:companyId/projects/:projectId/git-worktrees", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    assertCompanyAccess(req, companyId);

    // Find primary project workspace to get the local path
    const [pw] = await db
      .select({ id: projectWorkspaces.id, cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, companyId),
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.isPrimary, true),
        ),
      )
      .limit(1);

    if (!pw?.cwd) {
      res.json([]);
      return;
    }

    // Run git worktree list --porcelain in the repo root
    let stdout = "";
    try {
      ({ stdout } = await runGit("git", ["worktree", "list", "--porcelain"], {
        cwd: pw.cwd,
        env: buildExecutionWorkspaceGitEnv(options.processEnv ?? process.env),
      }));
    } catch {
      res.json([]);
      return;
    }

    // Parse porcelain output into worktree entries
    type GitWorktreeEntry = { path: string; head: string; branch: string | null; bare: boolean };
    const parsed: GitWorktreeEntry[] = [];
    let current: Partial<GitWorktreeEntry> | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current?.path) parsed.push(current as GitWorktreeEntry);
        current = { path: line.slice(9), head: "", branch: null, bare: false };
      } else if (line.startsWith("HEAD ") && current) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice(7).replace(/^refs\/heads\//, "");
      } else if (line === "bare" && current) {
        current.bare = true;
      }
    }
    if (current?.path) parsed.push(current as GitWorktreeEntry);

    // Get company issue prefix for identifier extraction
    const [company] = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const prefix = company?.issuePrefix ?? "";

    // Fetch execution_workspaces for this project to enrich
    const dbWorkspaces = await db
      .select({
        ew: executionWorkspaces,
        issue: {
          id: issues.id,
          title: issues.title,
          identifier: issues.identifier,
          status: issues.status,
        },
        agent: {
          id: agents.id,
          name: agents.name,
        },
      })
      .from(executionWorkspaces)
      .leftJoin(issues, eq(issues.id, executionWorkspaces.sourceIssueId))
      .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.projectId, projectId)));

    // Build lookup maps — by exact branch, branch-without-prefix, and cwd
    const byBranch = new Map<string, (typeof dbWorkspaces)[number]>();
    const byCwd = new Map<string, (typeof dbWorkspaces)[number]>();
    for (const r of dbWorkspaces) {
      if (r.ew.branchName) byBranch.set(r.ew.branchName, r);
      if (r.ew.cwd) byCwd.set(r.ew.cwd, r);
    }

    // Fetch all company issues by identifier for fallback matching
    // Issues may not have a projectId set, so we search company-wide
    const companyIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        identifier: issues.identifier,
        status: issues.status,
        agentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));

    const issueByIdentifier = new Map(
      companyIssues.filter((i) => i.identifier).map((i) => [i.identifier!.toUpperCase(), i]),
    );

    // Build a set of agent IDs we need and fetch them
    const agentIds = new Set(companyIssues.map((i) => i.agentId).filter(Boolean) as string[]);
    let agentMap = new Map<string, { id: string; name: string }>();
    if (agentIds.size > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, [...agentIds]));
      agentMap = new Map(agentRows.map((a) => [a.id, a]));
    }

    // Extract issue identifier from branch name or path basename
    const extractIdentifier = (branch: string | null, path: string): string | null => {
      if (!prefix) return null;
      const re = new RegExp(`(${prefix}-\\d+)`, "i");
      const branchMatch = branch?.match(re);
      if (branchMatch) return branchMatch[1].toUpperCase();
      const basename = path.split("/").pop() ?? "";
      const pathMatch = basename.match(re);
      return pathMatch ? pathMatch[1].toUpperCase() : null;
    };

    const result = parsed
      .filter((wt) => !wt.bare)
      .map((wt) => {
        // Try matching: exact branch → branch contained in DB → cwd → issue identifier
        let dbRow = byBranch.get(wt.branch ?? "");
        if (!dbRow && wt.branch) {
          // Try stripping common prefixes like "feat/", "fix/", "bugfix/"
          const stripped = wt.branch.replace(/^(?:feat|fix|bugfix|feature|hotfix)\//, "");
          dbRow = byBranch.get(stripped);
        }
        if (!dbRow) dbRow = byCwd.get(wt.path);

        // If we found a DB record, use it
        if (dbRow) {
          return {
            path: wt.path,
            head: wt.head,
            branch: wt.branch,
            isMainWorktree: wt.path === pw.cwd,
            executionWorkspace: toExecutionWorkspace(dbRow.ew),
            issue: dbRow.issue?.id
              ? { id: dbRow.issue.id, title: dbRow.issue.title, identifier: dbRow.issue.identifier, status: dbRow.issue.status }
              : null,
            agent: dbRow.agent?.id ? { id: dbRow.agent.id, name: dbRow.agent.name } : null,
          };
        }

        // Fallback: extract issue identifier from the branch/path and look up directly
        const identifier = extractIdentifier(wt.branch, wt.path);
        const issue = identifier ? issueByIdentifier.get(identifier.toUpperCase()) ?? null : null;
        const agent = issue?.agentId ? agentMap.get(issue.agentId) ?? null : null;

        return {
          path: wt.path,
          head: wt.head,
          branch: wt.branch,
          isMainWorktree: wt.path === pw.cwd,
          executionWorkspace: null,
          issue: issue
            ? { id: issue.id, title: issue.title, identifier: issue.identifier, status: issue.status }
            : null,
          agent,
        };
      });

    res.json(result);
  });

  // POST /companies/:companyId/projects/:projectId/git-worktrees/remove
  // Removes a git worktree by path using `git worktree remove --force`.
  router.post("/companies/:companyId/projects/:projectId/git-worktrees/remove", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    assertCompanyAccess(req, companyId);

    const worktreePath = req.body?.path as string | undefined;
    if (!worktreePath) {
      res.status(400).json({ error: "Missing 'path' in request body" });
      return;
    }

    // Verify project workspace exists and get cwd
    const [pw] = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, companyId),
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.isPrimary, true),
        ),
      )
      .limit(1);

    if (!pw?.cwd) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    // Prevent removing the primary worktree
    if (worktreePath === pw.cwd) {
      res.status(400).json({ error: "Cannot remove the primary worktree" });
      return;
    }

    try {
      await runGit("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: pw.cwd,
        env: buildExecutionWorkspaceGitEnv(options.processEnv ?? process.env),
      });
    } catch (err) {
      const failureReason = redactThrownDiagnosticError(
        err,
        materializeCurrentUserRedactionOptions({
          enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
        }),
        { fallbackMessage: "Failed to remove worktree" },
      ).message;
      res.status(500).json({ error: failureReason });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "execution_workspace.worktree_removed",
      entityType: "project",
      entityId: projectId,
      details: { path: worktreePath },
    });

    res.json({ ok: true });
  });

  return router;
}

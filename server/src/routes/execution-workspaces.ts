import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { updateExecutionWorkspaceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, logActivity, workspaceOperationService } from "../services/index.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { toExecutionWorkspace } from "../services/execution-workspaces.js";

const execFileAsync = promisify(execFile);

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export function executionWorkspaceRoutes(db: Db) {
  const router = Router();
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);

  router.get("/companies/:companyId/execution-workspaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const enriched = req.query.enriched === "true";

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
        .orderBy();

      const result = rows.map((row) => ({
        ...toExecutionWorkspace(row.workspace),
        issue: row.issue?.id ? { id: row.issue.id, title: row.issue.title, identifier: row.issue.identifier, status: row.issue.status } : null,
        agent: row.agent?.id ? { id: row.agent.id, name: row.agent.name } : null,
      }));
      res.json(result);
      return;
    }

    const workspaces = await svc.list(companyId, {
      projectId: req.query.projectId as string | undefined,
      projectWorkspaceId: req.query.projectWorkspaceId as string | undefined,
      issueId: req.query.issueId as string | undefined,
      status: req.query.status as string | undefined,
      reuseEligible: req.query.reuseEligible === "true",
    });
    res.json(workspaces);
  });

  router.get("/execution-workspaces/:id", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    res.json(workspace);
  });

  router.patch("/execution-workspaces/:id", validate(updateExecutionWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const patch: Record<string, unknown> = {
      ...req.body,
      ...(req.body.cleanupEligibleAt ? { cleanupEligibleAt: new Date(req.body.cleanupEligibleAt) } : {}),
    };
    let workspace = existing;
    let cleanupWarnings: string[] = [];

    if (req.body.status === "archived" && existing.status !== "archived") {
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
          }),
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
        const failureReason = error instanceof Error ? error.message : String(error);
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
    res.json(workspace);
  });

  // GET /companies/:companyId/projects/:projectId/git-worktrees
  // Reads live git worktrees from the project's primary workspace cwd and enriches
  // with DB execution_workspace records for status/issue/agent info.
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
      ({ stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: pw.cwd }));
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

    // Fetch all non-archived execution_workspaces for this project to enrich
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

    const byBranch = new Map(dbWorkspaces.map((r) => [r.ew.branchName, r]));
    const byCwd = new Map(dbWorkspaces.map((r) => [r.ew.cwd, r]));

    const result = parsed
      .filter((wt) => !wt.bare)
      .map((wt) => {
        const dbRow = byBranch.get(wt.branch ?? "") ?? byCwd.get(wt.path);
        return {
          path: wt.path,
          head: wt.head,
          branch: wt.branch,
          isMainWorktree: wt.path === pw.cwd,
          executionWorkspace: dbRow ? toExecutionWorkspace(dbRow.ew) : null,
          issue: dbRow?.issue?.id ? dbRow.issue : null,
          agent: dbRow?.agent?.id ? dbRow.agent : null,
        };
      });

    res.json(result);
  });

  return router;
}

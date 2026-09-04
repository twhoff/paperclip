import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeIssueActivityLimit } from "../services/activity.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { heartbeatService, issueService } from "../services/index.js";
import { redactStatelessDiagnosticResponseValue } from "../log-redaction.js";
import {
  sanitizeActivityRecordForOutput,
  sanitizeActivityRecordForPersistence,
} from "../services/activity-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);
  const heartbeat = heartbeatService(db);
  const instanceSettings = instanceSettingsService(db);

  async function currentUserRedactionOptions() {
    return { enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs };
  }

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 500);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const offset = (page - 1) * limit;

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      limit,
      offset,
    };
    const result = await svc.list(filters);
    const redactionOptions = await currentUserRedactionOptions();
    res.json(
      result.map((event) =>
        sanitizeActivityRecordForOutput(event, redactionOptions),
      ),
    );
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const sanitizedBody = sanitizeActivityRecordForPersistence(
      req.body,
      await currentUserRedactionOptions(),
    );
    const event = await svc.create({
      companyId,
      ...sanitizedBody,
    });
    res.status(201).json(
      sanitizeActivityRecordForOutput(event, await currentUserRedactionOptions()),
    );
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const requestedLimit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const result = await svc.forIssue(issue.id, normalizeIssueActivityLimit(requestedLimit));
    const redactionOptions = await currentUserRedactionOptions();
    res.json(
      result.map((event) =>
        sanitizeActivityRecordForOutput(event, redactionOptions),
      ),
    );
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(redactStatelessDiagnosticResponseValue(
      result,
      await currentUserRedactionOptions(),
    ));
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}

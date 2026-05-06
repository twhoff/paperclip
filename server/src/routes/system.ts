import { Router } from "express";
import { assertBoard } from "./authz.js";
import { badRequest } from "../errors.js";
import type { ShutdownService } from "../services/shutdown.js";

export function systemRoutes(shutdown: ShutdownService) {
  const router = Router();

  router.get("/shutdown", (_req, res) => {
    res.json(shutdown.getState());
  });

  router.post("/shutdown", async (req, res) => {
    assertBoard(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const timeoutMsRaw = body.timeoutMs;
    const exitProcessRaw = body.exitProcess;

    if (timeoutMsRaw !== undefined && (typeof timeoutMsRaw !== "number" || !Number.isFinite(timeoutMsRaw))) {
      throw badRequest("timeoutMs must be a finite number (milliseconds)");
    }
    if (exitProcessRaw !== undefined && typeof exitProcessRaw !== "boolean") {
      throw badRequest("exitProcess must be a boolean");
    }

    const state = await shutdown.initiate({
      timeoutMs: typeof timeoutMsRaw === "number" ? timeoutMsRaw : undefined,
      exitProcess: typeof exitProcessRaw === "boolean" ? exitProcessRaw : undefined,
      actorId: req.actor.userId ?? "board",
      actorType: "user",
    });

    res.status(202).json(state);
  });

  router.post("/shutdown/resume", async (req, res) => {
    assertBoard(req);
    const state = await shutdown.resume({
      actorId: req.actor.userId ?? "board",
      actorType: "user",
    });
    res.json(state);
  });

  return router;
}

import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentApiKeys,
  agents,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import { verifyLocalAgentJwt, type LocalAgentJwtClaims } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import {
  redactThrownDiagnosticError,
} from "../log-redaction.js";
import { logger, requestLogUrl } from "./logger.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sanitizeAuthSessionError(error: unknown) {
  return redactThrownDiagnosticError(
    error,
    { enabled: false },
    { fallbackMessage: "Auth session resolution failed" },
  );
}

const HOLLY_TOOLING_ADAPTER_TYPE = "holly";
const HOLLY_TOOLING_MAX_TOKEN_AGE_SECONDS = 5 * 60;
const HOLLY_TOOLING_CLOCK_SKEW_SECONDS = 30;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalHollyToolingToken(
  agentRecord: {
    status: string;
    adapterType: string;
    metadata: unknown;
  },
  claims: LocalAgentJwtClaims,
  runIdHeader: string | undefined,
): boolean {
  if (
    runIdHeader !== claims.run_id ||
    claims.adapter_type !== HOLLY_TOOLING_ADAPTER_TYPE ||
    agentRecord.adapterType !== HOLLY_TOOLING_ADAPTER_TYPE ||
    agentRecord.status !== "paused" ||
    !isPlainRecord(agentRecord.metadata)
  ) {
    return false;
  }

  const metadata = agentRecord.metadata;
  if (
    metadata.source !== "holly" ||
    metadata.managedBy !== "holly-adapter-paperclip" ||
    metadata.purpose !== "Holly project tooling agent identity"
  ) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    claims.iat <= now + HOLLY_TOOLING_CLOCK_SKEW_SECONDS &&
    claims.iat >= now - HOLLY_TOOLING_MAX_TOKEN_AGE_SECONDS
  );
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err: sanitizeAuthSessionError(err), method: req.method, url: requestLogUrl(req) },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            db
              .select({ companyId: companyMemberships.companyId })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
          ]);
          req.actor = {
            type: "board",
            userId,
            companyIds: memberships.map((row) => row.companyId),
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      // Board operator JWT — grant board access without agent lookup.
      // Security: the JWT is signed with PAPERCLIP_AGENT_JWT_SECRET which is
      // an instance-level secret. Possessing it implies full trust.
      if (claims.pcli_board) {
        req.actor = {
          type: "board",
          userId: `pcli:${claims.sub}`,
          isInstanceAdmin: true,
          runId: runIdHeader || claims.run_id || undefined,
          source: "local_implicit",
        };
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      if (runIdHeader && runIdHeader !== claims.run_id) {
        next();
        return;
      }

      // Holly's project-tooling identity is deliberately paused and never owns
      // heartbeat runs. Keep its freshly signed tooling JWT narrowly
      // usable without relaxing run binding for executable agent adapters.
      if (claims.adapter_type === HOLLY_TOOLING_ADAPTER_TYPE) {
        if (!isCanonicalHollyToolingToken(agentRecord, claims, runIdHeader)) {
          next();
          return;
        }
        req.actor = {
          type: "agent",
          agentId: claims.sub,
          companyId: claims.company_id,
          keyId: undefined,
          runId: claims.run_id,
          source: "agent_jwt",
        };
        next();
        return;
      }

      const runRecord = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          companyId: heartbeatRuns.companyId,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, claims.run_id),
            eq(heartbeatRuns.agentId, claims.sub),
            eq(heartbeatRuns.companyId, claims.company_id),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (
        !runRecord ||
        runRecord.id !== claims.run_id ||
        runRecord.agentId !== claims.sub ||
        runRecord.companyId !== claims.company_id ||
        (runRecord.status !== "queued" && runRecord.status !== "running")
      ) {
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: claims.run_id,
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}

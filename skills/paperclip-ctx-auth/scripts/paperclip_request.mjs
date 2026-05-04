/**
 * @deprecated Use paperclip_context_mode_request.mjs instead.
 *
 * This legacy helper is retained because it includes a DB-based identity
 * fallback (via `psql`) that the canonical cached helper does not provide.
 * Only import this file from non-sandboxed contexts where psql is on PATH
 * and env vars (PAPERCLIP_AGENT_ID/COMPANY_ID/ADAPTER_TYPE) cannot be set.
 *
 * For ctx_execute and any new caller, import paperclip_context_mode_request.mjs.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function readEnv(name, fallback = "") {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function parseEnvFile(contents) {
  const entries = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    entries[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return entries;
}

function resolvePaperclipEnvPath() {
  const homeDir = readEnv("PAPERCLIP_HOME", path.join(os.homedir(), ".paperclip"));
  const instanceId = readEnv("PAPERCLIP_INSTANCE_ID", "default");
  return path.join(homeDir, "instances", instanceId, ".env");
}

function readJwtConfig() {
  const envPath = resolvePaperclipEnvPath();
  const envEntries = parseEnvFile(readFileSync(envPath, "utf8"));
  const secret = envEntries.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(`PAPERCLIP_AGENT_JWT_SECRET missing from ${envPath}`);
  }
  return {
    secret,
    issuer: envEntries.PAPERCLIP_AGENT_JWT_ISSUER || "paperclip",
    audience: envEntries.PAPERCLIP_AGENT_JWT_AUDIENCE || "paperclip-api",
    ttlSeconds: Number(envEntries.PAPERCLIP_AGENT_JWT_TTL_SECONDS || 60 * 60 * 48),
  };
}

function base64UrlEncodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function mintLocalAgentJwt({ agentId, companyId, adapterType, runId = randomUUID() }) {
  const config = readJwtConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
  const signature = createHmac("sha256", config.secret).update(signingInput).digest("base64url");
  return {
    token: `${signingInput}.${signature}`,
    runId,
    claims,
  };
}

function resolveLocalAgentIdentityFromDb(preferredAdapterType = readEnv("PAPERCLIP_ADAPTER_TYPE", "codex_local")) {
  const query = `
    SELECT id, company_id, adapter_type
    FROM agents
    WHERE status NOT IN ('terminated', 'pending_approval')
      AND adapter_type = '${preferredAdapterType}'
    ORDER BY created_at ASC
    LIMIT 1;
  `.trim();
  const output = execFileSync(
    "psql",
    [
      "-h",
      readEnv("PAPERCLIP_DB_HOST", "127.0.0.1"),
      "-p",
      readEnv("PAPERCLIP_DB_PORT", "54329"),
      "-U",
      readEnv("PAPERCLIP_DB_USER", "paperclip"),
      "-d",
      readEnv("PAPERCLIP_DB_NAME", "paperclip"),
      "-tA",
      "-F",
      "\t",
      "-c",
      query,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PGPASSWORD: readEnv("PAPERCLIP_DB_PASSWORD", "paperclip"),
      },
    },
  ).trim();
  if (!output) {
    throw new Error(`No active agent found for adapter_type=${preferredAdapterType}`);
  }
  const [agentId, companyId, adapterType] = output.split("\t");
  return { agentId, companyId, adapterType };
}

export function resolveLocalAgentIdentity() {
  const agentId = process.env.PAPERCLIP_AGENT_ID?.trim();
  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
  const adapterType = process.env.PAPERCLIP_ADAPTER_TYPE?.trim();
  if (agentId && companyId && adapterType) {
    return { agentId, companyId, adapterType };
  }
  return resolveLocalAgentIdentityFromDb();
}

export async function paperclipRequest(apiPath, options = {}) {
  const rawBase = readEnv("PAPERCLIP_API_URL", "http://localhost:3100/api").replace(/\/$/, "");
  const apiBase = rawBase.endsWith("/api") ? rawBase : `${rawBase}/api`;
  const identity = options.identity || resolveLocalAgentIdentity();
  const { token, runId } = mintLocalAgentJwt({
    agentId: identity.agentId,
    companyId: identity.companyId,
    adapterType: identity.adapterType,
    runId: options.runId,
  });

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Paperclip-Run-Id", runId);

  const response = await fetch(`${apiBase}${apiPath}`, {
    ...options,
    headers,
  });
  return { response, runId, identity };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apiPath = process.argv[2] || "/agents/me";
  const { response, runId, identity } = await paperclipRequest(apiPath);
  const body = await response.text();
  const cliRawBase = readEnv("PAPERCLIP_API_URL", "http://localhost:3100/api").replace(/\/$/, "");
  const cliApiBase = cliRawBase.endsWith("/api") ? cliRawBase : `${cliRawBase}/api`;
  console.log(JSON.stringify({
    url: `${cliApiBase}${apiPath}`,
    status: response.status,
    ok: response.ok,
    runId,
    identity,
    body,
  }, null, 2));
}

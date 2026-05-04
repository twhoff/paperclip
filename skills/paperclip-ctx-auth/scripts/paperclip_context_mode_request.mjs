/**
 * paperclip_context_mode_request.mjs
 *
 * Canonical helper for calling the Paperclip API from inside ctx_execute sandboxes.
 * Import this file (not paperclip_request.mjs) in new code.
 *
 * Usage:
 *   const { paperclipRequest } = await import(
 *     'file://<project-root>/.agents/skills/paperclip-ctx-auth/scripts/paperclip_context_mode_request.mjs'
 *   );
 *   const { response } = await paperclipRequest('/agents/me');
 *
 * Identity is resolved from env vars (PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID,
 * PAPERCLIP_ADAPTER_TYPE) or passed explicitly via options.identity.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Module-level caches — computed once per process, reused for all subsequent calls.
let _jwtConfig = null;
let _apiBase = null;
let _identity = null;

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
  if (_jwtConfig) return _jwtConfig;
  const envPath = resolvePaperclipEnvPath();
  const envEntries = parseEnvFile(readFileSync(envPath, "utf8"));
  const secret = envEntries.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(`PAPERCLIP_AGENT_JWT_SECRET missing from ${envPath}`);
  }
  _jwtConfig = {
    secret,
    issuer: envEntries.PAPERCLIP_AGENT_JWT_ISSUER || "paperclip",
    audience: envEntries.PAPERCLIP_AGENT_JWT_AUDIENCE || "paperclip-api",
    ttlSeconds: Number(envEntries.PAPERCLIP_AGENT_JWT_TTL_SECONDS || 60 * 60 * 48),
  };
  return _jwtConfig;
}

function resolveApiBase() {
  if (_apiBase) return _apiBase;
  const raw = readEnv("PAPERCLIP_API_URL", "http://localhost:3100/api").replace(/\/$/, "");
  _apiBase = raw.endsWith("/api") ? raw : `${raw}/api`;
  return _apiBase;
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

export function resolveLocalAgentIdentity() {
  if (_identity) return _identity;
  const agentId = process.env.PAPERCLIP_AGENT_ID?.trim();
  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
  const adapterType = process.env.PAPERCLIP_ADAPTER_TYPE?.trim();
  if (!agentId || !companyId || !adapterType) {
    throw new Error(
      'Identity env vars missing. Set PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, and PAPERCLIP_ADAPTER_TYPE, ' +
      'or pass explicit identity:\n  await paperclipRequest("/path", { identity: { agentId, companyId, adapterType } })'
    );
  }
  _identity = { agentId, companyId, adapterType };
  return _identity;
}

export async function paperclipRequest(apiPath, options = {}) {
  const apiBase = resolveApiBase();
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
  console.log(JSON.stringify({
    url: `${resolveApiBase()}${apiPath}`,
    status: response.status,
    ok: response.ok,
    runId,
    identity,
    body,
  }, null, 2));
}

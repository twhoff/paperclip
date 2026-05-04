import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const HELPER_PATH = new URL("../paperclip_context_mode_request.mjs", import.meta.url).href;

const ENV_KEYS = [
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_ADAPTER_TYPE",
  "PAPERCLIP_API_URL",
];

let tempHome;
let originalEnv;
let originalFetch;

function writeEnvFile(home, secret = "test-secret", overrides = {}) {
  const instanceDir = path.join(home, "instances", "default");
  mkdirSync(instanceDir, { recursive: true });
  const lines = [
    `PAPERCLIP_AGENT_JWT_SECRET=${secret}`,
    `PAPERCLIP_AGENT_JWT_ISSUER=${overrides.issuer ?? "paperclip"}`,
    `PAPERCLIP_AGENT_JWT_AUDIENCE=${overrides.audience ?? "paperclip-api"}`,
    `PAPERCLIP_AGENT_JWT_TTL_SECONDS=${overrides.ttl ?? 3600}`,
  ];
  writeFileSync(path.join(instanceDir, ".env"), lines.join("\n") + "\n");
}

async function loadFreshHelper() {
  return import(`${HELPER_PATH}?cb=${Math.random()}`);
}

function decodeBase64UrlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  originalFetch = globalThis.fetch;
  tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-ctx-auth-"));
  writeEnvFile(tempHome);
  process.env.PAPERCLIP_HOME = tempHome;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.PAPERCLIP_AGENT_ID = "agent-uuid";
  process.env.PAPERCLIP_COMPANY_ID = "company-uuid";
  process.env.PAPERCLIP_ADAPTER_TYPE = "codex_local";
  delete process.env.PAPERCLIP_API_URL;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
  rmSync(tempHome, { recursive: true, force: true });
});

test("mintLocalAgentJwt produces a valid HS256 token whose signature verifies", async () => {
  const { mintLocalAgentJwt } = await loadFreshHelper();
  const { token, runId, claims } = mintLocalAgentJwt({
    agentId: "agent-uuid",
    companyId: "company-uuid",
    adapterType: "codex_local",
  });
  const parts = token.split(".");
  assert.equal(parts.length, 3, "token must have 3 base64url segments");

  const header = decodeBase64UrlJson(parts[0]);
  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });

  const payload = decodeBase64UrlJson(parts[1]);
  assert.equal(payload.sub, "agent-uuid");
  assert.equal(payload.company_id, "company-uuid");
  assert.equal(payload.adapter_type, "codex_local");
  assert.equal(payload.iss, "paperclip");
  assert.equal(payload.aud, "paperclip-api");
  assert.equal(typeof payload.iat, "number");
  assert.equal(payload.exp, payload.iat + 3600);
  assert.equal(payload.run_id, runId);
  assert.equal(claims.run_id, runId);

  const expected = createHmac("sha256", "test-secret")
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  assert.equal(parts[2], expected, "signature must match HMAC-SHA256 of header.payload");
});

test("resolveLocalAgentIdentity returns env-var trio when all three are set", async () => {
  const { resolveLocalAgentIdentity } = await loadFreshHelper();
  assert.deepEqual(resolveLocalAgentIdentity(), {
    agentId: "agent-uuid",
    companyId: "company-uuid",
    adapterType: "codex_local",
  });
});

test("resolveLocalAgentIdentity throws the documented error when any env var is missing", async () => {
  delete process.env.PAPERCLIP_COMPANY_ID;
  const { resolveLocalAgentIdentity } = await loadFreshHelper();
  assert.throws(() => resolveLocalAgentIdentity(), /Identity env vars missing/);
});

test("resolveLocalAgentIdentity caches the resolved value across calls", async () => {
  const helper = await loadFreshHelper();
  const first = helper.resolveLocalAgentIdentity();
  process.env.PAPERCLIP_AGENT_ID = "different-agent";
  process.env.PAPERCLIP_COMPANY_ID = "different-company";
  process.env.PAPERCLIP_ADAPTER_TYPE = "claude_local";
  const second = helper.resolveLocalAgentIdentity();
  assert.deepEqual(second, first, "second call must return the cached identity, not re-read env");
});

test("readJwtConfig caches across calls — second mint reuses the original secret even after .env is rewritten", async () => {
  const { mintLocalAgentJwt } = await loadFreshHelper();
  const before = mintLocalAgentJwt({
    agentId: "agent-uuid",
    companyId: "company-uuid",
    adapterType: "codex_local",
  });

  writeEnvFile(tempHome, "rotated-secret");

  const after = mintLocalAgentJwt({
    agentId: "agent-uuid",
    companyId: "company-uuid",
    adapterType: "codex_local",
  });

  const expectedBeforeSig = createHmac("sha256", "test-secret")
    .update(before.token.split(".").slice(0, 2).join("."))
    .digest("base64url");
  const expectedAfterSig = createHmac("sha256", "test-secret")
    .update(after.token.split(".").slice(0, 2).join("."))
    .digest("base64url");

  assert.equal(before.token.split(".")[2], expectedBeforeSig);
  assert.equal(after.token.split(".")[2], expectedAfterSig, "second mint must still use the cached test-secret, not the rotated one");
});

test("paperclipRequest sets Authorization and X-Paperclip-Run-Id headers and resolves URL from PAPERCLIP_API_URL", async () => {
  process.env.PAPERCLIP_API_URL = "http://example.test:9000";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const { paperclipRequest } = await loadFreshHelper();
  const { runId } = await paperclipRequest("/agents/me");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://example.test:9000/api/agents/me");
  const headers = calls[0].init.headers;
  const auth = headers.get("Authorization");
  assert.match(auth, /^Bearer eyJ/, "Authorization header must carry a Bearer JWT");
  assert.equal(headers.get("X-Paperclip-Run-Id"), runId);
});

test("paperclipRequest options.identity overrides the cached env-resolved identity", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };

  const { paperclipRequest } = await loadFreshHelper();
  await paperclipRequest("/agents/me", {
    identity: { agentId: "override-agent", companyId: "override-company", adapterType: "claude_local" },
  });

  const auth = calls[0].init.headers.get("Authorization");
  const payloadPart = auth.replace(/^Bearer /, "").split(".")[1];
  const payload = decodeBase64UrlJson(payloadPart);
  assert.equal(payload.sub, "override-agent");
  assert.equal(payload.company_id, "override-company");
  assert.equal(payload.adapter_type, "claude_local");
});

test("paperclipRequest options.runId overrides the auto-generated run id", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const { paperclipRequest } = await loadFreshHelper();
  const { runId } = await paperclipRequest("/agents/me", { runId: "fixed-run-id" });
  assert.equal(runId, "fixed-run-id");
});

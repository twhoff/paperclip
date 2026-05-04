import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const HELPER_PATH = new URL("../paperclip_request.mjs", import.meta.url).href;

const ENV_KEYS = [
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_ADAPTER_TYPE",
  "PAPERCLIP_API_URL",
  "PATH",
];

let tempHome;
let originalEnv;
let originalFetch;

function writeEnvFile(home, secret = "test-secret") {
  const instanceDir = path.join(home, "instances", "default");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(
    path.join(instanceDir, ".env"),
    [
      `PAPERCLIP_AGENT_JWT_SECRET=${secret}`,
      `PAPERCLIP_AGENT_JWT_ISSUER=paperclip`,
      `PAPERCLIP_AGENT_JWT_AUDIENCE=paperclip-api`,
      `PAPERCLIP_AGENT_JWT_TTL_SECONDS=3600`,
    ].join("\n") + "\n",
  );
}

function installPsqlShim(home, output) {
  const binDir = path.join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, "psql");
  writeFileSync(shimPath, `#!/bin/sh\nprintf '%s' "${output.replace(/"/g, '\\"')}"\n`);
  chmodSync(shimPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
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
  tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-ctx-auth-legacy-"));
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

test("legacy mintLocalAgentJwt produces an HS256 token whose signature verifies", async () => {
  const { mintLocalAgentJwt } = await loadFreshHelper();
  const { token } = mintLocalAgentJwt({
    agentId: "agent-uuid",
    companyId: "company-uuid",
    adapterType: "codex_local",
  });
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(decodeBase64UrlJson(parts[0]), { alg: "HS256", typ: "JWT" });
  const expected = createHmac("sha256", "test-secret")
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  assert.equal(parts[2], expected);
});

test("legacy resolveLocalAgentIdentity returns env-var trio when all three are set", async () => {
  const { resolveLocalAgentIdentity } = await loadFreshHelper();
  assert.deepEqual(resolveLocalAgentIdentity(), {
    agentId: "agent-uuid",
    companyId: "company-uuid",
    adapterType: "codex_local",
  });
});

test("legacy resolveLocalAgentIdentity falls back to psql DB lookup when env vars are missing", async () => {
  delete process.env.PAPERCLIP_AGENT_ID;
  delete process.env.PAPERCLIP_COMPANY_ID;
  // Keep PAPERCLIP_ADAPTER_TYPE so the fallback knows which adapter row to fetch.
  installPsqlShim(tempHome, "db-agent-id\tdb-company-id\tcodex_local");

  const { resolveLocalAgentIdentity } = await loadFreshHelper();
  assert.deepEqual(resolveLocalAgentIdentity(), {
    agentId: "db-agent-id",
    companyId: "db-company-id",
    adapterType: "codex_local",
  });
});

test("legacy paperclipRequest sets Authorization and X-Paperclip-Run-Id headers", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };

  const { paperclipRequest } = await loadFreshHelper();
  const { runId } = await paperclipRequest("/agents/me");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:3100/api/agents/me");
  const headers = calls[0].init.headers;
  assert.match(headers.get("Authorization"), /^Bearer eyJ/);
  assert.equal(headers.get("X-Paperclip-Run-Id"), runId);
});

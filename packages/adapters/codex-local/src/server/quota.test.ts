import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchCodexRpcQuota } from "./quota.js";

const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

async function createFakeCodex(source: string | ((directory: string) => string)) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-rpc-"));
  const scriptPath = path.join(directory, "fake-codex.js");
  const renderedSource = typeof source === "function" ? source(directory) : source;
  await fs.writeFile(scriptPath, renderedSource, "utf8");

  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(directory, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`,
      "utf8",
    );
  } else {
    const executablePath = path.join(directory, "codex");
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env node\n${renderedSource}`,
      "utf8",
    );
    await fs.chmod(executablePath, 0o755);
  }

  process.env.PATH = [directory, originalPath].filter(Boolean).join(path.delimiter);
  return directory;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processExited(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

describe("Codex RPC quota process bounds", () => {
  it("rejects cleanly when the Codex command cannot be spawned", async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-missing-"));
    process.env.PATH = emptyPath;

    try {
      await expect(fetchCodexRpcQuota()).rejects.toThrow(/failed to start/i);
    } finally {
      await fs.rm(emptyPath, { recursive: true, force: true });
    }
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects and terminates when Codex %s exceeds its buffer bound",
    async (stream) => {
      const directory = await createFakeCodex(
        `process.${stream}.write("x".repeat(2 * 1024 * 1024));\nsetInterval(() => {}, 1_000);\n`,
      );

      try {
        await expect(fetchCodexRpcQuota()).rejects.toThrow(
          new RegExp(`${stream} exceeded its buffer bound`, "i"),
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "waits for shutdown and escalates when Codex ignores SIGTERM",
    async () => {
      let childPid: number | null = null;
      const directory = await createFakeCodex((fakeDirectory) => {
        const pidPath = path.join(fakeDirectory, "pid");
        return `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newlineIndex;
  while ((newlineIndex = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, newlineIndex).trim();
    input = input.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (typeof message.id === "number") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
  }
});
setInterval(() => {}, 1_000);
`;
      });

      try {
        await fetchCodexRpcQuota();
        childPid = Number(
          await fs.readFile(path.join(directory, "pid"), "utf8"),
        );
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(await processExited(childPid)).toBe(true);
      } finally {
        if (childPid !== null && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "waits for a SIGTERM-resistant Codex descendant after the parent exits",
    async () => {
      let grandchildPid: number | null = null;
      const directory = await createFakeCodex((fakeDirectory) => {
        const pidPath = path.join(fakeDirectory, "grandchild-pid");
        const grandchildScript =
          "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
        return `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
  stdio: ["ignore", "pipe", "ignore"],
});
let ready = false;
const queued = [];
const respond = (message) => {
  if (typeof message.id === "number") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
};
grandchild.stdout.once("data", () => {
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(grandchild.pid));
  ready = true;
  for (const message of queued.splice(0)) respond(message);
});
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newlineIndex;
  while ((newlineIndex = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, newlineIndex).trim();
    input = input.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (ready) respond(message);
    else queued.push(message);
  }
});
setInterval(() => {}, 1_000);
`;
      });

      try {
        await fetchCodexRpcQuota();
        grandchildPid = Number(
          await fs.readFile(path.join(directory, "grandchild-pid"), "utf8"),
        );
        expect(Number.isSafeInteger(grandchildPid)).toBe(true);
        expect(await processExited(grandchildPid, 500)).toBe(true);
      } finally {
        if (grandchildPid !== null && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it("does not expose child stderr when the RPC process exits", async () => {
    const stderrSecret = "eyJhbGciOiJIUzI1NiJ9.codex-quota-stderr-secret.signature";
    const directory = await createFakeCodex(
      `process.stderr.write(${JSON.stringify(stderrSecret)});\nprocess.exit(17);\n`,
    );

    try {
      let failure: unknown;
      try {
        await fetchCodexRpcQuota();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/closed unexpectedly/i);
      expect((failure as Error).message).not.toContain(stderrSecret);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

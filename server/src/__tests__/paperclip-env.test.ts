import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import {
  buildPaperclipEnv,
  runChildProcess,
  runLocalAdapterChildProcess,
} from "../adapters/utils.js";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;
const ORIGINAL_HOST = process.env.HOST;
const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_HOLLY_SESSION_ID = process.env.HOLLY_SESSION_ID;
const ORIGINAL_PCLI_SESSION_ID = process.env.PCLI_SESSION_ID;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

  if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
  else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

  if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;

  if (ORIGINAL_HOST === undefined) delete process.env.HOST;
  else process.env.HOST = ORIGINAL_HOST;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;

  if (ORIGINAL_HOLLY_SESSION_ID === undefined) delete process.env.HOLLY_SESSION_ID;
  else process.env.HOLLY_SESSION_ID = ORIGINAL_HOLLY_SESSION_ID;

  if (ORIGINAL_PCLI_SESSION_ID === undefined) delete process.env.PCLI_SESSION_ID;
  else process.env.PCLI_SESSION_ID = ORIGINAL_PCLI_SESSION_ID;
});

describe("buildPaperclipEnv", () => {
  it("prefers an explicit PAPERCLIP_API_URL", () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe(`http://${os.hostname()}:3101`);
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://[::1]:3101");
  });

  it("gives different local agents stable, distinct Holly sessions", () => {
    const first = { id: "00000000-0000-4000-8000-000000000001", companyId: "company-1", adapterType: "claude_local" };
    const second = { id: "00000000-0000-4000-8000-000000000002", companyId: "company-1", adapterType: "codex_local" };

    expect(buildPaperclipEnv(first).HOLLY_SESSION_ID).toBe(
      "agent-00000000-0000-4000-8000-000000000001",
    );
    expect(buildPaperclipEnv(first).HOLLY_SESSION_ID).toBe(
      buildPaperclipEnv(first).HOLLY_SESSION_ID,
    );
    expect(buildPaperclipEnv(second).HOLLY_SESSION_ID).toBe(
      "agent-00000000-0000-4000-8000-000000000002",
    );
    expect(buildPaperclipEnv(first).HOLLY_SESSION_ID).not.toBe(
      buildPaperclipEnv(second).HOLLY_SESSION_ID,
    );
  });

  it("overrides ambient Holly identity and strips ambient PCLI identity from a local child", async () => {
    process.env.HOLLY_SESSION_ID = "agent-00000000-0000-4000-8000-000000000099";
    process.env.PCLI_SESSION_ID = "ambient-parent";
    const localAgent = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "company-1",
      adapterType: "cursor",
    };
    const env = buildPaperclipEnv(localAgent);

    const result = await runLocalAdapterChildProcess(
      localAgent,
      "paperclip-env-local-child",
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({holly:process.env.HOLLY_SESSION_ID,pcli:process.env.PCLI_SESSION_ID??null}))",
      ],
      {
        cwd: process.cwd(),
        env,
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      holly: "agent-00000000-0000-4000-8000-000000000001",
      pcli: null,
    });
  });

  it("strips ambient orchestration identity from generic process child launches", async () => {
    process.env.PCLI_SESSION_ID = "ambient-non-local";
    process.env.HOLLY_SESSION_ID = "agent-ambient-non-local";

    const result = await runChildProcess(
      "paperclip-env-non-local-child",
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({pcli:process.env.PCLI_SESSION_ID??null,holly:process.env.HOLLY_SESSION_ID??null}))",
      ],
      {
        cwd: process.cwd(),
        env: buildPaperclipEnv({
          id: "agent-1",
          companyId: "company-1",
          adapterType: "process",
        }),
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({ pcli: null, holly: null });
  });
});

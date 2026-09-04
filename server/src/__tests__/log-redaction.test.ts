import { describe, expect, it, vi } from "vitest";
import { CompiledSensitiveValueMatchers } from "@paperclipai/adapter-utils/server-utils";
import {
  SECRET_REDACTION_TOKEN,
  OrderedStreamingTextRedactor,
  createStreamingTextRedactor,
  maskUserNameForLogs,
  redactCurrentUserText,
  redactCurrentUserTextRange,
  redactCurrentUserValue,
  redactDiagnosticResponseValue,
  redactStatelessDiagnosticResponseValue,
  redactNdjsonLogRange,
} from "../log-redaction.js";

describe("log redaction", () => {
  it("redacts the active username inside home-directory paths", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const input = [
      `cwd=/Users/${userName}/paperclip`,
      `home=/home/${userName}/workspace`,
      `win=C:\\Users\\${userName}\\paperclip`,
    ].join("\n");

    const result = redactCurrentUserText(input, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`, `C:\\Users\\${userName}`],
    });

    expect(result).toContain(`cwd=/Users/${maskedUserName}/paperclip`);
    expect(result).toContain(`home=/home/${maskedUserName}/workspace`);
    expect(result).toContain(`win=C:\\Users\\${maskedUserName}\\paperclip`);
    expect(result).not.toContain(userName);
  });

  it("redacts standalone username mentions without mangling larger tokens", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserText(
      `user ${userName} said ${userName}/project should stay but apaperclipuserz should not change`,
      {
        userNames: [userName],
        homeDirs: [],
      },
    );

    expect(result).toBe(
      `user ${maskedUserName} said ${maskedUserName}/project should stay but apaperclipuserz should not change`,
    );
  });

  it("recursively redacts nested event payloads", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserValue({
      cwd: `/Users/${userName}/paperclip`,
      prompt: `open /Users/${userName}/paperclip/ui`,
      nested: {
        author: userName,
      },
      values: [userName, `/home/${userName}/project`],
    }, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`],
    });

    expect(result).toEqual({
      cwd: `/Users/${maskedUserName}/paperclip`,
      prompt: `open /Users/${maskedUserName}/paperclip/ui`,
      nested: {
        author: maskedUserName,
      },
      values: [maskedUserName, `/home/${maskedUserName}/project`],
    });
  });

  it("skips redaction when disabled", () => {
    const input = "cwd=/Users/paperclipuser/paperclip";
    expect(redactCurrentUserText(input, { enabled: false })).toBe(input);
  });

  it("always redacts Paperclip JWTs even when username redaction is disabled", () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWdlbnQtMSJ9.signature_value";
    const hyphenTerminatedToken =
      "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi0yIn0.signature-";
    const input = [
      `PAPERCLIP_API_KEY=${token}`,
      `Authorization: Bearer ${token}`,
      JSON.stringify({ env: { PAPERCLIP_API_KEY: token } }),
      `token=${hyphenTerminatedToken}`,
    ].join("\n");

    const result = redactCurrentUserText(input, { enabled: false });

    expect(result).not.toContain(token);
    expect(result).not.toContain(hyphenTerminatedToken);
    expect(result.match(new RegExp(SECRET_REDACTION_TOKEN.replaceAll("*", "\\*"), "g"))).toHaveLength(4);
  });

  it("recursively redacts Paperclip JWTs from run records and event payloads", () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJydW5JZCI6InJ1bi0xIn0.another_signature";

    expect(
      redactCurrentUserValue(
        {
          stdoutExcerpt: `PAPERCLIP_API_KEY=${token}`,
          payload: { env: { PAPERCLIP_API_KEY: token } },
        },
        { enabled: false },
      ),
    ).toEqual({
      stdoutExcerpt: `PAPERCLIP_API_KEY=${SECRET_REDACTION_TOKEN}`,
      payload: { env: { PAPERCLIP_API_KEY: SECRET_REDACTION_TOKEN } },
    });
  });

  it("redacts exact run-scoped secrets from text and nested values", () => {
    const secret = "plain-control-plane-secret-value";
    const options = { enabled: false, secretValues: [secret] };

    expect(redactCurrentUserText(`token=${secret}`, options)).toBe(
      `token=${SECRET_REDACTION_TOKEN}`,
    );
    expect(redactCurrentUserValue({ error: secret, nested: [secret] }, options)).toEqual({
      error: SECRET_REDACTION_TOKEN,
      nested: [SECRET_REDACTION_TOKEN],
    });
    expect(redactCurrentUserText("value=x", { enabled: false, secretValues: ["x"] })).toBe(
      `value=${SECRET_REDACTION_TOKEN}`,
    );
  });

  it("uses one-pass exact-secret replacement with bounded output", () => {
    const replacementCharacters = ["x", "*", "R", "E", "D", "A", "C", "T"];

    expect(redactCurrentUserText("x", {
      enabled: false,
      secretValues: replacementCharacters,
    })).toBe(SECRET_REDACTION_TOKEN);

    const hostile = "xq".repeat(1024 * 1024);
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
    let redacted: string;
    let largestMaterializedString = 0;
    try {
      redacted = redactCurrentUserText(hostile, {
        enabled: false,
        secretValues: replacementCharacters,
      });
      largestMaterializedString = Math.max(
        ...byteLengthSpy.mock.calls
          .map(([value]) => typeof value === "string" ? value.length : 0),
      );
    } finally {
      byteLengthSpy.mockRestore();
    }
    expect(Buffer.byteLength(redacted, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(largestMaterializedString).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(redacted).not.toContain("x");
  });

  it("does not expose a JWT prefix or partial UTF-8 character at the output cap", () => {
    const token = "eyJcap.payload.signature_value";
    const redacted = redactCurrentUserText(
      `${"q".repeat(2 * 1024 * 1024 - 5)}🙂${token}`,
      { enabled: false, secretValues: ["unused-exact-secret"] },
    );

    expect(Buffer.byteLength(redacted, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(redacted).not.toContain("\uFFFD");
    expect(redacted).not.toMatch(/(?:e|ey|eyJ[A-Za-z0-9_.-]*)$/);
  });

  it.each([1, 2, 44])(
    "fails closed when a response JWT crosses diagnostic fields at offset %i",
    (splitAt) => {
      const token =
        "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1yZXNwb25zZSJ9.signature_with-hyphen_";
      const result = redactDiagnosticResponseValue(
        {
          resultJson: {
            stdout: token.slice(0, splitAt),
            stderr: token.slice(splitAt),
            exitCode: 1,
          },
        },
        { enabled: false },
      );

      expect(`${result.resultJson.stdout}${result.resultJson.stderr}`).not.toContain(token);
      expect(result.resultJson.stdout).toBe(SECRET_REDACTION_TOKEN);
      expect(result.resultJson.stderr).not.toContain(token);
      expect(result.resultJson.exitCode).toBe(1);
    },
  );

  it.each([
    ["run excerpts", { stdoutExcerpt: "ey", stderrExcerpt: "Jheader.payload.signature_" }],
    ["error and result output", { error: "eyJheader.payload.", resultJson: { stdout: "signature-" } }],
    ["list error and summary", { error: "eyJheader.", resultJson: { summary: "payload.signature_" } }],
    ["context and error", { contextSnapshot: { prompt: "eyJheader.payload." }, error: "signature-" }],
    ["live status fields", { triggerDetail: "eyJheader.", error: "payload.signature_" }],
  ])("fails closed across %s fields", (_label, input) => {
    const result = redactDiagnosticResponseValue(input, { enabled: false });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("eyJheader.payload.signature_");
    expect(serialized).not.toContain("eyJheader.payload.signature-");
    expect(serialized).toContain(SECRET_REDACTION_TOKEN);
  });

  it("fails closed when an exact resolved secret crosses stdout and stderr", () => {
    const secret = "resolved-benign-binding-value-42";
    const splitAt = 17;
    const result = redactDiagnosticResponseValue(
      {
        stdout: `probe=${secret.slice(0, splitAt)}`,
        stderr: `${secret.slice(splitAt)} failed`,
        status: "warn",
      },
      { enabled: false, secretValues: [secret] },
    );

    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(result.stdout).toContain(SECRET_REDACTION_TOKEN);
    expect(result.stderr).not.toContain(secret);
    expect(result.status).toBe("warn");
  });

  it("fails closed when a JWT crosses three ordered diagnostic fields", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const result = redactDiagnosticResponseValue(
      {
        contextSnapshot: { prompt: token.slice(0, 1) },
        error: token.slice(1, 18),
        resultJson: { stdout: token.slice(18) },
        id: "run-1",
      },
      { enabled: false },
    );

    expect(
      `${result.contextSnapshot.prompt}${result.error}${result.resultJson.stdout}`,
    ).not.toContain(token);
    expect(result.contextSnapshot.prompt).toBe(SECRET_REDACTION_TOKEN);
    expect(result.error).not.toContain(token);
    expect(result.resultJson.stdout).not.toContain(token);
    expect(result.id).toBe("run-1");
  });

  it("redacts a cross-field JWT whose leading fragment exceeds the streaming bound", () => {
    const token = `eyJ${"a".repeat(20 * 1024)}.payload.signature_with-hyphen_`;
    const splitAt = token.indexOf(".payload") + 4;
    const result = redactDiagnosticResponseValue(
      { stdout: token.slice(0, splitAt), stderr: token.slice(splitAt) },
      { enabled: false },
    );

    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(result.stdout).toBe(SECRET_REDACTION_TOKEN);
    expect(result.stderr).not.toContain(token);
  });

  it("isolates diagnostic reconstruction checks to each list record", () => {
    const input = [
      { id: "run-1", error: "e" },
      { id: "run-2", resultJson: { stdout: "yJheader.payload.signature_" } },
    ];

    expect(redactDiagnosticResponseValue(input, { enabled: false })).toEqual(input);
  });

  it("fails closed when JWT pieces appear in reverse field order", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    const result = redactDiagnosticResponseValue(
      { stdout: token.slice(splitAt), stderr: token.slice(0, splitAt) },
      { enabled: false },
    );

    expect(`${result.stderr}${result.stdout}`).not.toContain(token);
    expect(result.stderr).toBe(SECRET_REDACTION_TOKEN);
  });

  it("fails closed for non-adjacent JWT pieces across three fields", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const result = redactDiagnosticResponseValue(
      {
        stdout: "signature_with-hyphen_",
        message: "unrelated diagnostic",
        stderr: "eyJheader.",
        error: "payload.",
      },
      { enabled: false },
    );

    expect(`${result.stderr}${result.error}${result.stdout}`).not.toContain(token);
    expect(result.stderr).toBe(SECRET_REDACTION_TOKEN);
    expect(result.message).toBe("unrelated diagnostic");
  });

  it("fails closed when a response record exceeds the diagnostic field bound", () => {
    const contextSnapshot = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`field${index}`, `value-${index}`]),
    );
    const result = redactDiagnosticResponseValue(
      { id: "run-1", contextSnapshot },
      { enabled: false },
    );

    expect(Object.values(result.contextSnapshot)).toHaveLength(129);
    expect(new Set(Object.values(result.contextSnapshot))).toEqual(
      new Set([SECRET_REDACTION_TOKEN]),
    );
    expect(result.id).toBe("run-1");
  });

  it("fails closed when a response record exceeds the diagnostic byte bound", () => {
    const result = redactDiagnosticResponseValue(
      { id: "run-1", stdout: "x".repeat(1_100_000), stderr: "safe" },
      { enabled: false },
    );

    expect(result.stdout).toBe(SECRET_REDACTION_TOKEN);
    expect(result.stderr).toBe(SECRET_REDACTION_TOKEN);
    expect(result.id).toBe("run-1");
    expect(JSON.stringify(result)).not.toContain("x".repeat(1_000));
  });

  it("bounds diagnostic traversal depth before cloning hostile nesting", () => {
    const secret = "deep-diagnostic-secret-value";
    let input: Record<string, unknown> = { message: secret };
    for (let index = 0; index < 64; index += 1) input = { payload: input };

    const result = redactDiagnosticResponseValue(input, {
      enabled: false,
      secretValues: [secret],
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(SECRET_REDACTION_TOKEN);
    expect((serialized.match(/"payload"/g) ?? []).length).toBeLessThanOrEqual(32);
  });

  it("replaces cyclic diagnostic subtrees with a serializable sentinel", () => {
    const input: Record<string, unknown> = { message: "safe" };
    input.self = input;

    const result = redactDiagnosticResponseValue(input, { enabled: false });

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)).toContain(SECRET_REDACTION_TOKEN);
  });

  it("stops reading a hostile broad record at the traversal node bound", () => {
    let reads = 0;
    const input: Record<string, unknown> = {};
    for (let index = 0; index < 6_000; index += 1) {
      Object.defineProperty(input, `field${index}`, {
        enumerable: true,
        get() {
          reads += 1;
          return `value-${index}`;
        },
      });
    }

    const result = redactDiagnosticResponseValue(input, { enabled: false });

    expect(reads).toBeLessThanOrEqual(4_096);
    expect(JSON.stringify(result).length).toBeLessThan(128_000);
  });

  it("fails closed before mapping an oversized top-level record array", () => {
    const input = Array.from({ length: 1_001 }, (_, index) => ({ id: `run-${index}` }));

    const result = redactDiagnosticResponseValue(input, { enabled: false });

    expect(result).toHaveLength(1_000);
    expect(result[0]).toEqual({ id: "run-0" });
    expect(result.at(-1)).toEqual({ id: "run-999" });
  });

  it("strictly isolates array records without sacrificing operational selectors", () => {
    const token = "eyJrecords.separate.signature_";
    const result = redactStatelessDiagnosticResponseValue([
      {
        id: "record-1",
        error: token.slice(0, 1),
        metadata: { padding: "x".repeat(1_100_000) },
      },
      { id: "record-2", error: token.slice(1) },
    ], { enabled: false });

    expect(result.map((record) => record.id)).toEqual(["record-1", "record-2"]);
    expect(`${result[0].error}${result[1].error}`).not.toContain(token);
    expect(result[0].metadata).toEqual({ padding: SECRET_REDACTION_TOKEN });
  });

  it("preserves null prototypes without allowing an own __proto__ key to mutate the clone", () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "__proto__", {
      enumerable: true,
      value: { message: "eyJheader.payload.signature_" },
    });

    const result = redactDiagnosticResponseValue(input, { enabled: false });

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("eyJheader.payload.signature_");
  });

  it("bounds and omits an oversized diagnostic property name", () => {
    const oversizedKey = `eyJ${"a".repeat(2 * 1024 * 1024)}`;
    const input = { metadata: { [oversizedKey]: "value" }, id: "run-1" };

    const result = redactDiagnosticResponseValue(input, { enabled: false });
    const serialized = JSON.stringify(result);

    expect(serialized.length).toBeLessThan(1_024);
    expect(serialized).not.toContain(oversizedKey.slice(0, 1_000));
  });

  it("isolates an overflowing diagnostic subtree and preserves required siblings", () => {
    const result = redactDiagnosticResponseValue(
      {
        id: "workspace-1",
        metadata: Array.from({ length: 5_000 }, (_, index) => index),
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:01.000Z",
      },
      { enabled: false },
    );

    expect(result).toEqual({
      id: "workspace-1",
      metadata: SECRET_REDACTION_TOKEN,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:01.000Z",
    });
  });

  it("charges isolated diagnostic siblings to one bounded traversal budget", () => {
    let reads = 0;
    const diagnosticArray = Array.from({ length: 4_096 }, (_, index) =>
      Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          reads += 1;
          return index;
        },
      }),
    );
    const record = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`metadata${index}`, diagnosticArray]),
    );

    const result = redactDiagnosticResponseValue(record, {
      enabled: false,
      extraDiagnosticKeys: Object.keys(record),
    });

    expect(reads).toBe(0);
    expect(Object.keys(result)).toHaveLength(25);
    expect(new Set(Object.values(result))).toEqual(new Set([SECRET_REDACTION_TOKEN]));
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  it("bounds isolated diagnostic work independently for every top-level record", () => {
    let reads = 0;
    const hostileArray = Array.from({ length: 4_096 }, (_, index) =>
      Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          reads += 1;
          return index;
        },
      }),
    );
    const records = Array.from({ length: 1_000 }, (_, recordIndex) => ({
      id: `run-${recordIndex}`,
      metadata: hostileArray,
    }));

    const result = redactDiagnosticResponseValue(records, { enabled: false });

    expect(result).toHaveLength(1_000);
    expect(reads).toBe(0);
    expect(result[0]).toEqual({ id: "run-0", metadata: SECRET_REDACTION_TOKEN });
    expect(result.at(-1)).toEqual({ id: "run-999", metadata: SECRET_REDACTION_TOKEN });
  });

  it("compiles exact-secret matchers once for a multi-record response", () => {
    let iterations = 0;
    const secretValues = {
      *[Symbol.iterator]() {
        iterations += 1;
        yield "one-run-scoped-secret";
      },
    };

    const result = redactDiagnosticResponseValue(
      Array.from({ length: 100 }, (_, index) => ({
        id: `run-${index}`,
        error: "one-run-scoped-secret",
      })),
      { enabled: false, secretValues },
    );

    expect(iterations).toBe(1);
    expect(result).toHaveLength(100);
    expect(new Set(result.map((record) => record.error))).toEqual(
      new Set([SECRET_REDACTION_TOKEN]),
    );
  });

  it("fails closed for custom serializers on plain and non-plain objects", () => {
    const secret = "serializer-secret-value";
    class HostileValue {
      exposed = secret;
      toJSON() {
        return secret;
      }
    }
    const input = {
      payload: new HostileValue(),
      metadata: {
        safe: true,
        toJSON() {
          return secret;
        },
      },
    };

    const serialized = JSON.stringify(
      redactDiagnosticResponseValue(input, { enabled: false, secretValues: [secret] }),
    );

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(SECRET_REDACTION_TOKEN);
  });

  it("uses intrinsic bounded array traversal when map or length is hostile", () => {
    const token = "eyJheader.payload.signature_";
    const overriddenMap = [{ message: token }];
    Object.defineProperty(overriddenMap, "map", {
      value: () => overriddenMap,
    });
    const hostileLength = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("hostile length");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(JSON.stringify(redactDiagnosticResponseValue(overriddenMap, { enabled: false }))).not.toContain(
      token,
    );
    expect(() => redactDiagnosticResponseValue(hostileLength, { enabled: false })).not.toThrow();
    expect(redactDiagnosticResponseValue(hostileLength, { enabled: false })).toEqual([]);
  });

  it("fails closed for revoked array proxies at top-level and nested boundaries", () => {
    const top = Proxy.revocable([], {});
    const nested = Proxy.revocable([], {});
    top.revoke();
    nested.revoke();

    expect(() => redactDiagnosticResponseValue(top.proxy, { enabled: false })).not.toThrow();
    expect(redactDiagnosticResponseValue(top.proxy, { enabled: false })).toBe(
      SECRET_REDACTION_TOKEN,
    );
    expect(redactDiagnosticResponseValue({ payload: nested.proxy }, { enabled: false })).toEqual({
      payload: SECRET_REDACTION_TOKEN,
    });
  });

  it("redacts generic and exact credentials split across diagnostic property keys", () => {
    const exactSecret = "resolved-provider-credential-value";
    const exactSplit = 14;
    const input = {
      metadata: {
        "prefix-eyJheader.": true,
        "payload.signature_": true,
        [`prefix-${exactSecret.slice(0, exactSplit)}`]: true,
        [exactSecret.slice(exactSplit)]: true,
      },
    };

    const result = redactDiagnosticResponseValue(input, {
      enabled: false,
      secretValues: [exactSecret],
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("eyJheader.");
    expect(serialized).not.toContain(exactSecret.slice(0, exactSplit));
    expect(Object.keys(result.metadata).join("")).not.toContain(exactSecret);
  });

  it.each(["ordinary diagnostic e", "ordinary diagnostic ey"])(
    "preserves a harmless partial prefix: %s",
    (stdout) => {
      const input = { stdout, stderr: "next line", status: "ok" };
      expect(redactDiagnosticResponseValue(input, { enabled: false })).toEqual(input);
    },
  );

  it("preserves a trailing e or ey inside a base64url word at a stateless boundary", () => {
    const input = {
      error: "invalid 'from' date",
      message: "complete survey",
    };

    expect(redactStatelessDiagnosticResponseValue(input, { enabled: false })).toEqual(input);
  });

  it("supports caller-scoped diagnostic keys without classifying labels globally", () => {
    const token = "eyJheader.";
    const input = {
      windows: [{ label: token, valueLabel: token }],
    };

    expect(redactDiagnosticResponseValue(input, { enabled: false })).toEqual(input);
    expect(
      redactDiagnosticResponseValue(input, {
        enabled: false,
        extraDiagnosticKeys: ["label", "valueLabel"],
      }),
    ).toEqual({
      windows: [{ label: SECRET_REDACTION_TOKEN, valueLabel: SECRET_REDACTION_TOKEN }],
    });
  });

  it("always redacts current process control-plane secrets on historical reads", () => {
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const secret = "opaque-current-control-plane-secret";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;

    try {
      expect(redactCurrentUserText(`historical=${secret}`, { enabled: false })).toBe(
        `historical=${SECRET_REDACTION_TOKEN}`,
      );
      expect(redactCurrentUserValue({ historical: secret }, { enabled: false })).toEqual({
        historical: SECRET_REDACTION_TOKEN,
      });
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  });

  it("redacts secrets split across streamed chunks without delaying unrelated text", () => {
    const secret = "split-secret-value-123456";
    const redactor = createStreamingTextRedactor({
      enabled: false,
      compiledSecretMatchers: new CompiledSensitiveValueMatchers([secret]),
    });

    const output = [
      redactor.push("ready\\nsecret=split-secret-"),
      redactor.push("value-123456\\ndone\\n"),
      redactor.flush(),
    ].join("");

    expect(output).toBe(`ready\\nsecret=${SECRET_REDACTION_TOKEN}\\ndone\\n`);
    expect(output).not.toContain(secret);
  });

  it.each([
    ["exact secret", "abcdef", "abc", "def"],
    ["JWT", "eyJheader.payload.signature_", "e", "yJheader.payload.signature_"],
  ])("fails closed when a %s is split across streams before a prefix mismatch", (
    _label,
    secret,
    prefix,
    suffix,
  ) => {
    const options = secret === "abcdef"
      ? {
          enabled: false,
          compiledSecretMatchers: new CompiledSensitiveValueMatchers([secret]),
        }
      : {
          enabled: false,
          compiledSecretMatchers: new CompiledSensitiveValueMatchers([]),
        };
    const redactor = new OrderedStreamingTextRedactor<"stdout" | "stderr">(options);
    const output = [
      ...redactor.push("stdout", prefix),
      ...redactor.push("stderr", suffix),
      ...redactor.push("stdout", "x"),
      ...redactor.flush(),
    ];
    const stdout = output.filter((entry) => entry.stream === "stdout")
      .map((entry) => entry.chunk).join("");
    const stderr = output.filter((entry) => entry.stream === "stderr")
      .map((entry) => entry.chunk).join("");

    expect(`${stdout}${stderr}`).not.toContain(secret);
    expect(JSON.stringify(output)).toContain(SECRET_REDACTION_TOKEN);
  });

  it("bounds adversarial exact-secret prefix matching across one-byte chunks", () => {
    const prefixLength = 64 * 1024 - 1;
    const redactor = createStreamingTextRedactor({
      enabled: false,
      secretValues: [`${"a".repeat(prefixLength)}b`],
    });
    const startedAt = performance.now();
    let output = "";

    for (let index = 0; index < prefixLength; index += 1) {
      output += redactor.push("a");
    }
    output += redactor.flush();

    expect(output).toBe(SECRET_REDACTION_TOKEN);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails closed when exact-secret matcher input exceeds its bounded budget", () => {
    const redactor = createStreamingTextRedactor({
      enabled: false,
      secretValues: Array.from({ length: 129 }, (_, index) => `secret-${index}`),
    });

    expect(redactor.push("ordinary output")).toBe(SECRET_REDACTION_TOKEN);
    expect(redactor.push("more output")).toBe("");
    expect(redactor.flush()).toBe("");
  });

  it("redacts an otherwise unknown JWT split inside its prefix", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1zdHJlYW0ifQ.signature-";
    const redactor = createStreamingTextRedactor({ enabled: false });

    const output = [
      redactor.push("token=e"),
      redactor.push("y"),
      redactor.push(`${token.slice(2)}\ndone`),
      redactor.flush(),
    ].join("");

    expect(output).toBe(`token=${SECRET_REDACTION_TOKEN}\ndon${SECRET_REDACTION_TOKEN}`);
    expect(output).not.toContain(token);
  });

  it.each(["e", "ey"])("fails closed for a held JWT prefix at stream EOF: %s", (prefix) => {
    const redactor = createStreamingTextRedactor({ enabled: false });

    const output = [redactor.push(`token=${prefix}`), redactor.flush()].join("");

    expect(output).toBe(`token=${SECRET_REDACTION_TOKEN}`);
    expect(output).not.toContain(`token=${prefix}`);
  });

  it("fails closed for held JWT prefixes in independent historical log streams", () => {
    const stored = [
      JSON.stringify({ ts: "1", stream: "stdout", chunk: "stdout=e" }),
      JSON.stringify({ ts: "2", stream: "stderr", chunk: "stderr=ey" }),
    ].join("\n") + "\n";

    const page = redactNdjsonLogRange(stored, undefined, { enabled: false });
    const records = page.content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { stream: string; chunk: string });

    expect(records.map((record) => record.chunk)).toEqual([
      `stdout=${SECRET_REDACTION_TOKEN}`,
      `stderr=${SECRET_REDACTION_TOKEN}`,
    ]);
  });

  it("redacts a JWT split immediately after a base64url underscore", () => {
    const token = "eyJheader_with_underscore.payload_with_underscore.signature_with_underscore";
    const splitAt = token.indexOf("_") + 1;
    const redactor = createStreamingTextRedactor({ enabled: false });

    const output = [
      redactor.push(`token=${token.slice(0, splitAt)}`),
      redactor.push(`${token.slice(splitAt)}\ndone`),
      redactor.flush(),
    ].join("");

    expect(output).toBe(`token=${SECRET_REDACTION_TOKEN}\ndon${SECRET_REDACTION_TOKEN}`);
    expect(output).not.toContain(token.slice(0, splitAt));
    expect(output).not.toContain(token.slice(splitAt));
  });

  it("bounds an unterminated JWT-like stream without exposing its tail", () => {
    const redactor = createStreamingTextRedactor({ enabled: false });
    const oversizedCandidate = `eyJ${"a".repeat(20 * 1024)}`;

    const output = [
      redactor.push(`token=${oversizedCandidate}`),
      redactor.push("still-secret"),
      redactor.push("\ndone"),
      redactor.flush(),
    ].join("");

    expect(output).toBe(`token=${SECRET_REDACTION_TOKEN}\ndon${SECRET_REDACTION_TOKEN}`);
    expect(output).not.toContain("still-secret");
  });

  it("keeps suppressing an oversized JWT candidate across an underscore boundary", () => {
    const redactor = createStreamingTextRedactor({ enabled: false });
    const oversizedCandidate = `eyJ${"a".repeat(20 * 1024)}`;

    const output = [
      redactor.push(`token=${oversizedCandidate}`),
      redactor.push("_secretTail"),
      redactor.push("\ndone"),
      redactor.flush(),
    ].join("");

    expect(output).toBe(`token=${SECRET_REDACTION_TOKEN}\ndon${SECRET_REDACTION_TOKEN}`);
    expect(output).not.toContain("secretTail");
  });

  it("redacts a complete log before applying caller-controlled byte ranges", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1oaXN0b3JpY2FsIn0.signature_value";
    const input = `before:${token}:after`;
    const expected = `before:${SECRET_REDACTION_TOKEN}:after`;
    let offset = 0;
    let reconstructed = "";

    while (true) {
      const page = redactCurrentUserTextRange(
        input,
        { offset, limitBytes: 5 },
        { enabled: false },
      );
      reconstructed += page.content;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }

    expect(reconstructed).toBe(expected);
    for (const hostileOffset of [9, 30, 58]) {
      const page = redactCurrentUserTextRange(
        input,
        { offset: hostileOffset, limitBytes: 8 },
        { enabled: false },
      );
      expect(page.content).not.toContain("hbGci");
      expect(page.content).not.toContain("ydW5J");
      expect(page.content).not.toContain("signature");
    }
  });

  it("redacts a historical JWT split across serialized NDJSON chunks before pagination", () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1oaXN0b3JpY2FsIn0.signature_value";
    const splitAt = token.indexOf("signature_value");
    const stored = [
      JSON.stringify({ ts: "1", stream: "stdout", chunk: `before:${token.slice(0, splitAt)}` }),
      JSON.stringify({ ts: "2", stream: "stderr", chunk: "unrelated" }),
      JSON.stringify({ ts: "3", stream: "stdout", chunk: `${token.slice(splitAt)}:after` }),
    ].join("\n") + "\n";
    let offset = 0;
    let reconstructedFile = "";

    while (true) {
      const page = redactNdjsonLogRange(
        stored,
        { offset, limitBytes: 7 },
        { enabled: false },
      );
      reconstructedFile += page.content;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }

    const records = reconstructedFile
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { stream: string; chunk: string });
    const stdout = records
      .filter((record) => record.stream === "stdout")
      .map((record) => record.chunk)
      .join("");

    expect(stdout).toBe(`before:${SECRET_REDACTION_TOKEN}${SECRET_REDACTION_TOKEN}:after`);
    expect(reconstructedFile).not.toContain(token.slice(0, splitAt));
    expect(reconstructedFile).not.toContain(token.slice(splitAt));

    for (const hostileOffset of [12, 48, 90]) {
      const page = redactNdjsonLogRange(
        stored,
        { offset: hostileOffset, limitBytes: 9 },
        { enabled: false },
      );
      expect(page.content).not.toContain("hbGci");
    }
  });

  it("fails closed on a cross-stream exact-secret prefix before a later mismatch", () => {
    const secret = "abcdef";
    const stored = [
      JSON.stringify({ stream: "stdout", chunk: "abc" }),
      JSON.stringify({ stream: "stderr", chunk: "def" }),
      JSON.stringify({ stream: "stdout", chunk: "x" }),
    ].join("\n") + "\n";

    const page = redactNdjsonLogRange(stored, undefined, {
      enabled: false,
      compiledSecretMatchers: new CompiledSensitiveValueMatchers([secret]),
    });

    expect(page.content).not.toContain("abc");
    expect(page.content).toContain(SECRET_REDACTION_TOKEN);
  });

  it("fails closed for an incomplete credential or malformed historical record", () => {
    const partialJwt = "eyJhbGciOiJIUzI1NiJ9.partial";
    const stored = `${JSON.stringify({ stream: "stdout", chunk: partialJwt })}\nnot-json\n`;
    const page = redactNdjsonLogRange(stored, undefined, { enabled: false });

    expect(page.content).not.toContain(partialJwt);
    expect(page.content).toContain(SECRET_REDACTION_TOKEN);
    expect(page.content).toContain("historical log record omitted");
  });

  it("fails closed before materializing an excessive number of historical records", () => {
    const stored = `${Array.from(
      { length: 10_001 },
      (_, index) => JSON.stringify({ stream: "stdout", chunk: `line-${index}` }),
    ).join("\n")}\n`;

    const page = redactNdjsonLogRange(stored, undefined, { enabled: false });

    expect(page.content).toContain("record limit exceeded");
    expect(page.content).not.toContain("line-0");
    expect(page.nextOffset).toBeUndefined();
  });

  it("drops non-canonical metadata that can reconstruct a credential", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1tZXRhZGF0YSJ9.signature_value";
    const splitAt = token.indexOf(".eyJ");
    const stored = `${JSON.stringify({
      ts: "1",
      stream: "stdout",
      chunk: "ok",
      left: token.slice(0, splitAt),
      right: token.slice(splitAt),
    })}\n`;

    const page = redactNdjsonLogRange(stored, undefined, { enabled: false });
    const record = JSON.parse(page.content.trim()) as Record<string, unknown>;

    expect(record).toEqual({ ts: "1", stream: "stdout", chunk: "ok" });
    expect(page.content).not.toContain(token.slice(0, splitAt));
    expect(page.content).not.toContain(token.slice(splitAt));
  });

  it("drops oversized non-canonical metadata from a single historical record", () => {
    const stored = `${JSON.stringify({
      ts: "1",
      stream: "stdout",
      chunk: "ok",
      blob: "x".repeat(1024 * 1024),
    })}\n`;

    const page = redactNdjsonLogRange(stored, undefined, { enabled: false });

    expect(page.content).toBe(`${JSON.stringify({ ts: "1", stream: "stdout", chunk: "ok" })}\n`);
    expect(Buffer.byteLength(page.content, "utf8")).toBeLessThan(256);
  });

  it("does not allocate redactors for attacker-controlled historical stream names", () => {
    const stored = `${Array.from(
      { length: 200 },
      (_, index) => JSON.stringify({ stream: `hostile-${index}`, chunk: `secret-${index}` }),
    ).join("\n")}\n`;

    const page = redactNdjsonLogRange(stored, undefined, { enabled: false });

    expect(page.content).toContain("invalid format");
    expect(page.content).not.toContain("hostile-");
    expect(page.content).not.toContain("secret-");
  });
});

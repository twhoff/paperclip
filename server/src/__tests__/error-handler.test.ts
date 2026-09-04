import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBeInstanceOf(Error);
    expect(res.err).not.toBe(err);
    expect(res.err.message).toBe("boom");
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBeInstanceOf(Error);
    expect(res.err).not.toBe(err);
    expect(res.err.message).toBe("db exploded");
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("redacts credentials from error responses and request logging context", () => {
    const credential = "provider-key-error-handler-canary-9f73";
    const req = makeReq() as any;
    req.body = { adapterConfig: { apiKey: credential } };
    req.query = { diagnostic: credential };
    req.originalUrl = `/api/test?diagnostic=${credential}`;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(
      500,
      `provider probe failed: ${credential}`,
      { stderr: credential },
    );

    errorHandler(err, req, res, next);

    const exposed = JSON.stringify({
      response: (res.json as ReturnType<typeof vi.fn>).mock.calls,
      errorContext: res.__errorContext,
      loggedError: {
        message: res.err?.message,
        stack: res.err?.stack,
      },
    });
    expect(exposed).not.toContain(credential);
    expect(exposed).toContain("***REDACTED***");
    expect(res.__errorContext.reqBody.adapterConfig.apiKey).toBe("***REDACTED***");
  });

  it("fails closed when request secret collection exceeds its bounded value set", () => {
    const req = makeReq() as any;
    req.body = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`apiKey${index}`, `secret-${index}`]),
    );
    const omittedSecret = "secret-128";
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new HttpError(500, `provider failed: ${omittedSecret}`), req, res, next);

    const exposed = JSON.stringify({
      response: (res.json as ReturnType<typeof vi.fn>).mock.calls,
      errorContext: res.__errorContext,
      loggedError: res.err,
    });
    expect(exposed).not.toContain(omittedSecret);
    expect(exposed).toContain("***REDACTED***");
  });

  it("redacts a current provider credential split between error message and stack", () => {
    const credential = "error-context-cross-stream-canary-7531";
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = credential;
    const splitAt = 20;
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error(credential.slice(0, splitAt));
    err.stack = credential.slice(splitAt);

    try {
      errorHandler(err, req, res, next);

      const contextReconstruction =
        `${res.__errorContext.error.message}${res.__errorContext.error.stack}`;
      const loggedReconstruction = `${res.err.message}${res.err.stack}`;
      expect(res.status).toHaveBeenCalledWith(500);
      expect(contextReconstruction).not.toContain(credential);
      expect(loggedReconstruction).not.toContain(credential);
      expect(JSON.stringify({ errorContext: res.__errorContext, loggedError: res.err }))
        .toContain("***REDACTED***");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("cannot reconstruct a JWT split across request body fields in logging context", () => {
    const credential = "eyJheader.payload.signature_";
    const req = makeReq() as any;
    req.body = {
      first: "eyJheader.",
      second: "payload.signature_",
    };
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new HttpError(400, "bad request"), req, res, next);

    const reconstruction = `${res.__errorContext.reqBody.first}${res.__errorContext.reqBody.second}`;
    expect(reconstruction).not.toContain(credential);
    expect(JSON.stringify(res.__errorContext.reqBody)).toContain("***REDACTED***");
  });

  it("strictly isolates diagnostics across separate error responses", () => {
    const token = "eyJerrors.separate.signature_";
    const firstReq = makeReq() as any;
    const secondReq = makeReq() as any;
    firstReq.body = { piece: token.slice(0, 1) };
    secondReq.body = { piece: token.slice(1) };
    const firstRes = makeRes() as any;
    const secondRes = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new HttpError(400, "first failure"), firstReq, firstRes, next);
    errorHandler(new HttpError(400, "second failure"), secondReq, secondRes, next);

    expect(`${firstRes.__errorContext.reqBody.piece}${secondRes.__errorContext.reqBody.piece}`)
      .not.toContain(token);
    expect(firstRes.__errorContext.reqBody.piece).toContain("***REDACTED***");
  });

  it("guards cyclic request bodies and cross-redacts error and request fragments", () => {
    const req = makeReq() as any;
    req.body = { continuation: "yJheader.payload.signature_" };
    req.body.self = req.body;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;

    expect(() => errorHandler(new HttpError(400, "e"), req, res, next)).not.toThrow();

    const serialized = JSON.stringify(res.__errorContext);
    expect(serialized).toContain("***REDACTED***");
    expect(`${res.__errorContext.error.message}${res.__errorContext.reqBody.continuation}`)
      .not.toContain("eyJheader.payload.signature_");
  });

  it("fails closed when HttpError diagnostic accessors throw", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const error = new Proxy(new HttpError(500, "hidden"), {
      get(target, property, receiver) {
        if (["name", "message", "stack", "details"].includes(String(property))) {
          throw new Error("hostile diagnostic accessor");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => errorHandler(error, req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.__errorContext)).not.toContain("hostile diagnostic accessor");
    expect(JSON.stringify(res.__errorContext)).toContain("***REDACTED***");
  });

  it("does not stringify hostile non-Error rejection values", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const error = {
      toString() {
        throw new Error("hostile string conversion");
      },
    };

    expect(() => errorHandler(error, req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.__errorContext.error.message).toBe("Internal server error");
  });
});

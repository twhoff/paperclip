import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";
import { serverVersion } from "../version.js";

describe("GET /health", () => {
  const app = express();
  app.use("/health", healthRoutes());

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("reports the dev watch identity when the serving process is supervised", async () => {
    const previous = process.env.PAPERCLIP_DEV_WATCH_ID;
    process.env.PAPERCLIP_DEV_WATCH_ID = "watch-1";
    try {
      const res = await request(app).get("/health");
      expect(res.body.devWatchId).toBe("watch-1");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_DEV_WATCH_ID;
      else process.env.PAPERCLIP_DEV_WATCH_ID = previous;
    }
  });
});

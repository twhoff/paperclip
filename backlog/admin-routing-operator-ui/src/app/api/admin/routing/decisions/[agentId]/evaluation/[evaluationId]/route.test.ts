/**
 * @jest-environment node
 */
/**
 * API route tests for GET /api/admin/routing/decisions/[agentId]/evaluation/[evaluationId]
 * (TIZA-1089).
 *
 * Asserts: 401 unauthenticated, 403 non-admin, 400 invalid evaluationId,
 * 404 evaluation not found, 200 + breakdown on success, 500 on service error.
 */

import { GET } from "./route";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdminSession = {
  token: "admin-token",
  user: {
    id: "admin-1",
    email: "admin@example.com",
    displayName: "Admin",
    timezone: "UTC",
    householdId: null,
    isPlatformAdmin: true,
    onboardingCompletedAt: new Date(),
  },
};

jest.mock("@/lib/session", () => ({
  requirePlatformAdminSession: jest.fn(),
}));

jest.mock("@/lib/services/routing-decisions.service", () => ({
  getEvaluationScores: jest.fn(),
}));

import { requirePlatformAdminSession } from "@/lib/session";
import { getEvaluationScores } from "@/lib/services/routing-decisions.service";

const mockRequire = requirePlatformAdminSession as jest.Mock;
const mockScores = getEvaluationScores as jest.Mock;

function makeParams(agentId: string, evaluationId: string) {
  return { params: Promise.resolve({ agentId, evaluationId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequire.mockResolvedValue(mockAdminSession);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/admin/routing/decisions/[agentId]/evaluation/[evaluationId]", () => {
  it("returns 401 when not authenticated", async () => {
    mockRequire.mockResolvedValue(Response.json({ error: "Unauthorised" }, { status: 401 }));
    const res = await GET(new Request("http://localhost"), makeParams("agent-1", "42"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    mockRequire.mockResolvedValue(Response.json({ error: "Forbidden" }, { status: 403 }));
    const res = await GET(new Request("http://localhost"), makeParams("agent-1", "42"));
    expect(res.status).toBe(403);
  });

  it("returns 400 when evaluationId is not a valid integer", async () => {
    const res = await GET(new Request("http://localhost"), makeParams("agent-1", "not-a-number"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid evaluationId");
  });

  it("returns 404 when the evaluation is not found", async () => {
    mockScores.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), makeParams("agent-1", "99"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Evaluation not found");
  });

  it("returns 200 with candidate scores on success", async () => {
    const breakdown = { evaluationId: 42, candidates: [{ name: "claude", score: 0.9 }] };
    mockScores.mockResolvedValue(breakdown);

    const res = await GET(new Request("http://localhost"), makeParams("agent-1", "42"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as typeof breakdown;
    expect(body.evaluationId).toBe(42);
    expect(body.candidates).toHaveLength(1);
    expect(mockScores).toHaveBeenCalledWith(42);
  });

  it("returns 500 when the service throws", async () => {
    mockScores.mockRejectedValue(new Error("DB error"));

    const res = await GET(new Request("http://localhost"), makeParams("agent-1", "42"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to load candidate scores");
  });
});

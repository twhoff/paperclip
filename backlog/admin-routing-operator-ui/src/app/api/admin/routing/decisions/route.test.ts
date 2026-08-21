/**
 * @jest-environment node
 */
/**
 * API route tests for GET /api/admin/routing/decisions (TIZA-1089).
 *
 * Asserts: 401 unauthenticated, 403 non-admin, 200 + agent summaries,
 * 500 when the service throws.
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
  getAgentSummaries: jest.fn(),
}));

import { requirePlatformAdminSession } from "@/lib/session";
import { getAgentSummaries } from "@/lib/services/routing-decisions.service";

const mockRequire = requirePlatformAdminSession as jest.Mock;
const mockSummaries = getAgentSummaries as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequire.mockResolvedValue(mockAdminSession);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/admin/routing/decisions", () => {
  it("returns 401 when not authenticated", async () => {
    mockRequire.mockResolvedValue(Response.json({ error: "Unauthorised" }, { status: 401 }));
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    mockRequire.mockResolvedValue(Response.json({ error: "Forbidden" }, { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns 200 with agent summaries for an admin", async () => {
    const summaries = [
      { agentId: "agent-1", agentName: "Tizzi", currentAdapter: "claude", currentModel: "sonnet" },
    ];
    mockSummaries.mockResolvedValue(summaries);

    const res = await GET();
    expect(res.status).toBe(200);

    const body = (await res.json()) as typeof summaries;
    expect(body).toHaveLength(1);
    expect(body[0]?.agentId).toBe("agent-1");
  });

  it("returns 500 when the service throws", async () => {
    mockSummaries.mockRejectedValue(new Error("DB error"));

    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to load routing decisions");
  });
});

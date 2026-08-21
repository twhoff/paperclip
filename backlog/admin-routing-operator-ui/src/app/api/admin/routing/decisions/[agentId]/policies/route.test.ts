/**
 * @jest-environment node
 */

jest.mock("@/lib/session", () => ({
  requirePlatformAdminSession: jest.fn(),
}));

jest.mock("@/lib/services/routing-decisions.service", () => ({
  getAgentPolicyBindings: jest.fn(),
}));

import { requirePlatformAdminSession } from "@/lib/session";
import { getAgentPolicyBindings } from "@/lib/services/routing-decisions.service";
import { GET } from "./route";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const mockAdminSession = {
  token: "admin-tok",
  user: {
    id: "admin-1",
    email: "admin@tizzi.app",
    displayName: "Admin",
    isPlatformAdmin: true,
  },
};

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  (requirePlatformAdminSession as jest.Mock).mockResolvedValue(mockAdminSession);
});

describe("GET /api/admin/routing/decisions/[agentId]/policies", () => {
  it("returns 401 when not admin", async () => {
    (requirePlatformAdminSession as jest.Mock).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 401 })
    );
    const res = await GET(new Request("http://localhost"), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
  });

  it("returns 400 for non-UUID agentId", async () => {
    const res = await GET(new Request("http://localhost"), makeParams("not-a-uuid"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid agent ID");
  });

  it("returns 200 with empty array when no data", async () => {
    (getAgentPolicyBindings as jest.Mock).mockResolvedValueOnce([]);
    const res = await GET(new Request("http://localhost"), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 200 with policy bindings payload", async () => {
    const policies = [
      {
        id: "p1",
        agentId: VALID_UUID,
        policyName: "cost-cap",
        boundAt: "2026-04-01T00:00:00Z",
      },
    ];
    (getAgentPolicyBindings as jest.Mock).mockResolvedValueOnce(policies);
    const res = await GET(new Request("http://localhost"), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("p1");
    expect(body[0].policyName).toBe("cost-cap");
  });

  it("returns 500 when service throws", async () => {
    (getAgentPolicyBindings as jest.Mock).mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(new Request("http://localhost"), makeParams(VALID_UUID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to load policy bindings");
  });
});

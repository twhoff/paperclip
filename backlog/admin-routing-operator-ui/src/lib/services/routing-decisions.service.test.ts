/**
 * @jest-environment node
 */
/**
 * routing-decisions.service tests — TIZA-741
 *
 * Service-layer unit tests. All DB interaction is mocked via pcli-db pool.
 * Tests cover: query output transformation, null handling, edge cases,
 * and the isShadowDecision helper logic (indirectly through return values).
 */

jest.mock("@/lib/pcli-db", () => ({
  pcliPool: {
    connect: jest.fn(),
  },
}));

import { pcliPool } from "@/lib/pcli-db";
import {
  getAgentSummaries,
  getAgentTimeline,
  getEvaluationScores,
  getAgentCooldown,
  getAgentPolicyBindings,
} from "./routing-decisions.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient(queryResults: Record<string, unknown[]>) {
  let callIndex = 0;
  const keys = Object.keys(queryResults);
  const mockQuery = jest.fn().mockImplementation(() => {
    const key = keys[callIndex] ?? keys[keys.length - 1] ?? "";
    callIndex++;
    return Promise.resolve({ rows: queryResults[key] ?? [] });
  });
  return {
    query: mockQuery,
    release: jest.fn(),
  };
}

function connectWith(client: ReturnType<typeof makeMockClient>) {
  (pcliPool.connect as jest.Mock).mockResolvedValue(client);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const now = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
const future = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

const decisionRow = {
  agent_id: "agent-1",
  agent_name: "Senior Engineer 1",
  action: "switch",
  decision_type: "adapter_switch",
  before_config: { adapter: "codex_local", model: null },
  after_config: { adapter: "copilot_cli", model: "claude-sonnet-4.6" },
  reason: "health_drop",
  created_at: now,
  trigger_type: "periodic",
  selected_candidate_id: 5,
};

const shadowDecisionRow = {
  ...decisionRow,
  agent_id: "agent-2",
  agent_name: "Senior Engineer 2",
  action: "shadow",
  decision_type: "shadow",
};

const cooldownRow = {
  agent_id: "agent-1",
  last_switch_reason: "rate_limit",
  last_switch_at: now,
  return_suppressed_until: future,
  previous_adapter_name: "codex_local",
};

// ---------------------------------------------------------------------------
// getAgentSummaries
// ---------------------------------------------------------------------------

describe("getAgentSummaries", () => {
  it("returns one summary per agent", async () => {
    const client = makeMockClient({
      decisions: [decisionRow],
      cooldowns: [],
    });
    connectWith(client);
    const results = await getAgentSummaries();
    expect(results).toHaveLength(1);
    const r0 = results[0];
    expect(r0).toBeDefined();
    expect(r0!.agentId).toBe("agent-1");
    expect(r0!.agentName).toBe("Senior Engineer 1");
  });

  it("maps after_config to currentAdapter and currentModel", async () => {
    const client = makeMockClient({ decisions: [decisionRow], cooldowns: [] });
    connectWith(client);
    const results = await getAgentSummaries();
    const summary = results[0];
    expect(summary).toBeDefined();
    expect(summary!.currentAdapter).toBe("copilot_cli");
    expect(summary!.currentModel).toBe("claude-sonnet-4.6");
  });

  it("sets shadowMode=true for shadow action", async () => {
    const client = makeMockClient({
      decisions: [shadowDecisionRow],
      cooldowns: [],
    });
    connectWith(client);
    const results = await getAgentSummaries();
    const summary = results[0];
    expect(summary).toBeDefined();
    expect(summary!.shadowMode).toBe(true);
  });

  it("sets shadowMode=false for switch action", async () => {
    const client = makeMockClient({ decisions: [decisionRow], cooldowns: [] });
    connectWith(client);
    const results = await getAgentSummaries();
    const summary = results[0];
    expect(summary).toBeDefined();
    expect(summary!.shadowMode).toBe(false);
  });

  it("attaches active cooldown state to matching agent", async () => {
    const client = makeMockClient({
      decisions: [decisionRow],
      cooldowns: [cooldownRow],
    });
    connectWith(client);
    const results = await getAgentSummaries();
    const summary = results[0];
    expect(summary).toBeDefined();
    expect(summary!.cooldown).not.toBeNull();
    expect(summary!.cooldown!.suppressedAdapter).toBe("codex_local");
    expect(summary!.cooldown!.remainingMs).toBeGreaterThan(0);
  });

  it("leaves cooldown=null when no active cooldown for agent", async () => {
    const client = makeMockClient({ decisions: [decisionRow], cooldowns: [] });
    connectWith(client);
    const results = await getAgentSummaries();
    const summary = results[0];
    expect(summary).toBeDefined();
    expect(summary!.cooldown).toBeNull();
  });

  it("returns empty array when no decisions", async () => {
    const client = makeMockClient({ decisions: [], cooldowns: [] });
    connectWith(client);
    const results = await getAgentSummaries();
    expect(results).toHaveLength(0);
  });

  it("releases the db client on success", async () => {
    const client = makeMockClient({ decisions: [decisionRow], cooldowns: [] });
    connectWith(client);
    await getAgentSummaries();
    expect(client.release).toHaveBeenCalled();
  });

  it("releases the db client on error", async () => {
    const client = makeMockClient({ decisions: [], cooldowns: [] });
    client.query.mockRejectedValueOnce(new Error("DB down"));
    connectWith(client);
    await expect(getAgentSummaries()).rejects.toThrow("DB down");
    expect(client.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAgentTimeline
// ---------------------------------------------------------------------------

const timelineRow = {
  id: 10,
  sweep_id: "sweep-1",
  decision_type: "adapter_switch",
  action: "switch",
  before_config: { adapter: "codex_local" },
  after_config: { adapter: "copilot_cli", model: "claude-sonnet-4.6" },
  reason: "health_drop",
  confidence: "0.92",
  trigger_type: "periodic",
  selected_candidate_id: 5,
  created_at: now,
  candidate_count: 3,
  evaluation_id: 99,
};

describe("getAgentTimeline", () => {
  it("returns events for the given agent", async () => {
    const client = makeMockClient({ events: [timelineRow] });
    connectWith(client);
    const events = await getAgentTimeline("agent-1");
    expect(events).toHaveLength(1);
    const e0 = events[0];
    expect(e0).toBeDefined();
    expect(e0!.id).toBe(10);
  });

  it("maps confidence string to float", async () => {
    const client = makeMockClient({ events: [timelineRow] });
    connectWith(client);
    const events = await getAgentTimeline("agent-1");
    const event = events[0];
    expect(event).toBeDefined();
    expect(event!.confidence).toBeCloseTo(0.92);
  });

  it("sets candidateCount=0 when candidate_count is null", async () => {
    const client = makeMockClient({
      events: [{ ...timelineRow, candidate_count: null }],
    });
    connectWith(client);
    const events = await getAgentTimeline("agent-1");
    const event = events[0];
    expect(event).toBeDefined();
    expect(event!.candidateCount).toBe(0);
  });

  it("sets evaluationId=null when evaluation_id is null", async () => {
    const client = makeMockClient({
      events: [{ ...timelineRow, evaluation_id: null }],
    });
    connectWith(client);
    const events = await getAgentTimeline("agent-1");
    const event = events[0];
    expect(event).toBeDefined();
    expect(event!.evaluationId).toBeNull();
  });

  it("sets shadowMode=true for shadow action", async () => {
    const client = makeMockClient({
      events: [{ ...timelineRow, action: "shadow", decision_type: "shadow" }],
    });
    connectWith(client);
    const events = await getAgentTimeline("agent-1");
    const event = events[0];
    expect(event).toBeDefined();
    expect(event!.shadowMode).toBe(true);
  });

  it("returns empty array when no events", async () => {
    const client = makeMockClient({ events: [] });
    connectWith(client);
    const events = await getAgentTimeline("agent-1");
    expect(events).toHaveLength(0);
  });

  it("releases the db client on success", async () => {
    const client = makeMockClient({ events: [timelineRow] });
    connectWith(client);
    await getAgentTimeline("agent-1");
    expect(client.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getEvaluationScores
// ---------------------------------------------------------------------------

const evalRow = {
  id: 99,
  sweep_id: "sweep-1",
  agent_name: "Senior Engineer 1",
  trigger_type: "periodic",
  reason: "health_drop",
  created_at: now,
};

const scoreRow = {
  id: 1,
  adapter_name: "copilot_cli",
  model_id: "claude-sonnet-4.6",
  allowed: true,
  excluded_reason: null,
  availability_score: "0.9",
  health_penalty: "0.0",
  recent_failure_penalty: "0.0",
  rate_limit_penalty: "0.0",
  cooldown_penalty: "0.0",
  total_score: "0.9",
  selected: true,
};

describe("getEvaluationScores", () => {
  it("returns full breakdown with candidates", async () => {
    const client = makeMockClient({
      eval: [evalRow],
      scores: [scoreRow],
    });
    connectWith(client);
    const breakdown = await getEvaluationScores(99);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.evaluationId).toBe(99);
    expect(breakdown!.candidates).toHaveLength(1);
  });

  it("parses numeric string fields to floats", async () => {
    const client = makeMockClient({ eval: [evalRow], scores: [scoreRow] });
    connectWith(client);
    const breakdown = await getEvaluationScores(99);
    const c0 = breakdown!.candidates[0];
    expect(c0).toBeDefined();
    expect(c0!.totalScore).toBeCloseTo(0.9);
    expect(c0!.healthPenalty).toBe(0);
  });

  it("returns null when evaluation not found", async () => {
    const client = makeMockClient({ eval: [], scores: [] });
    connectWith(client);
    const breakdown = await getEvaluationScores(999);
    expect(breakdown).toBeNull();
  });

  it("releases the db client on success", async () => {
    const client = makeMockClient({ eval: [evalRow], scores: [scoreRow] });
    connectWith(client);
    await getEvaluationScores(99);
    expect(client.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAgentCooldown
// ---------------------------------------------------------------------------

const cooldownStateRow = {
  last_switch_reason: "rate_limit",
  last_switch_at: now,
  return_suppressed_until: future,
  previous_adapter_name: "codex_local",
};

describe("getAgentCooldown", () => {
  it("returns cooldown state when active", async () => {
    const client = makeMockClient({ cooldown: [cooldownStateRow] });
    connectWith(client);
    const cooldown = await getAgentCooldown("agent-1");
    expect(cooldown).not.toBeNull();
    expect(cooldown!.suppressedAdapter).toBe("codex_local");
    expect(cooldown!.remainingMs).toBeGreaterThan(0);
  });

  it("returns null when no active cooldown", async () => {
    const client = makeMockClient({ cooldown: [] });
    connectWith(client);
    const cooldown = await getAgentCooldown("agent-1");
    expect(cooldown).toBeNull();
  });

  it("computes remainingMs relative to now", async () => {
    const client = makeMockClient({ cooldown: [cooldownStateRow] });
    connectWith(client);
    const cooldown = await getAgentCooldown("agent-1");
    const expectedRemaining = future.getTime() - Date.now();
    expect(cooldown!.remainingMs).toBeGreaterThan(0);
    // Allow 500ms slack for test execution time
    expect(Math.abs(cooldown!.remainingMs - expectedRemaining)).toBeLessThan(500);
  });

  it("returns lastSwitchAt as ISO string", async () => {
    const client = makeMockClient({ cooldown: [cooldownStateRow] });
    connectWith(client);
    const cooldown = await getAgentCooldown("agent-1");
    expect(cooldown!.lastSwitchAt).toBe(now.toISOString());
  });

  it("returns null lastSwitchAt when last_switch_at is null", async () => {
    const client = makeMockClient({
      cooldown: [{ ...cooldownStateRow, last_switch_at: null }],
    });
    connectWith(client);
    const cooldown = await getAgentCooldown("agent-1");
    expect(cooldown!.lastSwitchAt).toBeNull();
  });

  it("releases the db client", async () => {
    const client = makeMockClient({ cooldown: [cooldownStateRow] });
    connectWith(client);
    await getAgentCooldown("agent-1");
    expect(client.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAgentPolicyBindings
// ---------------------------------------------------------------------------

const policyRow = {
  policy_id: 1,
  policy_name: "openai-locked",
  policy_type: "adapter_restriction",
  applies_to_scope: "global",
  active: true,
  config_json: {},
  bound: false,
  priority: null,
};

const boundPolicyRow = {
  ...policyRow,
  policy_id: 2,
  policy_name: "copilot-cli-only",
  applies_to_scope: "agent",
  bound: true,
  priority: 1,
};

describe("getAgentPolicyBindings", () => {
  it("returns all policies for the agent", async () => {
    const client = makeMockClient({ policies: [policyRow, boundPolicyRow] });
    connectWith(client);
    const bindings = await getAgentPolicyBindings("agent-1");
    expect(bindings).toHaveLength(2);
  });

  it("maps bound=false correctly", async () => {
    const client = makeMockClient({ policies: [policyRow] });
    connectWith(client);
    const bindings = await getAgentPolicyBindings("agent-1");
    const binding = bindings[0];
    expect(binding).toBeDefined();
    expect(binding!.bound).toBe(false);
    expect(binding!.bindingPriority).toBeNull();
  });

  it("maps bound=true with priority correctly", async () => {
    const client = makeMockClient({ policies: [boundPolicyRow] });
    connectWith(client);
    const bindings = await getAgentPolicyBindings("agent-1");
    const binding = bindings[0];
    expect(binding).toBeDefined();
    expect(binding!.bound).toBe(true);
    expect(binding!.bindingPriority).toBe(1);
  });

  it("returns empty array when no policies", async () => {
    const client = makeMockClient({ policies: [] });
    connectWith(client);
    const bindings = await getAgentPolicyBindings("agent-1");
    expect(bindings).toHaveLength(0);
  });

  it("uses empty object as default config when config_json is null", async () => {
    const client = makeMockClient({
      policies: [{ ...policyRow, config_json: null }],
    });
    connectWith(client);
    const bindings = await getAgentPolicyBindings("agent-1");
    const binding = bindings[0];
    expect(binding).toBeDefined();
    expect(binding!.config).toEqual({});
  });

  it("releases the db client on success", async () => {
    const client = makeMockClient({ policies: [policyRow] });
    connectWith(client);
    await getAgentPolicyBindings("agent-1");
    expect(client.release).toHaveBeenCalled();
  });
});

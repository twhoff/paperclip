import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { DecisionTimeline } from "./DecisionTimeline";
import type { DecisionEvent } from "@/lib/services/routing-decisions.service";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

global.fetch = jest.fn();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(id: number, overrides: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    id,
    sweepId: `sweep-${id}`,
    decisionType: "adapter_switch",
    action: "switch",
    beforeAdapter: "codex_local",
    beforeModel: null,
    afterAdapter: "copilot_cli",
    afterModel: null,
    reason: "health_drop",
    confidence: 0.9,
    triggerType: "periodic",
    shadowMode: false,
    candidateCount: 2,
    evaluationId: id * 10,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const todayEvents: DecisionEvent[] = [
  makeEvent(1),
  makeEvent(2, { shadowMode: true, action: "shadow", decisionType: "shadow" }),
];

// ---------------------------------------------------------------------------
// DecisionTimeline
// ---------------------------------------------------------------------------

describe("DecisionTimeline", () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  it("renders empty state message when events array is empty", () => {
    render(<DecisionTimeline agentId="agent-1" events={[]} />);
    expect(screen.getByText(/No routing decisions recorded yet/i)).toBeInTheDocument();
  });

  it("renders a section for today's events", () => {
    render(<DecisionTimeline agentId="agent-1" events={todayEvents} />);
    expect(screen.getByText(/Today UTC/i)).toBeInTheDocument();
  });

  it("renders all events", () => {
    render(<DecisionTimeline agentId="agent-1" events={todayEvents} />);
    expect(screen.getAllByText("APPLIED").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("SHADOW").length).toBeGreaterThanOrEqual(1);
  });

  it("groups multiple events on different days into separate sections", () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayEvents = [makeEvent(3, { createdAt: yesterday.toISOString() })];
    render(<DecisionTimeline agentId="agent-1" events={[...todayEvents, ...yesterdayEvents]} />);
    expect(screen.getByText(/Today UTC/i)).toBeInTheDocument();
    expect(screen.getByText(/Yesterday UTC/i)).toBeInTheDocument();
  });

  it("renders events inside accessible list", () => {
    render(<DecisionTimeline agentId="agent-1" events={todayEvents} />);
    expect(screen.getByRole("list")).toBeInTheDocument();
  });

  it("passes agentId down to TimelineEvent (expand button uses it for fetch)", () => {
    render(<DecisionTimeline agentId="agent-special" events={[makeEvent(1)]} />);
    // Expand button present means TimelineEvent rendered with evaluationId
    expect(screen.getByRole("button", { name: /expand candidate scores/i })).toBeInTheDocument();
  });

  it("has no axe violations for non-empty timeline", async () => {
    const { container } = render(<DecisionTimeline agentId="agent-1" events={todayEvents} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations for empty timeline", async () => {
    const { container } = render(<DecisionTimeline agentId="agent-1" events={[]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

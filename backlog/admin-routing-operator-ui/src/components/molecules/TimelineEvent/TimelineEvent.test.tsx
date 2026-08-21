import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import { TimelineEvent } from "./TimelineEvent";
import type { DecisionEvent } from "@/lib/services/routing-decisions.service";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

global.fetch = jest.fn();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEvent: DecisionEvent = {
  id: 42,
  sweepId: "sweep-xyz",
  decisionType: "adapter_switch",
  action: "switch",
  beforeAdapter: "codex_local",
  beforeModel: null,
  afterAdapter: "copilot_cli",
  afterModel: "claude-sonnet-4.6",
  reason: "health_drop",
  confidence: 0.92,
  triggerType: "periodic",
  shadowMode: false,
  candidateCount: 3,
  evaluationId: 99,
  createdAt: "2026-04-06T10:00:00.000Z",
};

const shadowEvent: DecisionEvent = {
  ...baseEvent,
  id: 43,
  shadowMode: true,
  action: "shadow",
  decisionType: "shadow",
  evaluationId: null,
};

// ---------------------------------------------------------------------------
// TimelineEvent
// ---------------------------------------------------------------------------

describe("TimelineEvent", () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  it("renders APPLIED label for non-shadow events", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(screen.getByText("APPLIED")).toBeInTheDocument();
  });

  it("renders SHADOW label for shadow events", () => {
    render(<TimelineEvent event={shadowEvent} agentId="agent-1" />);
    expect(screen.getByText("SHADOW")).toBeInTheDocument();
  });

  it("shows ● indicator for applied events", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(screen.getByText("●")).toBeInTheDocument();
  });

  it("shows ◌ indicator for shadow events", () => {
    render(<TimelineEvent event={shadowEvent} agentId="agent-1" />);
    expect(screen.getByText("◌")).toBeInTheDocument();
  });

  it("shows adapter change in format 'after ← before'", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(
      screen.getByText(/copilot_cli \(claude-sonnet-4\.6\) ← codex_local/)
    ).toBeInTheDocument();
  });

  it("shows reason text", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(screen.getByText(/health_drop/i)).toBeInTheDocument();
  });

  it("shows candidate count", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(screen.getByText(/Candidates evaluated: 3/i)).toBeInTheDocument();
  });

  it("renders expand button when evaluationId is set", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(screen.getByRole("button", { name: /expand candidate scores/i })).toBeInTheDocument();
  });

  it("does not render expand button when evaluationId is null", () => {
    render(<TimelineEvent event={shadowEvent} agentId="agent-1" />);
    expect(
      screen.queryByRole("button", { name: /expand candidate scores/i })
    ).not.toBeInTheDocument();
  });

  it("expand button has aria-expanded=false initially", () => {
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("fetches and shows candidate scores when expanded", async () => {
    const mockScores = {
      evaluationId: 99,
      sweepId: "sweep-xyz",
      agentName: "agent-1",
      triggerType: "periodic",
      reason: null,
      createdAt: "2026-04-06T10:00:00.000Z",
      candidates: [
        {
          id: 1,
          adapterName: "copilot_cli",
          modelId: null,
          allowed: true,
          excludedReason: null,
          availabilityScore: 0.9,
          healthPenalty: 0,
          recentFailurePenalty: 0,
          rateLimitPenalty: 0,
          cooldownPenalty: 0,
          totalScore: 0.9,
          selected: true,
        },
      ],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockScores,
    });

    const user = userEvent.setup();
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });
    expect(screen.getByText("copilot_cli")).toBeInTheDocument();
  });

  it("shows error message when fetch fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false });

    const user = userEvent.setup();
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/could not load candidate scores/i)).toBeInTheDocument();
    });
  });

  it("collapses when expand button is clicked again", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        evaluationId: 99,
        sweepId: "s",
        agentName: "a",
        triggerType: null,
        reason: null,
        createdAt: "2026-04-06T10:00:00.000Z",
        candidates: [],
      }),
    });

    const user = userEvent.setup();
    render(<TimelineEvent event={baseEvent} agentId="agent-1" />);
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("region")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button"));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("has no axe violations for applied event", async () => {
    const { container } = render(
      <ul>
        <TimelineEvent event={baseEvent} agentId="agent-1" />
      </ul>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations for shadow event", async () => {
    const { container } = render(
      <ul>
        <TimelineEvent event={shadowEvent} agentId="agent-1" />
      </ul>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { CandidateScoreTable } from "./CandidateScoreTable";
import type { CandidateScoreBreakdown } from "@/lib/services/routing-decisions.service";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseBreakdown: CandidateScoreBreakdown = {
  evaluationId: 1,
  sweepId: "sweep-abc",
  agentName: "Senior Engineer 1",
  triggerType: "periodic",
  reason: "health_drop",
  createdAt: "2026-04-06T00:00:00.000Z",
  candidates: [
    {
      id: 1,
      adapterName: "copilot_cli",
      modelId: "claude-sonnet-4.6",
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
    {
      id: 2,
      adapterName: "codex_local",
      modelId: null,
      allowed: false,
      excludedReason: "circuit_breaker",
      availabilityScore: 0,
      healthPenalty: 0,
      recentFailurePenalty: 0,
      rateLimitPenalty: 0,
      cooldownPenalty: 0,
      totalScore: 0,
      selected: false,
    },
  ],
};

const breakdownWithPenalties: CandidateScoreBreakdown = {
  ...baseBreakdown,
  candidates: [
    {
      ...baseBreakdown.candidates[0]!,
      healthPenalty: -0.15,
      rateLimitPenalty: -0.05,
      totalScore: 0.7,
    },
    baseBreakdown.candidates[1]!,
  ],
};

// ---------------------------------------------------------------------------
// CandidateScoreTable
// ---------------------------------------------------------------------------

describe("CandidateScoreTable", () => {
  it("renders a table with accessible role", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders column headers with scope='col'", () => {
    const { container } = render(<CandidateScoreTable breakdown={baseBreakdown} />);
    const ths = container.querySelectorAll("th[scope='col']");
    expect(ths.length).toBeGreaterThanOrEqual(3);
  });

  it("shows adapter names for each candidate", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByText("copilot_cli")).toBeInTheDocument();
    expect(screen.getByText("codex_local")).toBeInTheDocument();
  });

  it("shows model ID alongside adapter name when set", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByText("(claude-sonnet-4.6)")).toBeInTheDocument();
  });

  it("shows numeric score for allowed candidates", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByText("0.90")).toBeInTheDocument();
  });

  it("shows EXCLUDED text for disallowed candidates", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByText("EXCLUDED")).toBeInTheDocument();
  });

  it("shows excluded reason in notes column", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByText(/circuit_breaker/i)).toBeInTheDocument();
  });

  it("marks selected candidate with accessible label", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByLabelText("selected")).toBeInTheDocument();
  });

  it("shows SELECTED label in notes column for selected candidate", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.getByText(/SELECTED/)).toBeInTheDocument();
  });

  it("shows penalty list when penalties exist", () => {
    render(<CandidateScoreTable breakdown={breakdownWithPenalties} />);
    expect(screen.getByText(/Penalties applied/i)).toBeInTheDocument();
    expect(screen.getByText(/health penalty/i)).toBeInTheDocument();
  });

  it("shows rate limit penalty when non-zero", () => {
    render(<CandidateScoreTable breakdown={breakdownWithPenalties} />);
    expect(screen.getByText(/rate limit penalty/i)).toBeInTheDocument();
  });

  it("does not show penalty section when all penalties are zero", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(screen.queryByText(/Penalties applied/i)).not.toBeInTheDocument();
  });

  it("shows evaluation timestamp", () => {
    render(<CandidateScoreTable breakdown={baseBreakdown} />);
    // Date is formatted, just check it's present in some form
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<CandidateScoreTable breakdown={baseBreakdown} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

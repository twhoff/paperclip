import type { Meta, StoryObj } from "@storybook/nextjs";
import { CandidateScoreTable } from "./CandidateScoreTable";
import type { CandidateScoreBreakdown } from "@/lib/services/routing-decisions.service";

const now = "2026-04-06T08:30:00.000Z";

const twoCandidate: CandidateScoreBreakdown = {
  evaluationId: 1,
  sweepId: "sweep-001",
  agentName: "Senior Engineer 1",
  triggerType: "periodic",
  reason: "health_drop",
  createdAt: now,
  candidates: [
    {
      id: 1,
      adapterName: "copilot_cli",
      modelId: "claude-sonnet-4.6",
      allowed: true,
      excludedReason: null,
      availabilityScore: 0.95,
      healthPenalty: 0,
      recentFailurePenalty: 0,
      rateLimitPenalty: 0,
      cooldownPenalty: 0,
      totalScore: 0.95,
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

const withPenalties: CandidateScoreBreakdown = {
  ...twoCandidate,
  candidates: [
    {
      ...twoCandidate.candidates[0]!,
      healthPenalty: -0.15,
      rateLimitPenalty: -0.05,
      totalScore: 0.75,
    },
    {
      id: 3,
      adapterName: "claude_local",
      modelId: "claude-opus-4.6",
      allowed: true,
      excludedReason: null,
      availabilityScore: 0.7,
      healthPenalty: -0.1,
      recentFailurePenalty: -0.08,
      rateLimitPenalty: 0,
      cooldownPenalty: -0.2,
      totalScore: 0.32,
      selected: false,
    },
    twoCandidate.candidates[1]!,
  ],
};

const meta: Meta<typeof CandidateScoreTable> = {
  component: CandidateScoreTable,
  title: "CandidateScoreTable",
  tags: ["autodocs", "molecule", "list-data"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof CandidateScoreTable>;

export const TwoCandidates: Story = {
  args: { breakdown: twoCandidate },
};

export const WithPenalties: Story = {
  name: "With penalty breakdown",
  args: { breakdown: withPenalties },
};

export const SingleCandidate: Story = {
  name: "Single candidate (selected)",
  args: {
    breakdown: {
      ...twoCandidate,
      candidates: [twoCandidate.candidates[0]!],
    },
  },
};

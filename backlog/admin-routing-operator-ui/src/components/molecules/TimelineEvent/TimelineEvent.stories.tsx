import type { Meta, StoryObj } from "@storybook/nextjs";
import { TimelineEvent } from "./TimelineEvent";
import type { DecisionEvent } from "@/lib/services/routing-decisions.service";

const appliedEvent: DecisionEvent = {
  id: 1,
  sweepId: "sweep-001",
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
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const shadowEvent: DecisionEvent = {
  ...appliedEvent,
  id: 2,
  action: "shadow",
  decisionType: "shadow",
  shadowMode: true,
  evaluationId: null,
  reason: "periodic evaluation — shadow mode active",
};

const noEvaluationEvent: DecisionEvent = {
  ...appliedEvent,
  id: 3,
  evaluationId: null,
  candidateCount: 0,
  reason: "manual_override",
};

const meta: Meta<typeof TimelineEvent> = {
  component: TimelineEvent,
  title: "TimelineEvent",
  tags: ["autodocs", "molecule", "list-data"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof TimelineEvent>;

export const Applied: Story = {
  args: {
    event: appliedEvent,
    agentId: "agent-preview",
  },
};

export const Shadow: Story = {
  args: {
    event: shadowEvent,
    agentId: "agent-preview",
  },
};

export const NoEvaluation: Story = {
  name: "No evaluation ID (no expand button)",
  args: {
    event: noEvaluationEvent,
    agentId: "agent-preview",
  },
};

export const EventList: Story = {
  name: "Multiple events",
  render: () => (
    <ul className="max-w-2xl space-y-2">
      <TimelineEvent event={appliedEvent} agentId="agent-preview" />
      <TimelineEvent event={shadowEvent} agentId="agent-preview" />
      <TimelineEvent event={noEvaluationEvent} agentId="agent-preview" />
    </ul>
  ),
};

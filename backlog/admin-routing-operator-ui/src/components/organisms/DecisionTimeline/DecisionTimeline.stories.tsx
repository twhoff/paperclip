import type { Meta, StoryObj } from "@storybook/nextjs";
import { DecisionTimeline } from "./DecisionTimeline";
import type { DecisionEvent } from "@/lib/services/routing-decisions.service";

function makeEvent(
  id: number,
  createdAt: string,
  overrides: Partial<DecisionEvent> = {}
): DecisionEvent {
  return {
    id,
    sweepId: `sweep-${id}`,
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
    evaluationId: id * 10,
    createdAt,
    ...overrides,
  };
}

const today = new Date();
const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);

const events: DecisionEvent[] = [
  makeEvent(1, today.toISOString()),
  makeEvent(2, new Date(today.getTime() - 2 * 60 * 60_000).toISOString(), {
    shadowMode: true,
    action: "shadow",
    decisionType: "shadow",
    reason: "periodic check",
  }),
  makeEvent(3, yesterday.toISOString(), { reason: "rate_limit_exceeded" }),
  makeEvent(4, new Date(yesterday.getTime() - 60 * 60_000).toISOString(), {
    evaluationId: null,
    candidateCount: 0,
  }),
];

const meta: Meta<typeof DecisionTimeline> = {
  component: DecisionTimeline,
  title: "DecisionTimeline",
  tags: ["autodocs", "organism", "list-data"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof DecisionTimeline>;

export const WithEvents: Story = {
  name: "Timeline with events (multi-day)",
  args: {
    agentId: "agent-preview",
    events,
  },
};

export const TodayOnly: Story = {
  name: "Today's events only",
  args: {
    agentId: "agent-preview",
    events: [makeEvent(1, today.toISOString()), makeEvent(2, today.toISOString())],
  },
};

export const Empty: Story = {
  name: "Empty state",
  args: {
    agentId: "agent-preview",
    events: [],
  },
};

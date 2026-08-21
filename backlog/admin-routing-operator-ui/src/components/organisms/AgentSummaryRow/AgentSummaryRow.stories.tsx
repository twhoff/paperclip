import type { Meta, StoryObj } from "@storybook/nextjs";
import { AgentSummaryRow } from "./AgentSummaryRow";
import type { AgentSummary } from "@/lib/services/routing-decisions.service";

const now = new Date().toISOString();

const baseAgent: AgentSummary = {
  agentId: "agent-abc",
  agentName: "Senior Engineer 1",
  currentAdapter: "copilot_cli",
  currentModel: "claude-sonnet-4.6",
  lastSwitchAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastSwitchReason: "health_drop",
  previousAdapter: "codex_local",
  shadowMode: false,
  cooldown: null,
};

const agentWithCooldown: AgentSummary = {
  ...baseAgent,
  agentName: "Senior Engineer 2",
  agentId: "agent-def",
  cooldown: {
    suppressedAdapter: "codex_local",
    returnSuppressedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    remainingMs: 30 * 60_000,
    lastSwitchReason: "rate_limit",
    lastSwitchAt: now,
  },
};

const agentWithShadow: AgentSummary = {
  ...baseAgent,
  agentName: "QA Engineer",
  agentId: "agent-ghi",
  shadowMode: true,
};

const agentNeverSwitched: AgentSummary = {
  ...baseAgent,
  agentName: "Lead Engineer",
  agentId: "agent-jkl",
  lastSwitchAt: null,
  lastSwitchReason: null,
  previousAdapter: null,
};

const meta: Meta<typeof AgentSummaryRow> = {
  component: AgentSummaryRow,
  title: "AgentSummaryRow",
  tags: ["autodocs", "organism"],
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <table>
        <tbody>
          <Story />
        </tbody>
      </table>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AgentSummaryRow>;

export const Active: Story = {
  args: { agent: baseAgent },
};

export const WithCooldown: Story = {
  name: "With active cooldown",
  args: { agent: agentWithCooldown },
};

export const ShadowMode: Story = {
  name: "Shadow mode active",
  args: { agent: agentWithShadow },
};

export const NeverSwitched: Story = {
  name: "No switch history",
  args: { agent: agentNeverSwitched },
};

export const MultipleRows: Story = {
  name: "Multiple rows (table)",
  decorators: [
    (_Story) => (
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-start">
            <th className="pe-4 pb-2">Agent</th>
            <th className="pe-4 pb-2">Adapter</th>
            <th className="pe-4 pb-2">Cooldown</th>
            <th className="pb-2">Last switch</th>
          </tr>
        </thead>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
          <AgentSummaryRow agent={agentWithCooldown} />
          <AgentSummaryRow agent={agentWithShadow} />
          <AgentSummaryRow agent={agentNeverSwitched} />
        </tbody>
      </table>
    ),
  ],
  args: { agent: baseAgent },
  render: () => <></>,
};

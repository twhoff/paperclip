import type { Meta, StoryObj } from "@storybook/nextjs";
import { PolicyBindingList } from "./PolicyBindingList";
import type { PolicyBinding } from "@/lib/services/routing-decisions.service";

const unboundOpenAI: PolicyBinding = {
  policyId: 1,
  policyName: "openai-locked",
  policyType: "adapter_restriction",
  appliesTo: "global",
  active: true,
  bound: false,
  bindingPriority: null,
  config: {},
};

const boundCopilotOnly: PolicyBinding = {
  policyId: 2,
  policyName: "copilot-cli-only",
  policyType: "adapter_restriction",
  appliesTo: "agent",
  active: true,
  bound: true,
  bindingPriority: 1,
  config: {},
};

const unboundManualOverride: PolicyBinding = {
  policyId: 3,
  policyName: "manual-override",
  policyType: "override",
  appliesTo: "agent",
  active: true,
  bound: false,
  bindingPriority: null,
  config: {},
};

const unknownPolicy: PolicyBinding = {
  policyId: 4,
  policyName: "custom-budget-cap",
  policyType: "budget",
  appliesTo: "agent",
  active: true,
  bound: false,
  bindingPriority: null,
  config: { maxDailyUsd: 10 },
};

const meta: Meta<typeof PolicyBindingList> = {
  component: PolicyBindingList,
  title: "PolicyBindingList",
  tags: ["autodocs", "organism", "list-data"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof PolicyBindingList>;

export const NoPolicies: Story = {
  name: "Empty state",
  args: { policies: [] },
};

export const AllUnbound: Story = {
  name: "All policies unbound",
  args: {
    policies: [unboundOpenAI, unboundManualOverride, unknownPolicy],
  },
};

export const WithBoundPolicy: Story = {
  name: "One policy bound (restriction active)",
  args: {
    policies: [unboundOpenAI, boundCopilotOnly, unboundManualOverride],
  },
};

export const MixedStates: Story = {
  name: "Mixed bound / unbound",
  args: {
    policies: [boundCopilotOnly, unboundOpenAI, unboundManualOverride, unknownPolicy],
  },
};

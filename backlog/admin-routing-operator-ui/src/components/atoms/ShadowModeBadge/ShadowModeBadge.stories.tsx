import type { Meta, StoryObj } from "@storybook/nextjs";
import { ShadowModeBadge } from "./ShadowModeBadge";

const meta: Meta<typeof ShadowModeBadge> = {
  component: ShadowModeBadge,
  title: "ShadowModeBadge",
  tags: ["autodocs", "atom", "feedback"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof ShadowModeBadge>;

export const Default: Story = {};

export const InContext: Story = {
  name: "In context (alongside agent name)",
  render: () => (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">Senior Engineer 1</span>
      <ShadowModeBadge />
    </div>
  ),
};

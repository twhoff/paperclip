import type { Meta, StoryObj } from "@storybook/nextjs";
import { CooldownBadge } from "./CooldownBadge";
import type { CooldownState } from "@/lib/services/routing-decisions.service";

const now = Date.now();

const baseCooldown: CooldownState = {
  suppressedAdapter: "copilot_cli",
  returnSuppressedUntil: new Date(now + 30 * 60_000).toISOString(),
  remainingMs: 30 * 60_000,
  lastSwitchReason: "rate_limit_exceeded",
  lastSwitchAt: new Date(now - 5 * 60_000).toISOString(),
};

const meta: Meta<typeof CooldownBadge> = {
  component: CooldownBadge,
  title: "CooldownBadge",
  tags: ["autodocs", "atom", "feedback"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof CooldownBadge>;

export const Default: Story = {
  args: {
    cooldown: baseCooldown,
  },
};

export const SubMinute: Story = {
  name: "Sub-minute remaining",
  args: {
    cooldown: {
      ...baseCooldown,
      remainingMs: 45_000,
      returnSuppressedUntil: new Date(now + 45_000).toISOString(),
    },
  },
};

export const LongCooldown: Story = {
  name: "Long cooldown (2h 15m)",
  args: {
    cooldown: {
      ...baseCooldown,
      remainingMs: (2 * 60 + 15) * 60_000,
      returnSuppressedUntil: new Date(now + (2 * 60 + 15) * 60_000).toISOString(),
    },
  },
};

export const NoSuppressedAdapter: Story = {
  name: "No suppressed adapter",
  args: {
    cooldown: {
      ...baseCooldown,
      suppressedAdapter: null,
      lastSwitchReason: null,
    },
  },
};

export const AllVariants: Story = {
  name: "All duration formats",
  render: () => (
    <div className="flex flex-col gap-3">
      <CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 45_000 }} />
      <CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 30 * 60_000 }} />
      <CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 90 * 60_000 }} />
      <CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 2 * 60 * 60_000 }} />
    </div>
  ),
};

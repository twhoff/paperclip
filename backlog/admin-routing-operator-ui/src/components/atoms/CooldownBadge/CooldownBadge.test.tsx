import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import { CooldownBadge } from "./CooldownBadge";
import type { CooldownState } from "@/lib/services/routing-decisions.service";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();
const baseCooldown: CooldownState = {
  suppressedAdapter: "copilot_cli",
  returnSuppressedUntil: new Date(now + 30 * 60_000).toISOString(),
  remainingMs: 30 * 60_000,
  lastSwitchReason: "rate_limit_exceeded",
  lastSwitchAt: new Date(now - 5 * 60_000).toISOString(),
};

// ---------------------------------------------------------------------------
// CooldownBadge
// ---------------------------------------------------------------------------

describe("CooldownBadge", () => {
  it("renders remaining time in the button label", () => {
    render(<CooldownBadge cooldown={baseCooldown} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/30m remaining/i);
  });

  it("shows '<1m' for sub-minute durations", () => {
    render(<CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 30_000 }} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/<1m remaining/i);
  });

  it("formats hours+minutes when duration ≥ 60 min", () => {
    render(<CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 90 * 60_000 }} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/1h 30m remaining/i);
  });

  it("formats exact hours when remainder is zero", () => {
    render(<CooldownBadge cooldown={{ ...baseCooldown, remainingMs: 2 * 60 * 60_000 }} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/2h remaining/i);
  });

  it("button is aria-expanded=false initially", () => {
    render(<CooldownBadge cooldown={baseCooldown} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens dialog panel on click", async () => {
    const user = userEvent.setup();
    render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Cooldown active")).toBeInTheDocument();
  });

  it("button becomes aria-expanded=true after opening", async () => {
    const user = userEvent.setup();
    render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("shows suppressed adapter in the dialog", async () => {
    const user = userEvent.setup();
    render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("copilot_cli")).toBeInTheDocument();
  });

  it("shows lastSwitchReason in the dialog when set", async () => {
    const user = userEvent.setup();
    render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("rate_limit_exceeded")).toBeInTheDocument();
  });

  it("closes dialog when Close button is clicked", async () => {
    const user = userEvent.setup();
    render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByText("Close"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes dialog on Escape key when focus is inside the dialog", async () => {
    const user = userEvent.setup();
    render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    // Tab into the dialog so keyboard events reach it
    await user.tab();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("handles missing suppressedAdapter gracefully", () => {
    render(<CooldownBadge cooldown={{ ...baseCooldown, suppressedAdapter: null }} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/adapter suppressed/i);
  });

  it("has no axe violations in closed state", async () => {
    const { container } = render(<CooldownBadge cooldown={baseCooldown} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in open state", async () => {
    const user = userEvent.setup();
    const { container } = render(<CooldownBadge cooldown={baseCooldown} />);
    await user.click(screen.getByRole("button"));
    expect(await axe(container)).toHaveNoViolations();
  });
});

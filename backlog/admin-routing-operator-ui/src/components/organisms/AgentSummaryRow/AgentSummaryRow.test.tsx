import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { AgentSummaryRow } from "./AgentSummaryRow";
import type { AgentSummary } from "@/lib/services/routing-decisions.service";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  cooldown: {
    suppressedAdapter: "codex_local",
    returnSuppressedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    remainingMs: 30 * 60_000,
    lastSwitchReason: "rate_limit",
    lastSwitchAt: now,
  },
};

const agentWithShadowMode: AgentSummary = {
  ...baseAgent,
  shadowMode: true,
  cooldown: null,
};

const agentWithNoSwitch: AgentSummary = {
  ...baseAgent,
  lastSwitchAt: null,
  lastSwitchReason: null,
  previousAdapter: null,
};

// ---------------------------------------------------------------------------
// AgentSummaryRow
// ---------------------------------------------------------------------------

describe("AgentSummaryRow", () => {
  it("renders the agent name", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText("Senior Engineer 1").length).toBeGreaterThan(0);
  });

  it("renders the current adapter", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText("copilot_cli").length).toBeGreaterThan(0);
  });

  it("shows 'Active' status when no cooldown and no shadow mode", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
  });

  it("renders CooldownBadge when cooldown is active", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={agentWithCooldown} />
        </tbody>
      </table>
    );
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("renders ShadowModeBadge when shadowMode is true", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={agentWithShadowMode} />
        </tbody>
      </table>
    );
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("links to the agent timeline page", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    const links = screen.getAllByRole("link");
    expect(links.some((l) => l.getAttribute("href") === "/admin/routing/agent-abc")).toBe(true);
  });

  it("shows 'just now' for very recent switches", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={{ ...baseAgent, lastSwitchAt: new Date().toISOString() }} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText(/just now/).length).toBeGreaterThan(0);
  });

  it("shows last switch reason in phone layout", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText(/health_drop/i).length).toBeGreaterThan(0);
  });

  it("shows adapter transition in phone layout when previousAdapter exists", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText(/codex_local → copilot_cli/i).length).toBeGreaterThan(0);
  });

  it("gracefully handles null lastSwitchAt", () => {
    render(
      <table>
        <tbody>
          <AgentSummaryRow agent={agentWithNoSwitch} />
        </tbody>
      </table>
    );
    expect(screen.getAllByText("Senior Engineer 1").length).toBeGreaterThan(0);
  });

  it("has no axe violations for base agent", async () => {
    const { container } = render(
      <table>
        <tbody>
          <AgentSummaryRow agent={baseAgent} />
        </tbody>
      </table>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations for agent with cooldown", async () => {
    const { container } = render(
      <table>
        <tbody>
          <AgentSummaryRow agent={agentWithCooldown} />
        </tbody>
      </table>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

import type { Meta, StoryObj } from "@storybook/nextjs";
import type { AgentSummary, CooldownState } from "@/lib/services/routing-decisions.service";
import { AgentSummaryRow } from "@/components/organisms/AgentSummaryRow";

const meta: Meta = {
  title: "Screens/admin/routing",
  tags: ["autodocs", "screen"],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "phone" },
  },
};

export default meta;
type Story = StoryObj;

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const cooldown: CooldownState = {
  suppressedAdapter: "claude_local",
  returnSuppressedUntil: new Date(Date.now() + 3_600_000).toISOString(),
  remainingMs: 3_600_000,
  lastSwitchReason: "Cost threshold exceeded",
  lastSwitchAt: new Date(Date.now() - 7_200_000).toISOString(),
};

const MOCK_AGENTS: AgentSummary[] = [
  {
    agentId: "a-1",
    agentName: "Senior Engineer 1",
    currentAdapter: "copilot_cli",
    currentModel: "gpt-4o",
    lastSwitchAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastSwitchReason: "Scheduled rotation",
    previousAdapter: "claude_local",
    shadowMode: false,
    cooldown: null,
  },
  {
    agentId: "a-2",
    agentName: "Senior Engineer 2",
    currentAdapter: "claude_local",
    currentModel: "claude-sonnet-4-20250514",
    lastSwitchAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastSwitchReason: "Quality score improvement",
    previousAdapter: "copilot_cli",
    shadowMode: false,
    cooldown,
  },
  {
    agentId: "a-3",
    agentName: "QA Lead",
    currentAdapter: "copilot_cli",
    currentModel: "gpt-4o",
    lastSwitchAt: null,
    lastSwitchReason: null,
    previousAdapter: null,
    shadowMode: true,
    cooldown: null,
  },
];

// ---------------------------------------------------------------------------
// Screen shell
// ---------------------------------------------------------------------------

function RoutingScreen({ state }: { state: "loading" | "error" | "loaded" | "empty" }) {
  const agents = state === "loaded" ? MOCK_AGENTS : [];
  const loading = state === "loading";
  const error = state === "error" ? "Could not load routing decisions." : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Adapter Routing Decisions</h1>
        <div className="flex items-center gap-3">
          {state === "loaded" && (
            <span className="text-muted-foreground text-xs">Updated 14:32:05</span>
          )}
          <button
            type="button"
            disabled={loading}
            className="border-border bg-card hover:bg-muted focus-visible:outline-ring rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      {state === "empty" && (
        <p className="text-muted-foreground text-sm">No routing decisions recorded yet.</p>
      )}

      {agents.length > 0 && (
        <>
          {/* Phone: stacked cards */}
          <div className="space-y-3 sm:hidden">
            {agents.map((agent) => (
              <AgentSummaryRow key={agent.agentId} agent={agent} />
            ))}
          </div>

          {/* Tablet/Desktop: table */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm" role="table">
              <thead>
                <tr className="border-border border-b text-left">
                  <th scope="col" className="text-muted-foreground pr-4 pb-2 font-medium">
                    Agent
                  </th>
                  <th scope="col" className="text-muted-foreground pr-4 pb-2 font-medium">
                    Current adapter
                  </th>
                  <th scope="col" className="text-muted-foreground pr-4 pb-2 font-medium">
                    Cooldown
                  </th>
                  <th scope="col" className="text-muted-foreground pb-2 font-medium">
                    Last switch
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentSummaryRow key={agent.agentId} agent={agent} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Default: Story = {
  name: "Loaded (phone)",
  render: () => <RoutingScreen state="loaded" />,
};

export const Loading: Story = {
  render: () => <RoutingScreen state="loading" />,
};

export const Error: Story = {
  render: () => <RoutingScreen state="error" />,
};

export const Empty: Story = {
  render: () => <RoutingScreen state="empty" />,
};

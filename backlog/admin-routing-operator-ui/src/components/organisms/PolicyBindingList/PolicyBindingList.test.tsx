import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { PolicyBindingList } from "./PolicyBindingList";
import type { PolicyBinding } from "@/lib/services/routing-decisions.service";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const unboundPolicy: PolicyBinding = {
  policyId: 1,
  policyName: "openai-locked",
  policyType: "adapter_restriction",
  appliesTo: "global",
  active: true,
  bound: false,
  bindingPriority: null,
  config: {},
};

const boundPolicy: PolicyBinding = {
  policyId: 2,
  policyName: "copilot-cli-only",
  policyType: "adapter_restriction",
  appliesTo: "agent",
  active: true,
  bound: true,
  bindingPriority: 1,
  config: {},
};

const manualOverridePolicy: PolicyBinding = {
  policyId: 3,
  policyName: "manual-override",
  policyType: "override",
  appliesTo: "agent",
  active: true,
  bound: false,
  bindingPriority: null,
  config: {},
};

// ---------------------------------------------------------------------------
// PolicyBindingList
// ---------------------------------------------------------------------------

describe("PolicyBindingList", () => {
  it("renders empty state when policies array is empty", () => {
    render(<PolicyBindingList policies={[]} />);
    expect(screen.getByText(/No active policies configured/i)).toBeInTheDocument();
  });

  it("renders a card for each policy", () => {
    render(<PolicyBindingList policies={[unboundPolicy, boundPolicy]} />);
    expect(screen.getByRole("region", { name: /Policy: openai-locked/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Policy: copilot-cli-only/i })).toBeInTheDocument();
  });

  it("renders 'NOT BOUND ✓' chip for unbound policy", () => {
    render(<PolicyBindingList policies={[unboundPolicy]} />);
    expect(screen.getByLabelText("Not bound")).toBeInTheDocument();
  });

  it("renders 'BOUND ⚠' chip for bound policy", () => {
    render(<PolicyBindingList policies={[boundPolicy]} />);
    expect(screen.getByLabelText(/Bound — restriction active/i)).toBeInTheDocument();
  });

  it("shows positive implication for known unbound openai-locked policy", () => {
    render(<PolicyBindingList policies={[unboundPolicy]} />);
    expect(screen.getByText(/No restriction on OpenAI adapters/i)).toBeInTheDocument();
  });

  it("shows positive implication for unbound copilot-cli-only policy", () => {
    render(<PolicyBindingList policies={[{ ...boundPolicy, bound: false }]} />);
    expect(screen.getByText(/Can route to any available adapter/i)).toBeInTheDocument();
  });

  it("shows positive implication for unbound manual-override policy", () => {
    render(<PolicyBindingList policies={[manualOverridePolicy]} />);
    expect(screen.getByText(/Routing decisions managed by V2 selector/i)).toBeInTheDocument();
  });

  it("shows bound implication text for bound policies", () => {
    render(<PolicyBindingList policies={[boundPolicy]} />);
    expect(screen.getByText(/Routing constrained by this policy binding/i)).toBeInTheDocument();
  });

  it("shows read-only notice", () => {
    render(<PolicyBindingList policies={[unboundPolicy]} />);
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it("shows policy type in card", () => {
    render(<PolicyBindingList policies={[unboundPolicy]} />);
    expect(screen.getByText(/adapter_restriction/i)).toBeInTheDocument();
  });

  it("shows appliesTo scope in card", () => {
    render(<PolicyBindingList policies={[unboundPolicy]} />);
    expect(screen.getByText(/global/i)).toBeInTheDocument();
  });

  it("has no axe violations for unbound policies", async () => {
    const { container } = render(
      <PolicyBindingList policies={[unboundPolicy, manualOverridePolicy]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations for bound policy", async () => {
    const { container } = render(<PolicyBindingList policies={[boundPolicy]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations for empty state", async () => {
    const { container } = render(<PolicyBindingList policies={[]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

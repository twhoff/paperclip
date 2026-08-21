import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { ShadowModeBadge } from "./ShadowModeBadge";

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// ShadowModeBadge
// ---------------------------------------------------------------------------

describe("ShadowModeBadge", () => {
  it("renders with accessible status role", () => {
    render(<ShadowModeBadge />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("has descriptive accessible label including 'Shadow mode'", () => {
    render(<ShadowModeBadge />);
    expect(
      screen.getByRole("status", {
        name: /shadow mode active — decisions logged but not applied/i,
      })
    ).toBeInTheDocument();
  });

  it("renders visible 'Shadow mode' text", () => {
    render(<ShadowModeBadge />);
    expect(screen.getByText(/shadow mode/i)).toBeInTheDocument();
  });

  it("renders the decorative icon as aria-hidden", () => {
    const { container } = render(<ShadowModeBadge />);
    const icon = container.querySelector("[aria-hidden='true']");
    expect(icon).toBeInTheDocument();
  });

  it("accepts and applies a custom className", () => {
    const { container } = render(<ShadowModeBadge className="my-custom-class" />);
    expect(container.firstChild).toHaveClass("my-custom-class");
  });

  it("has no axe violations", async () => {
    const { container } = render(<ShadowModeBadge />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

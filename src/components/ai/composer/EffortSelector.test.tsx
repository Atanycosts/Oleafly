// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/ai.json" with { type: "json" };
import { EffortSelector } from "./EffortSelector";

beforeAll(async () => {
  const { initTestI18n } = await import("@/components/ai/acp/tests/ui-fixtures");
  await initTestI18n();
});

function open() {
  fireEvent.pointerDown(screen.getByTestId("ai-effort-selector"), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("EffortSelector", () => {
  it("hides itself when the model has no effort choices", () => {
    const { container } = render(<EffortSelector choices={[]} value={undefined} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Auto for a level the model does not offer", () => {
    render(<EffortSelector choices={["low", "high"]} value="max" onChange={vi.fn()} />);
    expect(screen.getByTestId("ai-effort-selector")).toHaveAccessibleName(
      en.effort.ariaLabel.replace("{{level}}", en.effort.auto),
    );
  });

  it("picks the provider's ultra level and goes back to Auto", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<EffortSelector choices={["max", "ultra"]} value={undefined} onChange={onChange} />);
    open();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: en.effort.levels.ultra }));
    expect(onChange).toHaveBeenLastCalledWith("ultra");
    rerender(<EffortSelector choices={["max", "ultra"]} value="ultra" onChange={onChange} />);
    open();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(en.effort.auto) }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

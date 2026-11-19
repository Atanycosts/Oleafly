// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MaterialVersionStack, type MaterialVersionStackMode } from "./MaterialVersionStack";

function Counter({ name, unmount }: { name: string; unmount: () => void }) {
  const [value, setValue] = useState(0);
  useEffect(() => unmount, [unmount]);
  return <button type="button" onClick={() => setValue(value + 1)}>{name}: {value}</button>;
}

it("places two persistent layers on one canvas and makes only the front interactive", () => {
  const onForegroundChange = vi.fn();
  const originalField = "Original field";
  const workingField = "Working field";
  const { container } = render(<MaterialVersionStack mode="stack" previousLabel="Original" currentLabel="Working" previous={<input aria-label={originalField} />} current={<input aria-label={workingField} />} onForegroundChange={onForegroundChange} />);
  const canvas = screen.getByTestId("material-version-canvas");
  const rear = screen.getByLabelText("Original", { selector: "section" });
  const front = screen.getByLabelText("Working", { selector: "section" });
  expect(canvas).toHaveClass("relative", "[--stack-offset:28px]");
  expect(rear.parentElement).toBe(canvas);
  expect(front.parentElement).toBe(canvas);
  expect(rear).toHaveClass("absolute");
  expect(front).toHaveClass("absolute");
  expect(rear).toHaveAttribute("inert");
  expect(rear).toHaveAttribute("aria-hidden", "true");
  const rearLabel = within(rear).getByTestId("material-version-back-label");
  expect(rearLabel).toHaveTextContent("Original");
  expect(rearLabel).toHaveClass("z-[60]", "pointer-events-none", "text-xs");
  expect(rearLabel).not.toHaveAttribute("hidden");
  expect((rear as HTMLElement).style.zIndex).toBe("1");
  expect((front as HTMLElement).style.zIndex).toBe("2");
  expect(front).not.toHaveAttribute("inert");
  expect((rear as HTMLElement).style.top).toBe("0px");
  expect((front as HTMLElement).style.top).toBe("0px");
  expect((front as HTMLElement).style.right).toBe((rear as HTMLElement).style.right);
  expect((front as HTMLElement).style.bottom).toBe((rear as HTMLElement).style.bottom);
  expect((front as HTMLElement).style.transform).toBe("translate3d(var(--stack-offset), var(--stack-offset), 0)");
  expect((rear as HTMLElement).style.transform).toBe("translate3d(0, 0, 0)");
  expect(front).toHaveClass("motion-safe:transition-[transform,box-shadow]", "motion-reduce:transition-none");
  screen.getByRole("textbox", { name: "Working field" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(front).toHaveAttribute("inert");
  expect(rear).not.toHaveAttribute("inert");
  expect(rearLabel).toHaveAttribute("hidden");
  expect(within(front).getByTestId("material-version-back-label")).toHaveTextContent("Working");
  expect(within(front).getByTestId("material-version-back-label")).not.toHaveAttribute("hidden");
  expect((rear as HTMLElement).style.transform).toBe("translate3d(var(--stack-offset), var(--stack-offset), 0)");
  expect((front as HTMLElement).style.transform).toBe("translate3d(0, 0, 0)");
  expect(screen.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
  expect(container.querySelector('[aria-label="Working field"]')).not.toHaveFocus();
  expect(onForegroundChange).toHaveBeenCalledWith("previous");
});

it("keeps both child states and DOM instances through foreground and single layer changes", () => {
  const unmount = vi.fn();
  const show = (mode: MaterialVersionStackMode) => <MaterialVersionStack mode={mode} previousLabel="Original" currentLabel="Working" previous={<Counter name="Original count" unmount={unmount} />} current={<Counter name="Working count" unmount={unmount} />} />;
  const view = render(show("stack"));
  const current = screen.getByRole("button", { name: "Working count: 0" });
  fireEvent.click(current);
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  const previous = screen.getByRole("button", { name: "Original count: 0" });
  fireEvent.click(previous);
  view.rerender(show("current"));
  expect(screen.getByRole("button", { name: "Working count: 1" })).toBe(current);
  expect(previous.closest('[data-version="previous"]')).toHaveAttribute("hidden");
  expect((current.closest('[data-version="current"]') as HTMLElement).style.transform).toBe("");
  expect(current.closest('[data-version="current"]')).toHaveClass("inset-0");
  view.rerender(show("previous"));
  expect(screen.getByRole("button", { name: "Original count: 1" })).toBe(previous);
  view.rerender(show("stack"));
  fireEvent.click(screen.getByRole("button", { name: "Working" }));
  expect(screen.getByRole("button", { name: "Working count: 1" })).toBe(current);
  expect(unmount).not.toHaveBeenCalled();
});

it("honors a controlled foreground without resetting either layer", () => {
  const change = vi.fn();
  const view = render(<MaterialVersionStack mode="stack" foreground="previous" onForegroundChange={change} previousLabel="Original" currentLabel="Working" previous="Original content" current="Working content" />);
  fireEvent.click(screen.getByRole("button", { name: "Working" }));
  expect(change).toHaveBeenCalledWith("current");
  expect(screen.getByRole("region", { name: "Original" })).toHaveAttribute("data-foreground", "true");
  view.rerender(<MaterialVersionStack mode="stack" foreground="current" onForegroundChange={change} previousLabel="Original" currentLabel="Working" previous="Original content" current="Working content" />);
  expect(screen.getByRole("region", { name: "Working" })).toHaveAttribute("data-foreground", "true");
});

// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  WordFormattingToolbar,
  WordSurface,
  WordToolbarPortal,
  type WordFormattingToolbarLabels,
} from "./WordSurface";

const command = vi.hoisted(() => ({
  execute: vi.fn(),
  isActive: false,
  isEnabled: true,
  disabledReason: null as string | null,
}));

const fontFamily = vi.hoisted(() => ({
  value: "Cambria" as string | null,
  options: ["Calibri", "Cambria", "Times New Roman"],
  setValue: vi.fn(),
  isEnabled: true,
}));

const fontSize = vi.hoisted(() => ({
  value: 22 as number | null,
  execute: vi.fn(),
  isEnabled: true,
}));

vi.mock("@docx-editor.dev/react", () => ({
  useEditorCommand: (slot: string) => ({
    ...command,
    execute: (...args: unknown[]) => command.execute(slot, ...args),
    isActive: slot === "alignment.center" ? true : command.isActive,
  }),
  useEditorValueCommand: () => fontSize,
  useFontFamily: () => fontFamily,
}));

const labels: WordFormattingToolbarLabels = {
  toolbar: "Formatting",
  undo: "Undo",
  redo: "Redo",
  bold: "Bold",
  italic: "Italic",
  fontFamily: "Font",
  fontSize: "Size",
  mixed: "Mixed",
  alignLeft: "Align left",
  alignCenter: "Align center",
  alignRight: "Align right",
  moreTools: "More formatting",
  fewerTools: "Fewer formatting tools",
};

afterEach(() => {
  command.execute.mockReset();
  fontFamily.setValue.mockReset();
  fontSize.execute.mockReset();
});

function Counter({ name, mounted }: { name: string; mounted: () => void }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    mounted();
  }, [mounted]);
  return <button type="button" onClick={() => setValue((current) => current + 1)}>{name}: {value}</button>;
}

it("keeps both children mounted with one visible paper across single and compare views", () => {
  const originalMounted = vi.fn();
  const workingMounted = vi.fn();
  const onForegroundChange = vi.fn();
  const show = (view: "working" | "original" | "compare", foreground?: "current" | "previous") => (
    <WordSurface
      view={view}
      foreground={foreground}
      onForegroundChange={onForegroundChange}
      originalLabel="Original"
      workingLabel="Working"
      original={<Counter name="Original count" mounted={originalMounted} />}
      working={<Counter name="Working count" mounted={workingMounted} />}
    />
  );
  const view = render(show("working"));
  const working = screen.getByRole("button", { name: "Working count: 0" });
  const original = screen.getByRole("button", { name: "Original count: 0", hidden: true });
  const surface = screen.getByTestId("word-surface");
  const foreground = screen.getByTestId("word-surface-foreground");
  const foregroundClasses = foreground.className;
  const spine = screen.getByTestId("word-surface-version-spine");
  expect(within(spine).getByRole("button", { name: "Original" })).toBeVisible();
  expect(within(spine).getByRole("button", { name: "Working", pressed: true })).toBeVisible();
  expect(within(spine).getByRole("button", { name: "Working", pressed: true })).toHaveStyle("transform: translate(0, 32px)");
  expect(spine).toHaveClass("h-16", "shrink-0");
  expect(screen.getByTestId("word-surface-paper-edge")).toHaveStyle("transform: translateX(-20px)");

  fireEvent.click(working);
  expect(surface.querySelectorAll("[data-word-surface-layer]:not([hidden])")).toHaveLength(1);
  expect(original.closest("[data-word-surface-layer]")).toHaveAttribute("hidden");
  expect(original.closest("[data-word-surface-layer]")).toHaveAttribute("inert");

  view.rerender(show("original"));
  expect(screen.getByRole("button", { name: "Original count: 0" })).toBe(original);
  expect(working.closest("[data-word-surface-layer]")).toHaveAttribute("hidden");
  expect(original.closest("[data-word-surface-layer]")).not.toHaveAttribute("hidden");

  view.rerender(show("compare"));
  const edge = screen.getByTestId("word-surface-paper-edge");
  expect(edge).toHaveStyle("transform: translateX(-20px)");
  expect(edge).toHaveAttribute("data-version", "previous");
  expect(edge).toHaveAttribute("aria-hidden", "true");
  expect(edge).toHaveClass("pointer-events-none", "duration-[180ms]", "motion-safe:transition-transform", "motion-reduce:transition-none");
  expect(surface.querySelectorAll("[data-word-surface-layer]:not([hidden])")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(onForegroundChange).toHaveBeenCalledWith("previous");
  expect(screen.getByRole("button", { name: "Original", pressed: true })).toBeInTheDocument();
  expect(within(spine).getByRole("button", { name: "Original", pressed: true })).toHaveStyle("transform: translate(0, 32px)");
  expect(edge).toHaveAttribute("data-version", "current");
  expect(edge).toHaveStyle("transform: translateX(20px)");
  expect(screen.getByRole("button", { name: "Original count: 0" })).toBe(original);
  fireEvent.click(original);

  view.rerender(show("compare", "previous"));
  expect(screen.getByRole("button", { name: "Original count: 1" })).toBe(original);
  expect(screen.getByRole("button", { name: "Working count: 1", hidden: true })).toBe(working);
  view.rerender(show("working"));
  expect(screen.getByTestId("word-surface-foreground")).toBe(foreground);
  expect(foreground.className).toBe(foregroundClasses);
  expect(screen.getByTestId("word-surface-paper-edge")).toHaveStyle("transform: translateX(-20px)");
  expect(screen.getByRole("button", { name: "Working count: 1" })).toBe(working);
  expect(originalMounted).toHaveBeenCalledTimes(1);
  expect(workingMounted).toHaveBeenCalledTimes(1);
});

it("uses the persistent version spine to request the first original view without loading another preview", () => {
  const onViewChange = vi.fn();
  const workingMounted = vi.fn();
  const originalMounted = vi.fn();
  const show = (view: "working" | "original" | "compare", originalKept: boolean) => <WordSurface
    view={view}
    onViewChange={onViewChange}
    originalLabel="Opening original manuscript"
    workingLabel="Current working manuscript"
    working={<Counter name="Working count" mounted={workingMounted} />}
    original={originalKept ? <Counter name="Original count" mounted={originalMounted} /> : null}
  />;
  const rendered = render(show("working", false));
  const spine = screen.getByTestId("word-surface-version-spine");
  const working = screen.getByRole("button", { name: "Working count: 0" });
  fireEvent.click(working);
  expect(originalMounted).not.toHaveBeenCalled();
  fireEvent.click(within(spine).getByRole("button", { name: "Opening original manuscript" }));
  expect(onViewChange).toHaveBeenLastCalledWith("original");
  expect(originalMounted).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Working count: 1" })).toBe(working);

  rendered.rerender(show("original", true));
  expect(originalMounted).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Working count: 1", hidden: true })).toBe(working);
  expect(within(spine).getByRole("button", { name: "Opening original manuscript", pressed: true })).toBeVisible();
  fireEvent.click(within(spine).getByRole("button", { name: "Current working manuscript" }));
  expect(onViewChange).toHaveBeenLastCalledWith("working");
  rendered.rerender(show("working", true));
  expect(screen.getByRole("button", { name: "Working count: 1" })).toBe(working);
  expect(workingMounted).toHaveBeenCalledOnce();

  rendered.rerender(show("compare", true));
  onViewChange.mockClear();
  fireEvent.click(within(spine).getByRole("button", { name: "Opening original manuscript" }));
  expect(onViewChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("word-surface")).toHaveAttribute("data-view", "compare");
  expect(screen.getByRole("button", { name: "Original count: 0" })).toBeVisible();
  expect(screen.getByTestId("word-surface-paper-edge").children).toHaveLength(0);
});

it("uses public formatting commands in a compact toolbar", () => {
  render(<WordFormattingToolbar labels={labels} />);
  const toolbar = screen.getByTestId("word-formatting-toolbar");
  expect(toolbar).toHaveClass("flex-none");
  expect(within(toolbar).queryByRole("combobox", { name: "Font" })).not.toBeInTheDocument();

  fireEvent.click(within(toolbar).getByRole("button", { name: "Bold" }));
  fireEvent.click(within(toolbar).getByRole("button", { name: "More formatting" }));
  expect(within(toolbar).getByRole("combobox", { name: "Font" })).toHaveValue("Cambria");
  expect(within(toolbar).getByRole("combobox", { name: "Size" })).toHaveValue("22");

  fireEvent.change(within(toolbar).getByRole("combobox", { name: "Font" }), { target: { value: "Times New Roman" } });
  fireEvent.change(within(toolbar).getByRole("combobox", { name: "Size" }), { target: { value: "24" } });
  fireEvent.click(within(toolbar).getByRole("button", { name: "Align center" }));

  expect(command.execute).toHaveBeenCalledWith("text.bold");
  expect(fontFamily.setValue).toHaveBeenCalledWith("Times New Roman");
  expect(fontSize.execute).toHaveBeenCalledWith(24);
  expect(command.execute).toHaveBeenCalledWith("alignment.center");
});

it("portals toolbar chrome and disables history and formatting controls together", () => {
  const target = document.createElement("div");
  document.body.append(target);
  const view = render(<WordToolbarPortal target={target} labels={labels} disabled compact={false} />);
  const toolbar = within(target).getByTestId("word-formatting-toolbar");
  expect(toolbar).toHaveAttribute("aria-label", "Formatting");
  expect(within(toolbar).getByRole("button", { name: "Undo" })).toBeDisabled();
  expect(within(toolbar).getByRole("button", { name: "Redo" })).toBeDisabled();
  expect(within(toolbar).getByRole("button", { name: "Bold" })).toBeDisabled();
  expect(within(toolbar).getByRole("combobox", { name: "Font" })).toBeDisabled();
  expect(within(toolbar).getByRole("combobox", { name: "Size" })).toBeDisabled();

  view.rerender(<WordToolbarPortal target={target} labels={labels} compact={false} />);
  fireEvent.click(within(target).getByRole("button", { name: "Undo" }));
  expect(command.execute).toHaveBeenCalledWith("history.undo");
  view.unmount();
  target.remove();
});

it("represents mixed formatting and preserves a custom font size", () => {
  fontFamily.value = null;
  fontSize.value = 23;
  const view = render(<WordFormattingToolbar labels={labels} compact={false} />);

  const family = screen.getByRole("combobox", { name: "Font" });
  const size = screen.getByRole("combobox", { name: "Size" });
  expect(family).toHaveValue("");
  expect(size).toHaveValue("23");
  expect(within(family).getByRole("option", { name: "Mixed" })).toBeDisabled();
  expect(within(size).getByRole("option", { name: "11.5" })).toBeInTheDocument();

  fireEvent.change(family, { target: { value: "Times New Roman" } });
  expect(fontFamily.setValue).toHaveBeenCalledWith("Times New Roman");

  fontSize.value = null;
  view.rerender(<WordFormattingToolbar labels={labels} compact={false} />);
  expect(screen.getByRole("combobox", { name: "Size" })).toHaveValue("");
  expect(
    within(screen.getByRole("combobox", { name: "Size" })).getByRole(
      "option",
      { name: "Mixed" },
    ),
  ).toBeDisabled();

  view.unmount();
  const emptyPortal = render(<WordToolbarPortal target={null} labels={labels} />);
  expect(emptyPortal.container).toBeEmptyDOMElement();
  fontFamily.value = "Cambria";
  fontSize.value = 22;
});

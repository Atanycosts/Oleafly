// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/editor.json";
import { DocxMaterialTools } from "./DocxMaterialTools";

function callbacks() {
  return { onViewChange: vi.fn(), onAnnotateWhole: vi.fn(async () => {}), onAnnotateSelection: vi.fn(async () => {}) };
}

it("requires a selection for selection feedback and preserves focus when either annotation action is pressed", async () => {
  const actions = callbacks();
  const rendered = render(<DocxMaterialTools view="working" selectionAvailable={false} {...actions} />);
  const selected = screen.getByRole("button", { name: en.materials.annotateSelection });
  const whole = screen.getByRole("button", { name: en.materials.annotateWhole });
  expect(selected).toBeDisabled();
  expect(selected).toHaveAttribute("title", en.materials.selectionMissing);
  expect(fireEvent.mouseDown(whole)).toBe(false);
  await act(async () => fireEvent.click(whole));
  expect(actions.onAnnotateWhole).toHaveBeenCalledOnce();
  expect(actions.onAnnotateSelection).not.toHaveBeenCalled();
  rendered.rerender(<DocxMaterialTools view="working" selectionAvailable {...actions} />);
  expect(selected).toBeEnabled();
  expect(selected).not.toHaveAttribute("title");
  expect(fireEvent.mouseDown(selected)).toBe(false);
  await act(async () => fireEvent.click(selected));
  expect(actions.onAnnotateSelection).toHaveBeenCalledOnce();
  rendered.rerender(<DocxMaterialTools view="working" selectionAvailable disabled {...actions} />);
  expect(whole).toBeDisabled();
  expect(selected).toBeDisabled();
});

it("blocks duplicate captures until completion and recovers after a visible capture failure", async () => {
  let rejectCapture: (error: Error) => void = () => {};
  const actions = callbacks();
  actions.onAnnotateWhole.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectCapture = reject; }));
  render(<DocxMaterialTools view="working" selectionAvailable {...actions} />);
  const whole = screen.getByRole("button", { name: en.materials.annotateWhole });
  const selected = screen.getByRole("button", { name: en.materials.annotateSelection });
  fireEvent.click(whole);
  expect(whole).toBeDisabled();
  expect(selected).toBeDisabled();
  fireEvent.click(whole);
  fireEvent.click(selected);
  expect(actions.onAnnotateWhole).toHaveBeenCalledOnce();
  expect(actions.onAnnotateSelection).not.toHaveBeenCalled();
  await act(async () => rejectCapture(new Error("The document changed during capture")));
  expect(screen.getByRole("alert")).toHaveTextContent("The document changed during capture");
  expect(whole).toBeEnabled();
  expect(selected).toBeEnabled();
  await act(async () => fireEvent.click(selected));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(actions.onAnnotateSelection).toHaveBeenCalledOnce();
});

it("reports a rejected non-Error value without leaving capture controls disabled", async () => {
  const actions = callbacks();
  actions.onAnnotateSelection.mockRejectedValueOnce("Source is no longer available");
  render(<DocxMaterialTools view="original" selectionAvailable {...actions} />);
  const selected = screen.getByRole("button", { name: en.materials.annotateSelection });
  await act(async () => fireEvent.click(selected));
  expect(screen.getByRole("alert")).toHaveTextContent("Source is no longer available");
  expect(selected).toBeEnabled();
});

it("requests the chosen retained version view without starting an annotation capture", () => {
  const actions = callbacks();
  const rendered = render(<DocxMaterialTools view="working" selectionAvailable {...actions} />);
  const display = screen.getByRole("combobox", { name: en.materials.viewMode });
  expect(display).toHaveTextContent(en.materials.docxWorking);
  fireEvent.keyDown(display, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: en.materials.docxOriginal }));
  expect(actions.onViewChange).toHaveBeenLastCalledWith("original");
  rendered.rerender(<DocxMaterialTools view="original" selectionAvailable {...actions} />);
  fireEvent.keyDown(display, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: en.materials.docxCompare }));
  expect(actions.onViewChange).toHaveBeenLastCalledWith("compare");
  expect(actions.onAnnotateWhole).not.toHaveBeenCalled();
  expect(actions.onAnnotateSelection).not.toHaveBeenCalled();
});

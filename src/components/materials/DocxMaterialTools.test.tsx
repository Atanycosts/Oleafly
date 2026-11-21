// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/editor.json";
import { DocxMaterialTools } from "./DocxMaterialTools";

function callbacks() {
  return { onViewChange: vi.fn(), onAnnotateWhole: vi.fn(async () => {}) };
}

it("keeps whole-document annotation in the material tools without a fixed selection action", async () => {
  const actions = callbacks();
  const rendered = render(<DocxMaterialTools view="working" {...actions} />);
  const whole = screen.getByRole("button", { name: en.materials.annotateWhole });
  expect(screen.queryByRole("button", { name: en.materials.annotateSelection })).not.toBeInTheDocument();
  expect(fireEvent.mouseDown(whole)).toBe(false);
  await act(async () => fireEvent.click(whole));
  expect(actions.onAnnotateWhole).toHaveBeenCalledOnce();
  rendered.rerender(<DocxMaterialTools view="working" disabled {...actions} />);
  expect(whole).toBeDisabled();
});

it("blocks duplicate captures until completion and recovers after a visible capture failure", async () => {
  let rejectCapture: (error: Error) => void = () => {};
  const actions = callbacks();
  actions.onAnnotateWhole.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectCapture = reject; }));
  render(<DocxMaterialTools view="working" {...actions} />);
  const whole = screen.getByRole("button", { name: en.materials.annotateWhole });
  fireEvent.click(whole);
  expect(whole).toBeDisabled();
  fireEvent.click(whole);
  expect(actions.onAnnotateWhole).toHaveBeenCalledOnce();
  await act(async () => rejectCapture(new Error("The document changed during capture")));
  expect(screen.getByRole("alert")).toHaveTextContent("The document changed during capture");
  expect(whole).toBeEnabled();
  await act(async () => fireEvent.click(whole));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(actions.onAnnotateWhole).toHaveBeenCalledTimes(2);
});

it("reports a rejected non-Error value without leaving capture controls disabled", async () => {
  const actions = callbacks();
  actions.onAnnotateWhole.mockRejectedValueOnce("Source is no longer available");
  render(<DocxMaterialTools view="original" {...actions} />);
  const whole = screen.getByRole("button", { name: en.materials.annotateWhole });
  await act(async () => fireEvent.click(whole));
  expect(screen.getByRole("alert")).toHaveTextContent("Source is no longer available");
  expect(whole).toBeEnabled();
});

it("requests the chosen retained version view without starting an annotation capture", () => {
  const actions = callbacks();
  const rendered = render(<DocxMaterialTools view="working" {...actions} />);
  const display = screen.getByRole("combobox", { name: en.materials.viewMode });
  expect(display).toHaveTextContent(en.materials.docxWorking);
  fireEvent.keyDown(display, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: en.materials.docxOriginal }));
  expect(actions.onViewChange).toHaveBeenLastCalledWith("original");
  rendered.rerender(<DocxMaterialTools view="original" {...actions} />);
  fireEvent.keyDown(display, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: en.materials.docxCompare }));
  expect(actions.onViewChange).toHaveBeenLastCalledWith("compare");
  expect(actions.onAnnotateWhole).not.toHaveBeenCalled();
});

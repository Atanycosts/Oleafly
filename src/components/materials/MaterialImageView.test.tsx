// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { MaterialDocument } from "@/lib/material-surface";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import { MaterialImageView } from "./MaterialImageView";
import en from "@/i18n/locales/en/editor.json";
const document: MaterialDocument = { projectId: "p", documentId: "file:figure.png", path: "figure.png", kind: "image", title: "figure", revision: "exact", source: { bytes: new Uint8Array([1]) } };
it("normalizes a drag against the actual displayed image box and preserves its revision", () => {
  render(<MaterialImageView document={document} src="data:image/png;base64,AA==" />);
  const img = screen.getByRole("img");
  img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON() {} });
  const wrapper = img.parentElement!;
  wrapper.setPointerCapture = () => {};
  fireEvent.click(screen.getByRole("button", { name: en.materials.imageRegion }));
  fireEvent.pointerDown(wrapper, { clientX: 140, clientY: 70, pointerId: 1 });
  fireEvent.pointerMove(wrapper, { clientX: 300, clientY: 170, pointerId: 1 });
  fireEvent.pointerUp(wrapper, { pointerId: 1 });
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateSelection }));
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document, anchor: { kind: "region", rect: { x: .1, y: .1, width: .4, height: .5 } } });
});


it("restores the retained image region against the same image box", () => {
  render(<MaterialImageView document={document} src="data:image/png;base64,AA==" anchor={{ kind: "region", rect: { x: .2, y: .3, width: .4, height: .5 } }} />);
  expect(screen.getByTestId("material-image-region")).toHaveStyle({ left: "20%", top: "30%", width: "40%", height: "50%" });
});

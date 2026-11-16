// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PdfViewerHandle } from "@/components/pdf/PdfViewer";
import type { MaterialDocument } from "@/lib/material-surface";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import en from "@/i18n/locales/en/editor.json";
import { MaterialPdfActions } from "./MaterialPdfView";
vi.mock("@/components/pdf/PdfViewer", () => ({ PdfViewer: () => null }));
const document: MaterialDocument = { projectId: "p", documentId: "file:a.pdf", path: "a.pdf", kind: "pdf", title: "a", revision: "frozen-hash", source: { bytes: new Uint8Array([1]) } };
it("retains all selected PDF pages, normalized rectangles and rotation against the captured version", () => {
  const selection = { documentIdentity: "doc", text: "two pages", rotation: 90 as const, pages: [{ page: 2, rects: [{ x: .1, y: .2, width: .3, height: .4 }] }, { page: 3, rects: [] }] };
  const viewer = createRef<PdfViewerHandle>();
  viewer.current = { getTextSelection: () => selection } as PdfViewerHandle;
  render(<MaterialPdfActions document={document} viewer={viewer} page={3} />);
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateSelection }));
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document, anchor: { kind: "pdf", pages: selection.pages, quote: "two pages", rotation: 90 } });
});
it("opens whole material and current page without requiring text", () => {
  const viewer = createRef<PdfViewerHandle>();
  render(<MaterialPdfActions document={document} viewer={viewer} page={7} />);
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotatePage }));
  expect(useMaterialAnnotationsStore.getState().anchor).toEqual({ kind: "page", page: 7, rects: [] });
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateWhole }));
  expect(useMaterialAnnotationsStore.getState().anchor).toEqual({ kind: "whole" });
});

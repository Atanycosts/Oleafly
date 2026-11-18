// @vitest-environment jsdom
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PdfViewerHandle } from "@/components/pdf/PdfViewer";
import type { MaterialDocument } from "@/lib/material-surface";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import en from "@/i18n/locales/en/editor.json";
import { MaterialViewContext } from "./MaterialViewContext";
import { MaterialPdfActions, MaterialPdfSelection, MaterialPdfView } from "./MaterialPdfView";
const pdfViewer = vi.hoisted(() => ({ props: null as null | {
  documentIdentity: string;
  rotation: number;
  onLoadStateChange: (state: { status: string }) => void;
  onPageChange: (page: number) => void;
} }));
vi.mock("@/components/pdf/PdfViewer", () => ({
  PdfViewer: (props: NonNullable<typeof pdfViewer.props>) => {
    pdfViewer.props = props;
    return <div data-testid="pdf-viewer" data-document-identity={props.documentIdentity} data-rotation={props.rotation} />;
  },
}));
const document: MaterialDocument = { projectId: "p", documentId: "file:a.pdf", path: "a.pdf", kind: "pdf", title: "a", revision: "frozen-hash", source: { bytes: new Uint8Array([1]) } };
beforeEach(() => useAgentWorkspaceStore.setState({ views: {} }));
it("reports a missing text selection without opening an annotation", () => {
  const viewer = createRef<PdfViewerHandle>();
  render(<MaterialPdfActions document={document} viewer={viewer} page={3} />);
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateSelection }));
  expect(screen.getByRole("status")).toHaveTextContent(en.materials.selectionMissing);
  expect(useMaterialAnnotationsStore.getState().document).toBeNull();
});
it("retains all selected PDF pages, normalized rectangles and rotation against the captured version", () => {
  const selection = { documentIdentity: "doc", text: "two pages", rotation: 90 as const, pages: [{ page: 2, rects: [{ x: .1, y: .2, width: .3, height: .4 }] }, { page: 3, rects: [] }] };
  const viewer = createRef<PdfViewerHandle>();
  viewer.current = { getTextSelection: () => selection } as unknown as PdfViewerHandle;
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
it("publishes a captured PDF selection and falls back to the current page when capture is unavailable", () => {
  const selection = { documentIdentity: "doc", text: "selected", rotation: 180 as const, pages: [{ page: 2, rects: [] }] };
  const viewer = createRef<PdfViewerHandle>();
  viewer.current = { getTextSelection: () => selection } as unknown as PdfViewerHandle;
  const view = render(<MaterialViewContext document={document} active materialRole="result"><MaterialPdfSelection viewer={viewer} page={2}><span>PDF</span></MaterialPdfSelection></MaterialViewContext>);
  const selectionRoot = view.container.querySelectorAll(".contents").item(1);
  if (!(selectionRoot instanceof Element)) throw new Error("The material selection surface did not render.");
  fireEvent.mouseUp(selectionRoot);
  expect(useAgentWorkspaceStore.getState().views.p.selection?.anchor).toMatchObject({ kind: "pdf", quote: "selected", rotation: 180 });
  view.rerender(<MaterialViewContext document={document} active materialRole="result"><MaterialPdfSelection viewer={createRef<PdfViewerHandle>()} page={3}><span>PDF</span></MaterialPdfSelection></MaterialViewContext>);
  const fallbackRoot = view.container.querySelectorAll(".contents").item(1);
  if (!(fallbackRoot instanceof Element)) throw new Error("The material selection surface did not render.");
  fireEvent.mouseUp(fallbackRoot);
  expect(useAgentWorkspaceStore.getState().views.p.selection?.anchor).toEqual({ kind: "page", page: 3, rects: [] });
});
it("passes the exact material identity and retained PDF rotation to the viewer", () => {
  const onPageChange = vi.fn();
  const view = render(<MaterialPdfView document={document} bytes={new Uint8Array([1])} onPageChange={onPageChange} />);
  expect(screen.getByTestId("pdf-viewer")).toHaveAttribute("data-document-identity", "file:a.pdf:frozen-hash");
  expect(screen.getByTestId("pdf-viewer")).toHaveAttribute("data-rotation", "0");
  const surface = view.container.firstElementChild;
  if (!(surface instanceof Element)) throw new Error("The material PDF surface did not render.");
  fireEvent.mouseUp(surface);
  if (!pdfViewer.props) throw new Error("The PDF viewer did not receive its runtime handlers.");
  act(() => pdfViewer.props?.onLoadStateChange({ status: "loading" }));
  act(() => pdfViewer.props?.onLoadStateChange({ status: "ready" }));
  act(() => pdfViewer.props?.onPageChange(4));
  expect(onPageChange).toHaveBeenCalledWith(4);
  view.rerender(<MaterialPdfView document={document} bytes={new Uint8Array([1])} anchor={{ kind: "pdf", pages: [], quote: "retained", rotation: 270 }} />);
  expect(screen.getByTestId("pdf-viewer")).toHaveAttribute("data-rotation", "270");
  if (!pdfViewer.props) throw new Error("The PDF viewer did not retain its runtime handlers.");
  act(() => pdfViewer.props?.onPageChange(5));
  expect(onPageChange).toHaveBeenCalledOnce();
});

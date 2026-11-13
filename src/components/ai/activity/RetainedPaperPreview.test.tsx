// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import enAi from "@/i18n/locales/en/ai.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ read: vi.fn(), gotoPage: vi.fn(), props: null as Record<string, unknown> | null }));
vi.mock("@/lib/research-literature", () => ({ readRetainedPaperPdf: mocks.read }));
vi.mock("@/components/pdf/PdfViewer", async () => {
  const React = await import("react");
  return { PdfViewer: React.forwardRef((props: Record<string, unknown>, ref) => {
    mocks.props = props;
    React.useImperativeHandle(ref, () => ({ gotoPage: mocks.gotoPage }));
    return <button type="button" onClick={() => (props.onLoadStateChange as (state: unknown) => void)({ status: "ready" })}>{"PDF ready"}</button>;
  }) };
});
import { RetainedPaperPreview } from "./RetainedPaperPreview";
const reference = { projectId: "original-project", path: "sources/papers/a.pdf", pdfSha256: "original-hash" };
beforeEach(() => { mocks.read.mockReset(); mocks.gotoPage.mockReset(); mocks.props = null; });

it("loads only after clicking, retains original project/hash and jumps to the actual read page", async () => {
  mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  render(<RetainedPaperPreview reference={reference} pageStart={3} pageEnd={4} pageCount={12} />);
  expect(mocks.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: enAi.paperReader.openPdf }));
  await screen.findByRole("button", { name: "PDF ready" });
  expect(mocks.read).toHaveBeenCalledWith(reference);
  expect(screen.getByText("PDF SHA-256: original-hash")).toBeInTheDocument();
  expect(screen.getByText("Read pages 3 to 4 of 12")).toBeInTheDocument();
  expect(mocks.props?.documentIdentity).toBe("paper:original-project:original-hash");
  expect(mocks.props?.registerGlobalController).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "PDF ready" }));
  expect(mocks.gotoPage).toHaveBeenCalledWith(3);
});

it.each(["PDF hash mismatch", "Retained PDF is missing"])("shows exact read failures without rendering a different PDF: %s", async (message) => {
  mocks.read.mockRejectedValue(new Error(message));
  render(<RetainedPaperPreview reference={reference} />);
  fireEvent.click(screen.getByRole("button", { name: enAi.paperReader.openPdf }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("button", { name: "PDF ready" })).toBeNull();
});

it("discards an in-flight previous reference when the identity changes", async () => {
  let resolveOld!: (value: ArrayBuffer) => void;
  mocks.read.mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { resolveOld = resolve; }));
  mocks.read.mockResolvedValueOnce(new Uint8Array([9]).buffer);
  const { rerender } = render(<RetainedPaperPreview reference={reference} />);
  fireEvent.click(screen.getByRole("button", { name: enAi.paperReader.openPdf }));
  const next = { ...reference, projectId: "second-project", pdfSha256: "second-hash" };
  rerender(<RetainedPaperPreview reference={next} />);
  await screen.findByRole("button", { name: "PDF ready" });
  resolveOld(new Uint8Array([1]).buffer);
  await waitFor(() => expect(mocks.props?.documentIdentity).toBe("paper:second-project:second-hash"));
  expect(mocks.props?.data).toEqual(new Uint8Array([9]));
});

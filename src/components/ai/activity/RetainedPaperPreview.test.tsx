// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import enAi from "@/i18n/locales/en/ai.json" with { type: "json" };
const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/research-literature", () => ({ readRetainedPaperPdf: mocks.read }));
vi.mock("@/store/material-viewer", () => ({ useMaterialViewerStore: { getState: () => ({ open: mocks.open }) } }));
import { RetainedPaperPreview } from "./RetainedPaperPreview";
const reference = { projectId: "original-project", path: "sources/papers/a.pdf", pdfSha256: "original-hash" };
beforeEach(() => { mocks.read.mockReset(); mocks.open.mockReset(); });
it("opens a lazily verified retained PDF in the center with the original identity and page", async () => {
  mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  render(<RetainedPaperPreview reference={reference} pageStart={3} />);
  expect(mocks.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: enAi.paperReader.openPdf }));
  const request = mocks.open.mock.calls[0][0];
  expect(request).toMatchObject({ projectId: reference.projectId, documentId: `paper:${reference.path}`, revision: reference.pdfSha256, initialPage: 3, kind: "pdf" });
  expect(await request.load()).toEqual(new Uint8Array([1, 2, 3]));
  expect(mocks.read).toHaveBeenCalledWith(reference);
});

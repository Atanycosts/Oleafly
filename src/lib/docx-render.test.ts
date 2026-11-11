import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxRender } from "./docx-render";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/journal-workbench", () => ({
  journalRequest: mocks.request,
  journalQuery: (path: string, query: Record<string, string>) => `${path}?${new URLSearchParams(query)}`,
}));
import { ensureDocxRender, loadDocxPdf } from "./docx-render";

const render: DocxRender = {
  bundle_id: "render-exact", baseline_id: "baseline-saved", registered_at: "2026-11-11T00:00:00Z",
  manifest: {
    source_sha256: "source", pdf_sha256: "pdf", page_count: 3,
    render_record: { renderer_engine: "LibreOffice", renderer_version: "26.8", renderer_path: "/opt/soffice" },
  },
};
beforeEach(() => { vi.clearAllMocks(); });
describe("DOCX saved-version PDF", () => {
  it("recovers a committed PDF on retry before running another converter", async () => {
    mocks.request.mockResolvedValue({ derived_renders: [render] });
    expect(await ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).toBe(render);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith("/api/derived-renders?project_id=paper&baseline_id=baseline-saved");
  });
  it("renders only the selected baseline and does not silently switch engines", async () => {
    mocks.request.mockResolvedValue({ derived_renders: [] });
    mocks.invoke.mockRejectedValueOnce(new Error("LibreOffice conversion failed"));
    await expect(ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).rejects.toThrow("conversion failed");
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("journal_docx_render", { projectId: "paper", baselineId: "baseline-saved", executable: "/opt/soffice" });
  });
  it("refuses a completion for a different baseline", async () => {
    mocks.request.mockResolvedValue({ derived_renders: [] });
    mocks.invoke.mockResolvedValue({ ...render, baseline_id: "unrelated" });
    await expect(ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).rejects.toThrow("selected saved DOCX version");
  });
  it("reads the exact retained bundle as binary data", async () => {
    mocks.invoke.mockResolvedValue(Uint8Array.from([37, 80, 68, 70]).buffer);
    expect(await loadDocxPdf("paper", render)).toEqual(Uint8Array.from([37, 80, 68, 70]));
    expect(mocks.invoke).toHaveBeenCalledWith("journal_docx_pdf", { projectId: "paper", baselineId: "baseline-saved", bundleId: "render-exact" });
  });
});

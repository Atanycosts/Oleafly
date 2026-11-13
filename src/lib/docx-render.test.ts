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
    render_record: {
      report_version: "libreoffice-headless-1.1.0",
      renderer_engine: "LibreOffice",
      renderer_version: "26.8",
      renderer_path: "/opt/soffice",
      font_cache_sha256: "cache-current",
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.request.mockResolvedValue({ derived_renders: [], font_cache_sha256: "cache-current" });
});
describe("DOCX saved-version PDF", () => {
  it("recovers a committed PDF on retry before running another converter", async () => {
    mocks.request.mockResolvedValue({ derived_renders: [render], font_cache_sha256: "cache-current" });
    expect(await ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).toBe(render);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith("/api/derived-renders?project_id=paper&baseline_id=baseline-saved");
  });
  it("uses the latest compatible record in commit order", async () => {
    const earlier = { ...render, bundle_id: "render-earlier" };
    mocks.request.mockResolvedValue({ derived_renders: [earlier, render], font_cache_sha256: "cache-current" });

    expect(await ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).toBe(render);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("does not reuse a legacy 1.0 report", async () => {
    const legacy = {
      ...render,
      manifest: {
        ...render.manifest,
        render_record: { ...render.manifest.render_record, report_version: "libreoffice-headless-1.0.0" },
      },
    };
    mocks.request.mockResolvedValue({ derived_renders: [legacy], font_cache_sha256: "cache-current" });
    mocks.invoke.mockResolvedValue(render);

    expect(await ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).toBe(render);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
  it("force bypasses compatible records and starts a conversion", async () => {
    mocks.request.mockResolvedValue({ derived_renders: [render] });
    mocks.invoke.mockResolvedValue(render);

    expect(await ensureDocxRender("paper", "baseline-saved", "/opt/soffice", true)).toBe(render);
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("journal_docx_render", {
      projectId: "paper",
      baselineId: "baseline-saved",
      executable: "/opt/soffice",
    });
  });
  it("regenerates after a font-cache change even when a prior forced conversion failed", async () => {
    mocks.request.mockResolvedValue({ derived_renders: [render], font_cache_sha256: "cache-new" });
    mocks.invoke.mockRejectedValueOnce(new Error("Conversion failed"));
    await expect(ensureDocxRender("paper", "baseline-saved", "/opt/soffice", true)).rejects.toThrow("Conversion failed");
    const replacement = { ...render, bundle_id: "render-new-font-cache" };
    mocks.invoke.mockResolvedValueOnce(replacement);
    expect(await ensureDocxRender("paper", "baseline-saved", "/opt/soffice")).toBe(replacement);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
  it("shares an in-flight conversion across close and reopen for the same font cache", async () => {
    let finish!: (value: DocxRender) => void;
    mocks.invoke.mockReturnValueOnce(new Promise<DocxRender>((resolve) => { finish = resolve; }));
    const first = ensureDocxRender("paper", "baseline-saved", "/opt/soffice");
    const reopened = ensureDocxRender("paper", "baseline-saved", "/opt/soffice");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    finish(render);
    expect(await first).toBe(render);
    expect(await reopened).toBe(render);
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

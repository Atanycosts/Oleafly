// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxRender } from "@/lib/docx-render";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), find: vi.fn(), pdf: vi.fn() }));
vi.mock("@/lib/docx-render", () => ({ ensureDocxRender: mocks.ensure, findDocxRenderer: mocks.find, loadDocxPdf: mocks.pdf }));
vi.mock("@/components/pdf/PdfViewer", () => ({ PdfViewer: ({ documentIdentity }: { documentIdentity: string }) => <output data-testid="render-pdf">{documentIdentity}</output> }));
import { DocxRenderPanel } from "./DocxRenderPanel";

const text = en.docx.render;
const record = (baseline = "baseline-1", bundleId = `render-${baseline}`): DocxRender => ({
  bundle_id: bundleId, baseline_id: baseline, registered_at: "2026-11-11T00:00:00Z",
  manifest: {
    source_sha256: "source", pdf_sha256: "pdf", page_count: 3,
    render_record: {
      report_version: "libreoffice-headless-1.2.0",
      renderer_engine: "LibreOffice",
      renderer_version: "26.8",
      renderer_path: "/opt/soffice",
    },
  },
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (baseline = "baseline-1", dirty = false, fontRevision = 0, fontsReady = true) => <QueryClientProvider client={client}><DocxRenderPanel projectId="paper" baselineId={baseline} dirty={dirty} fontRevision={fontRevision} fontsReady={fontsReady} /></QueryClientProvider>;
  const rendered = render(view());
  return { ...rendered, update: (baseline: string, dirty: boolean, fontRevision = 0) => rendered.rerender(view(baseline, dirty, fontRevision)) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue("/opt/soffice");
  mocks.ensure.mockImplementation(async (_project: string, baseline: string) => record(baseline));
  mocks.pdf.mockResolvedValue(Uint8Array.from([37, 80, 68, 70]));
});
describe("saved DOCX render panel", () => {
  it("waits for a visible PDF or tools request and retains the previous result while inactive", async () => {
    const onPreview = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (enabled: boolean, baselineId = "baseline-1") => <QueryClientProvider client={client}>
      <DocxRenderPanel projectId="paper" baselineId={baselineId} dirty={false} enabled={enabled} onPreview={onPreview} />
    </QueryClientProvider>;
    const panel = render(view(false));
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();

    panel.rerender(view(true));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      render: record(), bytes: Uint8Array.from([37, 80, 68, 70]), loading: false, stale: false,
    })));
    expect(mocks.find).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.pdf).toHaveBeenCalledTimes(1);

    panel.rerender(view(false, "baseline-2"));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      render: record(), bytes: Uint8Array.from([37, 80, 68, 70]), stale: true,
    })));
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.pdf).toHaveBeenCalledTimes(1);

    panel.rerender(view(true, "baseline-2"));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      render: record("baseline-2"), loading: false, stale: false,
    })));
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(mocks.pdf).toHaveBeenCalledTimes(2);
  });
  it("waits until native font resolution has supplied its bytes before converting", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (fontsReady: boolean) => <QueryClientProvider client={client}><DocxRenderPanel projectId="paper" baselineId="baseline-1" dirty={false} fontsReady={fontsReady} /></QueryClientProvider>;
    const panel = render(view(false));
    await waitFor(() => expect(mocks.find).toHaveBeenCalled());
    expect(mocks.ensure).not.toHaveBeenCalled();
    panel.rerender(view(true));
    await waitFor(() => expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.current));
    expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith("paper", "baseline-1", "/opt/soffice", false);
  });
  it("keeps the old PDF identified while rendering the next saved version and while typing", async () => {
    const panel = mount();
    await waitFor(() => expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.current));
    let finish!: (result: DocxRender) => void;
    mocks.ensure.mockReturnValueOnce(new Promise<DocxRender>((resolve) => { finish = resolve; }));
    panel.update("baseline-2", false);
    await waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith("paper", "baseline-2", "/opt/soffice", false));
    expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.stale);
    await act(async () => finish(record("baseline-2")));
    await waitFor(() => expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.current));
    panel.update("baseline-2", true);
    expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.stale);
  });
  it("publishes the embedded preview to the central workspace without a PDF dialog", async () => {
    const onPreview = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>
      <DocxRenderPanel projectId="paper" baselineId="baseline-1" dirty={false} onPreview={onPreview} />
    </QueryClientProvider>);
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: "paper",
      render: record(),
      bytes: Uint8Array.from([37, 80, 68, 70]),
      loading: false,
      error: null,
      stale: false,
    })));
    expect(mocks.pdf).toHaveBeenCalledWith("paper", record());
    expect(screen.queryByRole("button", { name: text.open })).not.toBeInTheDocument();
    expect(screen.queryByText("/opt/soffice")).not.toBeInTheDocument();
    expect(screen.queryByText("baseline-1")).not.toBeInTheDocument();
    const close = onPreview.mock.lastCall?.[0].close as (() => void) | undefined;
    act(() => close?.());
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(null));
  });
  it("forces a replacement render when the font revision changes", async () => {
    const panel = mount();
    await waitFor(() => expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.current));
    let finish!: (result: DocxRender) => void;
    mocks.ensure.mockReturnValueOnce(new Promise<DocxRender>((resolve) => { finish = resolve; }));

    panel.update("baseline-1", false, 1);

    await waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith("paper", "baseline-1", "/opt/soffice", true));
    expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.stale);
    await act(async () => finish(record("baseline-1", "render-after-font-refresh")));
    await waitFor(() => expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.current));
  });
  it("retains the old preview after failure and retries the explicit new version", async () => {
    const panel = mount();
    await waitFor(() => expect(screen.getByRole("button", { name: text.open })).toBeEnabled());
    mocks.ensure.mockRejectedValueOnce(new Error("Conversion failed"));
    panel.update("baseline-2", false);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      en.workspace.docxRender.renderFailed,
    ));
    expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.stale);
    fireEvent.click(screen.getByRole("button", { name: text.open }));
    await waitFor(() => expect(screen.getByTestId("render-pdf")).toHaveTextContent("render-baseline-1"));
    expect(mocks.pdf).toHaveBeenCalledWith("paper", record());
    fireEvent.click(screen.getByRole("button", { name: "Close PDF preview" }));
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    await waitFor(() => expect(mocks.ensure).toHaveBeenLastCalledWith("paper", "baseline-2", "/opt/soffice", true));
    await waitFor(() => expect(screen.getByTestId("docx-render-state")).toHaveTextContent(text.current));
  });
  it("reports missing capability without starting a conversion", async () => {
    mocks.find.mockResolvedValue(null);
    mount();
    await waitFor(() => expect(screen.getByText(/Install LibreOffice/)).toBeVisible());
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});

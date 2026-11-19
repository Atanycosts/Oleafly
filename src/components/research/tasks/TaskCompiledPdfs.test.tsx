// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { pdfPageToPng } from "@/lib/pdf-image";
import { extractPdfText } from "@/lib/pdf-text";
import type { TaskCompiledArtifact } from "@/lib/research-tasks";
import { TaskCompiledPdfs } from "./TaskCompiledPdfs";

const invoke = vi.hoisted(() => vi.fn());
const viewer = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/store/material-viewer", () => ({ useMaterialViewerStore: { getState: () => viewer } }));
vi.mock("@/store/research-tasks", () => ({ useResearchTasksStore: (selector: (state: unknown) => unknown) => selector({ tasks: [{ id: "task-a", projectId: "paper" }] }) }));
vi.mock("@/store/files", () => ({ useFilesStore: (selector: (state: unknown) => unknown) => selector({ projectId: "paper" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/pdf/PdfViewer", () => ({ PdfViewer: () => null }));
vi.mock("@/lib/pdf-text", () => ({ extractPdfText: vi.fn() }));
vi.mock("@/lib/pdf-image", () => ({ pdfPageToPng: vi.fn() }));
beforeEach(() => {
  invoke.mockReset();
  viewer.open.mockReset();
  vi.mocked(extractPdfText).mockReset();
  vi.mocked(pdfPageToPng).mockReset();
});

function artifact(mainDocument: string): TaskCompiledArtifact {
  return {
    taskId: "task-a",
    generation: 2,
    inputFingerprint: "input",
    sourceRevision: "source",
    outputId: null,
    pdfSha256: "0123456789abcdef",
    mainDocument,
    size: 1,
    path: `compiled-artifacts/${mainDocument}.pdf`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

it("queries the exact task generation and refreshes after the task finishes", async () => {
  invoke.mockResolvedValue([]);
  const view = render(<TaskCompiledPdfs taskId="task-a" generation={2} status="running" />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("research_task_compiled_pdfs", { taskId: "task-a", generation: 2 }));
  invoke.mockResolvedValue([{ taskId: "task-a", generation: 2, inputFingerprint: "input", pdfSha256: "0123456789abcdef", mainDocument: "main.tex", size: 42, path: "compiled.pdf" }]);
  view.rerender(<TaskCompiledPdfs taskId="task-a" generation={2} status="awaiting_review" />);
  expect(await screen.findByRole("button", { name: /main.tex/ })).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("reads a referenced historical PDF directly through the verified artifact reader", async () => {
  const reference = { taskId: "task-a", generation: 2, inputFingerprint: "input", sourceRevision: "source", outputId: "output", pdfSha256: "0123456789abcdef", mainDocument: "main.tex", size: 42, path: "compiled-artifacts/old.pdf" };
  invoke.mockResolvedValue(new ArrayBuffer(42));
  render(<TaskCompiledPdfs taskId="task-a" generation={2} status="awaiting_review" reference={reference} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("research_task_compiled_pdf_read", { taskId: "task-a", generation: 2, reference }));
  expect(invoke).not.toHaveBeenCalledWith("research_task_compiled_pdfs", expect.anything());
});

it.each(["current", "historical"] as const)("opens captured %s PDF bytes as a result and notifies its host", async (version) => {
  const reference = { taskId: "task-a", generation: 2, inputFingerprint: "input", sourceRevision: "source", outputId: "output", pdfSha256: "pdf-hash", mainDocument: "main.tex", size: 3, path: "compiled.pdf" };
  invoke.mockImplementation(async (command: string) => command === "research_task_compiled_pdfs" ? [reference] : new Uint8Array([1, 2, 3]).buffer);
  const close = vi.fn();
  render(<TaskCompiledPdfs taskId="task-a" generation={2} status="completed" reference={version === "historical" ? reference : undefined} onOpenInWorkspace={close} />);
  if (version === "current") fireEvent.click(await screen.findByRole("button", { name: /main.tex/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open in workspace" }));
  expect(viewer.open).toHaveBeenCalledWith(expect.objectContaining({ kind: "pdf", role: "result", revision: "pdf-hash", projectId: "paper" }));
  expect(await viewer.open.mock.calls.at(-1)?.[0].load()).toEqual(new Uint8Array([1, 2, 3]));
  expect(close).toHaveBeenCalledOnce();
});

it("keeps late text and raster results from appearing on another task PDF", async () => {
  const prior = artifact("draft.tex");
  const next = artifact("final.tex");
  const priorText = deferred<Awaited<ReturnType<typeof extractPdfText>>>();
  const priorImage = deferred<string>();
  const draftBytes = new Uint8Array([1]);
  const finalBytes = new Uint8Array([2]);
  invoke.mockImplementation(async (command: string, input: { reference?: TaskCompiledArtifact }) =>
    command === "research_task_compiled_pdfs" ? [prior, next]
      : input.reference?.path === prior.path ? draftBytes.buffer : finalBytes.buffer);
  vi.mocked(extractPdfText).mockReturnValueOnce(priorText.promise)
    .mockResolvedValueOnce({ pages: ["Current PDF content"], numPages: 1 });
  vi.mocked(pdfPageToPng).mockReturnValueOnce(priorImage.promise)
    .mockResolvedValueOnce("data:image/png;base64,YQ==");
  render(<TaskCompiledPdfs taskId="task-a" generation={2} status="completed" />);

  fireEvent.click(await screen.findByRole("button", { name: /draft\.tex/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Read PDF text" }));
  fireEvent.click(screen.getByRole("button", { name: "Render first page" }));
  fireEvent.click(screen.getByRole("button", { name: /final\.tex/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Read PDF text" }));
  fireEvent.click(screen.getByRole("button", { name: "Render first page" }));
  expect(await screen.findByText(/Current PDF content/)).toBeVisible();
  expect(await screen.findByRole("img", { name: "Task PDF first page" }))
    .toHaveAttribute("src", "data:image/png;base64,YQ==");
  expect(extractPdfText).toHaveBeenNthCalledWith(1, draftBytes);
  expect(extractPdfText).toHaveBeenNthCalledWith(2, finalBytes);

  await act(async () => {
    priorText.resolve({ pages: ["Stale draft content"], numPages: 1 });
    priorImage.reject(new Error("Stale raster failure"));
  });
  expect(screen.getByText(/Current PDF content/)).toBeVisible();
  expect(screen.queryByText(/Stale draft content/)).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reports list and verified read failures and clears the error when another PDF is selected", async () => {
  const draft = artifact("draft.tex");
  const final = artifact("final.tex");
  invoke.mockRejectedValueOnce(new Error("Could not load task outputs"))
    .mockResolvedValueOnce([draft, final])
    .mockRejectedValueOnce(new Error("Saved PDF bytes no longer match"))
    .mockResolvedValueOnce(new Uint8Array([2]).buffer);
  const view = render(<TaskCompiledPdfs taskId="task-a" generation={2} status="queued" />);
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(<TaskCompiledPdfs taskId="task-a" generation={2} status="running" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load task outputs");
  view.rerender(<TaskCompiledPdfs taskId="task-a" generation={2} status="completed" />);
  fireEvent.click(await screen.findByRole("button", { name: /draft\.tex/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Saved PDF bytes no longer match");
  expect(screen.queryByRole("button", { name: "Open in workspace" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /final\.tex/ }));
  expect(await screen.findByRole("button", { name: "Open in workspace" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

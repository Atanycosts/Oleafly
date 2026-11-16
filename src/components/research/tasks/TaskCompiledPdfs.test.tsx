// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
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
});

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

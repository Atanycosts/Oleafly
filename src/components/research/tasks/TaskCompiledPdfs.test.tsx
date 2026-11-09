// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TaskCompiledPdfs } from "./TaskCompiledPdfs";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/pdf/PdfViewer", () => ({ PdfViewer: () => null }));
vi.mock("@/lib/pdf-text", () => ({ extractPdfText: vi.fn() }));
vi.mock("@/lib/pdf-image", () => ({ pdfPageToPng: vi.fn() }));
beforeEach(() => invoke.mockReset());

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

// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RetainedPdfSelection } from "@/lib/pdf-selection";
const api = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/pdf-selection", () => ({ loadTaskPdfSelection: api.load }));
vi.mock("@/lib/research-tasks", () => ({ readTaskCompiledPdf: api.read }));
vi.mock("@/components/preview/PdfSelectionDocument", () => ({ PdfSelectionDocument: ({ input, bytes }: { input: { mainDocument: string }; bytes: Uint8Array | null }) => <div data-testid="retained">{input.mainDocument}:{bytes ? [...bytes].join(",") : "unloaded"}</div> }));
import { TaskPdfSelection } from "./TaskPdfSelection";
function retained(name: string): RetainedPdfSelection {
  return {
    annotationId: name, originalAnnotationId: `root-${name}`,
    input: { projectId: "paper", mainDocument: `${name}.tex`, checkpoint: null, pdfSha256: `hash-${name}`, size: 1,
      selection: { documentIdentity: name, text: `Selected ${name}`, pages: [{ page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }] }], rotation: 0 } },
    reference: { taskId: `task-${name}`, generation: 0, inputFingerprint: `input-${name}`, sourceRevision: `source-${name}`, outputId: null,
      pdfSha256: `hash-${name}`, size: 1, mainDocument: `${name}.tex`, path: `${name}.pdf` },
  };
}
beforeEach(() => { vi.clearAllMocks(); });
it("reads the task input at generation zero with its full retained reference", async () => {
  const input = retained("A"); api.load.mockResolvedValue(input); api.read.mockResolvedValue(new Uint8Array([7]).buffer);
  render(<TaskPdfSelection taskId="task-A" openOriginal />);
  await waitFor(() => expect(screen.getByTestId("retained")).toHaveTextContent("A.tex:7"));
  expect(api.read).toHaveBeenCalledWith("task-A", 0, input.reference);
});
it("ignores old original-PDF responses after changing tasks", async () => {
  let resolveOld!: (value: ArrayBuffer) => void;
  api.load.mockImplementation((id: string) => Promise.resolve(retained(id === "task-A" ? "A" : "B")));
  api.read.mockImplementation((id: string) => id === "task-A" ? new Promise<ArrayBuffer>((resolve) => { resolveOld = resolve; }) : Promise.resolve(new Uint8Array([2]).buffer));
  const view = render(<TaskPdfSelection taskId="task-A" openOriginal />);
  await waitFor(() => expect(api.read).toHaveBeenCalledWith("task-A", 0, retained("A").reference));
  view.rerender(<TaskPdfSelection taskId="task-B" openOriginal />);
  await waitFor(() => expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:2"));
  expect(api.read).not.toHaveBeenCalledWith("task-B", 0, retained("A").reference);
  await act(async () => { resolveOld(new Uint8Array([1]).buffer); });
  expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:2");
});
it("ignores an old task-input response after changing tasks", async () => {
  let resolveOld!: (value: RetainedPdfSelection) => void;
  api.load.mockImplementation((id: string) => id === "task-A" ? new Promise<RetainedPdfSelection>((resolve) => { resolveOld = resolve; }) : Promise.resolve(retained("B")));
  api.read.mockResolvedValue(new Uint8Array([2]).buffer);
  const view = render(<TaskPdfSelection taskId="task-A" openOriginal />);
  view.rerender(<TaskPdfSelection taskId="task-B" openOriginal />);
  await waitFor(() => expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:2"));
  await act(async () => { resolveOld(retained("A")); });
  expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:2");
  expect(api.read).not.toHaveBeenCalledWith("task-B", 0, retained("A").reference);
});

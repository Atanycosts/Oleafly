// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/preview.json";
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

it("keeps an unavailable original tied to its reference without eager reads or a stale error in the next task", async () => {
  const first = retained("A");
  const second = retained("B");
  api.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  let rejectFirst!: (cause: Error) => void;
  api.read.mockImplementationOnce(() => new Promise<ArrayBuffer>((_, reject) => { rejectFirst = reject; }))
    .mockRejectedValueOnce(new Error("Retained PDF B unavailable"));
  const view = render(<TaskPdfSelection taskId="task-A" />);
  expect(await screen.findByTestId("retained")).toHaveTextContent("A.tex:unloaded");
  expect(api.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: en.selection.openOriginal }));
  expect(api.read).toHaveBeenCalledExactlyOnceWith("task-A", 0, first.reference);

  view.rerender(<TaskPdfSelection taskId="task-B" openOriginal />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Retained PDF B unavailable");
  expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:unloaded");
  await act(async () => { rejectFirst(new Error("Obsolete PDF A error")); });
  expect(screen.getByRole("alert")).toHaveTextContent("Retained PDF B unavailable");
  expect(api.read).toHaveBeenLastCalledWith("task-B", 0, second.reference);
});

it("reports a failed task-input lookup without opening another task's PDF", async () => {
  api.load.mockRejectedValueOnce(new Error("Task input reference unavailable"));
  render(<TaskPdfSelection taskId="task-A" openOriginal />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Task input reference unavailable");
  expect(screen.queryByTestId("retained")).not.toBeInTheDocument();
  expect(api.read).not.toHaveBeenCalled();
});

it("ignores a failed task-input lookup after changing tasks", async () => {
  let rejectOld!: (cause: Error) => void;
  api.load.mockImplementation((id: string) => id === "task-A"
    ? new Promise<RetainedPdfSelection>((_, reject) => { rejectOld = reject; })
    : Promise.resolve(retained("B")));
  const view = render(<TaskPdfSelection taskId="task-A" openOriginal />);
  await waitFor(() => expect(api.load).toHaveBeenCalledWith("task-A"));

  view.rerender(<TaskPdfSelection taskId="task-B" openOriginal />);
  await waitFor(() => expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:2"));
  await act(async () => { rejectOld(new Error("Obsolete task A lookup failed")); });

  expect(screen.getByTestId("retained")).toHaveTextContent("B.tex:2");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

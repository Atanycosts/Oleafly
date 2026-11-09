// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/preview.json" with { type: "json" };
import type { FrozenPdfSelection } from "@/lib/pdf-selection";
import type { TaskAnnotation } from "@/lib/task-collaboration";
import type { ResearchTask } from "@/lib/research-tasks";
const api = vi.hoisted(() => ({ onSaved: null as null | ((annotation: TaskAnnotation) => void), explicit: null as null | ((body: string) => Promise<void>), capture: vi.fn(), save: vi.fn(), create: vi.fn(), start: vi.fn(), list: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/assistant-delegation-capture", () => ({ captureAssistantTarget: api.capture }));
vi.mock("@/lib/pdf-selection", () => ({ savePdfSelection: api.save, createPdfReviewTask: api.create, startPdfReviewTask: api.start, listPdfSelections: api.list, readPdfSelection: api.read, pdfSelectionInput: (annotation: TaskAnnotation) => (() => { if (!annotation.source) throw new Error("Missing annotation source fixture"); return JSON.parse(annotation.source.content); })() }));
vi.mock("./PdfSelectionDocument", () => ({ PdfSelectionDocument: () => <div /> }));
vi.mock("@/components/research/tasks/TaskAnnotations", () => ({ TaskAnnotations: ({ onSaved, onExplicitRequest }: { onSaved?: (annotation: TaskAnnotation) => void; onExplicitRequest?: (body: string) => Promise<void> }) => { api.onSaved = onSaved ?? null; api.explicit = onExplicitRequest ?? null; return <div />; } }));
import { PdfSelectionDialog } from "./PdfSelectionDialog";
const frozen: FrozenPdfSelection = { projectId: "paper", mainDocument: "main.tex", checkpoint: null, bytes: new Uint8Array([1]), selection: { documentIdentity: "old-pdf", text: "Historical quoted source", pages: [{ page: 2, rects: [{ x: .1, y: .2, width: .3, height: .1 }] }], rotation: 0 } };
const annotation = { id: "root", body: "Original feedback", createdAt: 1, target: { projectId: "paper", objectKind: "pdf_selection", objectId: "root", path: "main.tex" }, source: { kind: "pdf_selection", content: JSON.stringify(frozen) } } as TaskAnnotation;
const target = { runtimeId: "builtin", agentId: "fixture", modelId: "test" };
beforeEach(() => { vi.clearAllMocks(); api.onSaved = null; api.explicit = null; api.list.mockResolvedValue([]); api.save.mockResolvedValue(annotation); api.read.mockResolvedValue(new ArrayBuffer(1)); api.capture.mockResolvedValue(target); api.start.mockResolvedValue(undefined); });
it("saves feedback without capturing an agent or creating or starting a task", async () => {
  render(<PdfSelectionDialog projectId="paper" frozen={frozen} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Save this feedback" } });
  fireEvent.click(screen.getByRole("button", { name: en.selection.saveFeedback }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(frozen, "Save this feedback"));
  await screen.findByRole("status");
  expect(api.capture).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});
it("starts a new request against the historical root and retries the same created task", async () => {
  api.list.mockResolvedValue([annotation]);
  const task = { id: "review-1", title: "Review" } as ResearchTask;
  api.create.mockResolvedValue(task); api.start.mockRejectedValueOnce(new Error("start failed")).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<PdfSelectionDialog projectId="paper" frozen={null} onClose={close} />);
  fireEvent.click(await screen.findByRole("button", { name: /Original feedback/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Check this now" } });
  fireEvent.click(screen.getByRole("button", { name: en.selection.startReview }));
  await screen.findByRole("alert");
  expect(api.create).toHaveBeenCalledWith(annotation, "Check this now", target);
  expect(api.save).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toBeDisabled();
  const savedRoot = screen.getByRole("button", { name: /Original feedback/ });
  expect(savedRoot).toBeDisabled();
  fireEvent.click(savedRoot);
  expect(api.create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: en.selection.retryStart }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.create).toHaveBeenCalledOnce(); expect(api.capture).toHaveBeenCalledOnce();
  expect(api.start.mock.calls).toEqual([[task], [task]]);
});

it("keeps historical feedback passive and starts an explicit saved request with its new body", async () => {
  api.list.mockResolvedValue([annotation]);
  const task = { id: "review-saved-request", title: "Saved request" } as ResearchTask;
  api.create.mockResolvedValue(task);
  const close = vi.fn();
  render(<PdfSelectionDialog projectId="paper" frozen={null} onClose={close} />);
  fireEvent.click(await screen.findByRole("button", { name: /Original feedback/ }));
  await waitFor(() => expect(api.explicit).toBeTypeOf("function"));
  await act(async () => { api.onSaved?.({ ...annotation, id: "feedback", body: "Only an observation", explicitRequest: false }); });
  expect(api.capture).not.toHaveBeenCalled();
  expect(api.create).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => { await api.explicit?.("Verify this older PDF against current evidence"); });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.create).toHaveBeenCalledExactlyOnceWith(annotation, "Verify this older PDF against current evidence", target);
  expect(api.start).toHaveBeenCalledExactlyOnceWith(task);
  expect(api.save).not.toHaveBeenCalled();
});

it("retains the delegated task after a failed start and retries without a second task", async () => {
  api.list.mockResolvedValue([annotation]);
  const task = { id: "delegated-review", title: "Delegated review" } as ResearchTask;
  api.create.mockResolvedValue(task);
  api.start.mockRejectedValueOnce(new Error("Start unavailable")).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<PdfSelectionDialog projectId="paper" frozen={null} onClose={close} />);
  fireEvent.click(await screen.findByRole("button", { name: /Original feedback/ }));
  await waitFor(() => expect(api.explicit).toBeTypeOf("function"));
  await act(async () => {
    await expect(api.explicit?.("New explicit request")).rejects.toThrow("Start unavailable");
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Start unavailable");
  fireEvent.click(screen.getByRole("button", { name: en.selection.retryStart }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.create).toHaveBeenCalledExactlyOnceWith(annotation, "New explicit request", target);
  expect(api.start.mock.calls).toEqual([[task], [task]]);
  expect(api.save).not.toHaveBeenCalled();
});

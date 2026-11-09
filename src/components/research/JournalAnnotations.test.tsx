// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskAnnotationsProps } from "./tasks/TaskAnnotations";
import type { JournalAnnotationObject, JournalObjectReference } from "@/lib/journal-workbench";
import type { TaskAnnotation, TaskAnnotationDraft } from "@/lib/task-collaboration";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { researchTaskFixture } from "./tasks/tests/task-fixtures";

const api = vi.hoisted(() => ({
  panel: null as TaskAnnotationsProps | null,
  load: vi.fn(), save: vi.fn(), request: vi.fn(), group: vi.fn(), annotations: vi.fn(), capture: vi.fn(),
  receive: vi.fn(), start: vi.fn(), open: vi.fn(), rail: vi.fn(),
}));
vi.mock("./tasks/TaskAnnotations", () => ({ TaskAnnotations: (props: TaskAnnotationsProps) => { api.panel = props; return <div data-testid="annotation-editor" />; } }));
vi.mock("@/lib/journal-workbench", () => ({
  loadJournalAnnotationObject: api.load, saveJournalAnnotation: api.save, requestJournalAnnotation: api.request,
  journalAnnotationSource: (annotation: TaskAnnotation) => JSON.parse(annotation.source?.content ?? "{}"),
}));
vi.mock("@/lib/task-collaboration", () => ({ loadTaskGroup: api.group, loadObjectAnnotations: api.annotations }));
vi.mock("@/lib/assistant-delegation-capture", () => ({ captureAssistantTarget: api.capture }));
vi.mock("@/store/research-tasks", () => ({ useResearchTasksStore: { getState: () => ({ receiveTask: api.receive, startTask: api.start, openTaskDetail: api.open }) } }));
vi.mock("@/store/settings", () => ({ useSettingsStore: { getState: () => ({ setRailTab: api.rail }) } }));
vi.mock("@/store/research-tasks-flag", () => ({ researchTasksEnabled: () => true, useResearchTasksEnabled: () => true, setResearchTasksEnabled: vi.fn() }));
import { JournalAnnotations } from "./JournalAnnotations";

const reference: JournalObjectReference = { libraryRoot: "/library", workbenchProjectId: "manuscript", kind: "rule", objectId: "columns", worldVersionId: "world-old", checkId: null };
const target = { projectId: "paper", taskId: null, objectKind: "journal_rule", objectId: JSON.stringify({ libraryRoot: "/library", manuscriptId: "manuscript", id: "columns" }), objectRevision: "world-old", path: null };
const source = { kind: "journal_object", content: JSON.stringify({ reference, object: { rule_id: "columns", evidence: [{ quote: "Use two columns" }] } }) };
const root: TaskAnnotation = { id: "root", target, source: { ...source, sha256: "hash" }, author: { kind: "user", id: "user" }, body: "Old rule feedback", parentId: null, mentions: [], explicitRequest: false, status: "open", createdAt: 1, updatedAt: 1, handledAt: null, handledBy: null };
const task = researchTaskFixture({ id: "journal-task", status: "completed" });
const object: JournalAnnotationObject = { reference, target, source, relatedTasks: [task], continuationTaskId: null };
const text = en.journal.annotations;
const draft = (patch: Partial<TaskAnnotationDraft> = {}): TaskAnnotationDraft => ({ target, body: "Check this earlier rule", parentId: null, mentions: [], explicitRequest: false, ...patch });

beforeEach(() => {
  vi.clearAllMocks(); api.panel = null;
  api.load.mockResolvedValue(object); api.save.mockResolvedValue(root);
  api.request.mockResolvedValue({ annotation: { ...root, id: "request", explicitRequest: true }, task, created: false, needsStart: false });
  api.group.mockResolvedValue(null); api.capture.mockResolvedValue({ runtimeId: "builtin", agentId: "chosen", modelId: "chosen-model" });
  api.annotations.mockResolvedValue({ annotations: [root] });
  api.start.mockResolvedValue({ ...task, status: "running" });
});

async function ready() { await screen.findByTestId("annotation-editor"); await waitFor(() => expect(api.group).toHaveBeenCalledWith("paper", task.id)); }

it("saves original feedback without resolving a model or asking an associated task to run", async () => {
  render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await ready();
  const body = "  This rule may be wrong.\nKeep the original quote.  ";
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ body })); });
  expect(api.save).toHaveBeenCalledExactlyOnceWith("paper", reference, body, null, []);
  expect(api.capture).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it("continues the exact associated task with the retained parent and mentions without starting it again", async () => {
  render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await ready();
  await act(async () => { api.panel?.onReplyChange?.(root); });
  await waitFor(() => expect(api.load).toHaveBeenLastCalledWith("paper", reference, root.id));
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ explicitRequest: true, parentId: root.id, mentions: ["reviewer"] })); });
  expect(api.request).toHaveBeenCalledExactlyOnceWith({ projectId: "paper", reference, body: "Check this earlier rule", parentId: root.id, mentions: ["reviewer"], taskId: task.id, draft: null });
  expect(api.save).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it("retains a newly created task when start fails and retries its same ID without a second annotation or task", async () => {
  api.load.mockResolvedValue({ ...object, relatedTasks: [] });
  api.request.mockResolvedValue({ annotation: { ...root, id: "request", explicitRequest: true }, task, created: true, needsStart: true });
  api.start.mockRejectedValueOnce(new Error("Start failed")).mockResolvedValueOnce({ ...task, status: "running" });
  render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await screen.findByTestId("annotation-editor");
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ explicitRequest: true })); });
  expect(await screen.findByRole("alert")).toHaveTextContent("Start failed");
  expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ parentId: root.id, taskId: null, draft: expect.objectContaining({ runtimeId: "builtin", agentId: "chosen", modelId: "chosen-model" }) }));
  fireEvent.click(screen.getByRole("button", { name: text.retryStart }));
  await waitFor(() => expect(screen.queryByRole("button", { name: text.retryStart })).toBeNull());
  expect(api.start.mock.calls).toEqual([[task.id], [task.id]]);
  expect(api.request).toHaveBeenCalledOnce(); expect(api.save).toHaveBeenCalledOnce(); expect(api.capture).toHaveBeenCalledOnce();
});

it("keeps a reply on the older source when the current displayed rule advances", async () => {
  const view = render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await ready();
  await act(async () => { api.panel?.onReplyChange?.(root); });
  view.rerender(<JournalAnnotations projectId="paper" reference={{ ...reference, worldVersionId: "world-new" }} onOpenTarget={vi.fn()} />);
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ parentId: root.id, body: "Question about the original rule" })); });
  expect(api.save).toHaveBeenCalledExactlyOnceWith("paper", reference, "Question about the original rule", root.id, []);
});

it("requires a choice when multiple tasks share this object and does not use a project's latest pointer", async () => {
  api.load.mockResolvedValue({ ...object, relatedTasks: [task, { ...task, id: "another-task" }] });
  render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await screen.findByTestId("annotation-editor");
  await act(async () => { await expect(api.panel?.submitAnnotation?.(draft({ explicitRequest: true }))).rejects.toThrow(text.chooseTask); });
  expect(api.save).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled(); expect(api.capture).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "another-task" } });
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ explicitRequest: true })); });
  expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ taskId: "another-task", parentId: root.id, draft: null }));
});

it("starts an existing unstarted associated task only when the backend requests it", async () => {
  api.request.mockResolvedValue({ annotation: { ...root, id: "request", explicitRequest: true }, task, created: false, needsStart: true });
  render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await ready();
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ explicitRequest: true })); });
  expect(api.start).toHaveBeenCalledExactlyOnceWith(task.id);
  expect(api.capture).not.toHaveBeenCalled();
});

it("can reply to a member's annotation using its original source without calling a model for feedback", async () => {
  const memberReply = { ...root, id: "member-reply", source: null, parentId: root.id, author: { kind: "member" as const, id: "reviewer" }, target: { ...root.target, taskId: task.id } };
  render(<JournalAnnotations projectId="paper" reference={reference} onOpenTarget={vi.fn()} />);
  await ready();
  await act(async () => { api.panel?.onReplyChange?.(memberReply); });
  await waitFor(() => expect(api.load).toHaveBeenLastCalledWith("paper", reference, memberReply.id));
  await act(async () => { await api.panel?.submitAnnotation?.(draft({ parentId: memberReply.id, mentions: ["reviewer"] })); });
  expect(api.save).toHaveBeenCalledExactlyOnceWith("paper", reference, "Check this earlier rule", memberReply.id, ["reviewer"]);
  expect(api.capture).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

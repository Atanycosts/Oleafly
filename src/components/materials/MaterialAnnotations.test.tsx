// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialAnnotations } from "./MaterialAnnotations";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import { materialTarget, type MaterialDocument } from "@/lib/material-surface";
import type { AnnotationTarget, TaskAnnotation, TaskAnnotationDraft } from "@/lib/task-collaboration";
import { researchTaskFixture } from "@/components/research/tasks/tests/task-fixtures";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useSettingsStore } from "@/store/settings";

const api = vi.hoisted(() => ({ save: vi.fn(), request: vi.fn(), read: vi.fn(), load: vi.fn(), group: vi.fn(), list: vi.fn(), capture: vi.fn(), start: vi.fn(), enable: vi.fn(), enabled: vi.fn(), open: vi.fn(), receive: vi.fn(), taskDetail: vi.fn(), bindProject: vi.fn(), refresh: vi.fn(), projectId: null as string | null, tasks: [] as { id: string }[] }));
vi.mock("@/lib/research-tasks", async (original) => ({ ...await original<typeof import("@/lib/research-tasks")>(), listResearchTasks: api.list }));
vi.mock("@/lib/material-annotations", async (original) => ({ ...await original<typeof import("@/lib/material-annotations")>(), saveMaterialAnnotation: api.save, requestMaterialAnnotation: api.request, readMaterialAnnotation: api.read }));
vi.mock("@/lib/task-collaboration", () => ({ loadObjectAnnotations: api.load, loadTaskAnnotations: vi.fn(), loadTaskGroup: api.group, submitTaskAnnotation: vi.fn() }));
vi.mock("@/lib/assistant-delegation-capture", () => ({ captureAssistantTarget: api.capture }));
vi.mock("@/store/research-tasks-flag", () => ({ researchTasksEnabled: api.enabled, setResearchTasksEnabled: api.enable }));
vi.mock("@/store/research-tasks", () => ({ useResearchTasksStore: { getState: () => ({ projectId: api.projectId, tasks: api.tasks, bindProject: api.bindProject, refresh: api.refresh, startTask: api.start, receiveTask: api.receive, openTaskDetail: api.taskDetail }) } }));
vi.mock("@/store/material-viewer", () => ({ useMaterialViewerStore: { getState: () => ({ open: api.open }) } }));
const labels = en.tasks.annotations;
const document: MaterialDocument = { projectId: "paper", documentId: "material-a", path: "figure.svg", title: "Figure A", kind: "image", revision: "revision-new", source: { bytes: new Uint8Array([1, 2]) } };
let saved: TaskAnnotation[];
function annotation(draft: Partial<TaskAnnotation> = {}): TaskAnnotation {
  return { id: "feedback-1", target: materialTarget(document), author: { kind: "user", id: "user" }, body: "Inspect this figure", parentId: null, mentions: [], explicitRequest: false, status: "open", createdAt: 1, updatedAt: 1, handledAt: null, handledBy: null, ...draft };
}
function fillRequest() {
  fireEvent.change(screen.getByRole("textbox", { name: labels.body }), { target: { value: "Inspect this figure" } });
  fireEvent.click(screen.getByRole("checkbox", { name: labels.explicitRequest }));
  fireEvent.click(screen.getByRole("button", { name: labels.save }));
}
beforeEach(() => {
  vi.clearAllMocks(); saved = [];
  api.projectId = null; api.tasks = [];
  useMaterialAnnotationsStore.getState().open(document, { kind: "region", rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
  api.load.mockImplementation(async () => ({ annotations: saved, deliveries: [], handlings: [], requirements: [], distillations: [] }));
  api.save.mockImplementation(async (_document: MaterialDocument, _anchor: unknown, draft: TaskAnnotationDraft) => {
    const item = annotation({ ...draft, source: null }); saved.push(item); return item;
  });
  api.enabled.mockReturnValue(false);
  api.list.mockResolvedValue([]);
  api.group.mockResolvedValue(null);
  api.refresh.mockResolvedValue(undefined);
  api.enable.mockResolvedValue(undefined);
  api.bindProject.mockResolvedValue(undefined);
  api.capture.mockResolvedValue({ runtimeId: "builtin", agentId: "provider", modelId: "model" });
  api.start.mockResolvedValue(researchTaskFixture({ status: "running" }));
  api.request.mockResolvedValue({ annotation: annotation({ id: "requested-1", explicitRequest: true }), task: researchTaskFixture(), needsStart: true });
});

describe("material feedback panel", () => {
  it("renders nothing when no material is open", () => {
    useMaterialAnnotationsStore.getState().close();
    const view = render(<MaterialAnnotations />);
    expect(view.container).toBeEmptyDOMElement();
  });
  it("shows an object-history failure without closing the material workspace", async () => {
    api.load.mockRejectedValueOnce(new Error("Object history unavailable"));
    render(<MaterialAnnotations />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Object history unavailable");
    expect(useMaterialAnnotationsStore.getState().document).toBe(document);
    expect(screen.getByRole("textbox", { name: labels.body })).toBeVisible();
  });
  it("keeps annotations readable when their task is no longer listed", async () => {
    saved = [annotation({ target: { ...materialTarget(document), taskId: "removed-task" } })];
    api.list.mockResolvedValue([]);
    render(<MaterialAnnotations />);
    expect(await screen.findByTestId("task-annotation")).toHaveTextContent("Inspect this figure");
    expect(api.list).toHaveBeenCalledExactlyOnceWith("paper");
    expect(screen.queryByRole("button", { name: `${en.materialAnnotations.openTask} · Task removed-task` })).not.toBeInTheDocument();
  });
  it("shows the selected quote only for quote-bearing anchors", () => {
    useMaterialAnnotationsStore.getState().open(document, { kind: "html", selector: "#figure", quote: "Selected caption" });
    render(<MaterialAnnotations />);
    expect(screen.getByText("Selected caption")).toBeVisible();
    act(() => useMaterialAnnotationsStore.getState().open(document, { kind: "page", page: 2, rects: [] }));
    expect(screen.queryByText("Selected caption")).not.toBeInTheDocument();
  });
  it("exposes a recovered task without starting work already present", async () => {
    api.request.mockResolvedValue({
      annotation: annotation({ id: "requested-without-start", explicitRequest: true }),
      task: researchTaskFixture({ id: "ready-task", status: "awaiting_review" }),
      needsStart: false,
    });
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await waitFor(() => expect(api.request).toHaveBeenCalledOnce());
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `${en.materialAnnotations.openTask} · Task ready-task` })).toBeVisible();
  });
  it("labels non-material results without a path by their result role", async () => {
    showResult({ ...materialTarget(document), objectKind: "artifact", objectId: "result", taskId: "result-task", path: null });
    render(<MaterialAnnotations />);
    expect(await screen.findByRole("button", { name: en.materialAnnotations.result })).toBeVisible();
  });
  it("offers optional minimization without clearing its draft or closing the material", async () => {
    const minimize = vi.fn();
    const view = render(<MaterialAnnotations onMinimize={minimize} />);
    await screen.findByText(labels.empty);
    fireEvent.change(screen.getByRole("textbox", { name: labels.body }), { target: { value: "Draft to keep" } });
    fireEvent.click(screen.getByRole("button", { name: en.materialAnnotations.minimize }));
    expect(minimize).toHaveBeenCalledOnce();
    expect(useMaterialAnnotationsStore.getState().document).toBe(document);
    expect(screen.getByRole("textbox", { name: labels.body })).toHaveValue("Draft to keep");
    view.rerender(<MaterialAnnotations />);
    expect(screen.queryByRole("button", { name: en.materialAnnotations.minimize })).not.toBeInTheDocument();
  });
  it("binds the project before opening handling details for a first-time task viewer", async () => {
    saved = [annotation({ target: { ...materialTarget(document), taskId: "task-1" }, explicitRequest: true })];
    api.list.mockResolvedValue([researchTaskFixture({ status: "awaiting_review" })]);
    let finishBinding!: () => void;
    api.bindProject.mockImplementationOnce(() => new Promise<void>((resolve) => { finishBinding = resolve; }));
    useSettingsStore.setState({ showTree: false, railTab: "files" });
    render(<MaterialAnnotations />);
    fireEvent.click(await screen.findByRole("button", { name: `${en.materialAnnotations.openTask} · Task task-1` }));
    await waitFor(() => expect(api.bindProject).toHaveBeenCalledWith("paper"));
    expect(api.taskDetail).not.toHaveBeenCalled();
    await act(async () => { finishBinding(); });
    expect(api.taskDetail).toHaveBeenCalledWith("task-1", "annotations");
    expect(useSettingsStore.getState()).toMatchObject({ showTree: true, railTab: "research" });
  });
  it.each(["provider failure", "pending task"] as const)("isolates a new material version from an older asynchronous %s", async (outcome) => {
    const provider = { runtimeId: "builtin", agentId: "provider", modelId: "model" };
    let resolveCapture!: (value: typeof provider) => void;
    let rejectCapture!: (cause: Error) => void;
    const oldCapture = new Promise<typeof provider>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
    api.capture.mockImplementationOnce(() => oldCapture).mockResolvedValue(provider);
    const oldBind = vi.fn().mockRejectedValue(new Error("old binding failed"));
    const newBind = vi.fn().mockResolvedValue(undefined);
    const nextDocument = { ...document, revision: "revision-next", source: { bytes: new Uint8Array([3, 4]) } };
    api.save.mockImplementation(async (captured: MaterialDocument, _anchor: unknown, draft: TaskAnnotationDraft) => {
      const item = annotation({ ...draft, id: `feedback-${captured.revision}`, source: null });
      saved.push(item);
      return item;
    });
    api.request.mockImplementation(async (_projectId: string, annotationId: string) => {
      const original = saved.find((item) => item.id === annotationId);
      if (!original) throw new Error("Missing retained feedback");
      const taskId = original.target.objectRevision === document.revision ? "old-task" : "new-task";
      return { annotation: { ...original, explicitRequest: true }, task: researchTaskFixture({ id: taskId }), needsStart: true };
    });
    useMaterialAnnotationsStore.getState().open(document, undefined, { beforeStartTask: oldBind });
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await waitFor(() => expect(api.capture).toHaveBeenCalledOnce());

    act(() => useMaterialAnnotationsStore.getState().open(nextDocument, undefined, { beforeStartTask: newBind }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: labels.body })).toHaveValue(""));
    await act(async () => {
      if (outcome === "provider failure") rejectCapture(new Error("old provider failed"));
      else resolveCapture(provider);
      await oldCapture.catch(() => undefined);
    });
    if (outcome === "pending task") await waitFor(() => expect(oldBind).toHaveBeenCalledWith("old-task"));
    expect(screen.queryByText("old provider failed")).not.toBeInTheDocument();
    expect(screen.queryByText("old binding failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.materialAnnotations.retryStart })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();

    fillRequest();
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("new-task"));
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1][0]).toBe(nextDocument);
    expect(api.request).toHaveBeenLastCalledWith("paper", "feedback-revision-next", expect.anything());
    expect(newBind).toHaveBeenCalledExactlyOnceWith("new-task");
    expect(oldBind).toHaveBeenCalledTimes(outcome === "pending task" ? 1 : 0);
    expect(api.start).toHaveBeenCalledOnce();
  });

  it("binds the captured working copy before starting a new material task", async () => {
    const order: string[] = [];
    const bind = vi.fn(async () => { order.push("bind"); });
    api.start.mockImplementation(async () => { order.push("start"); return researchTaskFixture({ status: "running" }); });
    useMaterialAnnotationsStore.getState().open(document, undefined, { beforeStartTask: bind });
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(order).toEqual(["bind", "start"]);
    expect(bind).toHaveBeenCalledWith("task-1");
  });
  it("retains the existing task after bind failure and retries binding before startup", async () => {
    const bind = vi.fn().mockRejectedValueOnce(new Error("captured session changed")).mockResolvedValue(undefined);
    useMaterialAnnotationsStore.getState().open(document, undefined, { beforeStartTask: bind });
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await screen.findByText("captured session changed");
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.materialAnnotations.retryStart }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("task-1"));
    expect(bind).toHaveBeenCalledTimes(2);
    expect(api.request).toHaveBeenCalledOnce();
    expect(api.save).toHaveBeenCalledOnce();
  });
  it("refuses to bind or start an older reply with the current working copy hook", async () => {
    const bind = vi.fn().mockResolvedValue(undefined);
    api.request.mockResolvedValue({ annotation: annotation({ target: { ...materialTarget(document), objectRevision: "old" } }), task: researchTaskFixture(), needsStart: true });
    useMaterialAnnotationsStore.getState().open(document, undefined, { beforeStartTask: bind });
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await screen.findByRole("alert");
    expect(bind).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.materialAnnotations.retryStart }));
    expect(bind).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("rejects an older recovered task instead of binding it to the reopened current material", async () => {
    const bind = vi.fn().mockResolvedValue(undefined);
    saved = [annotation({ target: { ...materialTarget(document), taskId: "task-1", objectRevision: "older" }, explicitRequest: true })];
    api.list.mockResolvedValue([researchTaskFixture()]);
    useMaterialAnnotationsStore.getState().open(document, undefined, { beforeStartTask: bind });
    render(<MaterialAnnotations />);
    fireEvent.click(await screen.findByRole("button", { name: en.materialAnnotations.retryStart }));
    await screen.findByRole("alert");
    expect(bind).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("keeps live binding options out of retained document state and clears them on ordinary open", () => {
    const beforeStartTask = vi.fn();
    useMaterialAnnotationsStore.getState().open(document, undefined, { beforeStartTask });
    expect(useMaterialAnnotationsStore.getState().document).not.toHaveProperty("beforeStartTask");
    useMaterialAnnotationsStore.getState().open(document);
    expect(useMaterialAnnotationsStore.getState().options).toEqual({});
  });
  it("saves ordinary feedback without enabling research tasks or capturing a provider", async () => {
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fireEvent.change(screen.getByRole("textbox", { name: labels.body }), { target: { value: "Inspect this figure" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    expect(api.enable).not.toHaveBeenCalled();
    expect(api.capture).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
    expect(api.save.mock.calls[0][1]).toMatchObject({ kind: "region" });
  });
  it("retains the created task after start failure and retries only its existing ID", async () => {
    api.start.mockRejectedValueOnce(new Error("provider temporarily unavailable"));
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await screen.findByText("provider temporarily unavailable");
    expect(api.enable).toHaveBeenCalledWith(true);
    expect(api.request).toHaveBeenCalledWith("paper", "feedback-1", expect.objectContaining({ agentId: "provider", modelId: "model" }));
    const retry = screen.getByRole("button", { name: en.materialAnnotations.retryStart });
    fireEvent.click(retry);
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls.map(([id]) => id)).toEqual(["task-1", "task-1"]);
    expect(api.request).toHaveBeenCalledOnce();
    expect(api.save).toHaveBeenCalledOnce();
  });
  it("retries failed provider capture without duplicating saved feedback", async () => {
    api.capture.mockRejectedValueOnce(new Error("choose provider"));
    render(<MaterialAnnotations />);
    await screen.findByText(labels.empty);
    fillRequest();
    await screen.findByText("choose provider");
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(api.request).toHaveBeenCalledOnce());
    expect(api.save).toHaveBeenCalledOnce();
  });
  it("recovers an unstarted task after reopening the panel", async () => {
    saved = [annotation({ target: { ...materialTarget(document), taskId: "task-1" }, explicitRequest: true })];
    api.list.mockResolvedValue([researchTaskFixture()]);
    render(<MaterialAnnotations />);
    fireEvent.click(await screen.findByRole("button", { name: en.materialAnnotations.retryStart }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("task-1"));
    expect(api.request).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });
  it("opens the retained earlier bytes rather than applying old anchors to a current buffer", async () => {
    const snapshot = { document: { ...document, source: undefined, revision: "revision-old" }, anchor: { kind: "whole" }, sha256: "old", size: 1, mediaType: "image/svg+xml" };
    saved = [annotation({ target: { ...materialTarget(document), objectRevision: "revision-old" }, source: { kind: "material_snapshot", content: JSON.stringify(snapshot), sha256: "source" } })];
    api.read.mockResolvedValue({ snapshot, bytes: [7] });
    render(<MaterialAnnotations />);
    const card = await screen.findByTestId("task-annotation");
    fireEvent.click(within(card).getByRole("button", { name: labels.recordedObject }));
    await waitFor(() => expect(api.open).toHaveBeenCalledOnce());
    const request = api.open.mock.calls[0][0];
    expect(request.revision).toBe("revision-old");
    expect(await request.load()).toEqual(new Uint8Array([7]));
    expect(request.anchor).toEqual({ kind: "whole" });
  });
  it("passes a frozen source to its host and reports a failed source read without opening it", async () => {
    const retained = { snapshot: { document: { ...document, source: undefined }, anchor: { kind: "whole" }, sha256: "old", size: 1, mediaType: "image/svg+xml" }, bytes: [7] };
    saved = [annotation({ source: { kind: "material_snapshot", content: JSON.stringify(retained.snapshot), sha256: "source" } })];
    api.read.mockRejectedValueOnce(new Error("Retained source is unavailable")).mockResolvedValue(retained);
    const onOpenSnapshot = vi.fn();
    render(<MaterialAnnotations onOpenSnapshot={onOpenSnapshot} />);
    const card = await screen.findByTestId("task-annotation");
    const open = within(card).getByRole("button", { name: labels.recordedObject });
    fireEvent.click(open);
    expect(await screen.findByRole("alert")).toHaveTextContent("Retained source is unavailable");
    expect(onOpenSnapshot).not.toHaveBeenCalled();
    expect(api.open).not.toHaveBeenCalled();
    fireEvent.click(open);
    await waitFor(() => expect(onOpenSnapshot).toHaveBeenCalledExactlyOnceWith(retained));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.read).toHaveBeenNthCalledWith(2, "paper", "feedback-1");
    expect(api.open).not.toHaveBeenCalled();
  });
  it("recovers the newest annotated task and offers its members for feedback", async () => {
    const oldTask = researchTaskFixture({ id: "old", createdAt: 1, status: "awaiting_review" });
    const latest = researchTaskFixture({ id: "latest", createdAt: 2, status: "awaiting_review" });
    saved = [annotation({ id: "old-note", target: { ...materialTarget(document), taskId: oldTask.id } }), annotation({ target: { ...materialTarget(document), taskId: latest.id } })];
    api.list.mockResolvedValue([oldTask, latest]);
    api.group.mockResolvedValue({ members: [{ id: "reviewer", name: "Figure reviewer" }] });
    render(<MaterialAnnotations />);
    await screen.findByRole("button", { name: `${en.materialAnnotations.openTask} · Task latest` });
    expect(api.group).toHaveBeenCalledExactlyOnceWith("paper", "latest");
    fireEvent.click(await screen.findByRole("checkbox", { name: "@Figure reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: labels.body }), { target: { value: "Check the caption" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(document, expect.anything(), expect.objectContaining({ mentions: ["reviewer"], explicitRequest: false })));
    expect(screen.queryByRole("button", { name: en.materialAnnotations.retryStart })).not.toBeInTheDocument();
  });
  it.each(["task history", "task members"] as const)("keeps feedback usable when recovered %s cannot load", async (source) => {
    saved = [annotation({ target: { ...materialTarget(document), taskId: "task-1" } })];
    api.list.mockResolvedValue([researchTaskFixture({ status: "awaiting_review" })]);
    if (source === "task history") api.list.mockRejectedValueOnce(new Error("History unavailable"));
    else api.group.mockRejectedValueOnce(new Error("Members unavailable"));
    render(<MaterialAnnotations />);
    expect(await screen.findByRole("alert")).toHaveTextContent(source === "task history" ? "History unavailable" : "Members unavailable");
    fireEvent.change(screen.getByRole("textbox", { name: labels.body }), { target: { value: "Saved locally for later" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    expect(api.request).not.toHaveBeenCalled();
  });
  function showResult(reference: AnnotationTarget) {
    const original = annotation();
    saved = [original];
    const context = { annotations: saved, deliveries: [], requirements: [], distillations: [], handlings: [{ id: "handling", annotationId: original.id, author: { kind: "model", id: "model" }, summary: "Reviewed", resultRefs: [reference], createdAt: 2 }] };
    api.load.mockResolvedValue(context);
    return context;
  }
  it("delegates a handling result to the caller when a target opener is supplied", async () => {
    const result = { ...materialTarget(document), objectKind: "artifact", objectId: "result", taskId: "result-task", path: "review.md" };
    showResult(result);
    const onOpenTarget = vi.fn();
    render(<MaterialAnnotations onOpenTarget={onOpenTarget} />);
    fireEvent.click(await screen.findByRole("button", { name: "review.md" }));
    expect(onOpenTarget).toHaveBeenCalledExactlyOnceWith(result);
    expect(api.taskDetail).not.toHaveBeenCalled();
  });
  it.each(["known", "missing", "refresh failure"] as const)("opens a %s handling task in the already bound project", async (state) => {
    api.projectId = "paper";
    api.tasks = state === "known" ? [{ id: "result-task" }] : [];
    if (state === "refresh failure") api.refresh.mockRejectedValueOnce(new Error("Task refresh unavailable"));
    showResult({ ...materialTarget(document), objectKind: "artifact", objectId: "result", taskId: "result-task", path: "review.md" });
    render(<MaterialAnnotations />);
    fireEvent.click(await screen.findByRole("button", { name: "review.md" }));
    if (state === "refresh failure") {
      expect(await screen.findByRole("alert")).toHaveTextContent("Task refresh unavailable");
      expect(api.taskDetail).not.toHaveBeenCalled();
    } else await waitFor(() => expect(api.taskDetail).toHaveBeenCalledWith("result-task", "output"));
    expect(api.bindProject).not.toHaveBeenCalled();
    expect(api.refresh).toHaveBeenCalledTimes(state === "known" ? 0 : 1);
  });
  it("opens the exact material revision referenced by a handling result", async () => {
    const result = { ...materialTarget(document), objectRevision: "sha256:earlier" };
    const snapshot = { document: { ...document, source: undefined, revision: "earlier" }, anchor: { kind: "whole" }, sha256: "earlier", size: 1, mediaType: "image/svg+xml" };
    const frozen = annotation({ id: "earlier-note", target: result, source: { kind: "material_snapshot", content: JSON.stringify(snapshot), sha256: "source" } });
    const initial = showResult(result);
    // The initial object query supplies the handling result; opening it resolves its retained annotation.
    api.load.mockImplementation((reference: AnnotationTarget) => Promise.resolve(reference.objectRevision === result.objectRevision ? { annotations: [frozen] } : initial));
    api.read.mockResolvedValue({ snapshot, bytes: [8] });
    render(<MaterialAnnotations />);
    fireEvent.click(await screen.findByRole("button", { name: `${document.title} · ${en.materialAnnotations.oldVersion}` }));
    await waitFor(() => expect(api.read).toHaveBeenCalledExactlyOnceWith("paper", "earlier-note"));
    expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ revision: "earlier" }));
  });
});

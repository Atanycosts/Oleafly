// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialAnnotations } from "./MaterialAnnotations";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import { materialTarget, type MaterialDocument } from "@/lib/material-surface";
import type { TaskAnnotation, TaskAnnotationDraft } from "@/lib/task-collaboration";
import { researchTaskFixture } from "@/components/research/tasks/tests/task-fixtures";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useSettingsStore } from "@/store/settings";

const api = vi.hoisted(() => ({ save: vi.fn(), request: vi.fn(), read: vi.fn(), load: vi.fn(), list: vi.fn(), capture: vi.fn(), start: vi.fn(), enable: vi.fn(), enabled: vi.fn(), open: vi.fn(), receive: vi.fn(), taskDetail: vi.fn(), bindProject: vi.fn() }));
vi.mock("@/lib/research-tasks", async (original) => ({ ...await original<typeof import("@/lib/research-tasks")>(), listResearchTasks: api.list }));
vi.mock("@/lib/material-annotations", async (original) => ({ ...await original<typeof import("@/lib/material-annotations")>(), saveMaterialAnnotation: api.save, requestMaterialAnnotation: api.request, readMaterialAnnotation: api.read }));
vi.mock("@/lib/task-collaboration", () => ({ loadObjectAnnotations: api.load, loadTaskAnnotations: vi.fn(), loadTaskGroup: vi.fn().mockResolvedValue(null), submitTaskAnnotation: vi.fn() }));
vi.mock("@/lib/assistant-delegation-capture", () => ({ captureAssistantTarget: api.capture }));
vi.mock("@/store/research-tasks-flag", () => ({ researchTasksEnabled: api.enabled, setResearchTasksEnabled: api.enable }));
vi.mock("@/store/research-tasks", () => ({ useResearchTasksStore: { getState: () => ({ projectId: null, bindProject: api.bindProject, startTask: api.start, receiveTask: api.receive, openTaskDetail: api.taskDetail }) } }));
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
  useMaterialAnnotationsStore.getState().open(document, { kind: "region", rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
  api.load.mockImplementation(async () => ({ annotations: saved, deliveries: [], handlings: [], requirements: [], distillations: [] }));
  api.save.mockImplementation(async (_document: MaterialDocument, _anchor: unknown, draft: TaskAnnotationDraft) => {
    const item = annotation({ ...draft, source: null }); saved.push(item); return item;
  });
  api.enabled.mockReturnValue(false);
  api.list.mockResolvedValue([]);
  api.enable.mockResolvedValue(undefined);
  api.bindProject.mockResolvedValue(undefined);
  api.capture.mockResolvedValue({ runtimeId: "builtin", agentId: "provider", modelId: "model" });
  api.start.mockResolvedValue(researchTaskFixture({ status: "running" }));
  api.request.mockResolvedValue({ annotation: annotation({ id: "requested-1", explicitRequest: true }), task: researchTaskFixture(), needsStart: true });
});

describe("material feedback panel", () => {
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
});

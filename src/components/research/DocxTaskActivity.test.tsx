// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import enEditor from "@/i18n/locales/en/editor.json" with { type: "json" };
import type { DocxActivity } from "@/lib/docx-task-activity";
const mocks = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), bind: vi.fn(), open: vi.fn(), bindProject: vi.fn(), refresh: vi.fn(), projectId: "app" as string | null, tasks: [] as { id: string }[], setRailTab: vi.fn(), minimize: vi.fn(), close: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock("@/lib/research-tasks", () => ({ listResearchTasks: mocks.list }));
vi.mock("@/lib/docx-task-activity", () => ({ loadDocxTaskActivities: mocks.load, bindDocxTask: mocks.bind, subscribeDocxTaskActivity: mocks.subscribe }));
vi.mock("@/store/research-tasks", () => ({ useResearchTasksStore: { getState: () => ({ projectId: mocks.projectId, tasks: mocks.tasks, bindProject: mocks.bindProject, refresh: mocks.refresh, openTaskDetail: mocks.open }) } }));
vi.mock("@/store/settings", () => ({ useSettingsStore: { getState: () => ({ setRailTab: mocks.setRailTab }) } }));
vi.mock("@/store/docx-workspace", () => ({ useDocxWorkspaceStore: { getState: () => ({ minimize: mocks.minimize, close: mocks.close }) } }));
import { DocxActivitySource, DocxTaskActivity } from "./DocxTaskActivity";
const text = en.docx.taskActivity;
const activity: DocxActivity = {
  id: "proposal", origin: { taskId: "task-source", generation: 3, groupId: "group", memberId: "member", executionId: "execution", workIds: ["work-a", "work-b"] },
  document: { sessionId: "historical-session", appProjectId: "app", workbenchProjectId: "paper", baselineId: "baseline", sourceSha256: "a".repeat(64), sessionRevision: 1, savedRevision: 0 },
  proposalId: null, createdAt: 1,
  event: { type: "runtime", event: { kind: "proposed", target: { targetId: "old-target", paragraphRef: "p1", revision: 1, original: "Historical original" }, proposed: "Historical candidate" } },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectId = "app";
  mocks.tasks = [{ id: "queued-task" }, { id: "task-source" }];
  mocks.bindProject.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([{ id: "queued-task", title: "Queued task", status: "queued", executionGeneration: 0, startedAt: null }, { id: "running-task", title: "Running task", status: "running", executionGeneration: 1 }]);
  mocks.load.mockResolvedValue({ activities: [], nextCursor: 0, hasMore: false });
  mocks.bind.mockResolvedValue(undefined);
});
describe("document task activity panel", () => {
  it("binds only an explicitly chosen existing task to the live session", async () => {
    render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Queued task" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "Running task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Queued task · queued" })).not.toBeInTheDocument();
    expect(mocks.bind).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(text.chooseTask), { target: { value: "queued-task" } });
    fireEvent.click(screen.getByRole("button", { name: text.bind }));
    await waitFor(() => expect(mocks.bind).toHaveBeenCalledWith("app", "queued-task", "live-session"));
    fireEvent.click(await screen.findByRole("button", { name: text.bound }));
    expect(mocks.open).toHaveBeenCalledWith("queued-task", "activity");
    expect(mocks.setRailTab).toHaveBeenCalledExactlyOnceWith("research");
    expect(mocks.minimize).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.bindProject).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.setRailTab.mock.invocationCallOrder[0]);
    expect(mocks.setRailTab.mock.invocationCallOrder[0]).toBeLessThan(mocks.minimize.mock.invocationCallOrder[0]);
  });
  it("renders immutable history and task/work sources without reattaching historical targets", async () => {
    mocks.load.mockResolvedValueOnce({ activities: [{ cursor: 10, activity }], nextCursor: 10, hasMore: true });
    render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="new-session" />);
    expect(await screen.findByText("Historical original")).toBeInTheDocument();
    expect(screen.getByText("Historical candidate")).toBeInTheDocument();
    expect(screen.queryByText(/work-a/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: text.source }));
    expect(mocks.open).toHaveBeenCalledWith("task-source", "activity");
    expect(mocks.setRailTab).toHaveBeenCalledWith("research");
    expect(mocks.minimize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: text.group }));
    expect(mocks.open).toHaveBeenLastCalledWith("task-source", "group");
    expect(mocks.setRailTab).toHaveBeenCalledTimes(2);
    expect(mocks.minimize).toHaveBeenCalledTimes(2);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: text.more }));
    await waitFor(() => expect(mocks.load).toHaveBeenLastCalledWith("app", "paper", 10, 20));
    const listener = (mocks.subscribe.mock.calls as unknown as [() => void][])[0][0];
    await act(async () => listener());
    expect(mocks.load).toHaveBeenCalledTimes(3);
  });
});

it("binds the source project before opening details on the first visit from Journal", async () => {
  mocks.projectId = null;
  mocks.tasks = [];
  let finishBinding!: () => void;
  mocks.bindProject.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishBinding = () => { mocks.projectId = "app"; mocks.tasks = [{ id: "task-source" }]; resolve(); };
  }));
  render(<DocxActivitySource activity={activity} />);
  fireEvent.click(screen.getByRole("button", { name: text.source }));
  expect(mocks.bindProject).toHaveBeenCalledExactlyOnceWith("app");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.setRailTab).not.toHaveBeenCalled();
  expect(mocks.minimize).not.toHaveBeenCalled();
  await act(async () => finishBinding());
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("task-source", "activity");
  expect(mocks.setRailTab).toHaveBeenCalledExactlyOnceWith("research");
  expect(mocks.minimize).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
});

it("refreshes a missing source task once before opening its group in the current project", async () => {
  mocks.tasks = [];
  let finishRefresh!: () => void;
  mocks.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishRefresh = () => { mocks.tasks = [{ id: "task-source" }]; resolve(); };
  }));
  render(<DocxActivitySource activity={activity} />);
  fireEvent.click(screen.getByRole("button", { name: text.group }));
  expect(mocks.bindProject).not.toHaveBeenCalled();
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.setRailTab).not.toHaveBeenCalled();
  await act(async () => finishRefresh());
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("task-source", "group");
  expect(mocks.setRailTab).toHaveBeenCalledExactlyOnceWith("research");
  expect(mocks.minimize).toHaveBeenCalledOnce();
});

it("refreshes tasks created after opening and clears the bound label for a new live session", async () => {
  mocks.list.mockResolvedValueOnce([]);
  const view = render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="session-one" />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
  expect(screen.queryByRole("option", { name: "Queued task" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: text.refresh }));
  await screen.findByRole("option", { name: "Queued task" });
  fireEvent.change(screen.getByLabelText(text.chooseTask), { target: { value: "queued-task" } });
  fireEvent.click(screen.getByRole("button", { name: text.bind }));
  await screen.findByRole("button", { name: text.bound });
  view.rerender(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="session-two" />);
  expect(screen.queryByRole("button", { name: text.bound })).not.toBeInTheDocument();
  expect(mocks.bind).toHaveBeenCalledOnce();
});

it("shows the actual operation and saved or checked result retained for a task", async () => {
  const save: DocxActivity = {
    ...activity,
    id: "save",
    event: {
      type: "runtime",
      event: {
        kind: "operation",
        operationId: "save-operation",
        operation: "save",
        request: { expected_revision: 3 },
        result: {
          operation: "save",
          ok: true,
          document: { ...activity.document, baselineId: "saved-baseline", sessionRevision: 3, savedRevision: 3 },
          result: { baselineId: "saved-baseline", revision: 3, sourceSha256: "b".repeat(64) },
        },
      },
    },
  };
  const check: DocxActivity = {
    ...activity,
    id: "check",
    event: {
      type: "runtime",
      event: {
        kind: "operation",
        operationId: "check-operation",
        operation: "check",
        request: { template: "world-current" },
        result: {
          operation: "check",
          ok: true,
          document: { ...activity.document, baselineId: "saved-baseline", sessionRevision: 3, savedRevision: 3 },
          result: { template: "world-current", check: {
            check_id: "check-current", baseline_id: "saved-baseline", world_version_id: "world-current",
            validity: "CURRENT", summary: { findings: 0 },
          } },
        },
      },
    },
  };
  mocks.load.mockResolvedValueOnce({
    activities: [{ cursor: 1, activity: save }, { cursor: 2, activity: check }],
    nextCursor: 2,
    hasMore: false,
  });

  const { container } = render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);

  expect(await screen.findByText(`${enEditor.agentWorkspace.save} · ${text.operationSucceeded}`)).toBeVisible();
  expect(screen.getByText(`${enEditor.agentWorkspace.check} · ${text.operationSucceeded}`)).toBeVisible();
  expect(screen.getByText(`${text.events.saved}: 3`)).toBeVisible();
  expect(screen.getByText(en.docx.checked)).toBeVisible();
  expect(screen.queryByText(`${en.docx.checked}: ${en.journal.current}`)).toBeNull();
  expect(container.querySelector('[data-testid="docx-task-operation"][data-operation="save"]')).toMatchObject({
    dataset: expect.objectContaining({
      baselineId: "saved-baseline", revision: "3", sourceSha256: "b".repeat(64), outcome: "succeeded",
    }),
  });
  expect(container.querySelector('[data-testid="docx-task-operation"][data-operation="check"]')).toMatchObject({
    dataset: expect.objectContaining({
      baselineId: "saved-baseline", checkId: "check-current", worldVersionId: "world-current",
      validity: "CURRENT", outcome: "succeeded",
    }),
  });
});

it.each([
  ["saved", enEditor.agentWorkspace.exportSaved],
  ["cancelled", enEditor.agentWorkspace.exportCancelled],
  ["download_requested", enEditor.agentWorkspace.downloadRequested],
] as const)("shows the retained %s export outcome without inferring success from ok", async (status, label) => {
  const exported: DocxActivity = {
    ...activity,
    id: "export",
    event: {
      type: "runtime",
      event: {
        kind: "operation",
        operationId: "export-operation",
        operation: "export",
        request: { session_id: activity.document.sessionId },
        result: {
          operation: "export",
          ok: true,
          document: activity.document,
          result: {
            result: status === "saved" ? { status, path: "/chosen/paper.docx" } : { status },
            filename: "paper.docx",
            sessionId: activity.document.sessionId,
            sessionRevision: activity.document.sessionRevision,
            byteLength: 2048,
          },
        },
      },
    },
  };
  mocks.load.mockResolvedValueOnce({ activities: [{ cursor: 1, activity: exported }], nextCursor: 1, hasMore: false });

  render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);

  const operation = await screen.findByText(`${enEditor.agentWorkspace.export} · ${label}`);
  expect(operation).toBeVisible();
  expect(operation).toHaveAttribute("data-outcome", status);
  expect(screen.queryByText(`${enEditor.agentWorkspace.export} · ${text.operationSucceeded}`)).not.toBeInTheDocument();
  if (status !== "saved") {
    expect(screen.queryByText(`${enEditor.agentWorkspace.export} · ${enEditor.agentWorkspace.exportSaved}`)).not.toBeInTheDocument();
  }
});

it("coalesces an explicit refresh while the current activity page is still loading", async () => {
  let finishLoad!: (page: { activities: never[]; nextCursor: number; hasMore: boolean }) => void;
  mocks.load.mockReturnValueOnce(new Promise((resolve) => { finishLoad = resolve; }));
  render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());

  fireEvent.click(screen.getByRole("button", { name: text.refresh }));
  expect(mocks.load).toHaveBeenCalledOnce();
  await act(async () => finishLoad({ activities: [], nextCursor: 0, hasMore: false }));
  expect(screen.getByRole("button", { name: text.refresh })).toBeEnabled();
});

it("reports a task-list failure without losing the recoverable activity panel", async () => {
  mocks.list.mockRejectedValueOnce(new Error("tasks unavailable"));
  mocks.load.mockReturnValueOnce(new Promise(() => {}));
  render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);

  expect(await screen.findByRole("alert")).toHaveTextContent("tasks unavailable");
  expect(screen.getByRole("button", { name: text.bind })).toBeDisabled();
  expect(screen.getByRole("button", { name: text.refresh })).toBeEnabled();
});

it("reports an activity-history failure and recovers on the next refresh", async () => {
  mocks.load.mockRejectedValueOnce(new Error("history unavailable"));
  render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("history unavailable");

  fireEvent.click(screen.getByRole("button", { name: text.refresh }));

  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("renders started and failed historical operations from the same page", async () => {
  const started: DocxActivity = {
    ...activity,
    id: "started",
    event: {
      type: "runtime",
      event: { kind: "operationStarted", operation: "save", request: { expected_revision: 1 } },
    },
  };
  const failed: DocxActivity = {
    ...activity,
    id: "failed",
    event: {
      type: "runtime",
      event: {
        kind: "operation",
        operationId: "export-failed",
        operation: "export",
        request: { session_id: activity.document.sessionId },
        result: { operation: "export", ok: false },
      },
    },
  };
  const checkpoint: DocxActivity = {
    ...activity,
    id: "checkpoint",
    event: {
      type: "operationCheckpoint",
      operationId: "save-operation",
      phase: "saved",
      recoveryKey: "recovery-key",
      contentSha256: "d".repeat(64),
      fromDocument: activity.document,
    },
  };
  mocks.load.mockResolvedValueOnce({
    activities: [
      { cursor: 1, activity: started },
      { cursor: 2, activity: failed },
      { cursor: 3, activity: checkpoint },
    ],
    nextCursor: 3,
    hasMore: false,
  });
  render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);

  expect(await screen.findByText(`${enEditor.agentWorkspace.save} · ${text.events.operationStarted}`)).toBeVisible();
  const operation = screen.getByText(`${enEditor.agentWorkspace.export} · ${text.operationFailed}`);
  expect(operation).toHaveAttribute("data-outcome", "failed");
  expect(operation).not.toHaveAttribute("data-session-revision");
  expect(screen.getByText(text.events.saved)).toBeVisible();
});

it("reports a live-session bind failure and leaves the selection ready to retry", async () => {
  mocks.bind.mockRejectedValueOnce(new Error("session is stale"));
  render(<DocxTaskActivity projectId="app" workbenchProjectId="paper" sessionId="live-session" />);
  const select = await screen.findByLabelText(text.chooseTask);
  fireEvent.change(select, { target: { value: "queued-task" } });

  fireEvent.click(screen.getByRole("button", { name: text.bind }));

  expect(await screen.findByRole("alert")).toHaveTextContent("session is stale");
  expect(screen.getByRole("button", { name: text.bind })).toBeEnabled();
  expect(select).toHaveValue("queued-task");
  expect(screen.queryByRole("button", { name: text.bound })).not.toBeInTheDocument();
});

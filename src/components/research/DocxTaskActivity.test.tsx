// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
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
    expect(screen.getByText(`${text.work}: work-a, work-b`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${text.source}: task-source · ${text.generation} 3` }));
    expect(mocks.open).toHaveBeenCalledWith("task-source", "activity");
    expect(mocks.setRailTab).toHaveBeenCalledWith("research");
    expect(mocks.minimize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: `${text.group}: group` }));
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
  fireEvent.click(screen.getByRole("button", { name: `${text.source}: task-source · ${text.generation} 3` }));
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
  fireEvent.click(screen.getByRole("button", { name: `${text.group}: group` }));
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

import { JSDOM } from "jsdom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { researchTaskFixture } from "./tests/task-fixtures";
import type { GroupSnapshot } from "@/lib/task-collaboration";
const api = vi.hoisted(() => ({ loadTaskGroup: vi.fn(), loadTaskGroupMessages: vi.fn(), createTaskGroup: vi.fn(), sendGroupMessage: vi.fn(), setTaskGroupStatus: vi.fn(), setGroupMemberPaused: vi.fn(), setGroupMemberInterest: vi.fn() }));
vi.mock("@/lib/task-collaboration", () => api);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (selector: (v: unknown) => unknown) => selector({ researchTools: { tasks: { group: new Proxy({}, { get: (_, key) => String(key) }) } } }) }) }));
let Panel: typeof import("./TaskGroupPanel").TaskGroupPanel;
let testing: typeof import("@testing-library/react");
beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Event", "MutationObserver"] as const) vi.stubGlobal(key, key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testing = await import("@testing-library/react");
  Panel = (await import("./TaskGroupPanel")).TaskGroupPanel;
});
beforeEach(() => { vi.resetAllMocks(); api.loadTaskGroup.mockResolvedValue(null); api.loadTaskGroupMessages.mockResolvedValue(snapshot()); });
afterEach(() => testing.cleanup());
const task = researchTaskFixture({ id: "t1", projectId: "p1", runtimeId: "builtin", agentId: "provider", modelId: "model", skillIds: [], updatedAt: 1 });
const agents = [{ runtimeId: "builtin", agentId: "agent", modelId: "cli-model", label: "Second model" }];
function snapshot(): GroupSnapshot {
 return { group: { id: "g1", projectId: "p1", taskId: "t1", status: "open", createdAt: 1, updatedAt: 1 }, members: [{ id: "m1", groupId: "g1", name: "Reviewer", responsibility: "Check evidence", runtimeId: "acp", agentId: "agent", modelId: "actual-model", skillIds: [], coordinator: true, paused: false, joinedAt: 1 }], interests: [], messages: [{ id: "msg1", sequence: 1, groupId: "g1", author: { kind: "member", id: "m1", executionId: "x1" }, body: "Returned evidence", recipients: [], replyTo: null, object: null, requestWork: false, createdAt: 1 }], work: [{ id: "w1", groupId: "g1", memberId: "m1", causeKind: "message", causeId: "msg1", priority: 1, status: "completed", executionId: "x1", resultMessageId: "msg1", createdAt: 1, updatedAt: 1 }], executions: [], nextSequence: 1 };
}
describe("TaskGroupPanel", () => {
 it("creates coordinator with frozen task model and an explicitly selected built-in member", async () => {
  const view = testing.render(<Panel task={task} agents={agents} />);
  await testing.waitFor(() => expect(view.getByText("addMember")).toBeTruthy());
  testing.fireEvent.change(view.getByLabelText("name"), { target: { value: "Coordinator" } });
  testing.fireEvent.change(view.getByLabelText("responsibility"), { target: { value: "Coordinate" } });
  testing.fireEvent.click(view.getByText("addMember"));
  const name = view.getAllByLabelText("name")[1];
  const responsibility = view.getAllByLabelText("responsibility")[1];
  if (!name || !responsibility) throw new Error("The added member fields are missing");
  testing.fireEvent.change(name, { target: { value: "Reviewer" } });
  testing.fireEvent.change(responsibility, { target: { value: "Review" } });
  testing.fireEvent.change(view.getByLabelText("model"), { target: { value: "0" } });
  testing.fireEvent.click(view.getByText("create"));
  await testing.waitFor(() => expect(api.createTaskGroup).toHaveBeenCalledWith("p1", "t1", [expect.objectContaining({ coordinator: true, runtimeId: "builtin", modelId: "model" }), expect.objectContaining({ coordinator: false, runtimeId: "builtin", agentId: "agent", modelId: "cli-model" })]));
 });
 it("sends addressed reply with work request and displays returned work status", async () => {
  api.loadTaskGroup.mockResolvedValue(snapshot());
  const view = testing.render(<Panel task={task} agents={agents} />);
  await testing.waitFor(() => expect(view.getByText(/actual-model/)).toBeTruthy());
  testing.fireEvent.click(view.getByText("reply"));
  testing.fireEvent.click(view.getByLabelText("@Reviewer"));
  testing.fireEvent.change(view.getByLabelText("message"), { target: { value: "Check this claim" } });
  testing.fireEvent.click(view.getByLabelText("requestWork"));
  testing.fireEvent.click(view.getByText("send"));
  await testing.waitFor(() => expect(api.sendGroupMessage).toHaveBeenCalledWith("p1", "g1", { body: "Check this claim", recipients: ["m1"], replyTo: "msg1", requestWork: true, object: null }));
  expect(view.getByText(/completed/)).toBeTruthy();
  expect(view.getAllByText("Returned evidence").length).toBe(2);
 });
 it("ignores a late group response after switching task scope", async () => {
  let resolve!: (value: GroupSnapshot) => void;
  api.loadTaskGroup.mockImplementationOnce(() => new Promise<GroupSnapshot>(done => { resolve = done; }));
  const view = testing.render(<Panel task={task} agents={agents} />);
  view.rerender(<Panel task={{ ...task, id: "t2", projectId: "p2" }} agents={agents} />);
  await testing.waitFor(() => expect(api.loadTaskGroup).toHaveBeenCalledWith("p2", "t2"));
  await testing.act(async () => resolve(snapshot()));
  expect(view.queryByText("Check evidence")).toBeNull();
  expect(view.getByText("create")).toBeTruthy();
 });
 it("does not replace an ACP coordinator with a built-in member", async () => {
  const view = testing.render(<Panel task={{ ...task, runtimeId: "acp" }} agents={agents} />);
  await testing.waitFor(() => expect(view.getByText("acpUnsupported")).toBeTruthy());
  expect(view.queryByText("create")).toBeNull();
  expect(api.createTaskGroup).not.toHaveBeenCalled();
 });
 it("refreshes an existing group by message cursor", async () => {
  api.loadTaskGroup.mockResolvedValue(snapshot());
  const view = testing.render(<Panel task={task} agents={agents} />);
  await testing.waitFor(() => expect(view.getByText(/actual-model/)).toBeTruthy());
  testing.fireEvent.click(view.getByText("refresh"));
  await testing.waitFor(() => expect(api.loadTaskGroupMessages).toHaveBeenCalledWith("p1", "g1", 1));
  expect(api.loadTaskGroup).toHaveBeenCalledTimes(1);
  expect(view.getAllByText("Returned evidence").length).toBe(2);
 });

 it("shares the loaded snapshot and links returned work to its message", async () => {
  const group = snapshot(); api.loadTaskGroup.mockResolvedValue(group);
  const callback = vi.fn();
  const view = testing.render(<Panel task={task} agents={agents} onSnapshot={callback} />);
  await testing.waitFor(() => expect(callback).toHaveBeenCalledWith(group));
  expect(view.getByRole("link", { name: "Returned evidence" }).getAttribute("href")).toBe("#group-message-msg1");
  expect(view.container.querySelector("#group-message-msg1")).toBeTruthy();
 });

});

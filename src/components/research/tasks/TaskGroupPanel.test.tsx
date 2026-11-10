import { JSDOM } from "jsdom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { researchTaskFixture } from "./tests/task-fixtures";
import type { TaskObservation, TaskTranscriptEvent } from "@/lib/research-tasks";
import type { AnnotationContext, GroupEvent, GroupSnapshot, MemberExecution, TaskAnnotation } from "@/lib/task-collaboration";
const api = vi.hoisted(() => ({ loadTaskGroup: vi.fn(), loadTaskGroupMessages: vi.fn(), loadTaskGroupEventsPage: vi.fn(), loadTaskGroupExecutionsPage: vi.fn(), loadTaskGroupEventsAfter: vi.fn(), loadTaskGroupExecutionsAfter: vi.fn(), loadTaskGroupEvent: vi.fn(), loadTaskGroupExecution: vi.fn(), createTaskGroup: vi.fn(), sendGroupMessage: vi.fn(), setTaskGroupStatus: vi.fn(), setGroupMemberPaused: vi.fn(), setGroupMemberInterest: vi.fn(), loadTaskAnnotations: vi.fn() }));
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/task-collaboration", () => api);
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (selector: (v: unknown) => unknown) => selector({ common: { actions: { copy: "Copy", copied: "Copied" } }, researchTools: { tasks: { group: new Proxy({}, { get: (_, key) => String(key) }), annotations: { resultRefs: "resultRefs" }, observations: new Proxy({}, { get: (_, key) => String(key) }) } } }) }) }));
let Panel: typeof import("./TaskGroupPanel").TaskGroupPanel;
let testing: typeof import("@testing-library/react");
beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Event", "MutationObserver"] as const) vi.stubGlobal(key, key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testing = await import("@testing-library/react");
  Panel = (await import("./TaskGroupPanel")).TaskGroupPanel;
});
beforeEach(() => {
  vi.resetAllMocks();
  api.loadTaskGroup.mockResolvedValue(null);
  api.loadTaskGroupMessages.mockResolvedValue(snapshot());
  api.loadTaskGroupEventsPage.mockResolvedValue({ events: [], hasMore: false });
  api.loadTaskGroupExecutionsPage.mockResolvedValue({ executions: [], hasMore: false });
  api.loadTaskGroupEventsAfter.mockResolvedValue({ events: [], hasMore: false });
  api.loadTaskGroupExecutionsAfter.mockResolvedValue({ executions: [], hasMore: false });
  api.loadTaskGroupEvent.mockResolvedValue(null);
  api.loadTaskGroupExecution.mockResolvedValue(null);
  api.loadTaskAnnotations.mockResolvedValue(annotationContext());
  native.invoke.mockResolvedValue(null);
});
afterEach(() => testing.cleanup());
const task = researchTaskFixture({ id: "t1", projectId: "p1", runtimeId: "builtin", agentId: "provider", modelId: "model", skillIds: [], updatedAt: 1 });
const agents = [{ runtimeId: "builtin", agentId: "agent", modelId: "cli-model", label: "Second model" }];
function snapshot(): GroupSnapshot {
 return { group: { id: "g1", projectId: "p1", taskId: "t1", status: "open", createdAt: 1, updatedAt: 1 }, members: [{ id: "m1", groupId: "g1", name: "Reviewer", responsibility: "Check evidence", runtimeId: "acp", agentId: "agent", modelId: "actual-model", skillIds: [], coordinator: true, paused: false, joinedAt: 1 }], interests: [], messages: [{ id: "msg1", sequence: 1, groupId: "g1", author: { kind: "member", id: "m1", executionId: "x1" }, body: "Returned evidence", recipients: [], replyTo: null, object: null, requestWork: false, createdAt: 1 }], work: [{ id: "w1", groupId: "g1", memberId: "m1", causeKind: "message", causeId: "msg1", priority: 1, status: "completed", executionId: "x1", resultMessageId: "msg1", createdAt: 1, updatedAt: 1 }], executions: [], nextSequence: 1 };
}
function annotationContext(): AnnotationContext {
  const annotation: TaskAnnotation = {
    id: "annotation-1",
    target: { projectId: "p1", taskId: "t1", objectKind: "file", objectId: "notes.md", objectRevision: "4", path: "notes.md" },
    author: { kind: "user", id: "user-1" },
    body: "Please verify the recorded claim.",
    parentId: null,
    mentions: ["m1"],
    explicitRequest: true,
    status: "handled",
    createdAt: 1,
    updatedAt: 2,
    handledAt: 2,
    handledBy: { kind: "member", id: "m1" },
  };
  return {
    annotations: [annotation],
    deliveries: [],
    requirements: [],
    handlings: [{
      id: "handling-1",
      annotationId: annotation.id,
      author: { kind: "member", id: "m1" },
      summary: "Compared the observation with the retained claim.",
      resultRefs: [{ projectId: "p1", taskId: "t1", objectKind: "file", objectId: "result.md", objectRevision: "2", path: "result.md" }],
      createdAt: 2,
    }],
    distillations: [],
  };
}
function observationRow(sequence: number, observation: TaskObservation, executionGeneration = 7): TaskTranscriptEvent {
  return { taskId: "t1", executionGeneration, sequence, createdAt: sequence, event: { kind: "observation", observation } };
}
function eventRecord(sequence: number): GroupEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    groupId: "g1",
    kind: "file_changed",
    object: { kind: "file", id: `notes-${sequence}.md`, revision: String(sequence), path: `notes-${sequence}.md` },
    author: { kind: "member", id: "m1", executionId: `execution-${sequence}` },
    detail: `Event ${sequence}`,
    createdAt: sequence,
  };
}
function executionRecord(startedAt: number): MemberExecution {
  return {
    id: `execution-${String(startedAt).padStart(3, "0")}`,
    groupId: "g1",
    memberId: "m1",
    taskGeneration: 2,
    sessionId: `session-${startedAt}`,
    runtimeId: "builtin",
    agentId: "agent",
    modelId: "model",
    providerId: "provider",
    status: "completed",
    inputTokens: startedAt,
    outputTokens: startedAt,
    startedAt,
    finishedAt: startedAt + 1,
  };
}
function emptyIncremental(loaded: GroupSnapshot): GroupSnapshot {
  return {
    ...loaded,
    messages: [],
    events: [],
    executions: [],
  };
}
function sourceSnapshot(): GroupSnapshot {
  const base = attributedSnapshot();
  return {
    ...base,
    executions: [{ id: "x1", groupId: "g1", memberId: "m1", taskGeneration: 2, sessionId: "session-1", runtimeId: "builtin", agentId: "agent", modelId: "model", providerId: "provider", status: "completed", inputTokens: 1, outputTokens: 1, startedAt: 1, finishedAt: 2 }],
    work: [
      {
        id: "w-source",
        groupId: "g1",
        memberId: "m1",
        causeKind: "event",
        causeId: "e1",
        priority: 1,
        status: "completed",
        executionId: "x1",
        resultMessageId: null,
        reasons: [
          { kind: "read", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, sourceId: "call-read", executionId: "x1" },
          { kind: "wrote", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, sourceId: "call-write", executionId: "x1" },
        ],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "w-annotations",
        groupId: "g1",
        memberId: "m1",
        causeKind: "annotation",
        causeId: "annotation-1",
        priority: 1,
        status: "pending",
        executionId: null,
        resultMessageId: null,
        reasons: [
          { kind: "mention", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, sourceId: "annotation-1" },
          { kind: "handled", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, sourceId: "handling-1", executionId: "x1" },
          { kind: "parent_handling", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, sourceId: "handling-1" },
        ],
        createdAt: 3,
        updatedAt: 3,
      },
    ],
  };
}
function attributedSnapshot(): GroupSnapshot {
  const base = snapshot();
  const reviewer = base.members[0];
  const completedWork = base.work[0];
  if (!reviewer || !completedWork) throw new Error("The attributed snapshot fixture is incomplete");
  return {
    ...base,
    members: [
      reviewer,
      { id: "m2", groupId: "g1", name: "Writer", responsibility: "Update files", runtimeId: "builtin", agentId: "writer", modelId: "writer-model", skillIds: [], coordinator: false, paused: false, joinedAt: 2 },
    ],
    work: [
      {
        ...completedWork,
        reasons: [
          { kind: "explicit_recipient", object: { kind: "message", id: "msg1", revision: null, path: null }, sourceId: "msg1", executionId: "x1" },
          { kind: "interest_event", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, sourceId: "e1", executionId: "x2" },
        ],
      },
      { id: "w2", groupId: "g1", memberId: "m2", causeKind: "event", causeId: "e2", priority: 1, status: "pending", executionId: null, resultMessageId: null, reasons: [], createdAt: 2, updatedAt: 2 },
    ],
    events: [
      { sequence: 1, id: "e1", groupId: "g1", kind: "file_changed", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, author: { kind: "member", id: "m2", executionId: "x2" }, detail: "Workspace revision 4 was written.", createdAt: 2 },
      { sequence: 2, id: "e2", groupId: "g1", kind: "file_changed", object: { kind: "file", id: "budget.csv", revision: "2", path: "budget.csv" }, author: { kind: "member", id: "m1", executionId: "x1" }, detail: "A managed write changed the budget.", createdAt: 3 },
    ],
    attentions: [
      { memberId: "m1", object: { kind: "file", id: "notes.md", revision: "4", path: "notes.md" }, relation: "read", sourceId: "read-1", executionId: "x1", updatedAt: 2 },
      { memberId: "m2", object: { kind: "file", id: "budget.csv", revision: "2", path: "budget.csv" }, relation: "wrote", sourceId: "write-2", executionId: "x2", updatedAt: 3 },
      { memberId: "m3", object: { kind: "file", id: "hidden.md", revision: "1", path: "hidden.md" }, relation: "handled", sourceId: "handle-3", executionId: "x3", updatedAt: 4 },
    ],
  };
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
  await testing.waitFor(() => expect(api.loadTaskGroupMessages).toHaveBeenCalledWith("p1", "t1", "g1", 1));
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

 it("shows work attribution, event details, and member-owned attentions", async () => {
  api.loadTaskGroup.mockResolvedValue(attributedSnapshot());
  const view = testing.render(<Panel task={task} agents={agents} />);
  await testing.waitFor(() => expect(view.getByText(/reasonExplicitRecipient/)).toBeTruthy());

  expect(view.getByText(/reasonInterestEvent/)).toBeTruthy();
  expect(view.getAllByText(/file notes\.md · v4/).length).toBeGreaterThan(0);
  expect(view.getByText(/Workspace revision 4 was written\./)).toBeTruthy();
  expect(view.getByText(/A managed write changed the budget\./)).toBeTruthy();
  expect(view.getByText("noWakeReasons")).toBeTruthy();

  const reviewerAttention = view.getByTestId("attention-m1");
  expect(testing.within(reviewerAttention).getByText("attentionRead")).toBeTruthy();
  expect(testing.within(reviewerAttention).getByText(/file notes\.md · v4/)).toBeTruthy();
  expect(testing.within(reviewerAttention).queryByText("attentionWrote")).toBeNull();

  const writerAttention = view.getByTestId("attention-m2");
  expect(testing.within(writerAttention).getByText("attentionWrote")).toBeTruthy();
  expect(testing.within(writerAttention).getByText(/file budget\.csv · v2/)).toBeTruthy();
  expect(testing.within(writerAttention).queryByText("attentionRead")).toBeNull();
  expect(view.queryByText("file hidden.md · v1")).toBeNull();
 });

 it("shows the retained content and reason for responsibility-based participation", async () => {
  const loaded = attributedSnapshot();
  loaded.work[0].causeKind = "event";
  loaded.work[0].causeId = "e1";
  loaded.work[0].reasons = [{ kind: "responsibility", detail: "The comparison changed from test to validation.", sourceId: "assessment-1" }];
  const event = loaded.events?.[0];
  if (!event) throw new Error("Missing file event fixture");
  event.evidence = { availability: "available", fileSha256: "retained-hash", content: "validation split" };
  api.loadTaskGroup.mockResolvedValue(loaded);
  const view = testing.render(<Panel task={task} agents={agents} />);
  const work = await view.findByTestId("work-w1");
  expect(testing.within(work).getByText("reasonResponsibility")).toBeTruthy();
  expect(testing.within(work).getByText("The comparison changed from test to validation.")).toBeTruthy();
  expect(testing.within(work).getByText(/retained-hash/)).toBeTruthy();
  expect(testing.within(work).getByText(/validation split/)).toBeTruthy();
 });

 it("reads exact old-generation observation calls on demand", async () => {
  api.loadTaskGroup.mockResolvedValue(sourceSnapshot());
  native.invoke
    .mockResolvedValueOnce(observationRow(2, {
      type: "toolExecution",
      callId: "call-read",
      name: "mcp__filesystem__read_file",
      status: "done",
      inputSha256: "read-input",
      outputSha256: "read-output",
      skillId: null,
      skillInstructionsSha256: null,
      source: { path: "notes.md", fileSha256: "read-source-hash", offset: 0, endOffset: 12, truncated: false, snapshotRetained: true },
      actor: "tool-helper",
    }, 2))
    .mockResolvedValueOnce({ text: "old retained source", source: {} })
    .mockResolvedValueOnce(observationRow(3, {
      type: "toolExecution",
      callId: "call-write",
      name: "write_file",
      status: "done",
      inputSha256: "write-input",
      outputSha256: "write-output",
      skillId: null,
      skillInstructionsSha256: null,
      source: null,
      actor: null,
    }, 2));
  const view = testing.render(<Panel task={task} agents={agents} />);
  const work = await view.findByTestId("work-w-source");
  testing.fireEvent.click(testing.within(work).getByTestId("source-w-source-read"));
  await testing.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
  expect(native.invoke).toHaveBeenCalledWith("research_task_observation_call", { taskId: "t1", executionGeneration: 2, callId: "call-read" });
  expect(testing.within(work).getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("read-source-hash") === true)).toBeTruthy();
  expect(testing.within(work).getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("notes.md") === true)).toBeTruthy();
  expect(testing.within(work).getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("tool-helper") === true)).toBeTruthy();
  expect(testing.within(work).queryByText("sourceMetadataOnly")).toBeNull();
  testing.fireEvent.click(testing.within(work).getByText("openSource"));
  await testing.waitFor(() => expect(testing.within(work).getByText("old retained source")).toBeTruthy());
  expect(native.invoke).toHaveBeenNthCalledWith(2, "research_task_source_preview", { taskId: "t1", executionGeneration: 2, sequence: 2 });
  expect(testing.within(work).queryByText("member: m1")).toBeNull();

  testing.fireEvent.click(testing.within(work).getByTestId("source-w-source-wrote"));
  await testing.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(3));
  expect(native.invoke).toHaveBeenNthCalledWith(3, "research_task_observation_call", { taskId: "t1", executionGeneration: 2, callId: "call-write" });
  expect(testing.within(work).getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("call-write") === true)).toBeTruthy();
 });

 it("reads handling and annotation sources without inferring an author", async () => {
  api.loadTaskGroup.mockResolvedValue(sourceSnapshot());
  const context = annotationContext();
  api.loadTaskAnnotations.mockResolvedValue(context);
  const view = testing.render(<Panel task={task} agents={agents} />);
  const work = await view.findByTestId("work-w-annotations");

  testing.fireEvent.click(testing.within(work).getByTestId("source-w-annotations-handled"));
  await testing.waitFor(() => expect(testing.within(work).getByText("Please verify the recorded claim.")).toBeTruthy());
  expect(testing.within(work).getByText("Compared the observation with the retained claim.")).toBeTruthy();
  expect(testing.within(work).getByText("file result.md · v2")).toBeTruthy();
  expect(testing.within(work).getByText("user: user-1")).toBeTruthy();
  expect(testing.within(work).getByText("member: m1")).toBeTruthy();

  testing.fireEvent.click(testing.within(work).getByTestId("source-w-annotations-parent_handling"));
  testing.fireEvent.click(testing.within(work).getByTestId("source-w-annotations-mention"));
  await testing.waitFor(() => expect(testing.within(work).getAllByText("Please verify the recorded claim.")).toHaveLength(3));
  expect(api.loadTaskAnnotations).toHaveBeenCalledTimes(3);
  expect(api.loadTaskAnnotations).toHaveBeenCalledWith("p1", "t1");
 });

 it("reports missing executions and unavailable exact source calls", async () => {
  const outside = sourceSnapshot();
  outside.executions = [];
  api.loadTaskGroup.mockResolvedValue(outside);
  const first = testing.render(<Panel task={task} agents={agents} />);
  const sourceWork = await first.findByTestId("work-w-source");
  testing.fireEvent.click(testing.within(sourceWork).getByTestId("source-w-source-read"));
  await testing.waitFor(() => expect(testing.within(sourceWork).getByText("sourceExecutionUnavailable")).toBeTruthy());
  expect(native.invoke).not.toHaveBeenCalled();
  testing.cleanup();

  api.loadTaskGroup.mockResolvedValue(sourceSnapshot());
  native.invoke.mockResolvedValue(null);
  const second = testing.render(<Panel task={task} agents={agents} />);
  const secondWork = await second.findByTestId("work-w-source");
  testing.fireEvent.click(testing.within(secondWork).getByTestId("source-w-source-wrote"));
  await testing.waitFor(() => expect(testing.within(secondWork).getByText("sourceRecordUnavailable")).toBeTruthy());
  expect(native.invoke).toHaveBeenCalledWith("research_task_observation_call", { taskId: "t1", executionGeneration: 2, callId: "call-write" });
 });

 it("resolves an execution outside the loaded window by stable identity", async () => {
  const outside = sourceSnapshot();
  outside.executions = [];
  api.loadTaskGroup.mockResolvedValue(outside);
  api.loadTaskGroupExecution.mockResolvedValue({ id: "x1", groupId: "g1", memberId: "m1", taskGeneration: 2, sessionId: "session-1", runtimeId: "builtin", agentId: "agent", modelId: "model", providerId: "provider", status: "completed", inputTokens: 1, outputTokens: 1, startedAt: 1, finishedAt: 2 });
  native.invoke.mockResolvedValueOnce(observationRow(2, {
    type: "toolExecution",
    callId: "call-read",
    name: "read_file",
    status: "done",
    inputSha256: "read-input",
    outputSha256: "read-output",
    skillId: null,
    skillInstructionsSha256: null,
    source: { path: "notes.md", fileSha256: "historical-read-hash", offset: 0, endOffset: 12, truncated: false, snapshotRetained: true },
    actor: null,
  }, 2));
  const view = testing.render(<Panel task={task} agents={agents} />);
  const work = await view.findByTestId("work-w-source");
  testing.fireEvent.click(testing.within(work).getByTestId("source-w-source-read"));
  await testing.waitFor(() => expect(api.loadTaskGroupExecution).toHaveBeenCalledWith("p1", "t1", "g1", "x1"));
  await testing.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("research_task_observation_call", { taskId: "t1", executionGeneration: 2, callId: "call-read" }));
  expect(testing.within(work).getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("historical-read-hash") === true)).toBeTruthy();
 });

 it("merges an empty incremental poll without clearing loaded history", async () => {
  const loaded = sourceSnapshot();
  loaded.executionsHasMore = true;
  loaded.eventsHasMore = true;
  api.loadTaskGroup.mockResolvedValue(loaded);
  const incremental = snapshot();
  incremental.messages = [];
  incremental.work = loaded.work;
  incremental.executions = [];
  incremental.events = [];
  incremental.nextSequence = loaded.nextSequence;
  api.loadTaskGroupMessages.mockResolvedValue(incremental);
  const view = testing.render(<Panel task={task} agents={agents} />);
  await testing.waitFor(() => expect(view.getByText(/Workspace revision 4 was written\./)).toBeTruthy());
  testing.fireEvent.click(view.getByText("refresh"));
  await testing.waitFor(() => expect(api.loadTaskGroupMessages).toHaveBeenCalledWith("p1", "t1", "g1", loaded.nextSequence));
  expect(view.getByText(/Workspace revision 4 was written\./)).toBeTruthy();
  expect(view.getByText(/x1 · Reviewer/)).toBeTruthy();
 });

 it("loads every event and execution added beyond the latest incremental window", async () => {
  const loaded = attributedSnapshot();
  loaded.events = Array.from({ length: 100 }, (_, index) => eventRecord(index + 1));
  loaded.executions = Array.from({ length: 100 }, (_, index) => executionRecord(index + 1));
  loaded.eventsHasMore = true;
  loaded.executionsHasMore = true;
  api.loadTaskGroup.mockResolvedValue(loaded);
  const callback = vi.fn();
  const view = testing.render(<Panel task={task} agents={agents} onSnapshot={callback} />);
  await testing.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));

  api.loadTaskGroupMessages.mockClear();
  api.loadTaskGroupEventsAfter.mockReset();
  api.loadTaskGroupExecutionsAfter.mockReset();
  callback.mockClear();
  api.loadTaskGroupMessages.mockResolvedValue({
    ...emptyIncremental(loaded),
    events: Array.from({ length: 100 }, (_, index) => eventRecord(index + 151)),
    executions: Array.from({ length: 100 }, (_, index) => executionRecord(index + 151)),
  });
  api.loadTaskGroupEventsAfter.mockImplementation(async (_projectId, _taskId, _groupId, afterSequence) => {
    if (afterSequence === 100) return { events: Array.from({ length: 100 }, (_, index) => eventRecord(index + 101)), hasMore: true };
    if (afterSequence === 200) return { events: Array.from({ length: 50 }, (_, index) => eventRecord(index + 201)), hasMore: false };
    throw new Error(`Unexpected event cursor ${afterSequence}`);
  });
  api.loadTaskGroupExecutionsAfter.mockImplementation(async (_projectId, _taskId, _groupId, afterStartedAt) => {
    if (afterStartedAt === 100) return { executions: Array.from({ length: 100 }, (_, index) => executionRecord(index + 101)), hasMore: true };
    if (afterStartedAt === 200) return { executions: Array.from({ length: 50 }, (_, index) => executionRecord(index + 201)), hasMore: false };
    throw new Error(`Unexpected execution cursor ${afterStartedAt}`);
  });

  testing.fireEvent.click(view.getByText("refresh"));
  await testing.waitFor(() => expect(callback.mock.calls.at(-1)?.[0].events).toHaveLength(250));
  const final = callback.mock.calls.at(-1)?.[0] as GroupSnapshot;
  expect(final.events?.map(event => event.sequence)).toEqual(Array.from({ length: 250 }, (_, index) => index + 1));
  expect(final.executions.map(execution => execution.startedAt)).toEqual(Array.from({ length: 250 }, (_, index) => 250 - index));
  expect(api.loadTaskGroupEventsAfter).toHaveBeenNthCalledWith(1, "p1", "t1", "g1", 100);
  expect(api.loadTaskGroupEventsAfter).toHaveBeenNthCalledWith(2, "p1", "t1", "g1", 200);
  expect(api.loadTaskGroupExecutionsAfter).toHaveBeenNthCalledWith(1, "p1", "t1", "g1", 100, "execution-100");
  expect(api.loadTaskGroupExecutionsAfter).toHaveBeenNthCalledWith(2, "p1", "t1", "g1", 200, "execution-200");
 });

 it("updates a loaded execution from the incremental window without treating it as history", async () => {
  const loaded = attributedSnapshot();
  const running = executionRecord(100);
  running.status = "running";
  running.inputTokens = null;
  running.outputTokens = null;
  running.finishedAt = null;
  loaded.executions = [running];
  loaded.executionsHasMore = true;
  api.loadTaskGroup.mockResolvedValue(loaded);
  const callback = vi.fn();
  const view = testing.render(<Panel task={task} agents={agents} onSnapshot={callback} />);
  await testing.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
  expect(view.getByText(/execution-100 · Reviewer .* running · \?\/\?/)).toBeTruthy();

  callback.mockClear();
  api.loadTaskGroupExecutionsAfter.mockClear();
  api.loadTaskGroupMessages.mockResolvedValue({
    ...emptyIncremental(loaded),
    executions: [{ ...running, status: "completed", inputTokens: 10, outputTokens: 20, finishedAt: 101 }],
  });
  testing.fireEvent.click(view.getByText("refresh"));

  await testing.waitFor(() => expect(view.getByText(/execution-100 · Reviewer .* completed · 10\/20/)).toBeTruthy());
  const final = callback.mock.calls.at(-1)?.[0] as GroupSnapshot;
  expect(final.executions).toEqual([expect.objectContaining({ id: "execution-100", status: "completed", inputTokens: 10, outputTokens: 20, finishedAt: 101 })]);
  expect(final.executionsHasMore).toBe(true);
  expect(api.loadTaskGroupExecutionsAfter).toHaveBeenCalledWith("p1", "t1", "g1", 100, "execution-100");
 });

 it("bootstraps executions from the beginning when the initial window was empty", async () => {
  const loaded = attributedSnapshot();
  loaded.executions = [];
  loaded.executionsHasMore = false;
  api.loadTaskGroup.mockResolvedValue(loaded);
  const callback = vi.fn();
  const view = testing.render(<Panel task={task} agents={agents} onSnapshot={callback} />);
  await testing.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));

  callback.mockClear();
  api.loadTaskGroupExecutionsAfter.mockReset();
  api.loadTaskGroupMessages.mockResolvedValue({
    ...emptyIncremental(loaded),
    executions: Array.from({ length: 100 }, (_, index) => executionRecord(index + 51)),
  });
  api.loadTaskGroupExecutionsAfter.mockImplementation(async (_projectId, _taskId, _groupId, afterStartedAt) => {
    if (afterStartedAt === 0) return { executions: Array.from({ length: 100 }, (_, index) => executionRecord(index + 1)), hasMore: true };
    if (afterStartedAt === 100) return { executions: Array.from({ length: 50 }, (_, index) => executionRecord(index + 101)), hasMore: false };
    throw new Error(`Unexpected execution cursor ${afterStartedAt}`);
  });

  testing.fireEvent.click(view.getByText("refresh"));
  await testing.waitFor(() => expect(callback.mock.calls.at(-1)?.[0].executions).toHaveLength(150));
  const final = callback.mock.calls.at(-1)?.[0] as GroupSnapshot;
  expect(final.executions.map(execution => execution.startedAt)).toEqual(Array.from({ length: 150 }, (_, index) => 150 - index));
  expect(final.executionsHasMore).toBe(false);
  expect(api.loadTaskGroupExecutionsAfter).toHaveBeenNthCalledWith(1, "p1", "t1", "g1", 0, "");
  expect(api.loadTaskGroupExecutionsAfter).toHaveBeenNthCalledWith(2, "p1", "t1", "g1", 100, "execution-100");
 });

 it("preserves an older history page loaded while refresh pagination is in flight", async () => {
  const loaded = attributedSnapshot();
  loaded.events = [eventRecord(100), eventRecord(101)];
  loaded.eventsHasMore = true;
  api.loadTaskGroup.mockResolvedValue(loaded);
  const callback = vi.fn();
  const view = testing.render(<Panel task={task} agents={agents} onSnapshot={callback} />);
  await testing.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));

  let resolveAfter!: (page: { events: GroupEvent[]; hasMore: boolean }) => void;
  let resolveOlder!: (page: { events: GroupEvent[]; hasMore: boolean }) => void;
  api.loadTaskGroupMessages.mockClear();
  api.loadTaskGroupEventsPage.mockClear();
  api.loadTaskGroupEventsAfter.mockReset();
  callback.mockClear();
  api.loadTaskGroupMessages.mockResolvedValue({
    ...emptyIncremental(loaded),
    messages: [{ ...snapshot().messages[0], id: "msg-poll", sequence: 2, body: "Poll completed" }],
    nextSequence: 2,
  });
  api.loadTaskGroupEventsAfter.mockImplementation(() => new Promise(done => { resolveAfter = done; }));
  api.loadTaskGroupEventsPage.mockImplementationOnce(() => new Promise(done => { resolveOlder = done; }));

  testing.fireEvent.click(view.getByText("refresh"));
  await testing.waitFor(() => expect(api.loadTaskGroupEventsAfter).toHaveBeenCalledWith("p1", "t1", "g1", 101));
  testing.fireEvent.click(view.getByText("loadEarlierEvents"));
  await testing.waitFor(() => expect(api.loadTaskGroupEventsPage).toHaveBeenCalledWith("p1", "t1", "g1", 100));
  await testing.act(async () => resolveOlder({ events: [eventRecord(99)], hasMore: false }));
  await testing.waitFor(() => expect(callback.mock.calls.at(-1)?.[0].events).toHaveLength(3));
  await testing.act(async () => resolveAfter({ events: [], hasMore: false }));

  await testing.waitFor(() => {
    const current = callback.mock.calls.at(-1)?.[0] as GroupSnapshot | undefined;
    expect(current?.messages.some(message => message.id === "msg-poll")).toBe(true);
  });
  const final = callback.mock.calls.at(-1)?.[0] as GroupSnapshot;
  expect(final.events?.map(event => event.sequence)).toEqual([99, 100, 101]);
  expect(final.eventsHasMore).toBe(false);
 });

 it("shows source read errors and ignores late exact calls after switching tasks", async () => {
  api.loadTaskGroup.mockResolvedValue(sourceSnapshot());
  native.invoke.mockRejectedValueOnce(new Error("Observation unavailable"));
  const failed = testing.render(<Panel task={task} agents={agents} />);
  const failedWork = await failed.findByTestId("work-w-source");
  testing.fireEvent.click(testing.within(failedWork).getByTestId("source-w-source-read"));
  await testing.waitFor(() => expect(testing.within(failedWork).getByText("Observation unavailable")).toBeTruthy());
  testing.cleanup();

  let resolveObservation!: (row: TaskTranscriptEvent | null) => void;
  api.loadTaskGroup.mockReset().mockResolvedValueOnce(sourceSnapshot()).mockResolvedValueOnce(null);
  native.invoke.mockReset().mockImplementationOnce(() => new Promise<TaskTranscriptEvent | null>(done => { resolveObservation = done; }));
  const view = testing.render(<Panel task={task} agents={agents} />);
  const switchedWork = await view.findByTestId("work-w-source");
  testing.fireEvent.click(testing.within(switchedWork).getByTestId("source-w-source-read"));
  view.rerender(<Panel task={{ ...task, id: "t2", projectId: "p2" }} agents={agents} />);
  await testing.waitFor(() => expect(api.loadTaskGroup).toHaveBeenCalledWith("p2", "t2"));
  await testing.act(async () => resolveObservation(observationRow(2, {
    type: "toolExecution",
    callId: "call-read",
    name: "read_file",
    status: "done",
    inputSha256: "read-input",
    outputSha256: "read-output",
    skillId: null,
    skillInstructionsSha256: null,
    source: { path: "notes.md", fileSha256: "late-read-hash", offset: 0, endOffset: 12, truncated: false, snapshotRetained: true },
  }, 2)));
  expect(view.container.querySelector("pre")).toBeNull();
  expect(view.getByText("create")).toBeTruthy();
 });

});

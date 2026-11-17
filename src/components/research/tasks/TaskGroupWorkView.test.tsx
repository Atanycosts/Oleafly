import { JSDOM } from "jsdom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type {
  GroupEvent,
  GroupMessage,
  GroupSnapshot,
  GroupWork,
  TaskAnnotation,
} from "@/lib/task-collaboration";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (selector: (value: unknown) => unknown) =>
      selector({
        common: { actions: { close: "Close" } },
        researchTools: {
          tasks: { group: new Proxy({}, { get: (_, key) => String(key) }) },
        },
      }),
  }),
}));

let WorkView: typeof import("./TaskGroupWorkView").TaskGroupWorkView;
let testing: typeof import("@testing-library/react");

beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Node",
    "Event",
    "MutationObserver",
  ] as const) {
    vi.stubGlobal(
      key,
      key === "window"
        ? dom.window
        : key === "document"
          ? dom.window.document
          : dom.window[key],
    );
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testing = await import("@testing-library/react");
  WorkView = (await import("./TaskGroupWorkView")).TaskGroupWorkView;
});

afterEach(() => testing.cleanup());

function message(id: string, body: string, replyTo: string | null = null): GroupMessage {
  return {
    id,
    sequence: 1,
    groupId: "g1",
    author: { kind: "user", id: "user-1", executionId: null },
    body,
    recipients: [],
    replyTo,
    object: null,
    requestWork: false,
    createdAt: 1,
  };
}

function work(
  id: string,
  status: GroupWork["status"],
  causeKind = "message",
  causeId = "source",
): GroupWork {
  return {
    id,
    groupId: "g1",
    memberId: "m1",
    causeKind,
    causeId,
    priority: 1,
    status,
    executionId: null,
    resultMessageId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshot(workItems: GroupWork[], messages: GroupMessage[] = []): GroupSnapshot {
  return {
    group: {
      id: "g1",
      projectId: "p1",
      taskId: "t1",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
    },
    members: [{
      id: "m1",
      groupId: "g1",
      name: "Reviewer",
      responsibility: "Check evidence",
      runtimeId: "builtin",
      agentId: "agent",
      modelId: "model",
      skillIds: [],
      coordinator: true,
      paused: false,
      joinedAt: 1,
    }],
    interests: [],
    messages,
    work: workItems,
    executions: [],
    nextSequence: messages.length,
  };
}

it("filters work sections and follows up on a loaded source message", () => {
  const source = message("source", "Check the source claim");
  const active = work("active", "running");
  const completed = work("completed", "completed");
  completed.resolution = { summary: "The claim is supported.", resultRefs: [] };
  const onReply = vi.fn();

  const view = testing.render(
    <WorkView
      snapshot={snapshot([active, completed], [source])}
      busy={false}
      loadMessage={async () => null}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={onReply}
    />,
  );

  expect(view.getByTestId("work-active")).toBeTruthy();
  expect(view.getByTestId("work-completed")).toBeTruthy();
  const filter = view.getByLabelText("workFilter");
  testing.fireEvent.change(filter, { target: { value: "open" } });
  expect(view.getByTestId("work-active")).toBeTruthy();
  expect(view.queryByTestId("work-completed")).toBeNull();
  testing.fireEvent.change(filter, { target: { value: "completed" } });
  expect(view.queryByTestId("work-active")).toBeNull();
  expect(view.getByTestId("work-completed")).toBeTruthy();

  testing.fireEvent.click(testing.within(view.getByTestId("work-completed")).getByText("workFollowUp"));
  expect(onReply).toHaveBeenCalledWith(source);
});

it("loads exact annotation and event sources only when requested", async () => {
  const annotation: TaskAnnotation = {
    id: "annotation-1",
    target: {
      projectId: "p1",
      taskId: "t1",
      objectKind: "file",
      objectId: "notes.md",
      objectRevision: "4",
      path: "notes.md",
    },
    author: { kind: "user", id: "user-1" },
    body: "Please verify the retained claim.",
    parentId: null,
    mentions: ["m1"],
    explicitRequest: true,
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    handledAt: null,
    handledBy: null,
  };
  const event: GroupEvent = {
    sequence: 3,
    id: "event-1",
    groupId: "g1",
    kind: "file_changed",
    object: { kind: "file", id: "draft.md", revision: "2", path: "draft.md" },
    author: { kind: "member", id: "m1", executionId: null },
    detail: "The draft changed.",
    createdAt: 3,
  };
  const loadAnnotation = vi.fn(async () => annotation);
  const loadEvent = vi.fn(async () => event);

  const view = testing.render(
    <WorkView
      snapshot={snapshot([
        work("annotation-work", "pending", "annotation", "annotation-1"),
        {
          ...work("event-work", "pending", "event", "event-1"),
          reasons: [{
            kind: "interest_object",
            object: { kind: "file", id: "draft.md", revision: "2", path: "draft.md" },
          }],
        },
      ])}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={loadAnnotation}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const annotationSource = view.getByTestId("source-annotation-annotation-work");
  expect(loadAnnotation).not.toHaveBeenCalled();
  testing.fireEvent.click(testing.within(annotationSource).getByText("workReadSource"));
  await testing.waitFor(() => expect(testing.within(annotationSource).getByText("Please verify the retained claim.")).toBeTruthy());
  expect(testing.within(annotationSource).getByText("notes.md")).toBeTruthy();
  expect(loadAnnotation).toHaveBeenCalledWith("annotation-1");

  const eventSource = view.getByTestId("source-event-event-work");
  expect(loadEvent).not.toHaveBeenCalled();
  testing.fireEvent.click(testing.within(eventSource).getByText("workReadSource"));
  await testing.waitFor(() => expect(testing.within(eventSource).getByText("file_changed · draft.md")).toBeTruthy());
  expect(loadEvent).toHaveBeenCalledWith("event-1");
});

it("opens only exact historical result identities and keeps malformed references static", () => {
  const completed = work("history-result", "completed");
  completed.causeId = "source";
  completed.resolution = {
    summary: "Historical changes were retained.",
    resultRefs: [
      {
        projectId: "p1",
        taskId: "t1",
        objectKind: "message",
        objectId: "t1:2:5",
        objectRevision: "generation:2",
        path: "message-five",
      },
      {
        projectId: "p1",
        taskId: "t1",
        objectKind: "tool_call",
        objectId: "t1:3:8",
        objectRevision: "generation:3",
        path: "tool-output",
      },
      {
        projectId: "p1",
        taskId: "t1",
        objectKind: "message",
        objectId: "t1:2:6",
        objectRevision: "generation:3",
        path: "wrong-generation",
      },
      {
        projectId: "p1",
        taskId: "t1",
        objectKind: "tool_call",
        objectId: "t2:2:7",
        objectRevision: "generation:2",
        path: "foreign-task",
      },
    ],
  };
  const onOpenResult = vi.fn();

  const view = testing.render(
    <WorkView
      snapshot={snapshot([completed], [message("source", "Check the change")])}
      busy={false}
      loadMessage={async () => null}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
      onOpenResult={onOpenResult}
    />,
  );

  testing.fireEvent.click(view.getByRole("button", { name: "message-five · generation:2" }));
  testing.fireEvent.click(view.getByRole("button", { name: "tool-output · generation:3" }));
  expect(onOpenResult).toHaveBeenNthCalledWith(1, expect.objectContaining({ objectKind: "message", objectId: "t1:2:5" }));
  expect(onOpenResult).toHaveBeenNthCalledWith(2, expect.objectContaining({ objectKind: "tool_call", objectId: "t1:3:8" }));
  expect(view.queryByRole("button", { name: "wrong-generation · generation:3" })).toBeNull();
  expect(view.queryByRole("button", { name: "foreign-task · generation:2" })).toBeNull();
  expect(view.getByText("wrong-generation · generation:3")).toBeTruthy();
  expect(view.getByText("foreign-task · generation:2")).toBeTruthy();
});

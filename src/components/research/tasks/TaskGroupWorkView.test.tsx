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

function message(
  id: string,
  body: string,
  replyTo: string | null = null,
  groupId = "g1",
): GroupMessage {
  return {
    id,
    sequence: 1,
    groupId,
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
  groupId = "g1",
): GroupWork {
  return {
    id,
    groupId,
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

function eventWork(
  id: string,
  causeId = "event-1",
  groupId = "g1",
  path = "draft.md",
): GroupWork {
  const item = work(id, "pending", "event", causeId, groupId);
  item.reasons = [{
    kind: "interest_object",
    object: { kind: "file", id: path, revision: "2", path },
  }];
  return item;
}

function annotation(
  id = "annotation-1",
  body = "Please verify the retained claim.",
  path = "notes.md",
): TaskAnnotation {
  return {
    id,
    target: {
      projectId: "p1",
      taskId: "t1",
      objectKind: "file",
      objectId: path,
      objectRevision: "4",
      path,
    },
    author: { kind: "user", id: "user-1" },
    body,
    parentId: null,
    mentions: ["m1"],
    explicitRequest: true,
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    handledAt: null,
    handledBy: null,
  };
}

function event(
  id = "event-1",
  groupId = "g1",
  kind = "file_changed",
  path = "draft.md",
): GroupEvent {
  return {
    sequence: 3,
    id,
    groupId,
    kind,
    object: { kind: "file", id: path, revision: "2", path },
    author: { kind: "member", id: "m1", executionId: null },
    detail: "The draft changed.",
    createdAt: 3,
  };
}

function snapshot(
  workItems: GroupWork[],
  messages: GroupMessage[] = [],
  groupId = "g1",
): GroupSnapshot {
  return {
    group: {
      id: groupId,
      projectId: "p1",
      taskId: "t1",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
    },
    members: [{
      id: "m1",
      groupId,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  const retainedAnnotation = annotation();
  const changedEvent = event();
  const loadAnnotation = vi.fn(async () => retainedAnnotation);
  const loadEvent = vi.fn(async () => changedEvent);

  const view = testing.render(
    <WorkView
      snapshot={snapshot([
        work("annotation-work", "pending", "annotation", "annotation-1"),
        eventWork("event-work"),
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

it("clears a failed message error after a successful retry", async () => {
  const loadMessage = vi.fn()
    .mockRejectedValueOnce(new Error("Message unavailable"))
    .mockResolvedValueOnce(message("source", "Recovered source message"));
  const view = testing.render(
    <WorkView
      snapshot={snapshot([work("message-retry", "pending")])}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  const source = view.getByTestId("source-question-message-retry");

  testing.fireEvent.click(testing.within(source).getByRole("button", { name: "workReadSource" }));
  await testing.waitFor(() => {
    expect(testing.within(source).getByRole("alert").textContent).toBe("Message unavailable");
  });

  const retry = testing.within(source).getByRole("button", {
    name: "workReadSource",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  testing.fireEvent.click(retry);

  await testing.waitFor(() => {
    expect(testing.within(source).getByText("Recovered source message")).toBeTruthy();
  });
  expect(testing.within(source).queryByRole("alert")).toBeNull();
});

it("surfaces an event failure and retries to the recovered label", async () => {
  const loadEvent = vi.fn()
    .mockRejectedValueOnce(new Error("Event unavailable"))
    .mockResolvedValueOnce(event());
  const view = testing.render(
    <WorkView
      snapshot={snapshot([eventWork("event-retry")])}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  const source = view.getByTestId("source-event-event-retry");

  testing.fireEvent.click(testing.within(source).getByRole("button", { name: "workReadSource" }));
  await testing.waitFor(() => {
    expect(testing.within(source).getByRole("alert").textContent).toBe("Event unavailable");
  });
  await testing.waitFor(() => {
    const retry = testing.within(source).getByRole("button", {
      name: "workReadSource",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });

  testing.fireEvent.click(testing.within(source).getByRole("button", { name: "workReadSource" }));
  await testing.waitFor(() => {
    expect(testing.within(source).getByText("file_changed · draft.md")).toBeTruthy();
  });
});

it("surfaces an annotation failure and retries to the recovered body", async () => {
  const loadAnnotation = vi.fn()
    .mockRejectedValueOnce(new Error("Annotation unavailable"))
    .mockResolvedValueOnce(annotation());
  const view = testing.render(
    <WorkView
      snapshot={snapshot([work("annotation-retry", "pending", "annotation", "annotation-1")])}
      busy={false}
      loadMessage={async () => null}
      loadEvent={async () => null}
      loadAnnotation={loadAnnotation}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  const source = view.getByTestId("source-annotation-annotation-retry");

  testing.fireEvent.click(testing.within(source).getByRole("button", { name: "workReadSource" }));
  await testing.waitFor(() => {
    expect(testing.within(source).getByRole("alert").textContent).toBe("Annotation unavailable");
  });
  await testing.waitFor(() => {
    const retry = testing.within(source).getByRole("button", {
      name: "workReadSource",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });

  testing.fireEvent.click(testing.within(source).getByRole("button", { name: "workReadSource" }));
  await testing.waitFor(() => {
    expect(testing.within(source).getByText("Please verify the retained claim.")).toBeTruthy();
  });
  expect(testing.within(source).getByText("notes.md")).toBeTruthy();
});

it("does not let a late message from an old group block the current group", async () => {
  const oldMessage = deferred<GroupMessage | null>();
  const currentMessage = deferred<GroupMessage | null>();
  const loadMessage = vi.fn()
    .mockImplementationOnce(() => oldMessage.promise)
    .mockImplementationOnce(() => currentMessage.promise);
  const view = testing.render(
    <WorkView
      key="g1"
      snapshot={snapshot([work("message-scope", "pending")])}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  testing.fireEvent.click(
    testing.within(view.getByTestId("source-question-message-scope")).getByRole("button", {
      name: "workReadSource",
    }),
  );

  view.rerender(
    <WorkView
      key="g2"
      snapshot={snapshot([work("message-scope", "pending", "message", "source", "g2")], [], "g2")}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const currentSource = view.getByTestId("source-question-message-scope");
  const readCurrent = testing.within(currentSource).getByRole("button", {
    name: "workReadSource",
  }) as HTMLButtonElement;
  expect(readCurrent.disabled).toBe(false);
  testing.fireEvent.click(readCurrent);
  await testing.act(async () => {
    currentMessage.resolve(message("source", "Current group-two message", null, "g2"));
    await currentMessage.promise;
  });
  await testing.waitFor(() => {
    expect(testing.within(currentSource).getByText("Current group-two message")).toBeTruthy();
  });

  await testing.act(async () => {
    oldMessage.resolve(message("source", "Stale group-one message"));
    await oldMessage.promise;
  });

  expect(testing.within(currentSource).getByText("Current group-two message")).toBeTruthy();
  expect(currentSource.textContent).not.toContain("Stale group-one message");
});

it("ignores a late message failure from an old group", async () => {
  const oldMessage = deferred<GroupMessage | null>();
  const currentMessage = deferred<GroupMessage | null>();
  const loadMessage = vi.fn()
    .mockImplementationOnce(() => oldMessage.promise)
    .mockImplementationOnce(() => currentMessage.promise);
  const view = testing.render(
    <WorkView
      snapshot={snapshot([work("message-error-scope", "pending")])}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  testing.fireEvent.click(
    testing.within(view.getByTestId("source-question-message-error-scope")).getByRole("button", {
      name: "workReadSource",
    }),
  );

  view.rerender(
    <WorkView
      snapshot={snapshot([work("message-error-scope", "pending", "message", "source", "g2")], [], "g2")}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const currentSource = view.getByTestId("source-question-message-error-scope");
  testing.fireEvent.click(
    testing.within(currentSource).getByRole("button", { name: "workReadSource" }),
  );
  await testing.act(async () => {
    currentMessage.resolve(message("source", "Current group message", null, "g2"));
    await currentMessage.promise;
  });
  await testing.waitFor(() => {
    expect(testing.within(currentSource).getByText("Current group message")).toBeTruthy();
  });

  await testing.act(async () => {
    oldMessage.reject(new Error("Obsolete group message failed"));
    await oldMessage.promise.catch(() => {});
  });

  expect(testing.within(currentSource).getByText("Current group message")).toBeTruthy();
  expect(testing.within(currentSource).queryByRole("alert")).toBeNull();
});

it("does not publish an event resolved for an old group", async () => {
  const oldEvent = deferred<GroupEvent | null>();
  const currentEvent = deferred<GroupEvent | null>();
  const loadEvent = vi.fn()
    .mockImplementationOnce(() => oldEvent.promise)
    .mockImplementationOnce(() => currentEvent.promise);
  const view = testing.render(
    <WorkView
      snapshot={snapshot([eventWork("event-scope", "event-1", "g1")], [], "g1")}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  testing.fireEvent.click(
    testing.within(view.getByTestId("source-event-event-scope")).getByRole("button", {
      name: "workReadSource",
    }),
  );

  view.rerender(
    <WorkView
      snapshot={snapshot([eventWork("event-scope", "event-1", "g2")], [], "g2")}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const currentSource = view.getByTestId("source-event-event-scope");
  const readCurrent = testing.within(currentSource).getByRole("button", {
    name: "workReadSource",
  }) as HTMLButtonElement;
  expect(readCurrent.disabled).toBe(false);
  testing.fireEvent.click(readCurrent);
  await testing.act(async () => {
    currentEvent.resolve(event("event-1", "g2", "file_changed"));
    await currentEvent.promise;
  });
  await testing.waitFor(() => {
    expect(testing.within(currentSource).getByText("file_changed · draft.md")).toBeTruthy();
  });

  await testing.act(async () => {
    oldEvent.resolve(event("event-1", "g1", "stale_group_event"));
    await oldEvent.promise;
  });

  expect(testing.within(currentSource).getByText("file_changed · draft.md")).toBeTruthy();
  expect(currentSource.textContent).not.toContain("stale_group_event");
});

it("does not let an old event clear the current group's loading state", async () => {
  const oldEvent = deferred<GroupEvent | null>();
  const currentEvent = deferred<GroupEvent | null>();
  const loadEvent = vi.fn()
    .mockImplementationOnce(() => oldEvent.promise)
    .mockImplementationOnce(() => currentEvent.promise);
  const view = testing.render(
    <WorkView
      snapshot={snapshot([eventWork("event-loading-scope", "event-1", "g1")], [], "g1")}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  testing.fireEvent.click(
    testing.within(view.getByTestId("source-event-event-loading-scope")).getByRole("button", { name: "workReadSource" }),
  );
  view.rerender(
    <WorkView
      snapshot={snapshot([eventWork("event-loading-scope", "event-1", "g2")], [], "g2")}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const currentSource = view.getByTestId("source-event-event-loading-scope");
  testing.fireEvent.click(
    testing.within(currentSource).getByRole("button", { name: "workReadSource" }),
  );
  await testing.act(async () => {
    oldEvent.resolve(event("event-1", "g1", "old_group_event"));
    await oldEvent.promise;
  });
  const retryCurrent = testing.within(currentSource).getByRole("button", { name: "workReadSource" }) as HTMLButtonElement;
  expect(retryCurrent.disabled).toBe(true);

  await testing.act(async () => {
    currentEvent.reject(new Error("Current group event unavailable"));
    await currentEvent.promise.catch(() => {});
  });
  await testing.waitFor(() => expect(retryCurrent.disabled).toBe(false));
  expect(testing.within(currentSource).getByRole("alert").textContent).toBe("Current group event unavailable");
});

it("does not publish an annotation resolved for an old group", async () => {
  const oldAnnotation = deferred<TaskAnnotation | null>();
  const currentAnnotation = deferred<TaskAnnotation | null>();
  const loadAnnotation = vi.fn()
    .mockImplementationOnce(() => oldAnnotation.promise)
    .mockImplementationOnce(() => currentAnnotation.promise);
  const view = testing.render(
    <WorkView
      snapshot={snapshot([work("annotation-scope", "pending", "annotation", "annotation-1", "g1")], [], "g1")}
      busy={false}
      loadMessage={async () => null}
      loadEvent={async () => null}
      loadAnnotation={loadAnnotation}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  testing.fireEvent.click(
    testing.within(view.getByTestId("source-annotation-annotation-scope")).getByRole("button", {
      name: "workReadSource",
    }),
  );

  view.rerender(
    <WorkView
      snapshot={snapshot([
        work("annotation-scope", "pending", "annotation", "annotation-1", "g2"),
      ], [], "g2")}
      busy={false}
      loadMessage={async () => null}
      loadEvent={async () => null}
      loadAnnotation={loadAnnotation}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const currentSource = view.getByTestId("source-annotation-annotation-scope");
  const readCurrent = testing.within(currentSource).getByRole("button", {
    name: "workReadSource",
  }) as HTMLButtonElement;
  expect(readCurrent.disabled).toBe(false);
  testing.fireEvent.click(readCurrent);
  await testing.act(async () => {
    currentAnnotation.resolve(annotation("annotation-1", "Current group-two annotation", "group-two.md"));
    await currentAnnotation.promise;
  });
  await testing.waitFor(() => {
    expect(testing.within(currentSource).getByText("Current group-two annotation")).toBeTruthy();
  });
  expect(testing.within(currentSource).getByText("group-two.md")).toBeTruthy();

  await testing.act(async () => {
    oldAnnotation.resolve(annotation("annotation-1", "Stale group-one annotation", "group-one.md"));
    await oldAnnotation.promise;
  });

  expect(testing.within(currentSource).getByText("Current group-two annotation")).toBeTruthy();
  expect(testing.within(currentSource).getByText("group-two.md")).toBeTruthy();
  expect(currentSource.textContent).not.toContain("Stale group-one annotation");
});

it("loads a retained result with its reply parent and routes the exact dependency result", async () => {
  const source = message("source", "Check the retained evidence");
  const parent = message("result-parent", "Earlier answer in the retained thread");
  const result = message("result-evidence", "Exact retained result", parent.id);
  const dependencyResult = message("dependency-evidence", "Exact dependency result");
  const request = message("wait-request", "Please provide the exact evidence");
  const completed = work("retained-result", "completed");
  completed.resultMessageId = result.id;
  completed.resolution = { summary: "Evidence retained.", resultRefs: [] };
  completed.waits = [{
    requestMessageId: request.id,
    work: [{
      workId: "dependency-work",
      memberId: "m1",
      status: "completed",
      resultMessageId: dependencyResult.id,
    }],
  }];
  const workSnapshot = snapshot([completed], [source, request, dependencyResult]);
  workSnapshot.members[0].paused = true;
  const loadMessage = vi.fn(async (id: string) => {
    if (id === result.id) return result;
    if (id === parent.id) return parent;
    return null;
  });

  const view = testing.render(
    <WorkView
      snapshot={workSnapshot}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const card = view.getByTestId("work-retained-result");
  expect(view.getByText("paused")).toBeTruthy();
  testing.fireEvent.click(testing.within(card).getByText("workReadResult"));
  await testing.waitFor(() => {
    expect(testing.within(card).getByRole("button", { name: "workOpenResult" })).toBeTruthy();
  });
  expect(loadMessage.mock.calls).toEqual([[result.id]]);

  testing.fireEvent.click(
    testing.within(view.getByTestId("resolution-retained-result")).getByRole("button", {
      name: "workOpenResult",
    }),
  );
  await testing.waitFor(() => {
    expect(view.getByText(parent.body)).toBeTruthy();
  });
  expect(view.getByText(result.body)).toBeTruthy();
  expect(loadMessage.mock.calls).toEqual([[result.id], [parent.id]]);

  testing.fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(view.queryByText(parent.body)).toBeNull();

  testing.fireEvent.click(
    testing.within(view.getByTestId("waits-retained-result")).getByRole("button", {
      name: "workOpenResult",
    }),
  );
  await testing.waitFor(() => {
    expect(view.getByText(dependencyResult.body)).toBeTruthy();
  });
  expect(loadMessage.mock.calls).toEqual([[result.id], [parent.id]]);
});

it("keeps unavailable annotations, events and generic sources tied to their cause", async () => {
  const missingAnnotation = work(
    "missing-annotation",
    "pending",
    "annotation",
    "annotation-missing",
  );
  const missingEvent = eventWork(
    "missing-event",
    "event-missing",
    "g1",
    "retained/missing-event.md",
  );
  const genericObject = work("generic-object", "pending", "material", "file:missing");
  genericObject.reasons = [{
    kind: "interest_object",
    object: {
      kind: "file",
      id: "retained/generic.md",
      revision: "7",
      path: "retained/generic.md",
    },
  }];
  const genericUnavailable = work(
    "generic-unavailable",
    "pending",
    "material",
    "opaque-material-cause",
  );
  const unavailableThread = work("unavailable-thread", "completed");
  unavailableThread.waits = [{
    requestMessageId: "missing-wait-request",
    work: [{
      workId: "missing-dependency",
      memberId: "m1",
      status: "completed",
      resultMessageId: "missing-result-message",
    }],
  }];
  const loadEvent = vi.fn(async () => null);
  const loadAnnotation = vi.fn(async () => null);

  const view = testing.render(
    <WorkView
      snapshot={snapshot([
        missingAnnotation,
        missingEvent,
        genericObject,
        genericUnavailable,
        unavailableThread,
      ])}
      busy={false}
      loadMessage={async () => null}
      loadEvent={loadEvent}
      loadAnnotation={loadAnnotation}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const annotationSource = view.getByTestId("source-annotation-missing-annotation");
  testing.fireEvent.click(
    testing.within(annotationSource).getByRole("button", { name: "workReadSource" }),
  );
  await testing.waitFor(() => {
    expect(testing.within(annotationSource).getByText("workSourceUnavailable")).toBeTruthy();
  });

  const eventSource = view.getByTestId("source-event-missing-event");
  expect(testing.within(eventSource).getByText("retained/missing-event.md")).toBeTruthy();
  testing.fireEvent.click(
    testing.within(eventSource).getByRole("button", { name: "workReadSource" }),
  );
  await testing.waitFor(() => {
    expect(testing.within(eventSource).getByText("workSourceUnavailable")).toBeTruthy();
  });

  expect(loadAnnotation).toHaveBeenCalledExactlyOnceWith("annotation-missing");
  expect(loadEvent).toHaveBeenCalledExactlyOnceWith("event-missing");
  expect(testing.within(view.getByTestId("work-generic-object")).getByText("retained/generic.md"))
    .toBeTruthy();
  expect(testing.within(view.getByTestId("work-generic-unavailable")).getByText("workSourceUnavailable"))
    .toBeTruthy();

  testing.fireEvent.click(
    testing.within(view.getByTestId("waits-unavailable-thread")).getByRole("button", {
      name: "workOpenResult",
    }),
  );
  await testing.waitFor(() => {
    expect(view.getByText("workThreadUnavailable")).toBeTruthy();
  });
});

it("loads the exact waiting request and keeps its reply thread available", async () => {
  const waiting = work("waiting-request", "waiting");
  waiting.waits = [{ requestMessageId: "request-message", work: [] }];
  const request = message("request-message", "Please continue from this request");
  const loadMessage = vi.fn(async () => request);
  const view = testing.render(
    <WorkView
      snapshot={snapshot([waiting])}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );

  const waits = view.getByTestId("waits-waiting-request");
  expect(testing.within(waits).getByText("workWaitingRequest")).toBeTruthy();
  testing.fireEvent.click(testing.within(waits).getByText("workReadRequest"));
  await testing.waitFor(() => {
    expect(testing.within(waits).getByText(request.body)).toBeTruthy();
  });
  expect(loadMessage).toHaveBeenCalledExactlyOnceWith(request.id);

  testing.fireEvent.click(testing.within(waits).getByRole("button", { name: "workViewThread" }));
  await testing.waitFor(() => {
    expect(view.getByRole("region", { name: "workThread" })).toBeTruthy();
  });
  expect(view.getAllByText(request.body)).toHaveLength(2);

  view.rerender(
    <WorkView
      snapshot={snapshot([])}
      busy={false}
      loadMessage={loadMessage}
      loadEvent={async () => null}
      loadAnnotation={async () => null}
      renderDiagnostics={() => null}
      onReply={() => {}}
    />,
  );
  expect(view.getByText("workEmpty")).toBeTruthy();
});

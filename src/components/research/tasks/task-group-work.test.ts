import { describe, expect, it } from "vitest";
import type { GroupMessage, GroupWork } from "@/lib/task-collaboration";
import { partitionWork, replyThread } from "./task-group-work";

function work(id: string, status: GroupWork["status"]): GroupWork {
  return {
    id,
    groupId: "group",
    memberId: "member",
    causeKind: "message",
    causeId: "question",
    priority: 1,
    status,
    executionId: null,
    resultMessageId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function message(id: string, sequence: number, replyTo: string | null = null): GroupMessage {
  return {
    id,
    sequence,
    groupId: "group",
    author: { kind: "member", id: "member", executionId: null },
    body: id,
    recipients: [],
    replyTo,
    object: null,
    requestWork: false,
    createdAt: sequence,
  };
}

describe("task group work helpers", () => {
  it("separates one member's independent open and completed matters", () => {
    const items = [
      work("failed", "failed"),
      work("waiting", "waiting"),
      work("running", "running"),
      work("done", "completed"),
    ];

    expect(partitionWork(items, "open")).toEqual({
      needsFollowUp: [items[0], items[1]],
      active: [items[2]],
      completed: [],
    });
    expect(partitionWork(items, "completed").completed).toEqual([items[3]]);
    expect(partitionWork(items, "all").completed).toEqual([items[3]]);
  });

  it("keeps every loaded reply in a source question thread", () => {
    const messages = [
      message("root", 1),
      message("reply", 2, "root"),
      message("nested", 3, "reply"),
      message("other", 4),
    ];

    expect(replyThread(messages, "root").map((item) => item.id)).toEqual([
      "root",
      "reply",
      "nested",
    ]);
    expect(replyThread(messages, "nested").map((item) => item.id)).toEqual([
      "root",
      "reply",
      "nested",
    ]);
  });
});

import type { GroupMessage, GroupWork } from "@/lib/task-collaboration";

export type WorkFilter = "open" | "completed" | "all";

export interface WorkSections {
  needsFollowUp: GroupWork[];
  active: GroupWork[];
  completed: GroupWork[];
}

export function partitionWork(work: GroupWork[], filter: WorkFilter): WorkSections {
  const visible = work.filter((item) => {
    if (filter === "all") return true;
    if (filter === "completed") return item.status === "completed";
    return item.status !== "completed";
  });
  return {
    needsFollowUp: visible.filter((item) =>
      item.status === "waiting" || item.status === "checkpointed" || item.status === "failed",
    ),
    active: visible.filter((item) => item.status === "pending" || item.status === "running"),
    completed: visible.filter((item) => item.status === "completed"),
  };
}

export function replyThread(messages: GroupMessage[], rootId: string): GroupMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const root = byId.get(rootId);
  if (!root) return [];

  const included = new Set<string>([root.id]);
  let parentId = root.replyTo;
  const seenParents = new Set<string>();
  while (parentId && !seenParents.has(parentId)) {
    seenParents.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    included.add(parent.id);
    parentId = parent.replyTo;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (!message.replyTo || included.has(message.id)) continue;
      if (included.has(message.replyTo)) {
        included.add(message.id);
        changed = true;
      }
    }
  }

  return messages
    .filter((message) => included.has(message.id))
    .sort((left, right) => left.sequence - right.sequence);
}

export function workObject(work: GroupWork) {
  return work.reasons?.find((reason) => reason.object)?.object ?? null;
}

export function countOpenWork(work: GroupWork[]): number {
  return work.filter((item) => item.status !== "completed").length;
}

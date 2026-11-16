import type { ToolApprovalRequest } from "@/lib/ai-tools";
import type { ApprovalMode } from "@oleafly/ai-tools";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";

export interface RegisteredApproval {
  req: ToolApprovalRequest;
  resolve: (ok: boolean) => void;
  mode: ApprovalMode;
}

export interface ActiveChatRun {
  flowId: string;
  controller: AbortController;
  projectId: string | null;
  chatId: string | null;
  pendingApproval: RegisteredApproval | null;
  lastPartAt: number;
}

let active: ActiveChatRun | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of [...listeners]) fn();
}

export function beginChatRun(controller: AbortController, projectId: string | null): ActiveChatRun {
  active = { flowId: crypto.randomUUID(), controller, projectId, chatId: null, pendingApproval: null, lastPartAt: Date.now() };
  if (projectId) useAgentWorkspaceStore.getState().beginFollow(projectId, { kind: "chat", flowId: active.flowId, chatId: null });
  emit();
  return active;
}

export function updateChatRun(
  run: ActiveChatRun,
  patch: Partial<Pick<ActiveChatRun, "chatId" | "pendingApproval" | "lastPartAt">>,
): void {
  if (active !== run) return;
  Object.assign(run, patch);
  emit();
}

export function endChatRun(run: ActiveChatRun): void {
  if (active !== run) return;
  active = null;
  emit();
}

export function activeChatRun(): ActiveChatRun | null {
  return active;
}

export function subscribeChatRun(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

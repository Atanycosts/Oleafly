import { create } from "zustand";
import type { MaterialAnchor, MaterialKind } from "@/lib/material-surface";

export type AgentExecutionOrigin =
  | { kind: "chat"; flowId: string; chatId: string | null }
  | { kind: "task"; taskId: string; generation: number; memberId?: string | null; executionId?: string | null }
  | { kind: "external"; flowId: string };

export interface AgentWorkspaceSelection {
  revision: string;
  paragraphRef?: string;
  paraId?: string;
  quote?: string;
  anchor?: MaterialAnchor;
}

/** The viewed material is independent of the writable live Word session. */
export interface AgentWorkspaceView {
  projectId: string;
  documentId: string;
  title: string;
  kind: MaterialKind;
  role: "working" | "original" | "task_input" | "candidate" | "checked" | "evidence" | "result";
  revision: string;
  sessionId?: string;
  sessionRevision?: number;
  dirty?: boolean;
  selection?: AgentWorkspaceSelection | null;
}

export interface AgentWorkspaceTarget {
  projectId: string;
  sessionId: string;
  paragraphRef?: string;
  paraId?: string;
  sessionRevision?: number;
}

export interface AgentWorkspaceOperation {
  id: string;
  projectId: string;
  sessionId: string;
  title?: string;
  origin: AgentExecutionOrigin;
  operation: string;
  phase: "started" | "succeeded" | "failed";
  target?: AgentWorkspaceTarget;
  result?: unknown;
  error?: string;
}

export interface AgentWorkspaceNavigation {
  sequence: number;
  operationId: string;
  flowKey: string;
  target: AgentWorkspaceTarget;
}

export function agentExecutionFlowKey(origin: AgentExecutionOrigin): string {
  return origin.kind === "task" ? `task:${origin.taskId}:${origin.generation}` : `${origin.kind}:${origin.flowId}`;
}

interface AgentWorkspaceState {
  projectId: string | null;
  views: Record<string, AgentWorkspaceView>;
  operations: AgentWorkspaceOperation[];
  following: { projectId: string; flowKey: string } | null;
  paused: boolean;
  latestTarget: AgentWorkspaceNavigation | null;
  navigation: AgentWorkspaceNavigation | null;
  sequence: number;
  intentRevision: number;
  setProject(projectId: string | null): void;
  publishView(view: AgentWorkspaceView): void;
  clearView(projectId: string, documentId?: string): void;
  beginFollow(projectId: string, origin: AgentExecutionOrigin): void;
  pause(): void;
  resume(): void;
  report(operation: AgentWorkspaceOperation): void;
}

/** Ephemeral UI projection of real calls/receipts. Domain records remain in their existing stores. */
export const useAgentWorkspaceStore = create<AgentWorkspaceState>((set) => ({
  projectId: null,
  views: {},
  operations: [],
  following: null,
  paused: false,
  latestTarget: null,
  navigation: null,
  sequence: 0,
  intentRevision: 0,
  setProject: (projectId) => set((state) => state.projectId === projectId ? state : ({
    projectId, following: null, paused: false, latestTarget: null, navigation: null, intentRevision: state.intentRevision + 1,
  })),
  publishView: (view) => set((state) => ({ views: { ...state.views, [view.projectId]: view } })),
  clearView: (projectId, documentId) => set((state) => {
    if (documentId && state.views[projectId]?.documentId !== documentId) return state;
    const views = { ...state.views };
    delete views[projectId];
    return { views };
  }),
  beginFollow: (projectId, origin) => set((state) => {
    const flowKey = agentExecutionFlowKey(origin);
    const operation = [...state.operations].reverse().find((item) => item.projectId === projectId &&
      agentExecutionFlowKey(item.origin) === flowKey && item.target);
    const latestTarget = operation?.target ? { sequence: state.sequence + 1, operationId: operation.id,
      flowKey, target: operation.target } : null;
    return { following: { projectId, flowKey }, paused: false, latestTarget,
      navigation: projectId === state.projectId ? latestTarget : null, sequence: state.sequence + 1, intentRevision: state.intentRevision + 1 };
  }),
  pause: () => set((state) => ({ paused: true, intentRevision: state.intentRevision + 1 })),
  resume: () => set((state) => ({
    paused: false,
    navigation: state.latestTarget && state.latestTarget.target.projectId === state.projectId
      ? { ...state.latestTarget, sequence: state.sequence + 1 } : state.navigation,
    sequence: state.sequence + 1,
    intentRevision: state.intentRevision + 1,
  })),
  report: (operation) => set((state) => {
    const operations = [...state.operations.filter((item) => item.id !== operation.id), operation].slice(-100);
    const flowKey = agentExecutionFlowKey(operation.origin);
    if (!operation.target || operation.projectId !== state.projectId ||
      state.following?.projectId !== operation.projectId || state.following.flowKey !== flowKey) return { operations };
    const latestTarget = { sequence: state.sequence + 1, operationId: operation.id, flowKey, target: operation.target };
    return { operations, latestTarget, sequence: latestTarget.sequence,
      ...(state.paused ? {} : { navigation: latestTarget }) };
  }),
}));

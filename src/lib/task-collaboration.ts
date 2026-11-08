import { invoke } from "@tauri-apps/api/core";

export interface AnnotationTarget {
  projectId: string;
  taskId: string | null;
  objectKind: string;
  objectId: string;
  objectRevision: string | null;
  path: string | null;
}

export interface AnnotationAuthor {
  kind: "user" | "member" | "model" | "system";
  id: string;
}

export interface TaskAnnotation {
  id: string;
  target: AnnotationTarget;
  author: AnnotationAuthor;
  body: string;
  parentId: string | null;
  mentions: string[];
  explicitRequest: boolean;
  status: "open" | "handled" | "dismissed";
  createdAt: number;
  updatedAt: number;
  handledAt: number | null;
  handledBy: AnnotationAuthor | null;
}

export interface AnnotationHandling {
  id: string;
  annotationId: string;
  author: AnnotationAuthor;
  summary: string;
  resultRefs: AnnotationTarget[];
  createdAt: number;
}

export interface RequirementScope {
  projectId: string;
  taskId: string | null;
  objectKind: string | null;
  objectId: string | null;
  objectRevision: string | null;
  path: string | null;
}

export interface EnduringRequirement {
  id: string;
  scope: RequirementScope;
  author: AnnotationAuthor;
  text: string;
  kind: "candidate" | "enduring";
  status: "active" | "withdrawn" | "superseded";
  sourceAnnotationId: string | null;
  replacedBy: string | null;
  createdAt: number;
  updatedAt: number;
  withdrawnAt: number | null;
}

export interface Distillation {
  id: string;
  sourceAnnotationId: string;
  handlingId: string;
  author: AnnotationAuthor;
  rationale: string;
  outcome: "promoted" | "candidate" | "no_enduring_requirement" | "needs_review";
  requirementId: string | null;
  replacedRequirementId: string | null;
  createdAt: number;
}

export interface AnnotationContext {
  annotations: TaskAnnotation[];
  deliveries: { annotationId: string; deliveredGeneration: number | null; deliveredAt: number | null }[];
  requirements: EnduringRequirement[];
  handlings: AnnotationHandling[];
  distillations: Distillation[];
}

export interface TaskAnnotationDraft {
  target: AnnotationTarget;
  body: string;
  parentId: string | null;
  mentions: string[];
  explicitRequest: boolean;
}

export const loadTaskAnnotations = (projectId: string, taskId: string) =>
  invoke<AnnotationContext>("research_task_annotations", { projectId, taskId });

export const loadObjectAnnotations = (target: AnnotationTarget) =>
  invoke<AnnotationContext>("research_object_annotations", { target });

export const submitTaskAnnotation = (draft: TaskAnnotationDraft) =>
  invoke<TaskAnnotation>("research_task_annotation_submit", { draft });

export type GroupStatus = "open" | "paused" | "closed";

export interface GroupActor {
  kind: "user" | "member" | "system";
  id: string;
  executionId: string | null;
}

export interface GroupObject {
  kind: string;
  id: string;
  revision: string | null;
  path: string | null;
}

export interface TaskGroup {
  id: string;
  taskId: string | null;
  projectId: string;
  status: GroupStatus;
  createdAt: number;
  updatedAt: number;
}

export interface MemberDraft {
  name: string;
  responsibility: string;
  runtimeId: string;
  agentId: string;
  modelId: string;
  skillIds: string[];
  coordinator: boolean;
}

export interface GroupMember extends MemberDraft {
  id: string;
  groupId: string;
  paused: boolean;
  joinedAt: number;
}

export interface MemberInterest {
  memberId: string;
  kind: "path" | "object" | "event";
  value: string;
}

export interface MessageDraft {
  body: string;
  recipients: string[];
  replyTo: string | null;
  object: GroupObject | null;
  requestWork: boolean;
}

export interface GroupMessage extends MessageDraft {
  id: string;
  sequence: number;
  groupId: string;
  author: GroupActor;
  createdAt: number;
}

export interface GroupWork {
  id: string;
  groupId: string;
  memberId: string;
  causeKind: string;
  causeId: string;
  priority: number;
  status: "pending" | "running" | "waiting" | "completed" | "failed";
  executionId: string | null;
  resultMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemberExecution {
  id: string;
  groupId: string;
  memberId: string;
  taskGeneration: number;
  sessionId: string;
  runtimeId: string;
  agentId: string;
  modelId: string;
  providerId: string | null;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface GroupSnapshot {
  group: TaskGroup;
  members: GroupMember[];
  interests: MemberInterest[];
  messages: GroupMessage[];
  work: GroupWork[];
  executions: MemberExecution[];
  nextSequence: number;
}

export const loadTaskGroup = (projectId: string, taskId: string) =>
  invoke<GroupSnapshot | null>("research_task_group", { projectId, taskId });

export const loadTaskGroupMessages = (projectId: string, groupId: string, afterSequence: number) =>
  invoke<GroupSnapshot>("research_task_group_snapshot", { projectId, groupId, afterSequence });

export const createTaskGroup = (projectId: string, taskId: string, members: MemberDraft[]) =>
  invoke<GroupSnapshot>("research_task_group_create", { projectId, taskId, members });

export const sendGroupMessage = (projectId: string, groupId: string, draft: MessageDraft) =>
  invoke<GroupMessage>("research_task_group_message", { projectId, groupId, draft });

export const setTaskGroupStatus = (projectId: string, groupId: string, status: GroupStatus) =>
  invoke<void>("research_task_group_status", { projectId, groupId, status });

export const setGroupMemberPaused = (projectId: string, groupId: string, memberId: string, paused: boolean) =>
  invoke<void>("research_task_group_member_paused", { projectId, groupId, memberId, paused });

export const setGroupMemberInterest = (projectId: string, groupId: string, interest: MemberInterest, active: boolean) =>
  invoke<void>("research_task_group_interest", { projectId, groupId, interest, active });

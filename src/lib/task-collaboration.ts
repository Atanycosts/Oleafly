import { invoke } from "@tauri-apps/api/core";

export interface AnnotationTarget {
  projectId: string;
  taskId: string | null;
  objectKind: string;
  objectId: string;
  objectRevision: string | null;
  path: string | null;
}

export interface AnnotationSourceDraft {
  kind: string;
  content: string;
}

export interface AnnotationSource extends AnnotationSourceDraft {
  sha256: string;
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
  source?: AnnotationSource | null;
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
  promotedFromRequirementId?: string | null;
  replacedRequirementId: string | null;
  createdAt: number;
}

export interface AnnotationContext {
  annotations: TaskAnnotation[];
  deliveries: { annotationId: string; preparedGeneration: number | null; preparedAt: number | null; deliveredGeneration: number | null; deliveredAt: number | null }[];
  requirements: EnduringRequirement[];
  handlings: AnnotationHandling[];
  distillations: Distillation[];
}

export interface TaskAnnotationDraft {
  target: AnnotationTarget;
  body: string;
  source?: AnnotationSourceDraft;
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

export interface WorkReason {
  kind: string;
  detail?: string;
  object?: GroupObject;
  sourceId?: string;
  executionId?: string;
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
  reasons?: WorkReason[];
  createdAt: number;
  updatedAt: number;
}

export interface MemberAttention {
  memberId: string;
  object: GroupObject;
  relation: "read" | "wrote" | "handled";
  sourceId: string;
  executionId: string | null;
  updatedAt: number;
}

export interface GroupEvent {
  sequence: number;
  id: string;
  groupId: string;
  kind: string;
  object: GroupObject;
  author: GroupActor;
  detail: string;
  evidence?: unknown;
  createdAt: number;
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
  attentions?: MemberAttention[];
  messages: GroupMessage[];
  work: GroupWork[];
  executions: MemberExecution[];
  events?: GroupEvent[];
  eventsHasMore?: boolean;
  executionsHasMore?: boolean;
  nextSequence: number;
}

export interface GroupEventPage {
  events: GroupEvent[];
  hasMore: boolean;
}

export interface GroupExecutionPage {
  executions: MemberExecution[];
  hasMore: boolean;
}

export const loadTaskGroup = (projectId: string, taskId: string) =>
  invoke<GroupSnapshot | null>("research_task_group", { projectId, taskId });

export const loadTaskGroupMessages = (projectId: string, taskId: string, groupId: string, afterSequence: number) =>
  invoke<GroupSnapshot>("research_task_group_snapshot", { projectId, taskId, groupId, afterSequence });

export const loadTaskGroupEventsPage = (projectId: string, taskId: string, groupId: string, beforeSequence: number | null, limit = 100) =>
  invoke<GroupEventPage>("research_task_group_events_page", { projectId, taskId, groupId, beforeSequence, limit });

export const loadTaskGroupExecutionsPage = (projectId: string, taskId: string, groupId: string, beforeStartedAt: number | null, beforeId: string | null, limit = 100) =>
  invoke<GroupExecutionPage>("research_task_group_executions_page", { projectId, taskId, groupId, beforeStartedAt, beforeId, limit });

export const loadTaskGroupEventsAfter = (projectId: string, taskId: string, groupId: string, afterSequence: number, limit = 100) =>
  invoke<GroupEventPage>("research_task_group_events_after", { projectId, taskId, groupId, afterSequence, limit });

export const loadTaskGroupExecutionsAfter = (projectId: string, taskId: string, groupId: string, afterStartedAt: number, afterId: string, limit = 100) =>
  invoke<GroupExecutionPage>("research_task_group_executions_after", { projectId, taskId, groupId, afterStartedAt, afterId, limit });

export const loadTaskGroupEvent = (projectId: string, taskId: string, groupId: string, eventId: string) =>
  invoke<GroupEvent | null>("research_task_group_event", { projectId, taskId, groupId, eventId });

export const loadTaskGroupExecution = (projectId: string, taskId: string, groupId: string, executionId: string) =>
  invoke<MemberExecution | null>("research_task_group_execution", { projectId, taskId, groupId, executionId });

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

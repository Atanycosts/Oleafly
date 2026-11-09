import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EffortLevel } from "@oleafly/ai-core";
import type { ProjectStateChanged } from "@/lib/tauri";

export type ResearchTaskStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled"
  | "plan_ready";

export type TaskIsolationKind = "git_worktree" | "staged_project";
export type TaskFileChangeKind = "added" | "modified" | "deleted";

export type SkipReason = "too_large" | "link_outside" | "link_to_folder" | "broken_link" | "not_unicode";

export interface TaskIsolationSummary {
  kind: TaskIsolationKind;
  executionRoot: string;
  sourceRevision: string;
  baselineHash: string;
  fileCount: number;
  createdAt: number;
  skipped?: { path: string; reason: SkipReason }[];
  initialGitStatus?: string[] | null;
  initialGitStatusComplete?: boolean | null;
}

export type MetricGoal = "maximize" | "minimize";
export type CommandPolicy = "allow" | "ask" | "off";
export type RunProfile = "analysis" | "training";
export type TaskPhase =
  | "preparing"
  | "planning"
  | "working"
  | "waiting_runs"
  | "waiting_approval"
  | "wrapping_up"
  | "checking_evidence";
export type StopReason = "budget_time" | "budget_cost" | "budget_runs";
export type RetryMode = "resume" | "fresh";
export type OwnerKind = "app" | "daemon";

export interface PrimaryMetric {
  name: string;
  goal: MetricGoal;
}

export interface TaskBudget {
  wallClockMinutes: number;
  usdCap: number | null;
  maxRuns: number | null;
  runTimeoutMinutes: number;
}

export interface ComputeResources {
  timeMinutes: number | null;
  partition: string | null;
  gpus: number | null;
  cpus: number | null;
  memoryGb: number | null;
  account: string | null;
  qos: string | null;
}

export interface ResearchBrief {
  goal: string;
  successCriteria: string[];
  scope: string;
  constraints: string;
  primaryMetric: PrimaryMetric | null;
  reviewPlanFirst: boolean;
  permissions: { network: boolean; commands: CommandPolicy; desktopApps: boolean };
  budget: TaskBudget;
  reasoningEffort: EffortLevel | null;
  profile: RunProfile;
  compute: { executor: string; target: string | null; resources: ComputeResources | null };
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export type EvidenceCheckId = "build" | "references" | "bibliography" | "numbers" | "figures";
export type EvidenceStatus = "pass" | "warn" | "skipped";

export interface EvidenceItem {
  code: string;
  file: string | null;
  line: number | null;
  params: Record<string, string>;
  provenance?: CheckProvenance;
}

export interface FindingSource {
  path: string; fileSha256: string; lineStart: number; lineEnd: number;
  quote: string; quoteSha256: string;
}

export interface CheckProvenance {
  ruleVersion: string; source: FindingSource; runId: string; runSha256: string;
  ledgerContainsRun: boolean;
}

export type FindingDisposition = "open" | "accepted" | "rejected" | "deferred";
export type FindingValidity = "current" | "stale" | "unknown";
export interface FindingView {
  sequence: number;
  finding: {
    id: string; taskId: string; executionGeneration: number; origin: string;
    verdict: string; severity: string; item: EvidenceItem; createdAt: number;
  };
  validity: FindingValidity;
  changedDependencies: { dependency: string; expected: string; actual: string | null }[];
  unavailable: string[]; disposition: FindingDisposition;
  history: { sequence: number; disposition: FindingDisposition; rationale: string; actor: string; source: string; createdAt: number }[];
  historyCount: number;
}

export interface FindingPage {
  taskId: string; executionGeneration: number; findings: FindingView[];
  nextSequence: number; hasMore: boolean; coverageGaps: string[];
}

export const loadResearchTaskFindings = (taskId: string, executionGeneration: number, afterSequence = 0, limit = 20) =>
  invoke<FindingPage>("research_task_findings", { taskId, executionGeneration, query: { after_sequence: afterSequence, limit } });

export const decideResearchTaskFinding = (taskId: string, executionGeneration: number, findingId: string, disposition: FindingDisposition, rationale: string) =>
  invoke<void>("research_task_finding_decide", { taskId, executionGeneration, findingId, decision: { disposition, rationale } });

export const previewResearchTaskFindingSource = (taskId: string, executionGeneration: number, findingId: string) =>
  invoke<FindingSource>("research_task_finding_source", { taskId, executionGeneration, findingId });

export interface EvidenceReport {
  checkedAt: number;
  checks: { id: EvidenceCheckId; status: EvidenceStatus; items: EvidenceItem[] }[];
}

export type RunState = "starting" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";

export interface RunRecord {
  taskId: string;
  runId: string;
  executionGeneration: number;
  name: string;
  executor: string;
  command: string;
  cwdRel: string;
  state: RunState;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  runDir: string;
  metrics: Record<string, number>;
  reported: boolean;
}

export type ApprovalKind = "command" | "run" | "mcp";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "withdrawn";

export interface ApprovalRecord {
  id: string;
  taskId: string;
  executionGeneration: number;
  kind: ApprovalKind;
  summary: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

export function defaultBrief(goal = ""): ResearchBrief {
  return {
    goal,
    successCriteria: [],
    scope: "",
    constraints: "",
    primaryMetric: null,
    reviewPlanFirst: false,
    permissions: { network: false, commands: "allow", desktopApps: false },
    budget: { wallClockMinutes: 120, usdCap: null, maxRuns: null, runTimeoutMinutes: 60 },
    reasoningEffort: null,
    profile: "analysis",
    compute: { executor: "local", target: null, resources: null },
  };
}

export interface TaskFileChange {
  path: string;
  kind: TaskFileChangeKind;
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeSize: number | null;
  afterSize: number | null;
}

export interface TaskArtifact {
  path: string;
  label: string;
  mediaType: string | null;
}

export interface TaskResultMetadata {
  summary: string;
  changedFiles: TaskFileChange[];
  artifacts: TaskArtifact[];
  nativeSessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TaskReviewResult {
  selectedPaths: string[];
  appliedAt: number;
  projectMutationGeneration: number;
}

export interface ResearchTask {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  runtimeId: string;
  agentId: string;
  modelId: string;
  skillIds: string[];
  dependencyIds: string[];
  status: ResearchTaskStatus;
  executionGeneration: number;
  sessionId: string | null;
  nativeSessionId: string | null;
  sourceRevision: string | null;
  isolation: TaskIsolationSummary | null;
  error: string | null;
  result: TaskResultMetadata | null;
  review: TaskReviewResult | null;
  startRequested: boolean;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  brief: ResearchBrief;
  recordSlug: string;
  recordDir: string;
  runAfter: number | null;
  keepRunningAfterQuit: boolean;
  owner: OwnerKind;
  phase: TaskPhase | null;
  planApproved: boolean;
  stopReason: StopReason | null;
  evidence: EvidenceReport | null;
  pendingApprovals: number;
  activeMs: number;
  todos: TodoItem[];
  reclaimRequested: boolean;
  resumedFrom: number | null;
}

export interface ResearchTaskDraft {
  projectId: string;
  title: string;
  prompt: string;
  runtimeId: string;
  agentId: string;
  modelId: string;
  skillIds: string[];
  dependencyIds: string[];
  brief?: ResearchBrief;
  runAfter?: number | null;
  keepRunningAfterQuit?: boolean;
}

type RawTask = Partial<ResearchTask> & Pick<ResearchTask, "id" | "projectId" | "status">;

export function normalizeTask(raw: RawTask): ResearchTask {
  const brief = { ...defaultBrief(), ...raw.brief };
  return {
    title: "",
    prompt: "",
    runtimeId: "",
    agentId: "",
    modelId: "",
    skillIds: [],
    dependencyIds: [],
    executionGeneration: 0,
    sessionId: null,
    nativeSessionId: null,
    sourceRevision: null,
    isolation: null,
    error: null,
    result: null,
    review: null,
    startRequested: false,
    cancelRequested: false,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    finishedAt: null,
    recordSlug: "",
    recordDir: "",
    runAfter: null,
    keepRunningAfterQuit: false,
    owner: "app",
    phase: null,
    planApproved: false,
    stopReason: null,
    evidence: null,
    pendingApprovals: 0,
    activeMs: 0,
    todos: [],
    reclaimRequested: false,
    resumedFrom: null,
    ...raw,
    brief: {
      ...brief,
      reasoningEffort: raw.brief?.reasoningEffort ?? null,
      permissions: { ...defaultBrief().permissions, ...raw.brief?.permissions },
      budget: { ...defaultBrief().budget, ...raw.brief?.budget },
      compute: { ...defaultBrief().compute, ...raw.brief?.compute },
    },
  };
}

export type ResearchTaskEdit = Omit<ResearchTaskDraft, "projectId">;

export type TaskToolPhase = "request" | "result" | "update";

export interface TaskToolEvent {
  kind: "tool";
  name: string;
  detail: string;
  callId?: string | null;
  phase?: TaskToolPhase;
  status?: string | null;
}

export type TaskRuntimeEvent =
  | { kind: "observation"; observation: TaskObservation }
  | { kind: "sessionBound"; nativeSessionId: string }
  | { kind: "status"; message: string }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | TaskToolEvent
  | { kind: "artifact"; artifact: TaskArtifact }
  | { kind: "usage"; inputTokens: number | null; outputTokens: number | null }
  | { kind: "run"; runId: string; name: string; state: RunState; exitCode: number | null }
  | { kind: "approval"; approvalId: string; approvalKind: ApprovalKind; status: ApprovalStatus; summary: string }
  | { kind: "phase"; phase: TaskPhase };

export type TaskObservation =
  | { type: "member"; memberId: string; executionId: string; triggerIds: string[]; status: string }
  | { type: "requestContext"; sessionId: string; tools: { name: string; source: string; schemaSha256: string }[];
      schemaBytes: number; catalogBytes: number; skillBytes: number; requirementIds: string[] }
  | { type: "runtime"; runtimeId: string; providerId: string; modelId: string; sessionId: string;
      tools: { name: string; source: string; schemaSha256: string }[]; declaredSkills: string[];
      injectedSkills: { id: string; sectionSha256: string }[]; unavailable: string[] }
  | { type: "toolRequested"; callId: string; name: string; inputSha256: string; actor?: string | null }
  | { type: "toolExecution"; callId: string; name: string; status: string; inputSha256: string; outputSha256: string;
      skillId: string | null; skillInstructionsSha256: string | null;
      source: { path: string; fileSha256: string; offset: number; endOffset: number; truncated: boolean; snapshotRetained: boolean | null; pdf?: { path: string; sha256: string; pageCount: number; pageStart: number | null; pageEnd: number | null } | null } | null;
      actor?: string | null }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null };

export interface TaskObservationView {
  summary: {
    taskId: string; projectId: string; executionGeneration: number;
    status: ResearchTaskStatus; goal: string; successCriteria: string[];
    runtime: TaskTranscriptEvent | null; usage: TaskTranscriptEvent | null;
    baseline: TaskIsolationSummary | null;
    changedFiles: TaskFileChange[]; changedFileCount: number; evidence: EvidenceReport | null;
    coverageGaps: string[];
  };
  page: { events: TaskTranscriptEvent[]; nextSequence: number; throughSequence: number; hasMore: boolean };
}

export const loadResearchTaskObservations = (taskId: string, executionGeneration: number, afterSequence = 0, limit = 20) =>
  invoke<TaskObservationView>("research_task_observations", { taskId, executionGeneration, afterSequence, limit });

export const loadResearchTaskObservationCall = (taskId: string, executionGeneration: number, callId: string) =>
  invoke<TaskTranscriptEvent | null>("research_task_observation_call", { taskId, executionGeneration, callId });

export const previewResearchTaskSource = (taskId: string, executionGeneration: number, sequence: number) =>
  invoke<{ source: NonNullable<Extract<TaskObservation, { type: "toolExecution" }>["source"]>; text: string }>(
    "research_task_source_preview", { taskId, executionGeneration, sequence },
  );

export interface TaskTranscriptEvent {
  taskId: string;
  executionGeneration: number;
  sequence: number;
  event: TaskRuntimeEvent;
  createdAt: number;
  textStart?: number;
}

export interface TaskTranscriptPage {
  events: TaskTranscriptEvent[];
  nextSequence: number | null;
  previousSequence?: number | null;
  resumedFrom?: number | null;
}

export const NEWEST_EVENTS = Number.MAX_SAFE_INTEGER;

export interface TaskApplyResult {
  task: ResearchTask;
  projectState: ProjectStateChanged;
}

export interface TaskPreviewContent {
  exists: boolean;
  text: string | null;
  base64: string | null;
  mediaType: string | null;
  binary: boolean;
  truncated: boolean;
  size: number | null;
  sha256: string | null;
}

export interface TaskFilePreview {
  path: string;
  change: TaskFileChangeKind;
  before: TaskPreviewContent;
  after: TaskPreviewContent;
  projectSha256: string | null;
  baseIsCurrent: boolean;
  mergesWithShared: boolean;
}

export interface TaskArtifactPreview {
  artifact: TaskArtifact;
  content: TaskPreviewContent;
}

const normalized = (task: Promise<ResearchTask>) => task.then(normalizeTask);

export const listResearchTasks = (projectId: string) =>
  invoke<ResearchTask[]>("research_task_list", { projectId }).then((tasks) => tasks.map(normalizeTask));

export const createResearchTask = (draft: ResearchTaskDraft) =>
  normalized(invoke<ResearchTask>("research_task_create", { draft }));

export const createDelegatedResearchTask = (
  draft: ResearchTaskDraft,
  delegation: import("@/lib/assistant-delegation").AssistantDelegation,
) => normalized(invoke<ResearchTask>("research_task_create_with_inputs", { draft, delegation, journalInput: null }));

export interface TaskCompiledArtifact {
  taskId: string;
  generation: number;
  inputFingerprint: string;
  sourceRevision: string;
  outputId: string | null;
  pdfSha256: string;
  size: number;
  mainDocument: string;
  path: string;
}

export const listTaskCompiledPdfs = (taskId: string, generation: number) =>
  invoke<TaskCompiledArtifact[]>("research_task_compiled_pdfs", { taskId, generation });

export const readTaskCompiledPdf = (taskId: string, generation: number, reference: TaskCompiledArtifact) =>
  invoke<ArrayBuffer>("research_task_compiled_pdf_read", { taskId, generation, reference });

export const editResearchTask = (taskId: string, edit: ResearchTaskEdit) =>
  normalized(invoke<ResearchTask>("research_task_edit", { taskId, edit }));

export const startResearchTask = (taskId: string) =>
  normalized(invoke<ResearchTask>("research_task_start", { taskId }));

export const cancelResearchTask = (taskId: string) =>
  normalized(invoke<ResearchTask>("research_task_cancel", { taskId }));

export const retryResearchTask = (taskId: string, mode: RetryMode = "fresh") =>
  normalized(invoke<ResearchTask>("research_task_retry", { taskId, mode }));

export const acceptResearchTaskResult = (taskId: string) =>
  normalized(invoke<ResearchTask>("research_task_accept_result", { taskId }));

export const deleteResearchTask = (taskId: string) =>
  invoke<void>("research_task_delete", { taskId });

export const setResearchTaskKeepRunning = (taskId: string, keep: boolean) =>
  normalized(invoke<ResearchTask>("research_task_set_keep_running", { taskId, keep }));

export const applyResearchTask = (
  taskId: string,
  expectedProjectGeneration: number,
  selectedPaths: string[],
) =>
  invoke<TaskApplyResult>("research_task_apply", {
    request: { taskId, expectedProjectGeneration, selectedPaths },
  }).then((result) => ({ ...result, task: normalizeTask(result.task) }));

export const loadResearchTaskEvents = (
  taskId: string,
  executionGeneration: number,
  afterSequence?: number,
  limit = 100,
) =>
  invoke<TaskTranscriptPage>("research_task_events", {
    taskId,
    executionGeneration,
    afterSequence: afterSequence ?? null,
    limit,
  });

export const loadResearchTaskEventsBefore = (
  taskId: string,
  executionGeneration: number,
  beforeSequence: number,
  limit = 100,
) =>
  invoke<TaskTranscriptPage>("research_task_events", {
    taskId,
    executionGeneration,
    beforeSequence,
    limit,
  });

export const previewResearchTaskFile = (taskId: string, path: string) =>
  invoke<TaskFilePreview>("research_task_file_preview", { taskId, path });

export const previewResearchTaskArtifact = (taskId: string, path: string, executionGeneration: number) =>
  invoke<TaskArtifactPreview>("research_task_artifact_preview", { taskId, path, executionGeneration });

export const listenForResearchTaskChanges = (
  onTask: (task: ResearchTask) => void,
): Promise<UnlistenFn> =>
  listen<ResearchTask>("research-task-changed", (event) => onTask(normalizeTask(event.payload)));

export const listenForResearchTaskEvents = (
  onEvent: (event: TaskTranscriptEvent) => void,
): Promise<UnlistenFn> =>
  listen<TaskTranscriptEvent>("research-task-event", (event) => onEvent(event.payload));

export interface TaskTranscriptDelta {
  taskId: string;
  executionGeneration: number;
  sequence: number;
  kind: "text" | "reasoning";
  append: string;
  createdAt: number;
  textLength?: number;
}

export const listenForResearchTaskDeltas = (
  onDelta: (delta: TaskTranscriptDelta) => void,
): Promise<UnlistenFn> =>
  listen<TaskTranscriptDelta>("research-task-delta", (event) => onDelta(event.payload));

export const watchResearchTask = (taskId: string | null) =>
  invoke<void>("research_task_watch", { taskId });

export interface TaskPlanText {
  text: string;
  truncated: boolean;
}

export const MAX_PLAN_BYTES = 64 * 1024;

export const loadResearchTaskPlan = (taskId: string) =>
  invoke<TaskPlanText | string>("research_task_plan", { taskId }).then(
    (plan): TaskPlanText => (typeof plan === "string" ? { text: plan, truncated: false } : plan),
  );

export const approveResearchTaskPlan = (taskId: string, editedPlan?: string) =>
  normalized(
    invoke<ResearchTask>("research_task_approve_plan", { taskId, editedPlan: editedPlan ?? null }),
  );

export interface PlanItem {
  text: string;
  done: boolean;
}

export interface LedgerRow {
  id: string;
  time: string;
  hypothesis: string;
  change: string;
  command: string;
  metrics: Record<string, number>;
  verdict: string;
  notes: string;
}

export interface BestMetric {
  name: string;
  value: number;
  runId: string;
  series: number[];
}

export interface BudgetUsage {
  activeMinutes: number;
  limitMinutes: number;
  spentUsd: number | null;
  usdCap: number | null;
  runsStarted: number;
  maxRuns: number | null;
}

export interface TaskProgress {
  phase: TaskPhase | null;
  plan: PlanItem[];
  todos: TodoItem[];
  ledger: LedgerRow[];
  best: BestMetric | null;
  runsInFlight: RunRecord[];
  recentRuns: RunRecord[];
  budget: BudgetUsage;
  evidence: EvidenceReport | null;
  recordDir: string;
}

export const progressResearchTask = (taskId: string) =>
  invoke<TaskProgress>("research_task_progress", { taskId });

export const cancelResearchTaskRun = (taskId: string, runId: string) =>
  invoke<void>("research_task_run_cancel", { taskId, runId });

export const researchTaskRunLog = (taskId: string, runId: string, tail = 200) =>
  invoke<string>("research_task_run_log", { taskId, runId, tail });

export const listResearchTaskApprovals = (projectId: string) =>
  invoke<ApprovalRecord[]>("research_task_approvals", { projectId });

export const decideResearchTaskApproval = (approvalId: string, approve: boolean) =>
  invoke<ApprovalRecord>("research_task_approval_decide", { approvalId, approve });

export const refreshResearchTaskEvidence = (taskId: string) =>
  normalized(invoke<ResearchTask>("research_task_evidence_refresh", { taskId }));

export interface AttentionSummary {
  byProject: Record<string, number>;
}

export const loadResearchAttention = () => invoke<AttentionSummary>("research_task_attention");

export const listenForResearchAttention = (
  onSummary: (summary: AttentionSummary) => void,
): Promise<UnlistenFn> =>
  listen<AttentionSummary>("research-attention", (event) => onSummary(event.payload));

export type NotificationPermission = "granted" | "denied" | "prompt";

export const researchNotificationPermission = (request = false) =>
  invoke<NotificationPermission>("research_notification_permission", { request });

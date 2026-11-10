import { JSDOM } from "jsdom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRecord,
  EvidenceReport,
  ResearchTask,
  TaskArtifactPreview,
  TaskFilePreview,
  TaskIsolationSummary,
  TaskProgress,
  TaskRuntimeEvent,
  TaskObservationView,
} from "@/lib/research-tasks";
import { formatDateTime } from "@/lib/intl";
import enCommon from "@/i18n/locales/en/common.json" with { type: "json" };
import enResearchTools from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { taskFieldsSince047 } from "./tests/task-fixtures";
import * as timelineBuilders from "./task-timeline";
import type { AnnotationTarget, GroupSnapshot } from "@/lib/task-collaboration";
import type { TaskAnnotationsProps } from "./TaskAnnotations";

let TaskDetailDialog: typeof import("./TaskDetailDialog").TaskDetailDialog;
let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let within: typeof import("@testing-library/react").within;

const previewMocks = vi.hoisted(() => ({
  file: vi.fn(),
  artifact: vi.fn(),
  events: vi.fn(),
  referencedEvents: vi.fn(),
  compiledPdfs: vi.fn(),
  observations: vi.fn().mockResolvedValue({
    summary: { runtime: null, usage: null, baseline: null, changedFiles: [], changedFileCount: 0, evidence: null, coverageGaps: [] },
    page: { events: [], nextSequence: 0, throughSequence: 0, hasMore: false },
  }),
  source: vi.fn(),
  findings: vi.fn().mockResolvedValue({ findings: [], nextSequence: 0, hasMore: false, coverageGaps: [] }),
  findingSource: vi.fn(),
  findingDecide: vi.fn(),
  keepRunning: vi.fn(),
  config: vi.fn(),
  plan: vi.fn(),
  progress: vi.fn(),
  runLog: vi.fn(),
  cancelRun: vi.fn(),
  approvals: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("@/lib/research-tasks", () => ({
  previewResearchTaskFile: previewMocks.file,
  previewResearchTaskArtifact: previewMocks.artifact,
  loadResearchTaskEventsBefore: previewMocks.events,
  loadResearchTaskEvents: previewMocks.referencedEvents,
  listTaskCompiledPdfs: previewMocks.compiledPdfs,
  loadResearchTaskObservations: previewMocks.observations,
  previewResearchTaskSource: previewMocks.source,
  loadResearchTaskFindings: previewMocks.findings,
  previewResearchTaskFindingSource: previewMocks.findingSource,
  decideResearchTaskFinding: previewMocks.findingDecide,
  NEWEST_EVENTS: Number.MAX_SAFE_INTEGER,
  MAX_PLAN_BYTES: 64 * 1024,
  setResearchTaskKeepRunning: previewMocks.keepRunning,
  loadResearchTaskPlan: previewMocks.plan,
  progressResearchTask: previewMocks.progress,
  researchTaskRunLog: previewMocks.runLog,
  cancelResearchTaskRun: previewMocks.cancelRun,
  listResearchTaskApprovals: previewMocks.approvals,
  decideResearchTaskApproval: previewMocks.decide,
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  getConfig: previewMocks.config,
}));

vi.mock("@/components/editor/diff/InlineDiffPreview", () => ({
  InlineDiffPreview: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <div>{`${oldText} -> ${newText}`}</div>
  ),
}));

vi.mock("./TaskCompiledPdfs", () => ({ TaskCompiledPdfs: ({ reference }: { reference?: { path: string; generation: number } }) => reference ? <div data-testid="mock-retained-pdf" data-path={reference.path} data-generation={reference.generation} /> : null }));

const annotationMocks = vi.hoisted(() => ({ props: null as TaskAnnotationsProps | null, group: vi.fn(), message: vi.fn(), annotations: vi.fn(), pdf: vi.fn() }));
const journalReference = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/journal-workbench", () => ({ loadJournalTarget: journalReference.load }));
vi.mock("@/lib/pdf-selection", () => ({ loadTaskPdfSelection: annotationMocks.pdf }));
vi.mock("./TaskPdfSelection", () => ({ TaskPdfSelection: ({ taskId, openOriginal }: { taskId: string; openOriginal?: boolean }) => <div data-testid="mock-task-pdf" data-task={taskId} data-open-original={String(openOriginal)} /> }));
vi.mock("./TaskAnnotations", () => ({
  TaskAnnotations: (props: TaskAnnotationsProps) => { annotationMocks.props = props; return null; },
}));
vi.mock("@/lib/task-collaboration", () => ({ loadTaskGroup: annotationMocks.group, loadTaskGroupMessage: annotationMocks.message, loadTaskAnnotations: annotationMocks.annotations }));

const markdownDraws = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children, streaming }: { children: string; streaming?: boolean }) => {
    markdownDraws.texts.push(children);
    return <p data-streaming={streaming ? "true" : undefined}>{children}</p>;
  },
}));

vi.mock("./task-timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-timeline")>();
  return {
    ...actual,
    buildTaskTimeline: vi.fn(actual.buildTaskTimeline),
    buildTaskTimelineIncremental: vi.fn(actual.buildTaskTimelineIncremental),
  };
});

beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://oleafly.test",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("DocumentFragment", dom.window.DocumentFragment);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("NodeFilter", dom.window.NodeFilter);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => dom.window.clearTimeout(handle));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => {} },
    scrollIntoView: { configurable: true, value: vi.fn() },
  });
  ({ act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react"));
  ({ TaskDetailDialog } = await import("./TaskDetailDialog"));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function page() {
  return within(document.body);
}

function openTab(name: string) {
  fireEvent.mouseDown(page().getByRole("tab", { name }), { button: 0 });
}

async function backgroundSettingRead() {
  await waitFor(() => expect(previewMocks.config).toHaveBeenCalled());
}

function task(id: string): ResearchTask {
  return {
    id,
    projectId: "paper",
    title: `Task ${id}`,
    prompt: `Complete ${id}`,
    runtimeId: "builtin",
    agentId: "provider",
    modelId: "model",
    skillIds: [],
    dependencyIds: [],
    status: "awaiting_review",
    executionGeneration: 1,
    sessionId: `session-${id}`,
    nativeSessionId: null,
    sourceRevision: "snapshot:base",
    isolation: null,
    error: null,
    result: {
      summary: `Result ${id}`,
      changedFiles: [
        {
          path: "main.tex",
          kind: "modified",
          beforeSha256: `before-${id}`,
          afterSha256: `after-${id}`,
          beforeSize: 5,
          afterSize: 5,
        },
      ],
      artifacts: [],
      nativeSessionId: null,
      inputTokens: null,
      outputTokens: null,
    },
    review: null,
    startRequested: false,
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: 1,
    ...taskFieldsSince047(),
  };
}

function preview(after: string): TaskFilePreview {
  const content = (text: string) => ({
    exists: true,
    text,
    base64: null,
    mediaType: "text/x-tex",
    binary: false,
    truncated: false,
    size: text.length,
    sha256: text,
  });
  return {
    path: "main.tex",
    change: "modified",
    before: content("before"),
    after: content(after),
    projectSha256: "before",
    baseIsCurrent: true,
    mergesWithShared: false,
  };
}

function props(current: ResearchTask, onCancel = vi.fn(async () => {})) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    task: current,
    tasks: [current],
    events: [],
    eventsLoading: false,
    canLoadMoreEvents: false,
    busy: false,
    onStart: vi.fn(async () => {}),
    onCancel,
    onRetry: vi.fn(async () => {}),
    onEdit: vi.fn(),
    onApply: vi.fn(async () => {}),
    onAccept: vi.fn(async () => {}),
    onDelete: vi.fn(),
    onLoadMoreEvents: vi.fn(async () => {}),
  };
}

function observedRun(id: string): TaskObservationView {
  const row = (sequence: number, event: TaskRuntimeEvent) => ({ taskId: id, executionGeneration: 1, sequence, event, createdAt: sequence });
  return {
    summary: {
      taskId: id, projectId: "paper", executionGeneration: 1, status: "awaiting_review", goal: "Read evidence", successCriteria: ["Source can be recovered"],
      runtime: row(1, { kind: "observation", observation: { type: "runtime", runtimeId: "builtin", providerId: "actual-provider", modelId: "actual-model", sessionId: "session", tools: [{ name: "read_file", source: "builtin", schemaSha256: "schema-hash" }], declaredSkills: ["selected"], injectedSkills: [{ id: "selected", sectionSha256: "section-hash" }], unavailable: ["commands:disabled"] } }),
      usage: row(2, { kind: "observation", observation: { type: "usage", inputTokens: 0, outputTokens: null } }),
      baseline: { kind: "git_worktree", executionRoot: "workspace", sourceRevision: "revision-start", baselineHash: "baseline-hash", fileCount: 2, createdAt: 1, initialGitStatus: [" M main.tex", "?? notes.md"], initialGitStatusComplete: true },
      changedFiles: [], changedFileCount: 1, evidence: { checkedAt: 1, checks: [] }, coverageGaps: [],
    },
    page: { events: [
      row(3, { kind: "observation", observation: { type: "toolRequested", callId: "source-call", name: "read_file", inputSha256: "input-hash" } }),
      row(4, { kind: "observation", observation: { type: "toolExecution", callId: "source-call", name: "read_file", status: "done", inputSha256: "input-hash", outputSha256: "output-hash", skillId: null, skillInstructionsSha256: null, source: { path: "main.tex", fileSha256: "source-hash", offset: 6, endOffset: 12, truncated: true, snapshotRetained: true } } }),
    ], nextSequence: 4, throughSequence: 4, hasMore: false },
  };
}

describe("TaskDetailDialog", () => {
  beforeEach(() => {
    previewMocks.file.mockReset();
    previewMocks.artifact.mockReset();
    previewMocks.events.mockReset();
    previewMocks.referencedEvents.mockReset().mockResolvedValue({ events: [], nextSequence: null });
    previewMocks.compiledPdfs.mockReset().mockResolvedValue([]);
    annotationMocks.props = null;
    annotationMocks.pdf.mockReset().mockResolvedValue(null);
    annotationMocks.message.mockReset().mockResolvedValue(null);
    annotationMocks.annotations.mockReset().mockResolvedValue({ annotations: [] });
    annotationMocks.group.mockReset().mockResolvedValue(null);
    previewMocks.observations.mockReset().mockResolvedValue({ summary: { runtime: null, usage: null, baseline: null, evidence: null, coverageGaps: [] }, page: { events: [], nextSequence: 0, throughSequence: 0, hasMore: false } });
    previewMocks.source.mockReset();
    previewMocks.findings.mockReset().mockResolvedValue({ findings: [], nextSequence: 0, hasMore: false, coverageGaps: [] });
    previewMocks.findingSource.mockReset();
    previewMocks.findingDecide.mockReset();
    previewMocks.keepRunning.mockReset();
    previewMocks.config.mockReset().mockResolvedValue({ research_background_enabled: true });
    previewMocks.plan.mockReset().mockResolvedValue({ text: "- [ ] Measure the baseline", truncated: false });
    previewMocks.progress.mockReset();
    previewMocks.runLog.mockReset();
    previewMocks.cancelRun.mockReset();
    previewMocks.approvals.mockReset().mockResolvedValue([]);
    previewMocks.decide.mockReset();
  });

  afterEach(() => cleanup());

  it("annotates an earlier activity row with its original object identity and generation", async () => {
    const current = { ...task("older-annotation"), executionGeneration: 4, resumedFrom: 2 };
    previewMocks.events.mockResolvedValue({
      events: [{ taskId: current.id, executionGeneration: 2, sequence: 7, createdAt: 7, event: { kind: "text", text: "Earlier decision" } }],
      nextSequence: null, previousSequence: null, resumedFrom: null,
    });
    render(<TaskDetailDialog {...props(current)} initialTab="activity" />);
    fireEvent.click(page().getByRole("button", { name: enResearchTools.backgroundHelper.earlierActivity }));
    const earlier = await page().findByTestId("research-task-earlier-activity");
    expect(within(earlier).getByText("Earlier decision")).toBeInTheDocument();
    fireEvent.click(within(earlier).getByRole("button", { name: enResearchTools.tasks.annotations.annotate }));
    await waitFor(() => expect(annotationMocks.props?.target).toEqual({
      projectId: current.projectId, taskId: current.id, objectKind: "message", objectId: `${current.id}:2:7`, objectRevision: "generation:2", path: null,
    }));
    expect(page().getByRole("tab", { name: enResearchTools.tasks.annotations.title })).toHaveAttribute("data-state", "active");
    expect(previewMocks.events).toHaveBeenCalledWith(current.id, 2, Number.MAX_SAFE_INTEGER, 200);
  });

  it("opens the retained PDF input only for the matching task-child annotation target", async () => {
    const current = task("pdf-reference");
    const target: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "pdf_selection", objectId: "pdf-object", objectRevision: "sha256:original", path: "main.tex" };
    annotationMocks.pdf.mockResolvedValue({ annotationId: "child-pdf" });
    annotationMocks.annotations.mockResolvedValue({ annotations: [{ id: "child-pdf", target }] });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(target); });
    expect(annotationMocks.pdf).toHaveBeenCalledWith(current.id);
    expect(annotationMocks.annotations).toHaveBeenCalledWith(current.projectId, current.id);
    await waitFor(() => expect(page().getByTestId("mock-task-pdf")).toHaveAttribute("data-open-original", "true"));
    expect(page().getByTestId("mock-task-pdf")).toHaveAttribute("data-task", current.id);
    expect(page().queryByTestId("task-annotation-source")).not.toBeInTheDocument();
  });

  it("rejects a different PDF object or revision without opening the task output", async () => {
    const current = task("pdf-mismatch");
    const target: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "pdf_selection", objectId: "pdf-object", objectRevision: "sha256:original", path: "main.tex" };
    annotationMocks.pdf.mockResolvedValue({ annotationId: "child-pdf" });
    annotationMocks.annotations.mockResolvedValue({ annotations: [{ id: "child-pdf", target }] });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    for (const invalid of [{ ...target, objectRevision: "sha256:other" }, { ...target, objectId: "another-pdf" }]) {
      await act(async () => { annotationMocks.props?.onOpenTarget?.(invalid); });
      expect(within(page().getByTestId("task-annotation-source")).getByRole("alert")).toHaveTextContent(enResearchTools.tasks.annotations.referenceUnavailable);
      expect(page().getByRole("tab", { name: enResearchTools.tasks.annotations.title })).toHaveAttribute("data-state", "active");
      expect(page().queryByTestId("mock-task-pdf")).not.toBeInTheDocument();
    }
  });

  it("reads a saved message reference from its recorded generation and reports a missing original sequence", async () => {
    const current = { ...task("referenced"), executionGeneration: 8 };
    const reference: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "message", objectId: `${current.id}:2:7`, objectRevision: "generation:2", path: null };
    previewMocks.referencedEvents.mockResolvedValueOnce({
      events: [{ taskId: current.id, executionGeneration: 2, sequence: 7, createdAt: 7, event: { kind: "text", text: "Original generation-two decision" } }], nextSequence: null,
    });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" events={[{ taskId: current.id, executionGeneration: 8, sequence: 7, createdAt: 8, event: { kind: "text", text: "Current replacement" } }]} />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(reference); });
    expect(previewMocks.referencedEvents).toHaveBeenCalledExactlyOnceWith(current.id, 2, 6, 200);
    const source = page().getByTestId("task-annotation-source");
    expect(within(source).getByText("Original generation-two decision")).toBeInTheDocument();
    expect(within(source).queryByText("Current replacement")).toBeNull();
    previewMocks.referencedEvents.mockResolvedValueOnce({
      events: [{ taskId: current.id, executionGeneration: 2, sequence: 8, createdAt: 8, event: { kind: "text", text: "A different old message" } }], nextSequence: null,
    });
    await act(async () => { annotationMocks.props?.onOpenTarget?.(reference); });
    await waitFor(() => expect(within(source).getByRole("alert")).toHaveTextContent(enResearchTools.tasks.annotations.referenceUnavailable));
    expect(within(source).queryByText("Original generation-two decision")).toBeNull();
    expect(within(source).queryByText("A different old message")).toBeNull();
    expect(previewMocks.referencedEvents).toHaveBeenLastCalledWith(current.id, 2, 6, 200);
  });

  it("loads existing group members when annotations opens directly without visiting the group tab", async () => {
    const current = task("direct-annotations");
    const snapshot: GroupSnapshot = {
      group: { id: "group-existing", taskId: current.id, projectId: current.projectId, status: "open", createdAt: 1, updatedAt: 5 },
      members: [{ id: "member-reviewer", groupId: "group-existing", name: "Reviewer", responsibility: "Check evidence", runtimeId: "builtin", agentId: "openai", modelId: "model", skillIds: [], coordinator: false, paused: false, joinedAt: 1 }],
      interests: [], messages: [], work: [], executions: [], nextSequence: 0,
    };
    annotationMocks.group.mockResolvedValue(snapshot);
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.members).toEqual(snapshot.members));
    expect(annotationMocks.group).toHaveBeenCalledWith(current.projectId, current.id);
    expect(annotationMocks.props?.revision).toBe(snapshot.group.updatedAt);
    expect(page().getByRole("tab", { name: enResearchTools.tasks.group.title })).toHaveAttribute("data-state", "inactive");
    expect(page().getByRole("tab", { name: enResearchTools.tasks.annotations.title })).toHaveAttribute("data-state", "active");
  });

  it("opens a journal handling reference from its retained object source", async () => {
    const current = task("journal-reference");
    const target: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "journal_source", objectId: "stable-library-source", objectRevision: "world-old", path: null };
    journalReference.load.mockResolvedValue({
      reference: { kind: "source", objectId: "source-fragment-old" }, target,
      source: { kind: "journal_object", content: JSON.stringify({ object: { text: "Original retained journal instruction", locator: "guide:page-4" } }) }, relatedTasks: [],
    });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(target); });
    const original = await page().findByTestId("journal-retained-object");
    expect(within(original).getByText("Original retained journal instruction")).toBeInTheDocument();
    expect(within(original).getByText("guide:page-4")).toBeInTheDocument();
    expect(journalReference.load).toHaveBeenCalledExactlyOnceWith(target);
    expect(previewMocks.referencedEvents).not.toHaveBeenCalled();
  });

  it("opens a historical group message result by exact identity", async () => {
    const current = task("group-message-reference");
    const target: AnnotationTarget = {
      projectId: current.projectId,
      taskId: current.id,
      objectKind: "group_message",
      objectId: "message-old",
      objectRevision: "sequence:2",
      path: null,
    };
    annotationMocks.group.mockResolvedValue({
      group: { id: "group-existing", taskId: current.id, projectId: current.projectId, status: "open", createdAt: 1, updatedAt: 5 },
      members: [],
      interests: [],
      messages: [],
      work: [],
      executions: [],
      nextSequence: 3,
    });
    annotationMocks.message.mockResolvedValue({
      id: target.objectId,
      sequence: 2,
      groupId: "group-existing",
      author: { kind: "member", id: "reviewer", executionId: null },
      body: "Historical group result",
      recipients: [],
      replyTo: null,
      object: null,
      requestWork: false,
      createdAt: 2,
    });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(target); });
    const source = page().getByTestId("task-annotation-source");
    expect(within(source).getByText("Historical group result")).toBeInTheDocument();
    expect(annotationMocks.message).toHaveBeenCalledWith(current.projectId, current.id, "group-existing", target.objectId);
  });

  it("does not open a historical artifact through the current generation's preview", async () => {
    const current = { ...task("older-artifact"), executionGeneration: 8 };
    const reference: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "artifact", objectId: `${current.id}:2:7`, objectRevision: "generation:2", path: "figures/result.png" };
    previewMocks.referencedEvents.mockResolvedValue({
      events: [{ taskId: current.id, executionGeneration: 2, sequence: 7, createdAt: 7, event: { kind: "artifact", artifact: { path: "figures/result.png", label: "Original chart", mediaType: "image/png" } } }], nextSequence: null,
    });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(reference); });
    const source = page().getByTestId("task-annotation-source");
    await waitFor(() => expect(within(source).getByText(enResearchTools.tasks.annotations.referenceUnavailable)).toBeInTheDocument());
    expect(source).toHaveTextContent("generation:2");
    expect(within(source).queryByRole("button", { name: /Original chart/ })).toBeNull();
    expect(previewMocks.artifact).not.toHaveBeenCalled();
  });

  it("opens a compiled PDF result from its exact retained generation after a later run", async () => {
    const current = { ...task("retained-pdf"), executionGeneration: 8 };
    const pdf = { taskId: current.id, generation: 2, inputFingerprint: "input-old", sourceRevision: "source-old", outputId: "output-old", pdfSha256: "pdf-old", size: 42, mainDocument: "main.tex", path: "compiled-artifacts/old.pdf" };
    const target: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "task_pdf", objectId: pdf.pdfSha256, objectRevision: "generation:2", path: pdf.path };
    previewMocks.compiledPdfs.mockResolvedValue([pdf]);
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(target); });
    const source = page().getByTestId("task-annotation-source");
    await waitFor(() => expect(within(source).getByTestId("mock-retained-pdf")).toHaveAttribute("data-path", pdf.path));
    expect(within(source).getByTestId("mock-retained-pdf")).toHaveAttribute("data-generation", "2");
    expect(previewMocks.compiledPdfs).toHaveBeenCalledExactlyOnceWith(current.id, 2);
    expect(previewMocks.referencedEvents).not.toHaveBeenCalled();
    expect(previewMocks.artifact).not.toHaveBeenCalled();
  });

  it("rejects a PDF result whose hash does not match the retained path", async () => {
    const current = task("mismatched-pdf");
    const target: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "task_pdf", objectId: "claimed-hash", objectRevision: "generation:1", path: "compiled-artifacts/retained.pdf" };
    previewMocks.compiledPdfs.mockResolvedValue([{ path: target.path, pdfSha256: "actual-hash" }]);
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.onOpenTarget).toBeDefined());
    await act(async () => { annotationMocks.props?.onOpenTarget?.(target); });
    const source = page().getByTestId("task-annotation-source");
    await waitFor(() => expect(within(source).getByRole("alert")).toHaveTextContent(enResearchTools.tasks.annotations.referenceUnavailable));
    expect(within(source).queryByTestId("mock-retained-pdf")).toBeNull();
  });

  it("captures only a hash-verified artifact from the annotated generation", async () => {
    const current = { ...task("artifact-source"), executionGeneration: 4 };
    const artifact = { path: "report.md", label: "Review report", mediaType: "text/markdown" };
    if (!current.result) throw new Error("expected a saved task result");
    current.result = { ...current.result, artifacts: [artifact] };
    previewMocks.artifact.mockResolvedValue({ artifact, content: {
      exists: true, text: "Original report text", base64: null, mediaType: "text/markdown", binary: false,
      truncated: false, size: 19, sha256: "verified-sha256",
    } });
    render(<TaskDetailDialog {...props(current)} initialTab="annotations" />);
    await waitFor(() => expect(annotationMocks.props?.loadSource).toBeDefined());
    const target: AnnotationTarget = { projectId: current.projectId, taskId: current.id, objectKind: "artifact", objectId: `${current.id}:4:7`, objectRevision: "generation:4", path: artifact.path };
    await expect(annotationMocks.props?.loadSource?.(target)).resolves.toEqual({ kind: "task_artifact", content: "Original report text" });
    expect(previewMocks.artifact).toHaveBeenCalledWith(current.id, artifact.path, 4);

    const older = { ...target, objectRevision: "generation:3" };
    await expect(annotationMocks.props?.loadSource?.(older)).resolves.toBeUndefined();
    expect(previewMocks.artifact).toHaveBeenCalledOnce();
  });

  it("shows the recorded runtime, paired call and exact source range in the existing activity", async () => {
    const current = task("observed");
    const view = observedRun(current.id);
    previewMocks.observations.mockResolvedValue(view);
    previewMocks.source.mockResolvedValue({ source: view.page.events[1], text: "证据" });
    const events = [{ taskId: current.id, executionGeneration: 1, sequence: 5, createdAt: 5, event: { kind: "tool" as const, callId: "source-call", name: "read_file", phase: "request" as const, detail: '{"path":"main.tex"}', status: "running" } }];
    render(<TaskDetailDialog {...props(current)} events={events} />);
    openTab(enResearchTools.tasks.detail.tabActivity);
    const section = within(page().getByTestId("task-observations"));
    await waitFor(() => expect(section.getByText("actual-provider / actual-model · builtin")).toBeInTheDocument());
    expect(section.getByText(/Reported input.*0 \/ Unknown/)).toBeInTheDocument();
    expect(section.getByText(/Commands turned off/)).toBeInTheDocument();
    fireEvent.click(section.getByText(enResearchTools.tasks.observations.records));
    expect(section.getByText(/#3 → #4/)).toHaveTextContent("source-call");
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
    const scrollsBefore = scroll.mock.calls.length;
    fireEvent.click(section.getByRole("button", { name: enResearchTools.tasks.observations.openCall }));
    expect(scroll).toHaveBeenCalledTimes(scrollsBefore + 1);
    fireEvent.click(section.getByRole("button", { name: enResearchTools.tasks.observations.openCall }));
    expect(scroll).toHaveBeenCalledTimes(scrollsBefore + 2);
    fireEvent.click(section.getByRole("button", { name: enResearchTools.tasks.observations.openSource }));
    await waitFor(() => expect(section.getByText("证据")).toBeInTheDocument());
    expect(previewMocks.source).toHaveBeenCalledWith(current.id, 1, 4);
    previewMocks.source.mockRejectedValue(new Error("The source revision is no longer retained."));
    fireEvent.click(section.getByRole("button", { name: enResearchTools.tasks.observations.openSource }));
    await waitFor(() => expect(section.getByRole("alert")).toHaveTextContent("no longer retained"));
    fireEvent.click(section.getByText(enResearchTools.tasks.observations.baseline));
    expect(section.getByText(/M main.tex/)).toHaveTextContent("?? notes.md");
    fireEvent.click(section.getByRole("button", { name: "Review 1 file changes" }));
    expect(page().getByRole("tab", { name: enResearchTools.tasks.detail.tabReview })).toHaveAttribute("data-state", "active");
  });

  it("recovers observation query errors and ignores an old page after a newer task revision", async () => {
    const current = task("refresh-observed");
    const first = observedRun(current.id);
    first.page.hasMore = true;
    previewMocks.observations.mockRejectedValueOnce(new Error("Observation storage unavailable")).mockResolvedValue(first);
    const input = props(current);
    const ui = render(<TaskDetailDialog {...input} />);
    openTab(enResearchTools.tasks.detail.tabActivity);
    const section = within(page().getByTestId("task-observations"));
    await waitFor(() => expect(section.getByRole("alert")).toHaveTextContent("Observation storage unavailable"));
    fireEvent.click(section.getByRole("button", { name: enResearchTools.tasks.observations.retry }));
    await waitFor(() => expect(section.getByRole("button", { name: enResearchTools.tasks.observations.more })).toBeEnabled());
    const older = deferred<TaskObservationView>();
    previewMocks.observations.mockReturnValueOnce(older.promise);
    fireEvent.click(section.getByRole("button", { name: enResearchTools.tasks.observations.more }));
    expect(previewMocks.observations).toHaveBeenLastCalledWith(current.id, 1, 4);
    const latest = observedRun(current.id);
    latest.page.events = [{ taskId: current.id, executionGeneration: 1, sequence: 12, createdAt: 12, event: { kind: "observation", observation: { type: "toolRequested", callId: "new-call", name: "load_skill", inputSha256: "new-input" } } }];
    latest.page.nextSequence = 12;
    latest.page.throughSequence = 12;
    previewMocks.observations.mockResolvedValue(latest);
    ui.rerender(<TaskDetailDialog {...input} task={{ ...current, updatedAt: 2 }} />);
    await waitFor(() => expect(section.getByText("Committed through sequence 12")).toBeInTheDocument());
    expect(previewMocks.observations).toHaveBeenLastCalledWith(current.id, 1, 4);
    fireEvent.click(section.getByText(enResearchTools.tasks.observations.records));
    expect(section.getByText(/#3 → #4/)).toHaveTextContent("source-call");
    expect(section.getByText(/#12 · new-call/)).toBeInTheDocument();
    await act(async () => { older.resolve(first); });
    expect(section.getByText("Committed through sequence 12")).toBeInTheDocument();
    expect(section.queryByText("Committed through sequence 4")).toBeNull();
  });

  it("shows shortened Git, file and check coverage instead of implying a complete summary", async () => {
    const current = task("partial-observed");
    const view = observedRun(current.id);
    view.summary.coverageGaps = ["observations.git_status_shortened", "observations.file_list_shortened", "observations.check_items_shortened"];
    if (!view.summary.baseline) throw new Error("Missing baseline fixture");
    const baseline = view.summary.baseline;
    baseline.initialGitStatus = [];
    baseline.initialGitStatusComplete = false;
    previewMocks.observations.mockResolvedValue(view);
    const input = props(current);
    const ui = render(<TaskDetailDialog {...input} />);
    openTab(enResearchTools.tasks.detail.tabActivity);
    const section = within(page().getByTestId("task-observations"));
    await waitFor(() => expect(section.getByText(enResearchTools.tasks.observations.gitShortened)).toBeInTheDocument());
    expect(section.getByText(enResearchTools.tasks.observations.filesShortened)).toBeInTheDocument();
    expect(section.getByText(enResearchTools.tasks.observations.checksShortened)).toBeInTheDocument();
    expect(section.queryByText(enResearchTools.tasks.observations.clean)).toBeNull();
    view.summary.coverageGaps = ["observations.git_status_completeness_unknown"];
    baseline.initialGitStatusComplete = null;
    ui.rerender(<TaskDetailDialog {...input} task={{ ...current, updatedAt: 2 }} />);
    await waitFor(() => expect(section.getByText(enResearchTools.tasks.observations.gitCompletenessUnknown)).toBeInTheDocument());
    fireEvent.click(section.getByRole("button", { name: "View 0 evidence checks" }));
    expect(page().getByRole("tab", { name: enResearchTools.tasks.detail.tabReview })).toHaveAttribute("data-state", "active");
  });

  it("the detail dialog toggles keep running and loads earlier activity", async () => {
    previewMocks.keepRunning.mockResolvedValue(undefined);
    previewMocks.events.mockImplementation(async (taskId: string, generation: number) => ({
      events: [
        {
          taskId,
          executionGeneration: generation,
          sequence: 1,
          event: { kind: "status", message: `Generation ${generation} notes` },
          createdAt: 1,
        },
      ],
      nextSequence: null,
      previousSequence: null,
      resumedFrom: generation > 1 ? generation - 1 : null,
    }));
    const current: ResearchTask = {
      ...task("resumed"),
      status: "running",
      executionGeneration: 3,
      resumedFrom: 2,
      keepRunningAfterQuit: false,
    };
    render(<TaskDetailDialog {...props(current)} />);

    const keep = page().getByRole("checkbox", { name: enResearchTools.brief.keepRunning });
    expect(keep).toBeEnabled();
    fireEvent.click(keep);
    await waitFor(() => expect(previewMocks.keepRunning).toHaveBeenCalledWith("resumed", true));

    const earlier = enResearchTools.backgroundHelper.earlierActivity;
    fireEvent.click(page().getByRole("button", { name: earlier }));
    expect(await page().findByText("Generation 2 notes")).toBeInTheDocument();
    expect(previewMocks.events).toHaveBeenCalledWith("resumed", 2, Number.MAX_SAFE_INTEGER, 200);
    fireEvent.click(page().getByRole("button", { name: earlier }));
    expect(await page().findByText("Generation 1 notes")).toBeInTheDocument();
    expect(page().queryByRole("button", { name: earlier })).not.toBeInTheDocument();
  });

  it("drops the earlier activity it loaded when the task starts another run", async () => {
    previewMocks.events.mockImplementation((taskId: string, generation: number) => Promise.resolve({
      events: [
        {
          taskId,
          executionGeneration: generation,
          sequence: 1,
          event: { kind: "status", message: `Generation ${generation} notes` },
          createdAt: 1,
        },
      ],
      nextSequence: null,
      previousSequence: null,
      resumedFrom: generation - 1,
    }));
    const current: ResearchTask = { ...task("resumed"), status: "running", executionGeneration: 3, resumedFrom: 2 };
    const view = render(<TaskDetailDialog {...props(current)} />);
    const earlier = enResearchTools.backgroundHelper.earlierActivity;
    fireEvent.click(page().getByRole("button", { name: earlier }));
    expect(await page().findByText("Generation 2 notes")).toBeInTheDocument();

    view.rerender(<TaskDetailDialog {...props({ ...current, executionGeneration: 4, resumedFrom: 3 })} />);

    expect(page().queryByText("Generation 2 notes")).not.toBeInTheDocument();
    expect(page().getByRole("button", { name: earlier })).toBeEnabled();
    fireEvent.click(page().getByRole("button", { name: earlier }));
    expect(await page().findByText("Generation 3 notes")).toBeInTheDocument();
    expect(previewMocks.events).toHaveBeenLastCalledWith("resumed", 3, Number.MAX_SAFE_INTEGER, 200);
  });

  it("stops showing earlier activity at a run that started fresh", async () => {
    previewMocks.events.mockImplementation(async (taskId: string, generation: number) => ({
      events: [
        {
          taskId,
          executionGeneration: generation,
          sequence: 1,
          event: { kind: "status", message: `Generation ${generation} notes` },
          createdAt: 1,
        },
      ],
      nextSequence: null,
      previousSequence: null,
      resumedFrom: generation === 3 ? 2 : null,
    }));
    const current: ResearchTask = { ...task("chain"), status: "running", executionGeneration: 3, resumedFrom: 2 };
    render(<TaskDetailDialog {...props(current)} />);
    const earlier = enResearchTools.backgroundHelper.earlierActivity;

    fireEvent.click(page().getByRole("button", { name: earlier }));

    expect(await page().findByText("Generation 2 notes")).toBeInTheDocument();
    expect(page().queryByRole("button", { name: earlier })).not.toBeInTheDocument();
    expect(previewMocks.events.mock.calls.map(([, generation]) => generation)).toEqual([2]);
  });

  it("keeps the keep-running choice fixed for finished tasks and while background tasks are off", async () => {
    const finished = render(<TaskDetailDialog {...props(task("finished"))} />);
    expect(page().getByRole("checkbox", { name: enResearchTools.brief.keepRunning })).toBeDisabled();
    finished.unmount();

    previewMocks.config.mockResolvedValue({ research_background_enabled: false });
    render(<TaskDetailDialog {...props({ ...task("waiting"), status: "queued" })} />);
    expect(await page().findByText(enResearchTools.brief.keepRunningHint)).toBeInTheDocument();
    expect(
      page().getByRole("checkbox", { name: new RegExp(enResearchTools.brief.keepRunning) }),
    ).toBeDisabled();
    expect(page().queryByRole("button", { name: enResearchTools.backgroundHelper.earlierActivity })).toBeNull();
  });

  it("shows keep running off while background tasks are off, as the composer does", async () => {
    previewMocks.config.mockResolvedValue({ research_background_enabled: false });
    render(<TaskDetailDialog {...props({ ...task("kept"), status: "queued", keepRunningAfterQuit: true })} />);

    await page().findByText(enResearchTools.brief.keepRunningHint);
    expect(page().getByRole("checkbox", { name: new RegExp(enResearchTools.brief.keepRunning) })).not.toBeChecked();
  });

  it("lets the header scroll, so stacked approvals can't push the tabs out of the dialog", () => {
    render(<TaskDetailDialog {...props(task("header"))} />);

    const header = page().getByRole("heading", { name: "Task header" }).closest("header");
    expect(header?.className).toContain("overflow-y-auto");
    expect(header?.className).toMatch(/max-h-/);
  });

  it("says Applying only while its own apply runs", async () => {
    const applying = deferred<void>();
    const current = task("label");
    const input = { ...props(current), onApply: vi.fn(() => applying.promise) };
    previewMocks.file.mockResolvedValue(preview("after"));
    const view = render(<TaskDetailDialog {...input} busy />);
    expect(page().queryByRole("button", { name: enResearchTools.tasks.detail.applying })).toBeNull();
    view.rerender(<TaskDetailDialog {...input} />);
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await page().findByText("before -> after");

    fireEvent.click(page().getByRole("button", { name: "Apply 1 selected" }));

    expect(page().getByRole("button", { name: enResearchTools.tasks.detail.applying })).toBeInTheDocument();
    await act(async () => applying.resolve());
    expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeInTheDocument();
  });

  it("applies once when Apply is clicked again while its apply runs", async () => {
    const applying = deferred<void>();
    const input = { ...props(task("double")), onApply: vi.fn(() => applying.promise) };
    previewMocks.file.mockResolvedValue(preview("after"));
    render(<TaskDetailDialog {...input} />);
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await page().findByText("before -> after");

    const button = page().getByRole("button", { name: "Apply 1 selected" });
    act(() => {
      button.click();
      button.click();
    });
    expect(input.onApply).toHaveBeenCalledOnce();
    const running = page().getByRole("button", { name: enResearchTools.tasks.detail.applying });
    expect(running).toBeDisabled();
    fireEvent.click(running);
    expect(input.onApply).toHaveBeenCalledOnce();

    await act(async () => applying.resolve());
    expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeEnabled();
  });

  it("shows sizes, not a diff of every line removed, for a side too large to read", async () => {
    const big = preview("small");
    previewMocks.file.mockResolvedValue({
      ...big,
      after: { ...big.after, text: null, binary: true, truncated: true, size: 410_000 },
    });
    render(<TaskDetailDialog {...props(task("big"))} />);

    fireEvent.click(page().getByRole("button", { name: "Preview" }));

    expect(await page().findByTestId("research-task-preview-too-large")).toHaveTextContent(
      enResearchTools.tasks.detail.tooLargeToDiff,
    );
    expect(page().queryByText(/before ->/)).toBeNull();
    expect(page().getByText(enResearchTools.tasks.detail.afterBytes.replace("{{size}}", "410000"))).toBeInTheDocument();
  });

  it("shows where a helper task runs beside its status", () => {
    const current: ResearchTask = {
      ...task("helper"),
      status: "running",
      owner: "daemon",
      reclaimRequested: true,
    };
    render(<TaskDetailDialog {...props(current)} />);
    expect(page().getByText(enResearchTools.backgroundHelper.badge.movingBack)).toBeInTheDocument();
  });

  it("renders the task body inside the dialog the review specs scope on", () => {
    const current = task("scoped");
    render(<TaskDetailDialog {...props(current)} />);
    const dialog = page().getByRole("dialog");
    const detail = dialog.querySelector('article[aria-labelledby="research-task-detail-title"]');
    expect(detail).not.toBeNull();
    expect(within(detail as HTMLElement).getByRole("heading", { name: current.title })).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText(enResearchTools.tasks.status.awaitingReview)).toBeInTheDocument();
  });

  it("shows a stored read-only folder refusal as its sentence", () => {
    const current = {
      ...task("refused"),
      error: `@oleafly/error:${JSON.stringify({
        code: "project.folder_read_only",
        params: { name: "main.tex" },
        detail: null,
      })}`,
    };
    render(<TaskDetailDialog {...props(current)} />);
    const alert = page().getByText(enResearchTools.tasks.detail.needsAttention).parentElement as HTMLElement;
    expect(
      within(alert).getByText(
        "Oleafly can't make this change because main.tex or its folder is read-only. Copy the folder you opened into your library and edit it there.",
      ),
    ).toBeInTheDocument();
    expect(alert.textContent).not.toContain("@oleafly/error:");
  });

  it("rejects a file preview that completes after the selected task changes", async () => {
    const pending = deferred<TaskFilePreview>();
    previewMocks.file.mockReturnValue(pending.promise);
    const first = task("first");
    const second = task("second");
    const view = render(<TaskDetailDialog {...props(first)} />);

    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    view.rerender(<TaskDetailDialog {...props(second)} />);
    await act(async () => pending.resolve(preview("first task output")));

    await waitFor(() => {
      expect(page().queryByText(/first task output/)).not.toBeInTheDocument();
      expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeDisabled();
    });
  });

  it("lets the user discard changes while a task is awaiting review, after asking", async () => {
    const onCancel = vi.fn(async () => {});
    render(<TaskDetailDialog {...props(task("review"), onCancel)} />);

    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.discardChanges }));
    const confirm = page().getByRole("alertdialog");
    expect(confirm).toHaveTextContent(enResearchTools.tasks.confirm.discardTitle);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: enResearchTools.tasks.detail.discardChanges }));

    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(page().queryByRole("alertdialog")).toBeNull();
  });

  it("names the tasks that fail and the runs that stop with a cancelled task, and keeps it on Keep", async () => {
    const current = { ...task("base"), status: "running" as const, result: null };
    const waiting = { ...task("waiting"), status: "queued" as const, startRequested: true, dependencyIds: ["base"] };
    const chained = { ...task("chained"), status: "queued" as const, startRequested: true, dependencyIds: ["waiting"] };
    const draft = { ...task("draft"), status: "queued" as const, startRequested: false, dependencyIds: ["base"] };
    const done = { ...task("done"), status: "completed" as const, dependencyIds: ["base"] };
    const run = { taskId: "base", runId: "r007", name: "train-large", executionGeneration: 1, state: "running" as const };
    previewMocks.progress.mockResolvedValue({ runsInFlight: [run], recentRuns: [], plan: [], todos: [], ledger: [] });
    const input = { ...props(current), tasks: [current, waiting, chained, draft, done] };
    render(<TaskDetailDialog {...input} />);

    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.stopTask }));

    const confirm = page().getByRole("alertdialog");
    const dependents = within(confirm).getByTestId("research-task-confirm-dependents");
    expect(dependents).toHaveTextContent("These 2 tasks wait for it and fail too:");
    expect(dependents).toHaveTextContent("Task waiting");
    expect(dependents).toHaveTextContent("Task chained");
    expect(dependents).not.toHaveTextContent("Task draft");
    expect(dependents).not.toHaveTextContent("Task done");
    expect(await within(confirm).findByTestId("research-task-confirm-runs")).toHaveTextContent("train-large r007");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(page().queryByRole("alertdialog")).toBeNull());
    expect(input.onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.stopTask }));
    fireEvent.click(within(page().getByRole("alertdialog")).getByRole("button", { name: /Keep task/ }));
    expect(input.onCancel).not.toHaveBeenCalled();
  });

  it("applies only selected files after each selected file has been previewed", async () => {
    const current = task("review");
    if (!current.result) throw new Error("Missing review fixture");
    current.result.changedFiles.push({
      ...current.result.changedFiles[0], path: "references.bib", kind: "added",
    });
    previewMocks.file.mockImplementation(async (_id: string, path: string) => ({ ...preview(path), path }));
    const input = props(current);
    render(<TaskDetailDialog {...input} />);

    expect(page().getByRole("button", { name: "Apply 2 selected" })).toBeDisabled();
    fireEvent.click(page().getAllByRole("button", { name: "Preview" })[0]);
    await page().findByText("before -> main.tex");
    expect(page().getByRole("button", { name: "Apply 2 selected" })).toBeDisabled();
    fireEvent.click(page().getByRole("checkbox", { name: "Apply references.bib" }));
    fireEvent.click(page().getByRole("button", { name: "Apply 1 selected" }));
    expect(input.onApply).toHaveBeenCalledWith(["main.tex"]);
    await page().findByRole("button", { name: "Apply 1 selected" });

    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.selectAll }));
    expect(page().getByRole("button", { name: "Apply 2 selected" })).toBeDisabled();
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await page().findByText("before -> references.bib");
    expect(page().getByRole("button", { name: "Apply 2 selected" })).toBeEnabled();
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.clearSelection }));
    expect(page().getByRole("button", { name: "Apply 0 selected" })).toBeDisabled();
    expect(previewMocks.file.mock.calls).toEqual([[current.id, "main.tex"], [current.id, "references.bib"]]);
  });

  it("lists the research record on its own and needs a preview only of the project's files", async () => {
    const current = { ...task("record"), recordDir: "research/notes-1a2b" };
    if (!current.result) throw new Error("Missing review fixture");
    current.result.changedFiles.push(
      { ...current.result.changedFiles[0], path: "research/notes-1a2b/ledger.tsv", kind: "added" },
      { ...current.result.changedFiles[0], path: "research/notes-1a2b/handoff.md", kind: "added" },
    );
    previewMocks.file.mockImplementation(async (_id: string, path: string) => ({ ...preview(path), path }));
    const input = props(current);
    render(<TaskDetailDialog {...input} />);

    const record = page().getByRole("region", { name: enResearchTools.tasks.detail.researchRecord });
    expect(within(record).getByText("research/notes-1a2b/ledger.tsv")).toBeInTheDocument();
    expect(within(record).queryByText("main.tex")).not.toBeInTheDocument();
    expect(page().getByRole("button", { name: "Apply 3 selected" })).toBeDisabled();
    fireEvent.click(page().getAllByRole("button", { name: "Preview" })[0]);
    await page().findByText("before -> main.tex");
    fireEvent.click(page().getByRole("button", { name: "Apply 3 selected" }));
    expect(input.onApply).toHaveBeenCalledWith([
      "main.tex",
      "research/notes-1a2b/ledger.tsv",
      "research/notes-1a2b/handoff.md",
    ]);
    await page().findByRole("button", { name: "Apply 3 selected" });
  });

  it("applies a review of only the research record without previews", async () => {
    const current = { ...task("record-only"), recordDir: "research/notes-1a2b" };
    if (!current.result) throw new Error("Missing review fixture");
    current.result.changedFiles = [
      { ...current.result.changedFiles[0], path: "research/notes-1a2b/ledger.tsv", kind: "added" },
    ];
    const input = props(current);
    render(<TaskDetailDialog {...input} />);

    expect(page().queryByText(enResearchTools.tasks.detail.previewBeforeApply)).not.toBeInTheDocument();
    fireEvent.click(page().getByRole("button", { name: "Apply 1 selected" }));
    expect(input.onApply).toHaveBeenCalledWith(["research/notes-1a2b/ledger.tsv"]);
    expect(page().getByRole("button", { name: enResearchTools.tasks.detail.applying })).toBeInTheDocument();
    await page().findByRole("button", { name: "Apply 1 selected" });
  });

  it("keeps applying disabled after a failed preview and recovers on retry", async () => {
    previewMocks.file.mockRejectedValueOnce(new Error("Preview no longer matches the saved task"));
    previewMocks.file.mockResolvedValueOnce(preview("recovered output"));
    render(<TaskDetailDialog {...props(task("review"))} />);

    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    expect(await page().findByRole("alert")).toHaveTextContent("Preview no longer matches");
    expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeDisabled();
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await page().findByText("before -> recovered output");
    expect(page().queryByRole("alert")).not.toBeInTheDocument();
    expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeEnabled();
  });

  it("rejects a pending preview from the previous execution of the same task", async () => {
    const pending = deferred<TaskFilePreview>();
    previewMocks.file.mockReturnValue(pending.promise);
    const current = task("same-task");
    const view = render(<TaskDetailDialog {...props(current)} />);
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    const next = { ...task(current.id), executionGeneration: 2 };
    view.rerender(<TaskDetailDialog {...props(next)} />);
    await act(async () => pending.resolve(preview("previous execution output")));

    expect(page().queryByText(/previous execution output/)).not.toBeInTheDocument();
    expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeDisabled();
  });

  it("lets an unchanged result be reviewed without applying files", () => {
    const current = task("unchanged");
    if (!current.result) throw new Error("Missing review fixture");
    current.result.changedFiles = [];
    const input = props(current);
    const view = render(<TaskDetailDialog {...input} />);
    expect(page().getByText(enResearchTools.tasks.detail.noFilesChanged)).toBeInTheDocument();
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.markReviewed }));
    expect(input.onAccept).toHaveBeenCalledOnce();
    expect(input.onApply).not.toHaveBeenCalled();
    view.rerender(<TaskDetailDialog {...input} task={{ ...current, status: "completed" }} />);
    expect(page().queryByRole("button", { name: enResearchTools.tasks.detail.markReviewed })).not.toBeInTheDocument();
  });

  it("shows dependency blockers and schedules a queued task without claiming it is running", () => {
    const current = { ...task("dependent"), status: "queued" as const, dependencyIds: ["dependency", "missing"] };
    const dependency = { ...task("dependency"), status: "running" as const };
    const input = { ...props(current), tasks: [current, dependency] };
    const view = render(<TaskDetailDialog {...input} />);

    expect(page().getByText("Task dependency")).toBeInTheDocument();
    expect(page().getByText("Unavailable")).toBeInTheDocument();
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.startWhenReady }));
    fireEvent.click(page().getByRole("button", { name: enCommon.actions.edit }));
    fireEvent.click(page().getByRole("button", { name: enCommon.actions.cancel }));
    fireEvent.click(
      within(page().getByRole("alertdialog")).getByRole("button", { name: enResearchTools.tasks.confirm.cancelTask }),
    );
    expect(input.onStart).toHaveBeenCalledOnce();
    expect(input.onEdit).toHaveBeenCalledOnce();
    expect(input.onCancel).toHaveBeenCalledOnce();
    view.rerender(<TaskDetailDialog {...input} task={{ ...current, startRequested: true }} />);
    expect(page().getByRole("button", { name: enResearchTools.tasks.detail.waiting })).toBeDisabled();
  });

  it("prevents repeated cancellation and permits retry after a failed run", () => {
    const current = { ...task("running"), status: "running" as const };
    const input = props(current);
    const view = render(<TaskDetailDialog {...input} />);
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.stopTask }));
    expect(input.onCancel).not.toHaveBeenCalled();
    fireEvent.click(
      within(page().getByRole("alertdialog")).getByRole("button", { name: enResearchTools.tasks.detail.stopTask }),
    );
    expect(input.onCancel).toHaveBeenCalledOnce();
    view.rerender(<TaskDetailDialog {...input} task={{ ...current, cancelRequested: true }} />);
    expect(page().getByRole("button", { name: enResearchTools.tasks.detail.stopping })).toBeDisabled();
    view.rerender(<TaskDetailDialog {...input} task={{ ...current, status: "failed", error: "The agent disconnected" }} />);
    expect(page().getByRole("alert")).toHaveTextContent("The agent disconnected");
    fireEvent.click(page().getByRole("button", { name: enCommon.actions.retry }));
    expect(input.onRetry).toHaveBeenCalledOnce();
    view.rerender(<TaskDetailDialog {...input} busy task={{ ...current, status: "cancelled" }} />);
    expect(page().getByRole("button", { name: enCommon.actions.retry })).toBeDisabled();
  });

  it("renders the transcript as a timeline with paired tool calls and folded usage", () => {
    const current = task("activity");
    const payloads: TaskRuntimeEvent[] = [
      { kind: "sessionBound", nativeSessionId: "native-session" },
      { kind: "status", message: "Reading sources" },
      { kind: "text", text: "Partial result" },
      { kind: "reasoning", text: "Compare the source measurements" },
      { kind: "tool", callId: "call_1", name: "read_file", phase: "request", detail: '{"path":"main.tex"}', status: "running" },
      { kind: "tool", callId: "call_1", name: "", phase: "result", detail: '{"path":"main.tex","content":"body"}', status: "done" },
      { kind: "artifact", artifact: { path: "report.md", label: "Evidence report", mediaType: "text/markdown" } },
      { kind: "usage", inputTokens: 74833, outputTokens: 1712 },
    ];
    const cliTask = { ...current, runtimeId: "acp", nativeSessionId: "native-session" };
    const input = {
      ...props(current), task: cliTask, tasks: [cliTask], canLoadMoreEvents: true, onOpenSession: vi.fn(),
      events: payloads.map((event, index) => ({ taskId: current.id, executionGeneration: 1, sequence: index + 1, event, createdAt: index })),
    };
    const view = render(<TaskDetailDialog {...input} />);
    openTab(enResearchTools.tasks.detail.tabActivity);
    expect(page().getByText(enResearchTools.tasks.timeline.sessionConnected)).toBeInTheDocument();
    expect(page().getByText("Reading sources")).toBeInTheDocument();
    expect(page().getByText("Partial result")).toBeInTheDocument();
    expect(page().queryByText("Compare the source measurements")).toBeNull();
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.reasoning }));
    expect(page().getByText("Compare the source measurements")).toBeInTheDocument();

    const card = page().getByTestId("research-tool-card");
    expect(card).toHaveTextContent("Read file");
    expect(card).not.toHaveTextContent("call_1");
    expect(page().queryByText(/Usage:/)).toBeNull();
    expect(page().getByText("Input 75k, output 1.7k")).toBeInTheDocument();
    expect(page().getByRole("button", { name: "Saved Evidence report" })).toBeInTheDocument();

    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.openSession }));
    fireEvent.click(page().getByRole("button", { name: enResearchTools.tasks.detail.loadMore }));
    expect(input.onOpenSession).toHaveBeenCalledWith(cliTask);
    expect(input.onLoadMoreEvents).toHaveBeenCalledOnce();
    view.rerender(<TaskDetailDialog {...input} eventsLoading />);
    expect(page().getByRole("button", { name: enResearchTools.tasks.detail.loadMore })).toBeDisabled();
    expect(within(page().getByRole("region", { name: enResearchTools.tasks.detail.tabActivity })).getByRole("status")).toHaveTextContent("Loading activity");
  });

  it("prefers final task totals over the last member usage and falls back per missing count", () => {
    const current = task("group-usage");
    if (!current.result) throw new Error("Missing task result fixture");
    const result = current.result;
    const input = {
      ...props(current),
      task: { ...current, result: { ...result, inputTokens: 723944, outputTokens: 5811 } },
      events: [{
        taskId: current.id, executionGeneration: 1, sequence: 1, createdAt: 1,
        event: { kind: "usage" as const, inputTokens: 24454, outputTokens: 67 },
      }],
    };
    const view = render(<TaskDetailDialog {...input} />);
    expect(page().getByText("Input 724k, output 5.8k")).toBeInTheDocument();
    expect(page().queryByText("Input 24k, output 67")).toBeNull();

    view.rerender(<TaskDetailDialog {...input} task={{
      ...current, result: { ...result, inputTokens: 0, outputTokens: null },
    }} />);
    expect(page().getByText("Input 0, output 67")).toBeInTheDocument();

    view.rerender(<TaskDetailDialog {...input} task={{ ...current, status: "running", result: null }} />);
    expect(page().getByText("Input 24k, output 67")).toBeInTheDocument();
  });

  it("marks an unfinished tool as interrupted and flags the failure milestone", () => {
    const current = {
      ...task("stopped"),
      status: "failed" as const,
      error: "The request timed out.",
    };
    const input = {
      ...props(current),
      events: [
        { kind: "status" as const, message: "Reading sources" },
        { kind: "tool" as const, name: "compile", detail: "{}" },
        { kind: "status" as const, message: "The request timed out." },
      ].map((event, index) => ({
        taskId: current.id,
        executionGeneration: 1,
        sequence: index + 1,
        event,
        createdAt: index,
      })),
    };
    render(<TaskDetailDialog {...input} />);
    openTab(enResearchTools.tasks.detail.tabActivity);

    const card = page().getByTestId("research-tool-card");
    expect(card).toHaveAttribute("data-research-status", "interrupted");
    expect(card).toHaveTextContent("Interrupted");
    expect(card).toHaveTextContent("Compile document");
    const activity = document.querySelector(
      'section[aria-labelledby="research-task-activity"]',
    ) as HTMLElement;
    expect(within(activity).getByText("The request timed out.")).toHaveClass("text-destructive");
  });

  it("expands a tool card to reveal its output instead of dumping it inline", () => {
    const current = task("tools");
    const input = {
      ...props(current),
      events: [
        { kind: "tool" as const, callId: "call_2", name: "literature_search", phase: "request" as const, detail: '{"query":"edge"}', status: "running" },
        { kind: "tool" as const, callId: "call_2", name: "", phase: "result" as const, detail: '{"results":[{"title":"A paper","publication_year":2024}]}', status: "done" },
      ].map((event, index) => ({ taskId: current.id, executionGeneration: 1, sequence: index + 1, event, createdAt: index })),
    };
    render(<TaskDetailDialog {...input} />);
    openTab(enResearchTools.tasks.detail.tabActivity);
    expect(page().queryByText(/A paper/)).toBeNull();
    fireEvent.click(page().getByRole("button", { name: /Search literature/ }));
    expect(page().getByText("A paper")).toBeInTheDocument();
  });

  it("previews a saved artifact from the activity timeline in the output tab", async () => {
    const current = task("timeline-artifact");
    if (!current.result) throw new Error("Missing review fixture");
    const artifact = { path: "report.md", label: "Evidence report", mediaType: "text/markdown" };
    current.result.artifacts = [artifact];
    previewMocks.artifact.mockResolvedValue({
      artifact,
      content: { exists: true, text: "Saved evidence", base64: null, mediaType: "text/markdown", binary: false, truncated: false, size: 14, sha256: "sha" },
    });
    render(
      <TaskDetailDialog
        {...props(current)}
        events={[
          {
            taskId: current.id,
            executionGeneration: 1,
            sequence: 1,
            event: { kind: "artifact", artifact },
            createdAt: 1,
          },
        ]}
      />,
    );
    openTab(enResearchTools.tasks.detail.tabActivity);
    fireEvent.click(page().getByRole("button", { name: "Saved Evidence report" }));
    await waitFor(() => expect(page().getByText("Saved evidence")).toBeInTheDocument());
    expect(previewMocks.artifact).toHaveBeenCalledWith(current.id, artifact.path, current.executionGeneration);
  }, 10_000);

  it.each(["text", "image", "binary"] as const)("previews a %s artifact without offering a dead open action", async (kind) => {
    const current = task("artifact");
    if (!current.result) throw new Error("Missing review fixture");
    const artifact = { path: "report.bin", label: "Evidence artifact", mediaType: null };
    current.result.artifacts = [artifact];
    const content: TaskArtifactPreview["content"] = {
      exists: true, text: kind === "text" ? "Evidence from the saved task" : null,
      base64: kind === "image" ? "aW1hZ2U=" : null,
      mediaType: kind === "image" ? "image/png" : null,
      binary: kind !== "text", truncated: false, size: 32, sha256: "artifact-sha",
    };
    previewMocks.artifact.mockResolvedValue({ artifact, content });
    render(<TaskDetailDialog {...props(current)} />);
    openTab(enResearchTools.tasks.detail.tabOutput);
    fireEvent.click(page().getByRole("button", { name: "Evidence artifactreport.bin" }));
    await waitFor(() => expect(page().getByText("Evidence artifact", { selector: "p" })).toBeInTheDocument());
    if (kind === "text") expect(page().getByText("Evidence from the saved task")).toBeInTheDocument();
    if (kind === "image") expect(page().getByRole("img", { name: artifact.label })).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
    if (kind === "binary") expect(page().getByText(/Binary file · 32 bytes/)).toBeInTheDocument();
    expect(page().queryByRole("button", { name: "Open elsewhere" })).not.toBeInTheDocument();
    expect(previewMocks.artifact).toHaveBeenCalledWith(current.id, artifact.path, current.executionGeneration);
  });

  it("warns and blocks a file that changed in the project after the task started", async () => {
    const current = task("drifted");
    previewMocks.file.mockResolvedValue({
      ...preview("after"),
      projectSha256: "someone-else-edited-it",
      baseIsCurrent: false,
    });
    render(<TaskDetailDialog {...props(current)} />);
    expect(page().getByRole("checkbox", { name: "Apply main.tex" })).toBeChecked();
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(page().getByRole("alert")).toHaveTextContent("changed in your project after this task started"),
    );
    const checkbox = page().getByRole("checkbox", { name: "Apply main.tex" });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(page().getByRole("button", { name: "Apply 0 selected" })).toBeDisabled();
  });

  it("keeps a changed file selected when applying merges it through the shared project", async () => {
    const current = task("merging");
    previewMocks.file.mockResolvedValue({
      ...preview("after"),
      projectSha256: "a-collaborator-edited-it",
      baseIsCurrent: false,
      mergesWithShared: true,
    });
    render(<TaskDetailDialog {...props(current)} />);
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await page().findByRole("button", { name: enResearchTools.tasks.detail.refreshPreview });

    const checkbox = page().getByRole("checkbox", { name: "Apply main.tex" });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(page().queryByRole("alert")).not.toBeInTheDocument();
    expect(page().queryByText(enResearchTools.tasks.detail.changedSince)).not.toBeInTheDocument();
    expect(page().getByText(enResearchTools.tasks.detail.mergesOnApply)).toBeInTheDocument();
    expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeEnabled();
  });

  it("keeps loaded previews and the reviewer's selection when the same run is refreshed", async () => {
    const current = task("refresh");
    previewMocks.file.mockResolvedValue(preview("after"));
    const input = props(current);
    const view = render(<TaskDetailDialog {...input} />);
    fireEvent.click(page().getByRole("checkbox", { name: "Apply main.tex" }));
    fireEvent.click(page().getByRole("button", { name: "Preview" }));
    await page().findByRole("button", { name: enResearchTools.tasks.detail.refreshPreview });

    const refreshed = JSON.parse(JSON.stringify(current)) as ResearchTask;
    view.rerender(<TaskDetailDialog {...input} task={refreshed} tasks={[refreshed]} />);

    expect(page().getByRole("button", { name: enResearchTools.tasks.detail.refreshPreview })).toBeInTheDocument();
    expect(page().getByRole("checkbox", { name: "Apply main.tex" })).not.toBeChecked();
  });

  it("offers deletion for a settled task and hides it while the task runs", () => {
    const current = task("removable");
    const input = props(current);
    const view = render(<TaskDetailDialog {...input} />);
    fireEvent.click(page().getByRole("button", { name: `Delete ${current.title}` }));
    expect(input.onDelete).toHaveBeenCalledOnce();
    view.rerender(<TaskDetailDialog {...input} task={{ ...current, status: "running" }} />);
    expect(page().queryByRole("button", { name: `Delete ${current.title}` })).not.toBeInTheDocument();
  });

  describe("review details", () => {
    const detail = enResearchTools.tasks.detail;

    function binaryPreview(path: string, before: boolean, after: boolean): TaskFilePreview {
      const side = (exists: boolean, size: number) => ({
        exists, text: null, base64: null, mediaType: "application/pdf", binary: true, truncated: false, size, sha256: `${size}`,
      });
      return {
        path,
        change: before ? (after ? "modified" : "deleted") : "added",
        before: side(before, 10),
        after: side(after, 20),
        projectSha256: "10",
        baseIsCurrent: true,
        mergesWithShared: false,
      };
    }

    function withFiles(...files: { path: string; kind: "added" | "modified" | "deleted" }[]) {
      const current = task("files");
      if (!current.result) throw new Error("Missing review fixture");
      current.result.changedFiles = files.map((file) => ({
        ...file, beforeSha256: null, afterSha256: null, beforeSize: null, afterSize: null,
      })) as never;
      return current;
    }

    it("labels added and deleted files and sizes binary previews", async () => {
      const current = withFiles({ path: "fig.pdf", kind: "added" }, { path: "old.pdf", kind: "deleted" });
      previewMocks.file.mockImplementation(async (_id: string, path: string) =>
        path === "fig.pdf" ? binaryPreview(path, false, true) : binaryPreview(path, true, false),
      );
      render(<TaskDetailDialog {...props(current)} />);

      expect(page().getByText(detail.changeAdded)).toBeInTheDocument();
      expect(page().getByText(detail.changeDeleted)).toBeInTheDocument();
      const [first, second] = page().getAllByRole("button", { name: "Preview" });
      fireEvent.click(first);
      await waitFor(() => expect(page().getByText(detail.beforeAbsent)).toBeInTheDocument());
      expect(page().getByText(detail.afterBytes.replace("{{size}}", "20"))).toBeInTheDocument();
      fireEvent.click(second);
      await waitFor(() => expect(page().getByText(detail.afterAbsent)).toBeInTheDocument());
      expect(page().getByText(detail.beforeBytes.replace("{{size}}", "10"))).toBeInTheDocument();
    });

    it("counts several files that changed in the project since the task started", async () => {
      const current = withFiles({ path: "a.tex", kind: "modified" }, { path: "b.tex", kind: "modified" });
      previewMocks.file.mockImplementation(async (_id: string, path: string) => ({
        ...preview("after"),
        path,
        baseIsCurrent: false,
      }));
      render(<TaskDetailDialog {...props(current)} />);

      for (const button of page().getAllByRole("button", { name: "Preview" })) fireEvent.click(button);

      await waitFor(() =>
        expect(page().getByRole("alert")).toHaveTextContent(detail.driftedMany.replace("{{fileCount}}", "2")),
      );
    });

    it("selects files that merge through the shared project but not blocked ones with Select all", async () => {
      const current = withFiles({ path: "a.tex", kind: "modified" }, { path: "b.tex", kind: "modified" });
      previewMocks.file.mockImplementation(async (_id: string, path: string) => ({
        ...preview("after"),
        path,
        baseIsCurrent: false,
        mergesWithShared: path === "a.tex",
      }));
      render(<TaskDetailDialog {...props(current)} />);
      for (const button of page().getAllByRole("button", { name: "Preview" })) fireEvent.click(button);
      await waitFor(() =>
        expect(page().getAllByRole("button", { name: detail.refreshPreview })).toHaveLength(2),
      );
      const merging = page().getByRole("checkbox", { name: "Apply a.tex" });
      const blocked = page().getByRole("checkbox", { name: "Apply b.tex" });

      fireEvent.click(merging);
      expect(merging).not.toBeChecked();
      fireEvent.click(page().getByRole("button", { name: detail.selectAll }));

      expect(merging).toBeChecked();
      expect(blocked).not.toBeChecked();
      expect(blocked).toBeDisabled();
      expect(page().getByRole("alert")).toHaveTextContent(detail.driftedOne.replace("{{path}}", "b.tex"));
    });

    it("shows why a file preview failed", async () => {
      previewMocks.file.mockRejectedValueOnce(new Error("snapshot pruned"));
      render(<TaskDetailDialog {...props(task("broken"))} />);

      fireEvent.click(page().getByRole("button", { name: "Preview" }));

      await waitFor(() => expect(page().getByRole("alert")).toHaveTextContent("snapshot pruned"));
    });

    it("shows why an artifact preview failed", async () => {
      const current = task("artifact-failure");
      if (!current.result) throw new Error("Missing review fixture");
      current.result.artifacts = [{ path: "out.csv", label: "Table", mediaType: "text/csv" }];
      previewMocks.artifact.mockRejectedValueOnce("artifact missing");
      render(<TaskDetailDialog {...props(current)} />);
      openTab(detail.tabOutput);

      fireEvent.click(page().getByRole("button", { name: "Tableout.csv" }));

      await waitFor(() => expect(page().getByText("artifact missing")).toBeInTheDocument());
    });

    it("names a Git worktree as the task's isolation", () => {
      render(
        <TaskDetailDialog
          {...props({ ...task("worktree"), isolation: { kind: "git_worktree" } as never })}
        />,
      );

      expect(page().getByText(new RegExp(detail.isolationWorktree))).toBeInTheDocument();
    });

    it("lets the reviewer clear and restore the file selection", () => {
      render(<TaskDetailDialog {...props(task("select"))} />);
      const checkbox = page().getByRole("checkbox", { name: "Apply main.tex" });

      fireEvent.click(page().getByRole("button", { name: detail.clearSelection }));
      expect(checkbox).not.toBeChecked();
      fireEvent.click(page().getByRole("button", { name: detail.selectAll }));
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });

    it("opens on the requested tab and says when a result has no summary", () => {
      const current = { ...task("quiet"), status: "completed" as const };
      if (!current.result) throw new Error("Missing review fixture");
      current.result.summary = "";
      render(<TaskDetailDialog {...props(current)} initialTab="output" />);

      expect(page().getByText(detail.noSummary)).toBeInTheDocument();
    });

    it("opens a finished task without output on its activity", () => {
      render(<TaskDetailDialog {...props({ ...task("bare"), status: "failed", result: null })} />);

      expect(page().getByRole("tab", { name: detail.tabActivity })).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("autoresearch", () => {
    const detail = enResearchTools.tasks.detail;
    const plan = enResearchTools.tasks.plan;
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    const workspace: TaskIsolationSummary = {
      kind: "staged_project",
      executionRoot: "/tasks/workspaces/failed/1",
      sourceRevision: "snapshot:base",
      baselineHash: "baseline",
      fileCount: 3,
      createdAt: 1,
    };

    function progressFixture(): TaskProgress {
      return {
        phase: "working",
        plan: [{ text: "Measure the baseline", done: false }],
        todos: [],
        ledger: [],
        best: null,
        runsInFlight: [],
        recentRuns: [],
        budget: { activeMinutes: 3, limitMinutes: 120, spentUsd: null, usdCap: null, runsStarted: 0, maxRuns: null },
        evidence: null,
        recordDir: "research/task-1a2b",
      };
    }

    function approvalRecord(id: string, taskId: string): ApprovalRecord {
      return {
        id,
        taskId,
        executionGeneration: 1,
        kind: "command",
        summary: `Install the packages for ${taskId}`,
        detail: "pip install -r requirements.txt",
        status: "pending",
        createdAt: 1,
        expiresAt: Date.UTC(2026, 9, 20, 9, 30),
        decidedAt: null,
      };
    }

    it("shows the phase of a running task and when a queued task starts", () => {
      const running: ResearchTask = { ...task("live"), status: "running", phase: "waiting_runs", result: null };
      const view = render(<TaskDetailDialog {...props(running)} />);
      expect(page().getByTestId("research-task-phase")).toHaveTextContent("Waiting for runs");

      view.rerender(<TaskDetailDialog {...props({ ...running, phase: null })} />);
      expect(page().queryByTestId("research-task-phase")).toBeNull();

      const runAfter = Date.UTC(2026, 9, 20, 9, 30);
      view.rerender(<TaskDetailDialog {...props({ ...running, status: "queued", runAfter })} />);
      expect(page().queryByTestId("research-task-phase")).toBeNull();
      expect(
        page().getByText(squash(detail.startsAt.replace("{{time}}", formatDateTime(new Date(runAfter))))),
      ).toBeInTheDocument();

      view.rerender(<TaskDetailDialog {...props({ ...running, status: "queued", runAfter: null })} />);
      expect(page().queryByText(/^Starts /)).toBeNull();
    });

    it("says why a task stopped at its budget once it is no longer running", async () => {
      const stopped: ResearchTask = { ...task("budget"), stopReason: "budget_time" };
      const view = render(<TaskDetailDialog {...props(stopped)} />);
      await backgroundSettingRead();
      expect(page().getByTestId("research-task-stop-reason")).toHaveTextContent(detail.stopReason.budgetTime);

      view.rerender(<TaskDetailDialog {...props({ ...stopped, stopReason: "budget_cost" })} />);
      expect(page().getByTestId("research-task-stop-reason")).toHaveTextContent(detail.stopReason.budgetCost);

      view.rerender(<TaskDetailDialog {...props({ ...stopped, stopReason: "budget_runs" })} />);
      expect(page().getByTestId("research-task-stop-reason")).toHaveTextContent(detail.stopReason.budgetRuns);

      view.rerender(<TaskDetailDialog {...props({ ...stopped, status: "running", result: null })} />);
      expect(page().queryByTestId("research-task-stop-reason")).toBeNull();
    });

    it("offers Resume and Start over for a failed task with a workspace", () => {
      const failed: ResearchTask = {
        ...task("failed"),
        status: "failed",
        isolation: workspace,
        result: null,
        error: "The agent disconnected",
      };
      const input = props(failed);
      const view = render(<TaskDetailDialog {...input} />);

      expect(page().queryByRole("button", { name: enCommon.actions.retry })).toBeNull();
      fireEvent.click(page().getByRole("button", { name: detail.resume }));
      fireEvent.click(page().getByRole("button", { name: detail.startOver }));
      expect(input.onRetry.mock.calls).toEqual([["resume"], ["fresh"]]);

      view.rerender(<TaskDetailDialog {...input} busy task={{ ...failed, status: "cancelled" }} />);
      expect(page().getByRole("button", { name: detail.resume })).toBeDisabled();
      expect(page().getByRole("button", { name: detail.startOver })).toBeDisabled();

      view.rerender(<TaskDetailDialog {...input} task={{ ...failed, isolation: null }} />);
      expect(page().queryByRole("button", { name: detail.resume })).toBeNull();
      fireEvent.click(page().getByRole("button", { name: enCommon.actions.retry }));
      expect(input.onRetry).toHaveBeenLastCalledWith("fresh");
    });

    it("ignores a rejected retry", async () => {
      const failed: ResearchTask = { ...task("rejected"), status: "failed", isolation: workspace, result: null };
      const input = {
        ...props(failed),
        onRetry: vi.fn(async () => {
          throw new Error("The saved workspace is gone. Start over instead.");
        }),
      };
      render(<TaskDetailDialog {...input} />);
      fireEvent.click(page().getByRole("button", { name: detail.resume }));
      fireEvent.click(page().getByRole("button", { name: detail.startOver }));
      await waitFor(() => expect(input.onRetry).toHaveBeenCalledTimes(2));
      expect(page().getByRole("button", { name: detail.resume })).toBeEnabled();
    });

    it("the Progress tab loads the task's progress", async () => {
      previewMocks.progress.mockResolvedValue(progressFixture());
      const running: ResearchTask = { ...task("progress"), status: "running", result: null };
      render(<TaskDetailDialog {...props(running)} />);
      expect(previewMocks.progress).not.toHaveBeenCalled();

      openTab(detail.tabProgress);

      const board = await page().findByTestId("research-task-progress");
      expect(within(board).getByText("Measure the baseline")).toBeInTheDocument();
      expect(previewMocks.progress).toHaveBeenCalledWith("progress");
    });

    it("stops polling progress when the dialog closes", async () => {
      const polls: Array<() => void> = [];
      const cleared: number[] = [];
      const realSet = window.setInterval.bind(window);
      const realClear = window.clearInterval.bind(window);
      const setSpy = vi.spyOn(window, "setInterval").mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...rest: unknown[]
      ) => {
        if (timeout === 3_000 && typeof handler === "function") {
          polls.push(handler as () => void);
          return 4_242;
        }
        return realSet(handler, timeout, ...rest);
      }) as typeof window.setInterval);
      const clearSpy = vi.spyOn(window, "clearInterval").mockImplementation(((handle?: number) => {
        if (handle === 4_242) cleared.push(handle);
        else realClear(handle);
      }) as typeof window.clearInterval);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      try {
        previewMocks.progress.mockResolvedValue(progressFixture());
        const running: ResearchTask = { ...task("polled"), status: "running", result: null };
        const view = render(<TaskDetailDialog {...props(running)} initialTab="progress" />);
        await page().findByTestId("research-task-progress");
        expect(polls).toHaveLength(1);
        await act(async () => polls[0]());
        expect(previewMocks.progress).toHaveBeenCalledTimes(2);

        view.rerender(<TaskDetailDialog {...props(running)} initialTab="progress" open={false} />);

        await waitFor(() => expect(cleared).toEqual([4_242]));
        expect(page().queryByTestId("research-task-progress")).toBeNull();
        expect(polls).toHaveLength(1);
        expect(previewMocks.progress).toHaveBeenCalledTimes(2);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        Reflect.deleteProperty(document, "visibilityState");
      }
    });

    it("shows the plan with Approve and Approve edited plan on a plan-ready task", async () => {
      const ready: ResearchTask = { ...task("plan"), status: "plan_ready", result: null };
      const input = { ...props(ready), onApprovePlan: vi.fn(async (_edited?: string) => {}) };
      render(<TaskDetailDialog {...input} />);
      expect(page().getByRole("tab", { name: detail.tabReview })).toHaveAttribute("aria-selected", "true");

      const editor = await page().findByRole("textbox", { name: plan.title });
      expect(editor).toHaveValue("- [ ] Measure the baseline");
      expect(previewMocks.plan).toHaveBeenCalledWith("plan");
      fireEvent.click(page().getByRole("button", { name: plan.approve }));
      expect(input.onApprovePlan).toHaveBeenLastCalledWith(undefined);

      fireEvent.change(editor, { target: { value: "- [ ] edited" } });
      fireEvent.click(page().getByRole("button", { name: plan.approveEdited }));
      expect(input.onApprovePlan).toHaveBeenLastCalledWith("- [ ] edited");

      fireEvent.click(page().getByRole("button", { name: plan.discard }));
      expect(input.onCancel).not.toHaveBeenCalled();
      fireEvent.click(
        within(page().getByRole("alertdialog")).getByRole("button", { name: enResearchTools.tasks.confirm.cancelTask }),
      );
      expect(input.onCancel).toHaveBeenCalledOnce();
      expect(page().getByRole("checkbox", { name: enResearchTools.brief.keepRunning })).toBeEnabled();
    });

    it("keeps the usual review when the plan cannot be approved from here", () => {
      const ready: ResearchTask = { ...task("plan-readonly"), status: "plan_ready", result: null };
      render(<TaskDetailDialog {...props(ready)} />);

      expect(page().queryByTestId("research-task-plan")).toBeNull();
      expect(page().getByText(detail.nothingToReview)).toBeInTheDocument();
      expect(previewMocks.plan).not.toHaveBeenCalled();
    });

    it("shows evidence checks on the Review tab and checks again on request", async () => {
      const evidence: EvidenceReport = {
        checkedAt: 1,
        checks: [
          { id: "build", status: "pass", items: [] },
          {
            id: "numbers",
            status: "warn",
            items: [{ code: "numbers.unknownRun", file: "results.tex", line: 4, params: { run: "r009" } }],
          },
        ],
      };
      const onRefreshEvidence = vi.fn(async () => {});
      render(<TaskDetailDialog {...props({ ...task("evidence"), evidence })} onRefreshEvidence={onRefreshEvidence} />);

      const checklist = await page().findByTestId("research-evidence");
      expect(checklist).toHaveTextContent(enResearchTools.evidence.checks.build);
      expect(checklist).toHaveTextContent("Run r009 doesn't exist.");
      expect(checklist).toHaveTextContent("results.tex:4");
      expect(page().getByRole("button", { name: "Apply 1 selected" })).toBeInTheDocument();
      fireEvent.click(within(checklist).getByRole("button", { name: enResearchTools.evidence.refresh }));
      await waitFor(() => expect(onRefreshEvidence).toHaveBeenCalledOnce());
    });

    it("shows the evidence checks while they run and leaves them out when there is nothing to show", async () => {
      const onRefreshEvidence = vi.fn(async () => {});
      const checking: ResearchTask = { ...task("checking"), status: "completed", phase: "checking_evidence" };
      const view = render(<TaskDetailDialog {...props(checking)} initialTab="review" onRefreshEvidence={onRefreshEvidence} />);
      const checklist = await page().findByTestId("research-evidence");
      expect(within(checklist).getByRole("status")).toHaveTextContent(enResearchTools.evidence.running);
      expect(within(checklist).getByRole("button", { name: enResearchTools.evidence.refresh })).toBeEnabled();

      view.rerender(
        <TaskDetailDialog {...props({ ...checking, phase: null })} initialTab="review" onRefreshEvidence={onRefreshEvidence} />,
      );
      expect(page().queryByTestId("research-evidence")).toBeNull();

      view.rerender(<TaskDetailDialog {...props(task("no-handler"))} initialTab="review" />);
      expect(page().queryByTestId("research-evidence")).toBeNull();
    });

    it("shows the task's own pending approvals in a banner", async () => {
      previewMocks.approvals.mockResolvedValue([approvalRecord("a1", "banner"), approvalRecord("a2", "elsewhere")]);
      const waiting: ResearchTask = { ...task("banner"), status: "running", pendingApprovals: 1, result: null };
      const view = render(<TaskDetailDialog {...props(waiting)} />);

      const banner = await page().findByTestId("research-pending-approvals");
      expect(previewMocks.approvals).toHaveBeenCalledWith("paper");
      const rows = within(banner).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("Install the packages for banner");

      view.rerender(<TaskDetailDialog {...props({ ...waiting, pendingApprovals: 0 })} />);
      expect(page().queryByTestId("research-pending-approvals")).toBeNull();
    });
  });

  describe("long activity", () => {
    const detail = enResearchTools.tasks.detail;
    const row = (sequence: number, message: string, taskId = "long") => ({
      taskId,
      executionGeneration: 1,
      sequence,
      event: { kind: "status" as const, message },
      createdAt: sequence,
    });
    const text = (sequence: number, value: string, generation = 1) => ({
      taskId: "long",
      executionGeneration: generation,
      sequence,
      event: { kind: "text" as const, text: value },
      createdAt: sequence,
    });
    const running = (): ResearchTask => ({ ...task("long"), status: "running", result: null });

    it("offers Load more above the newest activity, where older rows come from", async () => {
      const input = {
        ...props(running()),
        canLoadMoreEvents: true,
        events: [row(3999, "Older shown"), row(4000, "Newest saved")],
      };
      render(<TaskDetailDialog {...input} />);
      await backgroundSettingRead();

      const older = page().getByTestId("research-task-activity-older");
      expect(older).toHaveTextContent(detail.olderActivity);
      expect(older.compareDocumentPosition(page().getByText("Older shown")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const buttons = page().getAllByRole("button", { name: detail.loadMore });
      expect(buttons).toHaveLength(1);
      expect(older).toContainElement(buttons[0]);
      fireEvent.click(buttons[0]);
      expect(input.onLoadMoreEvents).toHaveBeenCalledOnce();
    });

    it("keeps the newest items mounted and shows older ones it holds before asking for more", async () => {
      const events = Array.from({ length: 250 }, (_, index) => row(index + 1, `Step ${index + 1}`));
      const input = { ...props(running()), events };
      render(<TaskDetailDialog {...input} />);
      await backgroundSettingRead();

      expect(page().queryByText("Step 50")).toBeNull();
      expect(page().getByText("Step 51")).toBeInTheDocument();
      expect(page().getByText("Step 250")).toBeInTheDocument();
      fireEvent.click(page().getByRole("button", { name: detail.loadMore }));

      expect(page().getByText("Step 1")).toBeInTheDocument();
      expect(input.onLoadMoreEvents).not.toHaveBeenCalled();
      expect(page().queryByTestId("research-task-activity-older")).toBeNull();
    });

    it("keeps Load more out of the footer, so the other tabs don't offer it", () => {
      render(<TaskDetailDialog {...props(task("long"))} canLoadMoreEvents events={[row(1, "Saved")]} />);
      openTab(detail.tabReview);
      expect(page().queryByRole("button", { name: detail.loadMore })).toBeNull();
    });

    it("offers no Load more when everything is loaded", () => {
      render(<TaskDetailDialog {...props(running())} events={[row(1, "Saved"), row(2, "Live")]} />);
      expect(page().queryByTestId("research-task-activity-older")).toBeNull();
      expect(page().queryByRole("button", { name: detail.loadMore })).toBeNull();
    });

    it("builds no timeline while another tab shows, and catches up when Activity opens", () => {
      const view = render(
        <TaskDetailDialog {...props(running())} initialTab="review" events={[text(1, "Streaming answer")]} />,
      );
      vi.mocked(timelineBuilders.buildTaskTimeline).mockClear();
      vi.mocked(timelineBuilders.buildTaskTimelineIncremental).mockClear();
      view.rerender(
        <TaskDetailDialog {...props(running())} initialTab="review" events={[text(1, "Streaming answer grows")]} />,
      );
      expect(timelineBuilders.buildTaskTimeline).not.toHaveBeenCalled();
      expect(timelineBuilders.buildTaskTimelineIncremental).not.toHaveBeenCalled();

      openTab(detail.tabActivity);
      expect(page().getByText("Streaming answer grows")).toBeInTheDocument();
    });

    it("follows a message while its text grows", () => {
      const view = render(<TaskDetailDialog {...props(running())} events={[text(1, "Thinking")]} />);
      const panel = page().getByRole("tabpanel");
      const scrolled = vi.fn();
      Object.defineProperty(panel, "scrollHeight", { configurable: true, get: () => 900 });
      Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => 0, set: scrolled });

      view.rerender(<TaskDetailDialog {...props(running())} events={[text(1, "Thinking about the ledger")]} />);

      expect(scrolled).toHaveBeenCalledWith(900);
    });

    it("streams only the newest message of a running task and redraws only the row that changed", () => {
      const view = render(
        <TaskDetailDialog
          {...props(running())}
          events={[text(1, "First message"), row(2, "Between"), text(3, "Second")]}
        />,
      );
      expect(page().getByText("First message")).not.toHaveAttribute("data-streaming");
      expect(page().getByText("Second")).toHaveAttribute("data-streaming", "true");

      markdownDraws.texts.length = 0;
      view.rerender(
        <TaskDetailDialog
          {...props(running())}
          events={[text(1, "First message"), row(2, "Between"), text(3, "Second message grows")]}
        />,
      );

      expect(markdownDraws.texts).toEqual(["Second message grows"]);
      expect(page().getByText("Second message grows")).toHaveAttribute("data-streaming", "true");
    });

    it("does not stream the messages of a task that is not running", () => {
      render(
        <TaskDetailDialog
          {...props({ ...task("long"), status: "awaiting_review" })}
          initialTab="activity"
          events={[text(1, "Done thinking")]}
        />,
      );
      expect(page().getByText("Done thinking")).not.toHaveAttribute("data-streaming");
    });

    it("keeps each earlier run in its own timeline and shows the end of a run it only partly loaded", async () => {
      previewMocks.events.mockImplementation(async (taskId: string, generation: number, before: number) => {
        const sequence = before === Number.MAX_SAFE_INTEGER ? 1000 : before - 1;
        return {
          events: [
            {
              taskId,
              executionGeneration: generation,
              sequence,
              event: { kind: "text", text: `Run ${generation} part ${sequence}.` },
              createdAt: 1,
            },
          ],
          nextSequence: null,
          previousSequence: generation === 2 ? sequence : null,
          resumedFrom: generation === 2 ? 1 : null,
        };
      });
      const current: ResearchTask = { ...task("long"), status: "running", result: null, executionGeneration: 3, resumedFrom: 2 };
      render(<TaskDetailDialog {...props(current)} />);
      const earlier = enResearchTools.backgroundHelper.earlierActivity;

      fireEvent.click(page().getByRole("button", { name: earlier }));
      await page().findByTestId("research-task-earlier-activity");
      await waitFor(() =>
        expect(page().getByTestId("research-task-earlier-activity")).toHaveTextContent(
          enResearchTools.backgroundHelper.earlierTruncated.replace("{{limit}}", "2,000"),
        ),
      );
      expect(previewMocks.events.mock.calls.filter(([, generation]) => generation === 2)).toHaveLength(10);
      expect(previewMocks.events).toHaveBeenCalledWith("long", 2, Number.MAX_SAFE_INTEGER, 200);
      expect(previewMocks.events).toHaveBeenCalledWith("long", 2, 1000, 200);
      expect(page().getByText(/Run 2 part 1000\.$/)).toBeInTheDocument();

      fireEvent.click(page().getByRole("button", { name: earlier }));
      await page().findByText("Run 1 part 1000.");
      expect(page().getByText("Run 1 part 1000.").textContent).toBe("Run 1 part 1000.");
      expect(page().getByText(/Run 2 part 1000/).textContent).not.toContain("Run 1");
    });
  });

  describe("file selection and keep running", () => {
    const detail = enResearchTools.tasks.detail;

    function withFiles(...paths: string[]) {
      const current = task("files");
      if (!current.result) throw new Error("Missing review fixture");
      current.result.changedFiles = paths.map((path) => ({
        path, kind: "modified", beforeSha256: null, afterSha256: null, beforeSize: null, afterSize: null,
      })) as never;
      return current;
    }

    it("lets the reviewer clear the selection while one file has changed since the task started", async () => {
      const current = withFiles("a.tex", "b.tex");
      previewMocks.file.mockImplementation(async (_id: string, path: string) => ({
        ...preview("after"),
        path,
        baseIsCurrent: path === "a.tex",
        mergesWithShared: false,
      }));
      render(<TaskDetailDialog {...props(current)} />);
      fireEvent.click(page().getAllByRole("button", { name: "Preview" })[1]);
      await waitFor(() => expect(page().getByRole("checkbox", { name: "Apply b.tex" })).toBeDisabled());
      const first = page().getByRole("checkbox", { name: "Apply a.tex" });
      expect(first).toBeChecked();

      fireEvent.click(page().getByRole("button", { name: detail.clearSelection }));
      expect(first).not.toBeChecked();
      fireEvent.click(page().getByRole("button", { name: detail.selectAll }));
      expect(first).toBeChecked();
      expect(page().getByRole("checkbox", { name: "Apply b.tex" })).not.toBeChecked();
    });

    it("turns Select all off when every file changed since the task started", async () => {
      const current = withFiles("a.tex");
      previewMocks.file.mockResolvedValue({ ...preview("after"), path: "a.tex", baseIsCurrent: false, mergesWithShared: false });
      render(<TaskDetailDialog {...props(current)} />);
      fireEvent.click(page().getByRole("button", { name: "Preview" }));

      await waitFor(() => expect(page().getByRole("button", { name: detail.selectAll })).toBeDisabled());
    });

    it("explains why a task that uses desktop apps can't keep running after Oleafly closes", async () => {
      const apps: ResearchTask = {
        ...task("apps"),
        status: "queued",
        result: null,
        brief: { ...task("apps").brief, permissions: { ...task("apps").brief.permissions, desktopApps: true } },
      };
      render(<TaskDetailDialog {...props(apps)} />);

      const keep = page().getByRole("checkbox", { name: new RegExp(enResearchTools.brief.keepRunning) });
      await waitFor(() => expect(page().getByText(detail.keepRunningDesktopApps)).toBeInTheDocument());
      expect(keep).toBeDisabled();
    });

    it("still lets a task that already keeps running with desktop apps turn it off", async () => {
      const current = task("apps-on");
      const apps: ResearchTask = {
        ...current,
        status: "queued",
        result: null,
        keepRunningAfterQuit: true,
        brief: { ...current.brief, permissions: { ...current.brief.permissions, desktopApps: true } },
      };
      render(<TaskDetailDialog {...props(apps)} />);

      const keep = page().getByRole("checkbox", { name: new RegExp(enResearchTools.brief.keepRunning) });
      await waitFor(() => expect(keep).toBeEnabled());
      expect(page().queryByText(detail.keepRunningDesktopApps)).toBeNull();
    });

    it("shows a coded preview failure as its sentence", async () => {
      previewMocks.file.mockRejectedValueOnce(
        `@oleafly/error:${JSON.stringify({ code: "project.folder_read_only", params: { name: "main.tex" }, detail: null })}`,
      );
      render(<TaskDetailDialog {...props(task("coded"))} />);

      fireEvent.click(page().getByRole("button", { name: "Preview" }));

      await waitFor(() => expect(page().getByRole("alert")).toHaveTextContent("main.tex or its folder is read-only"));
      expect(page().getByRole("alert")).not.toHaveTextContent("@oleafly/error");
    });
  });
});

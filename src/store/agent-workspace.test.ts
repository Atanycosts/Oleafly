import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocxAgentTools,
  DOCX_AGENT_HOST,
  registerDocxAgentSession,
  resetDocxAgentHostForTest,
} from "@/lib/docx-agent-host";
import type { DocxApplyResult, DocxSession, DocxTarget } from "@/lib/docx-session";
import { useFilesStore } from "@/store/files";
import {
  agentExecutionFlowKey,
  type AgentExecutionOrigin,
  type AgentWorkspaceOperation,
  useAgentWorkspaceStore,
  type AgentWorkspaceView,
} from "./agent-workspace";

function chatOrigin(flowId: string, chatId = "chat-1"): AgentExecutionOrigin {
  return { kind: "chat", flowId, chatId };
}

function operation(
  id: string,
  projectId: string,
  origin: AgentExecutionOrigin,
  phase: AgentWorkspaceOperation["phase"],
  revision: number,
): AgentWorkspaceOperation {
  return {
    id,
    projectId,
    sessionId: "session-1",
    origin,
    operation: "format",
    phase,
    target: {
      projectId,
      sessionId: "session-1",
      paragraphRef: "p1",
      sessionRevision: revision,
    },
    ...(phase === "failed" ? { error: "Formatting failed." } : {}),
  };
}

function resetAgentWorkspace(): void {
  useAgentWorkspaceStore.setState({
    projectId: null,
    views: {},
    operations: [],
    following: null,
    paused: false,
    latestTarget: null,
    navigation: null,
    sequence: 0,
  });
}

function docxSession(): DocxSession {
  const handle = { kind: "paragraph", ref: "p1" } as AutomationHandle<"paragraph">;
  return {
    revision: () => 2,
    listParagraphHandles: () => [handle],
    listParagraphs: () => [{ handle, text: "Original paragraph.", paraId: "para-1" }],
    readParagraph: () => ({ paragraphRef: handle.ref, revision: 2, paraId: "para-1",
      modelText: "Original paragraph.", displayText: "Original paragraph.", atoms: [],
      editableRanges: [{ start: 0, end: "Original paragraph.".length }] }),
    replaceParagraphRange: () => ({ ok: false, code: "unsupported-target",
      message: "Read only test session.", revision: 2, changed: false }),
    captureTarget: (target): DocxTarget => ({
      paragraph: target,
      original: "Original paragraph.",
      revision: 2,
      paraId: "para-1",
      structure: "original-structure",
    }),
    applySuggestion: (): DocxApplyResult => ({
      ok: false,
      code: "stale-target",
      message: "Read only test session.",
      revision: 2,
      changed: false,
    }),
    isSuggestionApplied: () => false,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

function wordView(role: AgentWorkspaceView["role"]): AgentWorkspaceView {
  return {
    projectId: "alpha",
    documentId: `document-${role}`,
    title: role === "original" ? "Original manuscript" : "Working manuscript",
    kind: "docx",
    role,
    revision: `sha256-${role}`,
    sessionId: "session-1",
    sessionRevision: 2,
    selection: {
      revision: "2",
      paragraphRef: "p1",
      paraId: "para-1",
      quote: "Original paragraph.",
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetAgentWorkspace();
  resetDocxAgentHostForTest();
  useFilesStore.setState({ projectId: "alpha" });
});

describe("agent workspace follow state", () => {
  it("holds navigation while paused, keeps the latest target, and reveals it on resume", () => {
    const origin = chatOrigin("flow-a");
    const store = useAgentWorkspaceStore.getState();
    store.setProject("alpha");
    store.beginFollow("alpha", origin);

    const started = operation("op-1", "alpha", origin, "started", 2);
    store.report(started);
    const visibleBeforePause = useAgentWorkspaceStore.getState().navigation;

    useAgentWorkspaceStore.getState().pause();
    const succeeded = operation("op-1", "alpha", origin, "succeeded", 3);
    useAgentWorkspaceStore.getState().report(succeeded);

    expect(useAgentWorkspaceStore.getState().navigation).toEqual(visibleBeforePause);
    expect(useAgentWorkspaceStore.getState().latestTarget).toMatchObject({
      operationId: "op-1",
      flowKey: agentExecutionFlowKey(origin),
      target: succeeded.target,
    });

    const pausedSequence = useAgentWorkspaceStore.getState().sequence;
    useAgentWorkspaceStore.getState().resume();

    expect(useAgentWorkspaceStore.getState()).toMatchObject({
      paused: false,
      navigation: {
        operationId: "op-1",
        flowKey: agentExecutionFlowKey(origin),
        target: succeeded.target,
      },
    });
    expect(useAgentWorkspaceStore.getState().navigation?.sequence).toBeGreaterThan(
      pausedSequence,
    );
  });

  it("ignores another flow or project when reporting navigation targets", () => {
    const followed = chatOrigin("followed");
    const otherFlow = chatOrigin("other-flow", "chat-2");
    const store = useAgentWorkspaceStore.getState();
    store.setProject("alpha");
    store.beginFollow("alpha", followed);
    store.report(operation("followed-op", "alpha", followed, "started", 2));
    const before = useAgentWorkspaceStore.getState();

    store.report(operation("other-flow-op", "alpha", otherFlow, "started", 3));
    store.report(operation("other-project-op", "beta", followed, "started", 4));

    expect(useAgentWorkspaceStore.getState().navigation).toBe(before.navigation);
    expect(useAgentWorkspaceStore.getState().latestTarget).toBe(before.latestTarget);
    expect(useAgentWorkspaceStore.getState().sequence).toBe(before.sequence);
    expect(useAgentWorkspaceStore.getState().operations.map((item) => item.id)).toEqual([
      "followed-op",
      "other-flow-op",
      "other-project-op",
    ]);
  });

  it("keeps task generations isolated and resumes the latest target from the selected generation", () => {
    const first: AgentExecutionOrigin = { kind: "task", taskId: "task", generation: 1 };
    const second: AgentExecutionOrigin = { kind: "task", taskId: "task", generation: 2 };
    const store = useAgentWorkspaceStore.getState();
    store.setProject("alpha");
    store.beginFollow("alpha", first);
    store.report(operation("first-generation", "alpha", first, "succeeded", 2));
    useAgentWorkspaceStore.getState().beginFollow("alpha", second);
    useAgentWorkspaceStore.getState().report(
      operation("late-first-generation", "alpha", first, "succeeded", 3),
    );

    expect(useAgentWorkspaceStore.getState().navigation).toBeNull();

    useAgentWorkspaceStore.getState().report(
      operation("second-generation", "alpha", second, "started", 3),
    );
    expect(useAgentWorkspaceStore.getState().navigation?.target.sessionRevision).toBe(3);
    useAgentWorkspaceStore.getState().pause();
    useAgentWorkspaceStore.getState().report(
      operation("second-generation", "alpha", second, "succeeded", 4),
    );
    expect(useAgentWorkspaceStore.getState().navigation?.target.sessionRevision).toBe(3);

    useAgentWorkspaceStore.getState().resume();
    expect(useAgentWorkspaceStore.getState().navigation).toMatchObject({
      operationId: "second-generation",
      flowKey: agentExecutionFlowKey(second),
      target: { sessionRevision: 4 },
    });
  });

  it("adopts the latest existing external operation only after the user follows it", () => {
    const origin: AgentExecutionOrigin = { kind: "external", flowId: "external-flow" };
    const store = useAgentWorkspaceStore.getState();
    store.setProject("alpha");
    store.report(operation("external-op", "alpha", origin, "started", 2));

    expect(useAgentWorkspaceStore.getState().following).toBeNull();
    expect(useAgentWorkspaceStore.getState().navigation).toBeNull();

    useAgentWorkspaceStore.getState().beginFollow("alpha", origin);

    expect(useAgentWorkspaceStore.getState().following).toEqual({
      projectId: "alpha",
      flowKey: agentExecutionFlowKey(origin),
    });
    expect(useAgentWorkspaceStore.getState().navigation).toMatchObject({
      operationId: "external-op",
      flowKey: agentExecutionFlowKey(origin),
      target: {
        projectId: "alpha",
        sessionId: "session-1",
        paragraphRef: "p1",
        sessionRevision: 2,
      },
    });
  });

  it("clears follow and queued navigation when the project changes", () => {
    const origin = chatOrigin("flow-a");
    const store = useAgentWorkspaceStore.getState();
    store.setProject("alpha");
    store.beginFollow("alpha", origin);
    store.report(operation("alpha-op", "alpha", origin, "started", 2));
    useAgentWorkspaceStore.getState().pause();

    useAgentWorkspaceStore.getState().setProject("beta");
    useAgentWorkspaceStore.getState().report(
      operation("late-alpha-op", "alpha", origin, "succeeded", 3),
    );

    expect(useAgentWorkspaceStore.getState()).toMatchObject({
      projectId: "beta",
      following: null,
      paused: false,
      latestTarget: null,
      navigation: null,
    });

    useAgentWorkspaceStore.getState().setProject("alpha");
    useAgentWorkspaceStore.getState().report(
      operation("another-alpha-op", "alpha", origin, "started", 4),
    );
    expect(useAgentWorkspaceStore.getState().following).toBeNull();
    expect(useAgentWorkspaceStore.getState().navigation).toBeNull();
  });

  it("keeps one operation record as started, succeeded, or failed phases arrive", () => {
    const origin = chatOrigin("flow-a");
    const store = useAgentWorkspaceStore.getState();
    store.setProject("alpha");

    store.report(operation("op-1", "alpha", origin, "started", 2));
    store.report(operation("op-2", "alpha", origin, "started", 2));
    store.report(operation("op-1", "alpha", origin, "succeeded", 3));
    store.report(operation("op-3", "alpha", origin, "failed", 3));
    store.report(operation("op-2", "alpha", origin, "failed", 3));

    const operations = useAgentWorkspaceStore.getState().operations;
    expect(operations.map(({ id, phase }) => ({ id, phase }))).toEqual([
      { id: "op-1", phase: "succeeded" },
      { id: "op-3", phase: "failed" },
      { id: "op-2", phase: "failed" },
    ]);
    expect(operations.find((item) => item.id === "op-1")?.target?.sessionRevision).toBe(3);
    expect(operations.find((item) => item.id === "op-2")).toMatchObject({
      error: "Formatting failed.",
      target: { sessionRevision: 3 },
    });
  });
});

describe("viewed originals", () => {
  it("never promotes an original selection to a writable Word target", async () => {
    registerDocxAgentSession({
      sessionId: "session-1",
      appProjectId: "alpha",
      workbenchProjectId: "paper-project",
      title: "Working manuscript",
      filename: "paper.docx",
      baselineId: "baseline-1",
      savedRevision: 2,
      sourceSha256: "a".repeat(64),
      session: docxSession(),
    });
    useAgentWorkspaceStore.getState().setProject("alpha");

    useAgentWorkspaceStore.getState().publishView(wordView("original"));
    const originalContext = await DOCX_AGENT_HOST.workspaceContext?.();
    expect(originalContext?.viewed).toMatchObject({
      role: "original",
      selection: { paragraphRef: "p1", revision: "2" },
    });
    expect(originalContext?.writable).toHaveLength(1);
    expect(originalContext?.selectionWriteTarget).toBeNull();

    useAgentWorkspaceStore.getState().publishView(wordView("working"));
    const workingContext = await DOCX_AGENT_HOST.workspaceContext?.();
    expect(workingContext?.selectionWriteTarget).toEqual({
      sessionId: "session-1",
      paragraphRef: "p1",
      revision: 2,
    });
  });
});

describe("DOCX operation projection", () => {
  it("projects a real tool call through started to its terminal phase", async () => {
    let revision = 0;
    const session = docxSession();
    session.revision = () => revision;
    session.formatParagraph = (_target, expectedRevision) => {
      if (expectedRevision !== revision) {
        return {
          ok: false,
          code: "stale-target",
          message: "The revision changed.",
          revision,
          changed: false,
        };
      }
      revision += 1;
      return { ok: true, changed: true, revision };
    };
    registerDocxAgentSession({
      sessionId: "session-1",
      appProjectId: "alpha",
      workbenchProjectId: "paper-project",
      title: "Working manuscript",
      filename: "paper.docx",
      baselineId: "baseline-1",
      savedRevision: 0,
      sourceSha256: "a".repeat(64),
      session,
    });
    useAgentWorkspaceStore.getState().setProject("alpha");
    const report = vi.spyOn(useAgentWorkspaceStore.getState(), "report");

    const result = await createDocxAgentTools().apply_docx_format.execute({
      paragraph_ref: "p1",
      expected_revision: 0,
      font: { bold: true },
    });

    expect(result).toMatchObject({ ok: true, changed: true, revision: 1 });
    expect(useAgentWorkspaceStore.getState().operations).toHaveLength(1);
    expect(useAgentWorkspaceStore.getState().operations[0]).toMatchObject({
      projectId: "alpha",
      sessionId: "session-1",
      operation: "format",
      phase: "succeeded",
      target: {
        projectId: "alpha",
        sessionId: "session-1",
        paragraphRef: "p1",
        sessionRevision: 1,
      },
      result: { ok: true, changed: true, revision: 1 },
    });
    expect(report.mock.calls.map(([projected]) => projected.phase)).toEqual([
      "started",
      "succeeded",
    ]);

    const stale = await createDocxAgentTools().apply_docx_format.execute({
      paragraph_ref: "p1",
      expected_revision: 0,
      font: { italic: true },
    });

    expect(stale).toMatchObject({ ok: false, code: "stale-target", changed: false });
    expect(report.mock.calls.map(([projected]) => projected.phase)).toEqual([
      "started",
      "succeeded",
      "started",
      "failed",
    ]);
    expect(useAgentWorkspaceStore.getState().operations.map((item) => item.phase)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect(useAgentWorkspaceStore.getState().operations.at(-1)?.error).toBe(
      "The revision changed.",
    );
  });
});

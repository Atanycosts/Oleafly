import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesStore } from "@/store/files";
import type {
  DocxApplyResult,
  DocxFormatBatchOperation,
  DocxInlineAtom,
  DocxParagraph,
  DocxSession,
  DocxTarget,
} from "./docx-session";

const mocks = vi.hoisted(() => ({
  runInlineCompletion: vi.fn(),
  templateSource: vi.fn(),
  compileDocxEquation: vi.fn(),
}));

vi.mock("@/lib/ai-inline", () => ({
  runInlineCompletion: mocks.runInlineCompletion,
}));
vi.mock("@/lib/docx-template-client", () => ({ loadTemplateSource: mocks.templateSource }));
vi.mock("@/lib/docx-equation-conversion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docx-equation-conversion")>();
  return { ...actual, compileDocxEquation: mocks.compileDocxEquation };
});

import {
  createDocxAgentTools,
  getDocxWorkspaceContext,
  revealDocxWorkspaceTarget,
  DOCX_AGENT_HOST,
  registerDocxAgentSession,
  resetDocxAgentHostForTest,
  runTaskDocxOperation,
  readTaskDocxDocumentPage,
  readTaskDocxImage,
  settleTaskDocxOperation,
  subscribeDocxAgentSessions,
  unregisterDocxAgentSession,
  updateDocxAgentSession,
} from "./docx-agent-host";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { beginChatRun, endChatRun } from "@/components/ai/chat-run-registry";
import { docxReadForTool, type DocxReadQuery } from "@oleafly/ai-tools";
import { DocxEquationConversionError, type CompiledDocxEquation } from "./docx-equation-conversion";

type DocxFormatReadQuery = Parameters<NonNullable<typeof DOCX_AGENT_HOST.readFormat>>[1];
type Exec = (input?: unknown) => Promise<unknown>;

function paragraph(ref: string, text: string, paraId = ref): DocxParagraph {
  return {
    handle: { kind: "paragraph", ref } as AutomationHandle<"paragraph">,
    text,
    paraId,
  };
}

function semantics(paragraph: DocxParagraph, revision = 0, overrides: {
  modelText?: string;
  displayText?: string;
  atoms?: readonly DocxInlineAtom[];
  editableRanges?: readonly { start: number; end: number }[];
} = {}) {
  const modelText = overrides.modelText ?? paragraph.text;
  const displayText = overrides.displayText ?? paragraph.text;
  const atoms = overrides.atoms ?? [];
  const editableRanges = overrides.editableRanges ?? (modelText ? [{ start: 0, end: modelText.length }] : []);
  return {
    paragraphRef: paragraph.handle.ref,
    revision,
    ...(paragraph.paraId ? { paraId: paragraph.paraId } : {}),
    modelText,
    displayText,
    atoms,
    editableRanges,
  };
}

function compiledEquation(overrides: Partial<CompiledDocxEquation> = {}): CompiledDocxEquation {
  return {
    latex: "x^2",
    macros: "",
    omml: "<m:oMath />",
    snippet: "<m:oMath />",
    warnings: [],
    sourceHash: "e".repeat(64),
    shape: {
      expectedMathObjects: 1,
      actualMathObjects: 1,
      display: true,
      structures: ["superscript"],
      mathVariants: [],
      variantCorrections: [],
    },
    ...overrides,
  };
}

function harness(
  initial = [paragraph("p1", "Original paragraph.")],
  initialSemantics?: (paragraph: DocxParagraph, revision: number) => ReturnType<typeof semantics>,
) {
  let revision = 0;
  let paragraphs = [...initial];
  const listeners = new Set<(revision: number) => void>();
  const session: DocxSession = {
    revision: () => revision,
    listParagraphs: () => paragraphs,
    listParagraphHandles: () => paragraphs.map((item) => item.handle),
    readParagraph: (handle) => {
      const current = paragraphs.find((item) => item.handle.ref === handle.ref);
      if (!current) throw new Error("missing paragraph");
      return initialSemantics?.(current, revision) ?? semantics(current, revision);
    },
    replaceParagraphRange: vi.fn((input) => {
      const current = paragraphs.find((item) => item.handle.ref === input.paragraphRef);
      if (!current || revision !== input.expectedRevision) {
        return { ok: false, code: "stale-target", message: "The paragraph changed.",
          revision, changed: false } as DocxApplyResult;
      }
      const expected = current.text.slice(input.modelRange.start, input.modelRange.end);
      if (expected !== input.expectedText) {
        return { ok: false, code: "expected-text-mismatch", message: "The expected text changed.",
          revision, changed: false } as DocxApplyResult;
      }
      paragraphs = paragraphs.map((item) => item.handle.ref === current.handle.ref
        ? { ...item, text: current.text.slice(0, input.modelRange.start) +
          input.text + current.text.slice(input.modelRange.end) }
        : item);
      revision += 1;
      for (const listener of listeners) listener(revision);
      return { ok: true, revision, changed: true } as DocxApplyResult;
    }),
    captureTarget: (handle): DocxTarget => {
      const paragraph = paragraphs.find((item) => item.handle.ref === handle.ref);
      if (!paragraph) throw new Error("missing paragraph");
      return {
        paragraph: paragraph.handle,
        original: paragraph.text,
        revision,
        paraId: paragraph.paraId,
        structure: `structure:${paragraph.text}`,
      };
    },
    applySuggestion: vi.fn((target: DocxTarget, text: string): DocxApplyResult => {
      const current = paragraphs.find((item) => item.handle.ref === target.paragraph.ref);
      if (!current || current.text !== target.original) {
        return {
          ok: false,
          code: "stale-target",
          message: "The target changed.",
          revision,
          changed: false,
        };
      }
      paragraphs = paragraphs.map((item) =>
        item.handle.ref === target.paragraph.ref ? { ...item, text } : item,
      );
      revision += 1;
      for (const listener of listeners) listener(revision);
      return { ok: true, revision, changed: true };
    }),
    isSuggestionApplied: (target, text) =>
      paragraphs.find((item) => item.handle.ref === target.paragraph.ref)?.text === text,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  };
  return {
    session,
    edit(ref: string, text: string) {
      paragraphs = paragraphs.map((item) =>
        item.handle.ref === ref ? { ...item, text } : item,
      );
      revision += 1;
      for (const listener of listeners) listener(revision);
    },
  };
}

function register(session: DocxSession, overrides: Record<string, unknown> = {}) {
  return registerDocxAgentSession({
    sessionId: "session-1",
    appProjectId: "app-project",
    workbenchProjectId: "paper-project",
    title: "Paper",
    filename: "paper.docx",
    baselineId: "baseline-1",
    savedRevision: 0,
    sourceSha256: "a".repeat(64),
    session,
    ...overrides,
  });
}

function tool(name: keyof ReturnType<typeof createDocxAgentTools>): Exec {
  return createDocxAgentTools()[name].execute as Exec;
}

beforeEach(() => {
  resetDocxAgentHostForTest();
  useFilesStore.setState({ projectId: "app-project" });
  mocks.runInlineCompletion.mockReset();
  mocks.compileDocxEquation.mockReset();
  useAgentWorkspaceStore.setState({ projectId: "app-project", views: {}, operations: [], following: null,
    navigation: null, latestTarget: null, paused: false, sequence: 0 });
});

describe("Word workspace context and execution feedback", () => {
  it("notifies session observers about edits and saved baselines, then removes a closed active session", async () => {
    const local = harness();
    const listener = vi.fn();
    const unsubscribe = subscribeDocxAgentSessions(listener);
    register(local.session);
    expect(listener).toHaveBeenCalledTimes(1);
    local.edit("p1", "Unsaved edit.");
    expect(listener).toHaveBeenCalledTimes(2);
    updateDocxAgentSession("session-1", { baselineId: "saved-edit", savedRevision: 1 });
    expect(listener).toHaveBeenCalledTimes(3);

    const second = harness([paragraph("p2", "Second working copy.")]);
    register(second.session, { sessionId: "session-2", filename: "second.docx" });
    expect((await DOCX_AGENT_HOST.readDocument()).document.sessionId).toBe("session-2");
    unregisterDocxAgentSession("session-2");
    expect((await DOCX_AGENT_HOST.readDocument()).document).toMatchObject({
      sessionId: "session-1", baselineId: "saved-edit", sessionRevision: 1, dirty: false,
    });
    const calls = listener.mock.calls.length;
    second.edit("p2", "Closed session edit.");
    expect(listener).toHaveBeenCalledTimes(calls);
    unsubscribe();
    local.edit("p1", "Later edit.");
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("settles a recorded task operation only in its original project and working copy", async () => {
    const recorded = vi.fn(async () => {});
    register(harness().session, { onTaskOperationRecorded: recorded });
    const scope = { projectId: "app-project", workbenchProjectId: "paper-project" };
    await settleTaskDocxOperation(scope, "committed-operation", "session-1");
    expect(recorded).toHaveBeenCalledExactlyOnceWith("committed-operation");
    await expect(settleTaskDocxOperation(
      { ...scope, workbenchProjectId: "other-paper" }, "committed-operation", "session-1",
    )).rejects.toThrow("unavailable or ambiguous");
    unregisterDocxAgentSession("session-1");
    await expect(settleTaskDocxOperation(scope, "committed-operation", "session-1"))
      .rejects.toThrow("unavailable or ambiguous");
    expect(recorded).toHaveBeenCalledOnce();
  });

  it("resolves the engine paragraph ID only when context is requested and refuses stale or reference selections", () => {
    const local = harness();
    const readParagraphs = vi.spyOn(local.session, "listParagraphs");
    register(local.session);
    const view = { projectId: "app-project", documentId: "paper", title: "Paper", kind: "docx" as const,
      role: "working" as const, revision: "0", sessionId: "session-1", sessionRevision: 0,
      selection: { revision: "0", paraId: "p1", quote: "Original paragraph." } };
    useAgentWorkspaceStore.getState().publishView(view);
    expect(readParagraphs).not.toHaveBeenCalled();
    expect(getDocxWorkspaceContext().selectionWriteTarget).toEqual({ sessionId: "session-1", paragraphRef: "p1", revision: 0 });
    expect(readParagraphs).toHaveBeenCalledOnce();
    readParagraphs.mockClear();

    local.edit("p1", "Manual edit");
    expect(getDocxWorkspaceContext().selectionWriteTarget).toBeNull();
    expect(readParagraphs).not.toHaveBeenCalled();
    const fresh = { ...view, revision: "1", sessionRevision: 1, selection: { ...view.selection, revision: "1" } };
    useAgentWorkspaceStore.getState().publishView({ ...fresh, role: "original" });
    expect(getDocxWorkspaceContext().selectionWriteTarget).toBeNull();
    expect(readParagraphs).not.toHaveBeenCalled();

    useAgentWorkspaceStore.getState().publishView({ ...fresh, selection: { revision: "1", paraId: "removed" } });
    expect(getDocxWorkspaceContext().selectionWriteTarget).toBeNull();
    useAgentWorkspaceStore.getState().publishView({ ...fresh, selection: { ...fresh.selection, paragraphRef: "another-paragraph" } });
    expect(getDocxWorkspaceContext().selectionWriteTarget).toBeNull();
    useAgentWorkspaceStore.getState().publishView(fresh);
    expect(getDocxWorkspaceContext().selectionWriteTarget).toEqual({ sessionId: "session-1", paragraphRef: "p1", revision: 1 });
  });

  it("keeps original selections separate and validates live write addresses against manual edits", () => {
    const local = harness();
    register(local.session);
    const view = { projectId: "app-project", documentId: "paper", title: "Paper", kind: "docx" as const,
      role: "original" as const, revision: "original-hash", sessionId: "session-1",
      selection: { revision: "0", paragraphRef: "p1", quote: "Original paragraph." } };
    useAgentWorkspaceStore.getState().publishView(view);
    expect(getDocxWorkspaceContext()).toMatchObject({ viewed: { role: "original" }, selectionWriteTarget: null,
      writable: [{ sessionId: "session-1", sessionRevision: 0, dirty: false }] });
    useAgentWorkspaceStore.getState().publishView({ ...view, role: "working" });
    expect(getDocxWorkspaceContext().selectionWriteTarget).toEqual({ sessionId: "session-1", paragraphRef: "p1", revision: 0 });
    local.edit("p1", "Manual edit");
    expect(getDocxWorkspaceContext()).toMatchObject({ selectionWriteTarget: null,
      writable: [{ sessionRevision: 1, dirty: true }] });
  });

  it("reports actual chat start, refusal and save success while respecting paused navigation", async () => {
    const local = harness();
    let finishSave!: (value: unknown) => void;
    const save = vi.fn(() => new Promise((resolve) => { finishSave = resolve; }));
    local.session.formatParagraph = vi.fn((): DocxApplyResult => ({ ok: false, code: "stale-target", message: "Manual edit advanced revision", changed: false, revision: 0 }));
    register(local.session, { save });
    const controller = new AbortController();
    const run = beginChatRun(controller, "app-project");
    const tools = createDocxAgentTools({ signal: controller.signal });
    const pending = tools.save_docx_document.execute({ expected_revision: 0 });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({ operation: "save", phase: "started",
      origin: { kind: "chat", flowId: run.flowId } });
    useAgentWorkspaceStore.getState().pause();
    const navigation = useAgentWorkspaceStore.getState().navigation;
    finishSave({ baselineId: "saved", revision: 0, sourceSha256: "b".repeat(64),
      document: { sessionId: "session-1", baselineId: "saved", sessionRevision: 0, savedRevision: 0, dirty: false } });
    await pending;
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({ phase: "succeeded", operation: "save", result: { baselineId: "saved" } });
    expect(useAgentWorkspaceStore.getState().navigation).toBe(navigation);
    await tools.apply_docx_format.execute({ paragraph_ref: "p1", expected_revision: 0, font: { size: 19 } });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({ phase: "failed", operation: "format", error: "Manual edit advanced revision" });
    endChatRun(run);
  });

  it("queues reveal until the host consumes it and refuses changed revisions or projects", async () => {
    const local = harness();
    const reveal = vi.fn();
    register(local.session, { reveal });
    const result = await createDocxAgentTools().reveal_docx_working_copy.execute({ paragraph_ref: "p1", expected_revision: 0 });
    expect(result).toMatchObject({ navigation: "requested" });
    expect(reveal).not.toHaveBeenCalled();
    const target = useAgentWorkspaceStore.getState().operations.at(-1)!.target!;
    const cancelled = new AbortController();
    cancelled.abort();
    await revealDocxWorkspaceTarget(target, cancelled.signal);
    expect(reveal).not.toHaveBeenCalled();
    await revealDocxWorkspaceTarget(target);
    expect(reveal).toHaveBeenCalledWith({ paragraphRef: "p1", paraId: "p1", expectedRevision: 0 });
    local.edit("p1", "changed");
    await expect(revealDocxWorkspaceTarget(target)).rejects.toThrow("earlier revision");
    await expect(revealDocxWorkspaceTarget({ ...target, projectId: "other" })).rejects.toThrow("another project");
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("does not present an older saved-baseline check as current after manual edits", async () => {
    const local = harness();
    let finishCheck!: () => void;
    register(local.session, { check: () => new Promise((resolve) => {
      finishCheck = () => resolve({ template: "world", check: { check_id: "retained-old-check" } });
    }) });
    const checking = createDocxAgentTools().check_docx_template.execute({ template: "world" });
    local.edit("p1", "Manual edit during check");
    finishCheck();
    expect(await checking).toMatchObject({ error: expect.stringContaining("changed while its saved baseline") });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({ operation: "check", phase: "failed" });
  });

  it("uses runtime task origin, scopes context and records callback failures", async () => {
    const local = harness();
    register(local.session, { prepareFonts: async () => ({ missing: ["SimSun"], resolving: true }),
      exportDocument: async () => { throw new Error("Export denied"); } });
    const origin = { kind: "task" as const, taskId: "actual-task", generation: 3 };
    const scope = { projectId: "app-project", workbenchProjectId: "paper-project", operationId: "op", origin };
    const result = await runTaskDocxOperation(scope, "session-1", "prepare_fonts", {});
    expect(result.result).toEqual({ missing: ["SimSun"], resolving: true });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({ id: "op", origin, phase: "succeeded" });
    await expect(runTaskDocxOperation({ ...scope, operationId: "export" }, "session-1", "export", {})).rejects.toThrow("Export denied");
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({ id: "export", origin, phase: "failed", error: "Error: Export denied" });
    const context = await runTaskDocxOperation(scope, "session-1", "context", {});
    expect(context.result).toMatchObject({ writable: [{ sessionId: "session-1" }] });
  });
});

describe("active DOCX Agent host", () => {
  it.each<{ query: DocxReadQuery; error: string }>([
    { query: { offset: -1 }, error: "offset must be a non-negative integer" },
    { query: { limit: 51 }, error: "one to fifty DOCX paragraphs" },
    { query: { textOffset: 0 }, error: "textOffset and textLimit must be supplied together" },
    { query: { textOffset: -1, textLimit: 10 }, error: "textOffset must be a non-negative UTF-16 offset" },
    { query: { textOffset: 0, textLimit: 8001 }, error: "one to eight thousand UTF-16 units" },
    { query: { atomOffset: -1 }, error: "atomOffset must be a non-negative atom index" },
    { query: { payloadOffset: -1 }, error: "payloadOffset must be a non-negative UTF-16 offset" },
    { query: { atomOffset: 0 }, error: "atomOffset requires textOffset and textLimit" },
    { query: { payloadOffset: 0 }, error: "payloadOffset requires atomOffset" },
    { query: { expectedRevision: -1 }, error: "expectedRevision must be a non-negative integer" },
    { query: { offset: 1, textOffset: 0, textLimit: 10 }, error: "does not identify an existing paragraph" },
  ])("rejects a malformed read continuation before reading paragraph content: $query", async ({ query, error }) => {
    const local = harness();
    const read = vi.spyOn(local.session, "readParagraph");
    register(local.session);
    await expect(DOCX_AGENT_HOST.readDocument(query)).rejects.toThrow(error);
    expect(read).not.toHaveBeenCalled();
    expect(local.session.revision()).toBe(0);
  });

  it("keeps a fresh recovered session dirty until it has a saved session revision", async () => {
    const local = harness([paragraph("p1", "Recovered unsaved text.")]);
    register(local.session, { savedRevision: -1 });
    const read = await DOCX_AGENT_HOST.readDocument();
    expect(read.document).toMatchObject({ sessionRevision: 0, savedRevision: -1, dirty: true });
    expect(read.paragraphs[0].text).toBe("Recovered unsaved text.");
    updateDocxAgentSession("session-1", { baselineId: "recovered-saved", savedRevision: 0 });
    expect((await DOCX_AGENT_HOST.readDocument()).document).toMatchObject({ baselineId: "recovered-saved", dirty: false });
  });
  it("lists and reads the live session while separating it from the saved baseline", async () => {
    const local = harness();
    register(local.session);
    local.edit("p1", "Unsaved text.");

    expect(await tool("list_docx_documents")({})).toEqual({
      documents: [
        expect.objectContaining({
          sessionId: "session-1",
          baselineId: "baseline-1",
          sessionRevision: 1,
          savedRevision: 0,
          dirty: true,
        }),
      ],
    });
    expect(await tool("read_docx_document")({})).toMatchObject({
      document: expect.objectContaining({
        sessionRevision: 1,
        savedRevision: 0,
        dirty: true,
      }),
      paragraphs: [
        { paragraphRef: "p1", text: "Unsaved text.", paraId: "p1",
          modelText: "Unsaved text.", displayText: "Unsaved text.", atoms: [],
          editableRanges: [{ start: 0, end: 13 }] },
      ],
      offset: 0, nextOffset: null, totalParagraphs: 1, next_query: null,
    });

    updateDocxAgentSession("session-1", {
      baselineId: "baseline-2",
      savedRevision: 1,
    });
    expect(await tool("read_docx_document")({})).toMatchObject({
      document: {
        baselineId: "baseline-2",
        sessionRevision: 1,
        savedRevision: 1,
        dirty: false,
      },
    });
  });

  it("captures, suggests and applies one current paragraph", async () => {
    const local = harness();
    register(local.session);
    mocks.runInlineCompletion.mockResolvedValue("Revised paragraph.");

    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string; revision: number; structure: string };
    expect(captured).toMatchObject({
      paragraphRef: "p1",
      text: "Original paragraph.",
      revision: 0,
      structure: "structure:Original paragraph.",
    });

    const suggestion = (await tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Make it clearer.",
      expected_revision: 0,
    })) as {
      target: { targetId: string };
      proposed: string;
      document: { sessionRevision: number; dirty: boolean };
    };
    expect(mocks.runInlineCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "Make it clearer.",
        selection: "Original paragraph.",
      }),
    );
    expect(suggestion).toMatchObject({
      proposed: "Revised paragraph.",
      document: { sessionRevision: 0, dirty: false },
    });

    expect(await tool("apply_docx_suggestion")({
      target_id: suggestion.target.targetId,
      expected_revision: 0,
      text: suggestion.proposed,
    })).toMatchObject({
      ok: true,
      changed: true,
      document: { sessionRevision: 1, savedRevision: 0, dirty: true },
    });
  });

  it("rejects stale expected and target revisions without overwriting newer text", async () => {
    const local = harness();
    register(local.session);
    mocks.runInlineCompletion.mockResolvedValue("Never applied.");
    const suggestion = (await tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Revise.",
    })) as { target: { targetId: string } };

    expect(await tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Revise.",
      expected_revision: 4,
    })).toEqual({
      error: expect.stringContaining("expected revision 4, current revision 0"),
    });
    expect(await tool("apply_docx_suggestion")({
      target_id: suggestion.target.targetId,
      expected_revision: 4,
      text: "Wrong revision.",
    })).toMatchObject({
      ok: false,
      code: "stale-target",
      changed: false,
    });

    local.edit("p1", "User changed this.");
    expect(await tool("apply_docx_suggestion")({
      target_id: suggestion.target.targetId,
      expected_revision: 0,
      text: "Never overwrite.",
    })).toEqual({
      error: "Error: The DOCX suggestion target changed since it was captured.",
    });
    expect(local.session.listParagraphs()[0].text).toBe("User changed this.");
  });

  it("rejects a target that changes while the suggestion is being generated", async () => {
    const local = harness();
    register(local.session);
    let finish!: (value: string) => void;
    mocks.runInlineCompletion.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );

    const pending = tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Revise.",
    });
    local.edit("p1", "User changed this first.");
    finish("Late suggestion.");

    await expect(pending).resolves.toEqual({
      error:
        "Error: The DOCX request was cancelled or its target changed.",
    });
  });

  it("streams the candidate to the caller and honors cancellation", async () => {
    const local = harness();
    register(local.session);
    const controller = new AbortController();
    const onToken = vi.fn();
    mocks.runInlineCompletion.mockImplementation(
      async ({ signal, onToken: emit }) => {
        emit("Partial candidate");
        expect(signal.aborted).toBe(false);
        return "Partial candidate";
      },
    );

    const streamingTools = createDocxAgentTools({
      signal: controller.signal,
      onToken,
    });
    expect(await (streamingTools.suggest_docx_change.execute as Exec)({
      paragraph_ref: "p1",
      instruction: "Revise.",
    })).toMatchObject({ proposed: "Partial candidate" });
    expect(onToken).toHaveBeenCalledWith("Partial candidate");

    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    controller.abort();
    const cancelledTools = createDocxAgentTools({
      signal: controller.signal,
    });
    expect(await (cancelledTools.apply_docx_suggestion.execute as Exec)({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Changed.",
    })).toMatchObject({
      error: expect.stringContaining("cancelled"),
    });
  });

  it("cannot apply a target after its session closes", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    unregisterDocxAgentSession("session-1");
    const reopened = harness();
    register(reopened.session);

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Must not apply.",
    })).toMatchObject({
      error: expect.stringContaining("no longer available"),
    });
    expect(reopened.session.applySuggestion).not.toHaveBeenCalled();
  });

  it("cannot use a target ID from another app project", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    useFilesStore.setState({ projectId: "other-project" });

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Must not apply.",
    })).toMatchObject({
      error: expect.stringContaining("not bound to the Agent for this project"),
    });
    expect(local.session.applySuggestion).not.toHaveBeenCalled();
  });

  it("refuses an unbound or other-project session", async () => {
    expect(await tool("read_docx_document")({})).toEqual({
      error: "Error: No active DOCX working copy is bound to the Agent.",
    });
    const local = harness();
    register(local.session, { appProjectId: "other-project" });
    expect(await tool("read_docx_document")({ session_id: "session-1" })).toEqual({
      error:
        "Error: DOCX session session-1 is not bound to the Agent for this project.",
    });
  });

  it("removes targets when the working copy closes", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    unregisterDocxAgentSession("session-1");

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Changed.",
    })).toEqual({
      error: `Error: DOCX suggestion target ${captured.targetId} is no longer available.`,
    });
  });

  it("does not bypass the session's complex-structure refusal", async () => {
    const local = harness();
    register(local.session);
    local.session.applySuggestion = vi.fn((): DocxApplyResult => ({
      ok: false,
      code: "unsupported-target",
      message: "Mixed formatting.",
      revision: 0,
      changed: false,
    }));
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Flattened.",
    })).toMatchObject({
      ok: false,
      code: expect.any(String),
      changed: false,
    });
  });

  it("rejects a stale target when the approval flow inspects it again", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };

    local.edit("p1", "User changed this while approval was pending.");

    await expect(DOCX_AGENT_HOST.inspectTarget(captured.targetId)).rejects.toThrow(
      "The DOCX suggestion target changed since it was captured.",
    );
    expect(local.session.applySuggestion).not.toHaveBeenCalled();
  });
});

function readableFormat(revision = 0, dirty = false) {
  return {
    document: { sessionId: "session-1", baselineId: "baseline-1",
      sessionRevision: revision, savedRevision: 0, dirty, filename: "paper.docx" },
    sourceSha256: "b".repeat(64), revision,
    paragraph: { paragraphRef: "p1", text: "Original paragraph.", revision,
      font: { bold: null, italic: null, underline: null, strikeThrough: null,
        highlightColor: null, subscript: null, superscript: null, name: null, size: null, color: null },
      paragraph: { alignment: "Left" as const, style: null, firstLineIndent: null,
        leftIndent: null, rightIndent: null, lineSpacing: null, spaceBefore: null,
        spaceAfter: null, widowControl: null, readingOrder: "LeftToRight" as const } },
    objects: [{ object_id: "word/document.xml#0.0", kind: "paragraph" }],
    total: 1, nextOffset: null,
  };
}

function retainedTemplateCheck(
  template = "world-v7",
  check: Record<string, unknown> = {},
) {
  return {
    template,
    check: {
      check_id: "check-7",
      project_id: "paper-project",
      baseline_id: "baseline-1",
      world_version_id: template,
      source_sha256: "a".repeat(64),
      validity: "CURRENT",
      stale_reasons: [],
      update_available: false,
      summary: {},
      ...check,
    },
  };
}

describe("live DOCX format, save and template tools", () => {
  it.each([
    ["apply_docx_format", "format", { paragraph_ref: "p1", expected_revision: 0, scope: "cell", cell: { fill: "D9EAF7" } }],
    ["apply_docx_format_batch", "format_batch", { expected_revision: 0, operations: [{ paragraph_ref: "p1", font: { bold: true } }] }],
    ["import_docx_template_styles", "import_styles", { expected_revision: 0, template: "world-selected", style_ids: ["Title"] }],
    ["replace_docx_text_range", "replace_range", { paragraph_ref: "p1", expected_revision: 0, range: { start: 0, end: 8 }, expected_text: "Original", replacement: "Revised" }],
    ["write_docx_equation", "write_equation", { paragraph_ref: "p1", expected_revision: 0, latex: "x^2", offset: 0 }],
  ] as const)("reports a successful ordinary %s against the actual edited session", async (name, operation, input) => {
    const local = harness();
    const mutate = () => {
      local.edit("p1", "Edited working copy.");
      return { ok: true as const, changed: true, revision: local.session.revision() };
    };
    const formatObject = vi.fn<NonNullable<DocxSession["formatObject"]>>(mutate);
    const formatBatch = vi.fn<NonNullable<DocxSession["formatBatch"]>>(mutate);
    const importTemplateStyles = vi.fn<NonNullable<DocxSession["importTemplateStyles"]>>(() => ({
      ...mutate(), styleIdMap: { Title: "ImportedTitle" }, themePolicy: "literal-source-fonts-and-stored-color-fallbacks",
    }));
    const writeEquation = vi.fn<NonNullable<DocxSession["writeEquation"]>>(mutate);
    const replaceParagraphRange = local.session.replaceParagraphRange;
    Object.assign(local.session, { formatObject, formatBatch, importTemplateStyles, writeEquation });
    mocks.templateSource.mockResolvedValue({ bytes: new Uint8Array([80, 75]), sourceSha256: "f".repeat(64) });
    mocks.compileDocxEquation.mockResolvedValue(compiledEquation());
    register(local.session);
    const tools = createDocxAgentTools({ runId: () => "external-edit" });
    const result = await (tools[name].execute as Exec)(input);
    expect(result).toMatchObject({ ok: true, document: { sessionRevision: 1, savedRevision: 0, dirty: true } });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({
      operation, phase: "succeeded", origin: { kind: "external", flowId: "external-edit" },
      target: { sessionId: "session-1", sessionRevision: 1 },
    });
    expect(local.session.revision()).toBe(1);
    if (name === "apply_docx_format") {
      expect(formatObject).toHaveBeenCalledExactlyOnceWith(
        paragraph("p1", "Original paragraph.").handle, 0, { kind: "cell", cell: { fill: "D9EAF7" } },
      );
    } else if (name === "apply_docx_format_batch") {
      expect(formatBatch).toHaveBeenCalledExactlyOnceWith([
        { target: paragraph("p1", "Original paragraph.").handle, font: { bold: true } },
      ], 0);
    } else if (name === "import_docx_template_styles") {
      expect(importTemplateStyles).toHaveBeenCalledExactlyOnceWith(new Uint8Array([80, 75]), ["Title"], 0);
    } else if (name === "replace_docx_text_range") {
      expect(replaceParagraphRange).toHaveBeenCalledExactlyOnceWith({
        paragraphRef: "p1", expectedRevision: 0, modelRange: { start: 0, end: 8 },
        expectedText: "Original", text: "Revised",
      });
      expect(local.session.listParagraphs()[0].text).toBe("Revised paragraph.");
    } else {
      expect(writeEquation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        paragraphRef: "p1", expectedRevision: 0, latex: "x^2", offset: 0,
      }), compiledEquation());
    }
  });

  it("reports a failed ordinary object format without claiming the working copy changed", async () => {
    const local = harness();
    local.session.formatObject = vi.fn<NonNullable<DocxSession["formatObject"]>>(() => ({ ok: false, changed: false,
      revision: 0, code: "transaction-refused", message: "The document is open for viewing." }));
    register(local.session);
    expect(await createDocxAgentTools().apply_docx_format.execute({
      paragraph_ref: "p1", expected_revision: 0, scope: "cell", cell: { fill: "D9EAF7" },
    })).toMatchObject({ ok: false, changed: false, document: { sessionRevision: 0, dirty: false } });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({
      operation: "format", phase: "failed", error: "The document is open for viewing.",
    });
    expect(local.session.revision()).toBe(0);
  });

  it.each([
    ["prepare_docx_fonts", "prepare_fonts", "prepareFonts"],
    ["export_docx_document", "export", "exportDocument"],
  ] as const)("records the real %s callback result and failure without changing the document", async (name, operation, callback) => {
    const local = harness();
    const prepareOrExport = vi.fn().mockResolvedValueOnce({ status: "completed", artifact: "retained-result" })
      .mockRejectedValueOnce(new Error("The retained source is unavailable."));
    register(local.session, { [callback]: prepareOrExport });
    const tools = createDocxAgentTools();
    expect(await (tools[name].execute as Exec)({ session_id: "session-1" }))
      .toEqual({ status: "completed", artifact: "retained-result" });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({
      operation, phase: "succeeded", result: { artifact: "retained-result" },
    });
    expect(await (tools[name].execute as Exec)({ session_id: "session-1" }))
      .toMatchObject({ error: expect.stringContaining("The retained source is unavailable.") });
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({
      operation, phase: "failed", error: expect.stringContaining("The retained source is unavailable."),
    });
    expect(local.session.revision()).toBe(0);
    expect(prepareOrExport).toHaveBeenCalledTimes(2);
  });

  it("resolves the complete batch before any edit and checkpoints one actual task transaction", async () => {
    const local = harness([paragraph("p1", "One"), paragraph("p2", "Two")]);
    const checkpoint = vi.fn(async () => {});
    local.session.formatBatch = vi.fn((operations: readonly DocxFormatBatchOperation[], expectedRevision: number): DocxApplyResult => {
      expect(operations.map(item => item.target.ref)).toEqual(["p1", "p2"]);
      expect(expectedRevision).toBe(0);
      local.edit("p1", "One");
      return { ok: true, changed: true, revision: 1 };
    });
    register(local.session, { onTaskOperation: checkpoint });
    await expect(DOCX_AGENT_HOST.formatBatch?.("session-1", 0, [
      { paragraphRef: "p1", font: { bold: true } }, { paragraphRef: "missing", font: { italic: true } },
    ])).rejects.toThrow("not present");
    expect(local.session.formatBatch).not.toHaveBeenCalled();
    expect(local.session.revision()).toBe(0);
    expect(await runTaskDocxOperation({ projectId: "app-project", workbenchProjectId: "paper-project", operationId: "batch-one" },
      "session-1", "format_batch", { expectedRevision: 0, operations: [
        { paragraphRef: "p1", range: { start: 0, end: 2 }, font: { bold: true } },
        { paragraphRef: "p2", objectFormat: { kind: "frame", frame: null } },
      ] })).toMatchObject({ operation: "format_batch", ok: true, document: { sessionRevision: 1 }, checkpoint: { status: "recorded" } });
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: "batch-one" }));
  });

  it("imports only retained selected-template bytes and refuses cancellation after source reading", async () => {
    const local = harness();
    const bytes = new Uint8Array([80, 75]);
    const checkpoint = vi.fn(async () => {});
    mocks.templateSource.mockResolvedValue({ bytes, sourceSha256: "f".repeat(64), worldVersionId: "world-selected" });
    local.session.importTemplateStyles = vi.fn<NonNullable<DocxSession["importTemplateStyles"]>>((_bytes, _ids, revision) => {
      local.edit("p1", "Original paragraph.");
      return { ok: true, changed: true, revision: revision + 1, styleIdMap: { Title: "TitlePasted" }, themePolicy: "literal-source-fonts-and-stored-color-fallbacks" };
    });
    register(local.session, { onTaskOperation: checkpoint });
    const result = await runTaskDocxOperation({ projectId: "app-project", workbenchProjectId: "paper-project", operationId: "styles-one" },
      "session-1", "import_styles", { expectedRevision: 0, template: "world-selected", styleIds: ["Title"] });
    expect(result).toMatchObject({ operation: "import_styles", ok: true, result: {
      template: "world-selected", templateSourceSha256: "f".repeat(64), styleIdMap: { Title: "TitlePasted" },
    }, checkpoint: { status: "recorded" } });
    expect(local.session.importTemplateStyles).toHaveBeenCalledExactlyOnceWith(bytes, ["Title"], 0);
    const controller = new AbortController();
    mocks.templateSource.mockImplementationOnce(async () => { controller.abort(); return { bytes, sourceSha256: "f".repeat(64) }; });
    await expect(DOCX_AGENT_HOST.importTemplateStyles?.("session-1", "world-selected", ["Title"], 1, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(local.session.importTemplateStyles).toHaveBeenCalledTimes(1);
  });

  it("refuses an old task generation after template loading and preserves a committed edit receipt", async () => {
    const local = harness();
    const bytes = new Uint8Array([80, 75]);
    let generation = 1;
    const beforeCommit = vi.fn(async () => {
      if (generation !== 1) throw new Error("This DOCX task execution is no longer active.");
    });
    const checkpoint = vi.fn(async () => { generation = 2; });
    local.session.importTemplateStyles = vi.fn<NonNullable<DocxSession["importTemplateStyles"]>>((_bytes, _ids, revision) => {
      local.edit("p1", "Committed by generation 1");
      return { ok: true, changed: true, revision: revision + 1, styleIdMap: {}, themePolicy: "literal-source-fonts-and-stored-color-fallbacks" };
    });
    register(local.session, { onTaskOperation: checkpoint });
    const scope = { projectId: "app-project", workbenchProjectId: "paper-project", operationId: "old-generation", beforeCommit };
    mocks.templateSource.mockImplementationOnce(async () => {
      generation = 2;
      return { bytes, sourceSha256: "f".repeat(64) };
    });
    await expect(runTaskDocxOperation(scope, "session-1", "import_styles", {
      expectedRevision: 0, template: "world-selected", styleIds: ["Title"],
    })).rejects.toThrow("no longer active");
    expect(local.session.importTemplateStyles).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(local.session.revision()).toBe(0);

    generation = 1;
    mocks.templateSource.mockResolvedValue({ bytes, sourceSha256: "f".repeat(64) });
    await expect(runTaskDocxOperation(scope, "session-1", "import_styles", {
      expectedRevision: 0, template: "world-selected", styleIds: ["Title"],
    })).resolves.toMatchObject({ ok: true, document: { sessionRevision: 1 }, checkpoint: { status: "recorded" } });
    expect(generation).toBe(2);
    expect(local.session.importTemplateStyles).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  it("uses the paragraph handle for object formats and checkpoints the real task result", async () => {
    const local = harness();
    local.session.formatObject = vi.fn((handle, expectedRevision, format): DocxApplyResult => {
      expect(handle.ref).toBe("p1");
      expect(expectedRevision).toBe(local.session.revision());
      expect(format).toEqual({ kind: "cell", cell: { fill: "D9EAF7" } });
      local.edit("p1", "Original paragraph.");
      return { ok: true, revision: local.session.revision(), changed: true };
    });
    const checkpoint = vi.fn(async () => {});
    register(local.session, { onTaskOperation: checkpoint });
    const format = { kind: "cell" as const, cell: { fill: "D9EAF7" } };
    expect(await DOCX_AGENT_HOST.formatObject?.(undefined, "p1", 0, format)).toMatchObject({
      ok: true, document: { sessionRevision: 1, dirty: true },
    });
    expect(await runTaskDocxOperation({
      projectId: "app-project", workbenchProjectId: "paper-project", operationId: "cell-operation",
    }, "session-1", "format", { paragraphRef: "p1", expectedRevision: 1, objectFormat: format })).toMatchObject({
      operation: "format", ok: true, document: { sessionRevision: 2 }, checkpoint: { status: "recorded" },
    });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "cell-operation", result: expect.objectContaining({ operation: "format", ok: true }),
    }));
  });

  it("reads scoped format, applies one revisioned format transaction and preserves the actual session state", async () => {
    const local = harness();
    const readFormat = vi.fn(async (_query: DocxFormatReadQuery) =>
      readableFormat(local.session.revision(), local.session.revision() !== 0));
    const formatParagraph = vi.fn((handle, expectedRevision, format): DocxApplyResult => {
      if (expectedRevision !== local.session.revision()) {
        return { ok: false, code: "stale-target", message: "stale",
          revision: local.session.revision(), changed: false };
      }
      expect(handle).toEqual(paragraph("p1", "Original paragraph.").handle);
      expect(format).toEqual({
        font: { name: "Arial", size: 12 },
        paragraph: { alignment: "Centered", spaceAfter: 6 },
      });
      local.edit("p1", "Original paragraph.");
      return { ok: true, revision: 1, changed: true };
    });
    local.session.formatParagraph = formatParagraph;
    register(local.session, { readFormat });
    const confirm = vi.fn(async () => true);
    const mutationAllowed = vi.fn(() => true);
    const tools = createDocxAgentTools({ confirm, mutationAllowed });

    expect(await (tools.read_docx_format.execute as Exec)({
      query: { paragraph_ref: "p1", kind: "objects", limit: 10 },
    })).toMatchObject({ paragraph: { paragraphRef: "p1" }, nextOffset: null });
    expect(await (tools.apply_docx_format.execute as Exec)({
      paragraph_ref: "p1",
      expected_revision: 0,
      font: { name: "Arial", size: 12 },
      paragraph: { alignment: "Centered", spaceAfter: 6 },
    })).toMatchObject({
      ok: true,
      changed: true,
      revision: 1,
      document: { sessionRevision: 1, savedRevision: 0, dirty: true },
    });
    expect(formatParagraph).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      tool: "apply_docx_format",
      path: "paper.docx#p1",
    }));
    expect(mutationAllowed).toHaveBeenCalledTimes(2);
  });

  it("honors decline and cancellation before changing the live session", async () => {
    const local = harness();
    const readFormat = vi.fn(async () => readableFormat());
    const formatParagraph = vi.fn(() => ({ ok: true as const, revision: 1, changed: true }));
    local.session.formatParagraph = formatParagraph;
    register(local.session, { readFormat });

    expect(await (createDocxAgentTools({ confirm: async () => false })
      .apply_docx_format.execute as Exec)({
      paragraph_ref: "p1", expected_revision: 0, font: { bold: true },
    })).toMatchObject({ declined: true });
    expect(formatParagraph).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    expect(await (createDocxAgentTools({ signal: controller.signal })
      .apply_docx_format.execute as Exec)({
      paragraph_ref: "p1", expected_revision: 0, font: { bold: true },
    })).toEqual({
      error: "The external request was cancelled before mutation.",
    });
    expect(formatParagraph).not.toHaveBeenCalled();
  });

  it("passes the explicit world version and expected save revision to session callbacks", async () => {
    const local = harness();
    const save = vi.fn(async ({ expectedRevision }) => ({
      baselineId: "baseline-2", revision: expectedRevision, sourceSha256: "c".repeat(64),
      document: { sessionId: "session-1", baselineId: "baseline-2",
        sessionRevision: expectedRevision, savedRevision: expectedRevision, dirty: false },
    }));
    const check = vi.fn(async ({ template }) => retainedTemplateCheck(
      template,
      { baseline_id: "baseline-2", source_sha256: "c".repeat(64) },
    ));
    register(local.session, { save, check });
    const controller = new AbortController();
    const tools = createDocxAgentTools({ signal: controller.signal });

    expect(await (tools.save_docx_document.execute as Exec)({ expected_revision: 0 }))
      .toMatchObject({ baselineId: "baseline-2", revision: 0 });
    expect(await (tools.check_docx_template.execute as Exec)({
      template: "world-v7",
    })).toMatchObject({
      template: "world-v7",
      check: { check_id: "check-7" },
    });
    expect(save).toHaveBeenCalledWith({ expectedRevision: 0, signal: controller.signal });
    expect(check).toHaveBeenCalledWith({ template: "world-v7", signal: controller.signal });

    expect(await (tools.check_docx_template.execute as Exec)({ template: " " })).toEqual({
      error: "template must be an explicit world version ID.",
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it.each(["ordinary", "task"] as const)(
    "refuses %s template checking while the working copy has unsaved edits",
    async (route) => {
      const local = harness();
      const check = vi.fn(async ({ template }) => retainedTemplateCheck(template));
      local.edit("p1", "Unsaved paragraph.");
      register(local.session, { check });
      const scope = {
        projectId: "app-project",
        workbenchProjectId: "paper-project",
        operationId: "dirty-check",
      };

      if (route === "ordinary") {
        expect(await createDocxAgentTools().check_docx_template.execute({ template: "world-v7" }))
          .toEqual({ error: "Error: Save the current DOCX working copy before checking it." });
      } else {
        await expect(runTaskDocxOperation(
          scope, "session-1", "check", { template: "world-v7" },
        )).rejects.toThrow("Save the current DOCX working copy before checking it.");
      }
      expect(check).not.toHaveBeenCalled();
    },
  );

  it.each(["ordinary", "task"] as const)(
    "refuses %s template check receipts for another requested baseline, world or source",
    async (route) => {
      const local = harness();
      let response = retainedTemplateCheck();
      const check = vi.fn(async () => response);
      register(local.session, { check });
      const scope = {
        projectId: "app-project",
        workbenchProjectId: "paper-project",
        operationId: "mismatched-check",
      };
      const scenarios = [
        { response: retainedTemplateCheck("world-old"), message: "requested saved baseline" },
        {
          response: retainedTemplateCheck("world-v7", { baseline_id: "baseline-old" }),
          message: "requested saved baseline",
        },
        {
          response: retainedTemplateCheck("world-v7", { world_version_id: "world-old" }),
          message: "requested saved baseline",
        },
        {
          response: retainedTemplateCheck("world-v7", { source_sha256: "b".repeat(64) }),
          message: "requested saved baseline",
        },
        {
          response: retainedTemplateCheck("world-v7", { validity: "STALE" }),
          message: "requested saved baseline",
        },
      ];

      for (const scenario of scenarios) {
        response = scenario.response;
        if (route === "ordinary") {
          expect(await createDocxAgentTools().check_docx_template.execute({ template: "world-v7" }))
            .toEqual({ error: expect.stringContaining(scenario.message) });
        } else {
          await expect(runTaskDocxOperation(
            scope, "session-1", "check", { template: "world-v7" },
          )).rejects.toThrow(scenario.message);
        }
      }
      expect(check).toHaveBeenCalledTimes(scenarios.length);
    },
  );

  it.each(["ordinary", "task"] as const)(
    "preserves %s save receipts for an older fixed revision",
    async (route) => {
      const local = harness();
      local.edit("p1", "Revision one.");
      const save = vi.fn(async () => ({
        baselineId: "baseline-old",
        revision: 0,
        sourceSha256: "b".repeat(64),
        document: {
          sessionId: "session-1",
          baselineId: "baseline-old",
          sessionRevision: 1,
          savedRevision: 0,
          dirty: true,
        },
      }));
      const checkpoint = vi.fn(async () => {});
      register(local.session, { save, onTaskOperation: checkpoint });
      const scope = {
        projectId: "app-project",
        workbenchProjectId: "paper-project",
        operationId: "stale-save",
      };

      if (route === "ordinary") {
        expect(await createDocxAgentTools().save_docx_document.execute({ expected_revision: 1 }))
          .toMatchObject({
            ok: false,
            expectedRevision: 1,
            baselineId: "baseline-old",
            revision: 0,
            sourceSha256: "b".repeat(64),
            message: expect.stringContaining("committed revision 0, not the requested revision 1"),
            document: { sessionRevision: 1, savedRevision: 0, dirty: true },
          });
      } else {
        await expect(runTaskDocxOperation(
          scope, "session-1", "save", { expectedRevision: 1 },
        )).resolves.toMatchObject({
          operation: "save",
          ok: false,
          message: expect.stringContaining("committed revision 0, not the requested revision 1"),
          document: {
            baselineId: "baseline-old",
            sourceSha256: "b".repeat(64),
            sessionRevision: 1,
            savedRevision: 0,
          },
          result: {
            ok: false,
            expectedRevision: 1,
            baselineId: "baseline-old",
            revision: 0,
          },
        });
        expect(checkpoint).not.toHaveBeenCalled();
      }
      await expect(DOCX_AGENT_HOST.listDocuments()).resolves.toMatchObject([
        {
          baselineId: "baseline-old",
          sourceSha256: "b".repeat(64),
          sessionRevision: 1,
          savedRevision: 0,
          dirty: true,
        },
      ]);
    },
  );

  it("updates the registered baseline from an actual save without losing edits made during it", async () => {
    const local = harness();
    local.edit("p1", "Revision one.");
    const save = vi.fn(async ({ expectedRevision }) => {
      local.edit("p1", "Revision two while saving.");
      return {
        baselineId: "baseline-2",
        revision: expectedRevision,
        sourceSha256: "c".repeat(64),
        document: {
          sessionId: "session-1",
          baselineId: "baseline-2",
          sessionRevision: 2,
          savedRevision: expectedRevision,
          dirty: true,
        },
      };
    });
    register(local.session, { save });

    expect(await createDocxAgentTools().save_docx_document.execute({ expected_revision: 1 }))
      .toMatchObject({
        baselineId: "baseline-2",
        revision: 1,
        document: { sessionRevision: 2, savedRevision: 1, dirty: true },
      });
    expect(await DOCX_AGENT_HOST.readDocument()).toMatchObject({
      document: {
        baselineId: "baseline-2",
        sourceSha256: "c".repeat(64),
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
      },
    });
  });

  it("passes the exact save-start identity only for a tracked task save", async () => {
    const local = harness();
    local.edit("p1", "Revision one.");
    const checkpoint = vi.fn(async () => { throw new Error("checkpoint must not run after native save"); });
    const save = vi.fn(async ({ expectedRevision, operation }) => {
      if (operation) {
        expect(operation).toEqual({
          operationId: "tracked-save",
          document: {
            sessionId: "session-1",
            appProjectId: "app-project",
            workbenchProjectId: "paper-project",
            baselineId: "baseline-1",
            sourceSha256: "a".repeat(64),
            sessionRevision: 1,
            savedRevision: 0,
          },
        });
      }
      local.edit("p1", "Revision two while saving.");
      return {
        baselineId: `baseline-${expectedRevision + 1}`,
        revision: expectedRevision,
        sourceSha256: (expectedRevision === 1 ? "c" : "d").repeat(64),
        document: {
          sessionId: "session-1",
          baselineId: `baseline-${expectedRevision + 1}`,
          sessionRevision: local.session.revision(),
          savedRevision: expectedRevision,
          dirty: true,
        },
      };
    });
    register(local.session, { save, onTaskOperation: checkpoint });

    await expect(runTaskDocxOperation({
      projectId: "app-project",
      workbenchProjectId: "paper-project",
      operationId: "tracked-save",
    }, "session-1", "save", { expectedRevision: 1 })).resolves.toMatchObject({
      operation: "save",
      ok: true,
      document: {
        baselineId: "baseline-2",
        sourceSha256: "c".repeat(64),
        sessionRevision: 2,
        savedRevision: 1,
      },
    });
    expect(save).toHaveBeenCalledOnce();
    expect(checkpoint).not.toHaveBeenCalled();

    await expect(runTaskDocxOperation({
      projectId: "app-project",
      workbenchProjectId: "paper-project",
    }, "session-1", "save", { expectedRevision: 2 })).resolves.toMatchObject({
      operation: "save",
      ok: true,
      document: { baselineId: "baseline-3", sessionRevision: 3, savedRevision: 2 },
    });
    expect(save).toHaveBeenNthCalledWith(2, { expectedRevision: 2 });
  });

  it("reports unavailable callbacks instead of rebinding or adding a default", async () => {
    const local = harness();
    register(local.session);
    const tools = createDocxAgentTools();
    for (const [run, error] of [
      [() => (tools.read_docx_format.execute as Exec)({}),
        "Live DOCX formatting reads are unavailable for this working copy."],
      [() => (tools.save_docx_document.execute as Exec)({ expected_revision: 0 }),
        "Live DOCX saving is unavailable for this working copy."],
      [() => (tools.check_docx_template.execute as Exec)({ template: "world-v7" }),
        "Explicit DOCX template checking is unavailable for this working copy."],
    ] as const) expect(await run()).toEqual({ unavailable: true, error });
  });

  it("binds DOCX image pixels to the current project, session and object revision", async () => {
    const local = harness();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const readImage = vi.fn((input: {
      paragraphRef: string;
      objectRef: string;
      expectedRevision: number;
    }) => ({
      revision: input.expectedRevision,
      objectRef: input.objectRef,
      part: "word/document.xml",
      relationshipId: "rId7",
      mediaPart: "word/media/image1.png",
      mimeType: "image/png",
      bytes,
    }));
    register({ ...local.session, readImage });
    const readImageFromHost = DOCX_AGENT_HOST.readImage;
    if (!readImageFromHost) throw new Error("DOCX image host is unavailable.");
    await expect(readImageFromHost("session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 0,
    })).resolves.toMatchObject({
      revision: 0,
      objectRef: "drawing-1",
      imageSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceSha256: "a".repeat(64),
      document: {
        sessionId: "session-1",
        sessionRevision: 0,
        sourceSha256: "a".repeat(64),
      },
    });
    await expect(readTaskDocxImage({
      projectId: "app-project",
      workbenchProjectId: "paper-project",
    }, "session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 0,
    })).resolves.toMatchObject({ mediaPart: "word/media/image1.png" });
    await expect(readImageFromHost("session-1", {
      paragraphRef: "missing",
      objectRef: "drawing-1",
      expectedRevision: 0,
    })).rejects.toThrow("not present");
    await expect(readImageFromHost("session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 2,
    })).rejects.toThrow("revision changed");
    expect(() => readTaskDocxImage({
      projectId: "app-project",
      workbenchProjectId: "another-paper",
    }, "session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 0,
    })).toThrow("unavailable or ambiguous");
    const hashing = readImageFromHost("session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 0,
    });
    local.edit("p1", "Edited while hashing.");
    await expect(hashing).rejects.toThrow("changed while its pixels were being hashed");
    const sourceChange = readImageFromHost("session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 1,
    });
    updateDocxAgentSession("session-1", {
      baselineId: "baseline-2",
      sourceSha256: "d".repeat(64),
    });
    await expect(sourceChange).rejects.toThrow("changed while its pixels were being hashed");
    useFilesStore.setState({ projectId: "other-project" });
    await expect(readImageFromHost("session-1", {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 0,
    })).rejects.toThrow("not bound");
  });
});

describe("live DOCX equation writes", () => {
  const input = {
    sessionId: "session-1",
    paragraphRef: "p1",
    expectedRevision: 0,
    latex: "x^2",
    macros: "\\newcommand{\\R}{\\mathbb{R}}",
    objectRef: "math-1",
    expectedFingerprint: "fingerprint-1",
    adoptSource: true,
    offset: 3,
    display: true,
  };

  it("does not write when cancellation arrives while conversion is pending", async () => {
    const local = harness();
    const writeEquation = vi.fn(() => ({
      ok: true as const,
      changed: true,
      revision: 1,
    }));
    local.session.writeEquation = writeEquation;
    register(local.session);
    let finishConversion!: (compiled: CompiledDocxEquation) => void;
    mocks.compileDocxEquation.mockReturnValueOnce(
      new Promise<CompiledDocxEquation>((resolve) => {
        finishConversion = resolve;
      }),
    );
    const controller = new AbortController();
    const writeEquationFromHost = DOCX_AGENT_HOST.writeEquation;
    if (!writeEquationFromHost) throw new Error("DOCX equation writes are unavailable.");
    const pending = writeEquationFromHost(input, { signal: controller.signal });

    await vi.waitFor(() => expect(mocks.compileDocxEquation).toHaveBeenCalledExactlyOnceWith(input));
    controller.abort();
    finishConversion(compiledEquation());

    await expect(pending).rejects.toThrow("cancelled before mutation");
    expect(writeEquation).not.toHaveBeenCalled();
    expect(local.session.revision()).toBe(0);
    expect(local.session.listParagraphs()[0].text).toBe("Original paragraph.");
  });

  it("returns a stale refusal when the revision changes during conversion", async () => {
    const local = harness();
    const writeEquation = vi.fn<NonNullable<DocxSession["writeEquation"]>>((request) => {
      if (local.session.revision() !== request.expectedRevision) {
        return {
          ok: false,
          code: "stale-target",
          message: "The equation revision changed. Read the current paragraph again.",
          revision: local.session.revision(),
          changed: false,
        };
      }
      local.edit("p1", "Equation inserted.");
      return { ok: true, changed: true, revision: local.session.revision() };
    });
    local.session.writeEquation = writeEquation;
    register(local.session);
    let finishConversion!: (compiled: CompiledDocxEquation) => void;
    mocks.compileDocxEquation.mockReturnValueOnce(
      new Promise<CompiledDocxEquation>((resolve) => {
        finishConversion = resolve;
      }),
    );
    const writeEquationFromHost = DOCX_AGENT_HOST.writeEquation;
    if (!writeEquationFromHost) throw new Error("DOCX equation writes are unavailable.");
    const pending = writeEquationFromHost(input);

    await vi.waitFor(() => expect(mocks.compileDocxEquation).toHaveBeenCalledOnce());
    local.edit("p1", "Manual edit during conversion.");
    finishConversion(compiledEquation());

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "stale-target",
      changed: false,
      revision: 1,
      document: { sessionRevision: 1 },
    });
    expect(writeEquation).toHaveBeenCalledOnce();
    expect(local.session.revision()).toBe(1);
    expect(local.session.listParagraphs()[0].text).toBe("Manual edit during conversion.");
  });

  it("runs task commit validation after conversion and before the equation mutation", async () => {
    const local = harness();
    const order: string[] = [];
    let finishConversion!: (compiled: CompiledDocxEquation) => void;
    mocks.compileDocxEquation.mockImplementationOnce(() => {
      order.push("conversion");
      return new Promise<CompiledDocxEquation>((resolve) => {
        finishConversion = resolve;
      });
    });
    local.session.writeEquation = vi.fn<NonNullable<DocxSession["writeEquation"]>>((request) => {
      order.push("writeEquation");
      local.edit(request.paragraphRef, "Equation inserted.");
      return { ok: true, changed: true, revision: local.session.revision() };
    });
    register(local.session);
    const beforeCommit = vi.fn(async () => {
      order.push("beforeCommit");
    });
    const pending = runTaskDocxOperation({
      projectId: "app-project",
      workbenchProjectId: "paper-project",
      beforeCommit,
    }, "session-1", "write_equation", input);

    await vi.waitFor(() => expect(mocks.compileDocxEquation).toHaveBeenCalledOnce());
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(local.session.writeEquation).not.toHaveBeenCalled();

    finishConversion(compiledEquation());
    await expect(pending).resolves.toMatchObject({
      operation: "write_equation",
      ok: true,
      document: { sessionRevision: 1 },
    });
    expect(order).toEqual(["conversion", "beforeCommit", "writeEquation"]);
  });

  it("returns conversion errors without touching the document", async () => {
    const local = harness();
    const writeEquation = vi.fn();
    local.session.writeEquation = writeEquation;
    register(local.session);
    mocks.compileDocxEquation.mockRejectedValueOnce(
      new DocxEquationConversionError("invalid-source", "The equation could not be parsed.", ["line 1"]),
    );

    const writeEquationFromHost = DOCX_AGENT_HOST.writeEquation;
    if (!writeEquationFromHost) throw new Error("DOCX equation writes are unavailable.");
    await expect(writeEquationFromHost(input)).resolves.toMatchObject({
      ok: false,
      code: "invalid-source",
      message: "The equation could not be parsed.",
      changed: false,
      revision: 0,
      warnings: ["line 1"],
      document: { sessionRevision: 0 },
    });
    expect(writeEquation).not.toHaveBeenCalled();
    expect(local.session.revision()).toBe(0);
    expect(local.session.listParagraphs()[0].text).toBe("Original paragraph.");
  });

  it("records one checkpoint receipt after a successful task equation write", async () => {
    const local = harness();
    const compiled = compiledEquation();
    const writeEquation = vi.fn<NonNullable<DocxSession["writeEquation"]>>((request) => {
      local.edit(request.paragraphRef, "Equation inserted.");
      return { ok: true, changed: true, revision: local.session.revision() };
    });
    const onTaskOperation = vi.fn(async () => {});
    local.session.writeEquation = writeEquation;
    register(local.session, { onTaskOperation });
    mocks.compileDocxEquation.mockResolvedValueOnce(compiled);

    await expect(runTaskDocxOperation({
      projectId: "app-project",
      workbenchProjectId: "paper-project",
      operationId: "equation-op",
    }, "session-1", "write_equation", input)).resolves.toMatchObject({
      operation: "write_equation",
      ok: true,
      document: { sessionRevision: 1 },
      result: { sourceHash: compiled.sourceHash, warnings: [] },
      checkpoint: { status: "recorded" },
    });
    expect(writeEquation).toHaveBeenCalledExactlyOnceWith(input, compiled);
    expect(onTaskOperation).toHaveBeenCalledExactlyOnceWith({
      operationId: "equation-op",
      document: expect.objectContaining({ sessionId: "session-1", sessionRevision: 1 }),
      result: expect.objectContaining({
        operation: "write_equation",
        ok: true,
        result: expect.objectContaining({ sourceHash: compiled.sourceHash }),
      }),
    });
  });
});

describe("task-provided DOCX proposals", () => {
  const scope = { projectId: "app-project", workbenchProjectId: "paper-project" };
  it("carries the actual completed operation status in every task envelope", async () => {
    const local = harness();
    const readFormat = vi.fn(async () => readableFormat());
    const save = vi.fn(async ({ expectedRevision }) => ({
      baselineId: "baseline-2", revision: expectedRevision, sourceSha256: "c".repeat(64),
      document: { sessionId: "session-1", baselineId: "baseline-2",
        sessionRevision: expectedRevision, savedRevision: expectedRevision, dirty: false },
    }));
    const check = vi.fn(async ({ template }) => retainedTemplateCheck(
      template,
      { baseline_id: "baseline-2", source_sha256: "c".repeat(64) },
    ));
    register(local.session, {
      readFormat,
      save,
      check,
      ...{
        session: {
          ...local.session,
          formatParagraph: () => ({
            ok: false as const, code: "invalid-format" as const, message: "invalid",
            revision: 0, changed: false as const,
          }),
          applySuggestion: () => ({
            ok: false as const, code: "unsupported-target" as const, message: "unsupported",
            revision: 0, changed: false as const,
          }),
        },
      },
    });

    expect(await runTaskDocxOperation(scope, "session-1", "read_format", {
      query: { paragraphRef: "p1", kind: "objects", limit: 10 },
    })).toMatchObject({ operation: "read_format", ok: true });
    expect(await runTaskDocxOperation(scope, "session-1", "format", {
      paragraphRef: "p1", expectedRevision: 0, format: { font: { bold: true } },
    })).toMatchObject({ operation: "format", ok: false, result: { ok: false } });

    const { captureTaskDocxTarget } = await import("./docx-agent-host");
    const { target } = captureTaskDocxTarget(scope, "session-1", "p1");
    expect(await runTaskDocxOperation(scope, "session-1", "apply", {
      targetId: target.targetId, expectedRevision: 0, text: "Replacement.",
    })).toMatchObject({ operation: "apply", ok: false, result: { ok: false } });
    expect(await runTaskDocxOperation(scope, "session-1", "save", {
      expectedRevision: 0,
    })).toMatchObject({ operation: "save", ok: true });
    expect(await runTaskDocxOperation(scope, "session-1", "check", {
      template: "world-v7",
    })).toMatchObject({ operation: "check", ok: true });
  });

  it("keeps thrown task operation failures as errors", async () => {
    const local = harness();
    register(local.session, {
      readFormat: async () => { throw new Error("format read failed"); },
    });
    await expect(runTaskDocxOperation(scope, "session-1", "read_format", {
      query: { paragraphRef: "p1", kind: "objects", limit: 10 },
    })).rejects.toThrow("format read failed");
  });

  it("validates without generation and presents only retained proposals to the original session", async () => {
    const local = harness();
    const onTaskSuggestion = vi.fn();
    register(local.session, { sourceSha256: "a".repeat(64), onTaskSuggestion });
    const { captureTaskDocxTarget, validateTaskDocxProposal, presentTaskDocxProposal } = await import("./docx-agent-host");
    const captured = captureTaskDocxTarget(scope, "session-1", "p1");
    const verified = validateTaskDocxProposal(scope, captured.target.targetId, 0, "Task text.", "session-1");
    expect(verified.document).toEqual({ sessionId: "session-1", appProjectId: "app-project", workbenchProjectId: "paper-project", baselineId: "baseline-1", sourceSha256: "a".repeat(64), sessionRevision: 0, savedRevision: 0 });
    expect(onTaskSuggestion).not.toHaveBeenCalled();
    const activity = { id: "proposal-1", document: verified.document, origin: { taskId: "task-1", generation: 3, groupId: null, memberId: null, executionId: null, workIds: [] }, proposalId: null, createdAt: 1, event: { type: "runtime", event: { kind: "proposed", target: verified.target, proposed: "Task text." } } } as const;
    presentTaskDocxProposal(scope, { ...activity, origin: { ...activity.origin, workIds: [] } });
    expect(onTaskSuggestion).toHaveBeenCalledWith(activity, expect.objectContaining({ original: "Original paragraph.", revision: 0 }));
    expect(mocks.runInlineCompletion).not.toHaveBeenCalled();
    expect(local.session.applySuggestion).not.toHaveBeenCalled();
  });
  it("refuses busy, stale, foreign and closed target references", async () => {
    const local = harness();
    const canPresentSuggestion = vi.fn(() => false);
    register(local.session, { canPresentSuggestion });
    const { captureTaskDocxTarget, validateTaskDocxProposal } = await import("./docx-agent-host");
    const { target } = captureTaskDocxTarget(scope, "session-1", "p1");
    expect(() => validateTaskDocxProposal(scope, target.targetId, 0, "Candidate")).toThrow("awaiting review");
    canPresentSuggestion.mockReturnValue(true);
    expect(() => validateTaskDocxProposal(scope, target.targetId, 0, "Candidate", "another-session")).toThrow("another session");
    expect(() => validateTaskDocxProposal({ ...scope, workbenchProjectId: "other" }, target.targetId, 0, "Candidate")).toThrow("unavailable");
    local.edit("p1", "User text");
    expect(() => validateTaskDocxProposal(scope, target.targetId, 0, "Candidate")).toThrow("changed");
    unregisterDocxAgentSession("session-1");
    register(local.session);
    expect(() => validateTaskDocxProposal(scope, target.targetId, 0, "Candidate")).toThrow("no longer available");
  });
  it("reads bounded windows using explicit task scope even when a different project is selected", async () => {
    const local = harness(Array.from({ length: 55 }, (_, index) => paragraph(`p${index}`, `Text ${index}`)));
    register(local.session);
    useFilesStore.setState({ projectId: "another-ui-project" });
    const { readTaskDocxDocument, listTaskDocxDocuments } = await import("./docx-agent-host");
    const page = readTaskDocxDocument(scope, "session-1", 20);
    expect(page.offset).toBe(20);
    expect(page.totalParagraphs).toBe(55);
    expect(page.paragraphs).toEqual(expect.arrayContaining([
      expect.objectContaining({ paragraphRef: "p20", text: "Text 20", paraId: "p20" }),
    ]));
    expect(page.nextOffset).toBe(20 + page.paragraphs.length);
    expect(readTaskDocxDocument(scope, "session-1", 50).nextOffset).toBeNull();
    expect(() => readTaskDocxDocument(scope, "session-1", 0, 51)).toThrow("fifty");
    expect(listTaskDocxDocuments(scope, "other")).toEqual([]);
    expect(readTaskDocxDocument({ ...scope, workbenchProjectId: null }, "session-1", 0, 1).document.workbenchProjectId).toBe("paper-project");
  });
  it("rejects a stale read continuation while keeping the stable paragraph reference", async () => {
    const local = harness(Array.from({ length: 3 }, (_, index) => paragraph(`p${index}`, `Text ${index}`)));
    register(local.session);
    const { readTaskDocxDocument } = await import("./docx-agent-host");
    const first = readTaskDocxDocument(scope, "session-1", 0, 1);
    expect(first.paragraphs[0].paragraphRef).toBe("p0");
    local.edit("p2", "Changed");
    expect(() => readTaskDocxDocumentPage(scope, "session-1", first.nextQuery!))
      .toThrow("stale");
  });
  it("routes protected range replacement through task attribution and checkpointing", async () => {
    const local = harness();
    const onTaskOperation = vi.fn(async () => undefined);
    register(local.session, { onTaskOperation });
    const result = await runTaskDocxOperation({
      ...scope, operationId: "range-op",
      origin: { kind: "task", taskId: "task-1", generation: 1 },
    }, "session-1", "replace_range", {
      paragraphRef: "p1", expectedRevision: 0,
      range: { start: 0, end: 8 }, expectedText: "Original", replacement: "Revised",
    });
    expect(result).toMatchObject({
      operation: "replace_range", ok: true,
      result: { ok: true, changed: true, revision: 1 },
      checkpoint: { status: "recorded" },
    });
    expect(local.session.replaceParagraphRange).toHaveBeenCalledWith({
      paragraphRef: "p1", expectedRevision: 0,
      modelRange: { start: 0, end: 8 }, expectedText: "Original", text: "Revised",
    });
    expect(onTaskOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "range-op",
      result: expect.objectContaining({ operation: "replace_range", ok: true }),
    }));
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({
      operation: "replace_range", phase: "succeeded",
      origin: { kind: "task", taskId: "task-1" },
    });
  });
  it.each([
    ["stale-target", "The paragraph changed."],
    ["atomic-overlap", "The range crosses a protected atom."],
    ["format-boundary", "The range crosses a formatting boundary."],
  ] as const)("reports an ordinary rejected range write as failed: %s", async (code, message) => {
    const local = harness();
    local.session.replaceParagraphRange = vi.fn((): DocxApplyResult => ({
      ok: false, code, message, revision: 0, changed: false,
    }));
    register(local.session);
    const result = await createDocxAgentTools().replace_docx_text_range.execute({
      paragraph_ref: "p1", expected_revision: 0,
      range: { start: 0, end: 8 }, expected_text: "Original", replacement: "Revised",
    });
    expect(result).toMatchObject({ ok: false, code, message, changed: false });
    expect(local.session.replaceParagraphRange).toHaveBeenCalledOnce();
    expect(local.session.replaceParagraphRange).toHaveBeenCalledWith({
      paragraphRef: "p1", expectedRevision: 0,
      modelRange: { start: 0, end: 8 }, expectedText: "Original", text: "Revised",
    });
    expect(local.session.applySuggestion).not.toHaveBeenCalled();
    expect(useAgentWorkspaceStore.getState().operations.at(-1)).toMatchObject({
      operation: "replace_range", phase: "failed", error: message,
      result: { ok: false, code, message, changed: false },
    });
  });
  it("continues an oversized paragraph with UTF-16 text windows", async () => {
    const local = harness([paragraph("p1", "字".repeat(8000)), paragraph("p2", "字".repeat(8000))]);
    register(local.session);
    const { readTaskDocxDocument, readTaskDocxDocumentPage } = await import("./docx-agent-host");
    const first = readTaskDocxDocument(scope, "session-1");
    expect(first.paragraphs).toHaveLength(1);
    expect(first.textWindow).toMatchObject({ paragraphRef: "p1", offset: 0 });
    expect(first.nextQuery).toMatchObject({ expectedRevision: 0, textOffset: expect.any(Number) });
    let text = first.paragraphs[0].modelText;
    let query = first.nextQuery!;
    while (query.textOffset !== undefined) {
      const next = readTaskDocxDocumentPage(scope, "session-1", query);
      text += next.paragraphs[0].modelText;
      query = next.nextQuery!;
    }
    expect(text).toBe("字".repeat(8000));
    local.edit("p1", "字".repeat(12000));
    expect(() => readTaskDocxDocumentPage(scope, "session-1", first.nextQuery!))
      .toThrow("stale");
  });
  it("includes zero-width atoms at empty, text-end and paragraph-end boundaries", async () => {
    const emptyAtom: DocxInlineAtom = {
      objectRef: "vml-empty", kind: "drawing", modelRange: { start: 0, end: 0 },
      displayRange: { start: 0, end: 1 }, displayText: "\uFFFC", readable: true,
      complete: true, editable: false, payload: { kind: "vml_picture" },
    };
    const tailAtom: DocxInlineAtom = {
      objectRef: "vml-tail", kind: "drawing", modelRange: { start: 4, end: 4 },
      displayRange: { start: 4, end: 5 }, displayText: "\uFFFC", readable: true,
      complete: true, editable: false, payload: { kind: "vml_picture" },
    };
    const empty = harness([paragraph("p1", "")], (current, revision) =>
      semantics(current, revision, {
        displayText: "\uFFFC", atoms: [emptyAtom], editableRanges: [],
      }));
    register(empty.session);
    const { readTaskDocxDocument, readTaskDocxDocumentPage } = await import("./docx-agent-host");
    const emptyPage = readTaskDocxDocument(scope, "session-1");
    expect(emptyPage.paragraphs[0]).toMatchObject({
      modelText: "", displayText: "\uFFFC",
      atoms: [{ objectRef: "vml-empty", modelRange: { start: 0, end: 0 } }],
      editableRanges: [],
    });

    resetDocxAgentHostForTest();
    const tail = harness([paragraph("p1", "text")], (current, revision) =>
      semantics(current, revision, {
        displayText: "text\uFFFC", atoms: [tailAtom],
      }));
    register(tail.session);
    const full = readTaskDocxDocument(scope, "session-1");
    expect(full.paragraphs[0].atoms.map((atom) => atom.objectRef)).toEqual(["vml-tail"]);
    expect(full.paragraphs[0].displayText).toBe("text\uFFFC");
    expect(full.paragraphs[0].editableRanges).toEqual([{ start: 0, end: 4 }]);
    const first = readTaskDocxDocumentPage(scope, "session-1", {
      offset: 0, limit: 20, expectedRevision: 0, textOffset: 0, textLimit: 4,
    });
    expect(first.paragraphs[0].atoms.map((atom) => atom.objectRef)).toEqual(["vml-tail"]);
    expect(first.paragraphs[0].displayText, JSON.stringify(first)).toBe("text\uFFFC");
    expect(first.paragraphs[0].editableRanges).toEqual([{ start: 0, end: 4 }]);
  });
  it("keeps atom and payload continuations on the final text window", async () => {
    const text = `${"a".repeat(100)}\uFFFC${"b".repeat(100)}\uFFFC${"c".repeat(20)}`;
    const atoms: DocxInlineAtom[] = [
      { objectRef: "first", kind: "math", modelRange: { start: 100, end: 101 },
        displayRange: { start: 100, end: 101 }, displayText: "\uFFFC", readable: true,
        complete: true, editable: false, payload: { formula: "x" } },
      { objectRef: "second", kind: "drawing", modelRange: { start: 101, end: 102 },
        displayRange: { start: 201, end: 202 }, displayText: "\uFFFC", readable: true,
        complete: true, editable: false, payload: { formula: "y".repeat(12000) } },
    ];
    const local = harness([paragraph("p1", text)], (current, revision) =>
      semantics(current, revision, { atoms, editableRanges: [] }));
    register(local.session);
    const { readTaskDocxDocument, readTaskDocxDocumentPage } = await import("./docx-agent-host");
    const first = readTaskDocxDocument(scope, "session-1");
    let page = first;
    while (page.paragraphs[0].atoms.length < 2) {
      page = readTaskDocxDocumentPage(scope, "session-1", page.nextQuery!);
    }
    expect(page.paragraphs[0].atoms.map((atom) => atom.objectRef)).toEqual(["first", "second"]);
    const second = page.paragraphs[0].atoms[1];
    expect(second.payloadContinuation).toMatchObject({
      sessionId: "session-1",
      textOffset: page.paragraphs[0].modelTextOffset ?? 0,
      textLimit: page.paragraphs[0].modelText.length,
      atomOffset: 1,
    });
    let payloadJson = second.payloadJson ?? "";
    let continuation = second.payloadContinuation;
    for (let chunks = 0; continuation && chunks < 20; chunks++) {
      expect(continuation).toMatchObject({
        sessionId: "session-1",
        textOffset: page.paragraphs[0].modelTextOffset ?? 0,
        textLimit: page.paragraphs[0].modelText.length,
        atomOffset: 1,
      });
      page = readTaskDocxDocumentPage(scope, "session-1", continuation);
      expect(page.paragraphs[0].atoms[0].objectRef).toBe("second");
      payloadJson += page.paragraphs[0].atoms[0].payloadJson ?? "";
      continuation = page.paragraphs[0].atoms[0].payloadContinuation;
    }
    expect(continuation).toBeNull();
    expect(JSON.parse(payloadJson)).toEqual({ formula: "y".repeat(12000) });
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(10_000);
  });
  it("continues a large zero-width payload in an otherwise empty paragraph", async () => {
    const payload = { label: "picture".repeat(1800) };
    const atom: DocxInlineAtom = {
      objectRef: "empty-picture", kind: "drawing", modelRange: { start: 0, end: 0 },
      displayRange: { start: 0, end: 1 }, displayText: "\uFFFC", readable: true,
      complete: true, editable: false, payload,
    };
    const local = harness([paragraph("p1", "")], (current, revision) =>
      semantics(current, revision, { displayText: "\uFFFC", atoms: [atom] }));
    register(local.session);
    let page = readTaskDocxDocumentPage(scope, "session-1", {});
    let json = "";
    let chunks = 0;
    while (true) {
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(10_000);
      json += page.paragraphs[0].atoms[0].payloadJson;
      if (!page.nextQuery) break;
      expect(page.nextQuery.textLimit).toBeGreaterThan(0);
      expect(chunks++).toBeLessThan(30);
      page = readTaskDocxDocumentPage(scope, "session-1", page.nextQuery);
    }
    expect(JSON.parse(json)).toEqual(payload);
  });
  it("keeps the established window while continuing an atom payload", async () => {
    const text = `${"a".repeat(8000)}${"b".repeat(10)}`;
    const atoms: DocxInlineAtom[] = [
      {
        objectRef: "first", kind: "math", modelRange: { start: 10, end: 11 },
        displayRange: { start: 10, end: 11 }, displayText: "\uFFFC", readable: true,
        complete: true, editable: false, payload: { formula: "first" },
      },
      {
        objectRef: "payload", kind: "math", modelRange: { start: 20, end: 21 },
        displayRange: { start: 20, end: 21 }, displayText: "\uFFFC", readable: true,
        complete: true, editable: false, payload: { formula: "x".repeat(20000) },
      },
    ];
    const local = harness([paragraph("p1", text)], (current, revision) =>
      semantics(current, revision, { atoms, editableRanges: [] }));
    register(local.session);
    const { readTaskDocxDocumentPage } = await import("./docx-agent-host");
    const page = readTaskDocxDocumentPage(scope, "session-1", {
      offset: 0, limit: 20, expectedRevision: 0,
      textOffset: 0, textLimit: 8000, atomOffset: 1, payloadOffset: 1,
    });
    expect(page.paragraphs[0]).toMatchObject({
      modelText: "", modelTextOffset: 0, modelTextLength: text.length,
      atoms: [{ objectRef: "payload", payloadOffset: 1 }],
    });
    expect(page.nextQuery).toMatchObject({
      textOffset: 0, textLimit: 8000, atomOffset: 1, payloadOffset: expect.any(Number),
    });
  });
  it("budgets the final snake_case tool page including every continuation", async () => {
    const atoms: DocxInlineAtom[] = Array.from({ length: 30 }, (_, index) => ({
      objectRef: `formula-${index}`, kind: "math", modelRange: { start: index, end: index + 1 },
      displayRange: { start: index, end: index + 1 }, displayText: "\uFFFC",
      readable: true, complete: true, editable: false,
      payload: { formula: '"\\中文'.repeat(400) },
    }));
    const local = harness([paragraph("p1", "\uFFFC".repeat(atoms.length))], (current, revision) =>
      semantics(current, revision, { atoms, editableRanges: [] }));
    register(local.session);
    let page = readTaskDocxDocumentPage(scope, "session-1", {});
    const seen = new Set<string>();
    for (let count = 0; ; count++) {
      expect(JSON.stringify(docxReadForTool(page)).length).toBeLessThanOrEqual(10_000);
      for (const atom of page.paragraphs[0].atoms) seen.add(atom.objectRef);
      if (!page.nextQuery) break;
      expect(count).toBeLessThan(500);
      page = readTaskDocxDocumentPage(scope, "session-1", page.nextQuery);
    }
    expect(seen.size).toBe(atoms.length);
  });
  it("keeps near-limit text pages callable through the ordinary tool", async () => {
    let text = "";
    const local = harness([paragraph("p1", "text"), paragraph("p2", "tail")], (current, revision) =>
      semantics(current, revision, { modelText: text, displayText: text }));
    register(local.session);
    for (let length = 2800; length <= 3200; length++) {
      text = "x".repeat(length);
      const page = readTaskDocxDocumentPage(scope, "session-1", { limit: 1 });
      expect(JSON.stringify(docxReadForTool(page)).length, `text length ${length}`)
        .toBeLessThanOrEqual(10_000);
    }
  });
  it("reconstructs display text across dense field and zero-width drawing continuations", async () => {
    let displayText = "";
    const atoms: DocxInlineAtom[] = [];
    const payload = { content: '"\\中文'.repeat(400) };
    for (let index = 0; index < 12; index++) {
      for (const [kind, text, width] of [
        ["drawing", "\uFFFC", 0], ["field", `Result${index}`, 1],
      ] as const) {
        const start = displayText.length;
        displayText += text;
        atoms.push({ objectRef: `${kind}-${index}`, kind,
          modelRange: { start: index, end: index + width },
          displayRange: { start, end: displayText.length }, displayText: text,
          readable: true, complete: true, editable: false, payload });
      }
    }
    const modelText = "\uFFFC".repeat(12);
    const local = harness([paragraph("p1", modelText)], (current, revision) =>
      semantics(current, revision, { modelText, displayText, atoms, editableRanges: [] }));
    register(local.session);
    const collectedModel: string[] = [], collectedDisplay: string[] = [];
    const payloadChunks = new Map<string, string[]>();
    const append = (collected: string[], text: string, offset: number) => {
      for (let index = 0; index < text.length; index++) {
        expect(collected[offset + index] ?? text[index]).toBe(text[index]);
        collected[offset + index] = text[index];
      }
    };
    let page = readTaskDocxDocumentPage(scope, "session-1", {
      offset: 0, textOffset: 0, textLimit: 3,
    });
    for (let count = 0; ; count++) {
      expect(JSON.stringify(docxReadForTool(page)).length).toBeLessThanOrEqual(10_000);
      const view = page.paragraphs[0];
      append(collectedModel, view.modelText, view.modelTextOffset ?? 0);
      append(collectedDisplay, view.displayText, view.displayTextOffset ?? 0);
      for (const atom of view.atoms) {
        const chunks = payloadChunks.get(atom.objectRef) ?? [];
        if (atom.payloadJson !== undefined) append(chunks, atom.payloadJson, atom.payloadOffset ?? 0);
        else if (atom.payload !== undefined) append(chunks, JSON.stringify(atom.payload), 0);
        payloadChunks.set(atom.objectRef, chunks);
      }
      if (!page.nextQuery) break;
      expect(count).toBeLessThan(500);
      page = readTaskDocxDocumentPage(scope, "session-1", page.nextQuery);
    }
    expect(collectedModel.join("")).toBe(modelText);
    expect(collectedDisplay.join("")).toBe(displayText);
    expect(payloadChunks.size).toBe(atoms.length);
    for (const chunks of payloadChunks.values()) expect(JSON.parse(chunks.join(""))).toEqual(payload);
  });
  it("keeps surrogate text windows and atom display windows on valid boundaries", async () => {
    const atoms: DocxInlineAtom[] = [{
      objectRef: "field", kind: "field", modelRange: { start: 199, end: 200 },
      displayRange: { start: 199, end: 206 }, displayText: "Result!",
      readable: true, complete: true, editable: false, payload: { code: "REF Target" },
    }];
    const modelText = `A${"😀".repeat(99)}${"\uFFFC"}${"😀".repeat(2400)}Z`;
    const displayText = `A${"😀".repeat(99)}Result!${"😀".repeat(2400)}Z`;
    const local = harness([paragraph("p1", modelText)], (current, revision) =>
      semantics(current, revision, { modelText, displayText, atoms, editableRanges: [] }));
    register(local.session);
    const { readTaskDocxDocument, readTaskDocxDocumentPage } = await import("./docx-agent-host");
    let page = readTaskDocxDocument(scope, "session-1");
    let assembledModel = page.paragraphs[0].modelText;
    let display = page.paragraphs[0].displayText;
    while (page.nextQuery?.textOffset !== undefined) {
      const start = page.nextQuery.textOffset;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(modelText.charCodeAt(start) < 0xdc00 || modelText.charCodeAt(start) > 0xdfff).toBe(true);
      page = readTaskDocxDocumentPage(scope, "session-1", page.nextQuery);
      assembledModel += page.paragraphs[0].modelText;
      display += page.paragraphs[0].displayText;
    }
    expect(assembledModel).toBe(modelText);
    expect(display).toBe(displayText);
    expect(page.paragraphs[0].atoms).toEqual([]);
  });
});

it("retains a native operation receipt before returning a committed task edit", async () => {
  const local = harness();
  local.session.formatParagraph = vi.fn((): DocxApplyResult => {
    local.edit("p1", "Original paragraph.");
    return { ok: true, changed: true, revision: 1 };
  });
  let finish!: () => void;
  const onTaskOperation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  register(local.session, { onTaskOperation });
  let returned = false;
  const work = runTaskDocxOperation({ projectId: "app-project", workbenchProjectId: "paper-project", operationId: "durable-intent" },
    "session-1", "format", { paragraphRef: "p1", expectedRevision: 0, format: { font: { bold: true } } })
    .then((result) => { returned = true; return result; });
  expect(onTaskOperation).toHaveBeenCalledWith(expect.objectContaining({
    operationId: "durable-intent", document: expect.objectContaining({ sessionRevision: 1 }),
    result: expect.objectContaining({ operation: "format", ok: true }),
  }));
  expect(returned).toBe(false);
  finish();
  expect(await work).toMatchObject({ operation: "format", ok: true, checkpoint: { status: "recorded" } });
});

it("reports a checkpoint failure while preserving the actual committed operation result", async () => {
  const local = harness();
  local.session.formatParagraph = vi.fn((): DocxApplyResult => {
    local.edit("p1", "Original paragraph.");
    return { ok: true, changed: true, revision: 1 };
  });
  register(local.session, { onTaskOperation: async () => { throw new Error("disk full"); } });
  expect(await runTaskDocxOperation({ projectId: "app-project", workbenchProjectId: "paper-project", operationId: "durable-intent" },
    "session-1", "format", { paragraphRef: "p1", expectedRevision: 0, format: { font: { nameEastAsia: "宋体" } } }))
    .toMatchObject({ operation: "format", ok: true, result: { changed: true }, checkpoint: { status: "failed", error: "Error: disk full" } });
  expect(local.session.revision()).toBe(1);
});

it("retains a committed task save receipt after its old session closes", async () => {
  const local = harness();
  local.edit("p1", "Saved revision one.");
  const checkpoint = vi.fn(async () => {});
  const save = vi.fn(async ({ expectedRevision }) => {
    unregisterDocxAgentSession("session-1");
    return {
      baselineId: "baseline-2",
      revision: expectedRevision,
      sourceSha256: "c".repeat(64),
      document: {
        sessionId: "session-1",
        baselineId: "baseline-2",
        sessionRevision: 1,
        savedRevision: expectedRevision,
        dirty: false,
      },
    };
  });
  register(local.session, { save, onTaskOperation: checkpoint });

  await expect(runTaskDocxOperation({
    projectId: "app-project",
    workbenchProjectId: "paper-project",
    operationId: "closed-session-save",
  }, "session-1", "save", { expectedRevision: 1 })).resolves.toMatchObject({
    operation: "save",
    ok: true,
    document: {
      sessionId: "session-1",
      baselineId: "baseline-2",
      sessionRevision: 1,
      savedRevision: 1,
    },
  });
  expect(checkpoint).not.toHaveBeenCalled();
});

it.each(["ordinary", "task"] as const)("returns a bounded %s check receipt with exact retained read parameters", async (route) => {
  const local = harness();
  const onTaskOperation = vi.fn(async () => {});
  const retained = { template: "world-7", check: {
    check_id: "checked", project_id: "paper-project", baseline_id: "baseline-1", world_version_id: "world-7",
    source_sha256: "a".repeat(64), validity: "CURRENT", stale_reasons: [], summary: { observed_difference: 2 },
    world: { rules: Array.from({ length: 100 }, () => ({ evidence: "w".repeat(3000) })) },
    coverage_gaps: [{ code: "unsupported" }], limitations: ["Retained limitation"],
    template_comparison: {
      total: 500, finding_summary: { observed_difference: 2 }, findings_artifact_version_id: "findings-artifact",
      findings: Array.from({ length: 100 }, () => ({ observed: "x".repeat(3000) })),
    },
  } };
  register(local.session, { onTaskOperation, check: async () => retained });
  const ordinaryCheck = DOCX_AGENT_HOST.checkTemplate;
  if (!ordinaryCheck) throw new Error("The ordinary DOCX check tool is unavailable.");
  const result = route === "ordinary"
    ? await ordinaryCheck("session-1", "world-7")
    : (await runTaskDocxOperation({ projectId: "app-project", workbenchProjectId: "paper-project", operationId: "check-intent" },
      "session-1", "check", { template: "world-7" })).result;
  expect(result).toMatchObject({ template: "world-7", check: {
    check_id: "checked", baseline_id: "baseline-1", world_version_id: "world-7", validity: "CURRENT",
    summary: { observed_difference: 2 }, coverage_gap_count: 1, limitation_count: 1,
    template_comparison: { total: 500, findings_artifact_version_id: "findings-artifact", finding_summary: { observed_difference: 2 } },
    objectRead: { tool: "journal_read", arguments: { operation: "object", kind: "check", object_id: "checked", world_version_id: "world-7" } },
    findingsRead: { tool: "journal_read", arguments: { operation: "findings", check_id: "checked", offset: 0, limit: 20 } },
    detail: "compact", readBoundary: expect.stringContaining("before judging omitted content"),
  } });
  expect(result.check).not.toHaveProperty("template_comparison.findings");
  expect(result.check).not.toHaveProperty("world");
  expect(JSON.stringify(result).length).toBeLessThan(4000);
  expect(retained.check.template_comparison.findings).toHaveLength(100);
  expect(retained.check.world.rules).toHaveLength(100);
  if (route === "task") {
    expect(onTaskOperation.mock.calls[0]).toEqual([expect.objectContaining({ result: expect.objectContaining({
      result: { template: "world-7", check: { check_id: "checked", project_id: "paper-project", baseline_id: "baseline-1",
        world_version_id: "world-7", source_sha256: "a".repeat(64), validity: "CURRENT", summary: { observed_difference: 2 },
        objectRead: { tool: "journal_read", arguments: { operation: "object", kind: "check", object_id: "checked", world_version_id: "world-7" } },
        findingsRead: { tool: "journal_read", arguments: { operation: "findings", check_id: "checked", offset: 0, limit: 20 } } } },
    }) })]);
  } else expect(onTaskOperation).not.toHaveBeenCalled();
});

it("refuses to attribute a completed baseline check to a newer live edit", async () => {
  const local = harness();
  const onTaskOperation = vi.fn(async () => {});
  let finish!: (result: { template: string; check: Record<string, unknown> }) => void;
  register(local.session, { onTaskOperation, check: () => new Promise((resolve) => { finish = resolve; }) });
  const checking = runTaskDocxOperation({ projectId: "app-project", workbenchProjectId: "paper-project", operationId: "check-intent" },
    "session-1", "check", { template: "world-7" });
  local.edit("p1", "User edited during the check");
  finish(retainedTemplateCheck("world-7", { check_id: "checked" }));
  await expect(checking).rejects.toThrow("changed while its saved baseline was being checked");
  expect(onTaskOperation).not.toHaveBeenCalled();
});

it("retains a completed task check after its generation is cancelled", async () => {
  const local = harness();
  let generation = 1;
  const beforeCommit = vi.fn(async () => {
    if (generation !== 1) throw new Error("This DOCX task execution is no longer active.");
  });
  const checkpoint = vi.fn(async () => {});
  const check = vi.fn(async ({ template }) => {
    generation = 2;
    return retainedTemplateCheck(template);
  });
  register(local.session, { check, onTaskOperation: checkpoint });

  await expect(runTaskDocxOperation({
    projectId: "app-project",
    workbenchProjectId: "paper-project",
    operationId: "completed-check",
    beforeCommit,
  }, "session-1", "check", { template: "world-v7" })).resolves.toMatchObject({
    operation: "check",
    ok: true,
    document: { baselineId: "baseline-1", sourceSha256: "a".repeat(64) },
    checkpoint: { status: "recorded" },
  });
  expect(generation).toBe(2);
  expect(beforeCommit).toHaveBeenCalledOnce();
  expect(checkpoint).toHaveBeenCalledOnce();
});

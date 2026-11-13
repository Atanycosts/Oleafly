// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalCheck, JournalProject, JournalState, JournalWorld } from "@/lib/journal-workbench";
import type { DocxParagraph, DocxSession, DocxTarget } from "@/lib/docx-session";
import type { DocxSave, DocxSource } from "@/lib/docx-workbench";
import type { DocxRecoverySnapshot } from "@/lib/docx-recovery";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { projectLeaveAllowed } from "@/lib/project-leave-guards";
import { acquireEditorMutationLease } from "@/lib/editor-mutation-lease";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { i18n } from "@/i18n";

const mocks = vi.hoisted(() => ({
  loadSource: vi.fn(),
  prepareSave: vi.fn(),
  saveBaseline: vi.fn(),
  commitRecovery: vi.fn(),
  resumeRecovery: vi.fn(),
  saveRecovery: vi.fn(),
  readRecovery: vi.fn(),
  clearRecovery: vi.fn(),
  discardRecovery: vi.fn(),
  listRecovery: vi.fn(),
  contentHash: vi.fn(),
  settleActivity: vi.fn(),
  fontOptions: null as null | { onError(cause: unknown): void; onSubstitutions(value: { from: string; to: string }[]): void },
  editorDocument: null as Uint8Array | null,
  fontShaping: undefined as { maxFontBytes: number } | undefined,
  runInlineCompletion: vi.fn(),
  createSession: vi.fn(),
  journalRequest: vi.fn(),
  editorSave: vi.fn(),
  applySuggestion: vi.fn(),
  registerAgentSession: vi.fn(),
  updateAgentSession: vi.fn(),
  unregisterAgentSession: vi.fn(),
  editor: {
    scrollToAnchor: vi.fn(),
    highlightAnchor: vi.fn(),
    clearAnchorHighlight: vi.fn(),
    on: () => () => {},
    measurement: { measurer: "fixed" as "fixed" | "shaped", resolving: false, producer: undefined as string | undefined },
    fontMeasurement: () => mocks.editor.measurement,
    editorSnapshot: { isLoading: false, isOpening: false, parseError: null, page: { current: 1, total: 1 } },
    snapshot: () => mocks.editor.editorSnapshot,
  },
}));

vi.mock("@docx-editor.dev/react", async () => {
  const React = await import("react");
  return {
    useDocxEditor: () => mocks.editor,
    useFonts: (source: unknown) => source,
    useEditorState: (selector: (snapshot: ReturnType<typeof mocks.editor.snapshot>) => unknown) => selector(mocks.editor.snapshot()),
    useScopedChromeAnchor: () => ({ ref: () => {}, style: { visibility: "hidden" } }),
    DocxEditor: React.forwardRef(function MockDocxEditor(
      props: {
        children?: React.ReactNode;
        document: Uint8Array;
        fontShaping: { maxFontBytes: number };
      },
      ref,
    ) {
      mocks.editorDocument = props.document;
      mocks.fontShaping = props.fontShaping;
      React.useImperativeHandle(ref, () => ({
        save: mocks.editorSave,
        getEditor: () => mocks.editor,
      }));
      return <div data-testid="mock-docx-editor">{props.children}</div>;
    }),
  };
});

vi.mock("./DocxTaskActivity", () => ({ DocxTaskActivity: () => <div data-testid="task-panel" />, DocxActivitySource: ({ activity }: { activity: { origin: { taskId: string } } }) => <span>{activity.origin.taskId}</span> }));
vi.mock("@/lib/docx-task-activity", () => ({ settleDocxTaskActivity: mocks.settleActivity }));
vi.mock("@docx-editor.dev/fonts", () => ({ packagedFonts: () => [] }));
vi.mock("@/lib/docx-fonts", () => ({ createDocxFontResolver: (options: NonNullable<typeof mocks.fontOptions>) => { mocks.fontOptions = options; return () => undefined; } }));
vi.mock("@/lib/ai-inline", () => ({ runInlineCompletion: mocks.runInlineCompletion }));
vi.mock("@/lib/docx-session", () => ({ createDocxSession: mocks.createSession }));
vi.mock("@/lib/docx-agent-host", () => ({
  registerDocxAgentSession: mocks.registerAgentSession,
  updateDocxAgentSession: mocks.updateAgentSession,
  unregisterDocxAgentSession: mocks.unregisterAgentSession,
}));
vi.mock("@/lib/docx-workbench", () => ({
  loadDocxSource: mocks.loadSource,
  prepareDocxSave: mocks.prepareSave,
  saveDocxBaseline: mocks.saveBaseline,
}));
vi.mock("@/lib/docx-recovery", () => ({
  saveDocxRecovery: mocks.saveRecovery,
  commitDocxRecovery: mocks.commitRecovery,
  resumeDocxRecovery: mocks.resumeRecovery,
  recoveryPendingSave: (save: DocxSave) => ({ projectId: save.project_id, expectedBaselineId: save.expected_baseline_id, filename: save.filename, reason: save.reason, requestId: save.request_id, revision: save.revision }),
  readDocxRecovery: mocks.readRecovery,
  clearDocxRecovery: mocks.clearRecovery,
  discardDocxRecovery: mocks.discardRecovery,
  docxContentSha256: mocks.contentHash,
  listDocxRecovery: mocks.listRecovery,
}));
vi.mock("@/lib/journal-workbench", () => ({ journalRequest: mocks.journalRequest }));
vi.mock("@/lib/docx-render", () => ({ findDocxRenderer: async () => null }));

import DocxWorkspaceDialog, { DocxWorkspaceHost } from "./DocxWorkspaceDialog";

const text = en.docx;
const INITIAL_BASELINE = "baseline-initial";
const SAVED_BASELINE = "baseline-saved";
const WORLD_VERSION = "world-current";

const PROJECT = {
  project_id: "project-manuscript",
  name: "Retained paper",
  baseline_id: INITIAL_BASELINE,
  binding: null,
  latest_check: null,
} satisfies JournalProject;

const WORLD = {
  version_id: WORLD_VERSION,
} as JournalWorld;

const SOURCE: DocxSource = {
  project_id: PROJECT.project_id,
  baseline_id: INITIAL_BASELINE,
  source_sha256: "a".repeat(64),
  filename: "retained-paper.docx",
  bytes: Uint8Array.from([80, 75, 3, 4]),
};

function paragraph(ref: string, body: string): DocxParagraph {
  return {
    handle: { kind: "paragraph", ref: ref as DocxParagraph["handle"]["ref"] },
    text: body,
    paraId: `para-${ref}`,
  };
}

function sessionHarness(initial: readonly DocxParagraph[]) {
  let current = [...initial];
  let revision = 0;
  const listeners = new Set<(next: number) => void>();
  const emit = () => {
    for (const listener of listeners) listener(revision);
  };
  const session: DocxSession = {
    revision: () => revision,
    listParagraphs: () => current,
    captureTarget: (handle): DocxTarget => {
      const target = current.find((item) => item.handle.ref === handle.ref);
      if (!target) throw new Error("missing paragraph");
      return {
        paragraph: target.handle,
        original: target.text,
        revision,
        paraId: target.paraId,
      };
    },
    applySuggestion: mocks.applySuggestion,
    isSuggestionApplied: (target, proposed) =>
      current.find((item) => item.handle.ref === target.paragraph.ref)?.text === proposed,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  };
  return {
    session,
    edit(ref: string, body: string) {
      current = current.map((item) => (item.handle.ref === ref ? { ...item, text: body } : item));
      revision += 1;
      emit();
    },
    setRevision(next: number) {
      revision = next;
      emit();
    },
    revision: () => revision,
    text: (ref: string) => current.find((item) => item.handle.ref === ref)?.text ?? null,
  };
}

function saveRequest(revision: number, expectedBaselineId = SOURCE.baseline_id): DocxSave {
  return {
    project_id: SOURCE.project_id,
    expected_baseline_id: expectedBaselineId,
    filename: SOURCE.filename,
    content_base64: "UEsDBA==",
    reason: `User saved revision ${revision}.`,
    request_id: "docx-request-fixed",
    revision,
  };
}

async function renderReady(harness: ReturnType<typeof sessionHarness>, onSaved = vi.fn(async () => {}), waitForSession = true, options: { recovery?: DocxRecoverySnapshot; project?: JournalProject } = {}) {
  mocks.createSession.mockReturnValue(harness.session);
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
    <DocxWorkspaceDialog
      appProjectId="app-project"
      project={options.project ?? PROJECT}
      recovery={options.recovery}
      world={WORLD}
      onClose={onClose}
      onSaved={onSaved}
    />
    </QueryClientProvider>
  );
  const view = render(tree);
  if (waitForSession) await waitFor(() => expect(mocks.createSession).toHaveBeenCalled());
  return { onClose, onSaved, rerender: () => view.rerender(tree) };
}

function chooseTarget(ref: string) {
  fireEvent.change(screen.getByLabelText(text.target), { target: { value: ref } });
}

function enterInstruction(instruction: string) {
  fireEvent.change(screen.getByLabelText(text.instruction), {
    target: { value: instruction },
  });
}

async function startGeneration(instruction = "Improve this") {
  enterInstruction(instruction);
  fireEvent.click(screen.getByRole("button", { name: text.generate }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.editor.measurement = { measurer: "fixed", resolving: false, producer: undefined };
  useDocxWorkspaceStore.setState({ request: null, minimized: false, recoveryOpen: false });
  mocks.settleActivity.mockResolvedValue({});
  mocks.listRecovery.mockResolvedValue({ snapshots: [], failures: [] });
  mocks.editor.editorSnapshot = { isLoading: false, isOpening: false, parseError: null, page: { current: 1, total: 1 } };
  mocks.loadSource.mockResolvedValue(SOURCE);
  mocks.editorSave.mockResolvedValue(Uint8Array.from([80, 75, 5, 6]).buffer);
  mocks.prepareSave.mockImplementation((source: DocxSource, revision: number, bytes: ArrayBuffer) => ({
    ...saveRequest(revision, source.baseline_id), content_base64: btoa(String.fromCharCode(...new Uint8Array(bytes))),
  }));
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 0 });
  mocks.resumeRecovery.mockResolvedValue([]);
  mocks.commitRecovery.mockImplementation(async () => {
    const save = mocks.prepareSave.mock.results.at(-1)?.value;
    const result = await mocks.saveBaseline(save);
    return { ...result, sourceSha256: "d".repeat(64) };
  });
  mocks.saveRecovery.mockResolvedValue({
    recoveryKey: "b".repeat(64),
    appProjectId: "app-project",
    workbenchProjectId: PROJECT.project_id,
    baseBaselineId: INITIAL_BASELINE,
    sourceSha256: SOURCE.source_sha256,
    revision: 0,
    updatedAt: "2026-11-11T08:30:15.123Z",
    contentSha256: "c".repeat(64),
  });
  mocks.readRecovery.mockResolvedValue(null);
  mocks.clearRecovery.mockResolvedValue(true);
  mocks.discardRecovery.mockResolvedValue(true);
  mocks.contentHash.mockResolvedValue("d".repeat(64));
  mocks.applySuggestion.mockReturnValue({ ok: true, revision: 1, changed: true });
});

it("shows resolving, shaped and fallback font states without claiming complete coverage", async () => {
  mocks.editor.measurement = { measurer: "fixed", resolving: true, producer: undefined };
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  expect(screen.getByTestId("docx-font-state")).toHaveTextContent(text.fontsResolving);
  mocks.editor.measurement = { measurer: "shaped", resolving: false, producer: "font-hash-producer" };
  act(() => harness.edit("first", "Changed"));
  await waitFor(() => expect(screen.getByTestId("docx-font-state")).toHaveTextContent(text.fontsShaped));
  expect(screen.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
  expect(screen.getByTestId("docx-font-state")).toHaveAttribute("data-producer", "font-hash-producer");
  mocks.editor.measurement = { measurer: "fixed", resolving: false, producer: undefined };
  act(() => harness.edit("first", "Changed again"));
  await waitFor(() => expect(screen.getByTestId("docx-font-state")).toHaveTextContent(text.fontsFixed));
  expect(screen.getByTestId("docx-font-state")).not.toHaveAttribute("data-producer");
});

it("keeps the 64 MiB shaping limit stable across editor updates", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const configured = mocks.fontShaping;
  expect(configured).toEqual({ maxFontBytes: 64 * 1024 * 1024 });
  act(() => harness.edit("first", "Updated"));
  expect(mocks.fontShaping).toBe(configured);
  expect(mocks.createSession).toHaveBeenCalledOnce();
});

it("shows explicit CJK substitutions and a native font failure", async () => {
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  act(() => mocks.fontOptions?.onSubstitutions([{ from: "宋体", to: "Noto Serif CJK SC" }]));
  expect(screen.getByTestId("docx-font-substitutions")).toHaveTextContent("宋体 → Noto Serif CJK SC");
  act(() => mocks.fontOptions?.onError(new Error("Native read failed")));
  expect(screen.getByRole("alert")).toHaveTextContent(`${text.fontError}: Error: Native read failed`);
});

describe("DocxWorkspaceDialog editing lifecycle", () => {
  const recovery: DocxRecoverySnapshot = {
    appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
    baseBaselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256,
    recoveryKey: "b".repeat(64), contentSha256: "c".repeat(64),
    revision: 9, updatedAt: "2026-11-12T02:00:00.000Z", bytes: Uint8Array.from([80, 75, 9, 9]),
  };

  it("routes a normal open with existing unsaved work to recovery before loading the editor", async () => {
    mocks.listRecovery.mockResolvedValue({ snapshots: [recovery], failures: [] });
    useDocxWorkspaceStore.getState().open({ appProjectId: "app-project", project: PROJECT, world: WORLD, onSaved: vi.fn() });
    render(<DocxWorkspaceHost />);
    await waitFor(() => expect(useDocxWorkspaceStore.getState().recoveryOpen).toBe(true));
    expect(useDocxWorkspaceStore.getState().request).toBeNull();
    expect(mocks.loadSource).not.toHaveBeenCalled();
  });

  it("keeps the live package and session when the application language changes", async () => {
    const harness = sessionHarness([paragraph("first", "Original text")]);
    await renderReady(harness);
    act(() => harness.edit("first", "Unsaved text"));
    const document = mocks.editorDocument;
    const locale = i18n.language;
    await act(async () => { await i18n.changeLanguage("zh-Hans"); });
    expect(mocks.loadSource).toHaveBeenCalledTimes(1);
    expect(mocks.editorDocument).toBe(document);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(harness.text("first")).toBe("Unsaved text");
    await act(async () => { await i18n.changeLanguage(locale); });
  });

  it("waits for an old background export and prevents its late write after an explicit save starts", async () => {
    const harness = sessionHarness([paragraph("first", "Original text")]);
    let finishExport!: (bytes: ArrayBuffer) => void;
    mocks.editorSave.mockReturnValueOnce(new Promise((resolve) => { finishExport = resolve; }))
      .mockResolvedValue(Uint8Array.from([80, 75, 7, 8]).buffer);
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 2 });
    await renderReady(harness);
    act(() => harness.edit("first", "Background export"));
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledTimes(1), { timeout: 2500 });
    act(() => harness.edit("first", "Explicit save text"));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    expect(mocks.saveBaseline).not.toHaveBeenCalled();
    await act(async () => finishExport(Uint8Array.from([80, 75, 1, 2]).buffer));
    await waitFor(() => expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved));
    expect(mocks.saveRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.saveRecovery.mock.calls[0][1]).toBe(2);
  });

  it("restores checkpoint bytes as unsaved in both the fresh session and Agent, then saves on the original baseline", async () => {
    const harness = sessionHarness([paragraph("first", "Recovered text")]);
    await renderReady(harness, undefined, true, { recovery });
    expect(mocks.editorDocument).toBe(recovery.bytes);
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
    expect(screen.getByTestId("docx-save-state")).not.toHaveTextContent("r-1");
    expect(mocks.registerAgentSession).toHaveBeenCalledWith(expect.objectContaining({ baselineId: INITIAL_BASELINE, savedRevision: -1, session: harness.session }));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved));
    expect(mocks.prepareSave.mock.calls[0][0].baseline_id).toBe(INITIAL_BASELINE);
    expect(mocks.clearRecovery).toHaveBeenCalledOnce();
  });

  it("keeps recovery on its original baseline and disables save when a newer version exists", async () => {
    const harness = sessionHarness([paragraph("first", "Recovered text")]);
    await renderReady(harness, undefined, true, { recovery, project: { ...PROJECT, baseline_id: SAVED_BASELINE } });
    expect(mocks.loadSource).toHaveBeenCalledWith(PROJECT.project_id, INITIAL_BASELINE);
    expect(screen.getByRole("alert")).toHaveTextContent(text.recovery.conflict);
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(screen.getByRole("button", { name: text.download })).toBeEnabled();
    expect(mocks.saveBaseline).not.toHaveBeenCalled();
  });

  it("keeps an unmatched recovery checkpoint and allows closing a failed open", async () => {
    mocks.loadSource.mockResolvedValue({ ...SOURCE, source_sha256: "f".repeat(64) });
    const harness = sessionHarness([paragraph("first", "Recovered text")]);
    const view = await renderReady(harness, undefined, false, { recovery });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text.recovery.sourceChanged));
    expect(mocks.createSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(mocks.clearRecovery).not.toHaveBeenCalled();
  });

  it("waits for the editor read model to finish opening before registering the session", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.editor.editorSnapshot = { isLoading: true, isOpening: true, parseError: null, page: { current: 0, total: 0 } };
    const view = await renderReady(harness, vi.fn(async () => {}), false);

    expect(mocks.createSession).not.toHaveBeenCalled();
    mocks.editor.editorSnapshot = { isLoading: false, isOpening: false, parseError: null, page: { current: 1, total: 1 } };
    act(() => view.rerender());
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
  });

  it("registers the live session and updates its saved baseline after a save", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
    await renderReady(harness);

    expect(mocks.registerAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^docx:/),
        appProjectId: "app-project",
        workbenchProjectId: PROJECT.project_id,
        baselineId: INITIAL_BASELINE,
        savedRevision: 0,
        session: harness.session,
      }),
    );

    act(() => harness.setRevision(1));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    const sessionId = mocks.registerAgentSession.mock.calls[0][0].sessionId;
    await waitFor(() =>
      expect(mocks.updateAgentSession).toHaveBeenCalledWith(
        sessionId,
        { baselineId: SAVED_BASELINE, savedRevision: 1, sourceSha256: "d".repeat(64) },
      ),
    );
    expect(mocks.saveRecovery).toHaveBeenCalledWith(
      {
        appProjectId: "app-project",
        workbenchProjectId: PROJECT.project_id,
        baseBaselineId: INITIAL_BASELINE,
        sourceSha256: SOURCE.source_sha256,
      },
      1,
      expect.any(ArrayBuffer),
      expect.objectContaining({ pendingSave: expect.objectContaining({ requestId: "docx-request-fixed" }) }),
    );
    expect(mocks.clearRecovery).toHaveBeenCalledOnce();
  });

  it("uses the newly committed baseline for the next recovery snapshot", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.saveBaseline
      .mockResolvedValueOnce({ baselineId: SAVED_BASELINE, revision: 1 })
      .mockResolvedValueOnce({ baselineId: "baseline-final", revision: 2 });
    await renderReady(harness);

    act(() => harness.setRevision(1));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(mocks.saveBaseline).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("docx-save-state")).toHaveTextContent("r1 / r1"));

    act(() => harness.setRevision(2));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(mocks.saveBaseline).toHaveBeenCalledTimes(2));

    expect(mocks.saveRecovery.mock.calls[1]?.[0]).toMatchObject({
      baseBaselineId: SAVED_BASELINE,
      sourceSha256: "d".repeat(64),
    });
    expect(mocks.clearRecovery.mock.calls[1]?.[0]).toMatchObject({
      baseBaselineId: SAVED_BASELINE,
      sourceSha256: "d".repeat(64),
    });
  });

  it("keeps a saved-version check from overlapping the next baseline save", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let finish!: (value: JournalState) => void;
    mocks.journalRequest.mockImplementation(() => new Promise<JournalState>((resolve) => { finish = resolve; }));
    await renderReady(harness);
    fireEvent.click(screen.getByRole("button", { name: text.check }));
    await waitFor(() => expect(mocks.journalRequest).toHaveBeenCalled());
    act(() => harness.edit("first", "Typing during the saved-version check"));
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    await act(async () => finish({ worlds: [], projects: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: text.save })).toBeEnabled());
    expect(mocks.saveBaseline).not.toHaveBeenCalled();
  });

  it("blocks project leave, reload and quit flushing until the working copy is saved or closed", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    await renderReady(harness);
    const leave = { projectId: "app-project", reason: "close" as const, targetProjectId: null };
    expect(await projectLeaveAllowed(leave)).toBe(true);
    act(() => harness.edit("first", "Unsaved typing"));
    let allowed = true;
    await act(async () => { allowed = await projectLeaveAllowed(leave); });
    expect(allowed).toBe(false);
    expect(screen.getByText(text.closeTitle)).toBeInTheDocument();
    const lease = acquireEditorMutationLease("app-project");
    try {
      await expect(lease.flush()).rejects.toThrow(text.closeHelp);
    } finally { lease.release(); }
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("clears the latest recovery snapshot before confirmed discard closes the working copy", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    const recoveryBytes = Uint8Array.from([80, 75, 9, 9]);
    mocks.readRecovery.mockResolvedValue({
      recoveryKey: "b".repeat(64),
      appProjectId: "app-project",
      workbenchProjectId: PROJECT.project_id,
      baseBaselineId: INITIAL_BASELINE,
      sourceSha256: SOURCE.source_sha256,
      revision: 1,
      updatedAt: "2026-11-11T08:30:15.123Z",
      contentSha256: "c".repeat(64),
      bytes: recoveryBytes,
    });
    const view = await renderReady(harness);
    act(() => harness.edit("first", "Unsaved text"));

    await act(async () => {
      await projectLeaveAllowed({ projectId: "app-project", reason: "close", targetProjectId: null });
    });
    fireEvent.click(screen.getByRole("button", { name: text.discard }));

    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    expect(mocks.readRecovery).toHaveBeenCalledWith({
      appProjectId: "app-project",
      workbenchProjectId: PROJECT.project_id,
      baseBaselineId: INITIAL_BASELINE,
      sourceSha256: SOURCE.source_sha256,
    });
    expect(mocks.clearRecovery).toHaveBeenCalledWith(
      {
        appProjectId: "app-project",
        workbenchProjectId: PROJECT.project_id,
        baseBaselineId: INITIAL_BASELINE,
        sourceSha256: SOURCE.source_sha256,
      },
      recoveryBytes,
    );
  });

  it("resumes checkpointing after discard fails even without another edit", async () => {
    const harness = sessionHarness([paragraph("first", "Original text")]);
    mocks.readRecovery.mockRejectedValueOnce(new Error("recovery disk unavailable"));
    const view = await renderReady(harness);
    act(() => harness.edit("first", "Unsaved text retained after failure"));
    await act(async () => { await projectLeaveAllowed({ projectId: "app-project", reason: "close", targetProjectId: null }); });
    fireEvent.click(screen.getByRole("button", { name: text.discard }));
    await waitFor(() => expect(mocks.readRecovery).toHaveBeenCalled());
    expect(view.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.saveRecovery).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(mocks.saveRecovery.mock.calls[0][1]).toBe(1);
    expect(harness.text("first")).toBe("Unsaved text retained after failure");
  });

  it("keeps a committed baseline saved when refreshing the parent panel fails", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
    await renderReady(harness, vi.fn(async () => { throw new Error("panel unavailable"); }));
    act(() => harness.edit("first", "New text"));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text.refreshFailed));
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent("r1 / r1");
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(screen.queryByRole("button", { name: text.retrySave })).not.toBeInTheDocument();
  });

  it("shows streamed tokens without applying them to the editor", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.runInlineCompletion.mockImplementation(
      async ({ onToken }: { onToken(full: string): void }) => {
        onToken("Suggested replacement");
        return "Suggested replacement";
      },
    );
    await renderReady(harness);
    await screen.findByRole("option", { name: /Original paragraph/ });
    chooseTarget("first");

    await startGeneration();

    await waitFor(() =>
      expect(screen.getByTestId("docx-proposed")).toHaveTextContent("Suggested replacement"),
    );
    expect(screen.getByRole("button", { name: text.accept })).toBeInTheDocument();
    expect(mocks.applySuggestion).not.toHaveBeenCalled();
    expect(harness.text("first")).toBe("Original paragraph");
  });

  it("aborts and withdraws when the target changes, ignoring late tokens and Accept", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let signal: AbortSignal | null = null;
    let onToken!: (full: string) => void;
    let finish!: (value: string) => void;
    mocks.runInlineCompletion.mockImplementation(
      (options: { signal: AbortSignal; onToken(full: string): void }) => {
        signal = options.signal;
        onToken = options.onToken;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    await renderReady(harness);
    await screen.findByRole("option", { name: /Original paragraph/ });
    chooseTarget("first");
    await startGeneration();
    await waitFor(() => expect(onToken).toBeTypeOf("function"));
    act(() => onToken("Partial suggestion"));

    act(() => harness.edit("first", "Locally edited paragraph"));

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.withdrawn);
    act(() => onToken("Late suggestion"));
    expect(screen.getByTestId("docx-proposed")).toHaveTextContent("Partial suggestion");
    await act(async () => finish("Final model suggestion"));
    expect(screen.queryByRole("button", { name: text.accept })).not.toBeInTheDocument();
    expect(mocks.applySuggestion).not.toHaveBeenCalled();
  });

  it("keeps the suggestion when another paragraph changes", async () => {
    const harness = sessionHarness([
      paragraph("first", "Original paragraph"),
      paragraph("second", "Other paragraph"),
    ]);
    let signal: AbortSignal | null = null;
    let onToken!: (full: string) => void;
    let finish!: (value: string) => void;
    mocks.runInlineCompletion.mockImplementation(
      (options: { signal: AbortSignal; onToken(full: string): void }) => {
        signal = options.signal;
        onToken = options.onToken;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    await renderReady(harness);
    await screen.findByRole("option", { name: /Original paragraph/ });
    chooseTarget("first");
    await startGeneration();
    await waitFor(() => expect(onToken).toBeTypeOf("function"));
    act(() => onToken("Suggested replacement"));

    act(() => harness.edit("second", "Locally edited other paragraph"));
    expect(signal).toMatchObject({ aborted: false });
    await act(async () => finish("Suggested replacement"));

    await waitFor(() =>
      expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.reviewing),
    );
    expect(screen.getByRole("button", { name: text.accept })).toBeInTheDocument();
    expect(mocks.applySuggestion).not.toHaveBeenCalled();
  });

  it("withdraws an applied suggestion after undo restores the original text", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.runInlineCompletion.mockResolvedValue("Suggested replacement");
    mocks.applySuggestion.mockImplementation(() => {
      harness.edit("first", "Suggested replacement");
      return { ok: true, revision: harness.revision(), changed: true };
    });
    await renderReady(harness);
    await screen.findByRole("option", { name: /Original paragraph/ });
    chooseTarget("first");
    await startGeneration();

    fireEvent.click(await screen.findByRole("button", { name: text.accept }));
    await waitFor(() =>
      expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.applied),
    );

    act(() => harness.edit("first", "Original paragraph"));

    await waitFor(() =>
      expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.withdrawn),
    );
    expect(screen.queryByRole("button", { name: text.accept })).not.toBeInTheDocument();
  });

  it("retries the same pending save and remains dirty when editing during export", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let finishExport!: (value: ArrayBuffer) => void;
    mocks.editorSave.mockReturnValue(
      new Promise((resolve) => {
        finishExport = resolve;
      }),
    );
    mocks.saveBaseline
      .mockRejectedValueOnce(new Error("save response lost"))
      .mockResolvedValueOnce({ baselineId: SAVED_BASELINE, revision: 5 });
    await renderReady(harness);
    act(() => harness.setRevision(5));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledTimes(1));

    act(() => harness.edit("first", "Edited while export is in flight"));
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent("r6 / r0");
    await act(async () => finishExport(Uint8Array.from([80, 75, 7, 8]).buffer));
    await screen.findByRole("alert");

    expect(mocks.prepareSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareSave.mock.calls[0]?.[1]).toBe(5);
    fireEvent.click(await screen.findByRole("button", { name: text.retrySave }));
    await waitFor(() =>
      expect(screen.getByTestId("docx-save-state")).toHaveTextContent("r6 / r5"),
    );

    expect(mocks.editorSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareSave).toHaveBeenCalledTimes(1);
    expect(mocks.saveBaseline).toHaveBeenCalledTimes(2);
    expect(mocks.saveBaseline.mock.calls[0]?.[0]).toBe(mocks.saveBaseline.mock.calls[1]?.[0]);
    expect(mocks.clearRecovery).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`${text.baseline}: ${SAVED_BASELINE}`)).toBeInTheDocument();
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  });

  it("checks the exact saved baseline and refuses a mismatched check result", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
    mocks.journalRequest.mockImplementation(async (path: string) => {
      if (path === "/api/state") {
        return {
          worlds: [],
          projects: [
            {
              ...PROJECT,
              baseline_id: SAVED_BASELINE,
              binding: {
                binding_id: "binding-current",
                baseline_id: SAVED_BASELINE,
                world_version_id: WORLD_VERSION,
              },
            },
          ],
        } satisfies JournalState;
      }
      if (path === "/api/check") {
        return {
          baseline_id: "baseline-stale",
          world_version_id: WORLD_VERSION,
          validity: "CURRENT",
        } satisfies Partial<JournalCheck>;
      }
      throw new Error(`Unexpected request ${path}`);
    });
    await renderReady(harness);
    act(() => harness.setRevision(1));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() =>
      expect(screen.getByText(`${text.baseline}: ${SAVED_BASELINE}`)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: text.check }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text.newBaseline));
    expect(mocks.journalRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/state",
      "/api/check",
    ]);
    expect(screen.queryByText(`${text.checked}: CURRENT`)).not.toBeInTheDocument();
  });
});

function presentTask(harness: ReturnType<typeof sessionHarness>) {
  const [registration] = mocks.registerAgentSession.mock.calls[mocks.registerAgentSession.mock.calls.length - 1];
  const target = harness.session.captureTarget(harness.session.listParagraphs()[0].handle);
  const activity = { id: "proposal-1", origin: { taskId: "task-origin", generation: 4, groupId: null, memberId: null, executionId: null, workIds: [] },
    document: { sessionId: registration.sessionId, appProjectId: "app-project", workbenchProjectId: PROJECT.project_id, baselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256, sessionRevision: 0, savedRevision: 0 },
    proposalId: null, createdAt: 1,
    event: { type: "runtime", event: { kind: "proposed", target: { targetId: "target-1", paragraphRef: target.paragraph.ref, original: target.original, revision: 0 }, proposed: "Task candidate" } } };
  act(() => registration.onTaskSuggestion(activity, target));
  return activity;
}

function applyTask(harness: ReturnType<typeof sessionHarness>) {
  mocks.applySuggestion.mockImplementation((_target: DocxTarget, proposed: string) => {
    harness.edit("first", proposed);
    return { ok: true, revision: harness.revision(), changed: true };
  });
  const activity = presentTask(harness);
  fireEvent.click(screen.getAllByRole("button", { name: text.accept })[0]);
  return activity;
}

describe("DOCX task receipts", () => {
  it("retries a failed applied receipt without applying again", async () => {
    const harness = sessionHarness([paragraph("first", "Original")]);
    mocks.settleActivity.mockRejectedValueOnce(new Error("Receipt unavailable")).mockResolvedValue({});
    await renderReady(harness);
    applyTask(harness);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Receipt unavailable"));
    expect(mocks.runInlineCompletion).not.toHaveBeenCalled();
    expect(mocks.applySuggestion).toHaveBeenCalledOnce();
    expect(harness.text("first")).toBe("Task candidate");
    fireEvent.click(screen.getByRole("button", { name: text.taskActivity.retry }));
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledTimes(2));
    expect(mocks.settleActivity.mock.calls[1]).toEqual(mocks.settleActivity.mock.calls[0]);
    expect(mocks.settleActivity.mock.calls[0]).toEqual(["app-project", PROJECT.project_id, "proposal-1", expect.objectContaining({ sessionRevision: 1 }), { kind: "applied" }]);
    expect(mocks.applySuggestion).toHaveBeenCalledOnce();
  });
  it("records rejected and stale proposals without mutation", async () => {
    const harness = sessionHarness([paragraph("first", "Original")]);
    await renderReady(harness);
    presentTask(harness);
    fireEvent.click(screen.getByRole("button", { name: text.reject }));
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledWith("app-project", PROJECT.project_id, "proposal-1", expect.anything(), { kind: "rejected" }));
    mocks.settleActivity.mockClear();
    presentTask(harness);
    act(() => harness.edit("first", "User edit"));
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledWith("app-project", PROJECT.project_id, "proposal-1", expect.anything(), { kind: "withdrawn" }));
    expect(mocks.applySuggestion).not.toHaveBeenCalled();
  });
  it("freezes the task save before commit and retries the same checkpoint after a lost response", async () => {
    const harness = sessionHarness([paragraph("first", "Original")]);
    await renderReady(harness);
    applyTask(harness);
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());
    mocks.commitRecovery.mockRejectedValueOnce(new Error("Save receipt unavailable"));
    let finishExport!: (bytes: ArrayBuffer) => void;
    mocks.editorSave.mockReturnValueOnce(new Promise((resolve) => { finishExport = resolve; }));
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
    const beforeExports = mocks.editorSave.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledTimes(beforeExports + 1));
    act(() => harness.edit("first", "Edited during export"));
    await act(async () => finishExport(Uint8Array.from([80, 75, 1, 2]).buffer));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Save receipt unavailable"));
    const fixed = mocks.saveRecovery.mock.calls.find((call) => call[3]?.pendingSave);
    expect(fixed?.[1]).toBe(1);
    expect(fixed?.[3]).toMatchObject({ document: { sessionRevision: 1 }, applied: [{ proposalId: "proposal-1", document: { sessionRevision: 1 } }], pendingSave: { requestId: "docx-request-fixed" } });
    expect(mocks.clearRecovery).not.toHaveBeenCalled();
    const writes = mocks.saveRecovery.mock.calls.length;
    const originalCommit = mocks.commitRecovery.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: text.retrySave }));
    await waitFor(() => expect(mocks.clearRecovery).toHaveBeenCalledOnce());
    expect(mocks.commitRecovery.mock.calls[1][0]).toEqual(originalCommit);
    // The only later checkpoint holds the post-export edit and its withdrawal.
    expect(mocks.saveRecovery.mock.calls.slice(writes).every((call) => !call[3]?.pendingSave)).toBe(true);
    expect(mocks.editorSave.mock.calls.length).toBeLessThanOrEqual(beforeExports + 2);
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledWith("app-project", PROJECT.project_id, "proposal-1", expect.objectContaining({ sessionRevision: 2 }), { kind: "withdrawn" }));
    expect(mocks.applySuggestion).toHaveBeenCalledOnce();
  });
  it("does not claim an undone candidate belongs to a later save", async () => {
    const harness = sessionHarness([paragraph("first", "Original")]);
    await renderReady(harness);
    applyTask(harness);
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());
    act(() => harness.edit("first", "Original"));
    await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledTimes(2));
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(mocks.saveBaseline).toHaveBeenCalledOnce());
    expect(mocks.settleActivity.mock.calls.map((call) => call[4].kind)).toEqual(["applied", "withdrawn"]);
  });
});

it("withdraws an unaccepted task proposal before explicitly closing its working copy", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const { onClose } = await renderReady(harness);
  presentTask(harness);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text.discard }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.settleActivity).toHaveBeenCalledWith("app-project", PROJECT.project_id, "proposal-1", expect.anything(), { kind: "withdrawn" });
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
});

function taskRecovery(): DocxRecoverySnapshot {
  const document = { sessionId: "previous-session", appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
    baselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256, sessionRevision: 9, savedRevision: 0 };
  return { appProjectId: "app-project", workbenchProjectId: PROJECT.project_id, baseBaselineId: INITIAL_BASELINE,
    sourceSha256: SOURCE.source_sha256, recoveryKey: "b".repeat(64), contentSha256: "c".repeat(64), revision: 9,
    updatedAt: "2026-11-13T02:00:00.000Z", bytes: Uint8Array.from([80, 75, 9, 9]),
    taskState: { document, applied: [{ proposalId: "proposal-recovered", document }], receipts: [] } };
}
function mockResume(snapshot: DocxRecoverySnapshot) {
  mocks.resumeRecovery.mockImplementation(async (_snapshot, document) => [{
    id: "recovered-edge", origin: { taskId: "old-task", generation: 2, groupId: "group", memberId: "member", executionId: "execution", workIds: ["work"] },
    proposalId: "proposal-recovered", document, createdAt: 1,
    event: { type: "outcome", outcome: { kind: "recovered", recoveryKey: snapshot.recoveryKey, contentSha256: snapshot.contentSha256, fromDocument: snapshot.taskState?.document } },
  }]);
}
it("resumes task provenance without reapplying a target and saves unchanged recovery bytes exactly", async () => {
  const snapshot = taskRecovery();
  mockResume(snapshot);
  const harness = sessionHarness([paragraph("first", "Recovered task text")]);
  await renderReady(harness, undefined, true, { recovery: snapshot });
  await screen.findByTestId("docx-recovered-source");
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: text.accept })).not.toBeInTheDocument();
  expect(mocks.resumeRecovery).toHaveBeenCalledWith(snapshot, expect.objectContaining({ sessionRevision: 0, savedRevision: -1 }));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(mocks.commitRecovery).toHaveBeenCalledOnce());
  expect(mocks.editorSave).not.toHaveBeenCalled();
  const write = mocks.saveRecovery.mock.calls.find((call) => call[3]?.pendingSave);
  expect(new Uint8Array(write?.[2])).toEqual(snapshot.bytes);
  expect(write?.[3]).toMatchObject({ document: { sessionRevision: 0, savedRevision: -1 }, applied: [{ proposalId: "proposal-recovered", document: { sessionRevision: 0 } }] });
});

it("withdraws recovered save attribution on first edit and never reacquires it from equal text", async () => {
  const snapshot = taskRecovery();
  mockResume(snapshot);
  const harness = sessionHarness([paragraph("first", "Recovered task text")]);
  await renderReady(harness, undefined, true, { recovery: snapshot });
  await screen.findByTestId("docx-recovered-source");
  act(() => harness.edit("first", "Manual text"));
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledWith("app-project", PROJECT.project_id, "proposal-recovered", expect.objectContaining({ sessionRevision: 1 }), { kind: "withdrawn" }));
  act(() => harness.edit("first", "Recovered task text"));
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 2 });
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(mocks.commitRecovery).toHaveBeenCalledOnce());
  const write = mocks.saveRecovery.mock.calls.find((call) => call[3]?.pendingSave);
  expect(write?.[3].applied).toEqual([]);
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-recovered-source")).toHaveTextContent("old-task");
});

it("keeps a failed resume checkpoint intact and allows retry without applying anything", async () => {
  const snapshot = taskRecovery();
  mockResume(snapshot);
  mocks.resumeRecovery.mockRejectedValueOnce(new Error("Recovery unavailable"));
  const harness = sessionHarness([paragraph("first", "Recovered task text")]);
  await renderReady(harness, undefined, true, { recovery: snapshot });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Recovery unavailable"));
  expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
  expect(mocks.saveRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text.recovery.restore }));
  await screen.findByTestId("docx-recovered-source");
  expect(mocks.resumeRecovery).toHaveBeenCalledTimes(2);
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
});

it("waits for the accepted bytes and source checkpoint before sending Applied", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  let finishCheckpoint!: () => void;
  mocks.saveRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCheckpoint = resolve; }));
  await renderReady(harness);
  applyTask(harness);
  await waitFor(() => expect(mocks.saveRecovery).toHaveBeenCalledOnce());
  expect(mocks.settleActivity).not.toHaveBeenCalled();
  expect(mocks.saveRecovery.mock.calls[0][3]).toMatchObject({
    document: { sessionRevision: 1 }, applied: [{ proposalId: "proposal-1", document: { sessionRevision: 1 } }],
    receipts: [{ proposalId: "proposal-1", outcome: { kind: "applied" } }],
  });
  await act(async () => finishCheckpoint());
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());
});

it("retries a committed resume with the original document after editing and withdraws its attribution", async () => {
  const snapshot = taskRecovery();
  mockResume(snapshot);
  mocks.resumeRecovery.mockRejectedValueOnce(new Error("Resume response lost"));
  const harness = sessionHarness([paragraph("first", "Recovered task text")]);
  await renderReady(harness, undefined, true, { recovery: snapshot });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Resume response lost"));
  act(() => harness.edit("first", "Later user edit"));
  fireEvent.click(screen.getByRole("button", { name: text.recovery.restore }));
  await screen.findByTestId("docx-recovered-source");
  expect(mocks.resumeRecovery.mock.calls[1]).toEqual(mocks.resumeRecovery.mock.calls[0]);
  expect(mocks.resumeRecovery.mock.calls[1][1]).toMatchObject({ sessionRevision: 0 });
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledWith("app-project", PROJECT.project_id,
    "proposal-recovered", expect.objectContaining({ sessionRevision: 1 }), { kind: "withdrawn" }));
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(mocks.commitRecovery).toHaveBeenCalledOnce());
  expect(mocks.saveRecovery.mock.calls.find((call) => call[3]?.pendingSave)?.[3].applied).toEqual([]);
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
});

it("blocks discard of an unconfirmed fixed save and retries only by explicit save", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const { onClose } = await renderReady(harness);
  applyTask(harness);
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());
  mocks.commitRecovery.mockRejectedValueOnce(new Error("Saved but task receipt failed"));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Saved but task receipt failed"));
  const fixed = mocks.commitRecovery.mock.calls[0][0];
  const writes = mocks.saveRecovery.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByText(text.pendingSaveHelp)).toBeInTheDocument();
  const discard = screen.getByRole("button", { name: text.discard });
  expect(discard).toBeDisabled();
  fireEvent.click(discard);
  expect(mocks.commitRecovery).toHaveBeenCalledOnce();
  expect(mocks.clearRecovery).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(mocks.settleActivity.mock.calls.map((call) => call[4].kind)).toEqual(["applied"]);
  fireEvent.click(screen.getByRole("button", { name: text.keepEditing }));
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
  fireEvent.click(screen.getByRole("button", { name: text.retrySave }));
  await waitFor(() => expect(mocks.clearRecovery).toHaveBeenCalledOnce());
  expect(mocks.commitRecovery.mock.calls[1][0]).toEqual(fixed);
  expect(mocks.saveRecovery).toHaveBeenCalledTimes(writes);
  expect(mocks.prepareSave).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("recovers a fixed checkpoint written before its native receipt phase failed", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  act(() => harness.edit("first", "Saved bytes"));
  const metadata = { ...taskRecovery(), taskState: undefined };
  mocks.saveRecovery.mockImplementationOnce(async (_identity, revision, bytes, taskState) => {
    mocks.readRecovery.mockResolvedValue({ ...metadata, revision, bytes: new Uint8Array(bytes), taskState, contentSha256: "d".repeat(64) });
    throw new Error("Checkpoint receipt failed");
  });
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Checkpoint receipt failed"));
  expect(mocks.commitRecovery).not.toHaveBeenCalled();
  expect(mocks.clearRecovery).not.toHaveBeenCalled();
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
  fireEvent.click(screen.getByRole("button", { name: text.retrySave }));
  await waitFor(() => expect(mocks.clearRecovery).toHaveBeenCalledOnce());
  expect(mocks.saveRecovery).toHaveBeenCalledOnce();
  expect(mocks.prepareSave).toHaveBeenCalledOnce();
  expect(mocks.commitRecovery).toHaveBeenCalledOnce();
});

it.each(["BASELINE_CONFLICT", "REJECTED", "IDEMPOTENCY_CONFLICT"])("keeps a refused %s save unsaved and allows explicit discard without a new request", async (refusal) => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const { onClose, onSaved } = await renderReady(harness);
  applyTask(harness);
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());
  const updates = mocks.updateAgentSession.mock.calls.length;
  mocks.commitRecovery.mockResolvedValueOnce({ refusal });
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(`${text.recovery.saveRefused} (${refusal})`));
  const fixed = mocks.commitRecovery.mock.calls[0][0];
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  expect(screen.getByRole("button", { name: text.download })).toBeEnabled();
  expect(screen.getByRole("button", { name: text.retrySave })).toBeDisabled();
  expect(mocks.updateAgentSession).toHaveBeenCalledTimes(updates);
  expect(onSaved).not.toHaveBeenCalled();
  expect(mocks.clearRecovery).not.toHaveBeenCalled();
  expect(mocks.discardRecovery).not.toHaveBeenCalled();
  act(() => harness.edit("first", "Later user edit"));
  fireEvent.click(screen.getByRole("button", { name: text.retrySave }));
  expect(mocks.prepareSave).toHaveBeenCalledOnce();
  expect(mocks.commitRecovery).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("button", { name: text.discard })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: text.discard }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.discardRecovery).toHaveBeenCalledExactlyOnceWith(fixed);
  expect(mocks.prepareSave).toHaveBeenCalledOnce();
  expect(mocks.commitRecovery).toHaveBeenCalledOnce();
  expect(mocks.settleActivity.mock.calls.map((call) => call[4].kind)).not.toContain("saved");
});

it("clears a clean rejection checkpoint by its exact hash before closing", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const { onClose } = await renderReady(harness);
  presentTask(harness);
  let finishCleanup!: (cleared: boolean) => void;
  mocks.discardRecovery.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishCleanup = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: text.reject }));
  await waitFor(() => expect(mocks.discardRecovery).toHaveBeenCalledOnce());
  const stored = await mocks.saveRecovery.mock.results[0].value;
  expect(mocks.discardRecovery).toHaveBeenCalledWith(stored);
  expect(stored).toMatchObject({ recoveryKey: "b".repeat(64), contentSha256: "c".repeat(64) });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finishCleanup(true));
  await waitFor(() => expect(screen.queryByRole("button", { name: text.taskActivity.retry })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(harness.text("first")).toBe("Original");
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
});

it("retains a clean rejection checkpoint until its failed receipt can be recorded", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  mocks.settleActivity.mockRejectedValueOnce(new Error("Receipt offline"));
  const { onClose } = await renderReady(harness);
  presentTask(harness);
  fireEvent.click(screen.getByRole("button", { name: text.reject }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Receipt offline"));
  expect(mocks.saveRecovery).toHaveBeenCalledOnce();
  expect(mocks.discardRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text.taskActivity.retry }));
  await waitFor(() => expect(mocks.discardRecovery).toHaveBeenCalledOnce());
  expect(mocks.settleActivity.mock.calls[1]).toEqual(mocks.settleActivity.mock.calls[0]);
});

it("does not clear recovery when the user edits while a clean rejection receipt is pending", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  let finishReceipt!: () => void;
  mocks.settleActivity.mockReturnValueOnce(new Promise<void>((resolve) => { finishReceipt = resolve; }));
  await renderReady(harness);
  presentTask(harness);
  fireEvent.click(screen.getByRole("button", { name: text.reject }));
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());
  act(() => harness.edit("first", "Later user edit"));
  await act(async () => finishReceipt());
  await waitFor(() => expect(screen.queryByRole("button", { name: text.taskActivity.retry })).not.toBeInTheDocument());
  expect(mocks.discardRecovery).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  await waitFor(() => expect(mocks.saveRecovery).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(mocks.saveRecovery.mock.calls[1][3]).toMatchObject({ document: { sessionRevision: 1 }, applied: [] });
  expect(mocks.discardRecovery).not.toHaveBeenCalled();
});

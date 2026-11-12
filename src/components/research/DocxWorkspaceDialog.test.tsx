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
  saveRecovery: vi.fn(),
  readRecovery: vi.fn(),
  clearRecovery: vi.fn(),
  listRecovery: vi.fn(),
  contentHash: vi.fn(),
  editorDocument: null as Uint8Array | null,
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
    editorSnapshot: { isLoading: false, isOpening: false, parseError: null, page: { current: 1, total: 1 } },
    snapshot: () => mocks.editor.editorSnapshot,
  },
}));

vi.mock("@docx-editor.dev/react", async () => {
  const React = await import("react");
  return {
    useDocxEditor: () => mocks.editor,
    useEditorState: (selector: (snapshot: ReturnType<typeof mocks.editor.snapshot>) => unknown) => selector(mocks.editor.snapshot()),
    useScopedChromeAnchor: () => ({ ref: () => {}, style: { visibility: "hidden" } }),
    DocxEditor: React.forwardRef(function MockDocxEditor(
      props: {
        children?: React.ReactNode;
        document: Uint8Array;
      },
      ref,
    ) {
      mocks.editorDocument = props.document;
      React.useImperativeHandle(ref, () => ({
        save: mocks.editorSave,
        getEditor: () => mocks.editor,
      }));
      return <div data-testid="mock-docx-editor">{props.children}</div>;
    }),
  };
});

vi.mock("@docx-editor.dev/fonts", () => ({ packagedFonts: () => [] }));
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
  readDocxRecovery: mocks.readRecovery,
  clearDocxRecovery: mocks.clearRecovery,
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
  useDocxWorkspaceStore.setState({ request: null, minimized: false, recoveryOpen: false });
  mocks.listRecovery.mockResolvedValue({ snapshots: [], failures: [] });
  mocks.editor.editorSnapshot = { isLoading: false, isOpening: false, parseError: null, page: { current: 1, total: 1 } };
  mocks.loadSource.mockResolvedValue(SOURCE);
  mocks.editorSave.mockResolvedValue(Uint8Array.from([80, 75, 5, 6]).buffer);
  mocks.prepareSave.mockImplementation((source: DocxSource, revision: number) =>
    saveRequest(revision, source.baseline_id),
  );
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 0 });
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
  mocks.contentHash.mockResolvedValue("d".repeat(64));
  mocks.applySuggestion.mockReturnValue({ ok: true, revision: 1, changed: true });
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
        { baselineId: SAVED_BASELINE, savedRevision: 1 },
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

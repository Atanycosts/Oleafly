// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { StrictMode } from "react";
import type { JournalCheck, JournalProject, JournalState, JournalWorld } from "@/lib/journal-workbench";
import type { DocxParagraph, DocxSession, DocxTarget } from "@/lib/docx-session";
import type { EditorSnapshot } from "@docx-editor.dev/core/contracts/editor";
import type { DocxSave, DocxSource } from "@/lib/docx-workbench";
import type { DocxRecoverySaveOperation, DocxRecoverySnapshot } from "@/lib/docx-recovery";
import type { DocxSaveResult } from "@oleafly/ai-tools";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import enEditor from "@/i18n/locales/en/editor.json" with { type: "json" };
import { projectLeaveAllowed } from "@/lib/project-leave-guards";
import { acquireEditorMutationLease } from "@/lib/editor-mutation-lease";
import { runDocxHistory } from "@/lib/docx-history";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
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
  bindTask: vi.fn(),
  retainFormat: vi.fn(),
  templateCheck: vi.fn(),
  fontOptions: null as null | { onError(cause: unknown): void; onStatus(value: import("@/lib/docx-fonts").DocxFontStatus): void },
  editorDocument: null as Uint8Array | null,
  fontShaping: undefined as { maxFontBytes: number } | undefined,
  runInlineCompletion: vi.fn(),
  createSession: vi.fn(),
  journalRequest: vi.fn(),
  editorSave: vi.fn(),
  downloadCopy: vi.fn(),
  editorMounted: vi.fn(),
  editorUnmounted: vi.fn(),
  renderFonts: vi.fn(),
  loadPdf: vi.fn(),
  pdfSelection: null as import("@/components/pdf/PdfViewer").PdfTextSelection | null,
  findRenderer: vi.fn(),
  applySuggestion: vi.fn(),
  registerAgentSession: vi.fn(),
  updateAgentSession: vi.fn(),
  unregisterAgentSession: vi.fn(),
  editorMounts: [] as { document: Uint8Array; mode: "edit" | "view" | "suggesting"; colorMode?: string }[],
  editorListeners: new Map<string, (value: unknown) => void>(),
  editor: {
    save: () => mocks.editorSave(),
    exec: vi.fn(),
    setFonts: vi.fn(),
    scrollToAnchor: vi.fn(),
    highlightAnchor: vi.fn(),
    clearAnchorHighlight: vi.fn(),
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      mocks.editorListeners.set(event, listener);
      return () => { mocks.editorListeners.delete(event); };
    }),
    query: vi.fn(() => ""),
    measurement: { measurer: "fixed" as "fixed" | "shaped", resolving: false, producer: undefined as string | undefined },
    fontMeasurement: () => mocks.editor.measurement,
    editorSnapshot: {
      isLoading: false,
      isOpening: false,
      parseError: null,
      page: { current: 1, total: 1 },
      selection: null as EditorSnapshot["selection"],
      selectionCollapsed: true,
    },
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
    useEditorCommand: (slot: string) => ({ isEnabled: true, isActive: false,
      execute: () => mocks.editor.exec({ type: slot === "history.redo" ? "redo" : slot === "history.undo" ? "undo" : slot }),
    }),
    useEditorValueCommand: () => ({ value: 22, isEnabled: true, execute: vi.fn() }),
    useFontFamily: () => ({ value: "Cambria", options: ["Cambria"], isEnabled: true, setValue: vi.fn() }),
    DocxEditor: { Root: function MockDocxEditorRoot(
      props: {
        children?: React.ReactNode;
        document: Uint8Array;
        fontShaping: { maxFontBytes: number };
        mode: "edit" | "view" | "suggesting";
        colorMode?: string;
      },
    ) {
      mocks.editorDocument = props.document;
      mocks.fontShaping = props.fontShaping;
      React.useEffect(() => {
        mocks.editorMounts.push({ document: props.document, mode: props.mode, colorMode: props.colorMode });
        mocks.editorMounted();
        return () => mocks.editorUnmounted();
      }, []);
      return <div data-testid="mock-docx-editor">{props.children}</div>;
    }, Viewport: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Content: () => null, Loading: () => null, OpenFailure: () => null,
      HeaderFooterChrome: () => null, NotesChrome: () => null },
  };
});

vi.mock("./DocxTaskActivity", () => ({ DocxTaskActivity: () => <div data-testid="task-panel" />, DocxActivitySource: ({ activity }: { activity: { origin: { taskId: string } } }) => <span>{activity.origin.taskId}</span> }));
vi.mock("@/lib/docx-task-activity", () => ({ settleDocxTaskActivity: mocks.settleActivity, bindDocxTask: mocks.bindTask }));
vi.mock("@/lib/docx-template-client", async (original) => ({
  ...await original<typeof import("@/lib/docx-template-client")>(),
  retainDocxFormat: mocks.retainFormat,
  checkJournalTemplate: mocks.templateCheck,
}));
vi.mock("@/lib/docx-fonts", () => ({ hasExactDocxFont: vi.fn(), createDocxFontResolver: (options: NonNullable<typeof mocks.fontOptions>) => { mocks.fontOptions = options; return () => undefined; } }));
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
  recoveryPendingSave: (save: DocxSave, operation?: DocxRecoverySaveOperation) => ({ projectId: save.project_id, expectedBaselineId: save.expected_baseline_id, filename: save.filename, reason: save.reason, requestId: save.request_id, revision: save.revision, ...(operation ? { operation } : {}) }),
  readDocxRecovery: mocks.readRecovery,
  clearDocxRecovery: mocks.clearRecovery,
  discardDocxRecovery: mocks.discardRecovery,
  docxContentSha256: mocks.contentHash,
  listDocxRecovery: mocks.listRecovery,
}));
vi.mock("@/lib/journal-workbench", () => ({ journalRequest: mocks.journalRequest }));
vi.mock("@/lib/docx-render", () => ({ findDocxRenderer: mocks.findRenderer, ensureDocxRender: mocks.renderFonts, loadDocxPdf: mocks.loadPdf }));
vi.mock("@/components/pdf/PdfViewer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { PdfViewer: forwardRef(function PdfViewer({ documentIdentity, onPageChange }: {
    documentIdentity: string; onPageChange?(page: number, total: number): void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getTextSelection: () => mocks.pdfSelection, gotoPage: vi.fn() }));
    const pageLabel = "PDF page 3";
    const selectedText = "Saved PDF text";
    return <div data-testid="saved-pdf-viewer" data-document-identity={documentIdentity}>
      <button type="button" onClick={() => onPageChange?.(3, 4)}>{pageLabel}</button>
      <span>{selectedText}</span>
    </div>;
  }) };
});
vi.mock("@/lib/docx-download", () => ({ downloadDocxCopy: mocks.downloadCopy }));

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
  journal_id: "journal-example",
  journal_name: "Example Journal",
  version_ordinal: 1,
  created_at: "2026-11-15T00:00:00Z",
  scope: { article_type: "research", stage: "submission", language: "en" },
  sources: [],
  rules: [],
  coverage_gaps: [],
  limitations: [],
} satisfies JournalWorld;

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

function exactFontDocx(): Uint8Array {
  const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const relationships =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  const officeDocument =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${relationships}"><Relationship Id="doc" Type="${officeDocument}" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships xmlns="${relationships}"/>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Exact Face" w:hAnsi="Exact Face"/></w:rPr><w:t>Exact Face</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    ),
  });
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
    listParagraphHandles: () => current.map(({ handle }) => handle),
    listParagraphs: () => current,
    readParagraph: (handle) => {
      const target = current.find((item) => item.handle.ref === handle.ref);
      if (!target) throw new Error("missing paragraph");
      return { paragraphRef: handle.ref, revision, paraId: target.paraId,
        modelText: target.text, displayText: target.text, atoms: [],
        editableRanges: [{ start: 0, end: target.text.length }] };
    },
    replaceParagraphRange: () => ({ ok: false, code: "unsupported-target",
      message: "Range editing is outside this dialog fixture.", revision, changed: false }),
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

async function renderReady(harness: ReturnType<typeof sessionHarness>, onSaved = vi.fn(async () => {}), waitForSession = true, options: { recovery?: DocxRecoverySnapshot; project?: JournalProject; world?: JournalWorld | null } = {}) {
  mocks.createSession.mockReturnValue(harness.session);
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
    <DocxWorkspaceDialog
      appProjectId="app-project"
      project={options.project ?? PROJECT}
      recovery={options.recovery}
      world={options.world === undefined ? WORLD : options.world}
      onClose={onClose}
      onSaved={onSaved}
    />
    </QueryClientProvider>
  );
  const view = render(tree);
  if (waitForSession) await waitFor(() => expect(mocks.createSession).toHaveBeenCalled());
  return { onClose, onSaved, rerender: () => view.rerender(tree), unmount: view.unmount };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.editorListeners.clear();
  mocks.editorMounts.length = 0;
  useWorkspaceSurfaceStore.setState({ active: "word" });
  useAgentWorkspaceStore.setState({ views: {}, operations: [], paused: false, navigation: null });
  useMaterialAnnotationsStore.getState().close();
  mocks.findRenderer.mockResolvedValue(null);
  mocks.loadPdf.mockResolvedValue(Uint8Array.from([37, 80, 68, 70]));
  mocks.pdfSelection = null;
  mocks.editor.measurement = { measurer: "fixed", resolving: false, producer: undefined };
  useDocxWorkspaceStore.setState({ request: null, context: null, minimized: false, recoveryOpen: false,
    savedVersion: 0, closeRequested: 0, closingBlocked: false });
  mocks.settleActivity.mockResolvedValue({});
  mocks.bindTask.mockResolvedValue(undefined);
  mocks.retainFormat.mockResolvedValue(undefined);
  mocks.listRecovery.mockResolvedValue({ snapshots: [], failures: [] });
  mocks.editor.editorSnapshot = {
    isLoading: false,
    isOpening: false,
    parseError: null,
    page: { current: 1, total: 1 },
    selection: null,
    selectionCollapsed: true,
  };
  mocks.loadSource.mockResolvedValue(SOURCE);
  mocks.editorSave.mockResolvedValue(Uint8Array.from([80, 75, 5, 6]).buffer);
  mocks.downloadCopy.mockResolvedValue({ status: "cancelled" });
  mocks.editor.scrollToAnchor.mockReturnValue(true);
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

async function chooseMaterialView(label: string) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const display = screen.getByRole("combobox", { name: enEditor.materials.viewMode });
  Object.assign(display, { hasPointerCapture: () => false, setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  fireEvent.pointerDown(display, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

it("publishes the viewed revision and live selection separately from original reference data", async () => {
  const harness = sessionHarness([paragraph("first", "Selected text")]);
  await renderReady(harness);
  mocks.editor.editorSnapshot = { ...mocks.editor.editorSnapshot,
    selection: { from: { paraId: "para-first" }, to: { paraId: "para-first" } }, selectionCollapsed: false };
  mocks.editor.query.mockReturnValue("Selected text");
  act(() => mocks.editorListeners.get("selectionChange")?.(mocks.editor.editorSnapshot));
  const current = () => useAgentWorkspaceStore.getState().views["app-project"];
  expect(current()).toMatchObject({ role: "working", revision: "0", sessionRevision: 0, dirty: false,
    selection: { revision: "0", paraId: "para-first", quote: "Selected text" } });
  expect(current().selection?.paragraphRef).toBeUndefined();
  act(() => harness.edit("first", "New working text"));
  expect(current()).toMatchObject({ role: "working", revision: "1", dirty: true,
    selection: { revision: "1", paraId: "para-first" } });

  await chooseMaterialView(enEditor.materials.docxOriginal);
  expect(current()).toMatchObject({ role: "original", revision: SOURCE.source_sha256,
    selection: { revision: SOURCE.source_sha256, paraId: "para-first" } });
  expect(current().sessionId).toBeUndefined();
  expect(current().selection?.paragraphRef).toBeUndefined();
  expect(screen.getAllByTestId("word-formatting-toolbar")).toHaveLength(1);
  expect(screen.getByRole("button", { name: enEditor.toolbar.bold })).toBeDisabled();

  const evidence = { projectId: "app-project", documentId: "evidence", kind: "pdf" as const,
    title: "Evidence", role: "evidence" as const, revision: "exact-evidence" };
  act(() => {
    useWorkspaceSurfaceStore.setState({ active: "material" });
    useAgentWorkspaceStore.getState().publishView(evidence);
  });
  act(() => harness.edit("first", "Background update"));
  expect(current()).toEqual(evidence);
});

it("handles repeated caret and selection changes without reading the full document or exporting bytes", async () => {
  const harness = sessionHarness(Array.from({ length: 1000 }, (_, index) => paragraph(index === 0 ? "first" : `p${index}`, "Synthetic long document paragraph")));
  const readParagraphs = vi.spyOn(harness.session, "listParagraphs");
  await renderReady(harness);
  readParagraphs.mockClear();
  mocks.editorSave.mockClear();
  mocks.editor.query.mockClear().mockReturnValue("Selected text");
  for (let index = 0; index < 20; index += 1) {
    mocks.editor.editorSnapshot = { ...mocks.editor.editorSnapshot,
      selection: { from: { paraId: "para-first" }, to: { paraId: "para-first" } }, selectionCollapsed: index % 2 === 0 };
    act(() => mocks.editorListeners.get("selectionChange")?.(mocks.editor.editorSnapshot));
  }
  // Editing publishes a new revision through the same path, without an eager paragraph scan.
  act(() => harness.edit("first", "New working text"));
  expect(readParagraphs).not.toHaveBeenCalled();
  expect(mocks.editorSave).not.toHaveBeenCalled();
  expect(mocks.editor.query).toHaveBeenCalledTimes(11);
  expect(useAgentWorkspaceStore.getState().views["app-project"].selection).toMatchObject({ revision: "1", paraId: "para-first" });
});

it("starts a saved PDF preview only after a direct user request", async () => {
  mocks.findRenderer.mockResolvedValue("/opt/soffice");
  mocks.renderFonts.mockResolvedValue({ bundle_id: "render-requested", baseline_id: INITIAL_BASELINE,
    manifest: { page_count: 1, render_record: { renderer_version: "LibreOffice 26.8" } } });
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  expect(mocks.findRenderer).not.toHaveBeenCalled();
  expect(mocks.renderFonts).not.toHaveBeenCalled();
  const openPdf = screen.getByRole("button", { name: text.render.open });
  expect(openPdf).toBeEnabled();
  fireEvent.click(openPdf);
  expect(screen.getByTestId("docx-render-preview")).toBeVisible();
  await waitFor(() => expect(mocks.renderFonts).toHaveBeenCalledExactlyOnceWith(PROJECT.project_id, INITIAL_BASELINE, "/opt/soffice", false));
  expect(mocks.editorSave).not.toHaveBeenCalled();
});

it("publishes the saved PDF identity, page and selection while preserving the separate Word session", async () => {
  const pdfHash = "e".repeat(64);
  mocks.findRenderer.mockResolvedValue("/opt/soffice");
  mocks.renderFonts.mockResolvedValue({ bundle_id: "render-selected", baseline_id: INITIAL_BASELINE,
    manifest: { pdf_sha256: pdfHash, page_count: 4, render_record: { renderer_version: "LibreOffice 26.8" } } });
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  fireEvent.click(screen.getByRole("button", { name: text.render.open }));
  await screen.findByTestId("saved-pdf-viewer");
  const current = () => useAgentWorkspaceStore.getState().views["app-project"];
  expect(current()).toMatchObject({
    documentId: `docx-render:${PROJECT.project_id}:${INITIAL_BASELINE}:render-selected`,
    kind: "pdf", role: "result", revision: pdfHash,
  });
  expect(current().sessionId).toBeUndefined();
  expect(current().sessionRevision).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "PDF page 3" }));
  expect(current().selection).toEqual({ revision: pdfHash, anchor: { kind: "page", page: 3, rects: [] } });
  mocks.pdfSelection = { documentIdentity: "render-selected", text: "Selected saved sentence", rotation: 0,
    pages: [{ page: 3, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] }] };
  fireEvent.mouseUp(screen.getByText("Saved PDF text"));
  expect(current().selection).toEqual({ revision: pdfHash, anchor: { kind: "pdf", rotation: 0,
    pages: mocks.pdfSelection.pages, quote: "Selected saved sentence" } });
  expect(current().selection?.paragraphRef).toBeUndefined();

  act(() => harness.edit("first", "Unsaved working text"));
  expect(current()).toMatchObject({ kind: "pdf", revision: pdfHash,
    selection: { anchor: { quote: "Selected saved sentence" } } });
  expect(screen.getByTestId("docx-render-preview")).toHaveTextContent(text.render.stale);
  const evidence = { projectId: "app-project", documentId: "other-evidence", kind: "pdf" as const,
    title: "Other evidence", role: "evidence" as const, revision: "other-hash" };
  act(() => {
    useWorkspaceSurfaceStore.setState({ active: "material" });
    useAgentWorkspaceStore.getState().publishView(evidence);
  });
  act(() => harness.edit("first", "More background work"));
  expect(current()).toEqual(evidence);
  act(() => useWorkspaceSurfaceStore.setState({ active: "word" }));
  expect(current()).toMatchObject({ kind: "pdf", revision: pdfHash });
  fireEvent.click(screen.getByRole("button", { name: en.workspace.backToDocument }));
  expect(current()).toMatchObject({ kind: "docx", role: "working", revision: "2", sessionRevision: 2, dirty: true });
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(mocks.editorSave).not.toHaveBeenCalled();
});

it("reveals the existing work session from history without focusing or rebinding it", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  act(() => harness.edit("first", "Unsaved working text"));
  await chooseMaterialView(enEditor.materials.docxOriginal);
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  await expect(registration.reveal({ paragraphRef: "first", expectedRevision: 0 })).rejects.toThrow("earlier revision");
  expect(screen.getByTestId("docx-original-surface")).toBeVisible();
  expect(mocks.editor.scrollToAnchor).not.toHaveBeenCalled();
  await expect(registration.reveal({ paragraphRef: "missing", expectedRevision: 1 })).rejects.toThrow("no longer present");

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: enEditor.materials.viewMode })));
  const focused = screen.getByRole("button", { name: text.download });
  focused.focus();
  await act(async () => { await registration.reveal({ paragraphRef: "first", expectedRevision: 1 }); });
  expect(screen.getByTestId("docx-editor-surface")).toBeVisible();
  expect(mocks.editor.scrollToAnchor).toHaveBeenCalledWith({ paraId: "para-first" });
  expect(mocks.editor.highlightAnchor).toHaveBeenCalledWith({ paraId: "para-first" });
  expect(document.activeElement).toBe(focused);
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(mocks.registerAgentSession).toHaveBeenCalledOnce();
  expect(mocks.editorUnmounted).not.toHaveBeenCalled();
  expect(harness.text("first")).toBe("Unsaved working text");
  expect(runDocxHistory(screen.getByTestId("docx-editor-surface"), false)).toBe(true);
  expect(mocks.editor.exec).toHaveBeenCalledWith({ type: "undo" });

  mocks.editor.scrollToAnchor.mockReturnValueOnce(false);
  await expect(registration.reveal({ paraId: "para-first", expectedRevision: 1 })).rejects.toThrow("no visible layout");
});

it("commits the working surface before waiting for the editor navigation frame", async () => {
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  await chooseMaterialView(enEditor.materials.docxOriginal);
  expect(screen.getByTestId("docx-editor-surface")).not.toBeVisible();
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  let frame: FrameRequestCallback | undefined;
  const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    expect(screen.getByTestId("docx-editor-surface")).toBeVisible();
    expect(screen.getByTestId("docx-original-surface")).not.toBeVisible();
    frame = callback;
    return 1;
  });
  try {
    await act(async () => {
      const navigation = registration.reveal({ paragraphRef: "first", expectedRevision: 0 });
      expect(mocks.editor.scrollToAnchor).not.toHaveBeenCalled();
      if (!frame) throw new Error("Navigation did not request its measurement frame.");
      frame(0);
      await navigation;
    });
    expect(mocks.editor.scrollToAnchor).toHaveBeenCalledExactlyOnceWith({ paraId: "para-first" });
  } finally {
    frames.mockRestore();
  }
});

it("returns actual font resolution and export outcomes through the registered business callbacks", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  const missing = [{ family: "SimSun", weight: 400, style: "normal" as const }];
  mocks.editor.setFonts.mockImplementationOnce(async () => {
    mocks.fontOptions?.onStatus({ probed: true, missing, aliases: [] });
  });
  let prepared: unknown;
  await act(async () => { prepared = await registration.prepareFonts(); });
  expect(prepared).toMatchObject({ status: { probed: true, missing }, measurement: { measurer: "fixed", resolving: false } });
  mocks.editor.setFonts.mockImplementationOnce(async () => { mocks.fontOptions?.onError(new Error("font read failed")); });
  await act(async () => { await expect(registration.prepareFonts()).rejects.toThrow("font read failed"); });

  act(() => harness.edit("first", "Current export"));
  expect(await registration.exportDocument()).toMatchObject({ result: { status: "cancelled" },
    filename: SOURCE.filename, sessionRevision: 1, byteLength: 4 });
  expect(mocks.downloadCopy).toHaveBeenCalledWith(Uint8Array.from([80, 75, 5, 6]), SOURCE.filename);
  mocks.downloadCopy.mockResolvedValueOnce({ status: "saved", path: "/chosen/working.docx" });
  expect(await registration.exportDocument()).toMatchObject({ result: { status: "saved", path: "/chosen/working.docx" } });
  mocks.downloadCopy.mockRejectedValueOnce(new Error("disk full"));
  await act(async () => { await expect(registration.exportDocument()).rejects.toThrow("disk full"); });
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
});

it("reads exact live run fonts through the registered format contract", async () => {
  mocks.editorSave.mockResolvedValue(exactFontDocx().buffer);
  await renderReady(sessionHarness([paragraph("first", "Exact Face")]));
  const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];

  const first = await registration.readFormat({
    kind: "objects",
    objectKind: "run",
    limit: 10,
  });
  const second = await registration.readFormat({
    kind: "objects",
    objectKind: "run",
    limit: 10,
  });

  expect(first.document).toMatchObject({
    sessionId: registration.sessionId,
    filename: SOURCE.filename,
    baselineId: INITIAL_BASELINE,
    sessionRevision: 0,
    savedRevision: 0,
    dirty: false,
  });
  expect(first.objects).toContainEqual(
    expect.objectContaining({
      kind: "run",
      text: "Exact Face",
      properties: expect.objectContaining({
        run: expect.objectContaining({ fontFamily: "Exact Face" }),
      }),
    }),
  );
  expect(second.sourceSha256).toBe(first.sourceSha256);
  expect(mocks.editorSave).toHaveBeenCalledOnce();
  expect(mocks.createSession).toHaveBeenCalledOnce();
});

it("re-exports format facts after an edit and caches them for the new revision", async () => {
  const harness = sessionHarness([paragraph("first", "Exact Face")]);
  mocks.editorSave.mockResolvedValue(exactFontDocx().buffer);
  await renderReady(harness);
  const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
  const query = { kind: "objects" as const, objectKind: "run", limit: 10 };

  const initial = await registration.readFormat(query);
  act(() => harness.edit("first", "Exact Face after edit"));
  const changed = await registration.readFormat(query);
  const cached = await registration.readFormat(query);

  expect(initial.document).toMatchObject({ sessionRevision: 0, dirty: false });
  expect(changed.document).toMatchObject({ sessionRevision: 1, dirty: true });
  expect(cached.document).toMatchObject({ sessionRevision: 1, dirty: true });
  expect(cached.sourceSha256).toBe(changed.sourceSha256);
  expect(mocks.editorSave).toHaveBeenCalledTimes(2);
});

it("re-exports format facts after a failed snapshot and succeeds on retry", async () => {
  mocks.editorSave
    .mockRejectedValueOnce(new Error("format export unavailable"))
    .mockResolvedValueOnce(exactFontDocx().buffer);
  await renderReady(sessionHarness([paragraph("first", "Exact Face")]));
  const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
  const query = { kind: "objects" as const, objectKind: "run", limit: 10 };

  await expect(registration.readFormat(query)).rejects.toThrow(
    "format export unavailable",
  );
  const retry = await registration.readFormat(query);
  const cached = await registration.readFormat(query);

  expect(retry.objects).toContainEqual(
    expect.objectContaining({
      kind: "run",
      properties: expect.objectContaining({
        run: expect.objectContaining({ fontFamily: "Exact Face" }),
      }),
    }),
  );
  expect(cached.sourceSha256).toBe(retry.sourceSha256);
  expect(mocks.editorSave).toHaveBeenCalledTimes(2);
});

it("serializes concurrent Agent font preparations without remounting the editor", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  let finishFirst!: () => void;
  mocks.editor.setFonts
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = () => {
            mocks.fontOptions?.onStatus({
              probed: true,
              missing: [{ family: "SimSun", weight: 400, style: "normal" }],
              aliases: [],
            });
            resolve();
          };
        }),
    )
    .mockImplementationOnce(async () => {
      mocks.fontOptions?.onStatus({
        probed: true,
        missing: [],
        aliases: [],
      });
    });
  await renderReady(harness);
  const document = mocks.editorDocument;
  const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];

  let first!: ReturnType<typeof registration.prepareFonts>;
  let second!: ReturnType<typeof registration.prepareFonts>;
  act(() => {
    first = registration.prepareFonts();
    second = registration.prepareFonts();
  });
  await waitFor(() => expect(mocks.editor.setFonts).toHaveBeenCalledOnce());

  let firstResult!: Awaited<typeof first>;
  await act(async () => {
    finishFirst();
    firstResult = await first;
  });
  await waitFor(() => expect(mocks.editor.setFonts).toHaveBeenCalledTimes(2));
  const secondResult = await second;

  expect(firstResult.status.missing).toEqual([
    { family: "SimSun", weight: 400, style: "normal" },
  ]);
  expect(secondResult.status).toEqual({ probed: true, missing: [], aliases: [] });
  expect(mocks.editorDocument).toBe(document);
  expect(harness.text("first")).toBe("Original");
  expect(mocks.createSession).toHaveBeenCalledOnce();
});

it("stops an Agent font preparation once its working copy has closed", async () => {
  const view = await renderReady(
    sessionHarness([paragraph("first", "Original")]),
  );
  const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];

  view.unmount();

  await expect(registration.prepareFonts()).rejects.toThrow(
    "closed during font preparation",
  );
  expect(mocks.editor.setFonts).not.toHaveBeenCalled();
});

it("cancels a reveal before or during the next frame without a late scroll", async () => {
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  await chooseMaterialView(enEditor.materials.docxOriginal);
  const controller = new AbortController();
  controller.abort();
  await registration.reveal({ paragraphRef: "first", expectedRevision: 0, signal: controller.signal });
  expect(screen.getByTestId("docx-original-surface")).toBeVisible();

  let nextFrame: FrameRequestCallback | undefined;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame = callback;
    return 1;
  });
  const pendingController = new AbortController();
  try {
    await act(async () => {
      const reveal = registration.reveal({ paragraphRef: "first", expectedRevision: 0, signal: pendingController.signal });
      pendingController.abort();
      nextFrame?.(0);
      await reveal;
    });
    expect(mocks.editor.scrollToAnchor).not.toHaveBeenCalled();
    expect(mocks.editor.highlightAnchor).not.toHaveBeenCalled();
  } finally { requestFrame.mockRestore(); }
});

it("rejects a reveal when the live revision changes before its next frame", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  let nextFrame: FrameRequestCallback | undefined;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame = callback;
    return 1;
  });
  try {
    await act(async () => {
      const reveal = registration.reveal({ paragraphRef: "first", expectedRevision: 0 });
      harness.edit("first", "User edited before navigation");
      nextFrame?.(0);
      await expect(reveal).rejects.toThrow("changed before navigation");
    });
    expect(mocks.editor.scrollToAnchor).not.toHaveBeenCalled();
    expect(mocks.editor.highlightAnchor).not.toHaveBeenCalled();
  } finally { requestFrame.mockRestore(); }
});

it("rejects a pending reveal when the working session closes before its frame", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const view = await renderReady(harness);
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  let nextFrame: FrameRequestCallback | undefined;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame = callback;
    return 1;
  });
  try {
    let navigation!: Promise<void>;
    act(() => {
      navigation = registration.reveal({ paragraphRef: "first", expectedRevision: 0 });
    });
    expect(nextFrame).toBeTypeOf("function");
    view.unmount();
    await act(async () => {
      nextFrame?.(0);
      await expect(navigation).rejects.toThrow("closed before navigation completed");
    });
    expect(harness.session.dispose).toHaveBeenCalledOnce();
    expect(mocks.editor.scrollToAnchor).not.toHaveBeenCalled();
    expect(mocks.editor.highlightAnchor).not.toHaveBeenCalled();
  } finally { requestFrame.mockRestore(); }
});

it("marks saved check evidence stale after a user edit without rewriting the result", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const checked = { baseline_id: INITIAL_BASELINE, world_version_id: WORLD_VERSION, validity: "CURRENT" };
  mocks.journalRequest.mockImplementation(async (path: string) => {
    if (path === "/api/state") return { projects: [{ ...PROJECT, binding: {
      binding_id: "binding-current", baseline_id: INITIAL_BASELINE, world_version_id: WORLD_VERSION,
    } }] };
    if (path === "/api/check") return checked;
    throw new Error(`Unexpected request ${path}`);
  });
  await renderReady(harness);
  fireEvent.click(screen.getByRole("button", { name: text.check }));
  await waitFor(() => expect(screen.getByTestId("docx-check-validity")).toHaveTextContent(en.journal.current));
  act(() => harness.edit("first", "Changed since check"));
  expect(screen.getByTestId("docx-check-validity")).toHaveTextContent(en.journal.stale);
  expect(checked.validity).toBe("CURRENT");
});

it("retries a failed saved-version check only after the user asks again", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const checked = {
    baseline_id: INITIAL_BASELINE,
    world_version_id: WORLD_VERSION,
    validity: "CURRENT",
  } satisfies Partial<JournalCheck>;
  const boundProject = {
    ...PROJECT,
    binding: {
      binding_id: "binding-current",
      baseline_id: INITIAL_BASELINE,
      world_version_id: WORLD_VERSION,
    },
  };
  let checkAttempts = 0;
  mocks.journalRequest.mockImplementation(async (path: string) => {
    if (path === "/api/state") return { projects: [boundProject] };
    if (path === "/api/check") {
      checkAttempts += 1;
      if (checkAttempts === 1) throw new Error("Checker unavailable");
      return checked;
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const view = await renderReady(harness);
  fireEvent.click(screen.getByRole("button", { name: text.check }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Checker unavailable"));
  expect(screen.getByRole("button", { name: text.check })).toBeEnabled();
  expect(screen.queryByTestId("docx-check-validity")).not.toBeInTheDocument();
  expect(view.onSaved).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: text.check }));
  await waitFor(() => expect(screen.getByTestId("docx-check-validity")).toHaveTextContent(en.journal.current));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.journalRequest.mock.calls.map(([path]) => path)).toEqual([
    "/api/state",
    "/api/check",
    "/api/state",
    "/api/check",
  ]);
  expect(view.onSaved).toHaveBeenCalledOnce();
});

it("shows useful font progress without exposing shaping internals", async () => {
  mocks.editor.measurement = { measurer: "fixed", resolving: true, producer: undefined };
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  expect(screen.getByTestId("docx-font-state")).toHaveTextContent(en.workspace.preparingFonts);
  mocks.editor.measurement = { measurer: "shaped", resolving: false, producer: "font-hash-producer" };
  act(() => harness.edit("first", "Changed"));
  await waitFor(() => expect(screen.getByTestId("docx-font-state")).toBeEmptyDOMElement());
  expect(screen.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
  expect(screen.getByTestId("docx-font-state")).not.toHaveAttribute("data-producer");
  mocks.editor.measurement = { measurer: "fixed", resolving: false, producer: undefined };
  act(() => harness.edit("first", "Changed again"));
  await waitFor(() => expect(screen.getByTestId("docx-font-state")).toBeEmptyDOMElement());
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

it("shows missing document faces and a native font failure", async () => {
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  act(() => mocks.fontOptions?.onStatus({ probed: true, missing: [{ family: "SimSun", weight: 400, style: "normal" }], aliases: [] }));
  fireEvent.click(screen.getByRole("button", { name: en.workspace.documentTools }));
  expect(screen.getByTestId("docx-font-missing-families")).toHaveTextContent("SimSun");
  act(() => mocks.fontOptions?.onError(new Error("Native read failed")));
  expect(screen.getByRole("alert")).toHaveTextContent(`${text.fontError}: Error: Native read failed`);
});

it("refreshes fonts in the existing edited session without changing its dirty state or document", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const bytes = mocks.editorDocument;
  act(() => harness.edit("first", "Unsaved edit"));
  fireEvent.click(screen.getByRole("button", { name: en.workspace.documentTools }));
  fireEvent.click(screen.getByTestId("docx-font-refresh"));
  await waitFor(() => expect(mocks.editor.setFonts).toHaveBeenCalledOnce());
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(mocks.editorDocument).toBe(bytes);
  expect(harness.text("first")).toBe("Unsaved edit");
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
});

it("keeps the edited session and retries a failed font refresh", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const bytes = mocks.editorDocument;
  act(() => harness.edit("first", "Unsaved edit"));
  fireEvent.click(screen.getByRole("button", { name: en.workspace.documentTools }));
  const refresh = screen.getByTestId("docx-font-refresh");
  mocks.editor.setFonts.mockImplementationOnce(async () => {
    mocks.fontOptions?.onError(new Error("font read failed"));
  });
  fireEvent.click(refresh);
  await waitFor(() => expect(screen.getAllByRole("alert").some(
    (alert) => alert.textContent?.includes(`${text.fontError}: Error: font read failed`),
  )).toBe(true));
  await waitFor(() => expect(refresh).toBeEnabled());

  mocks.editor.setFonts.mockImplementationOnce(async () => {
    mocks.fontOptions?.onStatus({ probed: true, missing: [], aliases: [] });
  });
  fireEvent.click(refresh);
  await waitFor(() => expect(mocks.editor.setFonts).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("docx-fonts-panel")).toHaveTextContent(en.docx.fonts.noneMissing));
  expect(mocks.editorDocument).toBe(bytes);
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(harness.text("first")).toBe("Unsaved edit");
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  expect(mocks.editorSave).not.toHaveBeenCalled();
});

it("regenerates the saved PDF after refreshing fonts without saving or remounting the edited document", async () => {
  mocks.findRenderer.mockResolvedValue("/opt/soffice");
  mocks.renderFonts.mockResolvedValue({
    bundle_id: "render-initial", baseline_id: INITIAL_BASELINE,
    manifest: { page_count: 1, render_record: { renderer_version: "LibreOffice 26.8" } },
  });
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  fireEvent.click(screen.getByRole("button", { name: en.workspace.documentTools }));
  await waitFor(() => expect(mocks.renderFonts).toHaveBeenCalledWith(PROJECT.project_id, INITIAL_BASELINE, "/opt/soffice", false));
  const bytes = mocks.editorDocument;
  act(() => harness.edit("first", "Unsaved edit"));
  fireEvent.click(screen.getByTestId("docx-font-refresh"));
  await waitFor(() => expect(mocks.renderFonts).toHaveBeenCalledWith(PROJECT.project_id, INITIAL_BASELINE, "/opt/soffice", true));
  expect(mocks.editorDocument).toBe(bytes);
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(mocks.saveBaseline).not.toHaveBeenCalled();
  expect(harness.text("first")).toBe("Unsaved edit");
});

describe("DocxWorkspaceDialog editing lifecycle", () => {
  it("ignores an earlier source load after StrictMode replays initialization", async () => {
    const harness = sessionHarness([paragraph("first", "Original text")]);
    mocks.createSession.mockReturnValue(harness.session);
    let finishEarlier!: (source: DocxSource) => void;
    let finishCurrent!: (source: DocxSource) => void;
    mocks.loadSource
      .mockImplementationOnce(() => new Promise<DocxSource>((resolve) => { finishEarlier = resolve; }))
      .mockImplementationOnce(() => new Promise<DocxSource>((resolve) => { finishCurrent = resolve; }));
    render(<StrictMode><QueryClientProvider client={new QueryClient()}>
      <DocxWorkspaceDialog appProjectId="app-project" project={PROJECT} world={WORLD} onClose={vi.fn()} onSaved={vi.fn()} />
    </QueryClientProvider></StrictMode>);
    expect(mocks.loadSource).toHaveBeenCalledTimes(2);
    const current = { ...SOURCE, bytes: Uint8Array.from(SOURCE.bytes) };
    await act(async () => finishCurrent(current));
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    act(() => harness.edit("first", "Unsaved edit"));
    await act(async () => finishEarlier({ ...SOURCE, bytes: Uint8Array.from([80, 75, 1, 2]) }));
    expect(mocks.editorDocument).toBe(current.bytes);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(harness.session.dispose).not.toHaveBeenCalled();
    expect(harness.text("first")).toBe("Unsaved edit");
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
    await chooseMaterialView(enEditor.materials.docxOriginal);
    expect(mocks.editorMounts.at(-1)).toMatchObject({ document: current.bytes, mode: "view" });
  });

  const recovery: DocxRecoverySnapshot = {
    appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
    baseBaselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256,
    recoveryKey: "b".repeat(64), contentSha256: "c".repeat(64),
    revision: 9, updatedAt: "2026-11-12T02:00:00.000Z", bytes: Uint8Array.from([80, 75, 9, 9]),
  };

  it("honors a tab close requested before the Word surface has mounted", async () => {
    useDocxWorkspaceStore.getState().open({ appProjectId: "app-project", project: PROJECT, world: WORLD, onSaved: vi.fn() });
    useDocxWorkspaceStore.getState().requestClose();
    render(<QueryClientProvider client={new QueryClient()}><DocxWorkspaceHost /></QueryClientProvider>);
    await waitFor(() => expect(useDocxWorkspaceStore.getState().request).toBeNull());
    expect(screen.queryByTestId("docx-workspace")).not.toBeInTheDocument();
  });

  it("routes a normal open with existing unsaved work to recovery before loading the editor", async () => {
    mocks.listRecovery.mockResolvedValue({ snapshots: [recovery], failures: [] });
    useDocxWorkspaceStore.getState().open({ appProjectId: "app-project", project: PROJECT, world: WORLD, onSaved: vi.fn() });
    render(<DocxWorkspaceHost />);
    await waitFor(() => expect(useDocxWorkspaceStore.getState().recoveryOpen).toBe(true));
    expect(useDocxWorkspaceStore.getState().request).toBeNull();
    expect(mocks.loadSource).not.toHaveBeenCalled();
  });

  it.each([null, WORLD])("refreshes a minimized workspace's world from %j without replacing its dirty session", async (initialWorld) => {
    const harness = sessionHarness([paragraph("first", "Original text")]);
    mocks.createSession.mockReturnValue(harness.session);
    mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
    const previousSaved = vi.fn(async () => {});
    const nextSaved = vi.fn(async () => {});
    const otherSaved = vi.fn(async () => {});
    const request = { appProjectId: "app-project", project: PROJECT, world: initialWorld, onSaved: previousSaved };
    useDocxWorkspaceStore.getState().open(request);
    render(<QueryClientProvider client={new QueryClient()}><DocxWorkspaceHost /></QueryClientProvider>);
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    const editorNode = screen.getByTestId("mock-docx-editor");
    const document = mocks.editorDocument;
    const sessionId = mocks.registerAgentSession.mock.calls[0][0].sessionId;
    const unregisterCount = mocks.unregisterAgentSession.mock.calls.length;
    act(() => harness.edit("first", "Unsaved text"));
    act(() => useWorkspaceSurfaceStore.getState().openJournal());
    expect(useWorkspaceSurfaceStore.getState().active).toBe("journal");
    const nextWorld = { ...WORLD, version_id: "world-next", journal_name: "Next journal" };
    act(() => useDocxWorkspaceStore.getState().open({ ...request, world: nextWorld, onSaved: nextSaved }));
    expect(useDocxWorkspaceStore.getState().context?.world?.version_id).toBe("world-next");
    expect(useDocxWorkspaceStore.getState().request).toBe(request);
    expect(screen.getByTestId("mock-docx-editor")).toBe(editorNode);
    expect(mocks.editorDocument).toBe(document);
    expect(mocks.editorMounted).toHaveBeenCalledOnce();
    expect(mocks.editorUnmounted).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(harness.session.dispose).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentSession).toHaveBeenCalledTimes(unregisterCount);
    expect(mocks.loadSource).toHaveBeenCalledOnce();
    expect(mocks.listRecovery).toHaveBeenCalledOnce();
    expect(harness.text("first")).toBe("Unsaved text");
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
    act(() => useDocxWorkspaceStore.getState().open({ ...request, project: { ...PROJECT, project_id: "other-document" }, world: null, onSaved: otherSaved }));
    expect(useDocxWorkspaceStore.getState().context?.world?.version_id).toBe("world-next");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(nextSaved).toHaveBeenCalledOnce());
    expect(previousSaved).not.toHaveBeenCalled();
    expect(otherSaved).not.toHaveBeenCalled();
    expect(mocks.updateAgentSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({ savedRevision: 1 }));
  });

  it("uses the latest onSaved context when a save finishes after the world changes", async () => {
    const harness = sessionHarness([paragraph("first", "Original text")]);
    mocks.createSession.mockReturnValue(harness.session);
    let finishSave!: (result: { baselineId: string; revision: number; sourceSha256: string }) => void;
    mocks.commitRecovery.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const previousSaved = vi.fn(async () => {});
    const nextSaved = vi.fn(async () => {});
    const request = { appProjectId: "app-project", project: PROJECT, world: WORLD, onSaved: previousSaved };
    useDocxWorkspaceStore.getState().open(request);
    render(<QueryClientProvider client={new QueryClient()}><DocxWorkspaceHost /></QueryClientProvider>);
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    act(() => harness.edit("first", "Pending save"));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(mocks.commitRecovery).toHaveBeenCalledOnce());
    act(() => useDocxWorkspaceStore.getState().open({ ...request, world: null, onSaved: nextSaved }));
    await act(async () => finishSave({ baselineId: SAVED_BASELINE, revision: 1, sourceSha256: "d".repeat(64) }));
    await waitFor(() => expect(nextSaved).toHaveBeenCalledOnce());
    expect(previousSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("docx-font-world")).not.toBeInTheDocument();
    expect(mocks.editorMounted).toHaveBeenCalledOnce();
    expect(mocks.editorUnmounted).not.toHaveBeenCalled();
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

  it("lazily mounts the exact opening version as read-only without remounting the working editor", async () => {
    const harness = sessionHarness([paragraph("first", "Unsaved working text")]);
    await renderReady(harness);
    const workingEditor = screen.getByTestId("mock-docx-editor");
    act(() => harness.edit("first", "Unsaved working text"));

    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const display = screen.getByRole("combobox", { name: enEditor.materials.viewMode });
    Object.assign(display, {
      hasPointerCapture: () => false,
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(display, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: enEditor.materials.docxOriginal }));

    await waitFor(() => expect(mocks.editorMounts).toHaveLength(2));
    expect(mocks.editorMounts[0]).toMatchObject({ document: SOURCE.bytes, mode: "edit", colorMode: "system" });
    expect(mocks.editorMounts[1]).toMatchObject({ document: SOURCE.bytes, mode: "view", colorMode: "system" });
    expect(screen.getByTestId("docx-editor-surface")).not.toBeVisible();
    expect(screen.getByTestId("docx-original-surface")).toBeVisible();
    expect(screen.getByTestId("docx-editor-surface").querySelector('[data-testid="mock-docx-editor"]')).toBe(workingEditor);
    expect(mocks.editorUnmounted).not.toHaveBeenCalled();
    expect(mocks.registerAgentSession).toHaveBeenCalledOnce();
    expect(harness.text("first")).toBe("Unsaved working text");

    fireEvent.pointerDown(display, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: enEditor.materials.docxCompare }));
    expect(screen.getByTestId("word-surface")).toHaveAttribute("data-view", "compare");
    expect(screen.getByTestId("docx-editor-surface").closest('[data-word-surface-layer="current"]')).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: enEditor.materials.docxWorking }));
    expect(screen.getByTestId("docx-editor-surface").closest('[data-word-surface-layer="current"]')).not.toHaveAttribute("inert");
    expect(screen.getByTestId("docx-original-surface").closest('[data-word-surface-layer="previous"]')).toHaveAttribute("inert");
    expect(screen.getByTestId("docx-editor-surface").querySelector('[data-testid="mock-docx-editor"]')).toBe(workingEditor);
    fireEvent.click(screen.getByRole("button", { name: enEditor.materials.docxOriginal }));
    expect(screen.getByTestId("docx-workspace")).toHaveAttribute("data-docx-history", "readonly");
    fireEvent.click(screen.getByRole("button", { name: enEditor.materials.docxWorking }));
    expect(screen.getByTestId("docx-workspace")).toHaveAttribute("data-docx-history", "working");
    expect(mocks.editorMounts).toHaveLength(2);
    expect(mocks.editorUnmounted).not.toHaveBeenCalled();
  });

  it("asks the user to retry instead of retaining an annotation copy from a changed revision", async () => {
    const harness = sessionHarness([paragraph("first", "Selected text")]);
    let finishExport!: (bytes: ArrayBuffer) => void;
    mocks.editorSave.mockReturnValueOnce(new Promise((resolve) => { finishExport = resolve; }));
    await renderReady(harness);
    mocks.editor.editorSnapshot = {
      ...mocks.editor.editorSnapshot,
      selection: { from: { paraId: "para-first" }, to: { paraId: "para-first" } },
      selectionCollapsed: false,
    };
    mocks.editor.query.mockReturnValue("Selected text");
    act(() => mocks.editorListeners.get("selectionChange")?.(mocks.editor.editorSnapshot));

    fireEvent.click(screen.getByRole("button", { name: enEditor.materials.annotateSelection }));
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledOnce());
    act(() => harness.edit("first", "Changed while exporting"));
    await act(async () => { finishExport(new Uint8Array([80, 75, 3, 4]).buffer); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(enEditor.materials.captureChanged));
    expect(useMaterialAnnotationsStore.getState().document).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: enEditor.materials.annotateSelection }));
    await waitFor(() => expect(useMaterialAnnotationsStore.getState().document?.title).toBe(SOURCE.filename));
    expect(useMaterialAnnotationsStore.getState().anchor).toEqual({
      kind: "object", id: "para-first", label: "Selected text",
    });
    expect(mocks.editorSave).toHaveBeenCalledTimes(2);
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
    mocks.editor.editorSnapshot = {
      isLoading: true,
      isOpening: true,
      parseError: null,
      page: { current: 0, total: 0 },
      selection: null,
      selectionCollapsed: true,
    };
    const view = await renderReady(harness, vi.fn(async () => {}), false);

    expect(mocks.createSession).not.toHaveBeenCalled();
    mocks.editor.editorSnapshot = {
      isLoading: false,
      isOpening: false,
      parseError: null,
      page: { current: 1, total: 1 },
      selection: null,
      selectionCollapsed: true,
    };
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

  it("cancels an in-flight Agent save and retries from a fresh export", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let finishExport!: (bytes: ArrayBuffer) => void;
    mocks.editorSave.mockReturnValueOnce(new Promise((resolve) => { finishExport = resolve; }));
    mocks.commitRecovery.mockResolvedValueOnce({
      baselineId: SAVED_BASELINE,
      revision: 1,
      sourceSha256: "d".repeat(64),
    });
    const view = await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.edit("first", "Save after cancelling"));

    const controller = new AbortController();
    let cancelled!: Promise<DocxSaveResult>;
    act(() => {
      cancelled = registration.save({ expectedRevision: 1, signal: controller.signal });
    });
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledOnce());
    controller.abort();
    await act(async () => {
      finishExport(Uint8Array.from([80, 75, 1, 2]).buffer);
      await expect(cancelled).rejects.toThrow("cancelled before the fixed save");
    });
    expect(mocks.prepareSave).not.toHaveBeenCalled();
    expect(mocks.commitRecovery).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);

    let saved!: DocxSaveResult;
    await act(async () => {
      saved = await registration.save({ expectedRevision: 1 });
    });
    expect(saved).toMatchObject({
      baselineId: SAVED_BASELINE,
      revision: 1,
      document: { sessionRevision: 1, savedRevision: 1, dirty: false },
    });
    expect(mocks.editorSave).toHaveBeenCalledTimes(2);
    expect(mocks.prepareSave).toHaveBeenCalledOnce();
    expect(mocks.commitRecovery).toHaveBeenCalledOnce();
    expect(view.onSaved).toHaveBeenCalledOnce();
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved);
  });

  it("rejects a stale Agent save revision without exporting, then saves the current revision", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.commitRecovery.mockResolvedValueOnce({
      baselineId: SAVED_BASELINE,
      revision: 1,
      sourceSha256: "d".repeat(64),
    });
    await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.setRevision(1));

    await act(async () => {
      await expect(registration.save({ expectedRevision: 0 })).rejects.toThrow(
        "session changed before saving",
      );
    });
    expect(mocks.editorSave).not.toHaveBeenCalled();
    expect(mocks.saveRecovery).not.toHaveBeenCalled();
    expect(mocks.commitRecovery).not.toHaveBeenCalled();

    let saved!: DocxSaveResult;
    await act(async () => {
      saved = await registration.save({ expectedRevision: 1 });
    });
    expect(saved).toMatchObject({
      baselineId: SAVED_BASELINE,
      revision: 1,
      document: { sessionRevision: 1, savedRevision: 1, dirty: false },
    });
    expect(mocks.editorSave).toHaveBeenCalledOnce();
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved);
  });

  it("blocks both visible and host-requested close while an Agent save is exporting", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let finishExport!: (value: ArrayBuffer) => void;
    mocks.editorSave.mockImplementationOnce(
      () => new Promise((resolve) => { finishExport = resolve; }),
    );
    mocks.commitRecovery.mockResolvedValueOnce({
      baselineId: SAVED_BASELINE,
      revision: 1,
      sourceSha256: "d".repeat(64),
    });
    const view = await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.edit("first", "Save before closing"));

    let save!: Promise<DocxSaveResult>;
    act(() => {
      save = registration.save({ expectedRevision: 1 });
    });
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledOnce());
    const close = screen.getByRole("button", { name: en.workspace.closeDocument });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    act(() => useDocxWorkspaceStore.getState().requestClose());
    expect(view.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () => {
      finishExport(Uint8Array.from([80, 75, 1, 2]).buffer);
      await save;
    });
    await waitFor(() => expect(close).toBeEnabled());
    expect(useDocxWorkspaceStore.getState().closingBlocked).toBe(false);
    fireEvent.click(close);
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it("keeps navigation available at the saving revision without changing the frozen export", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let finishExport!: (value: ArrayBuffer) => void;
    mocks.editorSave.mockImplementationOnce(
      () => new Promise((resolve) => { finishExport = resolve; }),
    );
    mocks.commitRecovery.mockResolvedValueOnce({
      baselineId: SAVED_BASELINE,
      revision: 1,
      sourceSha256: "d".repeat(64),
    });
    await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.edit("first", "Navigate while saving"));
    let save!: Promise<DocxSaveResult>;
    act(() => {
      save = registration.save({ expectedRevision: 1 });
    });
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledOnce());

    let frame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    try {
      let navigation!: Promise<void>;
      act(() => {
        navigation = registration.reveal({
          paragraphRef: "first",
          expectedRevision: 1,
        });
      });
      expect(mocks.editor.scrollToAnchor).not.toHaveBeenCalled();
      await act(async () => {
        frame?.(0);
        await navigation;
      });
      expect(mocks.editor.scrollToAnchor).toHaveBeenCalledWith({
        paraId: "para-first",
      });
      expect(mocks.editor.highlightAnchor).toHaveBeenCalledWith({
        paraId: "para-first",
      });
      expect(mocks.prepareSave).not.toHaveBeenCalled();
      expect(mocks.commitRecovery).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
    }

    await act(async () => {
      finishExport(Uint8Array.from([80, 75, 3, 4]).buffer);
      await save;
    });
    expect(mocks.commitRecovery).toHaveBeenCalledOnce();
    expect(
      mocks.prepareSave.mock.calls[0]?.[1],
    ).toBe(1);
  });

  it("rejects an Agent save while a saved-version check owns the working copy", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    let finishState!: (state: JournalState) => void;
    const checked = {
      baseline_id: INITIAL_BASELINE,
      world_version_id: WORLD_VERSION,
      validity: "CURRENT",
    } satisfies Partial<JournalCheck>;
    mocks.journalRequest.mockImplementation((path: string) => {
      if (path === "/api/state") {
        return new Promise<JournalState>((resolve) => { finishState = resolve; });
      }
      if (path === "/api/check") return Promise.resolve(checked);
      throw new Error(`Unexpected request ${path}`);
    });
    await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    fireEvent.click(screen.getByRole("button", { name: text.check }));
    await waitFor(() =>
      expect(useDocxWorkspaceStore.getState().closingBlocked).toBe(true),
    );

    await act(async () => {
      await expect(registration.save({ expectedRevision: 0 })).rejects.toThrow(
        "another document operation is pending",
      );
    });
    expect(mocks.editorSave).not.toHaveBeenCalled();
    expect(mocks.saveRecovery).not.toHaveBeenCalled();
    expect(mocks.commitRecovery).not.toHaveBeenCalled();

    await act(async () => {
      finishState({
        worlds: [],
        projects: [{
          ...PROJECT,
          binding: {
            binding_id: "binding-current",
            baseline_id: INITIAL_BASELINE,
            world_version_id: WORLD_VERSION,
          },
        }],
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("docx-check-validity")).toHaveTextContent(
        en.journal.current,
      ),
    );
    expect(useDocxWorkspaceStore.getState().closingBlocked).toBe(false);
  });

  it("refuses an Agent check while dirty, then checks the newly saved baseline", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    const checked = {
      baseline_id: SAVED_BASELINE,
      world_version_id: WORLD_VERSION,
      validity: "CURRENT",
    } satisfies Partial<JournalCheck>;
    mocks.commitRecovery.mockResolvedValueOnce({
      baselineId: SAVED_BASELINE,
      revision: 1,
      sourceSha256: "d".repeat(64),
    });
    mocks.journalRequest.mockResolvedValue({
      worlds: [],
      projects: [{ ...PROJECT, baseline_id: SAVED_BASELINE }],
    });
    mocks.templateCheck.mockResolvedValue(checked);
    const view = await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.edit("first", "Check after saving"));

    await act(async () => {
      await expect(
        registration.check({ template: WORLD_VERSION }),
      ).rejects.toThrow("Save the current DOCX working copy");
    });
    expect(mocks.journalRequest).not.toHaveBeenCalled();
    expect(mocks.templateCheck).not.toHaveBeenCalled();

    await act(async () => {
      await registration.save({ expectedRevision: 1 });
    });
    let result: unknown;
    await act(async () => {
      result = await registration.check({ template: WORLD_VERSION });
    });

    expect(result).toEqual({ template: WORLD_VERSION, check: checked });
    expect(mocks.journalRequest).toHaveBeenCalledExactlyOnceWith("/api/state");
    expect(mocks.templateCheck).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ baseline_id: SAVED_BASELINE }),
      WORLD_VERSION,
      "agent",
    );
    expect(view.onSaved).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("docx-check-validity")).toHaveTextContent(
      en.journal.current,
    );
  });

  it("refuses an Agent check when the server has advanced past the open baseline", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.journalRequest.mockResolvedValue({
      worlds: [],
      projects: [{ ...PROJECT, baseline_id: SAVED_BASELINE }],
    });
    const view = await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];

    await act(async () => {
      await expect(
        registration.check({ template: WORLD_VERSION }),
      ).rejects.toThrow(text.newBaseline);
    });

    expect(mocks.templateCheck).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("docx-check-validity")).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved));
    expect(screen.queryByTestId("docx-version-details")).not.toBeInTheDocument();

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
    await waitFor(() => expect(useDocxWorkspaceStore.getState().closingBlocked).toBe(true));
    await waitFor(() => expect(mocks.journalRequest).toHaveBeenCalled());
    act(() => harness.edit("first", "Typing during the saved-version check"));
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    await act(async () => finish({ worlds: [], projects: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: text.save })).toBeEnabled());
    expect(useDocxWorkspaceStore.getState().closingBlocked).toBe(false);
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

  it("allows another workspace to navigate without prompting or closing this document", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    const { onClose } = await renderReady(harness);
    act(() => harness.edit("first", "Unsaved text"));

    let allowed = false;
    await act(async () => {
      allowed = await projectLeaveAllowed({
        projectId: "other-app-project",
        reason: "switch",
        targetProjectId: "other-document",
      });
    });
    expect(allowed).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
    expect(harness.text("first")).toBe("Unsaved text");
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

  it("keeps unsaved work open when recovery changes during discard and retries", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.readRecovery.mockResolvedValue(recovery);
    mocks.clearRecovery.mockResolvedValueOnce(false);
    const { onClose } = await renderReady(harness);
    act(() => harness.edit("first", "Unsaved text retained after discard failure"));
    await act(async () => {
      expect(await projectLeaveAllowed({
        projectId: "app-project",
        reason: "close",
        targetProjectId: null,
      })).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: text.discard }));
    await waitFor(() => expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent(
      "DOCX recovery snapshot changed before it could be discarded.",
    ));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
    expect(mocks.clearRecovery).toHaveBeenCalledWith({
      appProjectId: "app-project",
      workbenchProjectId: PROJECT.project_id,
      baseBaselineId: INITIAL_BASELINE,
      sourceSha256: SOURCE.source_sha256,
    }, recovery.bytes);
    expect(mocks.discardRecovery).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: text.discard })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: text.discard }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mocks.readRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.clearRecovery).toHaveBeenCalledTimes(2);
    expect(harness.text("first")).toBe("Unsaved text retained after discard failure");
  });

  it("blocks discard while an Agent save exports from an already-open close prompt", async () => {
    const harness = sessionHarness([paragraph("first", "Original")]);
    let finishExport!: (value: ArrayBuffer) => void;
    mocks.editorSave.mockImplementationOnce(() => new Promise((resolve) => { finishExport = resolve; }));
    mocks.commitRecovery.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1, sourceSha256: "d".repeat(64) });
    const { onClose } = await renderReady(harness);
    const registration = () => mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.edit("first", "Unsaved export race text"));
    await act(async () => { await projectLeaveAllowed({ projectId: "app-project", reason: "close", targetProjectId: null }); });
    let save!: Promise<DocxSaveResult>;
    await act(async () => {
      save = registration().save({ expectedRevision: 1 });
    });
    await waitFor(() => expect(mocks.editorSave).toHaveBeenCalledOnce());
    const discard = screen.getByRole("button", { name: text.discard });
    expect(discard).toBeDisabled();
    fireEvent.click(discard);
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.clearRecovery).not.toHaveBeenCalled();
    expect(mocks.commitRecovery).not.toHaveBeenCalled();
    await act(async () => {
      finishExport(new Uint8Array([80, 75, 1, 2]).buffer);
      await save;
    });
    expect(mocks.commitRecovery).toHaveBeenCalledOnce();
    expect(mocks.discardRecovery).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("freezes the task save operation before commit and retains it for a manual retry", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.commitRecovery.mockRejectedValueOnce(new Error("commit reply lost"))
      .mockResolvedValueOnce({ baselineId: SAVED_BASELINE, revision: 1, sourceSha256: "d".repeat(64) });
    await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    act(() => harness.edit("first", "Updated paragraph"));
    const operation: DocxRecoverySaveOperation = { operationId: "task-save-operation", document: {
      sessionId: registration.sessionId, appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
      baselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256, sessionRevision: 1, savedRevision: 0,
    } };

    await act(async () => {
      await expect(registration.save({ expectedRevision: 1, operation })).rejects.toThrow("commit reply lost");
    });
    expect(mocks.saveRecovery).toHaveBeenCalledOnce();
    expect(mocks.saveRecovery.mock.calls[0]?.[3]).toMatchObject({ pendingSave: { operation } });
    expect(mocks.saveRecovery.mock.invocationCallOrder[0]).toBeLessThan(mocks.commitRecovery.mock.invocationCallOrder[0]);
    fireEvent.click(screen.getByRole("button", { name: text.retrySave }));
    await waitFor(() => expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved));
    expect(mocks.editorSave).toHaveBeenCalledOnce();
    expect(mocks.prepareSave).toHaveBeenCalledOnce();
    expect(mocks.saveRecovery).toHaveBeenCalledOnce();
    expect(mocks.commitRecovery.mock.calls[1]?.[0]).toEqual(mocks.commitRecovery.mock.calls[0]?.[0]);
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
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved);
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(screen.queryByRole("button", { name: text.retrySave })).not.toBeInTheDocument();
  });

  it("reviews a suggestion from the existing Agent without a second prompt form", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    await renderReady(harness);
    expect(screen.queryByRole("textbox", { name: text.instruction })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.generate })).not.toBeInTheDocument();
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    const target = harness.session.captureTarget(harness.session.listParagraphs()[0].handle);
    const controller = new AbortController();
    act(() => registration.onSuggestion({ target, proposed: "Partial suggestion", phase: "streaming", controller }));
    expect(screen.getByTestId("docx-proposed")).toHaveTextContent("Partial suggestion");
    expect(harness.text("first")).toBe("Original paragraph");
    act(() => registration.onSuggestion({ target, proposed: "Suggested replacement", phase: "reviewing", controller }));
    expect(screen.getByRole("button", { name: text.accept })).toBeVisible();
    expect(mocks.applySuggestion).not.toHaveBeenCalled();
  });

  it("withdraws the existing Agent's suggestion when its paragraph changes", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph"), paragraph("second", "Other paragraph")]);
    await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    const target = harness.session.captureTarget(harness.session.listParagraphs()[0].handle);
    const controller = new AbortController();
    act(() => registration.onSuggestion({ target, proposed: "Suggested replacement", phase: "streaming", controller }));
    act(() => harness.edit("second", "Changed other paragraph"));
    expect(controller.signal.aborted).toBe(false);
    act(() => harness.edit("first", "Changed target paragraph"));
    expect(controller.signal.aborted).toBe(true);
    expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.withdrawn);
    expect(screen.queryByRole("button", { name: text.accept })).not.toBeInTheDocument();
  });

  it("withdraws an applied Agent suggestion after undo restores the original text", async () => {
    const harness = sessionHarness([paragraph("first", "Original paragraph")]);
    mocks.applySuggestion.mockImplementation(() => {
      harness.edit("first", "Suggested replacement");
      return { ok: true, revision: harness.revision(), changed: true };
    });
    await renderReady(harness);
    const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
    const target = harness.session.captureTarget(harness.session.listParagraphs()[0].handle);
    act(() => registration.onSuggestion({ target, proposed: "Suggested replacement", phase: "reviewing", controller: new AbortController() }));
    fireEvent.click(screen.getByRole("button", { name: text.accept }));
    expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.applied);
    act(() => harness.edit("first", "Original paragraph"));
    expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.withdrawn);
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
    expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
    await act(async () => finishExport(Uint8Array.from([80, 75, 7, 8]).buffer));
    await screen.findByRole("alert");

    expect(mocks.prepareSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareSave.mock.calls[0]?.[1]).toBe(5);
    fireEvent.click(await screen.findByRole("button", { name: text.retrySave }));
    await waitFor(() =>
      expect(mocks.updateAgentSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ savedRevision: 5 })),
    );

    expect(mocks.editorSave).toHaveBeenCalledTimes(1);
    expect(mocks.prepareSave).toHaveBeenCalledTimes(1);
    expect(mocks.saveBaseline).toHaveBeenCalledTimes(2);
    expect(mocks.saveBaseline.mock.calls[0]?.[0]).toBe(mocks.saveBaseline.mock.calls[1]?.[0]);
    expect(mocks.clearRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ baselineId: SAVED_BASELINE }));
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
      expect(mocks.updateAgentSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ baselineId: SAVED_BASELINE })),
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

it("withdraws accepted task work before discarding and closing the working copy", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const { onClose } = await renderReady(harness);
  applyTask(harness);
  await waitFor(() => expect(mocks.settleActivity).toHaveBeenCalledOnce());

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: text.discard }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.settleActivity.mock.calls.map((call) => call[4].kind)).toEqual([
    "applied",
    "withdrawn",
  ]);
  expect(mocks.applySuggestion).toHaveBeenCalledOnce();
  expect(harness.text("first")).toBe("Task candidate");
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

it("retires acknowledged save and check checkpoints before the next task edit", async () => {
  mocks.saveRecovery.mockImplementation(async (identity, revision, _bytes, taskState) => ({
    ...identity, revision, taskState, recoveryKey: "b".repeat(64),
    contentSha256: "c".repeat(64), updatedAt: "2026-11-14T00:00:00Z",
  }));
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const registration = () => mocks.registerAgentSession.mock.calls.at(-1)?.[0];
  act(() => harness.edit("first", "First edit"));
  mocks.saveBaseline.mockResolvedValueOnce({ baselineId: SAVED_BASELINE, revision: 1 });
  let saved!: DocxSaveResult;
  await act(async () => { saved = await registration().save({ expectedRevision: 1 }); });
  const document = {
    sessionId: registration().sessionId, appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
    baselineId: saved.baselineId, sourceSha256: saved.sourceSha256, sessionRevision: 1, savedRevision: 1,
  };
  await act(async () => registration().onTaskOperation({
    operationId: "first-save", document, result: { operation: "save", ok: true, document, result: saved },
  }));
  expect(mocks.discardRecovery).not.toHaveBeenCalled();
  await act(async () => registration().onTaskOperationRecorded("first-save"));
  expect(mocks.discardRecovery).toHaveBeenCalledOnce();
  await act(async () => registration().onTaskOperation({
    operationId: "first-check", document,
    result: { operation: "check", ok: true, document, result: { template: WORLD_VERSION, check: { check_id: "first-check" } } },
  }));
  await act(async () => registration().onTaskOperationRecorded("first-check"));
  expect(mocks.discardRecovery).toHaveBeenCalledTimes(2);
  act(() => harness.edit("first", "Second edit"));
  const edited = { ...document, sessionRevision: 2 };
  await act(async () => registration().onTaskOperation({
    operationId: "second-format", document: edited,
    result: { operation: "format", ok: true, document: edited, result: { ok: true, changed: true, revision: 2 } },
  }));
  expect(mocks.saveRecovery.mock.calls.at(-1)?.[3].operations.map((operation: { operationId: string }) => operation.operationId))
    .toEqual(["second-format"]);
  act(() => harness.edit("first", "Third edit"));
  const rangeEdited = { ...document, sessionRevision: 3 };
  await act(async () => registration().onTaskOperation({
    operationId: "third-range", document: rangeEdited,
    result: {
      operation: "replace_range", ok: true, document: rangeEdited,
      result: { ok: true, changed: true, revision: 3 },
    },
  }));
  expect(mocks.saveRecovery.mock.calls.at(-1)?.[3].operations.map(
    (operation: { operationId: string }) => operation.operationId,
  )).toEqual(["second-format", "third-range"]);
});

it.each([false, true])("cleans a native-recorded format result with no changed bytes (ok=%s)", async (ok) => {
  mocks.saveRecovery.mockImplementation(async (identity, revision, _bytes, taskState) => ({
    ...identity, revision, taskState, recoveryKey: "b".repeat(64),
    contentSha256: "c".repeat(64), updatedAt: "2026-11-14T00:00:00Z",
  }));
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  const registration = mocks.registerAgentSession.mock.calls.at(-1)?.[0];
  const document = {
    sessionId: registration.sessionId, appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
    baselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256, sessionRevision: 0, savedRevision: 0,
  };
  await act(async () => registration.onTaskOperation({ operationId: "no-change", document,
    result: { operation: "format", ok, document, result: { ok, changed: false, revision: 0 } },
  }));
  expect(mocks.discardRecovery).not.toHaveBeenCalled();
  await act(async () => registration.onTaskOperationRecorded("no-change"));
  expect(mocks.discardRecovery).toHaveBeenCalledOnce();
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

it("shows a recovery-list failure in the host and lets the user close without opening the editor", async () => {
  mocks.listRecovery.mockRejectedValueOnce(new Error("Recovery storage is unavailable"));
  useDocxWorkspaceStore.getState().open({ appProjectId: "app-project", project: PROJECT, world: WORLD, onSaved: vi.fn() });
  render(<DocxWorkspaceHost />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Recovery storage is unavailable");
  expect(mocks.loadSource).not.toHaveBeenCalled();
  expect(mocks.createSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: en.workspace.closeDocument }));
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("annotates the opening version's exact bytes after saving a newer working baseline", async () => {
  const harness = sessionHarness([paragraph("first", "Original text")]);
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
  await renderReady(harness);
  act(() => harness.edit("first", "New working text"));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  await waitFor(() => expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved));
  await chooseMaterialView(enEditor.materials.docxOriginal);
  const exportsBefore = mocks.editorSave.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: enEditor.materials.annotateWhole }));
  await waitFor(() => expect(useMaterialAnnotationsStore.getState().document).not.toBeNull());
  const annotated = useMaterialAnnotationsStore.getState();
  expect(annotated.document).toMatchObject({ projectId: "app-project", documentId: `docx:${PROJECT.project_id}`, title: SOURCE.filename, kind: "docx" });
  expect(annotated.document?.source).toMatchObject({ bytes: SOURCE.bytes });
  expect(annotated.anchor).toEqual({ kind: "whole" });
  expect(annotated.options.beforeStartTask).toBeUndefined();
  expect(mocks.editorSave).toHaveBeenCalledTimes(exportsBefore);
  expect(mocks.bindTask).not.toHaveBeenCalled();
});

it("binds a working-material request to the captured revision and rejects the binding after another edit", async () => {
  const harness = sessionHarness([paragraph("first", "Selected text")]);
  await renderReady(harness);
  mocks.editor.editorSnapshot = { ...mocks.editor.editorSnapshot,
    selection: { from: { paraId: "para-first" }, to: { paraId: "para-first" } }, selectionCollapsed: false };
  mocks.editor.query.mockReturnValue("Selected text");
  act(() => mocks.editorListeners.get("selectionChange")?.(mocks.editor.editorSnapshot));
  fireEvent.click(screen.getByRole("button", { name: enEditor.materials.annotateSelection }));
  await waitFor(() => expect(useMaterialAnnotationsStore.getState().options.beforeStartTask).toBeTypeOf("function"));
  const annotations = useMaterialAnnotationsStore.getState();
  expect(annotations.anchor).toEqual({ kind: "object", id: "para-first", label: "Selected text" });
  expect(annotations.document?.source).toMatchObject({ bytes: new Uint8Array([80, 75, 5, 6]) });
  expect(mocks.bindTask).not.toHaveBeenCalled();
  const bind = annotations.options.beforeStartTask;
  if (!bind) throw new Error("Working material did not expose its task binding");
  await bind("task-annotation");
  const sessionId = mocks.registerAgentSession.mock.calls[0][0].sessionId;
  expect(mocks.bindTask).toHaveBeenCalledWith("app-project", "task-annotation", sessionId, 0, {
    sessionId, appProjectId: "app-project", workbenchProjectId: PROJECT.project_id,
    baselineId: INITIAL_BASELINE, sourceSha256: SOURCE.source_sha256, sessionRevision: 0, savedRevision: 0,
  });
  act(() => harness.edit("first", "Changed after capture"));
  await expect(bind("later-task")).rejects.toThrow(enEditor.materials.captureChanged);
  expect(mocks.bindTask).toHaveBeenCalledOnce();
});

it("reports an unready annotation export and allows capturing the material again", async () => {
  await renderReady(sessionHarness([paragraph("first", "Original")]));
  mocks.editorSave.mockResolvedValueOnce(null);
  const annotate = screen.getByRole("button", { name: enEditor.materials.annotateWhole });
  fireEvent.click(annotate);
  expect(await screen.findByRole("alert")).toHaveTextContent(text.notReady);
  expect(useMaterialAnnotationsStore.getState().document).toBeNull();
  await waitFor(() => expect(annotate).toBeEnabled());
  fireEvent.click(annotate);
  await waitFor(() => expect(useMaterialAnnotationsStore.getState().document).not.toBeNull());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.editorSave).toHaveBeenCalledTimes(2);
});

it("keeps the working copy dirty when a download export is unready and permits a later download", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  act(() => harness.edit("first", "Unsaved download"));
  mocks.editorSave.mockResolvedValueOnce(null);
  const download = screen.getByRole("button", { name: text.download });
  fireEvent.click(download);
  expect(await screen.findByRole("alert")).toHaveTextContent(text.notReady);
  expect(mocks.downloadCopy).not.toHaveBeenCalled();
  fireEvent.click(download);
  await waitFor(() => expect(mocks.downloadCopy).toHaveBeenCalledWith(new Uint8Array([80, 75, 5, 6]), SOURCE.filename));
  expect(mocks.saveBaseline).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  expect(harness.text("first")).toBe("Unsaved download");
});

it("clears a failed download and retries without saving the working copy", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  act(() => harness.edit("first", "Unsaved download retry"));
  mocks.downloadCopy.mockRejectedValueOnce(new Error("disk unavailable"));
  const download = screen.getByRole("button", { name: text.download });

  fireEvent.click(download);
  expect(await screen.findByRole("alert")).toHaveTextContent("Error: disk unavailable");
  expect(mocks.downloadCopy).toHaveBeenCalledExactlyOnceWith(
    new Uint8Array([80, 75, 5, 6]),
    SOURCE.filename,
  );
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);

  fireEvent.click(download);
  await waitFor(() => expect(mocks.downloadCopy).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(mocks.downloadCopy.mock.calls[1]).toEqual(mocks.downloadCopy.mock.calls[0]);
  expect(mocks.saveBaseline).not.toHaveBeenCalled();
  expect(mocks.commitRecovery).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  expect(harness.text("first")).toBe("Unsaved download retry");
});

it("keeps a committed document saved when recovery cleanup fails and does not offer another baseline commit", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
  mocks.clearRecovery.mockResolvedValueOnce(false);
  const view = await renderReady(harness);
  act(() => harness.edit("first", "Saved text"));
  fireEvent.click(screen.getByRole("button", { name: text.save }));
  expect(await screen.findByRole("alert")).toHaveTextContent(text.recovery.clearFailed);
  await waitFor(() => expect(view.onSaved).toHaveBeenCalledOnce());
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved);
  expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
  expect(screen.queryByRole("button", { name: text.retrySave })).not.toBeInTheDocument();
  expect(mocks.commitRecovery).toHaveBeenCalledOnce();
});

const TEMPLATE_WORLD: JournalWorld = { ...WORLD, template: {
  source_id: "template-original", normalized_source_id: "template-normalized", snapshot_source_id: "template-format",
  original_sha256: "1".repeat(64), source_sha256: "2".repeat(64), provenance: null,
} };

it.each([false, true])("reports format derivation after a committed template save, including derivation failure: %s", async (formatFails) => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  mocks.saveBaseline.mockResolvedValue({ baselineId: SAVED_BASELINE, revision: 1 });
  if (formatFails) mocks.retainFormat.mockRejectedValueOnce(new Error("Saved format could not be derived"));
  const view = await renderReady(harness, undefined, true, { world: TEMPLATE_WORLD });
  act(() => harness.edit("first", "Saved template text"));
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  let result: DocxSaveResult | undefined;
  await act(async () => { result = await registration.save({ expectedRevision: 1 }); });
  expect(result).toMatchObject({ baselineId: SAVED_BASELINE, revision: 1, formatStatus: formatFails ? "failed" : "recorded",
    document: { sessionRevision: 1, savedRevision: 1, dirty: false } });
  expect(mocks.retainFormat).toHaveBeenCalledWith(PROJECT.project_id, SAVED_BASELINE);
  if (formatFails) {
    expect(result?.formatError).toContain("Saved format could not be derived");
    expect(screen.getByRole("alert")).toHaveTextContent("Saved format could not be derived");
  } else expect(result).not.toHaveProperty("formatError");
  expect(view.onSaved).toHaveBeenCalledOnce();
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved);
  expect(screen.queryByRole("button", { name: text.retrySave })).not.toBeInTheDocument();
  expect(mocks.commitRecovery).toHaveBeenCalledOnce();
});

it("binds an unbound saved manuscript before a user check and opens the journal result", async () => {
  const checked = { baseline_id: INITIAL_BASELINE, world_version_id: WORLD_VERSION, validity: "CURRENT" } satisfies Partial<JournalCheck>;
  mocks.journalRequest.mockImplementation(async (path: string) => {
    if (path === "/api/state") return { projects: [PROJECT] };
    if (path === "/api/bind") return {};
    if (path === "/api/check") return checked;
    throw new Error(`Unexpected request ${path}`);
  });
  const view = await renderReady(sessionHarness([paragraph("first", "Original")]));
  fireEvent.click(screen.getByRole("button", { name: text.check }));
  await waitFor(() => expect(useWorkspaceSurfaceStore.getState().active).toBe("journal"));
  expect(mocks.journalRequest.mock.calls.map(([path]) => path)).toEqual(["/api/state", "/api/bind", "/api/check"]);
  expect(mocks.journalRequest).toHaveBeenCalledWith("/api/bind", { project_id: PROJECT.project_id, world_version_id: WORLD_VERSION, expected_binding_id: null });
  expect(screen.getByTestId("docx-check-validity")).toHaveTextContent(en.journal.current);
  expect(view.onSaved).toHaveBeenCalledOnce();
  expect(mocks.editorSave).not.toHaveBeenCalled();
});

it("uses the selected template for user checks and the requested template for Agent checks", async () => {
  const result = { baseline_id: INITIAL_BASELINE, world_version_id: WORLD_VERSION, validity: "CURRENT" } satisfies Partial<JournalCheck>;
  mocks.journalRequest.mockResolvedValue({ projects: [PROJECT] });
  mocks.templateCheck.mockResolvedValue(result);
  const view = await renderReady(sessionHarness([paragraph("first", "Original")]), undefined, true, { world: TEMPLATE_WORLD });
  fireEvent.click(screen.getByRole("button", { name: text.check }));
  await waitFor(() => expect(view.onSaved).toHaveBeenCalledOnce());
  expect(mocks.templateCheck).toHaveBeenCalledWith(PROJECT, WORLD_VERSION);
  expect(useWorkspaceSurfaceStore.getState().active).toBe("journal");
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  let agentResult: unknown;
  await act(async () => { agentResult = await registration.check({ template: "template-requested-by-agent" }); });
  expect(mocks.templateCheck).toHaveBeenCalledWith(PROJECT, "template-requested-by-agent", "agent");
  expect(agentResult).toEqual({ template: "template-requested-by-agent", check: result });
  expect(view.onSaved).toHaveBeenCalledTimes(2);
  expect(mocks.journalRequest.mock.calls.every(([path]) => path === "/api/state")).toBe(true);
  expect(mocks.editorSave).not.toHaveBeenCalled();
});

it("returns from a failed saved PDF preview to the same unsaved working editor", async () => {
  mocks.findRenderer.mockResolvedValue("/opt/soffice");
  mocks.renderFonts.mockResolvedValue({ bundle_id: "render-unavailable", baseline_id: INITIAL_BASELINE,
    manifest: { pdf_sha256: "e".repeat(64), page_count: 1, render_record: { renderer_version: "LibreOffice 26.8" } } });
  mocks.loadPdf.mockRejectedValueOnce(new Error("Retained PDF bytes unavailable"));
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const editorNode = screen.getByTestId("mock-docx-editor");
  act(() => harness.edit("first", "Unsaved working text"));
  fireEvent.click(screen.getByRole("button", { name: text.render.open }));
  expect(await screen.findByRole("alert")).toHaveTextContent(en.workspace.docxRender.loadFailed);
  expect(screen.queryByTestId("saved-pdf-viewer")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: en.workspace.backToDocument }));
  expect(screen.getByTestId("docx-editor-surface")).toBeVisible();
  expect(screen.getByTestId("mock-docx-editor")).toBe(editorNode);
  expect(useAgentWorkspaceStore.getState().views["app-project"]).toMatchObject({ role: "working", dirty: true, sessionRevision: 1 });
  expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(mocks.saveBaseline).not.toHaveBeenCalled();
});

it("opens exact missing font details from the document notice without replacing the edited session", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const editorNode = screen.getByTestId("mock-docx-editor");
  act(() => harness.edit("first", "Unsaved text"));
  act(() => mocks.fontOptions?.onStatus({ probed: true, missing: [
    { family: "Source Han Serif SC", weight: 400, style: "normal" },
    { family: "Source Han Serif SC", weight: 700, style: "normal" },
  ], aliases: [] }));
  fireEvent.click(screen.getByRole("button", { name: en.workspace.missingFonts }));
  expect(screen.getByRole("button", { name: en.workspace.documentTools })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("docx-font-missing-families")).toHaveTextContent(/^Source Han Serif SC$/);
  expect(screen.getByTestId("docx-font-refresh")).toBeVisible();
  expect(screen.getByTestId("mock-docx-editor")).toBe(editorNode);
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.unsaved);
  expect(mocks.editorSave).not.toHaveBeenCalled();
});

it("stops a streaming suggestion without applying it and allows the user to keep editing after a close prompt", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  const view = await renderReady(harness);
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  const target = harness.session.captureTarget(harness.session.listParagraphs()[0].handle);
  const controller = new AbortController();
  act(() => registration.onSuggestion({ target, proposed: "Partial replacement", phase: "streaming", controller }));
  expect(registration.canPresentSuggestion()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: text.stop }));
  expect(controller.signal.aborted).toBe(true);
  expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.withdrawn);
  expect(registration.canPresentSuggestion()).toBe(true);
  expect(mocks.applySuggestion).not.toHaveBeenCalled();
  act(() => harness.edit("first", "User's own edit"));
  fireEvent.click(screen.getByRole("button", { name: en.workspace.closeDocument }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: text.keepEditing }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(view.onClose).not.toHaveBeenCalled();
  expect(harness.text("first")).toBe("User's own edit");
});

it("shows an apply refusal and withdraws the suggestion without changing the working text", async () => {
  const harness = sessionHarness([paragraph("first", "Original")]);
  await renderReady(harness);
  const registration = mocks.registerAgentSession.mock.calls[0][0];
  const target = harness.session.captureTarget(harness.session.listParagraphs()[0].handle);
  mocks.applySuggestion.mockReturnValueOnce({ ok: false, code: "stale-target", message: "Refresh this paragraph before applying", revision: 0, changed: false });
  act(() => registration.onSuggestion({ target, proposed: "Candidate", phase: "reviewing", controller: new AbortController() }));
  fireEvent.click(screen.getByRole("button", { name: text.accept }));
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh this paragraph before applying");
  expect(screen.getByTestId("docx-suggestion")).toHaveTextContent(text.phases.withdrawn);
  expect(screen.queryByRole("button", { name: text.accept })).not.toBeInTheDocument();
  expect(harness.text("first")).toBe("Original");
  expect(screen.getByTestId("docx-save-state")).toHaveTextContent(text.saved);
});

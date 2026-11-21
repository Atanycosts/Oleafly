import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDocxEditor, useEditorState, useFonts } from "@docx-editor.dev/react";
import type { DocxEditorInstance, FontMeasurementState } from "@docx-editor.dev/core/editor";
import type { EditorSnapshot, SemanticSelection } from "@docx-editor.dev/core/contracts/editor";
import type { DocxFormatReadQuery, DocxFormatReadResult, DocxSaveResult, DocxTemplateCheckResult } from "@oleafly/ai-tools";
import { Check, Download, FilePenLine, LocateFixed, PanelRight, Save, Undo2, X } from "lucide-react";
import "@docx-editor.dev/core/styles/editor.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { base64ToBytes } from "@/lib/base64";
import { downloadDocxCopy } from "@/lib/docx-download";
import { createDocxFormatReader } from "@/lib/docx-format-reader";
import { createDocxFontResolver, type DocxFontStatus } from "@/lib/docx-fonts";
import { ensureDocxFonts } from "@/lib/docx-prepare-fonts";
import { createDocxSession, type DocxSession, type DocxTarget } from "@/lib/docx-session";
import { E2E_HOOKS } from "@/lib/e2e-flags";
import {
  registerDocxAgentSession,
  unregisterDocxAgentSession,
  updateDocxAgentSession,
  type DocxAgentRegistration,
  type DocxTaskOperationResult,
} from "@/lib/docx-agent-host";
import {
  clearDocxRecovery,
  discardDocxRecovery,
  docxContentSha256,
  commitDocxRecovery,
  recoveryPendingSave,
  resumeDocxRecovery,
  listDocxRecovery,
  readDocxRecovery,
  saveDocxRecovery,
  type DocxRecoveryMetadata,
  type DocxRecoverySnapshot,
  type DocxRecoveryTaskState,
  type DocxRecoveryApplied,
  type DocxRecoveryReceipt,
  type DocxRecoveryOperation,
  type DocxRecoverySaveOperation,
} from "@/lib/docx-recovery";
import { loadDocxSource, prepareDocxSave, type DocxSave, type DocxSource } from "@/lib/docx-workbench";
import { journalRequest, type JournalCheck, type JournalProject, type JournalState, type JournalWorld } from "@/lib/journal-workbench";
import { checkJournalTemplate, retainDocxFormat } from "@/lib/docx-template-client";
import { registerProjectLeaveGuard } from "@/lib/project-leave-guards";
import { registerEditorMutationOwner } from "@/lib/editor-mutation-lease";
import { useDocxWorkspaceStore, type DocxWorkspaceRequest } from "@/store/docx-workspace";
import { handoffToAssistant } from "@/features/assistant-handoff";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { useAgentWorkspaceStore, type AgentWorkspaceSelection } from "@/store/agent-workspace";
import { bindDocxTask, settleDocxTaskActivity, type DocxActivity, type DocxDocumentIdentity, type DocxProposalOutcome } from "@/lib/docx-task-activity";
import { DocxActivitySource, DocxTaskActivity } from "./DocxTaskActivity";
import { DocxRenderPanel, type DocxRenderPreview } from "./DocxRenderPanel";
import { MaterialPdfView } from "@/components/materials/MaterialPdfView";
import { MaterialViewContext } from "@/components/materials/MaterialViewContext";
import type { MaterialDocument } from "@/lib/material-surface";
import { DocxFontsPanel } from "./DocxFontsPanel";
import { DocxEquationPanel, type DocxEquationDraft, type DocxEquationTarget } from "./DocxEquationPanel";
import { DocxContextTools, overlaps, tabThroughDocxControls, useDocxOverlayPlacement, type DocxSelectionAnnotation } from "./DocxContextTools";
import { DocxMaterialTools, type DocxMaterialView } from "@/components/materials/DocxMaterialTools";
import { WordSurface, WordToolbarPortal } from "@/components/materials/WordSurface";
import { WordDocument, type WordDocumentRef } from "@/components/materials/WordDocument";
import type { MaterialVersionSide } from "@/components/materials/MaterialVersionStack";
import {
  captureRetainedDocxMaterial,
  captureWorkingDocxMaterial,
  DocxMaterialCaptureError,
  readDocxMaterialSelection,
} from "@/lib/docx-material";
import { registerDocxHistory } from "@/lib/docx-history";
import { openMaterialAnnotations } from "@/store/material-annotations";

const fontShaping = Object.freeze({ maxFontBytes: 64 * 1024 * 1024 });
const RECOVERY_DEBOUNCE_MS = 1500;
const e2eEditors = new Map<string, () => DocxEditorInstance | null>();

export function e2eDocxParagraphNode(sessionId: string, paraId: string): string | null {
  return E2E_HOOKS ? e2eEditors.get(sessionId)?.()?.surface?.session.nodeIdOf(paraId) ?? null : null;
}

export function e2eDocxSelection(sessionId: string): SemanticSelection | null {
  return E2E_HOOKS ? e2eEditors.get(sessionId)?.()?.surface?.state().selection ?? null : null;
}

function sameModelSelection(left: SemanticSelection | undefined, right: SemanticSelection) {
  return !!left && left.anchor.paragraphId === right.anchor.paragraphId && left.anchor.offset === right.anchor.offset &&
    left.head.paragraphId === right.head.paragraphId && left.head.offset === right.head.offset;
}

function cancelOnUserInteraction(controller: AbortController) {
  const cancel = () => controller.abort();
  for (const event of ["pointerdown", "keydown", "focusin", "wheel"]) {
    document.addEventListener(event, cancel, { capture: true, passive: true, signal: controller.signal });
  }
}

function captureSelectionGuard(editor: DocxEditorInstance, line: HTMLElement, controller: AbortController) {
  const surface = editor.surface;
  const viewport = line.closest<HTMLElement>(".docx-editor__scroll-container");
  if (!surface || !viewport) return null;
  const captured = surface.state().selection;
  const unchanged = () => editor.surface === surface && sameModelSelection(surface.state().selection, captured);
  const visible = () => viewport.contains(line) && overlaps(line.getBoundingClientRect(), viewport.getBoundingClientRect());
  const stopSelection = editor.on("selectionChange", () => {
    if (!unchanged()) controller.abort();
  });
  const onScroll = () => {
    if (!visible()) controller.abort();
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Node && !viewport.contains(event.target)) controller.abort();
  };
  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.ownerDocument.addEventListener("focusin", onFocusIn, true);
  return {
    isCurrent: () => unchanged() && visible(),
    stop() {
      stopSelection();
      viewport.removeEventListener("scroll", onScroll);
      viewport.ownerDocument.removeEventListener("focusin", onFocusIn, true);
    },
  };
}

interface Props {
  appProjectId: string;
  project: JournalProject;
  world: JournalWorld | null;
  recovery?: DocxRecoverySnapshot;
  workingEditorRef?: RefObject<WordDocumentRef | null>;
  feedbackVisible: boolean;
  onContextToolActivate?(): void;
  onClose(): void;
  onSaved(): Promise<void>;
}

interface Suggestion {
  activity?: DocxActivity;
  target: DocxTarget;
  proposed: string;
  phase: "streaming" | "reviewing" | "withdrawn" | "applied";
}

export function DocxWorkspaceHost({ feedbackVisible, onContextToolActivate }: {
  feedbackVisible: boolean;
  onContextToolActivate?(): void;
}) {
  const request = useDocxWorkspaceStore((state) => state.request);
  const context = useDocxWorkspaceStore((state) => state.context);
  const [prepared, setPrepared] = useState<DocxWorkspaceRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation("researchTools");
  useEffect(() => {
    let active = true;
    setError(null);
    if (!request) { setPrepared(null); return; }
    if (request.recovery) { setPrepared(request); return; }
    void listDocxRecovery().then((listing) => {
      if (!active) return;
      if (listing.snapshots.some((snapshot) => snapshot.appProjectId === request.appProjectId && snapshot.workbenchProjectId === request.project.project_id)) {
        const store = useDocxWorkspaceStore.getState();
        store.close();
        store.setRecoveryOpen(true);
      } else setPrepared(request);
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [request]);
  return request ? <>
    {prepared === request && context && <DocxWorkspaceDialog {...request} {...context} feedbackVisible={feedbackVisible}
      onContextToolActivate={onContextToolActivate}
      onClose={() => useDocxWorkspaceStore.getState().close()} />}
    {error && <div className="space-y-3 p-6"><h2>{t(($) => $.researchTools.docx.recovery.title)}</h2><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => useDocxWorkspaceStore.getState().close()}>{t(($) => $.researchTools.workspace.closeDocument)}</Button></div>}
  </> : null;
}

function SessionBridge({ onReady, onMeasurement, onSelection }: {
  onReady(editor: DocxEditorInstance): void;
  onMeasurement(value: FontMeasurementState): void;
  onSelection(editor: DocxEditorInstance, snapshot?: EditorSnapshot): void;
}) {
  const editor = useDocxEditor();
  const readyState = useEditorState((snapshot) => ({
    isLoading: snapshot.isLoading,
    isOpening: snapshot.isOpening ?? false,
    parseError: snapshot.parseError,
    pageTotal: snapshot.page.total,
    measurement: editor?.fontMeasurement(),
  }));
  const readyEditor = useRef<DocxEditorInstance | null>(null);

  const { measurer, resolving, producer } = readyState.measurement ?? { measurer: "fixed" as const, resolving: true, producer: undefined };
  useEffect(() => {
    onMeasurement({ measurer, resolving, producer });
  }, [onMeasurement, measurer, resolving, producer]);

  useEffect(() => {
    if (!editor) {
      readyEditor.current = null;
      return;
    }
    if (readyEditor.current === editor) return;
    if (!readyState.isLoading && !readyState.isOpening && readyState.parseError === null && readyState.pageTotal > 0) {
      readyEditor.current = editor;
      onReady(editor);
    }
  }, [editor, onReady, readyState]);
  useEffect(() => {
    if (!editor || readyState.isLoading || readyState.isOpening || readyState.parseError || readyState.pageTotal === 0) return;
    onSelection(editor);
    return editor.on("selectionChange", (snapshot) => onSelection(editor, snapshot));
  }, [editor, onSelection, readyState.isLoading, readyState.isOpening, readyState.pageTotal, readyState.parseError]);
  return null;
}

function ReadOnlySelectionBridge({ onSelection }: { onSelection(editor: DocxEditorInstance): void }) {
  const editor = useDocxEditor();
  const ready = useEditorState((snapshot) => !snapshot.isLoading && !snapshot.isOpening &&
    snapshot.parseError === null && snapshot.page.total > 0);
  useEffect(() => {
    if (!editor || !ready) return;
    onSelection(editor);
    return editor.on("selectionChange", () => onSelection(editor));
  }, [editor, onSelection, ready]);
  return null;
}

interface SuggestionActions {
  accept?(): void;
  reject(): void;
  stop(): void;
}

function SuggestionControls({ phase, accept, reject, stop }: SuggestionActions & { phase: Suggestion["phase"] }) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx, { returnObjects: true });
  if (phase === "streaming") return <Button size="sm" variant="outline" onClick={stop}>{text.stop}</Button>;
  if (phase !== "reviewing") return null;
  return <div className="flex flex-wrap gap-1.5">
    {accept && <Button size="sm" onClick={accept}><Check className="mr-1 size-3" />{text.accept}</Button>}
    <Button size="sm" variant="ghost" onClick={reject}><X className="mr-1 size-3" />{text.reject}</Button>
  </div>;
}

function SuggestionHighlight({ target }: { target: DocxTarget }) {
  const editor = useDocxEditor();
  const { paraId, original } = target;
  const paragraphId = paraId ? editor?.surface?.session.nodeIdOf(paraId) : null;
  useEffect(() => {
    if (!editor || !paragraphId || !original.length) return;
    editor.setHighlights("oleafly-review", [{ blockId: paragraphId, start: 0, length: original.length, expectedText: original }],
      { className: "oleafly-docx-target", color: "var(--doc-anchor-highlight-color)" });
    return () => editor.clearHighlights("oleafly-review");
  }, [editor, original, paragraphId]);
  return null;
}

function SuggestionEntry({ suggestion, panel, toolsId, onOpen, onLostFocus }: {
  suggestion: Suggestion;
  panel: RefObject<HTMLDivElement | null>;
  toolsId: string;
  onOpen(): void;
  onLostFocus(): void;
}) {
  const { t } = useTranslation("researchTools");
  const editor = useDocxEditor();
  const { paraId } = suggestion.target;
  const paragraphId = paraId ? editor?.surface?.session.nodeIdOf(paraId) : null;
  const findAnchor = useCallback((viewport: HTMLElement, bounds: DOMRect) => {
    if (!paragraphId) return null;
    const selector = `.docx-paragraph-fragment[data-paragraph-id="${CSS.escape(paragraphId)}"]`;
    for (const fragment of viewport.querySelectorAll<HTMLElement>(selector)) {
      const rect = fragment.getBoundingClientRect();
      if (rect.width && rect.height && overlaps(rect, bounds)) {
        return { rect, sheet: fragment.closest(".docx-page")?.getBoundingClientRect() };
      }
    }
    return null;
  }, [paragraphId]);
  const onPlacement = useCallback((placed: boolean, element: HTMLDivElement) => {
    if (!placed && element.contains(element.ownerDocument.activeElement)) onLostFocus();
  }, [onLostFocus]);
  useDocxOverlayPlacement(panel, findAnchor, 34, onPlacement, true);
  return <div ref={panel} inert style={{ visibility: "hidden" }}
    className="absolute z-20 w-max overflow-hidden rounded-lg border bg-popover p-0.5 text-popover-foreground shadow-sm"
    data-testid="docx-inline-suggestion" data-docx-history="field">
    <Button size="sm" variant="ghost" className="h-7 max-w-full gap-1.5 px-2" aria-controls={toolsId} aria-keyshortcuts="F6"
      aria-expanded={false} title={t(($) => $.researchTools.docx.phases[suggestion.phase])} onClick={(event) => {
        const entry = event.currentTarget;
        const viewport = entry.closest("section")?.querySelector<HTMLElement>(".docx-editor__scroll-container");
        if (viewport && findAnchor(viewport, viewport.getBoundingClientRect())) onOpen();
        else if (entry === entry.ownerDocument.activeElement) onLostFocus();
      }}>
      {suggestion.phase === "streaming" ? <Spinner size="sm" /> : <FilePenLine className="size-3.5" />}
      <span className="truncate">{t(($) => $.researchTools.docx.reviewSuggestion)}</span>
    </Button>
  </div>;
}

/** A working copy of a retained baseline; the original author path is never opened for writing. */
export default function DocxWorkspaceDialog({ appProjectId, project, world, recovery, feedbackVisible,
  workingEditorRef, onContextToolActivate, onClose, onSaved }: Props) {
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const { t, i18n } = useTranslation("researchTools");
  const { t: tEditor } = useTranslation("editor");
  const text = t(($) => $.researchTools.docx, { returnObjects: true });
  const [source, setSource] = useState<DocxSource | null>(null);
  const initialSourceRef = useRef<DocxSource | null>(null);
  const [materialView, setMaterialView] = useState<DocxMaterialView>("working");
  const [originalKept, setOriginalKept] = useState(false);
  const [stackForeground, setStackForeground] = useState<MaterialVersionSide>("current");
  const annotationCapture = useRef<AbortController | null>(null);
  const [workingViewSelection, setWorkingViewSelection] = useState<
    AgentWorkspaceSelection & { collapsedModelOffset?: number } | null
  >(null);
  const [originalViewSelection, setOriginalViewSelection] = useState<AgentWorkspaceSelection | null>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const activeSurface = useWorkspaceSurfaceStore((state) => state.active);
  const initialProject = useRef(project);
  const initialRecovery = useRef(recovery);
  const sourceMismatchMessage = useRef(text.recovery.sourceChanged);
  const editorLocale = useRef(i18n.language);
  const [baselineId, setBaselineId] = useState(recovery?.baseBaselineId ?? project.baseline_id);
  const [error, setError] = useState<string | null>(null);
  const toolsOpen = useDocxWorkspaceStore((state) => state.toolsOpen);
  const setToolsOpen = useDocxWorkspaceStore((state) => state.setToolsOpen);
  const toolsButton = useRef<HTMLButtonElement>(null);
  const toolsPanel = useRef<HTMLElement>(null);
  const reviewOpener = useRef<DocxEditorInstance | null>(null);
  const inlineReview = useRef<HTMLDivElement>(null);
  const restoreReviewFocus = useCallback(() => toolsButton.current?.focus({ preventScroll: true }), []);
  const toolsId = useId();
  const reviewHeadingId = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewControls = useRef<HTMLDivElement>(null);
  const revealReviewButton = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<DocxRenderPreview | null>(null);
  const [showPdf, setShowPdf] = useState(false);
  const closeRequested = useDocxWorkspaceStore((state) => state.closeRequested);
  const handledClose = useRef(0);
  const closeAction = useRef<() => void>(() => {});
  useEffect(() => {
    if (handledClose.current === closeRequested) return;
    handledClose.current = closeRequested;
    closeAction.current();
  }, [closeRequested]);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const suggestionRef = useRef<Suggestion | null>(null);
  const [taskReady, setTaskReady] = useState(false);
  const appliedTasks = useRef(new Map<string, DocxRecoveryApplied & { suggestion?: Suggestion }>());
  const taskOperations = useRef(new Map<string, DocxRecoveryOperation>(
    (initialRecovery.current?.taskState?.operations ?? []).map((operation) => [operation.operationId, operation]),
  ));
  const [recoveredActivities, setRecoveredActivities] = useState<DocxActivity[]>([]);
  const recoveredProposalIds = useRef(new Set<string>());
  const recoveredBytes = useRef(initialRecovery.current?.bytes);
  const [resuming, setResuming] = useState(false);
  const recoveryReady = useRef(!initialRecovery.current?.taskState);
  const retryResume = useRef<() => void>(() => {});
  const pendingCheckpoint = useRef<(DocxRecoverySnapshot & { taskState: DocxRecoveryTaskState }) | null>(null);
  const checkpointCurrent = useRef<() => Promise<void>>(async () => {});
  const receiptCheckpoint = useRef<{ metadata: DocxRecoveryMetadata; document: DocxDocumentIdentity } | null>(null);
  const fixedSavePending = useRef(false);
  const deferredWithdrawals = useRef<DocxRecoveryReceipt[]>([]);
  const receipts = useRef<DocxRecoveryReceipt[]>([]);
  const [pendingReceipts, setPendingReceipts] = useState(0);
  const receiptWriting = useRef(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const retryReceiptButton = useRef<HTMLButtonElement>(null);
  const identityRef = useRef<() => DocxDocumentIdentity>(() => { throw new Error("DOCX is not ready."); });
  const [revision, setRevision] = useState(0);
  // A recovered package has never been saved by the fresh editor session.
  // Keep automation revisions native; -1 marks the missing saved revision.
  const [savedRevision, setSavedRevision] = useState(recovery ? -1 : 0);
  const [saving, setSaving] = useState(false);
  const [pendingSave, setPendingSave] = useState<DocxSave | null>(null);
  const [refusedSave, setRefusedSave] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<JournalCheck | null>(null);
  const [closePrompt, setClosePrompt] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const localEditorRef = useRef<WordDocumentRef>(null);
  const editorRef = workingEditorRef ?? localEditorRef;
  const originalEditorRef = useRef<WordDocumentRef>(null);
  const editorInstance = useRef<DocxEditorInstance | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const sessionRef = useRef<DocxSession | null>(null);
  const equationDrafts = useRef(new Map<string, DocxEquationDraft>());
  const pendingSidebarEquation = useRef<AbortController | null>(null);
  const [capturedEquation, setCapturedEquation] = useState<{
    session: DocxSession;
    sessionId: string;
    target: DocxEquationTarget;
  } | null>(null);
  const liveSaveRef = useRef<NonNullable<DocxAgentRegistration["save"]>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const liveCheckRef = useRef<(request: { template: string; signal?: AbortSignal }) => Promise<DocxTemplateCheckResult>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const liveFormatRef = useRef<(query: DocxFormatReadQuery) => Promise<DocxFormatReadResult>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const livePrepareFontsRef = useRef<() => Promise<unknown>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const liveExportRef = useRef<NonNullable<DocxAgentRegistration["exportDocument"]>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const formatReaderRef = useRef<{ session: DocxSession; read: ReturnType<typeof createDocxFormatReader> } | null>(null);
  const formatDocumentRef = useRef({ sessionId: "", filename: "", baselineId: "", savedRevision: 0 });
  const recoveryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recoveryEpoch = useRef(0);
  const [sessionId] = useState(() => `docx:${crypto.randomUUID()}`);
  useEffect(() => {
    if (!E2E_HOOKS || !editorReady) return;
    e2eEditors.set(sessionId, () => editorInstance.current);
    return () => { e2eEditors.delete(sessionId); };
  }, [editorReady, sessionId]);
  const stopRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const [fontMeasurement, setFontMeasurement] = useState<FontMeasurementState>({ measurer: "fixed", resolving: true });
  const [fontStatus, setFontStatus] = useState<DocxFontStatus>({ probed: false, missing: [], aliases: [] });
  const fontStatusRef = useRef(fontStatus);
  const fontPreparationError = useRef<string | null>(null);
  const fontRefreshQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [fontRevision, setFontRevision] = useState(0);
  const createFontResolver = () => createDocxFontResolver({
    onError: (cause) => {
      fontPreparationError.current = String(cause);
      if (alive.current) setError(`${text.fontError}: ${String(cause)}`);
    },
    onStatus: (value) => { fontStatusRef.current = value; if (alive.current) setFontStatus(value); },
  });
  const [localFontResolver] = useState(createFontResolver);
  const fonts = useFonts(localFontResolver);
  function refreshFonts() {
    const refreshing = fontRefreshQueue.current.then(async () => {
      const editor = editorInstance.current;
      if (!editor || !alive.current) throw new Error(text.notReady);
      fontPreparationError.current = null;
      fontStatusRef.current = { probed: false, missing: [], aliases: [] };
      setFontStatus(fontStatusRef.current);
      await editor.setFonts(createFontResolver());
      if (alive.current) setFontRevision((value) => value + 1);
      if (fontPreparationError.current) throw new Error(fontPreparationError.current);
      return { status: fontStatusRef.current, measurement: editor.fontMeasurement() };
    });
    fontRefreshQueue.current = refreshing.catch(() => {});
    return refreshing;
  }
  const busySave = useRef(false);
  const discardingRef = useRef(false);
  const interactionRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = interactionRoot.current;
    if (!root) return;
    return registerDocxHistory(root, () => editorInstance.current);
  }, []);
  identityRef.current = () => {
    if (!source) throw new Error("The DOCX source is not loaded.");
    return { sessionId, appProjectId, workbenchProjectId: project.project_id,
      baselineId, sourceSha256: source.source_sha256, sessionRevision: sessionRef.current?.revision() ?? revision, savedRevision };
  };
  const dirty = revision !== savedRevision;
  const recoveryConflict = !!recovery && project.baseline_id !== recovery.baseBaselineId;
  const streaming = suggestion?.phase === "streaming";
  const saveRefused = !!pendingCheckpoint.current && refusedSave === `${pendingCheckpoint.current.recoveryKey}:${pendingCheckpoint.current.contentSha256}`;
  const closeBlocked = saving || checking || (pendingReceipts > 0 && !fixedSavePending.current);
  const captureWorkingSelection = useCallback((editor: DocxEditorInstance, snapshot?: EditorSnapshot) => {
    const current = snapshot ?? editor.snapshot();
    const materialSelection = readDocxMaterialSelection(editor, current);
    const selection = current.selection;
    const session = sessionRef.current;
    if (!selection || !session) { setWorkingViewSelection(null); return; }
    const paraId = "paraId" in selection.from && "paraId" in selection.to && selection.from.paraId === selection.to.paraId
      ? selection.from.paraId : undefined;
    const surface = editor.surface;
    const surfaceSelection = surface?.state().selection;
    const collapsedModelOffset = surfaceSelection &&
      surfaceSelection.anchor.paragraphId === surfaceSelection.head.paragraphId &&
      surfaceSelection.anchor.offset === surfaceSelection.head.offset
      ? surfaceSelection.anchor.offset
      : undefined;
    setWorkingViewSelection({ revision: String(session.revision()), paraId,
      ...(collapsedModelOffset === undefined ? {} : { collapsedModelOffset }),
      quote: current.selectionCollapsed ? undefined : materialSelection?.quote ?? editor.query({ type: "selectedText" }) });
  }, []);
  const captureEquationTarget = useCallback((target: DocxEquationTarget) => {
    const session = sessionRef.current;
    if (!session || target.revision !== session.revision()) return;
    setCapturedEquation({ session, sessionId, target });
  }, [sessionId]);
  const returnToBody = () => {
    pendingSidebarEquation.current?.abort();
    setCapturedEquation(null);
  };
  const captureOriginalSelection = useCallback((editor: DocxEditorInstance) => {
    const current = editor.snapshot();
    const selection = current.selection;
    if (!selection || !initialSourceRef.current) { setOriginalViewSelection(null); return; }
    const paraId = "paraId" in selection.from && "paraId" in selection.to && selection.from.paraId === selection.to.paraId
      ? selection.from.paraId : undefined;
    setOriginalViewSelection({ revision: initialSourceRef.current.source_sha256, paraId,
      quote: current.selectionCollapsed ? undefined : editor.query({ type: "selectedText" }) });
  }, []);
  useEffect(() => {
    useDocxWorkspaceStore.getState().setClosingBlocked(closeBlocked);
    return () => useDocxWorkspaceStore.getState().setClosingBlocked(false);
  }, [closeBlocked]);

  useEffect(() => {
    const unfinished = dirty || streaming || suggestion?.phase === "reviewing" || !!pendingSave || saving || checking || pendingReceipts > 0;
    const stopLeave = registerProjectLeaveGuard(async (leave) => {
      if (leave.projectId !== appProjectId) return true;
      if (!unfinished) { onClose(); return true; }
      if (!saving && !checking) {
        useWorkspaceSurfaceStore.getState().showWord();
        setClosePrompt(true);
      }
      return false;
    });
    const stopOwner = registerEditorMutationOwner({
      projectId: () => appProjectId,
      setLocked: (locked) => { if (interactionRoot.current) interactionRoot.current.inert = locked; },
      flush: () => { if (unfinished) throw new Error(text.closeHelp); },
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unfinished) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      stopLeave();
      stopOwner();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [appProjectId, dirty, streaming, pendingSave, saving, checking, text.closeHelp, onClose, pendingReceipts, suggestion?.phase]);

  const flushReceipts = useCallback(async () => {
    if (receiptWriting.current || fixedSavePending.current) return;
    receiptWriting.current = true;
    try {
      while (receipts.current.length) {
        const receipt = receipts.current[0];
        await settleDocxTaskActivity(appProjectId, initialProject.current.project_id,
          receipt.proposalId, receipt.document, receipt.outcome);
        receipts.current.shift();
        if (alive.current && receipts.current.length) setPendingReceipts(receipts.current.length);
      }
      const checkpoint = receiptCheckpoint.current;
      if (checkpoint) {
        const cleanup = recoveryQueueRef.current.then(async () => {
          const current = identityRef.current();
          if (receiptCheckpoint.current !== checkpoint || fixedSavePending.current || busySave.current ||
            receipts.current.length || deferredWithdrawals.current.length || appliedTasks.current.size || taskOperations.current.size ||
            current.sessionId !== checkpoint.document.sessionId ||
            current.sessionRevision !== checkpoint.document.sessionRevision ||
            current.sessionRevision !== current.savedRevision ||
            current.baselineId !== checkpoint.document.baselineId ||
            current.sourceSha256 !== checkpoint.document.sourceSha256) return;
          if (await discardDocxRecovery(checkpoint.metadata)) receiptCheckpoint.current = null;
        });
        recoveryQueueRef.current = cleanup.then(() => undefined, () => undefined);
        await cleanup;
      }
      if (alive.current) {
        const button = retryReceiptButton.current;
        if (!receipts.current.length && button && button.ownerDocument.activeElement === button) restoreReviewFocus();
        setPendingReceipts(receipts.current.length);
        setReceiptError(null);
      }
    } catch (cause) {
      if (alive.current) setReceiptError(String(cause));
    }
    finally { receiptWriting.current = false; }
  }, [appProjectId, restoreReviewFocus]);
  const checkpointAndFlushReceipts = useCallback(() => {
    void checkpointCurrent.current().then(flushReceipts).catch((cause) => {
      if (alive.current) setReceiptError(String(cause));
    });
  }, [flushReceipts]);
  const recordOutcome = useCallback((proposalId: string, outcome: DocxProposalOutcome, document = identityRef.current()) => {
    if ((busySave.current || fixedSavePending.current) && outcome.kind === "withdrawn") {
      deferredWithdrawals.current.push({ proposalId, document, outcome });
      return;
    }
    receipts.current.push({ proposalId, document, outcome });
    setPendingReceipts(receipts.current.length);
    if (!busySave.current && !fixedSavePending.current) checkpointAndFlushReceipts();
  }, [checkpointAndFlushReceipts]);

  const updateSuggestion = useCallback((next: Suggestion | null) => {
    const keepsReview = next?.phase === "streaming" || next?.phase === "reviewing";
    const entry = inlineReview.current;
    if (!keepsReview && entry?.contains(entry.ownerDocument.activeElement)) restoreReviewFocus();
    const controls = reviewControls.current;
    if (next && next.phase !== suggestionRef.current?.phase && controls) {
      const focused = controls.ownerDocument.activeElement;
      if (controls.contains(focused) && (!keepsReview || focused !== revealReviewButton.current)) {
        reviewHeading.current?.focus({ preventScroll: true });
      }
    }
    suggestionRef.current = next;
    setSuggestion(next);
  }, [restoreReviewFocus]);

  useEffect(() => {
    let active = true;
    alive.current = true;
    const snapshot = initialRecovery.current;
    void loadDocxSource(initialProject.current.project_id, snapshot?.baseBaselineId ?? initialProject.current.baseline_id)
      .then((value) => {
        if (!active) return;
        if (snapshot && (snapshot.appProjectId !== appProjectId || snapshot.workbenchProjectId !== value.project_id || snapshot.baseBaselineId !== value.baseline_id || snapshot.sourceSha256 !== value.source_sha256)) {
          throw new Error(sourceMismatchMessage.current);
        }
        initialSourceRef.current = value;
        if (alive.current) setSource(snapshot ? { ...value, bytes: snapshot.bytes } : value);
      })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => {
      active = false;
      alive.current = false;
      stopRef.current?.abort();
      unsubscribeRef.current?.();
      unregisterDocxAgentSession(sessionId);
      sessionRef.current?.dispose();
      useAgentWorkspaceStore.getState().clearView(appProjectId, `docx:${initialProject.current.project_id}`);
    };
  }, [appProjectId, sessionId]);

  const taskStateAtExport = useCallback((): DocxRecoveryTaskState => ({
    document: { ...identityRef.current() },
    applied: [...appliedTasks.current.values()].map(({ proposalId, document }) => ({ proposalId, document: { ...document } })),
    receipts: receipts.current.map((receipt) => ({ ...receipt, document: { ...receipt.document } })),
    operations: [...taskOperations.current.values()],
  }), []);

  const queueRecoveryWrite = useCallback((
    source: DocxSource, baseBaselineId: string, exportRevision: number, bytes: ArrayBuffer,
    taskState: DocxRecoveryTaskState,
  ): Promise<DocxRecoveryMetadata> => {
    const write = recoveryQueueRef.current.then(() => saveDocxRecovery({
      appProjectId, workbenchProjectId: source.project_id, baseBaselineId,
      sourceSha256: source.source_sha256,
    }, exportRevision, bytes, taskState));
    recoveryQueueRef.current = write.then(() => undefined, () => undefined);
    return write;
  }, [appProjectId]);

  const checkpoint = useCallback(() => {
    const epoch = recoveryEpoch.current;
    const write = recoveryQueueRef.current.then(async () => {
      const editor = editorRef.current;
      const session = sessionRef.current;
      if (!editor || !session || !source || !alive.current || discardingRef.current ||
        fixedSavePending.current || !recoveryReady.current || epoch !== recoveryEpoch.current) return;
      const exporting = recoveredBytes.current
        ? Promise.resolve(new Uint8Array(recoveredBytes.current).buffer) : editor.save();
      const exportRevision = session.revision();
      const taskState = taskStateAtExport();
      const bytes = await exporting;
      if (bytes && alive.current && !discardingRef.current && epoch === recoveryEpoch.current) {
        const metadata = await saveDocxRecovery({ appProjectId, workbenchProjectId: taskState.document.workbenchProjectId,
          baseBaselineId: taskState.document.baselineId, sourceSha256: taskState.document.sourceSha256 }, exportRevision, bytes, taskState);
        receiptCheckpoint.current = { metadata, document: taskState.document };
      }
    });
    recoveryQueueRef.current = write.then(() => undefined, () => undefined);
    return write;
  }, [appProjectId, editorRef, source, taskStateAtExport]);
  checkpointCurrent.current = checkpoint;

  useEffect(() => {
    if (!source || !dirty || saving || checking || discarding || pendingSave || resuming) return;
    const scheduledRevision = revision;
    const timer = window.setTimeout(() => {
      if (sessionRef.current?.revision() !== scheduledRevision) return;
      void checkpoint().catch((cause) => { if (alive.current) setError(String(cause)); });
    }, RECOVERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [checking, checkpoint, dirty, discarding, pendingSave, resuming, revision, saving, source]);

  const ready = useCallback((editor: DocxEditorInstance) => {
    editorInstance.current = editor;
    setEditorReady(true);
    unsubscribeRef.current?.();
    unregisterDocxAgentSession(sessionId);
    sessionRef.current?.dispose();
    equationDrafts.current.clear();
    setCapturedEquation(null);
    const session = createDocxSession(editor);
    sessionRef.current = session;
    const hasPendingReview = () => {
      const phase = suggestionRef.current?.phase;
      return phase === "streaming" || phase === "reviewing";
    };
    registerDocxAgentSession({
      sessionId,
      appProjectId,
      workbenchProjectId: initialProject.current.project_id,
      title: initialProject.current.name,
      filename: source?.filename ?? initialProject.current.name,
      baselineId: initialRecovery.current?.baseBaselineId ?? initialProject.current.baseline_id,
      savedRevision: initialRecovery.current ? -1 : 0,
      sourceSha256: identityRef.current().sourceSha256,
      session,
      prepareFonts: () => livePrepareFontsRef.current(),
      exportDocument: () => liveExportRef.current(),
      reveal: async ({ paragraphRef, paraId, expectedRevision, signal }) => {
        if (signal?.aborted) return;
        if (expectedRevision !== undefined && session.revision() !== expectedRevision) {
          throw new Error("The Word navigation target belongs to an earlier revision. Refresh the working copy context.");
        }
        const paragraphs = session.listParagraphs();
        const paragraph = paragraphRef ? paragraphs.find((item) => item.handle.ref === paragraphRef)
          : paraId ? paragraphs.find((item) => item.paraId === paraId) : undefined;
        if ((paragraphRef || paraId) && !paragraph?.paraId) throw new Error("The Word navigation paragraph is no longer present.");
        // Commit visibility before the imperative editor measures its viewport.
        flushSync(() => {
          setMaterialView("working");
          setStackForeground("current");
          setShowPdf(false);
          useWorkspaceSurfaceStore.getState().showWord();
        });
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (signal?.aborted) return;
        if (!alive.current || sessionRef.current !== session) throw new Error("The Word working copy closed before navigation completed.");
        if (expectedRevision !== undefined && session.revision() !== expectedRevision) {
          throw new Error("The Word working copy changed before navigation completed.");
        }
        if (paragraph?.paraId) {
          if (!editor.scrollToAnchor({ paraId: paragraph.paraId })) throw new Error("The Word navigation paragraph has no visible layout position.");
          editor.highlightAnchor({ paraId: paragraph.paraId });
        }
      },
      readFormat: (query) => liveFormatRef.current(query),
      save: (request) => liveSaveRef.current(request),
      check: (request) => liveCheckRef.current(request),
      onTaskOperation: async (operation) => {
        taskOperations.current.set(operation.operationId, operation);
        await checkpointCurrent.current();
        if (!receiptCheckpoint.current?.metadata.taskState?.operations?.some(
          (recorded) => recorded.operationId === operation.operationId,
        )) throw new Error("The DOCX operation completed, but its recovery checkpoint is pending.");
      },
      onTaskOperationRecorded: async (operationId) => {
        const operation = taskOperations.current.get(operationId);
        if (!operation) return;
        const result = operation.result as DocxTaskOperationResult;
        const changed = (result.operation === "replace_range" || result.operation === "format" ||
          result.operation === "format_batch" || result.operation === "import_styles" ||
          result.operation === "apply" || result.operation === "write_equation") && result.ok && result.result.changed;
        if (changed) return;
        // Native has retained the actual result (and verified saved source bytes).
        // It no longer belongs to a later unsaved edit's recovery state.
        taskOperations.current.delete(operationId);
        const checkpoint = receiptCheckpoint.current;
        if (!checkpoint) return;
        const cleanup = recoveryQueueRef.current.then(async () => {
          const current = identityRef.current();
          if (receiptCheckpoint.current !== checkpoint || fixedSavePending.current || busySave.current ||
            receipts.current.length || deferredWithdrawals.current.length || taskOperations.current.size ||
            current.sessionId !== checkpoint.document.sessionId ||
            current.sessionRevision !== checkpoint.document.sessionRevision ||
            current.sessionRevision !== current.savedRevision ||
            current.baselineId !== checkpoint.document.baselineId ||
            current.sourceSha256 !== checkpoint.document.sourceSha256) return;
          if (await discardDocxRecovery(checkpoint.metadata)) receiptCheckpoint.current = null;
        });
        recoveryQueueRef.current = cleanup.then(() => undefined, () => undefined);
        await cleanup;
      },
      canPresentSuggestion: () => !hasPendingReview(),
      onTaskSuggestion: (activity, target) => {
        if (!alive.current) throw new Error("The DOCX review surface closed.");
        updateSuggestion({ target, proposed: activity.event.type === "runtime" && activity.event.event.kind === "proposed" ? activity.event.event.proposed : "", phase: "reviewing", activity });
      },
      onSuggestion: (event) => {
        if (!alive.current) return;
        if (event.phase !== "withdrawn" && event.controller.signal.aborted) return;
        if (event.phase === "withdrawn" && stopRef.current !== event.controller) return;
        if (event.phase === "streaming" && stopRef.current !== event.controller) {
          if (suggestionRef.current?.phase === "streaming") throw new Error("A DOCX suggestion is already streaming.");
          stopRef.current = event.controller;
        }
        if (event.phase !== "streaming" && stopRef.current === event.controller) stopRef.current = null;
        updateSuggestion({ target: event.target, proposed: event.proposed, phase: event.phase });
      },
      onApplied: (target, proposed) => {
        if (alive.current && !hasPendingReview()) updateSuggestion({ target, proposed, phase: "applied" });
      },
    });
    const snapshot = initialRecovery.current;
    if (snapshot?.taskState) {
      const initialRevision = session.revision();
      const resumeDocument = { ...identityRef.current() };
      retryResume.current = () => {
      setResuming(true);
      void resumeDocxRecovery(snapshot, resumeDocument).then((activities) => {
        if (!alive.current) return;
        setRecoveredActivities(activities);
        for (const activity of activities) {
          if (!activity.proposalId) continue;
          if (session.revision() === initialRevision) {
            appliedTasks.current.set(activity.proposalId, { proposalId: activity.proposalId, document: activity.document });
            recoveredProposalIds.current.add(activity.proposalId);
          } else recordOutcome(activity.proposalId, { kind: "withdrawn" });
        }
        recoveryReady.current = true;
        setTaskReady(true);
      }).catch((cause) => { if (alive.current) setError(String(cause)); })
        .finally(() => { if (alive.current) setResuming(false); });
      };
      retryResume.current();
    } else setTaskReady(true);
    let previousRevision = session.revision();
    const refresh = () => {
      const changed = session.revision() !== previousRevision;
      previousRevision = session.revision();
      if (changed) {
        equationDrafts.current.clear();
        setCapturedEquation(null);
        recoveredBytes.current = undefined;
        for (const id of recoveredProposalIds.current) {
          appliedTasks.current.delete(id);
          recordOutcome(id, { kind: "withdrawn" });
        }
        recoveredProposalIds.current.clear();
      }
      setRevision(session.revision());
      captureWorkingSelection(editor);
      const pending = suggestionRef.current;
      if (pending && (pending.phase === "streaming" || pending.phase === "reviewing")) {
        let unchanged = false;
        try {
          const target = session.captureTarget(pending.target.paragraph);
          unchanged = target.original === pending.target.original && target.structure === pending.target.structure;
        } catch (cause) {
          setError(String(cause));
        }
        if (!unchanged) {
          stopRef.current?.abort();
          stopRef.current = null;
          updateSuggestion({ ...pending, phase: "withdrawn" });
          if (pending.activity) recordOutcome(pending.activity.id, { kind: "withdrawn" });
        }
      } else if (pending?.phase === "applied" && !session.isSuggestionApplied(pending.target, pending.proposed)) {
        updateSuggestion({ ...pending, phase: "withdrawn" });
      }
      for (const [id, applied] of appliedTasks.current) {
        if (applied.suggestion && !session.isSuggestionApplied(applied.suggestion.target, applied.suggestion.proposed)) {
          appliedTasks.current.delete(id);
          recordOutcome(id, { kind: "withdrawn" });
        }
      }
    };
    refresh();
    const documentChanged = session.subscribe(refresh);
    unsubscribeRef.current = documentChanged;
  }, [appProjectId, sessionId, source?.filename, updateSuggestion, recordOutcome, captureWorkingSelection]);

  function accept() {
    if (!workingInFront || useWorkspaceSurfaceStore.getState().active !== "word") return;
    const session = sessionRef.current;
    editorRef.current?.getEditor()?.surface?.flushPendingInput();
    const pending = suggestionRef.current;
    if (!session || pending?.phase !== "reviewing") return;
    // Publish the phase before the synchronous editor change event examines the old target.
    updateSuggestion({ ...pending, phase: "applied" });
    const result = session.applySuggestion(pending.target, pending.proposed);
    if (!result.ok) {
      updateSuggestion({ ...pending, phase: "withdrawn" });
      setError(result.message);
      if (pending.activity) recordOutcome(pending.activity.id, { kind: "withdrawn" });
    } else if (pending.activity) {
      appliedTasks.current.set(pending.activity.id, { proposalId: pending.activity.id, document: identityRef.current(), suggestion: pending });
      recordOutcome(pending.activity.id, { kind: "applied" });
    }
  }

  function stop() {
    const pending = suggestionRef.current;
    if (pending?.phase !== "streaming") return;
    stopRef.current?.abort();
    stopRef.current = null;
    updateSuggestion({ ...pending, phase: "withdrawn" });
    if (pending.activity) recordOutcome(pending.activity.id, { kind: "withdrawn" });
  }

  function reject() {
    const pending = suggestionRef.current;
    if (pending?.phase !== "reviewing") return;
    updateSuggestion(null);
    if (pending.activity) recordOutcome(pending.activity.id, { kind: "rejected" });
  }

  function changeMaterialView(view: DocxMaterialView) {
    setMaterialView(view);
    if (view !== "working") setOriginalKept(true);
    if (view === "working") setStackForeground("current");
    if (view === "original") setStackForeground("previous");
  }

  async function annotateDocxMaterial(surface: "original" | "working", target?: DocxSelectionAnnotation) {
    annotationCapture.current?.abort();
    const controller = new AbortController();
    annotationCapture.current = controller;
    if (!target) cancelOnUserInteraction(controller);
    let selectionGuard: ReturnType<typeof captureSelectionGuard> = null;
    const metadata = {
      projectId: appProjectId,
      documentId: `docx:${initialProject.current.project_id}`,
      title: (surface === "original" ? initialSourceRef.current : source)?.filename ?? project.name,
    };
    const isCurrent = () => !controller.signal.aborted && useWorkspaceSurfaceStore.getState().active === "word" &&
      (!selectionGuard || selectionGuard.isCurrent());
    try {
      if (surface === "original") {
        const initialSource = initialSourceRef.current;
        if (!initialSource) throw new Error(text.notReady);
        if (target) {
          const editor = originalEditorRef.current?.getEditor();
          if (!editor) throw new Error(text.notReady);
          selectionGuard = captureSelectionGuard(editor, target.line, controller);
          if (!selectionGuard) throw new Error(text.notReady);
        }
        const document = await captureRetainedDocxMaterial(metadata, initialSource.bytes);
        if (isCurrent()) openMaterialAnnotations(document, target?.selection.anchor);
        return;
      }
      const session = sessionRef.current;
      const workingEditor = editorRef.current;
      if (!session || !workingEditor) throw new Error(text.notReady);
      const editor = workingEditor.getEditor();
      if (!editor) throw new Error(text.notReady);
      editor.surface?.flushPendingInput();
      if (target?.revision !== undefined && session.revision() !== target.revision) {
        throw new DocxMaterialCaptureError("revision-changed");
      }
      if (target) {
        selectionGuard = captureSelectionGuard(editor, target.line, controller);
        if (!selectionGuard) throw new Error(text.notReady);
      }
      const capturedIdentity = identityRef.current();
      const captured = await captureWorkingDocxMaterial({ metadata, editor: workingEditor, session });
      if (!isCurrent()) return;
      if (sessionRef.current !== session || editorRef.current !== workingEditor || session.revision() !== captured.sessionRevision) {
        throw new DocxMaterialCaptureError("revision-changed");
      }
      openMaterialAnnotations(captured.document, target?.selection.anchor, {
        wordSessionId: sessionId,
        wordSessionRevision: captured.sessionRevision,
        beforeStartTask: async (taskId) => {
          if (!alive.current || sessionRef.current !== session || session.revision() !== captured.sessionRevision) {
            throw new Error(tEditor(($) => $.editor.materials.captureChanged));
          }
          await bindDocxTask(appProjectId, taskId, sessionId, captured.sessionRevision, capturedIdentity);
        },
      });
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof DocxMaterialCaptureError && cause.code === "revision-changed") {
        throw new Error(tEditor(($) => $.editor.materials.captureChanged));
      }
      if (cause instanceof DocxMaterialCaptureError && cause.code === "not-ready") throw new Error(text.notReady);
      throw cause;
    } finally {
      controller.abort();
      selectionGuard?.stop();
      if (annotationCapture.current === controller) annotationCapture.current = null;
    }
  }

  async function save(expectedRevision?: number, signal?: AbortSignal, operation?: DocxRecoverySaveOperation): Promise<DocxSaveResult | undefined> {
    const session = sessionRef.current;
    const editor = editorRef.current;
    if (!source || !session || !editor || busySave.current || discardingRef.current || checking || recoveryConflict || resuming || !taskReady || saveRefused) {
      if (expectedRevision !== undefined) throw new Error("The DOCX working copy cannot be saved while another document operation is pending.");
      return;
    }
    if (signal?.aborted) throw new Error("The DOCX save was cancelled before it started.");
    if (expectedRevision !== undefined && session.revision() !== expectedRevision) throw new Error("The DOCX session changed before saving.");
    busySave.current = true;
    recoveryEpoch.current += 1;
    setSaving(true);
    setError(null);
    try {
      await recoveryQueueRef.current;
      let request = pendingSave;
      let snapshot = pendingCheckpoint.current;
      if (!request || !snapshot) {
        if (expectedRevision !== undefined && session.revision() !== expectedRevision) {
          throw new Error("The DOCX session changed before saving.");
        }
        const exporting = recoveredBytes.current
          ? Promise.resolve(new Uint8Array(recoveredBytes.current).buffer) : editor.save();
        const exportRevision = session.revision();
        const taskState = taskStateAtExport();
        const bytes = await exporting;
        if (!bytes) throw new Error(text.notReady);
        if (signal?.aborted) throw new Error("The DOCX save was cancelled before the fixed save was created.");
        if (expectedRevision !== undefined && exportRevision !== expectedRevision) {
          throw new Error("The DOCX session changed before saving.");
        }
        request = prepareDocxSave({ ...source, baseline_id: baselineId }, exportRevision, bytes);
        taskState.pendingSave = recoveryPendingSave(request, operation);
        snapshot = { appProjectId, workbenchProjectId: source.project_id, baseBaselineId: baselineId,
          sourceSha256: source.source_sha256, revision: exportRevision, bytes: new Uint8Array(bytes), taskState,
          recoveryKey: "", contentSha256: "", updatedAt: "" };
        pendingCheckpoint.current = snapshot;
        fixedSavePending.current = true;
        setPendingSave(request);
      }
      const committedBytes = base64ToBytes(request.content_base64);
      if (!snapshot.recoveryKey) {
        try {
          const metadata = await queueRecoveryWrite(source, request.expected_baseline_id, request.revision,
            new Uint8Array(committedBytes).buffer, snapshot.taskState);
          snapshot = { ...snapshot, ...metadata };
          pendingCheckpoint.current = snapshot;
        } catch (cause) {
          // Native save writes the checkpoint before replaying its task receipts.
          // A receipt failure can leave the fixed request durably stored already.
          const stored = await readDocxRecovery(snapshot);
          if (stored?.taskState?.pendingSave?.requestId === request.request_id &&
            stored.contentSha256 === await docxContentSha256(committedBytes)) {
            pendingCheckpoint.current = { ...stored, taskState: stored.taskState };
          }
          throw cause;
        }
      }
      const result = await commitDocxRecovery(snapshot);
      if (!alive.current) return;
      if ("refusal" in result) {
        setRefusedSave(`${snapshot.recoveryKey}:${snapshot.contentSha256}`);
        setError(`${text.recovery.saveRefused} (${result.refusal})`);
        return;
      }
      const sourceSha256 = result.sourceSha256;
      setBaselineId(result.baselineId);
      setSource({ ...source, baseline_id: result.baselineId, source_sha256: sourceSha256 });
      setSavedRevision(result.revision);
      identityRef.current = () => ({ sessionId, appProjectId, workbenchProjectId: source.project_id,
        baselineId: result.baselineId, sourceSha256, sessionRevision: session.revision(), savedRevision: result.revision });
      updateDocxAgentSession(sessionId, { baselineId: result.baselineId, savedRevision: result.revision, sourceSha256 });
      // Native commit settles the frozen receipts and appends Saved before answering.
      const frozenReceipts = snapshot.taskState?.receipts ?? [];
      receipts.current = receipts.current.filter((receipt) => !frozenReceipts.some((frozen) =>
        frozen.proposalId === receipt.proposalId && frozen.outcome.kind === receipt.outcome.kind &&
        frozen.document.sessionId === receipt.document.sessionId && frozen.document.sessionRevision === receipt.document.sessionRevision));
      if (!receipts.current.length) setReceiptError(null);
      for (const operation of snapshot.taskState?.operations ?? []) taskOperations.current.delete(operation.operationId);
      pendingCheckpoint.current = null;
      fixedSavePending.current = false;
      setPendingSave(null);
      useDocxWorkspaceStore.getState().saved();
      recoveredBytes.current = undefined;
      setCheck(null);
      try {
        const cleared = await clearDocxRecovery({ appProjectId, workbenchProjectId: source.project_id,
          baseBaselineId: request.expected_baseline_id, sourceSha256: source.source_sha256 }, committedBytes);
        if (!cleared) throw new Error(text.recovery.clearFailed);
      } catch (cause) { if (alive.current) setError(String(cause)); }
      try { await onSavedRef.current(); }
      catch (cause) { if (alive.current) setError(`${text.refreshFailed}: ${String(cause)}`); }
      // The baseline save has committed. A later derivation failure is reported as such.
      let formatStatus: NonNullable<DocxSaveResult["formatStatus"]> = "not_requested";
      let formatError: string | undefined;
      if (world?.template) {
        try { await retainDocxFormat(source.project_id, result.baselineId); }
        catch (cause) { formatError = String(cause); if (alive.current) setError(formatError); }
        formatStatus = formatError ? "failed" : "recorded";
      }
      return { baselineId: result.baselineId, revision: result.revision, sourceSha256, formatStatus, ...(formatError ? { formatError } : {}),
        document: { sessionId, baselineId: result.baselineId, sessionRevision: session.revision(), savedRevision: result.revision, dirty: session.revision() !== result.revision } };
    } catch (cause) {
      if (alive.current) setError(String(cause));
      if (expectedRevision !== undefined) throw cause;
    } finally {
      busySave.current = false;
      if (!fixedSavePending.current) {
        receipts.current.push(...deferredWithdrawals.current);
        deferredWithdrawals.current = [];
      }
      if (alive.current) { setSaving(false); setPendingReceipts(receipts.current.length); }
      if (!fixedSavePending.current && receipts.current.length) checkpointAndFlushReceipts();
    }
  }

  liveSaveRef.current = async ({ expectedRevision, signal, operation }) => {
    const result = await save(expectedRevision, signal, operation);
    if (!result) throw new Error("The fixed DOCX save has not committed. Resolve the displayed save state before retrying.");
    return result;
  };
  livePrepareFontsRef.current = async () => {
    const acquisition = await ensureDocxFonts(world, { isActive: () => alive.current });
    if (!alive.current) throw new Error("The Word working copy closed during font preparation.");
    return { acquisition, ...await refreshFonts() };
  };
  liveExportRef.current = download;
  liveFormatRef.current = async (query) => {
    const session = sessionRef.current;
    const editor = editorRef.current;
    if (!session || !editor || !source) throw new Error(text.notReady);
    formatDocumentRef.current = { sessionId, filename: source.filename, baselineId, savedRevision };
    if (formatReaderRef.current?.session !== session) {
      formatReaderRef.current = { session, read: createDocxFormatReader({
        session, exportBytes: () => editor.save(), document: () => formatDocumentRef.current,
      }) };
    }
    return formatReaderRef.current.read(query);
  };
  liveCheckRef.current = async ({ template, signal }) => {
    if (!source || sessionRef.current?.revision() !== savedRevision) throw new Error("Save the current DOCX working copy before checking it.");
    if (signal?.aborted) throw new Error("The DOCX check was cancelled before it started.");
    const state = await journalRequest<JournalState>("/api/state");
    const current = state.projects.find((item) => item.project_id === source.project_id);
    if (!current || current.baseline_id !== baselineId) throw new Error(text.newBaseline);
    const result = await checkJournalTemplate(current, template, "agent");
    if (alive.current) { setCheck(result); useDocxWorkspaceStore.getState().saved(); await onSavedRef.current(); }
    return { template, check: { ...result } };
  };

  async function checkSaved() {
    if (!source || !world || dirty || saving) return;
    setChecking(true);
    setError(null);
    try {
      const state = await journalRequest<JournalState>("/api/state");
      const current = state.projects.find((item) => item.project_id === source.project_id);
      if (!current || current.baseline_id !== baselineId) throw new Error(text.newBaseline);
      if (world.template) {
        const result = await checkJournalTemplate(current, world.version_id);
        if (alive.current) { setCheck(result); useDocxWorkspaceStore.getState().saved(); await onSavedRef.current(); useWorkspaceSurfaceStore.getState().openJournal(); }
        return;
      }
      if (current.binding?.baseline_id !== baselineId || current.binding.world_version_id !== world.version_id) {
        await journalRequest("/api/bind", {
          project_id: source.project_id, world_version_id: world.version_id,
          expected_binding_id: current.binding?.binding_id ?? null,
        });
      }
      const result = await journalRequest<JournalCheck>("/api/check", { project_id: source.project_id });
      if (result.baseline_id !== baselineId || result.world_version_id !== world.version_id) throw new Error(text.newBaseline);
      if (alive.current) { setCheck(result); useDocxWorkspaceStore.getState().saved(); await onSavedRef.current(); useWorkspaceSurfaceStore.getState().openJournal(); }
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  async function download() {
    setError(null);
    try {
      const editor = editorRef.current;
      const session = sessionRef.current;
      if (!editor || !session || !source) throw new Error(text.notReady);
      const exporting = editor.save();
      const document = identityRef.current();
      const bytes = await exporting;
      if (!bytes) throw new Error(text.notReady);
      const result = await downloadDocxCopy(new Uint8Array(bytes), source.filename);
      return { result, filename: source.filename, sessionId: document.sessionId, sessionRevision: document.sessionRevision,
        byteLength: bytes.byteLength, document };
    } catch (cause) { setError(String(cause)); throw cause; }
  }

  function close() {
    if (closeBlocked) return;
    if (!source && !sessionRef.current) { onClose(); return; }
    if (dirty || streaming || suggestionRef.current?.phase === "reviewing" || pendingSave) setClosePrompt(true);
    else onClose();
  }

  async function discard() {
    if (!source || discardingRef.current || busySave.current || (fixedSavePending.current && !saveRefused)) return;
    discardingRef.current = true;
    recoveryEpoch.current += 1;
    setDiscarding(true);
    setError(null);
    try {
      await recoveryQueueRef.current;
      const pending = suggestionRef.current;
      if (pending?.activity && pending.phase === "reviewing") {
        await settleDocxTaskActivity(appProjectId, source.project_id, pending.activity.id,
          identityRef.current(), { kind: "withdrawn" });
        updateSuggestion({ ...pending, phase: "withdrawn" });
      }
      for (const proposalId of appliedTasks.current.keys()) {
        await settleDocxTaskActivity(appProjectId, source.project_id, proposalId,
          identityRef.current(), { kind: "withdrawn" });
        appliedTasks.current.delete(proposalId);
      }
      while (deferredWithdrawals.current.length) {
        const receipt = deferredWithdrawals.current[0];
        await settleDocxTaskActivity(appProjectId, source.project_id, receipt.proposalId,
          receipt.document, receipt.outcome);
        deferredWithdrawals.current.shift();
      }
      const current = identityRef.current();
      const identity = {
        appProjectId,
        workbenchProjectId: source.project_id,
        baseBaselineId: current.baselineId,
        sourceSha256: current.sourceSha256,
      };
      const snapshot = saveRefused ? pendingCheckpoint.current : await readDocxRecovery(identity);
      if (snapshot) {
        const cleared = saveRefused ? await discardDocxRecovery(snapshot) : await clearDocxRecovery(identity, snapshot.bytes);
        if (!cleared) throw new Error("The DOCX recovery snapshot changed before it could be discarded.");
      }
      onClose();
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      discardingRef.current = false;
      if (alive.current) setDiscarding(false);
    }
  }

  closeAction.current = close;
  const originalInFront = materialView === "original" || (materialView === "compare" && stackForeground === "previous");
  useEffect(() => {
    if (activeSurface !== "word" || originalInFront || showPdf || recoveryConflict || !taskReady) setCapturedEquation(null);
  }, [activeSurface, originalInFront, recoveryConflict, showPdf, taskReady]);
  const annotationView = activeSurface === "word"
    ? `${showPdf ? "pdf" : originalInFront ? "original" : "working"}:${toolsOpen}`
    : null;
  useLayoutEffect(() => {
    if (!annotationView) return;
    return () => annotationCapture.current?.abort();
  }, [annotationView]);
  useLayoutEffect(() => {
    if (feedbackVisible) annotationCapture.current?.abort();
  }, [feedbackVisible]);
  useLayoutEffect(() => {
    if (!toolsOpen) reviewOpener.current = null;
  }, [toolsOpen]);
  const openContextPanel = () => {
    annotationCapture.current?.abort();
    onContextToolActivate?.();
  };
  const workingInFront = activeSurface === "word" && !originalInFront && !showPdf && !recoveryConflict && taskReady;
  const waitingForReview = streaming || suggestion?.phase === "reviewing";
  const focusReview = () => reviewHeading.current?.focus({ preventScroll: true });
  const suggestionActions: SuggestionActions = {
    accept: workingInFront ? () => { focusReview(); accept(); } : undefined,
    reject: () => {
      reject();
      if (reviewOpener.current) closeTools();
      else restoreReviewFocus();
    },
    stop: () => { focusReview(); stop(); },
  };
  function closeTools() {
    const opener = reviewOpener.current;
    reviewOpener.current = null;
    setToolsOpen(false);
    if (workingInFront && opener && editorRef.current?.getEditor() === opener &&
      opener.surface?.activeScope().kind === "body" && opener.focus().ok) return;
    restoreReviewFocus();
  }
  function openSuggestion(opener: DocxEditorInstance | null = null) {
    reviewOpener.current = opener;
    flushSync(() => setToolsOpen(true));
    if (toolsPanel.current) toolsPanel.current.scrollTop = 0;
    focusReview();
  }
  async function revealSuggestion() {
    const pending = suggestionRef.current;
    const paraId = pending?.target.paraId;
    const editor = editorRef.current?.getEditor();
    if (!editor || !paraId || recoveryConflict) return;
    flushSync(() => {
      changeMaterialView("working");
      setShowPdf(false);
    });
    const controller = new AbortController();
    cancelOnUserInteraction(controller);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const interrupted = controller.signal.aborted;
    controller.abort();
    const current = suggestionRef.current;
    if (interrupted || !alive.current || editor !== editorRef.current?.getEditor() || current?.target !== pending.target ||
      (current.phase !== "streaming" && current.phase !== "reviewing") || !useDocxWorkspaceStore.getState().toolsOpen ||
      useWorkspaceSurfaceStore.getState().active !== "word") return;
    if (editor.scrollToAnchor({ paraId })) {
      setToolsOpen(false);
      restoreReviewFocus();
    }
  }
  const pdfDocument = useMemo<MaterialDocument | null>(() => {
    if (!showPdf || !preview?.bytes || preview.error || !source) return null;
    return {
      projectId: appProjectId,
      documentId: `docx-render:${preview.projectId}:${preview.render.baseline_id}:${preview.render.bundle_id}`,
      path: null,
      title: `${source.filename} · ${text.render.title}`,
      kind: "pdf",
      revision: preview.render.manifest.pdf_sha256,
      source: { bytes: preview.bytes, mediaType: "application/pdf" },
    };
  }, [appProjectId, preview, showPdf, source, text.render.title]);
  const pdfDocumentId = pdfDocument?.documentId;
  useEffect(() => () => {
    if (pdfDocumentId) useAgentWorkspaceStore.getState().clearView(appProjectId, pdfDocumentId);
  }, [appProjectId, pdfDocumentId]);
  useEffect(() => {
    if (!source || activeSurface !== "word") return;
    if (showPdf) { useAgentWorkspaceStore.getState().clearView(appProjectId, `docx:${project.project_id}`); return; }
    const initial = initialSourceRef.current;
    const viewRevision = originalInFront ? initial?.source_sha256 : String(revision);
    if (!viewRevision) return;
    const selection = originalInFront ? originalViewSelection : workingViewSelection;
    useAgentWorkspaceStore.getState().publishView({
      projectId: appProjectId, documentId: `docx:${project.project_id}`, title: source.filename,
      kind: "docx", role: originalInFront ? "original" : "working", revision: viewRevision,
      ...(originalInFront ? {} : { sessionId, sessionRevision: revision, dirty }),
      selection: selection?.revision === viewRevision ? selection : null,
    });
  }, [activeSurface, appProjectId, dirty, originalInFront, originalViewSelection, project.project_id, revision,
    sessionId, showPdf, source, workingViewSelection]);

  return <>
      <section
        ref={interactionRoot}
        className="flex h-full min-h-0 min-w-0 flex-col gap-2 p-3"
        aria-label={text.title}
        data-testid="docx-workspace"
        data-docx-history={originalInFront || showPdf ? "readonly" : "working"}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
          <h2 className="mr-auto truncate text-sm font-semibold">{project.name}</h2>
          <span role="status" data-testid="docx-save-state" className={dirty ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>
            {dirty ? text.unsaved : text.saved}
          </span>
          <Button size="sm" variant="outline" onClick={() => {
            handoffToAssistant(t(($) => $.researchTools.workspace.reviewDocumentPrompt, { name: project.name }), { autoSend: false });
          }}>{text.askAgent}</Button>
          <DocxMaterialTools
            view={materialView}
            onViewChange={changeMaterialView}
            disabled={!source}
            onAnnotateWhole={() => annotateDocxMaterial(originalInFront ? "original" : "working")}
          />
          <Button size="sm" variant="outline" disabled={!source || saving || checking || recoveryConflict || resuming || !taskReady || saveRefused || (!dirty && !pendingSave)} onClick={() => void save()}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="mr-1 size-3.5" />}
            {pendingSave ? text.retrySave : text.save}
          </Button>
          <Button size="sm" variant="outline" disabled={!source || saving} onClick={() => void download().catch(() => {})}><Download className="mr-1 size-3.5" />{text.download}</Button>
          <Button size="sm" variant="outline" disabled={!world || !source || dirty || saving || checking || recoveryConflict || !!pendingSave} onClick={() => void checkSaved()}>
            {checking ? <Spinner size="sm" className="mr-1" /> : <Check className="mr-1 size-3.5" />}{text.check}
          </Button>
          {check && <span data-testid="docx-check-validity">{text.checked}: {t(($) => check.validity === "CURRENT" && !dirty && check.baseline_id === baselineId && check.world_version_id === world?.version_id ? $.researchTools.journal.current : $.researchTools.journal.stale)}</span>}
          <Button size="sm" variant="outline" aria-pressed={showPdf} disabled={!source} onClick={() => setShowPdf((value) => !value)}>{showPdf ? t(($) => $.researchTools.workspace.backToDocument) : text.render.open}</Button>
          <Button size="sm" variant="ghost" onClick={() => useWorkspaceSurfaceStore.getState().openJournal()}>{t(($) => $.researchTools.journal.title)}</Button>
          <Button ref={toolsButton} size="sm" variant="ghost" aria-expanded={toolsOpen} aria-controls={toolsId}
            aria-label={t(($) => $.researchTools.workspace.documentTools)}
            data-testid="docx-document-tools" onClick={() => setToolsOpen(!toolsOpen)}>
            <span className="relative mr-1"><PanelRight className="size-3.5" />
              {(waitingForReview || pendingReceipts > 0) && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />}
            </span><span>{t(($) => $.researchTools.workspace.documentTools)}</span>
            {waitingForReview && suggestion && <span className="sr-only" role="status">: {text.phases[suggestion.phase]}</span>}
          </Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label={t(($) => $.researchTools.workspace.closeDocument)} disabled={closeBlocked} onClick={close}><X className="size-3.5" /></Button>
        </div>
        {source && <div className="text-xs text-muted-foreground" data-testid="docx-font-state" data-measurer={fontMeasurement.measurer} data-resolving={fontMeasurement.resolving}>{fontMeasurement.resolving ? t(($) => $.researchTools.workspace.preparingFonts) : fontStatus.missing.length > 0 ? <button type="button" className="text-amber-700 underline dark:text-amber-400" onClick={() => setToolsOpen(true)}>{t(($) => $.researchTools.workspace.missingFonts)}</button> : null}</div>}
        {recovery && <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.docx.recovery.restored, { time: new Date(recovery.updatedAt).toLocaleString(), revision: recovery.revision })}</p>}
        {recoveryConflict && <p role="alert" className="rounded border border-amber-500/40 p-2 text-xs">{text.recovery.conflict}</p>}
        {error && <p role="alert" className="break-words rounded border border-destructive/30 p-2 text-xs text-destructive">{error}</p>}
        <div className="relative grid min-h-0 flex-1 grid-cols-1">
          <div hidden={showPdf} className={showPdf ? "hidden min-h-0" : "flex min-h-0 flex-col"}>
            <div ref={setToolbarTarget} className="shrink-0 border-b bg-background" data-testid="docx-formatting-tools" />
            <WordSurface
              view={materialView}
              onViewChange={changeMaterialView}
              className="h-auto flex-1"
              foreground={stackForeground}
              onForegroundChange={setStackForeground}
              originalLabel={tEditor(($) => $.editor.materials.docxOriginal)}
              workingLabel={tEditor(($) => $.editor.materials.docxWorking)}
              working={<div className="h-full min-h-0 overflow-hidden rounded border bg-muted/20" data-testid="docx-editor-surface"
                onPointerDownCapture={(event) => {
                  if ((event.target as Element).closest(".docx-pages")) returnToBody();
                }}
                onKeyDownCapture={(event) => {
                  if (event.nativeEvent.isComposing || !(event.target as Element).closest(".docx-pages")) return;
                  if (event.key === "F6" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
                    !event.defaultPrevented && workingInFront && waitingForReview) {
                    const editor = editorRef.current?.getEditor();
                    if (editor?.surface?.activeScope().kind !== "body") return;
                    event.preventDefault();
                    event.stopPropagation();
                    openSuggestion(editor);
                  } else if (/^(?:Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|Tab)$/u.test(event.key)) {
                    returnToBody();
                  }
                }}>
              {source ? <WordDocument
                ref={editorRef} document={source.bytes} fonts={fonts} fontShaping={fontShaping} mode="edit" locale={editorLocale.current}
                title={source.filename} author="Oleafly User"
                colorMode="system"
                className="h-full"
                overlay={workingInFront && !toolsOpen && sessionRef.current &&
                  <DocxContextTools working={{ session: sessionRef.current, sessionId, equationDrafts: equationDrafts.current }}
                    onAnnotate={(target) => annotateDocxMaterial("working", target)}
                    feedbackVisible={feedbackVisible}
                    onOpenPanel={openContextPanel}
                    onEquationTargetChange={captureEquationTarget}
                    reviewEntry={!feedbackVisible && waitingForReview && suggestion ? {
                      panel: inlineReview,
                      content: <SuggestionEntry suggestion={suggestion} panel={inlineReview} toolsId={toolsId}
                        onOpen={openSuggestion} onLostFocus={restoreReviewFocus} />,
                    } : undefined} />}
                onFontError={(cause) => setError(`${text.fontError}: ${cause.message}`)}
              ><WordToolbarPortal target={toolbarTarget} disabled={originalInFront || showPdf} labels={{
                toolbar: tEditor(($) => $.editor.wordTools.toolbar),
                undo: tEditor(($) => $.editor.toolbar.undo, { shortcut: "Mod+Z" }),
                redo: tEditor(($) => $.editor.toolbar.redo, { shortcut: "Mod+Shift+Z" }),
                bold: tEditor(($) => $.editor.toolbar.bold), italic: tEditor(($) => $.editor.toolbar.italic),
                fontFamily: tEditor(($) => $.editor.wordTools.fontFamily), fontSize: tEditor(($) => $.editor.wordTools.fontSize),
                mixed: tEditor(($) => $.editor.wordTools.mixed), alignLeft: tEditor(($) => $.editor.wordTools.alignLeft),
                alignCenter: tEditor(($) => $.editor.wordTools.alignCenter), alignRight: tEditor(($) => $.editor.wordTools.alignRight),
                moreTools: tEditor(($) => $.editor.toolbar.moreOptions), fewerTools: tEditor(($) => $.editor.wordTools.fewerTools),
              }} /><SessionBridge onReady={ready} onMeasurement={setFontMeasurement} onSelection={captureWorkingSelection} />
                {workingInFront && waitingForReview && suggestion && <SuggestionHighlight target={suggestion.target} />}
              </WordDocument> : <p className="p-6 text-sm">{text.loading}</p>}
            </div>}
              original={originalKept && initialSourceRef.current ? <div className="h-full min-h-0 overflow-hidden rounded border bg-muted/20" data-testid="docx-original-surface" data-docx-history="readonly">
              <WordDocument
                ref={originalEditorRef} document={initialSourceRef.current.bytes} fonts={fonts}
                fontShaping={fontShaping} mode="view" locale={editorLocale.current}
                title={`${initialSourceRef.current.filename} · ${tEditor(($) => $.editor.materials.docxOriginal)}`}
                colorMode="system" className="h-full"
                overlay={activeSurface === "word" && originalInFront && !showPdf && !toolsOpen &&
                  <DocxContextTools onAnnotate={(target) => annotateDocxMaterial("original", target)}
                    feedbackVisible={feedbackVisible} onOpenPanel={openContextPanel} />}
                onFontError={(cause) => setError(`${text.fontError}: ${cause.message}`)}
              ><ReadOnlySelectionBridge onSelection={captureOriginalSelection} /></WordDocument>
            </div> : null}
            />
          </div>
          {showPdf && <section className="flex min-h-0 flex-col overflow-hidden rounded border" data-testid="docx-render-preview" data-docx-history="readonly">
            <p className="shrink-0 border-b p-2 text-xs text-muted-foreground">{preview?.stale ? text.render.stale : text.render.current}</p>
            <div className="min-h-0 flex-1">
              {preview?.error ? <p role="alert" className="p-4 text-sm text-destructive">{preview.error}</p> : pdfDocument && preview?.bytes ? <MaterialViewContext key={pdfDocument.documentId} document={pdfDocument} active={activeSurface === "word"} materialRole="result"><MaterialPdfView document={pdfDocument} bytes={preview.bytes} /></MaterialViewContext> : <p role="status" className="p-4 text-sm">{text.render.loading}</p>}
            </div>
          </section>}
          <aside ref={toolsPanel} id={toolsId} hidden={!toolsOpen} className="absolute inset-y-0 right-0 z-30 w-72 max-w-full space-y-3 overflow-y-auto rounded-lg border bg-background p-2 shadow-xl" aria-label={t(($) => $.researchTools.workspace.documentTools)} data-docx-history="field"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              closeTools();
            }}>
            {suggestion && <section className="space-y-2 rounded border p-3 text-xs" data-testid="docx-suggestion" aria-labelledby={reviewHeadingId}
              onKeyDown={(event) => {
                if (event.key === "Tab" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
                  tabThroughDocxControls(event.currentTarget, event);
                }
              }}>
              <h3 id={reviewHeadingId} ref={reviewHeading} tabIndex={-1} className="font-medium">{text.phases[suggestion.phase]}</h3>
              {suggestion.activity && <DocxActivitySource activity={suggestion.activity} />}
              <div ref={reviewControls} className="flex flex-wrap items-start gap-1.5">
                <SuggestionControls phase={suggestion.phase} {...suggestionActions} />
                {waitingForReview && !recoveryConflict && suggestion.target.paraId &&
                  <Button ref={revealReviewButton} size="sm" variant="ghost" onClick={() => void revealSuggestion()}><LocateFixed className="mr-1 size-3.5" />{text.revealSuggestion}</Button>}
              </div>
              <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-2 text-muted-foreground">{suggestion.target.original}</blockquote>
              <div className="min-h-8 whitespace-pre-wrap break-words" data-testid="docx-proposed">{suggestion.proposed}</div>
              {suggestion.phase === "withdrawn" && <p>{text.withdrawnHelp}</p>}
              {suggestion.phase === "applied" && <p className="flex items-center gap-1"><Undo2 className="size-3" />{text.undoHelp}</p>}
            </section>}
            <DocxFontsPanel world={world} status={fontStatus} ready={editorReady} onRefresh={async () => { await refreshFonts(); }} />
            {sessionRef.current && <DocxEquationPanel
              active={toolsOpen && workingInFront}
              sessionId={sessionId}
              session={sessionRef.current}
              selection={workingViewSelection}
              pendingWrite={pendingSidebarEquation}
              captured={capturedEquation?.session === sessionRef.current && capturedEquation.sessionId === sessionId &&
                capturedEquation.target.revision === sessionRef.current.revision()
                ? capturedEquation.target : null}
            />}
            {recovery?.taskState && !taskReady && <Button size="sm" variant="outline" disabled={resuming} onClick={() => retryResume.current()}>{text.recovery.restore}</Button>}
            {recoveredActivities.map((activity) => <div key={activity.id} className="rounded border p-2 text-xs" data-testid="docx-recovered-source">
              <p>{text.taskActivity.events.recovered}</p><DocxActivitySource activity={activity} />
            </div>)}
            <DocxTaskActivity projectId={appProjectId} workbenchProjectId={project.project_id} sessionId={taskReady ? sessionId : null} />
            {pendingReceipts > 0 && <div className="space-y-1 text-xs">
              <p role="status">{text.taskActivity.pending}</p>
              {receiptError && <p role="alert" className="break-words text-destructive">{receiptError}</p>}
              <Button ref={retryReceiptButton} size="sm" variant="outline" onClick={checkpointAndFlushReceipts}>{text.taskActivity.retry}</Button>
            </div>}
            <p className="text-[0.6875rem] text-muted-foreground">{text.previewHelp}</p>
            <DocxRenderPanel projectId={project.project_id} baselineId={baselineId} dirty={dirty} fontRevision={fontRevision} fontsReady={editorReady && !fontMeasurement.resolving} enabled={showPdf || toolsOpen} onPreview={setPreview} />
          </aside>
        </div>
      </section>
    <Dialog open={closePrompt} onOpenChange={setClosePrompt}>
      <DialogContent><DialogHeader><DialogTitle>{text.closeTitle}</DialogTitle><DialogDescription>{pendingSave && !saveRefused ? text.pendingSaveHelp : text.closeHelp}</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={discarding} onClick={() => setClosePrompt(false)}>{text.keepEditing}</Button><Button variant="destructive" disabled={discarding || saving || (!saveRefused && (!!pendingSave || pendingReceipts > 0))} onClick={() => void discard()}>{text.discard}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}

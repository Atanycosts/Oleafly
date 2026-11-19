import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDocxEditor, useEditorState, useFonts, useScopedChromeAnchor } from "@docx-editor.dev/react";
import type { DocxEditorInstance, FontMeasurementState } from "@docx-editor.dev/core/editor";
import type { EditorSnapshot } from "@docx-editor.dev/core/contracts/editor";
import type { DocxFormatReadQuery, DocxFormatReadResult, DocxSaveResult, DocxTemplateCheckResult } from "@oleafly/ai-tools";
import { Check, Download, PanelRight, Save, Square, Undo2, X } from "lucide-react";
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
import { DocxEquationPanel } from "./DocxEquationPanel";
import { DocxMaterialTools, type DocxMaterialView } from "@/components/materials/DocxMaterialTools";
import { WordSurface, WordToolbarPortal } from "@/components/materials/WordSurface";
import { WordDocument, type WordDocumentRef } from "@/components/materials/WordDocument";
import type { MaterialVersionSide } from "@/components/materials/MaterialVersionStack";
import {
  captureRetainedDocxMaterial,
  captureWorkingDocxMaterial,
  DocxMaterialCaptureError,
  readDocxMaterialSelection,
  type DocxMaterialSelection,
} from "@/lib/docx-material";
import { registerDocxHistory } from "@/lib/docx-history";
import { openMaterialAnnotations } from "@/store/material-annotations";

const fontShaping = Object.freeze({ maxFontBytes: 64 * 1024 * 1024 });
const RECOVERY_DEBOUNCE_MS = 1500;

interface Props {
  appProjectId: string;
  project: JournalProject;
  world: JournalWorld | null;
  recovery?: DocxRecoverySnapshot;
  onClose(): void;
  onSaved(): Promise<void>;
}

interface Suggestion {
  activity?: DocxActivity;
  target: DocxTarget;
  proposed: string;
  phase: "streaming" | "reviewing" | "withdrawn" | "applied";
}

export function DocxWorkspaceHost() {
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
    {prepared === request && context && <DocxWorkspaceDialog {...request} {...context} onClose={() => useDocxWorkspaceStore.getState().close()} />}
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

const findSuggestionAnchor = (viewport: HTMLElement) => viewport.querySelector<HTMLElement>(".oleafly-docx-target");

function SuggestionOverlay({ suggestion, accept, stop }: { suggestion: Suggestion | null; accept(): void; stop(): void }) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx, { returnObjects: true });
  const anchor = useScopedChromeAnchor(findSuggestionAnchor, "after");
  const visible = suggestion?.phase === "streaming" || suggestion?.phase === "reviewing";
  return <div ref={anchor.ref} style={anchor.style} className="pointer-events-none z-20 w-96" hidden={!visible} data-testid="docx-inline-suggestion">
    {visible && <div className="rounded-lg border border-primary/30 bg-background p-3 text-xs text-foreground shadow-lg">
      <p className="font-medium">{text.phases[suggestion.phase]}</p>
      <p className="my-2 line-clamp-3 whitespace-pre-wrap">{suggestion.proposed || text.loading}</p>
      {suggestion.phase === "reviewing" ? <Button className="pointer-events-auto" size="sm" onClick={accept}>{text.accept}</Button> : <Button className="pointer-events-auto" size="sm" variant="outline" onClick={stop}>{text.stop}</Button>}
    </div>}
  </div>;
}

/** A working copy of a retained baseline; the original author path is never opened for writing. */
export default function DocxWorkspaceDialog({ appProjectId, project, world, recovery, onClose, onSaved }: Props) {
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
  const [workingMaterialSelection, setWorkingMaterialSelection] = useState<DocxMaterialSelection | null>(null);
  const [originalMaterialSelection, setOriginalMaterialSelection] = useState<DocxMaterialSelection | null>(null);
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
  const [toolsOpen, setToolsOpen] = useState(!!recovery?.taskState);
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
  const receiptFailure = useRef<string | null>(null);
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
  const editorRef = useRef<WordDocumentRef>(null);
  const originalEditorRef = useRef<WordDocumentRef>(null);
  const editorInstance = useRef<DocxEditorInstance | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const sessionRef = useRef<DocxSession | null>(null);
  const liveSaveRef = useRef<NonNullable<DocxAgentRegistration["save"]>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const liveCheckRef = useRef<(request: { template: string; signal?: AbortSignal }) => Promise<DocxTemplateCheckResult>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const liveFormatRef = useRef<(query: DocxFormatReadQuery) => Promise<DocxFormatReadResult>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const livePrepareFontsRef = useRef<() => Promise<unknown>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const liveExportRef = useRef<() => Promise<unknown>>(async () => { throw new Error("The DOCX editor is not ready."); });
  const formatReaderRef = useRef<{ session: DocxSession; read: ReturnType<typeof createDocxFormatReader> } | null>(null);
  const formatDocumentRef = useRef({ sessionId: "", filename: "", baselineId: "", savedRevision: 0 });
  const recoveryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recoveryEpoch = useRef(0);
  const [sessionId] = useState(() => `docx:${crypto.randomUUID()}`);
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
  const recordMaterialSelection = useCallback((surface: "working" | "original", selection: DocxMaterialSelection | null) => {
    if (surface === "working") setWorkingMaterialSelection(selection);
    else setOriginalMaterialSelection(selection);
  }, []);
  const captureWorkingSelection = useCallback((editor: DocxEditorInstance, snapshot?: EditorSnapshot) => {
    const current = snapshot ?? editor.snapshot();
    const materialSelection = readDocxMaterialSelection(editor, current);
    recordMaterialSelection("working", materialSelection);
    const selection = current.selection;
    const session = sessionRef.current;
    if (!selection || !session) { setWorkingViewSelection(null); return; }
    const paraId = "paraId" in selection.from && "paraId" in selection.to && selection.from.paraId === selection.to.paraId
      ? selection.from.paraId : undefined;
    const surfaceSelection = editor.surface?.state().selection;
    const collapsedModelOffset = surfaceSelection &&
      surfaceSelection.anchor.paragraphId === surfaceSelection.head.paragraphId &&
      surfaceSelection.anchor.offset === surfaceSelection.head.offset
      ? surfaceSelection.anchor.offset
      : undefined;
    setWorkingViewSelection({ revision: String(session.revision()), paraId,
      ...(collapsedModelOffset === undefined ? {} : { collapsedModelOffset }),
      quote: current.selectionCollapsed ? undefined : materialSelection?.quote ?? editor.query({ type: "selectedText" }) });
  }, [recordMaterialSelection]);
  const captureOriginalSelection = useCallback((editor: DocxEditorInstance) => {
    recordMaterialSelection("original", readDocxMaterialSelection(editor));
    const current = editor.snapshot();
    const selection = current.selection;
    if (!selection || !initialSourceRef.current) { setOriginalViewSelection(null); return; }
    const paraId = "paraId" in selection.from && "paraId" in selection.to && selection.from.paraId === selection.to.paraId
      ? selection.from.paraId : undefined;
    setOriginalViewSelection({ revision: initialSourceRef.current.source_sha256, paraId,
      quote: current.selectionCollapsed ? undefined : editor.query({ type: "selectedText" }) });
  }, [recordMaterialSelection]);
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
      if (alive.current) setPendingReceipts(receipts.current.length);
      if (alive.current && receiptFailure.current) {
        const previousError = receiptFailure.current;
        setError((current) => current === previousError ? null : current);
        receiptFailure.current = null;
      }
    } catch (cause) {
      receiptFailure.current = String(cause);
      if (alive.current) setError(receiptFailure.current);
    }
    finally { receiptWriting.current = false; }
  }, [appProjectId]);
  const recordOutcome = useCallback((proposalId: string, outcome: DocxProposalOutcome, document = identityRef.current()) => {
    if ((busySave.current || fixedSavePending.current) && outcome.kind === "withdrawn") {
      deferredWithdrawals.current.push({ proposalId, document, outcome });
      return;
    }
    receipts.current.push({ proposalId, document, outcome });
    setPendingReceipts(receipts.current.length);
    if (!busySave.current && !fixedSavePending.current) {
      void checkpointCurrent.current().then(flushReceipts).catch((cause) => { if (alive.current) setError(String(cause)); });
    }
  }, [flushReceipts]);

  const updateSuggestion = useCallback((next: Suggestion | null) => {
    suggestionRef.current = next;
    setSuggestion(next);
    if (next?.phase === "streaming" || next?.phase === "reviewing") setToolsOpen(true);
  }, []);

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
  }, [appProjectId, source, taskStateAtExport]);
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
    const session = createDocxSession(editor);
    sessionRef.current = session;
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
      canPresentSuggestion: () => !["streaming", "reviewing"].includes(suggestionRef.current?.phase ?? ""),
      onTaskSuggestion: (activity, target) => {
        if (!alive.current) throw new Error("The DOCX review surface closed.");
        if (target.paraId) editor.highlightAnchor({ paraId: target.paraId }, { className: "oleafly-docx-target", timeoutMs: null });
        updateSuggestion({ target, proposed: activity.event.type === "runtime" && activity.event.event.kind === "proposed" ? activity.event.event.proposed : "", phase: "reviewing", activity });
      },
      onSuggestion: (event) => {
        if (!alive.current) return;
        if (event.phase === "streaming" && stopRef.current !== event.controller) {
          if (suggestionRef.current?.phase === "streaming") throw new Error("A DOCX suggestion is already streaming.");
          stopRef.current = event.controller;
          if (event.target.paraId) editor.highlightAnchor({ paraId: event.target.paraId }, { className: "oleafly-docx-target", timeoutMs: null });
        }
        if (event.phase !== "streaming" && stopRef.current === event.controller) stopRef.current = null;
        updateSuggestion({ target: event.target, proposed: event.proposed, phase: event.phase });
      },
      onApplied: (target, proposed) => {
        if (alive.current) updateSuggestion({ target, proposed, phase: "applied" });
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

  useEffect(() => {
    if (suggestion?.phase !== "streaming" && suggestion?.phase !== "reviewing") editorRef.current?.getEditor()?.clearAnchorHighlight();
  }, [suggestion?.phase]);

  function accept() {
    const session = sessionRef.current;
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
    stopRef.current?.abort();
    const pending = suggestionRef.current;
    if (pending) {
      updateSuggestion({ ...pending, phase: "withdrawn" });
      if (pending.activity) recordOutcome(pending.activity.id, { kind: "withdrawn" });
    }
  }

  function changeMaterialView(view: DocxMaterialView) {
    setMaterialView(view);
    if (view !== "working") setOriginalKept(true);
    if (view === "working") setStackForeground("current");
    if (view === "original") setStackForeground("previous");
  }

  async function annotateDocxMaterial(requireSelection: boolean) {
    const surface = materialView === "original" || (materialView === "compare" && stackForeground === "previous")
      ? "original" : "working";
    const liveEditor = surface === "original" ? originalEditorRef.current?.getEditor() : editorRef.current?.getEditor();
    if (!liveEditor) throw new Error(text.notReady);
    const selection = requireSelection ? readDocxMaterialSelection(liveEditor) : undefined;
    if (requireSelection && !selection) throw new Error(tEditor(($) => $.editor.materials.selectionMissing));
    const metadata = {
      projectId: appProjectId,
      documentId: `docx:${initialProject.current.project_id}`,
      title: (surface === "original" ? initialSourceRef.current : source)?.filename ?? project.name,
    };
    if (surface === "original") {
      const initialSource = initialSourceRef.current;
      if (!initialSource) throw new Error(text.notReady);
      const document = await captureRetainedDocxMaterial(metadata, initialSource.bytes);
      openMaterialAnnotations(document, selection?.anchor);
      return;
    }
    const session = sessionRef.current;
    const workingEditor = editorRef.current;
    if (!session || !workingEditor) throw new Error(text.notReady);
    try {
      const captured = await captureWorkingDocxMaterial({ metadata, editor: workingEditor, session });
      if (sessionRef.current !== session || editorRef.current !== workingEditor || session.revision() !== captured.sessionRevision) {
        throw new DocxMaterialCaptureError("revision-changed");
      }
      const capturedIdentity = identityRef.current();
      openMaterialAnnotations(captured.document, selection?.anchor, {
        beforeStartTask: async (taskId) => {
          if (!alive.current || sessionRef.current !== session || session.revision() !== captured.sessionRevision) {
            throw new Error(tEditor(($) => $.editor.materials.captureChanged));
          }
          await bindDocxTask(appProjectId, taskId, sessionId, captured.sessionRevision, capturedIdentity);
        },
      });
    } catch (cause) {
      if (cause instanceof DocxMaterialCaptureError && cause.code === "revision-changed") {
        throw new Error(tEditor(($) => $.editor.materials.captureChanged));
      }
      if (cause instanceof DocxMaterialCaptureError && cause.code === "not-ready") throw new Error(text.notReady);
      throw cause;
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
        const exporting = recoveredBytes.current
          ? Promise.resolve(new Uint8Array(recoveredBytes.current).buffer) : editor.save();
        const exportRevision = session.revision();
        const taskState = taskStateAtExport();
        const bytes = await exporting;
        if (!bytes) throw new Error(text.notReady);
        if (signal?.aborted) throw new Error("The DOCX save was cancelled before the fixed save was created.");
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
      if (!fixedSavePending.current && receipts.current.length) {
        void checkpointCurrent.current().then(flushReceipts).catch((cause) => { if (alive.current) setError(String(cause)); });
      }
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
      const sessionRevision = session.revision();
      const bytes = await exporting;
      if (!bytes) throw new Error(text.notReady);
      const result = await downloadDocxCopy(new Uint8Array(bytes), source.filename);
      return { result, filename: source.filename, sessionId, sessionRevision, byteLength: bytes.byteLength };
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
  const visibleMaterialSelection = originalInFront ? originalMaterialSelection : workingMaterialSelection;
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
            selectionAvailable={!!visibleMaterialSelection}
            disabled={!source}
            onAnnotateWhole={() => annotateDocxMaterial(false)}
            onAnnotateSelection={() => annotateDocxMaterial(true)}
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
          <Button size="sm" variant="ghost" aria-expanded={toolsOpen} onClick={() => setToolsOpen((value) => !value)}><PanelRight className="mr-1 size-3.5" />{t(($) => $.researchTools.workspace.documentTools)}</Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label={t(($) => $.researchTools.workspace.closeDocument)} disabled={closeBlocked} onClick={close}><X className="size-3.5" /></Button>
        </div>
        {source && <div className="text-xs text-muted-foreground" data-testid="docx-font-state" data-measurer={fontMeasurement.measurer} data-resolving={fontMeasurement.resolving}>{fontMeasurement.resolving ? t(($) => $.researchTools.workspace.preparingFonts) : fontStatus.missing.length > 0 ? <button type="button" className="text-amber-700 underline dark:text-amber-400" onClick={() => setToolsOpen(true)}>{t(($) => $.researchTools.workspace.missingFonts)}</button> : null}</div>}
        {recovery && <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.docx.recovery.restored, { time: new Date(recovery.updatedAt).toLocaleString(), revision: recovery.revision })}</p>}
        {recoveryConflict && <p role="alert" className="rounded border border-amber-500/40 p-2 text-xs">{text.recovery.conflict}</p>}
        {error && <p role="alert" className="break-words rounded border border-destructive/30 p-2 text-xs text-destructive">{error}</p>}
        <div className={`grid min-h-0 flex-1 gap-3 ${toolsOpen ? "grid-cols-[minmax(0,1fr)_16rem] max-lg:grid-cols-[minmax(0,1fr)_13rem]" : "grid-cols-1"}`}>
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
              working={<div className="h-full min-h-0 overflow-hidden rounded border bg-muted/20" data-testid="docx-editor-surface">
              {source ? <WordDocument
                ref={editorRef} document={source.bytes} fonts={fonts} fontShaping={fontShaping} mode="edit" locale={editorLocale.current}
                title={source.filename} author="Oleafly User"
                colorMode="system"
                className="h-full"
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
              }} /><SessionBridge onReady={ready} onMeasurement={setFontMeasurement} onSelection={captureWorkingSelection} /><SuggestionOverlay suggestion={suggestion} accept={accept} stop={stop} /></WordDocument> : <p className="p-6 text-sm">{text.loading}</p>}
            </div>}
              original={originalKept && initialSourceRef.current ? <div className="h-full min-h-0 overflow-hidden rounded border bg-muted/20" data-testid="docx-original-surface" data-docx-history="readonly">
              <WordDocument
                ref={originalEditorRef} document={initialSourceRef.current.bytes} fonts={fonts}
                fontShaping={fontShaping} mode="view" locale={editorLocale.current}
                title={`${initialSourceRef.current.filename} · ${tEditor(($) => $.editor.materials.docxOriginal)}`}
                colorMode="system" className="h-full"
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
          <aside hidden={!toolsOpen} className="min-h-0 space-y-3 overflow-y-auto" aria-label={t(($) => $.researchTools.workspace.documentTools)} data-docx-history="field">
            <DocxFontsPanel world={world} status={fontStatus} ready={editorReady} onRefresh={async () => { await refreshFonts(); }} />
            {sessionRef.current && <DocxEquationPanel
              active={toolsOpen && !originalInFront && !showPdf}
              sessionId={sessionId}
              session={sessionRef.current}
              selection={workingViewSelection}
            />}
            {recovery?.taskState && !taskReady && <Button size="sm" variant="outline" disabled={resuming} onClick={() => retryResume.current()}>{text.recovery.restore}</Button>}
            {recoveredActivities.map((activity) => <div key={activity.id} className="rounded border p-2 text-xs" data-testid="docx-recovered-source">
              <p>{text.taskActivity.events.recovered}</p><DocxActivitySource activity={activity} />
            </div>)}
            <DocxTaskActivity projectId={appProjectId} workbenchProjectId={project.project_id} sessionId={taskReady ? sessionId : null} />
            {pendingReceipts > 0 && <div className="space-y-1 text-xs" role="status">
              <p>{text.taskActivity.pending}</p>
              <Button size="sm" variant="outline" onClick={() => void checkpointCurrent.current().then(flushReceipts).catch((cause) => setError(String(cause)))}>{text.taskActivity.retry}</Button>
            </div>}
            {streaming && <Button size="sm" variant="outline" onClick={stop}><Square className="mr-1 size-3" />{text.stop}</Button>}
            {suggestion && <section className="space-y-2 rounded border p-3 text-xs" data-testid="docx-suggestion">
              {suggestion.activity && <DocxActivitySource activity={suggestion.activity} />}
              <p className="font-medium">{text.phases[suggestion.phase]}</p>
              <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-muted-foreground">{suggestion.target.original}</blockquote>
              <div aria-live="polite" className="min-h-8 whitespace-pre-wrap" data-testid="docx-proposed">{suggestion.proposed}</div>
              {suggestion.phase === "withdrawn" && <p>{text.withdrawnHelp}</p>}
              {suggestion.phase === "reviewing" && <div className="flex gap-2">
                <Button size="sm" onClick={accept}><Check className="mr-1 size-3" />{text.accept}</Button>
                <Button size="sm" variant="ghost" onClick={() => { if (suggestion.activity) recordOutcome(suggestion.activity.id, { kind: "rejected" }); updateSuggestion(null); }}><X className="mr-1 size-3" />{text.reject}</Button>
              </div>}
              {suggestion.phase === "applied" && <p className="flex items-center gap-1"><Undo2 className="size-3" />{text.undoHelp}</p>}
            </section>}
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

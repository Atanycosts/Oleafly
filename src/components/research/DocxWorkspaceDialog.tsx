import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DocxEditor, type DocxEditorRef, useDocxEditor, useEditorState, useFonts, useScopedChromeAnchor } from "@docx-editor.dev/react";
import type { DocxEditorInstance, FontMeasurementState } from "@docx-editor.dev/core/editor";
import { Check, Download, LoaderCircle, Minimize2, Save, Sparkles, Square, Undo2, X } from "lucide-react";
import "@docx-editor.dev/core/styles/editor.css";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { runInlineCompletion } from "@/lib/ai-inline";
import { base64ToBytes } from "@/lib/base64";
import { downloadDocxCopy } from "@/lib/docx-download";
import { createDocxFontResolver, type DocxFontStatus } from "@/lib/docx-fonts";
import { createDocxSession, type DocxParagraph, type DocxSession, type DocxTarget } from "@/lib/docx-session";
import {
  registerDocxAgentSession,
  unregisterDocxAgentSession,
  updateDocxAgentSession,
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
} from "@/lib/docx-recovery";
import { loadDocxSource, prepareDocxSave, type DocxSave, type DocxSource } from "@/lib/docx-workbench";
import { journalRequest, type JournalCheck, type JournalProject, type JournalState, type JournalWorld } from "@/lib/journal-workbench";
import { registerProjectLeaveGuard } from "@/lib/project-leave-guards";
import { registerEditorMutationOwner } from "@/lib/editor-mutation-lease";
import { useDocxWorkspaceStore, type DocxWorkspaceRequest } from "@/store/docx-workspace";
import { handoffToAssistant } from "@/features/assistant-handoff";
import { settleDocxTaskActivity, type DocxActivity, type DocxDocumentIdentity, type DocxProposalOutcome } from "@/lib/docx-task-activity";
import { DocxActivitySource, DocxTaskActivity } from "./DocxTaskActivity";
import { DocxRenderPanel } from "./DocxRenderPanel";
import { DocxFontsPanel } from "./DocxFontsPanel";

const fontShaping = Object.freeze({ maxFontBytes: 64 * 1024 * 1024 });
const RECOVERY_DEBOUNCE_MS = 1500;

interface Props {
  appProjectId: string;
  project: JournalProject;
  world: JournalWorld | null;
  recovery?: DocxRecoverySnapshot;
  onClose(): void;
  onSaved(): Promise<void>;
  minimized?: boolean;
  onMinimize?(): void;
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
  const minimized = useDocxWorkspaceStore((state) => state.minimized);
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
    {prepared === request && context && <DocxWorkspaceDialog {...request} {...context} minimized={minimized} onMinimize={() => useDocxWorkspaceStore.getState().minimize()} onClose={() => useDocxWorkspaceStore.getState().close()} />}
    {error && <Dialog open onOpenChange={() => useDocxWorkspaceStore.getState().close()}><DialogContent><DialogHeader><DialogTitle>{t(($) => $.researchTools.docx.recovery.title)}</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader></DialogContent></Dialog>}
    {minimized && <Button className="fixed bottom-6 right-6 z-40 shadow-lg" onClick={() => useDocxWorkspaceStore.getState().restore()}>{t(($) => $.researchTools.docx.restore)} · {request.project.name}</Button>}
  </> : null;
}

function SessionBridge({ onReady, onMeasurement }: { onReady(editor: DocxEditorInstance): void; onMeasurement(value: FontMeasurementState): void }) {
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
      <p className="font-medium">{`${text.phases[suggestion.phase]} · r${suggestion.target.revision}`}</p>
      <p className="my-2 line-clamp-3 whitespace-pre-wrap">{suggestion.proposed || text.loading}</p>
      {suggestion.phase === "reviewing" ? <Button className="pointer-events-auto" size="sm" onClick={accept}>{text.accept}</Button> : <Button className="pointer-events-auto" size="sm" variant="outline" onClick={stop}>{text.stop}</Button>}
    </div>}
  </div>;
}

/** A working copy of a retained baseline; the original author path is never opened for writing. */
export default function DocxWorkspaceDialog({ appProjectId, project, world, recovery, onClose, onSaved, minimized = false, onMinimize }: Props) {
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const { t, i18n } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx, { returnObjects: true });
  const [source, setSource] = useState<DocxSource | null>(null);
  const initialProject = useRef(project);
  const initialRecovery = useRef(recovery);
  const sourceMismatchMessage = useRef(text.recovery.sourceChanged);
  const editorLocale = useRef(i18n.language);
  const [baselineId, setBaselineId] = useState(recovery?.baseBaselineId ?? project.baseline_id);
  const [error, setError] = useState<string | null>(null);
  const [paragraphs, setParagraphs] = useState<readonly DocxParagraph[]>([]);
  const [selected, setSelected] = useState("");
  const [instruction, setInstruction] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const suggestionRef = useRef<Suggestion | null>(null);
  const [taskReady, setTaskReady] = useState(false);
  const appliedTasks = useRef(new Map<string, DocxRecoveryApplied & { suggestion?: Suggestion }>());
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
  const editorRef = useRef<DocxEditorRef>(null);
  const editorInstance = useRef<DocxEditorInstance | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const sessionRef = useRef<DocxSession | null>(null);
  const recoveryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recoveryEpoch = useRef(0);
  const [sessionId] = useState(() => `docx:${crypto.randomUUID()}`);
  const stopRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const [fontMeasurement, setFontMeasurement] = useState<FontMeasurementState>({ measurer: "fixed", resolving: true });
  const [fontStatus, setFontStatus] = useState<DocxFontStatus>({ probed: false, missing: [], aliases: [] });
  const createFontResolver = () => createDocxFontResolver({
    onError: (cause) => { if (alive.current) setError(`${text.fontError}: ${String(cause)}`); },
    onStatus: (value) => { if (alive.current) setFontStatus(value); },
  });
  const [localFontResolver] = useState(createFontResolver);
  const fonts = useFonts(localFontResolver);
  async function refreshFonts() {
    const editor = editorInstance.current;
    if (editor) await editor.setFonts(createFontResolver());
  }
  const busySave = useRef(false);
  const discardingRef = useRef(false);
  const interactionRoot = useRef<HTMLDivElement>(null);
  identityRef.current = () => {
    if (!source) throw new Error("The DOCX source is not loaded.");
    return { sessionId, appProjectId, workbenchProjectId: project.project_id,
      baselineId, sourceSha256: source.source_sha256, sessionRevision: sessionRef.current?.revision() ?? revision, savedRevision };
  };
  const dirty = revision !== savedRevision;
  const recoveryConflict = !!recovery && project.baseline_id !== recovery.baseBaselineId;
  const streaming = suggestion?.phase === "streaming";
  const saveRefused = !!pendingCheckpoint.current && refusedSave === `${pendingCheckpoint.current.recoveryKey}:${pendingCheckpoint.current.contentSha256}`;

  useEffect(() => {
    const unfinished = dirty || streaming || suggestion?.phase === "reviewing" || !!pendingSave || saving || checking || pendingReceipts > 0;
    const stopLeave = registerProjectLeaveGuard(async (leave) => {
      if (leave.projectId !== appProjectId) return true;
      if (!unfinished) { onClose(); return true; }
      if (!saving && !checking) setClosePrompt(true);
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
            receipts.current.length || deferredWithdrawals.current.length || appliedTasks.current.size ||
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
  }, []);

  useEffect(() => {
    alive.current = true;
    const snapshot = initialRecovery.current;
    void loadDocxSource(initialProject.current.project_id, snapshot?.baseBaselineId ?? initialProject.current.baseline_id)
      .then((value) => {
        if (snapshot && (snapshot.appProjectId !== appProjectId || snapshot.workbenchProjectId !== value.project_id || snapshot.baseBaselineId !== value.baseline_id || snapshot.sourceSha256 !== value.source_sha256)) {
          throw new Error(sourceMismatchMessage.current);
        }
        if (alive.current) setSource(snapshot ? { ...value, bytes: snapshot.bytes } : value);
      })
      .catch((cause) => { if (alive.current) setError(String(cause)); });
    return () => {
      alive.current = false;
      stopRef.current?.abort();
      unsubscribeRef.current?.();
      unregisterDocxAgentSession(sessionId);
      sessionRef.current?.dispose();
    };
  }, [appProjectId, sessionId]);

  const taskStateAtExport = useCallback((): DocxRecoveryTaskState => ({
    document: { ...identityRef.current() },
    applied: [...appliedTasks.current.values()].map(({ proposalId, document }) => ({ proposalId, document: { ...document } })),
    receipts: receipts.current.map((receipt) => ({ ...receipt, document: { ...receipt.document } })),
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
      const current = session.listParagraphs();
      setParagraphs(current);
      setRevision(session.revision());
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
    const selectionChanged = editor.on("selectionChange", (snapshot) => {
      const target = snapshot.selection?.from;
      if (target && "paraId" in target) {
        const paragraph = session.listParagraphs().find((item) => item.paraId === target.paraId);
        if (paragraph) setSelected(paragraph.handle.ref);
      }
    });
    unsubscribeRef.current = () => { documentChanged(); selectionChanged(); };
  }, [appProjectId, sessionId, source?.filename, updateSuggestion, recordOutcome]);

  useEffect(() => {
    if (suggestion?.phase !== "streaming" && suggestion?.phase !== "reviewing") editorRef.current?.getEditor()?.clearAnchorHighlight();
  }, [suggestion?.phase]);

  function reveal(paragraph: DocxParagraph) {
    setSelected(paragraph.handle.ref);
    if (paragraph.paraId) {
      const editor = editorRef.current?.getEditor();
      editor?.scrollToAnchor({ paraId: paragraph.paraId });
      editor?.highlightAnchor({ paraId: paragraph.paraId });
    }
  }

  async function generate() {
    const session = sessionRef.current;
    const paragraph = paragraphs.find((item) => item.handle.ref === selected);
    if (!session || !paragraph || !instruction.trim()) return;
    setError(null);
    const controller = new AbortController();
    stopRef.current = controller;
    let target: DocxTarget | undefined;
    try {
      target = session.captureTarget(paragraph.handle);
      const captured = target;
      if (captured.paraId) editorRef.current?.getEditor()?.highlightAnchor({ paraId: captured.paraId }, { className: "oleafly-docx-target", timeoutMs: null });
      updateSuggestion({ target: captured, proposed: "", phase: "streaming" });
      const index = paragraphs.indexOf(paragraph);
      const proposed = await runInlineCompletion({
        instruction: instruction.trim(), selection: captured.original,
        context: { before: paragraphs[index - 1]?.text ?? "", after: paragraphs[index + 1]?.text ?? "" },
        signal: controller.signal,
        onToken: (full) => {
          const pending = suggestionRef.current;
          if (alive.current && !controller.signal.aborted && pending && pending.target === captured && pending.phase === "streaming") {
            updateSuggestion({ ...pending, proposed: full });
          }
        },
      });
      const pending = suggestionRef.current;
      if (alive.current && !controller.signal.aborted && pending && pending.target === captured && pending.phase === "streaming") {
        updateSuggestion({ target: captured, proposed, phase: "reviewing" });
      }
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) {
        setError(String(cause));
        const pending = suggestionRef.current;
        if (pending && pending.target === target) updateSuggestion({ ...pending, phase: "withdrawn" });
      }
    } finally {
      if (stopRef.current === controller) stopRef.current = null;
    }
  }

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

  async function save() {
    const session = sessionRef.current;
    const editor = editorRef.current;
    if (!source || !session || !editor || busySave.current || checking || recoveryConflict || resuming || !taskReady || saveRefused) return;
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
        request = prepareDocxSave({ ...source, baseline_id: baselineId }, exportRevision, bytes);
        taskState.pendingSave = recoveryPendingSave(request);
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
      pendingCheckpoint.current = null;
      fixedSavePending.current = false;
      setPendingSave(null);
      recoveredBytes.current = undefined;
      setCheck(null);
      try {
        const cleared = await clearDocxRecovery({ appProjectId, workbenchProjectId: source.project_id,
          baseBaselineId: request.expected_baseline_id, sourceSha256: source.source_sha256 }, committedBytes);
        if (!cleared) throw new Error(text.recovery.clearFailed);
      } catch (cause) { if (alive.current) setError(String(cause)); }
      try { await onSavedRef.current(); }
      catch (cause) { if (alive.current) setError(`${text.refreshFailed}: ${String(cause)}`); }
    } catch (cause) {
      if (alive.current) setError(String(cause));
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

  async function checkSaved() {
    if (!source || !world || dirty || saving) return;
    setChecking(true);
    setError(null);
    try {
      const state = await journalRequest<JournalState>("/api/state");
      const current = state.projects.find((item) => item.project_id === source.project_id);
      if (!current || current.baseline_id !== baselineId) throw new Error(text.newBaseline);
      if (current.binding?.baseline_id !== baselineId || current.binding.world_version_id !== world.version_id) {
        await journalRequest("/api/bind", {
          project_id: source.project_id, world_version_id: world.version_id,
          expected_binding_id: current.binding?.binding_id ?? null,
        });
      }
      const result = await journalRequest<JournalCheck>("/api/check", { project_id: source.project_id });
      if (result.baseline_id !== baselineId || result.world_version_id !== world.version_id) throw new Error(text.newBaseline);
      if (alive.current) { setCheck(result); await onSavedRef.current(); }
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  async function download() {
    try {
      const bytes = await editorRef.current?.save();
      if (!bytes || !source) return;
      await downloadDocxCopy(new Uint8Array(bytes), source.filename);
    } catch (cause) { setError(String(cause)); }
  }

  function close() {
    if (saving || checking || (pendingReceipts > 0 && !fixedSavePending.current)) return;
    if (!source && !sessionRef.current) { onClose(); return; }
    if (dirty || streaming || suggestionRef.current?.phase === "reviewing" || pendingSave) setClosePrompt(true);
    else onClose();
  }

  async function discard() {
    if (!source || discardingRef.current || (fixedSavePending.current && !saveRefused)) return;
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

  return <>
    <Dialog modal={false} open={!minimized} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        forceMount
        ref={interactionRoot}
        style={minimized ? { display: "none" } : undefined}
        overlayClassName={minimized ? "hidden" : undefined}
        className="flex h-[94vh] w-[96vw] max-w-none flex-col gap-3 p-4 sm:max-w-none"
        closeDisabled={saving || checking}
        onInteractOutside={(event) => event.preventDefault()}
        data-testid="docx-workspace"
      >
        <DialogHeader className="pr-7">
          <DialogTitle>{text.title} · {project.name}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span role="status" data-testid="docx-save-state" className={dirty ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>
            {`${dirty ? text.unsaved : text.saved} · r${revision}${savedRevision < 0 ? "" : ` / r${savedRevision}`}`}
          </span>
          {onMinimize && <Button size="sm" variant="outline" onClick={onMinimize}><Minimize2 className="mr-1 size-3.5" />{text.minimize}</Button>}
          {onMinimize && <Button size="sm" variant="outline" onClick={() => {
            handoffToAssistant(`Read the active Oleafly DOCX working copy using read_docx_document with session_id ${sessionId}.\n${instruction.trim() || "Review the current manuscript and explain useful next changes."}\nUse the live DOCX tools for paragraph edits and respect the current approval policy. The saved Workbench baseline can be older than the live session.`, { autoSend: false });
            onMinimize();
          }}>{text.askAgent}</Button>}
          <Button size="sm" variant="outline" disabled={!source || saving || checking || recoveryConflict || resuming || !taskReady || saveRefused || (!dirty && !pendingSave)} onClick={() => void save()}>
            {saving ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : <Save className="mr-1 size-3.5" />}
            {pendingSave ? text.retrySave : text.save}
          </Button>
          <Button size="sm" variant="outline" disabled={!source || saving} onClick={() => void download()}><Download className="mr-1 size-3.5" />{text.download}</Button>
          <Button size="sm" variant="outline" disabled={!world || !source || dirty || saving || checking || recoveryConflict || !!pendingSave} onClick={() => void checkSaved()}>
            {checking ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : <Check className="mr-1 size-3.5" />}{text.check}
          </Button>
          {check && <span>{text.checked}: {check.validity} · {check.baseline_id}</span>}
        </div>
        {source && <p className="truncate text-[10px] text-muted-foreground" title={baselineId}>{text.baseline}: {baselineId}</p>}
        {source && <p className="text-xs text-muted-foreground" data-testid="docx-font-state" data-measurer={fontMeasurement.measurer} data-resolving={fontMeasurement.resolving} data-producer={fontMeasurement.producer}>{fontMeasurement.resolving ? text.fontsResolving : fontMeasurement.measurer === "shaped" ? text.fontsShaped : text.fontsFixed}</p>}
        {recovery && <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.docx.recovery.restored, { time: new Date(recovery.updatedAt).toLocaleString(), revision: recovery.revision })}</p>}
        {recoveryConflict && <p role="alert" className="rounded border border-amber-500/40 p-2 text-xs">{text.recovery.conflict}</p>}
        {error && <p role="alert" className="break-words rounded border border-destructive/30 p-2 text-xs text-destructive">{error}</p>}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_18rem] gap-3 max-md:grid-cols-1">
          <div className="min-h-0 overflow-hidden rounded border bg-muted/20" data-testid="docx-editor-surface">
            {source ? <DocxEditor
              ref={editorRef} document={source.bytes} fonts={fonts} fontShaping={fontShaping} mode="edit" locale={editorLocale.current}
              title={source.filename} author="Oleafly User"
              onSave={() => void save()} menu={false} colorMode="system"
              className="h-full"
              onFontError={(cause) => setError(`${text.fontError}: ${cause.message}`)}
            ><SessionBridge onReady={ready} onMeasurement={setFontMeasurement} /><SuggestionOverlay suggestion={suggestion} accept={accept} stop={stop} /></DocxEditor> : <p className="p-6 text-sm">{text.loading}</p>}
          </div>
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto" aria-label={text.work}>
            <DocxFontsPanel world={world} status={fontStatus} ready={editorReady} onRefresh={refreshFonts} />
            {recovery?.taskState && !taskReady && <Button size="sm" variant="outline" disabled={resuming} onClick={() => retryResume.current()}>{text.recovery.restore}</Button>}
            {recoveredActivities.map((activity) => <div key={activity.id} className="rounded border p-2 text-xs" data-testid="docx-recovered-source">
              <p>{text.taskActivity.events.recovered}</p><DocxActivitySource activity={activity} />
            </div>)}
            <DocxTaskActivity projectId={appProjectId} workbenchProjectId={project.project_id} sessionId={taskReady ? sessionId : null} />
            {pendingReceipts > 0 && <div className="space-y-1 text-xs" role="status">
              <p>{text.taskActivity.pending}</p>
              <Button size="sm" variant="outline" onClick={() => void checkpointCurrent.current().then(flushReceipts).catch((cause) => setError(String(cause)))}>{text.taskActivity.retry}</Button>
            </div>}
            <label className="space-y-1 text-xs">
              <span className="font-medium">{text.target}</span>
              <select className="h-9 w-full rounded border bg-background px-2" value={selected} onChange={(event) => {
                const paragraph = paragraphs.find((item) => item.handle.ref === event.target.value);
                if (paragraph) reveal(paragraph);
              }}>
                <option value="">{text.chooseTarget}</option>
                {paragraphs.filter((item) => item.text.trim()).map((item, index) => <option key={item.handle.ref} value={item.handle.ref}>{index + 1}. {item.text.slice(0, 90)}</option>)}
              </select>
            </label>
            <p className="text-[11px] text-muted-foreground">{text.targetHelp}</p>
            <Textarea aria-label={text.instruction} placeholder={text.instruction} rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" disabled={!selected || !instruction.trim() || streaming || suggestion?.phase === "reviewing" || !sessionRef.current} onClick={() => void generate()}><Sparkles className="mr-1 size-3.5" />{text.generate}</Button>
              {streaming && <Button size="sm" variant="outline" onClick={stop}><Square className="mr-1 size-3" />{text.stop}</Button>}
            </div>
            {suggestion && <section className="space-y-2 rounded border p-3 text-xs" data-testid="docx-suggestion">
              {suggestion.activity && <DocxActivitySource activity={suggestion.activity} />}
              <p className="font-medium">{`${text.phases[suggestion.phase]} · r${suggestion.target.revision}`}</p>
              <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-muted-foreground">{suggestion.target.original}</blockquote>
              <div aria-live="polite" className="min-h-8 whitespace-pre-wrap" data-testid="docx-proposed">{suggestion.proposed}</div>
              {suggestion.phase === "withdrawn" && <p>{text.withdrawnHelp}</p>}
              {suggestion.phase === "reviewing" && <div className="flex gap-2">
                <Button size="sm" onClick={accept}><Check className="mr-1 size-3" />{text.accept}</Button>
                <Button size="sm" variant="ghost" onClick={() => { if (suggestion.activity) recordOutcome(suggestion.activity.id, { kind: "rejected" }); updateSuggestion(null); }}><X className="mr-1 size-3" />{text.reject}</Button>
              </div>}
              {suggestion.phase === "applied" && <p className="flex items-center gap-1"><Undo2 className="size-3" />{text.undoHelp}</p>}
            </section>}
            <p className="text-[11px] text-muted-foreground">{text.previewHelp}</p>
            <DocxRenderPanel projectId={project.project_id} baselineId={baselineId} dirty={dirty} />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={closePrompt} onOpenChange={setClosePrompt}>
      <DialogContent><DialogHeader><DialogTitle>{text.closeTitle}</DialogTitle><DialogDescription>{pendingSave && !saveRefused ? text.pendingSaveHelp : text.closeHelp}</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={discarding} onClick={() => setClosePrompt(false)}>{text.keepEditing}</Button><Button variant="destructive" disabled={discarding || (!saveRefused && (!!pendingSave || pendingReceipts > 0))} onClick={() => void discard()}>{text.discard}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}

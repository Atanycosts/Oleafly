import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModalShell } from "@/components/ui/modal-shell";
import { TaskAnnotations } from "@/components/research/tasks/TaskAnnotations";
import { describeError } from "@/lib/app-error";
import { formatDateTime } from "@/lib/intl";
import { captureAssistantTarget } from "@/lib/assistant-delegation-capture";
import { createPdfReviewTask, listPdfSelections, pdfSelectionInput, readPdfSelection, savePdfSelection, startPdfReviewTask, type FrozenPdfSelection } from "@/lib/pdf-selection";
import type { ResearchTask } from "@/lib/research-tasks";
import { useResearchTasksStore } from "@/store/research-tasks";
import { useSettingsStore } from "@/store/settings";
import type { TaskAnnotation } from "@/lib/task-collaboration";
import { PdfSelectionDocument } from "./PdfSelectionDocument";

export function PdfSelectionDialog({ projectId, frozen, onClose }: Readonly<{ projectId: string; frozen: FrozenPdfSelection | null; onClose: () => void }>) {
  const { t } = useTranslation(["common", "preview"]);
  const bodyId = useId();
  const [records, setRecords] = useState<TaskAnnotation[]>([]);
  const [selected, setSelected] = useState<TaskAnnotation | null>(null);
  const [body, setBody] = useState("");
  const [bytes, setBytes] = useState<Uint8Array | null>(frozen?.bytes ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [savedNow, setSavedNow] = useState(false);
  const [reviewTask, setReviewTask] = useState<ResearchTask | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void listPdfSelections(projectId).then((rows) => { if (active) setRecords(rows); })
      .catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    setShowOriginal(false);
    if (!selected) return;
    setBytes(null);
    void readPdfSelection(projectId, selected.id).then((data) => { if (active) setBytes(new Uint8Array(data)); })
      .catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [projectId, selected]);
  const input = selected ? pdfSelectionInput(selected) : frozen ? {
    projectId: frozen.projectId, mainDocument: frozen.mainDocument, checkpoint: frozen.checkpoint,
    selection: frozen.selection, pdfSha256: "", size: frozen.bytes.byteLength,
  } : null;
  const saveOrReview = async (review: boolean, request = body, propagateError = false) => {
    if (!request.trim() || busy || (!selected && !frozen)) return;
    setBusy(true); setError(null);
    try {
      const target = review && !reviewTask ? await captureAssistantTarget(projectId) : null;
      const annotation = selected ?? await savePdfSelection(frozen as FrozenPdfSelection, request);
      if (mounted.current && !selected) { setSelected(annotation); setSavedNow(true); setRecords((rows) => [annotation, ...rows]); }
      if (review) {
        const task = reviewTask ?? await createPdfReviewTask(annotation, request, target as NonNullable<typeof target>);
        if (mounted.current) setReviewTask(task);
        await startPdfReviewTask(task);
        if (mounted.current) onClose();
      }
    } catch (cause) { if (mounted.current) setError(describeError(cause)); if (propagateError) throw cause; }
    finally { if (mounted.current) setBusy(false); }
  };
  return <ModalShell open onClose={onClose} closeLabel={t(($) => $.common.actions.close)} width="2xl" portal
    labelledBy="pdf-selection-title" testId="pdf-selection-dialog" className="max-h-[92vh] overflow-auto p-5">
    <header className="mb-3 flex items-center justify-between gap-3">
      <h2 id="pdf-selection-title" className="text-base font-semibold">{t(($) => $.preview.selection.title)}</h2>
      <Button variant="ghost" size="icon" onClick={onClose} aria-label={t(($) => $.common.actions.close)}><X className="size-4" /></Button>
    </header>
    <p className="mb-4 text-xs text-muted-foreground">{t(($) => $.preview.selection.description)}</p>
    {input ? <div className="space-y-3">
      <PdfSelectionDocument input={input} bytes={showOriginal ? bytes : null} />
      <Button variant="outline" size="sm" disabled={!bytes} onClick={() => setShowOriginal((value) => !value)}>{t(($) => $.preview.selection.openOriginal)}</Button>
      <label htmlFor={bodyId} className="block space-y-1 text-sm">
        <span>{t(($) => $.preview.selection.comment)}</span>
        <Textarea id={bodyId} data-modal-initial-focus value={body} onChange={(event) => setBody(event.target.value)} rows={3} disabled={busy || !!reviewTask} />
      </label>
      <div className="flex flex-wrap gap-2">
        {!selected && <Button variant="outline" disabled={busy || !body.trim()} onClick={() => void saveOrReview(false)}>{t(($) => $.preview.selection.saveFeedback)}</Button>}
        <Button disabled={busy || !body.trim()} onClick={() => void saveOrReview(true)}>{busy ? t(($) => $.common.state.loading) : reviewTask ? t(($) => $.preview.selection.retryStart) : t(($) => $.preview.selection.startReview)}</Button>
      </div>
      {savedNow && !reviewTask && <p role="status" className="text-xs text-muted-foreground">{t(($) => $.preview.selection.savedNotice)}</p>}
      {reviewTask && <Button variant="link" onClick={() => { useResearchTasksStore.getState().openTaskDetail(reviewTask.id); useSettingsStore.getState().setRailTab("research"); onClose(); }}>
        {t(($) => $.preview.selection.openTask)} · {reviewTask.title}
      </Button>}
      {selected && !busy && !reviewTask && <TaskAnnotations contextScope="object" objectTarget={selected.target} source={selected.source ?? undefined}
        onOpenTarget={() => setShowOriginal(true)} onExplicitRequest={async (request) => {
          setBody(request); await saveOrReview(true, request, true);
        }} />}
    </div> : <p className="mb-4 text-sm text-muted-foreground">{t(($) => $.preview.selection.selectHint)}</p>}
    {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    <section className="mt-5 space-y-2 border-t pt-4" aria-label={t(($) => $.preview.selection.saved)}>
      <h3 className="text-sm font-medium">{t(($) => $.preview.selection.saved)}</h3>
      {!records.length && <p className="text-xs text-muted-foreground">{t(($) => $.preview.selection.empty)}</p>}
      {records.map((annotation) => <Button key={annotation.id} variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" disabled={busy || !!reviewTask}
        onClick={() => { setSelected(annotation); setBody(annotation.body); setSavedNow(false); setReviewTask(null); setError(null); }}>
        <span className="min-w-0"><span className="block text-xs text-muted-foreground">{formatDateTime(annotation.createdAt)} · {annotation.target.path}</span><span className="line-clamp-2 break-words">{annotation.body}</span></span>
      </Button>)}
    </section>
  </ModalShell>;
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PdfSelectionDocument } from "@/components/preview/PdfSelectionDocument";
import { describeError } from "@/lib/app-error";
import { loadTaskPdfSelection, type RetainedPdfSelection } from "@/lib/pdf-selection";
import { readTaskCompiledPdf } from "@/lib/research-tasks";

export function TaskPdfSelection({ taskId, openOriginal = false }: Readonly<{ taskId: string; openOriginal?: boolean }>) {
  const { t } = useTranslation("preview");
  const [record, setRetained] = useState<RetainedPdfSelection | null>(null);
  const retained = record?.reference.taskId === taskId ? record : null;
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [show, setShow] = useState(openOriginal);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setRetained(null); setBytes(null); setError(null);
    void loadTaskPdfSelection(taskId).then((value) => { if (active) setRetained(value); })
      .catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [taskId]);
  useEffect(() => { if (openOriginal) setShow(true); }, [openOriginal]);
  useEffect(() => {
    if (!show || !retained) return;
    let active = true;
    void readTaskCompiledPdf(taskId, 0, retained.reference).then((value) => { if (active) setBytes(new Uint8Array(value)); })
      .catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [show, taskId, retained]);
  if (!retained && !error) return null;
  return <section data-testid="task-pdf-selection" className="space-y-3 rounded-md border p-3" aria-label={t(($) => $.preview.selection.taskInput)}>
    <h4 className="text-sm font-medium">{t(($) => $.preview.selection.taskInput)}</h4>
    {retained && <>
      <PdfSelectionDocument input={retained.input} bytes={show ? bytes : null} />
      <p className="break-all text-xs text-muted-foreground">{t(($) => $.preview.selection.annotation)}: {retained.originalAnnotationId}</p>
      <Button variant="outline" size="sm" onClick={() => setShow((value) => !value)}>{t(($) => $.preview.selection.openOriginal)}</Button>
    </>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
  </section>;
}

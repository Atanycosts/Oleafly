import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PdfViewer, type PdfViewerHandle } from "@/components/pdf/PdfViewer";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readRetainedPaperPdf, type RetainedPaperReference } from "@/lib/research-literature";

export function RetainedPaperPreview({ reference, pageStart, pageEnd, pageCount }: Readonly<{
  reference: RetainedPaperReference;
  pageStart?: number;
  pageEnd?: number;
  pageCount?: number;
}>) {
  const { t } = useTranslation("ai");
  const [open, setOpen] = useState(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewer = useRef<PdfViewerHandle>(null);
  const { projectId, path, pdfSha256 } = reference;
  useEffect(() => {
    setBytes(null);
    setError(null);
    if (!open) return;
    let active = true;
    void readRetainedPaperPdf({ projectId, path, pdfSha256 })
      .then((value) => { if (active) setBytes(new Uint8Array(value)); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [open, projectId, path, pdfSha256]);
  return <>
    <button type="button" className="rounded px-1.5 py-1 text-[0.625rem] font-medium hover:bg-accent" onClick={() => setOpen(true)}>
      {t(($) => $.ai.paperReader.openPdf)}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[85vh] max-w-4xl flex-col" data-testid="retained-paper-preview">
        <DialogHeader>
          <DialogTitle>{t(($) => $.ai.paperReader.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.ai.paperReader.description)}</DialogDescription>
        </DialogHeader>
        <p className="break-all font-mono text-xs">{t(($) => $.ai.paperReader.hash, { hash: reference.pdfSha256 })}</p>
        {pageStart !== undefined && <p className="text-xs">{t(($) => $.ai.paperReader.pages, { start: pageStart, end: pageEnd ?? pageStart, total: pageCount })}</p>}
        {error ? <p role="alert" className="select-text text-sm text-destructive">{error}</p> : bytes ?
          <div className="relative min-h-0 flex-1 overflow-auto" data-pdf-scroll-root>
            <PdfViewer ref={viewer} data={bytes} documentIdentity={`paper:${reference.projectId}:${reference.pdfSha256}`} registerGlobalController={false} scale={1}
              onLoadStateChange={(state) => { if (state.status === "ready") viewer.current?.gotoPage(pageStart ?? 1); }} />
          </div> : <p role="status" className="text-sm text-muted-foreground">{t(($) => $.ai.paperReader.loading)}</p>}
      </DialogContent>
    </Dialog>
  </>;
}

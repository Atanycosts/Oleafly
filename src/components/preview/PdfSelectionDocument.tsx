import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { PdfViewer, type PdfViewerHandle } from "@/components/pdf/PdfViewer";
import type { PdfSelectionInput } from "@/lib/pdf-selection";

export function PdfSelectionDocument({ input, bytes }: Readonly<{ input: PdfSelectionInput; bytes: Uint8Array | null }>) {
  const { t } = useTranslation("preview");
  const viewer = useRef<PdfViewerHandle>(null);
  return <div className="min-w-0 space-y-2" data-testid="pdf-selection-document">
    <p className="text-xs text-muted-foreground">{t(($) => $.preview.selection.pages, { pages: input.selection.pages.map((page) => page.page).join(", ") })} · {input.mainDocument}</p>
    <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border-l-2 bg-muted/40 p-3 text-sm">{input.selection.text}</blockquote>
    {input.pdfSha256 && <p className="break-all font-mono text-[0.6875rem] text-muted-foreground">{t(($) => $.preview.selection.pdfSha256, { sha256: input.pdfSha256 })}</p>}
    {bytes && <div className="relative h-96 overflow-auto rounded-md border" data-pdf-scroll-root>
      <PdfViewer ref={viewer} data={bytes} documentIdentity={`retained:${input.pdfSha256}`} rotation={input.selection.rotation} scale={1}
        onLoadStateChange={(state) => { if (state.status === "ready") viewer.current?.gotoPage(input.selection.pages[0].page); }} />
    </div>}
  </div>;
}

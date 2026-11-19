import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { PdfViewer, type PdfViewerHandle } from "@/components/pdf/PdfViewer";
import { Button } from "@/components/ui/button";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { useMaterialViewSelection } from "./MaterialViewContext";

export function MaterialPdfActions({ document, viewer, page = 1 }: {
  document: MaterialDocument;
  viewer: RefObject<PdfViewerHandle | null>;
  page?: number;
}) {
  const { t } = useTranslation("editor");
  const [missing, setMissing] = useState(false);
  const annotateSelection = () => {
    const selection = viewer.current?.getTextSelection();
    setMissing(!selection);
    if (!selection) return;
    openMaterialAnnotations(document, { kind: "pdf", pages: selection.pages, quote: selection.text, rotation: selection.rotation });
  };
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
    <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(document)}>{t(($) => $.editor.materials.annotateWhole)}</Button>
    <Button size="xs" variant="outline" onMouseDown={(event) => event.preventDefault()} onClick={annotateSelection}>{t(($) => $.editor.materials.annotateSelection)}</Button>
    <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(document, { kind: "page", page, rects: [] })}>{t(($) => $.editor.materials.annotatePage)}</Button>
    {missing && <span role="status" className="text-xs text-muted-foreground">{t(($) => $.editor.materials.selectionMissing)}</span>}
  </div>;
}

export function MaterialPdfSelection({ viewer, page, children }: { viewer: RefObject<PdfViewerHandle | null>; page: number; children: ReactNode }) {
  const [selection, setSelection] = useState<MaterialAnchor | null>(null);
  useMaterialViewSelection(useMemo(() => selection ?? { kind: "page", page, rects: [] }, [selection, page]));
  const capture = () => {
    const selected = viewer.current?.getTextSelection?.();
    setSelection(selected ? { kind: "pdf", pages: selected.pages, quote: selected.text, rotation: selected.rotation } : null);
  };
  return <div className="contents" onMouseUp={capture} onKeyUp={capture}>{children}</div>;
}

export function MaterialPdfView({ document, bytes, initialPage = 1, onPageChange, anchor }: {
  document: MaterialDocument;
  bytes: Uint8Array;
  initialPage?: number;
  onPageChange?: (page: number) => void;
  anchor?: MaterialAnchor;
}) {
  const viewer = useRef<PdfViewerHandle>(null);
  const [page, setPage] = useState(initialPage);
  const [selection, setSelection] = useState<MaterialAnchor | null>(anchor ?? null);
  useMaterialViewSelection(selection);
  const capture = () => {
    const selected = viewer.current?.getTextSelection();
    setSelection(selected ? { kind: "pdf", pages: selected.pages, quote: selected.text, rotation: selected.rotation } : null);
  };
  return <div className="flex h-full min-h-0 flex-col" onMouseUp={capture} onKeyUp={capture}>
    <MaterialPdfActions document={document} viewer={viewer} page={page} />
    <div className="relative min-h-0 flex-1 overflow-auto" data-pdf-scroll-root>
      <PdfViewer ref={viewer} data={bytes} documentIdentity={`${document.documentId}:${document.revision}`}
        registerGlobalController={false} scale={1} rotation={anchor?.kind === "pdf" ? anchor.rotation : 0}
        onLoadStateChange={(state) => { if (state.status === "ready") viewer.current?.gotoPage(initialPage); }}
        onPageChange={(next) => { setPage(next); setSelection({ kind: "page", page: next, rects: [] }); onPageChange?.(next); }} />
    </div>
  </div>;
}

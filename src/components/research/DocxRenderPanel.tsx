import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { FileText, RefreshCw, X } from "lucide-react";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ensureDocxRender, findDocxRenderer, loadDocxPdf, type DocxRender } from "@/lib/docx-render";

export interface DocxRenderPreview {
  projectId: string;
  render: DocxRender;
  bytes: Uint8Array | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  close(): void;
}

export function DocxRenderPanel({ projectId, baselineId, dirty, fontRevision = 0, fontsReady = true, enabled = true, onPreview }: {
  projectId: string;
  baselineId: string;
  dirty: boolean;
  fontRevision?: number;
  fontsReady?: boolean;
  enabled?: boolean;
  onPreview?(preview: DocxRenderPreview | null): void;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.render, { returnObjects: true });
  const workspace = t(($) => $.researchTools.workspace, { returnObjects: true });
  const [executable, setExecutable] = useState("");
  const [auto, setAuto] = useState(true);
  const [rendererUnavailable, setRendererUnavailable] = useState(false);
  const [shown, setShown] = useState<DocxRender | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled || executable || rendererUnavailable) return;
    let active = true;
    void findDocxRenderer()
      .then((path) => {
        if (!active) return;
        if (path) setExecutable(path);
        else setRendererUnavailable(true);
      })
      .catch(() => { if (active) setRendererUnavailable(true); });
    return () => { active = false; };
  }, [enabled, executable, rendererUnavailable]);
  const render = useQuery({
    queryKey: ["docx-render", projectId, baselineId, executable, fontRevision, refreshRevision],
    queryFn: () => ensureDocxRender(projectId, baselineId, executable, fontRevision > 0 || refreshRevision > 0),
    enabled: enabled && auto && executable !== "" && fontsReady,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  useEffect(() => { if (render.data) setShown(render.data); }, [render.data]);
  const pdf = useQuery({
    queryKey: ["docx-render-pdf", projectId, shown?.bundle_id],
    queryFn: () => {
      if (!shown) throw new Error("Choose a retained DOCX render first.");
      return loadDocxPdf(projectId, shown);
    },
    enabled: enabled && (open || !!onPreview) && shown !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const stale = shown !== null && (shown.baseline_id !== baselineId || dirty || render.data !== shown || render.isFetching || render.isError);
  const emitPreview = useCallback(() => {
    if (!onPreview) return;
    onPreview(shown ? {
      projectId,
      render: shown,
      bytes: pdf.data ?? null,
      loading: pdf.isLoading || pdf.isFetching,
      error: pdf.error ? workspace.docxRender.loadFailed : null,
      stale,
      close: () => setShown(null),
    } : null);
  }, [onPreview, pdf.data, pdf.error, pdf.isFetching, pdf.isLoading, projectId, shown, stale, workspace.docxRender.loadFailed]);
  useEffect(() => {
    emitPreview();
  }, [emitPreview]);
  useEffect(() => () => onPreview?.(null), [onPreview]);
  return <section className="space-y-2 rounded border p-3 text-xs" aria-label={text.title}>
    <div className="flex items-center justify-between gap-2">
      <strong>{text.title}</strong>
      {render.isFetching && <Spinner size="sm" aria-label={text.rendering} />}
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />{text.auto}</label>
    {(rendererUnavailable || (!executable && render.isFetched)) && <p className="text-muted-foreground">{text.unavailable}</p>}
    {render.error && <p role="alert" data-testid="docx-render-error" className="break-words text-destructive">{workspace.docxRender.renderFailed}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!executable || render.isFetching} onClick={() => {
        setAuto(true);
        setRefreshRevision((revision) => revision + 1);
      }}><RefreshCw className="mr-1 size-3" />{text.refresh}</Button>
      {!onPreview && <Button size="sm" variant="outline" disabled={!shown} onClick={() => setOpen(true)}><FileText className="mr-1 size-3" />{text.open}</Button>}
    </div>
    {shown && <>
      <p className={stale ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"} data-testid="docx-render-state">{stale ? text.stale : text.current} · {shown.manifest.page_count} {text.pages}</p>
      <p className="text-[0.625rem] text-muted-foreground">
        {t(($) => $.researchTools.workspace.docxRender.generatedBy, {
          engine: shown.manifest.render_record.renderer_engine || shown.manifest.render_record.renderer_version,
        })}
      </p>
    </>}
    <p className="text-[0.625rem] text-muted-foreground">{text.help}</p>
    {open && shown && <section className="flex h-[70vh] min-h-80 flex-col overflow-hidden rounded border" data-testid="docx-render-preview">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div>
          <p className="font-medium">{text.title}</p>
          <p className="text-muted-foreground">{stale ? text.stale : text.current}</p>
        </div>
        <Button size="sm" variant="ghost" aria-label={workspace.docxRender.close} onClick={() => setOpen(false)}><X className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        {pdf.error ? <p role="alert" className="text-sm text-destructive">{String(pdf.error)}</p> : pdf.data && shown ? <div className="relative min-h-0 flex-1 overflow-auto" data-pdf-scroll-root>
          <PdfViewer data={pdf.data} documentIdentity={`docx-render:${shown.bundle_id}`} registerGlobalController={false} scale={1} />
        </div> : <p role="status">{text.loading}</p>}
      </div>
    </section>}
  </section>;
}

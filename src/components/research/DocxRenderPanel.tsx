import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { FileText, LoaderCircle, RefreshCw } from "lucide-react";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ensureDocxRender, findDocxRenderer, loadDocxPdf, type DocxRender } from "@/lib/docx-render";
import { pickOpenPaths } from "@/lib/tauri";

export function DocxRenderPanel({ projectId, baselineId, dirty, fontRevision = 0, fontsReady = true }: {
  projectId: string;
  baselineId: string;
  dirty: boolean;
  fontRevision?: number;
  fontsReady?: boolean;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.render, { returnObjects: true });
  const [executable, setExecutable] = useState("");
  const [auto, setAuto] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<DocxRender | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    void findDocxRenderer()
      .then((path) => { if (active && path) setExecutable(path); })
      .catch((error: unknown) => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, []);
  const render = useQuery({
    queryKey: ["docx-render", projectId, baselineId, executable, fontRevision, refreshRevision],
    queryFn: () => ensureDocxRender(projectId, baselineId, executable, fontRevision > 0 || refreshRevision > 0),
    enabled: auto && executable !== "" && fontsReady,
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
    enabled: open && shown !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const stale = shown !== null && (shown.baseline_id !== baselineId || dirty || render.data !== shown || render.isFetching || render.isError);
  return <section className="space-y-2 rounded border p-3 text-xs" aria-label={text.title}>
    <div className="flex items-center justify-between gap-2">
      <strong>{text.title}</strong>
      {render.isFetching && <LoaderCircle className="size-3.5 animate-spin" aria-label={text.rendering} />}
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />{text.auto}</label>
    <details>
      <summary className="cursor-pointer text-muted-foreground">{text.engine}</summary>
      <Input className="my-2 h-8 text-xs" aria-label={text.executable} value={executable} placeholder={text.executable} onChange={(event) => { setAuto(false); setExecutable(event.target.value); }} />
      <Button size="sm" variant="outline" onClick={() => {
        void pickOpenPaths({ title: text.executable }).then((paths) => {
          if (paths?.[0]) { setExecutable(paths[0]); setAuto(true); }
        }).catch((error: unknown) => setNotice(String(error)));
      }}>{text.browse}</Button>
    </details>
    {!executable && <p className="text-muted-foreground">{text.unavailable}</p>}
    {(notice || render.error) && <p role="alert" className="break-words text-destructive">{notice ?? String(render.error)}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!executable || render.isFetching} onClick={() => {
        setAuto(true);
        setRefreshRevision((revision) => revision + 1);
      }}><RefreshCw className="mr-1 size-3" />{text.refresh}</Button>
      <Button size="sm" variant="outline" disabled={!shown} onClick={() => setOpen(true)}><FileText className="mr-1 size-3" />{text.open}</Button>
    </div>
    {shown && <>
      <p className={stale ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"} data-testid="docx-render-state">{stale ? text.stale : text.current} · {shown.manifest.page_count} {text.pages}</p>
      <p className="break-all text-[10px] text-muted-foreground">{shown.manifest.render_record.renderer_version} · {shown.baseline_id}</p>
    </>}
    <p className="text-[10px] text-muted-foreground">{text.help}</p>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[88vh] max-w-5xl flex-col" data-testid="docx-render-preview">
        <DialogHeader><DialogTitle>{text.title}</DialogTitle><DialogDescription>{stale ? text.stale : text.current} · {shown?.baseline_id}</DialogDescription></DialogHeader>
        {pdf.error ? <p role="alert" className="text-sm text-destructive">{String(pdf.error)}</p> : pdf.data && shown ? <div className="relative min-h-0 flex-1 overflow-auto" data-pdf-scroll-root>
          <PdfViewer data={pdf.data} documentIdentity={`docx-render:${shown.bundle_id}`} registerGlobalController={false} scale={1} />
        </div> : <p role="status">{text.loading}</p>}
      </DialogContent>
    </Dialog>
  </section>;
}

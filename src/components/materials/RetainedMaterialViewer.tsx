import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Eye, MessageSquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState, LoadingState } from "@/components/ui/empty";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MaterialVersionStack } from "./MaterialVersionStack";
import { MaterialPdfView } from "./MaterialPdfView";
import { MaterialImageView } from "./MaterialImageView";
import { MaterialViewContext } from "./MaterialViewContext";
import { createMaterialDocument, type MaterialDocument } from "@/lib/material-surface";
import { imageMime } from "@/lib/image-mime";
import { describeError } from "@/lib/app-error";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { useMaterialViewerStore, type MaterialViewerRequest, type MaterialViewVersion } from "@/store/material-viewer";

const RetainedDocxView = lazy(() => import("./RetainedDocxView").then((module) => ({ default: module.RetainedDocxView })));
const RetainedSourceView = lazy(() => import("./RetainedSourceView").then((module) => ({ default: module.RetainedSourceView })));
const RetainedDiagramView = lazy(() => import("./RetainedDiagramView").then((module) => ({ default: module.RetainedDiagramView })));
const MaterialHtmlView = lazy(() => import("./MaterialHtmlView").then((module) => ({ default: module.MaterialHtmlView })));
const MarkdownPreview = lazy(() => import("@/components/editor/MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })));

interface LoadedVersion {
  document: MaterialDocument;
  bytes: Uint8Array;
  text: string;
}

export async function loadMaterialView(request: MaterialViewerRequest, version: MaterialViewVersion): Promise<LoadedVersion> {
  const content = await version.load();
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
  const source = typeof content === "string" ? { text: content, mediaType: version.mediaType } : { bytes, mediaType: version.mediaType };
  const document = await createMaterialDocument({ projectId: request.projectId, documentId: request.documentId,
    path: request.path ?? null, kind: request.kind, title: version.title }, source);
  if (document.revision !== version.revision.replace(/^sha256:/u, "")) throw new Error("material_version_mismatch");
  return { document, bytes, text: typeof content === "string" ? content : new TextDecoder().decode(bytes) };
}

function ImageContent({ loaded, version }: { loaded: LoadedVersion; version: MaterialViewVersion }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const source = loaded.document.source;
    const mediaType = typeof source !== "function" && source.mediaType ? source.mediaType : imageMime(loaded.document.path ?? loaded.document.title);
    const next = URL.createObjectURL(new Blob([loaded.bytes.slice().buffer], { type: mediaType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [loaded]);
  return url ? <MaterialImageView document={loaded.document} src={url} anchor={version.anchor} /> : null;
}

function MaterialVersion({ request, version, heading, active }: { request: MaterialViewerRequest; version: MaterialViewVersion; heading?: string; active: boolean }) {
  const { t } = useTranslation("editor");
  const [loaded, setLoaded] = useState<LoadedVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry reloads the same retained version.
  useEffect(() => {
    let active = true;
    setLoaded(null); setError(null);
    void loadMaterialView(request, version).then((value) => { if (active) setLoaded(value); })
      .catch((cause) => { if (active) setError(cause instanceof Error && cause.message === "material_version_mismatch"
        ? t(($) => $.editor.materials.verifyFailed) : describeError(cause)); });
    return () => { active = false; };
  }, [request, version, retry, t]);
  const fallback = <LoadingState label={t(($) => $.editor.materials.loading)} className="p-4" />;
  let body = fallback;
  if (error) body = <ErrorState message={error} className="p-4"><Button size="sm" variant="outline" onClick={() => setRetry((current) => current + 1)}>{t(($) => $.editor.materials.retry)}</Button></ErrorState>;
  else if (loaded) {
    switch (request.kind) {
      case "pdf": body = <MaterialPdfView document={loaded.document} bytes={loaded.bytes} anchor={version.anchor} initialPage={version.initialPage ?? (version.anchor?.kind === "page" ? version.anchor.page : version.anchor?.kind === "pdf" ? version.anchor.pages[0]?.page : 1)} />; break;
      case "image": body = <ImageContent loaded={loaded} version={version} />; break;
      case "docx": body = <RetainedDocxView bytes={loaded.bytes} title={version.title} anchor={version.anchor} />; break;
      case "markdown": body = <MarkdownPreview content={loaded.text} document={loaded.document} anchor={version.anchor} projectId={request.projectId} path={request.path ?? ""} />; break;
      case "diagram": body = <RetainedDiagramView content={loaded.text} path={request.path ?? version.title} document={loaded.document} anchor={version.anchor} />; break;
      case "source": body = <RetainedSourceView content={loaded.text} path={request.path ?? version.title} anchor={version.anchor} document={loaded.document} />; break;
      case "html": body = <MaterialHtmlView document={loaded.document} bundle={loaded.text} anchor={version.anchor} />; break;
    }
  }
  return <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={heading ?? version.title}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <p className="mr-auto truncate text-xs font-medium">{heading ?? version.title}</p>
      <Badge variant="muted" size="sm">{t(($) => $.editor.materials.readOnly)}</Badge>
      {loaded && request.kind === "docx" && <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(loaded.document)}><MessageSquarePlus />{t(($) => $.editor.materials.annotateWhole)}</Button>}
    </div>
    <div className="min-h-0 flex-1"><MaterialViewContext key={version.revision} document={loaded?.document ?? null} active={active} materialRole={version.role ?? "evidence"}><Suspense fallback={fallback}>{body}</Suspense></MaterialViewContext></div>
  </section>;
}

export function RetainedMaterialViewer({ request, active = true }: { request: MaterialViewerRequest; active?: boolean }) {
  const { t } = useTranslation("editor");
  const visits = useMaterialViewerStore((state) => state.visits);
  const previousVisit = visits.at(-2);
  const [compare, setCompare] = useState(false);
  const [foreground, setForeground] = useState<"previous" | "current">("current");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit material navigation resets the comparison mode.
  useEffect(() => setCompare(false), [request]);
  return <section className="flex h-full min-h-0 flex-col" data-testid="retained-material-viewer">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="icon" variant="ghost" aria-label={previousVisit ? t(($) => $.editor.materials.backToMaterial, { title: previousVisit.request.title }) : t(($) => $.editor.materials.backToWorkspace)} onClick={() => useMaterialViewerStore.getState().back()}><ArrowLeft /></Button>
      <p className="mr-auto min-w-0 truncate text-sm font-semibold">{request.title}</p>
      {request.previous && <Tabs value={compare ? "compare" : "single"} onValueChange={(value) => setCompare(value === "compare")}>
        <TabsList size="sm" aria-label={t(($) => $.editor.materials.viewMode)}>
          <TabsTrigger value="single"><Eye />{t(($) => $.editor.materials.single)}</TabsTrigger>
          <TabsTrigger value="compare">{t(($) => $.editor.materials.compare)}</TabsTrigger>
        </TabsList>
      </Tabs>}
      <Button size="icon" variant="ghost" aria-label={t(($) => $.editor.materials.close)} onClick={() => useMaterialViewerStore.getState().close()}><X /></Button>
    </div>
    <MaterialVersionStack className="flex-1" mode={compare && request.previous ? "stack" : "current"} foreground={foreground} onForegroundChange={setForeground}
      previousLabel={t(($) => $.editor.materials.previous)} currentLabel={t(($) => $.editor.materials.current)}
      previous={request.previous ? <MaterialVersion request={request} version={request.previous} heading={t(($) => $.editor.materials.previous)} active={active && compare && foreground === "previous"} /> : null}
      current={<MaterialVersion request={request} version={request} active={active && (!compare || foreground === "current")} />} />
  </section>;
}

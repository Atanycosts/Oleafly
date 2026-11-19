import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { describeError } from "@/lib/app-error";
import { formatTime } from "@/lib/intl";
import { logError } from "@/lib/log";
import { openCompiledHtml, readHtmlPreview, closeHtmlPreview, type HtmlPreviewSnapshot } from "@/lib/notebook-commands";
import { MaterialHtmlView } from "@/components/materials/MaterialHtmlView";
import { createMaterialDocument, type MaterialDocument } from "@/lib/material-surface";
import { toast } from "@/lib/toast";
import { MaterialViewContext } from "@/components/materials/MaterialViewContext";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";

export function HtmlOutputPanel({
  projectId,
  builtAt,
  path,
  active = true,
  compiling = false,
  onCompile,
}: Readonly<{
  projectId: string;
  builtAt: number | null;
  path?: string;
  active?: boolean;
  compiling?: boolean;
  onCompile?: () => void;
}>) {
  const { t } = useTranslation(["preview"]);
  const activeSurface = useWorkspaceSurfaceStore((state) => state.active);
  const [opening, setOpening] = useState(false);
  const [loaded, setLoaded] = useState<{ snapshot: HtmlPreviewSnapshot; document: MaterialDocument } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let owned: string | null = null;
    setLoaded(null); setError(null);
    if (builtAt !== null || path) void readHtmlPreview(projectId, path).then(async (snapshot) => {
      if (!active) { void closeHtmlPreview(snapshot.url); return; }
      owned = snapshot.url;
      const document = await createMaterialDocument({ projectId, documentId: path ? `file:${path}` : "compiled:html", path: path ?? null, title: path?.split("/").pop() ?? "HTML", kind: "html" }, { text: snapshot.bundle, mediaType: "application/vnd.oleafly.html-bundle+json" });
      if (active) setLoaded({ snapshot, document });
      else { void closeHtmlPreview(snapshot.url); owned = null; }
    }).catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; if (owned) { void closeHtmlPreview(owned); owned = null; } };
  }, [projectId, builtAt, path]);
  const open = async () => {
    setOpening(true);
    try {
      await openCompiledHtml(projectId);
    } catch (error) {
      void logError("open compiled HTML", error);
      toast.errorUnique(`open-html:${projectId}`, describeError(error));
    } finally {
      setOpening(false);
    }
  };
  const building = builtAt === null && compiling;
  const title = () => {
    if (builtAt !== null) return t(($) => $.preview.html.builtTitle);
    if (building) return t(($) => $.preview.html.building);
    return t(($) => $.preview.html.pendingTitle);
  };
  const detail = () => {
    if (builtAt !== null) return t(($) => $.preview.html.builtDetail, { time: formatTime(builtAt) });
    if (building) return t(($) => $.preview.html.buildingDetail);
    return t(($) => $.preview.html.pendingDetail);
  };
  if (loaded) return <div className="flex h-full min-h-0 flex-col" data-testid="html-output-panel" inert={!active || undefined}>
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
      <span className="mr-auto">{path ?? `${title()} · ${detail()}`}</span>
      {!path && <Button size="xs" variant="ghost" disabled={opening} onClick={() => void open()}>{t(($) => $.preview.html.open)}</Button>}
    </div>
    <MaterialViewContext document={loaded.document} active={active && activeSurface === "files"} materialRole={path ? "working" : "result"}><MaterialHtmlView document={loaded.document} bundle={loaded.snapshot.bundle} previewUrl={loaded.snapshot.url} /></MaterialViewContext>
  </div>;
  return (
    <div
      className="flex h-full flex-col items-center justify-center space-y-3 p-6 text-center text-muted-foreground"
      data-testid="html-output-panel"
      role="status"
      aria-live="polite"
    >
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {building ? (
        <Spinner className="mx-auto size-10" />
      ) : (
        <Globe aria-hidden className="mx-auto size-10 opacity-30" />
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title()}</p>
        <p className="mx-auto max-w-xs text-sm">{detail()}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {builtAt !== null && (
          <Button size="sm" disabled={opening} onClick={() => void open()}>
            {opening ? <Spinner size="xs" /> : null}
            {t(($) => $.preview.html.open)}
          </Button>
        )}
        {builtAt === null && !compiling && onCompile && (
          <Button size="sm" onClick={onCompile}>
            {t(($) => $.preview.html.compile)}
          </Button>
        )}
      </div>
    </div>
  );
}

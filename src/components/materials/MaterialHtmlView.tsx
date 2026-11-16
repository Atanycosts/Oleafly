import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { restoreHtmlPreview, closeHtmlPreview } from "@/lib/notebook-commands";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useActivateMaterialView, useMaterialViewSelection } from "./MaterialViewContext";

export function MaterialHtmlView({ document, bundle, previewUrl, anchor }: { document: MaterialDocument; bundle: string; previewUrl?: string; anchor?: MaterialAnchor }) {
  const { t } = useTranslation("editor");
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(previewUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ selector: string; quote: string } | null>(null);
  const activateView = useActivateMaterialView();
  useMaterialViewSelection(useMemo(() => selection ? { kind: "html", ...selection } : null, [selection]));
  useEffect(() => {
    let active = true;
    let owned: string | null = null;
    setSelection(null); setError(null); setUrl(previewUrl ?? null);
    if (!previewUrl) void restoreHtmlPreview(bundle).then((snapshot) => {
      if (active) { owned = snapshot.url; setUrl(snapshot.url); }
      else void closeHtmlPreview(snapshot.url);
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; if (owned) void closeHtmlPreview(owned); };
  }, [bundle, previewUrl]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "oleafly-html-interaction") {
        if (frame.current && !frame.current.closest("[hidden], [inert]")) { activateView?.(); useAgentWorkspaceStore.getState().pause(); }
        return;
      }
      if (event.data?.type !== "oleafly-html-selection") return;
      const { selector, quote } = event.data;
      setSelection(typeof selector === "string" && typeof quote === "string" && quote.trim() ? { selector, quote } : null);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [url, activateView]);
  return <div className="flex h-full min-h-0 flex-col" data-testid="material-html-view">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(document)}>{t(($) => $.editor.materials.annotateWhole)}</Button>
      <Button size="xs" variant="outline" disabled={!selection} onClick={() => { if (selection) openMaterialAnnotations(document, { kind: "html", ...selection }); }}>{t(($) => $.editor.materials.annotateSelection)}</Button>
      <span className="text-xs text-muted-foreground">{t(($) => $.editor.materials.htmlSelectionHint)}</span>
    </div>
    {error ? <p role="alert" className="p-4 text-sm text-destructive">{t(($) => $.editor.materials.htmlBlocked)} {error}</p>
      : url ? <iframe key={url} ref={frame} src={url} title={document.title} onLoad={() => { if (anchor?.kind === "html") frame.current?.contentWindow?.postMessage({ type: "oleafly-html-anchor", selector: anchor.selector, quote: anchor.quote }, "*"); }} sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
        : <p role="status" className="p-4 text-sm text-muted-foreground">{t(($) => $.editor.materials.loading)}</p>}
  </div>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiagramCanvas, DiagramKitContext, diagramLanguage, languageForPath, mermaidBlocks, type DiagramKit } from "@oleafly/diagram";
import { diagramFromSource, type DiagramModel } from "@oleafly/latex";
import { KIT } from "@/components/diagram/diagram-kit";
import { describeError } from "@/lib/app-error";
import { Button } from "@/components/ui/button";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { ErrorState, LoadingState } from "@/components/ui/empty";
import { useMaterialViewSelection } from "./MaterialViewContext";

const keepReadOnly = () => {};

/** Use the existing diagram parser and canvas without registering an editable file. */
export function RetainedDiagramView({ content, path, document, anchor }: { content: string; path: string; document?: MaterialDocument; anchor?: MaterialAnchor }) {
  const { t } = useTranslation(["editor", "diagram"]);
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(anchor?.kind === "object" ? anchor.id : null);
  useMaterialViewSelection(useMemo(() => selected ? { kind: "object", id: selected } : null, [selected]));
  const [model, setModel] = useState<DiagramModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const kit = useMemo<DiagramKit>(() => ({ ...KIT, t: (key, params) =>
    (t as unknown as (key: string, params?: Record<string, unknown>) => string)(`diagram:package.${key}`, params) }), [t]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const read = async () => {
      const kind = languageForPath(path) ?? "tikz";
      if (kind === "tikz") return diagramFromSource(content);
      const language = diagramLanguage(kind);
      await language.load();
      const source = kind === "mermaid" ? mermaidBlocks(content)[0]?.code ?? content : language.fromStandalone(content).code;
      return language.read(source).model;
    };
    void read().then((next) => { if (active) setModel(next); })
      .catch((cause) => { if (active) setError(describeError(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [content, path]);
  useEffect(() => {
    const id = anchor?.kind === "object" ? anchor.id : null;
    setSelected(id);
    if (!id || !root.current) return;
    const reveal = () => {
      const element = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-id]") ?? []).find((element) => element.dataset.id === id);
      if (!element) return;
      element.style.outline = "2px solid var(--color-primary)";
      element.setAttribute("data-material-anchor", "true");
      element.scrollIntoView?.({ block: "center" });
    };
    reveal();
    const observer = new MutationObserver(reveal);
    observer.observe(root.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor, model, loading]);
  if (loading) return <LoadingState label={t(($) => $.editor.materials.loading)} className="p-4" />;
  if (error) return <ErrorState message={error} className="p-4" />;
  if (!model) return <p className="p-4 text-sm text-muted-foreground">{t(($) => $.editor.materials.notRenderable)}</p>;
  return <div ref={root} className="flex h-full min-h-0 flex-col" onClickCapture={(event) => {
    if ((event.target as Element).closest("button")) return;
    setSelected((event.target as Element).closest<HTMLElement>("[data-id]")?.dataset.id ?? null);
  }}>
    {document && <div className="flex shrink-0 gap-2 border-b px-3 py-2">
      <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(document)}>{t(($) => $.editor.materials.annotateWhole)}</Button>
      <Button size="xs" variant="outline" disabled={!selected} onClick={() => { if (selected) openMaterialAnnotations(document, { kind: "object", id: selected }); }}>{t(($) => $.editor.materials.diagramObject)}</Button>
    </div>}
    <DiagramKitContext.Provider value={kit}><DiagramCanvas model={model} onChange={keepReadOnly} readOnly /></DiagramKitContext.Provider>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { MaterialAnchor, MaterialDocument, MaterialRect } from "@/lib/material-surface";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { useMaterialViewSelection } from "./MaterialViewContext";

export function MaterialImageView({ document, src, onError, anchor }: { document: MaterialDocument; src: string; onError?: () => void; anchor?: MaterialAnchor }) {
  const { t } = useTranslation("editor");
  const image = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [rect, setRect] = useState<MaterialRect | null>(anchor?.kind === "region" ? anchor.rect : null);
  useMaterialViewSelection(useMemo(() => rect ? { kind: "region", rect } : null, [rect]));
  useEffect(() => { setRect(anchor?.kind === "region" ? anchor.rect : null); }, [anchor, document.revision]);
  const position = (clientX: number, clientY: number) => {
    const box = image.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (clientY - box.top) / box.height)) };
  };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap gap-2 border-b px-3 py-2">
      <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(document)}>{t(($) => $.editor.materials.annotateWhole)}</Button>
      <Button size="xs" variant={selecting ? "secondary" : "outline"} onClick={() => { setSelecting(!selecting); setRect(null); }}>{t(($) => $.editor.materials.imageRegion)}</Button>
      {rect && <Button size="xs" onClick={() => openMaterialAnnotations(document, { kind: "region", rect })}>{t(($) => $.editor.materials.annotateSelection)}</Button>}
    </div>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <div className="relative inline-flex max-h-full max-w-full touch-none"
        style={{ cursor: selecting ? "crosshair" : undefined }}
        onPointerDown={(event) => { if (!selecting) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = position(event.clientX, event.clientY); setRect(null); }}
        onPointerMove={(event) => { if (!start.current) return; const point = position(event.clientX, event.clientY); setRect({ x: Math.min(point.x, start.current.x), y: Math.min(point.y, start.current.y), width: Math.abs(point.x - start.current.x), height: Math.abs(point.y - start.current.y) }); }}
        onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; setRect(null); }}>
        <img ref={image} src={src} alt={document.title} onError={onError} draggable={false} className="block max-h-full max-w-full object-contain" />
        {rect && <div data-testid="material-image-region" aria-hidden className="pointer-events-none absolute border-2 border-primary bg-primary/15" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />}
      </div>
    </div>
  </div>;
}

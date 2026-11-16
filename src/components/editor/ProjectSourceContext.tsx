import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import { MaterialViewContext, useReportMaterialViewSelection } from "@/components/materials/MaterialViewContext";
import { createMaterialDocument, type MaterialDocument, type MaterialKind } from "@/lib/material-surface";
import { basename } from "@/lib/path-utils";
import { useFilesStore } from "@/store/files";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { getEditorView } from "./cm/controller";

function SourceSelection({ children }: { children: ReactNode }) {
  const report = useReportMaterialViewSelection();
  const capture = (event: SyntheticEvent) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".tiptap, .ProseMirror")) { report?.(null); return; }
    if (!event.target.closest(".cm-editor")) return;
    const view = getEditorView();
    if (!view) return;
    const range = view.state.selection.main;
    report?.(range.empty ? null : { kind: "text", from: range.from, to: range.to, quote: view.state.sliceDoc(range.from, range.to) });
  };
  return <div className="contents" onMouseUp={capture} onKeyUp={capture} onInput={capture}>{children}</div>;
}

export function ProjectSourceContext({ projectId, path, kind, children }: { projectId: string; path: string; kind: MaterialKind; children: ReactNode }) {
  const active = useWorkspaceSurfaceStore((state) => state.active === "files");
  const content = useFilesStore((state) => state.files[path]?.content);
  const dirty = useFilesStore((state) => state.files[path]?.dirty);
  const [document, setDocument] = useState<MaterialDocument | null>(null);
  useEffect(() => {
    let current = true;
    setDocument(null);
    if (content !== undefined) void createMaterialDocument({ projectId, documentId: `file:${path}`, path, title: basename(path), kind }, { text: content }).then((value) => { if (current) setDocument(value); });
    return () => { current = false; };
  }, [projectId, path, kind, content]);
  return <MaterialViewContext document={document} active={active} materialRole="working" dirty={dirty}><SourceSelection>{children}</SourceSelection></MaterialViewContext>;
}

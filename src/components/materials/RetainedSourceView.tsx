import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { editorTheme, languageForPath } from "@oleafly/editor";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";
import { Button } from "@/components/ui/button";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { useMaterialViewSelection } from "./MaterialViewContext";

/** Read-only source view, independent of the active editable project buffer. */
export function RetainedSourceView({ content, path, anchor, document }: { content: string; path: string; anchor?: MaterialAnchor; document?: MaterialDocument }) {
  const { t } = useTranslation("editor");
  const host = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Extract<MaterialAnchor, { kind: "text" }> | null>(null);
  useMaterialViewSelection(selection);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), editorTheme(), EditorView.updateListener.of((update) => {
      if (!update.selectionSet) return;
      const range = update.state.selection.main;
      setSelection(range.empty ? null : { kind: "text", from: range.from, to: range.to, quote: update.state.sliceDoc(range.from, range.to) });
    })];
    const language = languageForPath(path);
    if (language) extensions.push(language);
    const from = anchor?.kind === "text" ? Math.min(content.length, anchor.from) : 0;
    const to = anchor?.kind === "text" ? Math.min(content.length, anchor.to) : from;
    setSelection(from !== to ? { kind: "text", from, to, quote: content.slice(from, to) } : null);
    const view = new EditorView({
      state: EditorState.create({ doc: content, selection: { anchor: from, head: to }, extensions }),
      parent: host.current,
    });
    if (from) view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
    return () => view.destroy();
  }, [content, path, anchor]);
  return <div className="flex h-full min-h-0 flex-col">
    {document && <div className="flex shrink-0 gap-2 border-b px-3 py-2">
      <Button size="xs" variant="outline" onClick={() => openMaterialAnnotations(document)}>{t(($) => $.editor.materials.annotateWhole)}</Button>
      <Button size="xs" variant="outline" disabled={!selection} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (selection) openMaterialAnnotations(document, selection); }}>{t(($) => $.editor.materials.annotateSelection)}</Button>
    </div>}
    <div ref={host} className="min-h-0 flex-1 overflow-auto [&_.cm-editor]:h-full" data-testid="retained-source-view" />
  </div>;
}

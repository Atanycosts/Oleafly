import { useEffect, useState } from "react";
import { useFonts, useDocxEditor, useEditorState } from "@docx-editor.dev/react";
import { WordDocument } from "./WordDocument";
import type { MaterialAnchor } from "@/lib/material-surface";
import { createDocxFontResolver, type DocxFontStatus } from "@/lib/docx-fonts";
import { readDocxMaterialSelection } from "@/lib/docx-material";
import { useMaterialViewSelection } from "./MaterialViewContext";
import { useTranslation } from "react-i18next";
import "@docx-editor.dev/core/styles/editor.css";

const fontShaping = Object.freeze({ maxFontBytes: 64 * 1024 * 1024 });

function RetainedDocxAnchor({ anchor }: { anchor?: MaterialAnchor }) {
  const editor = useDocxEditor();
  const ready = useEditorState((state) => !state.isLoading && !state.isOpening && state.parseError === null && state.page.total > 0);
  const [selection, setSelection] = useState<MaterialAnchor | null>(null);
  useMaterialViewSelection(selection);
  useEffect(() => {
    if (!ready || !editor) { setSelection(null); return; }
    const update = () => setSelection(readDocxMaterialSelection(editor)?.anchor ?? null);
    update();
    return editor.on("selectionChange", update);
  }, [ready, editor]);
  useEffect(() => {
    if (ready && editor && anchor?.kind === "object") {
      // A retained view has no writable or Agent session. Only its own object is revealed.
      const paraId = anchor.id.startsWith("paragraph:") ? anchor.id.slice("paragraph:".length) : anchor.id;
      editor.scrollToAnchor({ paraId });
      editor.highlightAnchor({ paraId });
    }
  }, [ready, editor, anchor]);
  return null;
}

export function RetainedDocxView({ bytes, title, anchor }: { bytes: Uint8Array; title: string; anchor?: MaterialAnchor }) {
  const { i18n, t } = useTranslation("researchTools");
  const [fontError, setFontError] = useState<string | null>(null);
  const [status, setStatus] = useState<DocxFontStatus>({ probed: false, missing: [], aliases: [] });
  const [resolver] = useState(() => createDocxFontResolver({ onError: (error) => setFontError(String(error)), onStatus: setStatus }));
  const fonts = useFonts(resolver);
  return <div className="flex h-full min-h-0 flex-col" data-docx-history="readonly">
    {fontError && <p role="alert" className="border-b p-2 text-xs text-destructive">{fontError}</p>}
    {status.missing.length > 0 && <p role="status" className="border-b p-2 text-xs text-amber-700 dark:text-amber-400">{t(($) => $.researchTools.workspace.missingFonts)}</p>}
    <WordDocument document={bytes} fonts={fonts} fontShaping={fontShaping} mode="view" title={title} locale={i18n.language} colorMode="system" className="h-auto min-h-0 flex-1">
      <RetainedDocxAnchor anchor={anchor} />
    </WordDocument>
  </div>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { equationToSvgDocument } from "@/features/equation-export";
import { DOCX_AGENT_HOST } from "@/lib/docx-agent-host";
import type { DocxSession } from "@/lib/docx-session";

interface SelectedEquation {
  objectRef: string;
  expectedFingerprint: string;
  offset: number;
  status: "bound" | "stale" | "unbound";
  latex: string;
  macros: string;
  sourceHash?: string;
  display: boolean;
}

interface ParagraphEquations {
  key: string;
  paragraphRef: string;
  revision: number;
  modelText: string;
  equations: SelectedEquation[];
}

interface PanelResult {
  ok: boolean;
  message?: string;
  warnings: readonly string[];
}

interface RefreshTarget {
  objectRef?: string;
  offset?: number;
  sourceHash?: string;
}

export function DocxEquationPanel({ active, session, selection, sessionId }: {
  active: boolean;
  session: DocxSession;
  sessionId: string;
  selection: {
    paraId?: string;
    paragraphRef?: string;
    revision?: string;
    collapsedModelOffset?: number;
  } | null;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.equationTools, { returnObjects: true });
  const [paragraph, setParagraph] = useState<ParagraphEquations | null>(null);
  const [selectedObjectRef, setSelectedObjectRef] = useState<string | null>(null);
  const [latex, setLatex] = useState("");
  const [macros, setMacros] = useState("");
  const [display, setDisplay] = useState(false);
  const [adoptSource, setAdoptSource] = useState(false);
  const [result, setResult] = useState<PanelResult | null>(null);
  const [writing, setWriting] = useState(false);
  const [preview, setPreview] = useState<{ svg: string } | { error: string } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(session.revision());
  const draft = useRef(false);
  const pendingWrite = useRef(false);
  const loadedKey = useRef<string | null>(null);
  const targetRef = useRef<string | null>(null);
  const previewRequest = useRef(0);
  const paraId = selection?.paraId;
  const paragraphRef = selection?.paragraphRef;
  const selectionKey = paraId ? `id:${paraId}` : paragraphRef ? `ref:${paragraphRef}` : null;

  const clearPreview = useCallback(() => {
    previewRequest.current += 1;
    setPreview(null);
    setPreviewPending(false);
  }, []);

  const editTarget = useCallback((next: SelectedEquation | null) => {
    targetRef.current = next?.objectRef ?? null;
    setSelectedObjectRef(targetRef.current);
    setLatex(next?.latex ?? "");
    setMacros(next?.macros ?? "");
    setDisplay(next?.display ?? false);
    setAdoptSource(false);
    draft.current = false;
    clearPreview();
  }, [clearPreview]);

  // Choosing insertion or editing a draft must not reload the paragraph.
  const refresh = useCallback((preferred?: RefreshTarget, keepResult = false) => {
    if (!active || !selectionKey) return;
    const handle = paraId
      ? session.paragraphHandleForId?.(paraId)
      : session.listParagraphHandles().find((item) => item.ref === paragraphRef);
    if (!handle) { setParagraph(null); return; }
    const semantics = session.readParagraph(handle);
    const equations = semantics.atoms.flatMap((atom): SelectedEquation[] => {
      if (atom.kind !== "math") return [];
      const payload = atom.payload as {
        equationFingerprint?: string;
        source?: { status: SelectedEquation["status"]; latex?: string; macros?: string; sourceHash?: string; display?: boolean };
      } | undefined;
      if (!payload?.equationFingerprint || !payload.source) return [];
      return [{ objectRef: atom.objectRef, expectedFingerprint: payload.equationFingerprint,
        offset: atom.modelRange.start, status: payload.source.status,
        latex: payload.source.latex ?? "", macros: payload.source.macros ?? "",
        sourceHash: payload.source.sourceHash, display: payload.source.display ?? false }];
    });
    let next: SelectedEquation | null;
    if (preferred) {
      next = equations.find((item) => preferred.objectRef ? item.objectRef === preferred.objectRef
        : item.offset === preferred.offset && item.sourceHash === preferred.sourceHash) ?? null;
    } else if (loadedKey.current === selectionKey && targetRef.current === null) {
      next = null;
    } else {
      next = equations.find((item) => item.objectRef === targetRef.current) ?? equations[0] ?? null;
    }
    loadedKey.current = selectionKey;
    setParagraph({ key: selectionKey, paragraphRef: semantics.paragraphRef,
      revision: semantics.revision, modelText: semantics.modelText, equations });
    setSessionRevision(semantics.revision);
    editTarget(next);
    if (!keepResult) setResult(null);
  }, [active, editTarget, paraId, paragraphRef, selectionKey, session]);

  useEffect(() => {
    setSessionRevision(session.revision());
    return session.subscribe(setSessionRevision);
  }, [session]);
  useEffect(() => {
    if (!draft.current && !pendingWrite.current) refresh();
  }, [refresh]);
  useEffect(() => {
    if (paragraph && paragraph.revision !== sessionRevision && !draft.current && !pendingWrite.current) refresh();
  }, [paragraph, refresh, sessionRevision]);

  const selected = paragraph?.equations.find((item) => item.objectRef === selectedObjectRef) ?? null;
  const stale = Boolean(paragraph && (paragraph.key !== selectionKey || paragraph.revision !== sessionRevision));
  const displayInsertAvailable = paragraph?.modelText.length === 0;
  const canWrite = Boolean(active && selectionKey && paragraph && !stale && latex.trim() && !writing &&
    (selected ? selected.status === "bound" || adoptSource : !display || displayInsertAvailable));
  const insertionPoint = useMemo(() => {
    if (!paragraph || selected) return null;
    const caret = selection?.collapsedModelOffset;
    const validCaret = caret !== undefined && Number.isInteger(caret) && caret >= 0 && caret <= paragraph.modelText.length;
    const offset = validCaret ? caret : paragraph.modelText.length;
    return { offset, label: offset === 0 ? text.insertAtStart : validCaret ? text.insertAtCaret : text.insertAtEnd };
  }, [paragraph, selected, selection?.collapsedModelOffset, text.insertAtCaret, text.insertAtEnd, text.insertAtStart]);

  const markDraft = () => {
    draft.current = true;
    clearPreview();
    setResult(null);
  };
  const previewSource = async () => {
    if (!latex.trim()) return;
    const request = ++previewRequest.current;
    setPreviewPending(true);
    try {
      const source = `{\n${macros}\n${latex}\n}`;
      const svg = DOMPurify.sanitize(await equationToSvgDocument(source, display), {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ["use"],
      });
      if (request === previewRequest.current) setPreview({ svg });
    } catch (cause) {
      if (request === previewRequest.current) setPreview({ error: String(cause) });
    } finally {
      if (request === previewRequest.current) setPreviewPending(false);
    }
  };
  const write = async () => {
    if (!paragraph || !canWrite) return;
    pendingWrite.current = true;
    setWriting(true);
    setResult(null);
    try {
      const response = await DOCX_AGENT_HOST.writeEquation!({
        sessionId, paragraphRef: paragraph.paragraphRef, expectedRevision: paragraph.revision,
        latex, ...(macros.trim() ? { macros } : {}),
        ...(selected ? { objectRef: selected.objectRef, expectedFingerprint: selected.expectedFingerprint,
          ...(adoptSource ? { adoptSource: true } : {}) }
          : { offset: insertionPoint!.offset, display }),
      }, undefined);
      if (response.ok) refresh(selected ? { objectRef: selected.objectRef }
        : { offset: insertionPoint!.offset, sourceHash: response.sourceHash }, true);
      setResult({ ok: response.ok, message: response.message, warnings: response.warnings });
    } catch (cause) {
      setResult({ ok: false, message: String(cause), warnings: [] });
    } finally {
      pendingWrite.current = false;
      setWriting(false);
    }
  };

  const statusText = selected
    ? selected.status === "bound" ? text.bound : selected.status === "stale" ? text.stale : text.unbound
    : insertionPoint?.label ?? text.noEquation;

  return <section className="space-y-2 rounded border p-3 text-xs" aria-label={text.title} data-testid="docx-equation-panel" data-docx-history="field">
    <h3 className="text-sm font-semibold">{text.title}</h3>
    {!active || !selectionKey || !paragraph ? <p className="text-muted-foreground">{text.noSelection}</p> : <>
      <div className="space-y-1">
        <label className="block font-medium" htmlFor="docx-equation-target">{text.target}</label>
        <select id="docx-equation-target" className="w-full rounded border p-1" value={selectedObjectRef ?? ""}
          disabled={writing || stale} onChange={(event) => {
            editTarget(paragraph.equations.find((item) => item.objectRef === event.target.value) ?? null);
            setResult(null);
          }}>
          <option value="">{insertionPoint?.label ?? text.insertAtStart}</option>
          {paragraph.equations.map((item, index) => <option key={item.objectRef} value={item.objectRef}>
            {text.equations} {index + 1} · {item.status === "bound" ? text.bound : item.status === "stale" ? text.stale : text.unbound}
          </option>)}
        </select>
        <p className="text-muted-foreground">{statusText}</p>
      </div>
      <div className="space-y-1">
        <label className="block font-medium" htmlFor="docx-equation-latex">{text.source}</label>
        <textarea id="docx-equation-latex" className="h-24 w-full rounded border p-1 font-mono" value={latex} disabled={writing}
          onChange={(event) => { setLatex(event.target.value); markDraft(); }} />
      </div>
      <div className="space-y-1">
        <label className="block font-medium" htmlFor="docx-equation-macros">{text.macros}</label>
        <textarea id="docx-equation-macros" className="h-16 w-full rounded border p-1 font-mono" value={macros} disabled={writing}
          onChange={(event) => { setMacros(event.target.value); markDraft(); }} />
      </div>
      <Button size="sm" variant="outline" disabled={!latex.trim() || previewPending || writing} onClick={() => void previewSource()}>{text.preview}</Button>
      {preview && <div className="overflow-x-auto rounded border p-2" data-testid="docx-equation-preview">
        {"svg" in preview ? <EquationPreview svg={preview.svg} /> : <p className="break-words text-destructive">{preview.error}</p>}
      </div>}
      <p className="text-muted-foreground">{text.previewHelp}</p>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" name="docx-equation-placement" checked={!display} disabled={!!selected || writing}
            onChange={() => { setDisplay(false); markDraft(); }} />{text.inline}
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="docx-equation-placement" checked={display} disabled={!!selected || writing || !displayInsertAvailable}
            onChange={() => { setDisplay(true); markDraft(); }} />{text.display}
        </label>
      </div>
      {!selected && !displayInsertAvailable && <p className="text-muted-foreground">{text.displayRequiresEmptyParagraph}</p>}
      {selected && selected.status !== "bound" && <>
        <label className="flex items-center gap-1" htmlFor="docx-equation-adopt">
          <input id="docx-equation-adopt" type="checkbox" checked={adoptSource} disabled={writing}
            onChange={(event) => { setAdoptSource(event.target.checked); markDraft(); }} />
          <span>{text.adopt}</span>
        </label>
        <p className="text-muted-foreground">{text.adoptHelp}</p>
      </>}
      <Button size="sm" onClick={() => void write()} disabled={!canWrite}>
        {writing ? <Spinner size="sm" className="mr-1" /> : null}{selected ? text.replace : text.insert}
      </Button>
      {stale && <>
        <p role="status" className="text-amber-700 dark:text-amber-400">{text.fingerprintMismatch}</p>
        <Button size="sm" variant="outline" disabled={writing} onClick={() => refresh()}>{text.refresh}</Button>
      </>}
      {result && <div className="space-y-1 rounded border p-2" data-testid="docx-equation-result">
        <p className={result.ok ? "text-muted-foreground" : "text-destructive"}>
          {result.ok ? text.results : text.writeFailed}{result.message ? `: ${result.message}` : ""}
        </p>
        {result.warnings.length > 0 && <ul className="list-disc pl-4 text-muted-foreground">
          {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>}
      </div>}
    </>}
  </section>;
}

function EquationPreview({ svg }: { svg: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: MathJax output is sanitized with the SVG-only profile above.
  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}

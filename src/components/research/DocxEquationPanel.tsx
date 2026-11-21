import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { equationToSvgDocument } from "@/features/equation-export";
import { DOCX_AGENT_HOST } from "@/lib/docx-agent-host";
import type { DocxEquationSourceView } from "@/lib/docx-equations";
import type { DocxParagraphSemantics, DocxSession } from "@/lib/docx-session";

interface SelectedEquation {
  objectRef: string;
  expectedFingerprint: string;
  offset: number;
  end: number;
  status: "bound" | "stale" | "unbound";
  latex: string;
  macros: string;
  sourceHash?: string;
  display: boolean;
}

export interface DocxEquationTarget {
  paragraphRef: string;
  revision: number;
  equation: SelectedEquation;
}

export interface DocxEquationDraft {
  latex: string;
  macros: string;
  adoptSource: boolean;
}

export function readParagraphEquations(paragraph: DocxParagraphSemantics): SelectedEquation[] {
  return paragraph.atoms.flatMap((atom): SelectedEquation[] => {
    if (atom.kind !== "math") return [];
    const payload = atom.payload as { equationFingerprint?: string; source?: DocxEquationSourceView } | undefined;
    if (!payload?.equationFingerprint || !payload.source) return [];
    return [{ objectRef: atom.objectRef, expectedFingerprint: payload.equationFingerprint,
      offset: atom.modelRange.start, end: atom.modelRange.end, status: payload.source.status,
      latex: payload.source.latex ?? "", macros: payload.source.macros ?? "",
      sourceHash: payload.source.sourceHash, display: payload.source.display ?? false }];
  });
}

interface ParagraphEquations {
  key: string;
  paragraphRef: string;
  revision: number;
  modelText: string;
  equations: SelectedEquation[];
  capture: DocxEquationTarget | null;
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

export function DocxEquationPanel({ active, session, selection, sessionId, contextual, captured: capturedTarget, pendingWrite }: {
  active: boolean;
  session: DocxSession;
  sessionId: string;
  selection?: {
    paraId?: string;
    paragraphRef?: string;
    revision?: string;
    collapsedModelOffset?: number;
  } | null;
  captured?: DocxEquationTarget | null;
  pendingWrite?: RefObject<AbortController | null>;
  contextual?: {
    target: DocxEquationTarget;
    draft?: DocxEquationDraft;
    onDraftChange?(draft: DocxEquationDraft | null): void;
    onClose(restoreFocus: boolean): void;
    isTargetVisible?(): boolean;
  };
}) {
  const { t } = useTranslation(["researchTools", "common"]);
  const text = t(($) => $.researchTools.docx.equationTools, { returnObjects: true });
  const id = useId();
  const fixed = contextual?.target;
  const [paragraph, setParagraph] = useState<ParagraphEquations | null>(null);
  const [selectedObjectRef, setSelectedObjectRef] = useState<string | null>(null);
  const [latex, setLatex] = useState(contextual?.draft?.latex ?? fixed?.equation.latex ?? "");
  const [macros, setMacros] = useState(contextual?.draft?.macros ?? fixed?.equation.macros ?? "");
  const [display, setDisplay] = useState(fixed?.equation.display ?? false);
  const [adoptSource, setAdoptSource] = useState(contextual?.draft?.adoptSource ?? false);
  const [result, setResult] = useState<PanelResult | null>(null);
  const [writing, setWriting] = useState(false);
  const [preview, setPreview] = useState<{ svg: string } | { error: string } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(session.revision());
  const captured = !contextual && capturedTarget?.revision === session.revision() ? capturedTarget : null;
  const draft = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const localWrite = useRef<AbortController | null>(null);
  const writeController = pendingWrite ?? localWrite;
  const focusIsInPanel = () => {
    const element = panel.current;
    return Boolean(element?.contains(element.ownerDocument.activeElement));
  };
  useLayoutEffect(() => {
    setWriting(false);
    return () => {
      writeController.current?.abort();
      writeController.current = null;
    };
  }, [active, session, sessionId, writeController]);
  const targetRef = useRef<string | null>(null);
  const loadedKey = useRef<string | null>(null);
  const appliedCapture = useRef<DocxEquationTarget | null>(null);
  const previewRequest = useRef(0);
  const paraId = captured ? undefined : selection?.paraId;
  const paragraphRef = captured?.paragraphRef ?? selection?.paragraphRef;
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
  const refresh = useCallback((preferred?: RefreshTarget, keepResult = false,
    previous?: { paragraphRef: string; equation: SelectedEquation }) => {
    if (!active || !selectionKey) return;
    const handle = paraId
      ? session.paragraphHandleForId?.(paraId)
      : session.listParagraphHandles().find((item) => item.ref === paragraphRef);
    if (!handle) { setParagraph(null); return; }
    const semantics = session.readParagraph(handle);
    const equations = readParagraphEquations(semantics);
    const matches = previous?.paragraphRef === semantics.paragraphRef
      ? equations.filter((item) => item.expectedFingerprint === previous.equation.expectedFingerprint)
      : [];
    const keepSource = matches.length === 1 && matches[0].objectRef === previous?.equation.objectRef &&
      (!captured || (captured.equation.objectRef === matches[0].objectRef &&
        captured.equation.expectedFingerprint === matches[0].expectedFingerprint));
    const captureChanged = captured !== appliedCapture.current;
    let next: SelectedEquation | null;
    if (keepSource) {
      next = matches[0];
    } else if (preferred) {
      next = equations.find((item) => preferred.objectRef ? item.objectRef === preferred.objectRef
        : item.offset === preferred.offset && item.sourceHash === preferred.sourceHash) ?? null;
    } else if (captureChanged) {
      next = captured ? equations.find((item) => item.objectRef === captured.equation.objectRef &&
        item.expectedFingerprint === captured.equation.expectedFingerprint) ?? null : null;
    } else if (loadedKey.current !== selectionKey) {
      next = equations[0] ?? null;
    } else {
      next = equations.find((item) => item.objectRef === targetRef.current) ?? null;
    }
    appliedCapture.current = captured;
    loadedKey.current = selectionKey;
    setParagraph({ key: selectionKey, paragraphRef: semantics.paragraphRef,
      revision: semantics.revision, modelText: semantics.modelText, equations, capture: captured });
    setSessionRevision(semantics.revision);
    if (!keepSource) editTarget(next);
    else {
      setDisplay(next?.display ?? false);
      setAdoptSource(false);
      clearPreview();
    }
    if (!keepResult) setResult(null);
  }, [active, captured, clearPreview, editTarget, paraId, paragraphRef, selectionKey, session]);

  useEffect(() => {
    setSessionRevision(session.revision());
    return session.subscribe(setSessionRevision);
  }, [session]);
  useEffect(() => {
    if (!draft.current && !writeController.current) refresh();
  }, [refresh, writeController]);
  useEffect(() => {
    if (paragraph && paragraph.revision !== sessionRevision && !draft.current && !writeController.current) refresh();
  }, [paragraph, refresh, sessionRevision, writeController]);

  const selected = fixed?.equation ?? paragraph?.equations.find((item) => item.objectRef === selectedObjectRef) ?? null;
  const stale = fixed ? fixed.revision !== sessionRevision : Boolean(paragraph &&
    (paragraph.key !== selectionKey || paragraph.revision !== sessionRevision || paragraph.capture !== captured));
  const displayInsertAvailable = paragraph?.modelText.length === 0;
  const canWrite = Boolean(active && (fixed || (selectionKey && paragraph)) && !stale && latex.trim() && !writing &&
    (selected ? selected.status === "bound" || adoptSource : !display || displayInsertAvailable));
  const insertionPoint = useMemo(() => {
    if (!paragraph || selected) return null;
    const caret = selection?.collapsedModelOffset;
    const validCaret = caret !== undefined && Number.isInteger(caret) && caret >= 0 && caret <= paragraph.modelText.length;
    const offset = validCaret ? caret : paragraph.modelText.length;
    return { offset, label: offset === 0 ? text.insertAtStart : validCaret ? text.insertAtCaret : text.insertAtEnd };
  }, [paragraph, selected, selection?.collapsedModelOffset, text.insertAtCaret, text.insertAtEnd, text.insertAtStart]);

  const markDraft = (change?: Partial<DocxEquationDraft>) => {
    draft.current = true;
    if (change) contextual?.onDraftChange?.({ latex, macros, adoptSource, ...change });
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
    const target = fixed ?? paragraph;
    const writeEquation = DOCX_AGENT_HOST.writeEquation;
    const mutation = selected ? { objectRef: selected.objectRef, expectedFingerprint: selected.expectedFingerprint,
      ...(adoptSource ? { adoptSource: true } : {}) } : insertionPoint && { offset: insertionPoint.offset, display };
    if (!target || !mutation || !canWrite || writeController.current) return;
    if (focusIsInPanel()) (closeButton.current ?? heading.current)?.focus({ preventScroll: true });
    const controller = new AbortController();
    writeController.current = controller;
    setWriting(true);
    setResult(null);
    try {
      const response = await writeEquation({
        sessionId, paragraphRef: target.paragraphRef, expectedRevision: target.revision,
        latex, ...(macros.trim() ? { macros } : {}), ...mutation,
      }, { signal: controller.signal, isTargetVisible: contextual?.isTargetVisible });
      if (controller.signal.aborted) return;
      if (response.ok && contextual) {
        contextual.onDraftChange?.(null);
        if (response.warnings.length === 0) contextual.onClose(focusIsInPanel());
        else setResult({ ok: true, warnings: response.warnings });
        return;
      }
      if (response.ok) refresh(selected ? { objectRef: selected.objectRef }
        : { offset: insertionPoint?.offset, sourceHash: response.sourceHash }, true);
      setResult({ ok: response.ok, message: response.message, warnings: response.warnings });
    } catch (cause) {
      if (!controller.signal.aborted) setResult({ ok: false, message: String(cause), warnings: [] });
    } finally {
      if (writeController.current === controller) {
        writeController.current = null;
        setWriting(false);
      }
    }
  };

  const statusText = selected
    ? selected.status === "bound" ? text.bound : selected.status === "stale" ? text.stale : text.unbound
    : insertionPoint?.label ?? text.noEquation;

  const receipt = fixed && result?.ok;
  return <section ref={panel} className={contextual ? "space-y-2 p-3 text-xs" : "space-y-2 rounded border p-3 text-xs"} aria-label={text.title} data-testid="docx-equation-panel" data-docx-history="field">
    <div className="flex items-center justify-between gap-2">
      <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">{contextual ? text.editSource : text.title}</h3>
      {contextual && <Button ref={closeButton} size="icon" variant="ghost" className="size-6" title={t(($) => $.common.actions.close)}
        aria-label={t(($) => $.common.actions.close)} onClick={() => contextual.onClose(true)}><X className="size-4" /></Button>}
    </div>
    {!active || (!fixed && (!selectionKey || !paragraph)) ? <p className="text-muted-foreground">{text.noSelection}</p> : !receipt && <>
      {!fixed && paragraph && <div className="space-y-1">
        <label className="block font-medium" htmlFor={`${id}-target`}>{text.target}</label>
        <select id={`${id}-target`} className="w-full rounded border p-1" value={selectedObjectRef ?? ""}
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
      </div>}
      <div className="space-y-1">
        <label className="block font-medium" htmlFor={`${id}-latex`}>{text.source}</label>
        <textarea id={`${id}-latex`} className="h-24 w-full rounded border p-1 font-mono" value={latex} disabled={writing}
          onChange={(event) => { setLatex(event.target.value); markDraft({ latex: event.target.value }); }} />
      </div>
      <div className="space-y-1">
        <label className="block font-medium" htmlFor={`${id}-macros`}>{text.macros}</label>
        <textarea id={`${id}-macros`} className="h-16 w-full rounded border p-1 font-mono" value={macros} disabled={writing}
          onChange={(event) => { setMacros(event.target.value); markDraft({ macros: event.target.value }); }} />
      </div>
      <Button size="sm" variant="outline" disabled={!latex.trim() || previewPending || writing} onClick={(event) => {
        const button = event.currentTarget;
        if (button.ownerDocument.activeElement === button) {
          (closeButton.current ?? heading.current)?.focus({ preventScroll: true });
        }
        void previewSource();
      }}>{text.preview}</Button>
      {preview && <div className="overflow-x-auto rounded border p-2" data-testid="docx-equation-preview">
        {"svg" in preview ? <EquationPreview svg={preview.svg} /> : <p className="break-words text-destructive">{preview.error}</p>}
      </div>}
      {!fixed && <p className="text-muted-foreground">{text.previewHelp}</p>}
      {!fixed && <div className="flex items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" name="docx-equation-placement" checked={!display} disabled={!!selected || writing}
            onChange={() => { setDisplay(false); markDraft(); }} />{text.inline}
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="docx-equation-placement" checked={display} disabled={!!selected || writing || !displayInsertAvailable}
            onChange={() => { setDisplay(true); markDraft(); }} />{text.display}
        </label>
      </div>}
      {!selected && !displayInsertAvailable && <p className="text-muted-foreground">{text.displayRequiresEmptyParagraph}</p>}
      {selected && selected.status !== "bound" && <>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={adoptSource} disabled={writing}
            onChange={(event) => { setAdoptSource(event.target.checked); markDraft({ adoptSource: event.target.checked }); }} />
          <span>{text.adopt}</span>
        </label>
        {!fixed && <p className="text-muted-foreground">{text.adoptHelp}</p>}
      </>}
      <Button size="sm" onClick={() => void write()} disabled={!canWrite}>
        {writing ? <Spinner size="sm" className="mr-1" /> : null}{selected ? text.replace : text.insert}
      </Button>
      {stale && <>
        <p role="status" className="text-amber-700 dark:text-amber-400">{fixed ? text.contextChanged : text.fingerprintMismatch}</p>
        {!fixed && <Button size="sm" variant="outline" disabled={writing} onClick={() => {
          if (focusIsInPanel()) heading.current?.focus({ preventScroll: true });
          const clearedCapture = paragraph?.capture && !captured;
          refresh(undefined, false, draft.current && paragraph && selected && !clearedCapture
            ? { paragraphRef: paragraph.paragraphRef, equation: selected } : undefined);
        }}>{text.refresh}</Button>}
      </>}
    </>}
    {result && <div role="status" className="space-y-1 rounded border p-2" data-testid="docx-equation-result">
        <p className={result.ok ? "text-muted-foreground" : "text-destructive"}>
          {result.ok ? text.results : text.writeFailed}{result.message ? `: ${result.message}` : ""}
        </p>
        {result.warnings.length > 0 && <ul className="list-disc pl-4 text-muted-foreground">
          {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>}
    </div>}
  </section>;
}

function EquationPreview({ svg }: { svg: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: MathJax output is sanitized with the SVG-only profile above.
  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}

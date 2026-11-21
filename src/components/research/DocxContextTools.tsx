import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useDocxEditor } from "@docx-editor.dev/react";
import { editorPreviewActive, selectedDrawingOverlayTargetOf, type PaginatedSurface } from "@docx-editor.dev/core/editor";
import { caretAt } from "@docx-editor.dev/core/layout";
import type { OoxmlPackage } from "@docx-editor.dev/core/store";
import { visibleFocusable } from "@oleafly/templates/modal-coordinator";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowUpRight, BookOpen, BookPlus, Copy, Download, LocateFixed, Maximize2, MessageSquarePlus, Sigma, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDismiss } from "@/components/ui/use-dismiss";
import { bytesToBase64 } from "@/lib/base64";
import { XLSX_MEDIA_TYPE } from "@/lib/docx-chart-workbook";
import { readDocxFieldAction } from "@/lib/docx-citation-fields";
import { DOCX_CITATION_PREVIEW, docxCitationWriteRestriction, isDocxCitationBodyParagraph, type DocxCitationInsertRequest } from "@/lib/docx-citation-write";
import { readDocxContextDrawing, readDocxDrawingAtCaret, selectDocxDrawingAtCaret } from "@/lib/docx-context-drawing";
import type { DocxImageReadRequest } from "@/lib/docx-images";
import { readDocxMaterialSelection, type DocxMaterialSelection } from "@/lib/docx-material";
import { createDocxFieldReader, type DocxSession } from "@/lib/docx-session";
import { downloadBytes } from "@/lib/download-blob";
import { pickSavePath } from "@/lib/native-file-dialog";
import { openInSystemBrowser } from "@/lib/system-browser";
import { writeBytesFile } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { DocxCitationPicker, type DocxCitationPickerRefusal } from "./DocxCitationPicker";
import { DocxEquationPanel, readParagraphEquations, type DocxEquationDraft, type DocxEquationTarget } from "./DocxEquationPanel";

type SurfaceEquation = NonNullable<ReturnType<PaginatedSurface["equations"]["equationAtCaret"]>>;
type SurfaceSelection = ReturnType<PaginatedSurface["state"]>["selection"];
type FieldHit = NonNullable<ReturnType<typeof readDocxFieldAction>>;
type DrawingTarget = {
  surface: PaginatedSurface;
  drawingId: string;
  session: DocxSession;
  sessionId: string;
} & ({ kind: "image"; request: DocxImageReadRequest } |
  { kind: "chart"; workbook: Uint8Array; revision: number });
type CitationTarget = Omit<DocxCitationInsertRequest, "source"> & {
  surface: PaginatedSurface;
  paragraphId: string;
  pageIndex: number;
  layout: ReturnType<PaginatedSurface["publishedLayout"]>;
  caret: { x: number; y: number; height: number };
  pkg: OoxmlPackage;
};
type Target = { keyboard: boolean } & (
  | { kind: "equation"; surface: PaginatedSurface; painted: SurfaceEquation; write: DocxEquationTarget; session: DocxSession; sessionId: string; drafts: Map<string, DocxEquationDraft> }
  | { kind: "field"; hit: FieldHit; paragraphId: string; placement: { anchor: HTMLElement }; isCurrent(): boolean }
  | { kind: "insert-citation"; captured: CitationTarget; session: DocxSession; sessionId: string }
  | DrawingTarget
  | { kind: "text"; line: HTMLElement; selection: DocxMaterialSelection | null; revision?: number; isCurrent(): boolean }
);

const paintedField = '[data-field-atom="field"][data-paragraph-id][data-start][data-end]';
const paintedDrawing = ".docx-drawing[data-drawing-node-id]";
const drawingFrame = ".docx-image-selection-overlay__frame";

function drawingPointerId(element: Element | null) {
  return element?.closest<HTMLElement>(paintedDrawing)?.dataset.drawingNodeId ??
    element?.closest(drawingFrame)?.parentElement?.dataset.drawingNodeId;
}

function selectedDrawing(surface: PaginatedSurface | null, target: DrawingTarget) {
  if (surface !== target.surface || surface.activeScope().kind !== "body") return null;
  const drawing = selectedDrawingOverlayTargetOf(surface);
  return drawing?.id === target.drawingId ? drawing : null;
}

function matchesCitationCaret(surface: PaginatedSurface, target: CitationTarget) {
  if (target.surface !== surface || surface.activeScope().kind !== "body") return false;
  const { anchor, head } = surface.state().selection;
  return anchor.paragraphId === target.paragraphId && head.paragraphId === target.paragraphId &&
    anchor.offset === target.modelOffset && head.offset === target.modelOffset;
}

function matchesSelection(left: SurfaceSelection, right: SurfaceSelection) {
  return left.anchor.paragraphId === right.anchor.paragraphId && left.anchor.offset === right.anchor.offset &&
    left.head.paragraphId === right.head.paragraphId && left.head.offset === right.head.offset;
}

function fieldSelector(paragraphId: string, { start, end }: FieldHit["range"]) {
  return `${paintedField}[data-paragraph-id="${CSS.escape(paragraphId)}"][data-start="${start}"][data-end="${end}"]`;
}

function visibleFieldAnchor(viewport: HTMLElement, bounds: DOMRect, selector: string, near?: DOMRect) {
  let anchor: HTMLElement | undefined;
  let closest = Infinity;
  for (const candidate of viewport.querySelectorAll<HTMLElement>(selector)) {
    const rect = candidate.getBoundingClientRect();
    if (!rect.width || !overlaps(rect, bounds)) continue;
    if (!near) return candidate;
    const centerY = near.top + near.height / 2;
    const distance = Math.hypot(Math.max(rect.left - near.left, near.left - rect.right, 0),
      Math.max(rect.top - centerY, centerY - rect.bottom, 0));
    if (distance < closest) {
      closest = distance;
      anchor = candidate;
    }
  }
  return anchor;
}

function equationTarget(surface: PaginatedSurface, session: DocxSession, equation: SurfaceEquation) {
  const paraId = surface.session.paraIdOf(equation.paragraphId);
  const handle = paraId && session.paragraphHandleForId?.(paraId);
  if (!handle) return null;
  const paragraph = session.readParagraph(handle);
  const match = readParagraphEquations(paragraph).find((item) =>
    item.offset === equation.start && item.end === equation.end);
  return match ? { paragraphRef: paragraph.paragraphRef, revision: paragraph.revision, equation: match } : null;
}

export function overlaps(rect: DOMRect, viewport: DOMRect) {
  return rect.right > viewport.left && rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom;
}

export function tabThroughDocxControls(panel: HTMLElement, event: Pick<KeyboardEvent, "shiftKey" | "preventDefault">, wrap = false) {
  const controls = visibleFocusable(Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
  )).filter((control) => control.tabIndex >= 0));
  const focused = panel.ownerDocument.activeElement;
  const active = focused instanceof HTMLElement ? controls.indexOf(focused) : -1;
  const next = controls[active + (event.shiftKey ? -1 : 1)];
  const control = next ?? (wrap ? controls.at(event.shiftKey ? -1 : 0) ?? panel : null);
  if (!control) return;
  event.preventDefault();
  control.focus();
}

export function useDocxOverlayPlacement(
  panelRef: RefObject<HTMLDivElement | null>,
  findAnchor: (viewport: HTMLElement, bounds: DOMRect) => { rect: DOMRect; sheet?: DOMRect } | null,
  minimumHeight: number,
  onPlacement: (placed: boolean, panel: HTMLDivElement, viewport: HTMLElement, obstructsSibling: boolean) => void,
  allowEdge = false,
  avoid?: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = panel?.closest<HTMLElement>("section");
    const viewport = container?.querySelector<HTMLElement>(".docx-editor__scroll-container");
    const view = viewport?.ownerDocument.defaultView;
    if (!panel || !container || !viewport || !view) return;
    const sibling = avoid?.current;
    let frame = 0;
    const position = () => {
      frame = 0;
      const bounds = viewport.getBoundingClientRect();
      const anchor = findAnchor(viewport, bounds);
      const siblingBounds = sibling && !sibling.inert ? sibling.getBoundingClientRect() : undefined;
      const placed = anchor !== null && placeOverlay(panel, container, bounds, anchor, minimumHeight, allowEdge, siblingBounds);
      onPlacement(placed, panel, viewport, placed && !!siblingBounds && overlaps(panel.getBoundingClientRect(), siblingBounds));
      panel.style.visibility = placed ? "visible" : "hidden";
      if (placed) panel.removeAttribute("inert");
      else panel.setAttribute("inert", "");
    };
    const schedule = () => { if (!frame) frame = view.requestAnimationFrame(position); };
    const resize = new view.ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(panel);
    if (sibling) resize.observe(sibling);
    const repaint = new view.MutationObserver(schedule);
    repaint.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    if (sibling) repaint.observe(sibling, { attributes: true, attributeFilter: ["style", "inert"] });
    viewport.addEventListener("scroll", schedule, { passive: true });
    position();
    return () => {
      resize.disconnect();
      repaint.disconnect();
      viewport.removeEventListener("scroll", schedule);
      view.cancelAnimationFrame(frame);
    };
  }, [allowEdge, avoid, findAnchor, minimumHeight, onPlacement, panelRef]);
}

function placeOverlay(panel: HTMLDivElement, container: HTMLElement, bounds: DOMRect,
  { rect, sheet }: { rect: DOMRect; sheet?: DOMRect }, minimumHeight: number, allowEdge: boolean, avoid?: DOMRect) {
  if (!overlaps(rect, bounds)) return false;
  const origin = container.getBoundingClientRect();
  const scaleX = origin.width / container.offsetWidth || 1;
  const scaleY = origin.height / container.offsetHeight || 1;
  let left = Math.max(bounds.left, sheet?.left ?? bounds.left) + 4;
  let right = Math.min(bounds.right, sheet?.right ?? bounds.right) - 4;
  const above = rect.top - bounds.top - 8;
  const below = bounds.bottom - rect.bottom - 8;
  const room = Math.max(above, below);
  const atEdge = room < minimumHeight * scaleY || right <= left;
  if (atEdge) {
    if (!allowEdge || bounds.height < 38 * scaleY || bounds.width < 8) return false;
    left = bounds.left + 4;
    right = bounds.right - 4;
  }
  panel.style.maxWidth = `${(right - left) / scaleX}px`;
  panel.style.maxHeight = `${(atEdge ? bounds.height - 8 : room) / scaleY}px`;
  const size = panel.getBoundingClientRect();
  const flip = above > below && (atEdge || size.height > below);
  if (!atEdge) panel.style.maxHeight = `${(flip ? above : below) / scaleY}px`;
  const anchoredBottom = atEdge ? !flip : flip;
  const edge = atEdge ? (flip ? bounds.top + 4 : bounds.bottom - 4) :
    flip ? rect.top - 4 : rect.bottom + 4;
  panel.style.left = `${(Math.max(left, Math.min(rect.left, right - size.width)) - origin.left) / scaleX}px`;
  panel.style.top = anchoredBottom ? "" : `${(edge - origin.top) / scaleY}px`;
  panel.style.bottom = anchoredBottom ? `${(origin.bottom - edge) / scaleY}px` : "";
  if (avoid) {
    const placed = panel.getBoundingClientRect();
    if (overlaps(placed, avoid)) {
      const after = avoid.right + 4;
      const before = avoid.left - 4 - placed.width;
      if (after + placed.width <= bounds.right - 4) panel.style.left = `${(after - origin.left) / scaleX}px`;
      else if (before >= bounds.left + 4) panel.style.left = `${(before - origin.left) / scaleX}px`;
      else {
        const aboveSibling = avoid.top - 2 - placed.height;
        const belowSibling = avoid.bottom + 2;
        const vertical = aboveSibling >= bounds.top + 4 ? aboveSibling :
          belowSibling + placed.height <= bounds.bottom - 4 ? belowSibling : null;
        if (vertical !== null) {
          panel.style.bottom = "";
          panel.style.top = `${(vertical - origin.top) / scaleY}px`;
        } else {
          const roomLeft = avoid.left - bounds.left - 8;
          const roomRight = bounds.right - after - 4;
          const width = Math.max(roomLeft, roomRight);
          const widestAction = Math.max(...Array.from(panel.children, (action) => action.getBoundingClientRect().width));
          if (width >= widestAction + 6 * scaleX) {
            panel.style.maxWidth = `${width / scaleX}px`;
            panel.style.maxHeight = `${(bounds.height - 8) / scaleY}px`;
            const wrapped = panel.getBoundingClientRect();
            const horizontal = roomRight >= roomLeft ? after : avoid.left - 4 - wrapped.width;
            const top = Math.max(bounds.top + 4, Math.min(placed.top, bounds.bottom - 4 - wrapped.height));
            panel.style.left = `${(horizontal - origin.left) / scaleX}px`;
            panel.style.bottom = "";
            panel.style.top = `${(top - origin.top) / scaleY}px`;
          }
        }
      }
    }
  }
  return true;
}

const actionClass = "h-7 gap-1.5 px-2 text-xs";

export interface DocxSelectionAnnotation {
  selection: DocxMaterialSelection;
  line: HTMLElement;
  revision?: number;
}

export function DocxContextTools({ working, onAnnotate, reviewEntry, feedbackVisible = false, onOpenPanel, onEquationTargetChange }: {
  working?: { session: DocxSession; sessionId: string; equationDrafts: Map<string, DocxEquationDraft> };
  onAnnotate(target: DocxSelectionAnnotation): Promise<void>;
  reviewEntry?: { content: ReactNode; panel: RefObject<HTMLDivElement | null> };
  feedbackVisible?: boolean;
  onOpenPanel?(): void;
  onEquationTargetChange?(target: DocxEquationTarget): void;
}) {
  const editor = useDocxEditor();
  const { t } = useTranslation(["researchTools", "editor", "common"]);
  const editLabel = t(($) => $.researchTools.docx.equationTools.editSource);
  const citationLabel = t(($) => $.researchTools.docx.fieldTools.viewCitation);
  const insertCitationLabel = t(($) => $.researchTools.docx.fieldTools.insertCitation);
  const imageLabel = t(($) => $.researchTools.docx.imageTools.view);
  const exportWorkbookLabel = t(($) => $.researchTools.docx.chartTools.exportWorkbook);
  const [target, setTarget] = useState<Target | null>(null);
  const [editing, setEditing] = useState(false);
  const [reviewObstructed, setReviewObstructed] = useState(false);
  const [image, setImage] = useState<{ url: string; description?: string } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const activeChart = useRef<Extract<Target, { kind: "chart" }> | null>(null);
  const exportingWorkbook = useRef(false);
  const explicitEquation = useRef<{ id: string; revision: number; selection: SurfaceSelection } | null>(null);
  const session = working?.session;
  const sessionId = working?.sessionId;
  const equationDrafts = working?.equationDrafts;
  const previousFeedbackVisible = useRef(feedbackVisible);

  const openPanel = () => {
    onOpenPanel?.();
    setEditing(true);
  };

  const close = useCallback((restoreFocus = false) => {
    setTarget(null);
    setEditing(false);
    setImage(null);
    if (restoreFocus) editor?.focus();
  }, [editor]);
  useLayoutEffect(() => {
    if (feedbackVisible && !previousFeedbackVisible.current) close();
    previousFeedbackVisible.current = feedbackVisible;
  }, [close, feedbackVisible]);
  useDismiss(!!target, [overlay], () => close());
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => {
    if (!editor) return;
    return editor.on("selectionChange", () => {
      const marker = explicitEquation.current;
      const surface = editor.surface;
      if (marker && (!surface || !matchesSelection(surface.state().selection, marker.selection))) {
        explicitEquation.current = null;
      }
    });
  }, [editor]);

  useEffect(() => {
    const container = host.current?.parentElement;
    const viewport = container?.querySelector<HTMLElement>(".docx-editor__scroll-container");
    if (!editor || !container || !viewport) return;
    let original: { surface: PaginatedSurface; reader: ReturnType<typeof createDocxFieldReader> } | undefined;
    const originalParagraphs = (surface: PaginatedSurface) => {
      if (original?.surface !== surface) {
        original?.reader.dispose();
        original = { surface, reader: createDocxFieldReader(editor, surface.session) };
      }
      return original.reader;
    };

    const equationCandidate = (surface: PaginatedSurface, painted: SurfaceEquation,
      keyboard: boolean): Extract<Target, { kind: "equation" }> | null => {
      if (!session?.writeEquation || !sessionId || !equationDrafts || surface.editingMode() !== "edit") return null;
      const write = equationTarget(surface, session, painted);
      if (!write) return null;
      return { kind: "equation", keyboard, surface, painted, write, session, sessionId, drafts: equationDrafts };
    };

    const fieldCandidate = (surface: PaginatedSurface, paragraphId: string, start: number, end: number,
      keyboard: boolean, painted?: HTMLElement): Extract<Target, { kind: "field" }> | null => {
      const paraId = surface.session.paraIdOf(paragraphId);
      if (!paraId) return null;
      const reader = session ?? originalParagraphs(surface);
      const handle = reader.paragraphHandleForId?.(paraId);
      if (!handle) return null;
      const hit = readDocxFieldAction(reader.readParagraph(handle), { start, end }, () => surface.session.currentPackage());
      if (!hit || (hit.action.kind === "reference" && !surface.session.bookmarks().has(hit.action.bookmark))) return null;
      const caret = keyboard ? viewport.querySelector<HTMLElement>("[data-docx-caret]")?.getBoundingClientRect() : undefined;
      const anchor = painted ?? visibleFieldAnchor(viewport, viewport.getBoundingClientRect(), fieldSelector(paragraphId, hit.range), caret);
      if (!anchor) return null;
      return { kind: "field", keyboard, hit, paragraphId, placement: { anchor },
        isCurrent: () => editor.surface === surface && surface.activeScope().kind === "body" &&
          reader.revision() === hit.revision };
    };

    const activateField = (surface: PaginatedSurface, paragraphId: string, start: number, end: number,
      keyboard: boolean, painted?: HTMLElement) => {
      const field = fieldCandidate(surface, paragraphId, start, end, keyboard, painted);
      if (!field) return false;
      setEditing(false);
      setTarget(field);
      return true;
    };

    const activateDrawing = (surface: PaginatedSurface, keyboard: boolean, pointerId?: string) => {
      if (!session || !sessionId) return false;
      const intent = surface.drawingSelectionIntent();
      if (intent.kind !== "pointer" || (!keyboard && intent.drawingNodeId !== pointerId)) return false;
      const drawing = readDocxContextDrawing(surface, session);
      if (drawing.kind !== "image" && drawing.kind !== "chart") return false;
      const action = drawing.kind === "image" && drawing.previewable && drawing.readImage
        ? { kind: "image" as const, request: drawing.readImage }
        : drawing.kind === "chart" && drawing.workbook
          ? { kind: "chart" as const, workbook: drawing.workbook, revision: session.revision() }
          : null;
      if (!action) return false;
      setImage(null);
      setEditing(false);
      setTarget({ ...action, keyboard, surface, drawingId: drawing.target.id, session, sessionId });
      return true;
    };

    const fieldFromPointer = (surface: PaginatedSurface, target: Element, event: MouseEvent,
      press?: { x: number; y: number }) => {
      const pages = target.closest(".docx-pages");
      const pointed = viewport.ownerDocument.elementFromPoint(event.clientX, event.clientY);
      const line = pointed?.closest(".docx-line");
      if (!line || !pages?.contains(line)) return false;
      const fields = Array.from(line.querySelectorAll<HTMLElement>(paintedField)).filter((field) => {
        const rect = field.getBoundingClientRect();
        const contains = (x: number, y: number) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
        return contains(event.clientX, event.clientY) && (!press || contains(press.x, press.y));
      });
      if (fields.length !== 1) return false;
      const [field] = fields;
      if (!field?.dataset.paragraphId) return false;
      surface.flushPendingInput();
      return activateField(surface, field.dataset.paragraphId, Number(field.dataset.start), Number(field.dataset.end), false, field);
    };

    const request = (event: MouseEvent | KeyboardEvent, keyboard: boolean) => {
      const surface = editor.surface;
      const element = event.target as Element;
      const pages = element.closest(".docx-pages");
      const imageFrame = element.closest<HTMLElement>(".docx-image-selection-overlay");
      if ((!pages && !(keyboard && imageFrame)) || surface?.activeScope().kind !== "body" || event.defaultPrevented) return;
      surface.flushPendingInput();
      const modelSelection = surface.state().selection;
      const { anchor, head } = modelSelection;
      const sameParagraph = anchor.paragraphId === head.paragraphId;
      if (keyboard && activateDrawing(surface, true)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!pages) return;
      const snapshot = editor.snapshot();
      if (keyboard) {
        const start = Math.min(anchor.offset, head.offset);
        const end = Math.max(anchor.offset, head.offset);
        const field = sameParagraph && snapshot.selectionCollapsed
          ? fieldCandidate(surface, head.paragraphId, start, end, true)
          : null;
        const selectedEquation = explicitEquation.current;
        const equations = session?.writeEquation
          ? surface.equations.equationsInCaretParagraph()
            .filter((item) => snapshot.selectionCollapsed
              ? item.start <= head.offset && head.offset <= item.end
              : sameParagraph && start === item.start && end === item.end &&
                selectedEquation !== null && selectedEquation.id === item.id &&
                selectedEquation.revision === session.revision() &&
                matchesSelection(surface.state().selection, selectedEquation.selection))
            .map((item) => equationCandidate(surface, item, true))
            .filter((item): item is NonNullable<typeof item> => item !== null)
          : [];
        const drawing = session && snapshot.selectionCollapsed
          ? readDocxDrawingAtCaret(surface, session)
          : { kind: "none" } as const;
        const candidates = [field, ...equations, drawing.kind === "drawing" ? drawing : null]
          .filter((item) => item !== null);
        if (candidates.length > 1 || drawing.kind === "ambiguous") {
          event.preventDefault();
          return;
        }
        const [candidate] = candidates;
        if (candidate?.kind === "drawing") {
          if (!session || !selectDocxDrawingAtCaret(surface, session) || !activateDrawing(surface, true)) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (candidate) {
          if (candidate.kind === "equation") onEquationTargetChange?.(candidate.write);
          setEditing(false);
          setTarget(candidate);
          event.preventDefault();
          return;
        }
      }

      if (!keyboard && snapshot.selectionCollapsed && event instanceof MouseEvent && fieldFromPointer(surface, element, event)) {
        event.preventDefault();
        return;
      }

      if (DOCX_CITATION_PREVIEW && session?.insertCitation && sessionId && snapshot.selectionCollapsed &&
        surface.editingMode() === "edit" && !surface.collaborationSession() && !editorPreviewActive(editor) &&
        surface.drawingSelectionIntent().kind === "none") {
        const { head } = surface.state().selection;
        const part = surface.session.part();
        const pkg = surface.session.currentPackage();
        const paraId = surface.session.paraIdOf(head.paragraphId);
        const handle = paraId && session.paragraphHandleForId?.(paraId);
        const caret = pages.querySelector<HTMLElement>("[data-docx-caret]");
        const page = caret?.closest<HTMLElement>(".docx-page[data-page-index]");
        if (!handle || !caret || !page || !isDocxCitationBodyParagraph(part, head.paragraphId) ||
          surface.isInsideToc(head.paragraphId) || docxCitationWriteRestriction(pkg)) return;
        const paragraph = session.readParagraph(handle);
        if (paragraph.atoms.some(({ kind, modelRange }) => (kind === "field" || kind === "math") &&
          modelRange.start <= head.offset && head.offset <= modelRange.end)) return;
        const bounds = page.getBoundingClientRect();
        const position = caret.getBoundingClientRect();
        if (!overlaps(position, viewport.getBoundingClientRect()) || (!keyboard && event instanceof MouseEvent &&
          (Math.abs(event.clientX - position.left) > 8 || event.clientY < position.top || event.clientY > position.bottom))) return;
        const captured = { surface, pageIndex: Number(page.dataset.pageIndex), layout: surface.publishedLayout(),
          paragraphId: head.paragraphId, modelOffset: head.offset,
          paragraphRef: paragraph.paragraphRef, expectedRevision: paragraph.revision, pkg,
          caret: { x: (position.left - bounds.left) / bounds.width, y: (position.top - bounds.top) / bounds.height,
            height: position.height / bounds.height } };
        event.preventDefault();
        setEditing(false);
        setTarget({ kind: "insert-citation", keyboard, captured, session, sessionId });
        return;
      }

      const selection = readDocxMaterialSelection(editor, snapshot);
      const copyOnly = !snapshot.selectionCollapsed && !sameParagraph;
      const native = viewport.ownerDocument.getSelection();
      if ((!selection?.quote && !copyOnly) || !native?.rangeCount) return;
      const range = native.getRangeAt(0);
      if (range.collapsed || !pages.contains(range.commonAncestorContainer)) return;
      let node = native.focusNode;
      if (!keyboard && event instanceof MouseEvent) {
        const { clientX, clientY } = event;
        if (!Array.from(range.getClientRects()).some((rect) =>
          clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom)) return;
        node = viewport.ownerDocument.elementFromPoint(clientX, clientY);
      }
      const line = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".docx-line");
      if (!line || !pages.contains(line)) return;
      event.preventDefault();
      setEditing(false);
      const modelRevision = surface.session.revision();
      setTarget({ kind: "text", keyboard, selection, line, revision: session?.revision(),
        isCurrent: () => editor.surface === surface && surface.activeScope().kind === "body" &&
          surface.session.revision() === modelRevision && matchesSelection(surface.state().selection, modelSelection) });
    };
    const onContextMenu = (event: MouseEvent) => {
      if (event.clientX === 0 && event.clientY === 0) flushSync(() => request(event, true));
      else request(event, false);
    };
    const equationSelector = ".docx-pages [data-docx-equation]";
    let objectPress: { drawingId?: string; equationId?: string; pointerId: number; x: number; y: number; dragged: boolean; modified: boolean } | null = null;
    const onObjectDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      const element = event.target as Element;
      objectPress = event.button === 0
        ? { drawingId: drawingPointerId(element), equationId: element.closest<HTMLElement>(equationSelector)?.dataset.docxEquation,
          pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragged: false,
          modified: event.shiftKey || event.altKey || event.metaKey || event.ctrlKey } : null;
    };
    const onObjectMove = (event: PointerEvent) => {
      if (objectPress?.pointerId !== event.pointerId) return;
      if (event.type === "pointercancel") objectPress = null;
      else if (Math.hypot(event.clientX - objectPress.x, event.clientY - objectPress.y) > 4) objectPress.dragged = true;
    };
    const isSingleClick = (event: MouseEvent, press: NonNullable<typeof objectPress>) =>
      !press.dragged && !press.modified && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4 &&
      !event.defaultPrevented && event.detail === 1 && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    const onEquationClick = (event: MouseEvent) => {
      const press = objectPress;
      if (!press?.equationId && !(event.target as Element).closest(equationSelector)) return;
      event.stopPropagation();
      objectPress = null;
      const surface = editor.surface;
      if (!press?.equationId || !isSingleClick(event, press) || surface?.activeScope().kind !== "body") return;
      const pointed = viewport.ownerDocument.elementFromPoint(event.clientX, event.clientY);
      if (pointed?.closest<HTMLElement>(equationSelector)?.dataset.docxEquation !== press.equationId) return;
      const painted = surface.equations.equationById(press.equationId);
      const candidate = painted && equationCandidate(surface, painted, false);
      if (!candidate) return;
      const { paragraphId, start, end } = candidate.painted;
      const selection = { anchor: { paragraphId, offset: start }, head: { paragraphId, offset: end } };
      surface.setSelection(selection);
      explicitEquation.current = { id: candidate.painted.id, revision: candidate.session.revision(), selection };
      onEquationTargetChange?.(candidate.write);
      setEditing(false);
      setTarget(candidate);
    };
    const onClick = (event: MouseEvent) => {
      const surface = editor.surface;
      const element = event.target as Element;
      const press = objectPress;
      objectPress = null;
      if (!press || !isSingleClick(event, press) || !element.closest(`.docx-pages, ${drawingFrame}`) ||
        surface?.activeScope().kind !== "body" || !editor.snapshot().selectionCollapsed) return;
      const pointed = viewport.ownerDocument.elementFromPoint(event.clientX, event.clientY);
      if (press.drawingId && press.drawingId === drawingPointerId(pointed) && activateDrawing(surface, false, press.drawingId)) return;
      fieldFromPointer(surface, element, event, press);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        flushSync(() => request(event, true));
      }
    };
    viewport.addEventListener("contextmenu", onContextMenu);
    if (session?.writeEquation) viewport.addEventListener("click", onEquationClick, true);
    container.addEventListener("pointerdown", onObjectDown, true);
    container.addEventListener("pointermove", onObjectMove, true);
    container.addEventListener("pointercancel", onObjectMove, true);
    container.addEventListener("click", onClick);
    container.addEventListener("keydown", onKeyDown, true);
    return () => {
      original?.reader.dispose();
      viewport.removeEventListener("contextmenu", onContextMenu);
      viewport.removeEventListener("click", onEquationClick, true);
      container.removeEventListener("pointerdown", onObjectDown, true);
      container.removeEventListener("pointermove", onObjectMove, true);
      container.removeEventListener("pointercancel", onObjectMove, true);
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editor, equationDrafts, onEquationTargetChange, session, sessionId]);

  useEffect(() => {
    if (!editor || !target || (editing && target.kind === "equation")) return;
    const dismiss = () => close(overlay.current?.contains(overlay.current.ownerDocument.activeElement));
    const stopRevision = session?.subscribe(dismiss);
    if (target.kind === "equation") return stopRevision;
    const stopSelection = editor.on("selectionChange", () => {
      if (target.kind === "insert-citation" && editor.surface && matchesCitationCaret(editor.surface, target.captured)) return;
      if ((target.kind === "image" || target.kind === "chart") && selectedDrawing(editor.surface, target)) return;
      dismiss();
    });
    return () => { stopRevision?.(); stopSelection(); };
  }, [close, editing, editor, session, target]);

  const findAnchor = useCallback((viewport: HTMLElement, bounds: DOMRect) => {
    if (!target) return null;
    if (target.kind === "equation") {
      const anchor = viewport.querySelector<HTMLElement>(`[data-docx-equation="${CSS.escape(target.painted.id)}"]`);
      return anchor ? { rect: anchor.getBoundingClientRect(), sheet: anchor.closest(".docx-page")?.getBoundingClientRect() } : null;
    }
    if (target.kind === "field") {
      const { hit, paragraphId, placement } = target;
      const selector = fieldSelector(paragraphId, hit.range);
      const previous = placement.anchor;
      const rect = viewport.contains(previous) && previous.matches(selector) ? previous.getBoundingClientRect() : undefined;
      if (rect?.width && overlaps(rect, bounds)) return { rect, sheet: previous.closest(".docx-page")?.getBoundingClientRect() };
      const anchor = visibleFieldAnchor(viewport, bounds, selector, rect);
      if (!anchor) return null;
      placement.anchor = anchor;
      return { rect: anchor.getBoundingClientRect(), sheet: anchor.closest(".docx-page")?.getBoundingClientRect() };
    }
    if (target.kind === "insert-citation") {
      const { surface, pageIndex, layout, caret, paragraphId, modelOffset } = target.captured;
      const currentLayout = surface.publishedLayout();
      const moved = currentLayout !== layout;
      const position = moved ? caretAt(currentLayout, { paragraphId, offset: modelOffset }, { preferredPageIndex: pageIndex }) : null;
      if (moved && !position) return null;
      const page = viewport.querySelector<HTMLElement>(`.docx-page[data-page-index="${position?.pageIndex ?? pageIndex}"]`);
      if (!page) return null;
      const sheet = page.getBoundingClientRect();
      if (position) {
        const content = page.querySelector<HTMLElement>(".docx-page-content");
        if (!content) return null;
        const origin = content.getBoundingClientRect();
        const scale = surface.overlayCoordinates().paintScale * sheet.width / page.offsetWidth;
        return { sheet, rect: new DOMRect(origin.left + position.x * scale, origin.top + position.y * scale, 1, position.height * scale) };
      }
      return { sheet, rect: new DOMRect(sheet.left + caret.x * sheet.width, sheet.top + caret.y * sheet.height, 1, caret.height * sheet.height) };
    }
    if (target.kind === "image" || target.kind === "chart") {
      const drawing = selectedDrawing(editor?.surface ?? null, target);
      if (!drawing) return null;
      const page = viewport.querySelector<HTMLElement>(`.docx-page[data-page-index="${drawing.pageIndex}"]`);
      const anchor = page?.querySelector<HTMLElement>(`${paintedDrawing}[data-drawing-node-id="${CSS.escape(drawing.id)}"]`);
      return anchor ? { rect: anchor.getBoundingClientRect(), sheet: page?.getBoundingClientRect() } : null;
    }
    const { line } = target;
    return viewport.contains(line) ? { rect: line.getBoundingClientRect(), sheet: line.closest(".docx-page")?.getBoundingClientRect() } : null;
  }, [editor, target]);
  const reviewPanel = reviewEntry?.panel;
  const onPlacement = useCallback((placed: boolean, panel: HTMLDivElement, viewport: HTMLElement, obstructsSibling: boolean) => {
    if (obstructsSibling && reviewPanel?.current?.contains(panel.ownerDocument.activeElement)) {
      setReviewObstructed(false);
      close();
      return;
    }
    setReviewObstructed(obstructsSibling);
    if (placed) return;
    if (panel.contains(panel.ownerDocument.activeElement)) viewport.focus({ preventScroll: true });
    close();
  }, [close, reviewPanel]);
  useDocxOverlayPlacement(overlay, findAnchor, editing ? 104 : 30, onPlacement, true, editing ? undefined : reviewPanel);

  const contextViewport = () => host.current?.parentElement?.querySelector<HTMLElement>(".docx-editor__scroll-container");
  const isContextTargetVisible = (viewport = contextViewport()) => {
    if (!viewport) return false;
    const bounds = viewport.getBoundingClientRect();
    const anchor = findAnchor(viewport, bounds);
    return anchor !== null && overlaps(anchor.rect, bounds);
  };
  const requireVisibleTarget = (panel: HTMLDivElement, viewport: HTMLElement) => {
    if (isContextTargetVisible(viewport)) return true;
    onPlacement(false, panel, viewport, false);
    return false;
  };
  const canRunContextAction = (isCurrent: () => boolean) => {
    const panel = overlay.current;
    const viewport = contextViewport();
    if (!panel || !viewport) return false;
    editor?.surface?.flushPendingInput();
    if (isCurrent()) return requireVisibleTarget(panel, viewport);
    close(panel.contains(panel.ownerDocument.activeElement));
    return false;
  };

  useLayoutEffect(() => {
    const panel = overlay.current;
    const viewport = host.current?.parentElement?.querySelector<HTMLElement>(".docx-editor__scroll-container");
    if (!target || !panel || !viewport || !editor?.surface) return;
    const surface = editor.surface;
    if (target.kind === "chart") activeChart.current = target;
    const pin = (editing && (target.kind === "equation" || target.kind === "field")) || target.kind === "text" ? surface.retainSelection() : null;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(panel.contains(panel.ownerDocument.activeElement));
    };
    const onPanelKey = (event: KeyboardEvent) => {
      if (editing) event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Escape") {
        onEscape(event);
        return;
      }
      if (event.key === "Tab") tabThroughDocxControls(panel, event, editing);
    };
    const onViewportKey = (event: KeyboardEvent) => {
      onEscape(event);
      if (!editing && target.kind === "equation" && !event.defaultPrevented && !event.isComposing &&
        /^(?:Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|Tab)$/u.test(event.key)) close();
    };
    viewport.addEventListener("keydown", onViewportKey, true);
    panel.addEventListener("keydown", onPanelKey);
    if (!panel.inert && (editing || target.keyboard)) {
      const initialControl = editing && panel.querySelector<HTMLElement>(target.kind === "equation" ? "textarea" :
        target.kind === "insert-citation" ? 'input[type="search"]' : "ul a[href]");
      (initialControl || panel.querySelector("button") || panel).focus({ preventScroll: true });
    }
    return () => {
      activeChart.current = null;
      viewport.removeEventListener("keydown", onViewportKey, true);
      panel.removeEventListener("keydown", onPanelKey);
      if (pin) surface.releaseSelection(pin);
    };
  }, [close, editing, editor, target]);

  const openImage = (target: Extract<DrawingTarget, { kind: "image" }>) => {
    if (!target.session.readImage || !canRunContextAction(() => target.session === session && target.sessionId === sessionId &&
      selectedDrawing(editor?.surface ?? null, target) !== null && target.session.revision() === target.request.expectedRevision)) return;
    try {
      const result = target.session.readImage(target.request);
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
      setImage({ url, description: result.description });
      openPanel();
    } catch {
      close(true);
      toast.error(t(($) => $.researchTools.docx.imageTools.unavailable));
    }
  };

  const exportWorkbook = async (target: Extract<Target, { kind: "chart" }>) => {
    const panel = overlay.current;
    const isCurrent = () => activeChart.current === target && panel?.isConnected && !panel.closest("[inert]") &&
      target.session.revision() === target.revision && isContextTargetVisible();
    if (exportingWorkbook.current || target.session !== session || target.sessionId !== sessionId || !isCurrent()) return;
    const filename = "chart-workbook.xlsx";
    exportingWorkbook.current = true;
    try {
      if (isTauri()) {
        const path = await pickSavePath({ defaultPath: filename, filters: [{ name: "Excel", extensions: ["xlsx"] }] });
        if (!path || !isCurrent()) return;
        await writeBytesFile(path, bytesToBase64(target.workbook));
      } else {
        downloadBytes(target.workbook, XLSX_MEDIA_TYPE, filename);
      }
      if (isCurrent()) close(panel?.contains(panel.ownerDocument.activeElement));
    } catch {
      toast.error(t(($) => $.researchTools.docx.chartTools.exportFailed));
    } finally {
      exportingWorkbook.current = false;
    }
  };

  const runTextAction = (text: Extract<Target, { kind: "text" }>, action: "copy" | "annotate") => {
    if (!canRunContextAction(text.isCurrent)) return;
    if (action === "copy") {
      const result = editor?.exec({ type: "copy" });
      if (result && !result.ok) toast.error(t(($) => $.researchTools.docx.copySelectionRefused));
      close(true);
      return;
    }
    if (!text.selection) return;
    close(true);
    void onAnnotate({ selection: text.selection, line: text.line, revision: text.revision }).catch((cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const runFieldAction = (field: Extract<Target, { kind: "field" }>) => {
    if (!canRunContextAction(field.isCurrent)) return;
    if (field.hit.action.kind === "citation") openPanel();
    else {
      close(true);
      editor?.surface?.navigation.goToBookmark(field.hit.action.bookmark);
    }
  };

  const openEquation = (equation: Extract<Target, { kind: "equation" }>) => {
    if (canRunContextAction(() => editor?.surface === equation.surface && equation.surface.activeScope().kind === "body" &&
      equation.session === session && equation.sessionId === sessionId && equation.session.revision() === equation.write.revision)) openPanel();
  };

  const equationDraft = (equation: Extract<Target, { kind: "equation" }>, draft: DocxEquationDraft | null) => {
    if (equation.session.revision() !== equation.write.revision) return;
    const { objectRef } = equation.write.equation;
    if (draft) equation.drafts.set(objectRef, draft);
    else equation.drafts.delete(objectRef);
  };

  const isCurrentCitationTarget = (target: Extract<Target, { kind: "insert-citation" }>, surface?: PaginatedSurface | null) =>
    !!surface && target.session === session && target.sessionId === sessionId && matchesCitationCaret(surface, target.captured) &&
    target.session.revision() === target.captured.expectedRevision;

  const insertCitation = (target: Extract<Target, { kind: "insert-citation" }>, source: DocxCitationInsertRequest["source"]): DocxCitationPickerRefusal | null => {
    const surface = editor?.surface;
    const panel = overlay.current;
    const viewport = contextViewport();
    if (!surface || !panel || !viewport || panel.closest("[inert]")) return null;
    surface.flushPendingInput();
    const { captured } = target;
    if (!isCurrentCitationTarget(target, surface)) {
      close(panel.contains(panel.ownerDocument.activeElement));
      return null;
    }
    if (!requireVisibleTarget(panel, viewport)) return null;
    const result = target.session.insertCitation?.({ paragraphRef: captured.paragraphRef, expectedRevision: captured.expectedRevision,
      modelOffset: captured.modelOffset, source });
    if (!result?.ok) {
      if (result?.code === "unsupported-citation-metadata") return "metadata";
      return result?.code === "ambiguous-citation-source" ? "source" : "position";
    }
    if (!result.changed) return "position";
    const position = { paragraphId: captured.paragraphId, offset: captured.modelOffset + 1 };
    surface.setSelection({ anchor: position, head: position });
    close(true);
    return null;
  };

  return <div ref={host} className="contents">
    {!editing && reviewEntry && <div className={target && reviewObstructed ? "contents [&>*]:invisible!" : "contents"}
      inert={!!target && reviewObstructed}>{reviewEntry.content}</div>}
    {target ? <div ref={overlay} style={{ visibility: "hidden" }}
      onBlur={(event) => {
        if (!editing && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
      className={`absolute z-30 overflow-auto rounded-lg border bg-popover text-popover-foreground shadow-lg ${editing ? target.kind === "image" ? "w-xl" : "w-80" : "flex w-max flex-wrap p-0.5"}`}
      data-testid="docx-context-tools" {...(editing ? { role: "dialog", tabIndex: -1, "aria-label": target.kind === "field" ? citationLabel :
        target.kind === "insert-citation" ? insertCitationLabel : target.kind === "image" ? imageLabel : editLabel } : {})}>
      {target.kind === "equation" ? editing ?
        <DocxEquationPanel active session={target.session} sessionId={target.sessionId}
          contextual={{ target: target.write, draft: target.drafts.get(target.write.equation.objectRef),
            onDraftChange: (draft) => equationDraft(target, draft), onClose: close, isTargetVisible: isContextTargetVisible }} /> :
        <Button size="sm" variant="ghost" className={actionClass} aria-haspopup="dialog"
          onMouseDown={(event) => event.preventDefault()} onClick={() => openEquation(target)}>
          <Sigma className="size-3.5" />{editLabel}
        </Button> : target.kind === "field" ? (
          editing && target.hit.action.kind === "citation" ? <div className="flex max-h-[inherit] flex-col">
            <div className="flex shrink-0 justify-end border-b px-1 py-0.5">
              <Button size="icon" variant="ghost" className="size-7"
                aria-label={t(($) => $.common.actions.close)} onClick={() => close(true)}>
                <X className="size-3.5" />
              </Button>
            </div>
            <ul className="min-h-0 divide-y overflow-y-auto text-xs">
              {target.hit.action.sources.map((source, index) => <li key={`${index}:${source.title}`}>
                {source.url ? <Button asChild variant="ghost" className="h-auto w-full justify-between gap-2 rounded-none px-3 py-2 text-left whitespace-normal">
                  <a href={source.url} onClick={(event) => {
                    event.preventDefault();
                    if (canRunContextAction(target.isCurrent)) {
                      void openInSystemBrowser(event.currentTarget.href).then((opened) => {
                        if (!opened) toast.error(t(($) => $.researchTools.docx.fieldTools.openFailed));
                      });
                    }
                  }}>
                    <span className="min-w-0 break-words">{source.title}<span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">{new URL(source.url).hostname}</span></span>
                    <ArrowUpRight className="size-3.5 shrink-0" />
                  </a>
                </Button> : <span className="block break-words px-3 py-2">{source.title}</span>}
              </li>)}
            </ul>
          </div> : <Button size="sm" variant="ghost" className={actionClass}
            aria-haspopup={target.hit.action.kind === "citation" ? "dialog" : undefined}
            onMouseDown={(event) => event.preventDefault()} onClick={() => runFieldAction(target)}>
            {target.hit.action.kind === "citation" ? <><BookOpen className="size-3.5" />{citationLabel}</> :
              <><LocateFixed className="size-3.5" />{t(($) => $.researchTools.docx.fieldTools.goToReference)}</>}
          </Button>
        ) : target.kind === "insert-citation" ? editing ?
          <DocxCitationPicker pkg={target.captured.pkg} insert={(source) => insertCitation(target, source)} onClose={() => close(true)} /> :
          <Button size="sm" variant="ghost" className={actionClass} aria-haspopup="dialog"
            onMouseDown={(event) => event.preventDefault()} onClick={() => {
              if (canRunContextAction(() => isCurrentCitationTarget(target, editor?.surface))) openPanel();
            }}>
            <BookPlus className="size-3.5" />{insertCitationLabel}
        </Button> : target.kind === "image" ? editing && image ?
          <div className="flex max-h-[inherit] flex-col">
            <div className="flex shrink-0 justify-end border-b px-1 py-0.5">
              <Button size="icon" variant="ghost" className="size-7"
                aria-label={t(($) => $.common.actions.close)} onClick={() => close(true)}>
                <X className="size-3.5" />
              </Button>
            </div>
            <img className="min-h-0 w-full bg-white object-contain p-2" src={image.url} alt={image.description ?? ""} />
          </div> :
          <Button size="sm" variant="ghost" className={actionClass} aria-haspopup="dialog"
            onMouseDown={(event) => event.preventDefault()} onClick={() => openImage(target)}>
            <Maximize2 className="size-3.5" />{imageLabel}
        </Button> : target.kind === "chart" ?
        <Button size="sm" variant="ghost" className={actionClass}
          onMouseDown={(event) => event.preventDefault()} onClick={() => void exportWorkbook(target)}>
          <Download className="size-3.5" />{exportWorkbookLabel}
        </Button> : <>
          <Button size="sm" variant="ghost" className={actionClass} onMouseDown={(event) => event.preventDefault()}
            onClick={() => runTextAction(target, "copy")}>
            <Copy className="size-3.5" />{t(($) => $.editor.contextMenu.copy)}
          </Button>
          {target.selection && <Button size="sm" variant="ghost" className={actionClass}
            onMouseDown={(event) => event.preventDefault()} onClick={() => runTextAction(target, "annotate")}>
            <MessageSquarePlus className="size-3.5" />{t(($) => $.editor.materials.annotateSelection)}
          </Button>}
        </>}
    </div> : null}
  </div>;
}

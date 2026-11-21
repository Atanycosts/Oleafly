import {
  selectedDrawingOverlayTargetOf,
  type PaginatedSurface,
  type SelectedDrawingOverlayTarget,
} from "@docx-editor.dev/core/editor";
import {
  forEachSemanticDrawing,
  type DrawingPlaceholderKind,
  type SemanticDrawingVisit,
  type SemanticRootStoryKind,
  type SemanticStoryKind,
} from "@docx-editor.dev/core/layout";
import type { DocxImageReadRequest } from "./docx-images";
import { resolveDocxChartWorkbook } from "./docx-chart-workbook";
import type { DocxSession } from "./docx-session";

export type DocxContextDrawingFailure =
  | "selection-mismatch"
  | "not-body"
  | "layout-not-found"
  | "layout-ambiguous"
  | "paragraph-not-found"
  | "object-not-found"
  | "unsupported-graphic";

export interface DocxContextDrawingParagraph {
  readonly nodeId: string;
  readonly paraId: string;
  readonly paragraphRef: string;
}

type ResolvedDrawing =
  | {
      readonly kind: "image";
      readonly paragraph: DocxContextDrawingParagraph;
      readonly objectRef: string;
      readonly previewable: boolean;
      readonly readImage?: DocxImageReadRequest;
    }
  | {
      readonly kind: "chart";
      readonly paragraph: DocxContextDrawingParagraph;
      readonly objectRef: string;
      readonly workbook: Uint8Array | null;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: DocxContextDrawingFailure;
      readonly visit?: SemanticDrawingVisit;
    };

export type DocxContextDrawing =
  | { readonly kind: "none" }
  | {
      readonly kind: "image";
      readonly target: SelectedDrawingOverlayTarget;
      readonly paragraph: DocxContextDrawingParagraph;
      readonly objectRef: string;
      readonly previewable: boolean;
      readonly readImage?: DocxImageReadRequest;
    }
  | {
      readonly kind: "chart";
      readonly target: SelectedDrawingOverlayTarget;
      readonly paragraph: DocxContextDrawingParagraph;
      readonly objectRef: string;
      readonly workbook: Uint8Array | null;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: DocxContextDrawingFailure;
      readonly target: SelectedDrawingOverlayTarget;
      readonly story?: SemanticStoryKind;
      readonly rootStory?: SemanticRootStoryKind;
      readonly placeholderGraphicKind?: DrawingPlaceholderKind;
    };

export type DocxDrawingAtCaret =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | {
      readonly kind: "drawing";
      readonly drawingNodeId: string;
      readonly paragraphId: string;
    };

function unsupported(
  target: SelectedDrawingOverlayTarget,
  reason: DocxContextDrawingFailure,
  visit?: SemanticDrawingVisit,
): DocxContextDrawing {
  return {
    kind: "unsupported",
    reason,
    target,
    ...(visit === undefined
      ? {}
      : {
          story: visit.story,
          rootStory: visit.rootStory,
          ...(visit.drawing.placeholderGraphicKind === null
            ? {}
            : { placeholderGraphicKind: visit.drawing.placeholderGraphicKind }),
        }),
  };
}

function resolveDrawing(
  surface: PaginatedSurface,
  session: DocxSession,
  visit: SemanticDrawingVisit,
): ResolvedDrawing {
  const drawing = visit.drawing;
  if (
    visit.rootStory !== "body" ||
    visit.story !== "body" ||
    visit.textboxDepth !== 0 ||
    drawing.ownerPartName !== surface.session.part().name
  ) {
    return { kind: "unsupported", reason: "not-body", visit };
  }

  const paragraphId =
    drawing.kind === "inlineDrawing"
      ? drawing.paragraphId
      : drawing.anchorParagraphId;
  const paraId = surface.session.paraIdOf(paragraphId);
  if (!paraId) {
    return { kind: "unsupported", reason: "paragraph-not-found", visit };
  }

  const handle = session.paragraphHandleForId?.(paraId);
  if (!handle) {
    return { kind: "unsupported", reason: "paragraph-not-found", visit };
  }
  const paragraph = session.readParagraph(handle);
  const objectRef = `${paragraph.paragraphRef}:${drawing.drawingNodeId}`;
  const atom = paragraph.atoms.find(
    (candidate) =>
      candidate.kind === "drawing" && candidate.objectRef === objectRef,
  );
  if (!atom) {
    return { kind: "unsupported", reason: "object-not-found", visit };
  }

  const chartWorkbook = resolveDocxChartWorkbook(surface.session.currentPackage(), surface.session.part(), drawing.drawingNodeId);
  const chart = chartWorkbook !== null || drawing.chart !== undefined || drawing.placeholderGraphicKind === "chart";
  if (!chart && drawing.placeholderGraphicKind !== null) {
    return { kind: "unsupported", reason: "unsupported-graphic", visit };
  }

  const resolved = {
    objectRef,
    paragraph: {
      nodeId: paragraphId,
      paraId,
      paragraphRef: paragraph.paragraphRef,
    },
  };
  if (chart) return { kind: "chart", ...resolved, workbook: chartWorkbook?.workbook ?? null };
  return {
    kind: "image",
    ...resolved,
    previewable:
      drawing.resource.kind === "ready" &&
      drawing.resource.mime !== "image/svg+xml",
    ...(session.readImage && atom.readable
      ? {
          readImage: {
            paragraphRef: paragraph.paragraphRef,
            objectRef,
            expectedRevision: session.revision(),
          },
        }
      : {}),
  };
}

/**
 * Resolve the one drawing the user explicitly selected into its body paragraph.
 *
 * This does not infer a caption, a data source, or a neighboring object.
 * Images receive a read route only when the selected drawing has its own atom in the
 * resolved body paragraph. Charts never use the image reader; a workbook requires an
 * explicit internal relationship from the chart part.
 */
export function readDocxContextDrawing(
  surface: PaginatedSurface | null,
  session: DocxSession,
): DocxContextDrawing {
  if (!surface) return { kind: "none" };
  const target = selectedDrawingOverlayTargetOf(surface);
  if (!target) return { kind: "none" };

  const intent = surface.drawingSelectionIntent();
  if (
    intent.kind === "none" ||
    (intent.kind === "pointer" && intent.drawingNodeId !== target.id)
  ) {
    return unsupported(target, "selection-mismatch");
  }
  if (target.textbox) return unsupported(target, "not-body");

  const occurrences: SemanticDrawingVisit[] = [];
  forEachSemanticDrawing(surface.layout(), (visit) => {
    if (
      visit.page.index === target.pageIndex &&
      visit.drawing.drawingNodeId === target.id
    ) {
      occurrences.push(visit);
    }
  });
  if (occurrences.length === 0) {
    return unsupported(target, "layout-not-found");
  }
  if (occurrences.length !== 1) {
    return unsupported(target, "layout-ambiguous");
  }

  const [visit] = occurrences;
  const drawing = visit.drawing;
  if (
    target.kind !== (drawing.kind === "inlineDrawing" ? "inline" : "anchored")
  ) {
    return unsupported(target, "not-body", visit);
  }

  const resolved = resolveDrawing(surface, session, visit);
  if (resolved.kind === "unsupported") {
    return unsupported(target, resolved.reason, resolved.visit);
  }
  return { ...resolved, target };
}

export function readDocxDrawingAtCaret(
  surface: PaginatedSurface,
  session: DocxSession,
): DocxDrawingAtCaret {
  if (
    surface.activeScope().kind !== "body" ||
    surface.drawingSelectionIntent().kind !== "none"
  ) {
    return { kind: "none" };
  }
  const { selection: { anchor, head }, cellSelection } = surface.state();
  if (
    cellSelection !== null ||
    anchor.paragraphId !== head.paragraphId ||
    anchor.offset !== head.offset
  ) {
    return { kind: "none" };
  }

  const occurrences: SemanticDrawingVisit[] = [];
  forEachSemanticDrawing(surface.layout(), (visit) => {
    const drawing = visit.drawing;
    const paragraphId =
      drawing.kind === "inlineDrawing"
        ? drawing.paragraphId
        : drawing.anchorParagraphId;
    if (
      visit.rootStory === "body" &&
      visit.story === "body" &&
      visit.textboxDepth === 0 &&
      paragraphId === head.paragraphId &&
      drawing.start === head.offset
    ) {
      occurrences.push(visit);
    }
  });
  if (occurrences.length === 0) return { kind: "none" };
  if (occurrences.length !== 1) return { kind: "ambiguous" };

  const [visit] = occurrences;
  const drawing = visit.drawing;
  const resolved = resolveDrawing(surface, session, visit);
  if (!(resolved.kind === "image" && resolved.previewable && resolved.readImage) &&
    !(resolved.kind === "chart" && resolved.workbook)) return { kind: "none" };

  const paragraphId =
    drawing.kind === "inlineDrawing"
      ? drawing.paragraphId
      : drawing.anchorParagraphId;
  return { kind: "drawing", drawingNodeId: drawing.drawingNodeId, paragraphId };
}

/**
 * Select the one actionable drawing whose authored model position is the caret.
 */
export function selectDocxDrawingAtCaret(
  surface: PaginatedSurface,
  session: DocxSession,
): boolean {
  const target = readDocxDrawingAtCaret(surface, session);
  if (target.kind !== "drawing") return false;
  if (!surface.selectDrawing(target.drawingNodeId, target.paragraphId)) return false;
  return selectedDrawingOverlayTargetOf(surface)?.id === target.drawingNodeId;
}

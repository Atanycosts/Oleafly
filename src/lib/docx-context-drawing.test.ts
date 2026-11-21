// @vitest-environment jsdom
import {
  mountPaginatedSurface,
  type DocxEditorInstance,
  type PaginatedSurface,
} from "@docx-editor.dev/core/editor";
import { forEachSemanticDrawing, type SemanticDrawingVisit } from "@docx-editor.dev/core/layout";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocxSession, type DocxSession } from "./docx-session";
import {
  readDocxContextDrawing,
  readDocxDrawingAtCaret,
  selectDocxDrawingAtCaret,
} from "./docx-context-drawing";

const controls = vi.hoisted(() => ({
  targetOverride: undefined as unknown,
  visitsOverride: null as unknown,
}));

vi.mock("@docx-editor.dev/core/editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@docx-editor.dev/core/editor")>();
  return {
    ...actual,
    selectedDrawingOverlayTargetOf: (surface: PaginatedSurface | null) =>
      controls.targetOverride === undefined
        ? actual.selectedDrawingOverlayTargetOf(surface)
        : controls.targetOverride,
  };
});

vi.mock("@docx-editor.dev/core/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@docx-editor.dev/core/layout")>();
  return {
    ...actual,
    forEachSemanticDrawing: (
      layout: Parameters<typeof actual.forEachSemanticDrawing>[0],
      visit: (drawing: SemanticDrawingVisit) => void,
    ) => {
      if (controls.visitsOverride === null) {
        actual.forEachSemanticDrawing(layout, visit);
        return;
      }
      for (const drawing of controls.visitsOverride as readonly SemanticDrawingVisit[]) {
        visit(drawing);
      }
    },
  };
});

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const IMAGE_REL = `${R}/image`;
const CHART_REL = `${R}/chart`;
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  ),
);

function pictureDrawing(relationshipId = "rIdImage"): string {
  return `<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function anchoredPictureDrawing(relationshipId = "rIdImage"): string {
  return `<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="3" name="Anchored picture"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`;
}

function chartDrawing(relationshipId = "rIdChart"): string {
  return `<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="2" name="Chart 1"/><a:graphic><a:graphicData uri="${C}"><c:chart r:id="${relationshipId}"/></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function docx(input: {
  readonly body: string;
  readonly relationships: string;
  readonly chart?: boolean;
}): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${input.chart ? '<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' : ""}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:c="${C}" xmlns:r="${R}"><w:body>${input.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}">${input.relationships}</Relationships>`,
    ),
    "word/media/image1.png": PNG,
  };
  if (input.chart) {
    parts["word/charts/chart1.xml"] = strToU8(
      `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`,
    );
  }
  return zipSync(parts);
}

function imageRelationship(): string {
  return `<Relationship Id="rIdImage" Type="${IMAGE_REL}" Target="media/image1.png"/>`;
}

function chartRelationship(): string {
  return `<Relationship Id="rIdChart" Type="${CHART_REL}" Target="charts/chart1.xml"/>`;
}

function mount(input: {
  readonly body: string;
  readonly relationships: string;
  readonly chart?: boolean;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const opened = mountPaginatedSurface(container, docx(input), {
    editingMode: "edit",
    measurer: {
      measure: (text) => text.length * 6,
      lineMetrics: () => ({ height: 14, baseline: 11 }),
    },
  });
  if (!opened.ok) throw new Error(opened.reason);
  const surface = opened.surface;
  const session = createDocxSession({
    surface,
    exec: () => ({ ok: true }),
    on: () => () => {},
    can: () => ({ ok: false }),
  } as unknown as DocxEditorInstance);
  return {
    session,
    surface,
    dispose() {
      session.dispose();
      surface.destroy();
      container.remove();
    },
  };
}

function bodyDrawing(surface: PaginatedSurface): SemanticDrawingVisit {
  let found: SemanticDrawingVisit | undefined;
  forEachSemanticDrawing(surface.layout(), (visit) => {
    if (visit.rootStory === "body" && visit.story === "body") found ??= visit;
  });
  if (!found) throw new Error("The fixture has no body drawing.");
  return found;
}

function selectDrawing(surface: PaginatedSurface, visit: SemanticDrawingVisit): void {
  const paragraphId =
    visit.drawing.kind === "inlineDrawing"
      ? visit.drawing.paragraphId
      : visit.drawing.anchorParagraphId;
  if (!surface.selectDrawing(visit.drawing.drawingNodeId, paragraphId)) {
    throw new Error("The fixture drawing could not be selected.");
  }
}

function fakeTarget(id: string) {
  return {
    id,
    pageIndex: 0,
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    kind: "inline",
    widthEmu: 914400,
    heightEmu: 457200,
    position: null,
    anchorFrameOrigin: null,
    transform: { rotationDegrees: 0 },
    canResize: true,
    canMove: true,
    aspectLocked: false,
  } as const;
}

function fakeVisit(
  id: string,
  story: "body" | "header",
  start = 0,
): SemanticDrawingVisit {
  return {
    page: { index: 0 },
    rootStory: story,
    story,
    textboxDepth: 0,
    drawing: {
      kind: "inlineDrawing",
      drawingNodeId: id,
      paragraphId: "paragraph",
      start,
      ownerPartName: "word/document.xml",
      placeholderGraphicKind: null,
    },
  } as unknown as SemanticDrawingVisit;
}

afterEach(() => {
  controls.targetOverride = undefined;
  controls.visitsOverride = null;
});

describe("DOCX context drawing", () => {
  it("does not treat a fresh or adjacent text caret as an object selection", () => {
    const fixture = mount({
      body: `<w:p><w:r><w:t>Before </w:t></w:r><w:r>${pictureDrawing()}</w:r><w:r><w:t> after</w:t></w:r></w:p>`,
      relationships: imageRelationship(),
    });
    try {
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toEqual({ kind: "none" });
      const drawing = bodyDrawing(fixture.surface).drawing;
      const position = {
        paragraphId: drawing.kind === "inlineDrawing"
          ? drawing.paragraphId
          : drawing.anchorParagraphId,
        offset: 1,
      };
      fixture.surface.setSelection({ anchor: position, head: position });
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toEqual({ kind: "none" });
    } finally {
      fixture.dispose();
    }
  });

  it("resolves the selected body image to its exact routing atom without reading pixels", () => {
    const fixture = mount({
      body: `<w:p><w:r>${pictureDrawing()}</w:r></w:p>`,
      relationships: imageRelationship(),
    });
    try {
      const visit = bodyDrawing(fixture.surface);
      selectDrawing(fixture.surface, visit);
      const result = readDocxContextDrawing(fixture.surface, fixture.session);
      const paragraph = fixture.session.listParagraphs()[0];
      if (!paragraph) throw new Error("The fixture has no paragraph.");

      expect(result).toMatchObject({
        kind: "image",
        objectRef: `${paragraph.handle.ref}:${visit.drawing.drawingNodeId}`,
        paragraph: {
          nodeId: visit.drawing.kind === "inlineDrawing" ? visit.drawing.paragraphId : "",
          paragraphRef: paragraph.handle.ref,
        },
        readImage: {
          paragraphRef: paragraph.handle.ref,
          objectRef: `${paragraph.handle.ref}:${visit.drawing.drawingNodeId}`,
          expectedRevision: fixture.session.revision(),
        },
      });
      if (result.kind !== "image" || !result.readImage) {
        throw new Error("The selected image did not produce a read route.");
      }
      if (!fixture.session.readImage) throw new Error("The image reader is unavailable.");
      const image = fixture.session.readImage(result.readImage);
      expect(image.mediaPart).toBe("/word/media/image1.png");
      expect(image.bytes).toEqual(PNG);
    } finally {
      fixture.dispose();
    }
  });

  it("classifies a selected chart but never creates an image route", () => {
    const fixture = mount({
      body: `<w:p><w:r>${chartDrawing()}</w:r></w:p>`,
      relationships: chartRelationship(),
      chart: true,
    });
    try {
      const visit = bodyDrawing(fixture.surface);
      selectDrawing(fixture.surface, visit);
      const result = readDocxContextDrawing(fixture.surface, fixture.session);
      expect(result).toMatchObject({ kind: "chart", workbook: null });
      expect(result).not.toHaveProperty("readImage");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps the engine anchor placement and resolves the anchored image's body paragraph", () => {
    const fixture = mount({
      body: `<w:p><w:r><w:t>Anchor </w:t></w:r><w:r>${anchoredPictureDrawing()}</w:r></w:p>`,
      relationships: imageRelationship(),
    });
    try {
      const visit = bodyDrawing(fixture.surface);
      selectDrawing(fixture.surface, visit);
      const result = readDocxContextDrawing(fixture.surface, fixture.session);
      expect(result).toMatchObject({
        kind: "image",
        target: {
          kind: "anchored",
          position: { mode: "frame" },
        },
      });
      if (result.kind !== "image") throw new Error("The anchored image was not resolved.");
      if (visit.drawing.kind !== "anchoredDrawing") {
        throw new Error("The fixture was not laid out as an anchored drawing.");
      }
      expect(result.paragraph.nodeId).toBe(visit.drawing.anchorParagraphId);
    } finally {
      fixture.dispose();
    }
  });

  it("does not expose a field-wrapped picture as a selectable drawing object", () => {
    const fixture = mount({
      body: `<w:p><w:fldSimple w:instr="EMBED"><w:r>${pictureDrawing()}</w:r></w:fldSimple></w:p>`,
      relationships: imageRelationship(),
    });
    try {
      const paragraphId = fixture.surface.session.paragraphIds()[0];
      if (!paragraphId) throw new Error("The fixture has no paragraph.");
      const position = { paragraphId, offset: 0 };
      fixture.surface.setSelection({ anchor: position, head: position });
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toEqual({ kind: "none" });
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a pointer target that names a different drawing", () => {
    controls.targetOverride = fakeTarget("drawing-a");
    const result = readDocxContextDrawing(
      {
        drawingSelectionIntent: () => ({ kind: "pointer", drawingNodeId: "drawing-b" }),
      } as unknown as PaginatedSurface,
      {} as DocxSession,
    );
    expect(result).toMatchObject({ kind: "unsupported", reason: "selection-mismatch" });
  });

  it("does not route a drawing whose unique occurrence is outside the body story", () => {
    controls.targetOverride = fakeTarget("drawing-a");
    controls.visitsOverride = [fakeVisit("drawing-a", "header")];
    const result = readDocxContextDrawing(
      {
        drawingSelectionIntent: () => ({ kind: "programmatic" }),
        layout: () => ({}),
        session: { part: () => ({ name: "word/document.xml" }) },
      } as unknown as PaginatedSurface,
      {} as DocxSession,
    );
    expect(result).toMatchObject({ kind: "unsupported", reason: "not-body", rootStory: "header" });
    expect(result).not.toHaveProperty("readImage");
  });

  it("does not choose between duplicate occurrences of the selected drawing", () => {
    controls.targetOverride = fakeTarget("drawing-a");
    controls.visitsOverride = [
      fakeVisit("drawing-a", "body"),
      fakeVisit("drawing-a", "body"),
    ];
    const result = readDocxContextDrawing(
      {
        drawingSelectionIntent: () => ({ kind: "programmatic" }),
        layout: () => ({}),
        session: { part: () => ({ name: "word/document.xml" }) },
      } as unknown as PaginatedSurface,
      {} as DocxSession,
    );
    expect(result).toMatchObject({ kind: "unsupported", reason: "layout-ambiguous" });
    expect(result).not.toHaveProperty("readImage");
  });

  it("does not turn text ranges or unrelated programmatic selections into keyboard images", () => {
    const selectDrawing = vi.fn(() => true);
    const surface = (selection: {
      anchor: { paragraphId: string; offset: number };
      head: { paragraphId: string; offset: number };
    }, intent: "none" | "programmatic") => ({
      activeScope: () => ({ kind: "body" }),
      drawingSelectionIntent: () => ({ kind: intent }),
      state: () => ({ selection, cellSelection: null }),
      layout: () => ({}),
      session: { part: () => ({ name: "word/document.xml" }) },
      selectDrawing,
    }) as unknown as PaginatedSurface;
    const position = { paragraphId: "paragraph", offset: 0 };

    expect(selectDocxDrawingAtCaret(
      surface({ anchor: position, head: { ...position, offset: 1 } }, "none"),
      {} as DocxSession,
    )).toBe(false);
    expect(readDocxDrawingAtCaret(
      surface({ anchor: position, head: { ...position, offset: 1 } }, "none"),
      {} as DocxSession,
    )).toEqual({ kind: "none" });
    expect(selectDocxDrawingAtCaret(
      surface({ anchor: position, head: position }, "programmatic"),
      {} as DocxSession,
    )).toBe(false);
    expect(selectDrawing).not.toHaveBeenCalled();
  });

  it("rejects two drawings sharing the caret position", () => {
    controls.visitsOverride = [
      fakeVisit("drawing-a", "body", 3),
      fakeVisit("drawing-b", "body", 3),
    ];
    const selectDrawing = vi.fn(() => true);
    const position = { paragraphId: "paragraph", offset: 3 };
    const surface = {
      activeScope: () => ({ kind: "body" }),
      drawingSelectionIntent: () => ({ kind: "none" }),
      state: () => ({
        selection: { anchor: position, head: position },
        cellSelection: null,
      }),
      layout: () => ({}),
      session: { part: () => ({ name: "word/document.xml" }) },
      selectDrawing,
    } as unknown as PaginatedSurface;

    expect(readDocxDrawingAtCaret(surface, {} as DocxSession)).toEqual({ kind: "ambiguous" });
    expect(selectDocxDrawingAtCaret(surface, {} as DocxSession)).toBe(false);
    expect(selectDrawing).not.toHaveBeenCalled();
  });
});

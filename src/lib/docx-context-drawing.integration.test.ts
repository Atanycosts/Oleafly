// @vitest-environment jsdom
import {
  mountPaginatedSurface,
  type DocxEditorInstance,
  type PaginatedSurface,
} from "@docx-editor.dev/core/editor";
import {
  forEachSemanticDrawing,
  type SemanticDrawingVisit,
} from "@docx-editor.dev/core/layout";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  readDocxContextDrawing,
  readDocxDrawingAtCaret,
  selectDocxDrawingAtCaret,
} from "./docx-context-drawing";
import { createDocxSession } from "./docx-session";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const IMAGE_REL = `${R}/image`;
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  ),
);

interface PictureInput {
  readonly relationshipId: string;
  readonly docPrId: string;
  readonly name: string;
  readonly description: string;
  readonly offsetY?: number;
}

function pictureGraphic(input: PictureInput): string {
  return `<a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${input.name}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${input.relationshipId}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>`;
}

function inlinePicture(input: PictureInput): string {
  return `<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="${input.docPrId}" name="${input.name}" descr="${input.description}"/>${pictureGraphic(input)}</wp:inline></w:drawing>`;
}

function anchoredPicture(input: PictureInput): string {
  return `<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>${input.offsetY ?? 0}</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${input.docPrId}" name="${input.name}" descr="${input.description}"/>${pictureGraphic(input)}</wp:anchor></w:drawing>`;
}

function imageRelationship(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="${IMAGE_REL}" Target="${target}"/>`;
}

function docx(body: string, relationships: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}">${relationships}</Relationships>`,
    ),
    "word/media/inline-a.png": PNG,
    "word/media/inline-b.png": PNG,
    "word/media/anchored-a.png": PNG,
    "word/media/anchored-b.png": PNG,
  });
}

function mount(body: string, relationships: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const opened = mountPaginatedSurface(container, docx(body, relationships), {
    editingMode: "edit",
    imageDecodePort: {
      decode: async () => ({
        pixelWidth: 1,
        pixelHeight: 1,
        dpiX: 96,
        dpiY: 96,
      }),
    },
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
    container,
    paragraphs: session.listParagraphs(),
    session,
    surface,
    dispose() {
      session.dispose();
      surface.destroy();
      container.remove();
    },
  };
}

function bodyDrawings(surface: PaginatedSurface): readonly SemanticDrawingVisit[] {
  const visits: SemanticDrawingVisit[] = [];
  forEachSemanticDrawing(surface.layout(), (visit) => {
    if (visit.rootStory === "body" && visit.story === "body") visits.push(visit);
  });
  return visits;
}

async function readyBodyDrawings(
  surface: PaginatedSurface,
): Promise<readonly SemanticDrawingVisit[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    surface.layout();
    const visits = bodyDrawings(surface);
    if (
      visits.length > 0 &&
      visits.every((visit) => visit.drawing.resource.kind === "ready")
    ) {
      return visits;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The fixture drawings did not finish decoding.");
}

function selectDrawing(surface: PaginatedSurface, visit: SemanticDrawingVisit): void {
  const paragraphId =
    visit.drawing.kind === "inlineDrawing"
      ? visit.drawing.paragraphId
      : visit.drawing.anchorParagraphId;
  if (!surface.selectDrawing(visit.drawing.drawingNodeId, paragraphId)) {
    throw new Error("The integration fixture drawing could not be selected.");
  }
}

function caretAtVisit(visit: SemanticDrawingVisit) {
  return {
    paragraphId:
      visit.drawing.kind === "inlineDrawing"
        ? visit.drawing.paragraphId
        : visit.drawing.anchorParagraphId,
    offset: visit.drawing.start,
  };
}

function pressKey(
  fixture: ReturnType<typeof mount>,
  key: string,
  init: KeyboardEventInit = {},
) {
  fixture.surface.focus();
  const pages = fixture.container.querySelector<HTMLElement>(".docx-pages");
  if (!pages) throw new Error("The fixture has no pages layer.");
  pages.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
}

interface ExpectedPicture {
  readonly caption: string;
  readonly kind: "inline" | "anchored";
  readonly mediaPart: string;
  readonly description: string;
}

const pictures: readonly ExpectedPicture[] = [
  {
    caption: "Inline caption A",
    kind: "inline",
    mediaPart: "word/media/inline-a.png",
    description: "Selected inline A",
  },
  {
    caption: "Inline caption B",
    kind: "inline",
    mediaPart: "word/media/inline-b.png",
    description: "Selected inline B",
  },
  {
    caption: "Anchored caption A",
    kind: "anchored",
    mediaPart: "word/media/anchored-a.png",
    description: "Selected anchored A",
  },
  {
    caption: "Anchored caption B",
    kind: "anchored",
    mediaPart: "word/media/anchored-b.png",
    description: "Selected anchored B",
  },
];

describe("DOCX context drawing integration", () => {
  it("resolves only the selected adjacent inline or anchored picture on one page", () => {
    const fixture = mount(
      [
        `<w:p><w:r><w:t>Inline caption A</w:t></w:r><w:r>${inlinePicture({
          relationshipId: "rIdInlineA",
          docPrId: "11",
          name: "Inline A",
          description: "Selected inline A",
        })}</w:r><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>Inline caption B</w:t></w:r><w:r>${inlinePicture({
          relationshipId: "rIdInlineB",
          docPrId: "12",
          name: "Inline B",
          description: "Selected inline B",
        })}</w:r><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>Anchored caption A</w:t></w:r><w:r>${anchoredPicture({
          relationshipId: "rIdAnchoredA",
          docPrId: "13",
          name: "Anchored A",
          description: "Selected anchored A",
        })}</w:r><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>Anchored caption B</w:t></w:r><w:r>${anchoredPicture({
          relationshipId: "rIdAnchoredB",
          docPrId: "14",
          name: "Anchored B",
          description: "Selected anchored B",
          offsetY: 914400,
        })}</w:r><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>`,
      ].join(""),
      [
        imageRelationship("rIdInlineA", "media/inline-a.png"),
        imageRelationship("rIdInlineB", "media/inline-b.png"),
        imageRelationship("rIdAnchoredA", "media/anchored-a.png"),
        imageRelationship("rIdAnchoredB", "media/anchored-b.png"),
      ].join(""),
    );

    try {
      const visits = bodyDrawings(fixture.surface);
      expect(visits).toHaveLength(pictures.length);
      expect(new Set(visits.map((visit) => visit.page.index))).toEqual(new Set([0]));
      const selectedObjectRefs = new Set<string>();

      for (const visit of visits) {
        selectDrawing(fixture.surface, visit);
        const result = readDocxContextDrawing(fixture.surface, fixture.session);
        if (result.kind !== "image" || !result.readImage) {
          throw new Error(`The selected ${visit.drawing.kind} was not resolved as an image.`);
        }

        const paragraph = fixture.paragraphs.find(
          (candidate) => candidate.handle.ref === result.paragraph.paragraphRef,
        );
        if (!paragraph) throw new Error("The resolved paragraph was not in the fixture.");
        const expected = pictures.find((picture) => paragraph.text.includes(picture.caption));
        if (!expected) throw new Error(`No expectation matches "${paragraph.text}".`);
        if (!fixture.session.readImage) throw new Error("The fixture has no image reader.");
        const image = fixture.session.readImage(result.readImage);

        expect(result.target.id).toBe(visit.drawing.drawingNodeId);
        expect(result.target.kind).toBe(expected.kind);
        expect(result.paragraph.paragraphRef).toBe(paragraph.handle.ref);
        expect(result.objectRef).toBe(`${paragraph.handle.ref}:${visit.drawing.drawingNodeId}`);
        expect(selectedObjectRefs.has(result.objectRef)).toBe(false);
        selectedObjectRefs.add(result.objectRef);
        expect(image.mediaPart.replace(/^\//, "")).toBe(expected.mediaPart);
        expect(image.description).toBe(expected.description);
        expect(result).not.toHaveProperty("caption");
        expect(result).not.toHaveProperty("title");
      }
      expect(selectedObjectRefs.size).toBe(visits.length);
    } finally {
      fixture.dispose();
    }
  });

  it("selects an inline picture only at its exact atom start", async () => {
    const fixture = mount(
      `<w:p><w:r><w:t>Before </w:t></w:r><w:r>${inlinePicture({
        relationshipId: "rIdInline",
        docPrId: "21",
        name: "Inline",
        description: "Keyboard inline",
      })}</w:r><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>`,
      imageRelationship("rIdInline", "media/inline-a.png"),
    );
    try {
      const [visit] = await readyBodyDrawings(fixture.surface);
      if (!visit) throw new Error("The fixture has no inline picture.");
      const caret = caretAtVisit(visit);

      const afterAtom = { ...caret, offset: caret.offset + 1 };
      fixture.surface.setSelection({ anchor: afterAtom, head: afterAtom });
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "programmatic" });
      pressKey(fixture, "ArrowLeft");
      expect(fixture.surface.state().selection).toEqual({ anchor: caret, head: caret });
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "none" });
      const paraId = fixture.surface.session.paraIdOf(caret.paragraphId);
      const handle = paraId
        ? fixture.session.paragraphHandleForId?.(paraId)
        : undefined;
      expect(handle).toBeDefined();
      if (!handle) throw new Error("The fixture paragraph is unavailable.");
      const paragraph = fixture.session.readParagraph(handle);
      expect(paragraph.atoms).toContainEqual(expect.objectContaining({
        kind: "drawing",
        objectRef: `${paragraph.paragraphRef}:${visit.drawing.drawingNodeId}`,
        readable: true,
      }));
      expect(readDocxDrawingAtCaret(fixture.surface, fixture.session)).toMatchObject({
        kind: "drawing",
        drawingNodeId: visit.drawing.drawingNodeId,
      });
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "none" });
      expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(true);
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toMatchObject({
        kind: "image",
        target: { id: visit.drawing.drawingNodeId, kind: "inline" },
      });
    } finally {
      fixture.dispose();
    }
  });

  it("selects an anchored picture at its exact anchor offset", async () => {
    const fixture = mount(
      `<w:p><w:r><w:t>Anchor </w:t></w:r><w:r>${anchoredPicture({
        relationshipId: "rIdAnchored",
        docPrId: "22",
        name: "Anchored",
        description: "Keyboard anchored",
      })}</w:r><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>`,
      imageRelationship("rIdAnchored", "media/anchored-a.png"),
    );
    try {
      const [visit] = await readyBodyDrawings(fixture.surface);
      if (!visit) throw new Error("The fixture has no anchored picture.");
      const caret = caretAtVisit(visit);
      const afterAnchor = { ...caret, offset: caret.offset + 1 };

      fixture.surface.setSelection({ anchor: caret, head: caret });
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "programmatic" });
      expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(false);
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "programmatic" });

      fixture.surface.setSelection({ anchor: afterAnchor, head: afterAnchor });
      pressKey(fixture, "ArrowLeft");
      expect(fixture.surface.state().selection).toEqual({ anchor: caret, head: caret });

      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toEqual({ kind: "none" });
      pressKey(fixture, "ArrowRight");
      expect(fixture.surface.state().selection).toEqual({
        anchor: afterAnchor,
        head: afterAnchor,
      });
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "none" });
      expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(false);
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toEqual({ kind: "none" });

      pressKey(fixture, "ArrowLeft");
      expect(fixture.surface.state().selection).toEqual({ anchor: caret, head: caret });
      expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(true);
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toMatchObject({
        kind: "image",
        target: { id: visit.drawing.drawingNodeId, kind: "anchored" },
      });
    } finally {
      fixture.dispose();
    }
  });

  it("rejects an inline text range and an already selected drawing", () => {
    const fixture = mount(
      `<w:p><w:r><w:t>Before </w:t></w:r><w:r>${inlinePicture({
        relationshipId: "rIdInline",
        docPrId: "23",
        name: "Inline",
        description: "Range check",
      })}</w:r></w:p>`,
      imageRelationship("rIdInline", "media/inline-a.png"),
    );
    try {
      const [visit] = bodyDrawings(fixture.surface);
      if (!visit) throw new Error("The fixture has no inline picture.");
      const caret = caretAtVisit(visit);
      const rangeEnd = { ...caret, offset: caret.offset + 1 };
      fixture.surface.setSelection({ anchor: caret, head: rangeEnd });
      pressKey(fixture, "F10");
      expect(fixture.surface.state().selection).toEqual({ anchor: caret, head: rangeEnd });

      expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(false);
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "none" });

      selectDrawing(fixture.surface, visit);
      expect(fixture.surface.drawingSelectionIntent()).toEqual({
        kind: "pointer",
        drawingNodeId: visit.drawing.drawingNodeId,
      });
      expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("selects only the picture at the exact floating anchor offset", async () => {
    const fixture = mount(
      `<w:p><w:r><w:t>Anchors</w:t></w:r><w:r>${anchoredPicture({
        relationshipId: "rIdAnchoredA",
        docPrId: "24",
        name: "Anchored A",
        description: "Ambiguous A",
      })}</w:r><w:r>${anchoredPicture({
        relationshipId: "rIdAnchoredB",
        docPrId: "25",
        name: "Anchored B",
        description: "Ambiguous B",
        offsetY: 914400,
      })}</w:r></w:p>`,
      [
        imageRelationship("rIdAnchoredA", "media/anchored-a.png"),
        imageRelationship("rIdAnchoredB", "media/anchored-b.png"),
      ].join(""),
    );
    try {
      const visits = await readyBodyDrawings(fixture.surface);
      expect(visits).toHaveLength(2);
      expect(visits.map((visit) => visit.drawing.start)).toEqual([7, 8]);

      for (const visit of visits) {
        const caret = caretAtVisit(visit);
        const afterAnchor = { ...caret, offset: caret.offset + 1 };
        fixture.surface.setSelection({ anchor: afterAnchor, head: afterAnchor });
        pressKey(fixture, "ArrowLeft");
        expect(fixture.surface.state().selection).toEqual({ anchor: caret, head: caret });

        expect(selectDocxDrawingAtCaret(fixture.surface, fixture.session)).toBe(true);
        expect(readDocxContextDrawing(fixture.surface, fixture.session)).toMatchObject({
          kind: "image",
          target: { id: visit.drawing.drawingNodeId, kind: "anchored" },
        });
      }
    } finally {
      fixture.dispose();
    }
  });
});

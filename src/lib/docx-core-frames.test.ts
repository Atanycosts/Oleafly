import {
  buildStyleCascadeTable,
  createFixedMeasurer,
  createLayoutSession,
  layoutSemanticDocument,
  type ParagraphFragmentRecord,
} from "@docx-editor.dev/core/layout";
import {
  openHeadlessDocument,
  readOoxmlPart,
  replaceNode,
  writeOoxmlPackage,
  type OoxmlNode,
} from "@docx-editor.dev/core/store";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const GEOMETRY = {
  width: 600,
  height: 400,
  margin: { top: 30, bottom: 30, left: 30, right: 30 },
};
const MEASURER = createFixedMeasurer(5, 20);

function paragraph(text: string, props = ""): string {
  return `<w:p><w:pPr><w:spacing w:line="400" w:lineRule="exact" w:after="0"/>${props}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function frame(width: number, overrides: Partial<{ anchor: string; wrap: string }> = {}): string {
  return `<w:framePr w:w="${width}" w:hAnchor="${overrides.anchor ?? "page"}" w:xAlign="center" w:vAnchor="text" w:y="1" w:wrap="${overrides.wrap ?? "notBeside"}" w:vSpace="100"/>`;
}

function bodyPart(body: string, columns = 2, gap = 400) {
  const parsed = readOoxmlPart(
    `<w:document xmlns:w="${WORD_NS}"><w:body>${body}<w:sectPr><w:cols w:num="${columns}" w:space="${gap}"/></w:sectPr></w:body></w:document>`,
    { name: "/word/document.xml", contentType: "app/xml" },
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.part;
}

function partWithColumnWidths(body: string, widths: readonly number[]) {
  const columns = widths
    .map((width) => `<w:col w:w="${Math.round(width * 20)}"/>`)
    .join("");
  const parsed = readOoxmlPart(
    `<w:document xmlns:w="${WORD_NS}"><w:body>${body}<w:sectPr><w:cols w:num="${widths.length}" w:equalWidth="0" w:space="200">${columns}</w:cols></w:sectPr></w:body></w:document>`,
    { name: "/word/document.xml", contentType: "app/xml" },
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.part;
}

function elementNamed(node: OoxmlNode, localName: string): OoxmlNode | null {
  if (node.kind === "textValue") return null;
  if (node.localName === localName) return node;
  for (const child of node.children) {
    const match = elementNamed(child, localName);
    if (match) return match;
  }
  return null;
}

function geometryWithoutIds(layout: ReturnType<typeof layoutSemanticDocument>) {
  return layout.pages.flatMap((page) =>
    page.fragments
      .filter((fragment): fragment is ParagraphFragmentRecord => fragment.kind === "paragraph")
      .map((fragment) => ({
        fragmentIndex: fragment.fragmentIndex,
        outOfFlow: fragment.outOfFlow ?? false,
        positionedFrame: fragment.positionedFrame
          ? {
              box: fragment.positionedFrame.box,
              columnIndex: fragment.positionedFrame.columnIndex,
              sourceOrder: fragment.positionedFrame.sourceOrder,
              wrap: fragment.positionedFrame.wrap,
              hSpace: fragment.positionedFrame.hSpace,
              vSpace: fragment.positionedFrame.vSpace,
            }
          : undefined,
        box: fragment.box,
        lines: fragment.lines.map((line) => line.box),
      })),
  );
}

function styledDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD_NS}"><w:body>${paragraph("Inherited title", '<w:pStyle w:val="Title"/>')}${paragraph("Inherited author", '<w:pStyle w:val="Authors"/>')}${paragraph("body ".repeat(150))}<w:sectPr><w:cols w:num="2" w:space="400"/></w:sectPr></w:body></w:document>`,
    ),
    "word/styles.xml": strToU8(
      `<w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Title"><w:pPr>${frame(10000)}</w:pPr></w:style><w:style w:type="paragraph" w:styleId="Authors"><w:pPr>${frame(9600)}</w:pPr></w:style></w:styles>`,
    ),
  });
}

function frameLayout(body: string, columns = 2, gap = 400) {
  return layoutSemanticDocument(bodyPart(body, columns, gap), 0, {
    geometry: GEOMETRY,
    measurer: MEASURER,
  });
}

describe("DOCX core paragraph frames", () => {
  it("stacks wide frames in source order and clears both columns", () => {
    const layout = frameLayout(
      [
        paragraph("Full width title", frame(10000)),
        paragraph("First author", frame(9600)),
        paragraph("Second author", frame(9600)),
        paragraph("word ".repeat(600)),
      ].join(""),
    );
    const page = layout.pages[0];
    if (!page) throw new Error("Expected the framed document to produce a page.");
    const paragraphs = page.fragments.filter(
      (fragment): fragment is ParagraphFragmentRecord => fragment.kind === "paragraph",
    );
    const frames = paragraphs.filter((fragment) => fragment.positionedFrame);
    const [title, firstAuthor, secondAuthor] = frames;
    const titleFrame = title?.positionedFrame;
    const firstAuthorFrame = firstAuthor?.positionedFrame;
    const secondAuthorFrame = secondAuthor?.positionedFrame;
    if (
      !title ||
      !firstAuthor ||
      !secondAuthor ||
      !titleFrame ||
      !firstAuthorFrame ||
      !secondAuthorFrame
    ) {
      throw new Error("Expected title and two author frames.");
    }

    expect(titleFrame.box).toMatchObject({ x: 20, width: 500 });
    expect(firstAuthorFrame.box.width).toBeCloseTo(480);
    expect(secondAuthorFrame.box.width).toBeCloseTo(480);
    expect(frames.map((fragment) => fragment.positionedFrame?.sourceOrder)).toEqual([0, 1, 1]);
    expect(firstAuthorFrame.groupId).not.toBe(titleFrame.groupId);
    expect(secondAuthorFrame.groupId).toBe(firstAuthorFrame.groupId);
    expect(firstAuthor.box.y).toBeGreaterThanOrEqual(title.box.y + title.box.height);
    expect(secondAuthor.box.y).toBeGreaterThanOrEqual(
      firstAuthor.box.y + firstAuthor.box.height,
    );

    const bodyLines = paragraphs
      .filter((fragment) => !fragment.outOfFlow)
      .flatMap((fragment) => fragment.lines);
    expect(bodyLines.some((line) => line.box.x < 260)).toBe(true);
    expect(bodyLines.some((line) => line.box.x >= 280)).toBe(true);

    const authorBottom = firstAuthorFrame.box.y + firstAuthorFrame.box.height;
    expect(bodyLines.every((line) => line.box.y >= authorBottom + 5 - 0.001)).toBe(true);
  });

  it("keeps page-anchored frames ahead of ordinary text in a single column", () => {
    const layout = frameLayout(
      `${paragraph("Title", frame(10000))}${paragraph("body ".repeat(120))}`,
      1,
    );
    const paragraphs = layout.pages.flatMap((page) =>
      page.fragments.filter(
        (fragment): fragment is ParagraphFragmentRecord => fragment.kind === "paragraph",
      ),
    );
    const title = paragraphs.find((fragment) => fragment.positionedFrame);
    const body = paragraphs.find((fragment) => !fragment.positionedFrame);
    const firstLine = body?.lines[0];
    if (!title?.positionedFrame || !firstLine) {
      throw new Error("Expected a positioned title followed by body text.");
    }

    expect(title.outOfFlow).toBe(true);
    expect(title.positionedFrame.box).toMatchObject({ x: 20, width: 500 });
    expect(firstLine.box.x).toBe(0);
    expect(firstLine.box.y).toBeGreaterThanOrEqual(
      title.positionedFrame.box.y + title.positionedFrame.box.height + 5 - 0.001,
    );
  });

  it("leaves unsupported frame variants in ordinary column flow", () => {
    const layout = frameLayout(
      [
        paragraph("Narrow", frame(1000)),
        paragraph("Text anchored", frame(10000, { anchor: "text" })),
        paragraph("Side wrapped", frame(10000, { wrap: "around" })),
        paragraph("Body"),
      ].join(""),
    );

    const paragraphs = layout.pages.flatMap((page) =>
      page.fragments.filter(
        (fragment): fragment is ParagraphFragmentRecord => fragment.kind === "paragraph",
      ),
    );
    expect(paragraphs.some((fragment) => fragment.positionedFrame)).toBe(false);
    expect(paragraphs.filter((fragment) => !fragment.outOfFlow)).toHaveLength(4);
  });

  it("invalidates frames when retained paragraphs see only a section-width edit", () => {
    const body = [
      paragraph("300 point frame", frame(6000)),
      paragraph("body ".repeat(200)),
    ].join("");
    const initialPart = partWithColumnWidths(body, [200, 320]);
    const initialParagraph = elementNamed(initialPart.root, "p");
    if (!initialParagraph || initialParagraph.kind === "textValue") {
      throw new Error("Expected an initial paragraph.");
    }

    const session = createLayoutSession();
    const options = { geometry: GEOMETRY, measurer: MEASURER };
    const initial = layoutSemanticDocument(initialPart, 0, { ...options, session });
    expect(geometryWithoutIds(initial).some((fragment) => fragment.positionedFrame)).toBe(false);

    const replacementPart = partWithColumnWidths(body, [200, 260]);
    const currentSection = elementNamed(initialPart.root, "sectPr");
    const replacementSection = elementNamed(replacementPart.root, "sectPr");
    if (
      !currentSection ||
      currentSection.kind === "textValue" ||
      !replacementSection ||
      replacementSection.kind === "textValue"
    ) {
      throw new Error("Expected source and replacement section properties.");
    }

    const replaced = replaceNode(
      initialPart,
      currentSection.id,
      replacementSection,
    );
    if (!replaced.ok) throw new Error(JSON.stringify(replaced.issues));
    expect(elementNamed(replaced.part.root, "p")).toBe(initialParagraph);

    const coldPart = structuredClone(replaced.part);
    expect(elementNamed(coldPart.root, "p")).not.toBe(initialParagraph);
    const warm = layoutSemanticDocument(replaced.part, 1, { ...options, session });
    const cold = layoutSemanticDocument(coldPart, 1, options);
    const warmGeometry = geometryWithoutIds(warm);
    const coldGeometry = geometryWithoutIds(cold);

    expect(warmGeometry.some((fragment) => fragment.positionedFrame)).toBe(true);
    expect(
      warmGeometry.some((fragment) =>
        fragment.lines.some((line) => line.x === 0 && Math.abs(line.width - 200) < 0.001),
      ),
    ).toBe(true);
    expect(warmGeometry).toEqual(coldGeometry);
  });

  it("keeps style-inherited frame widths and order across save and reopen", () => {
    const opened = openHeadlessDocument(styledDocx());
    if (!opened.ok) throw new Error(opened.reason);

    const render = (view: typeof opened.view) => {
      const layout = layoutSemanticDocument(view.part(), 0, {
        geometry: GEOMETRY,
        measurer: MEASURER,
        styleCascade: buildStyleCascadeTable(
          view.stylesRoot(),
          view.documentThemeFonts(),
          view.settingsRoot(),
        ),
      });
      return layout.pages
        .flatMap((page) =>
          page.fragments.filter(
            (fragment): fragment is ParagraphFragmentRecord => fragment.kind === "paragraph",
          ),
        )
        .flatMap((fragment) =>
          fragment.positionedFrame
            ? [
                {
                  width: fragment.positionedFrame.box.width,
                  groupId: fragment.positionedFrame.groupId,
                  sourceOrder: fragment.positionedFrame.sourceOrder,
                },
              ]
            : [],
        );
    };

    const before = render(opened.view);
    const reopened = openHeadlessDocument(writeOoxmlPackage(opened.view.currentPackage()));
    if (!reopened.ok) throw new Error(reopened.reason);
    const after = render(reopened.view);

    expect(before.map(({ width }) => width)).toEqual([500, 480]);
    expect(after).toEqual(before);
  });
});

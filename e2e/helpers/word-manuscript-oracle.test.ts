import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  assertManuscriptInitialExport,
  assertManuscriptRepair,
  createControlledManuscript,
  readManuscriptOracle,
} from "./word-manuscript-oracle";

const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${WORD_NAMESPACE}">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading">
    <w:name w:val="Heading"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:b w:val="0"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Abstract">
    <w:name w:val="Abstract"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="both"/></w:pPr>
    <w:rPr><w:b w:val="1"/><w:bCs w:val="1"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Text">
    <w:name w:val="Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="both"/></w:pPr>
    <w:rPr><w:b w:val="0"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="References">
    <w:name w:val="References"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="both"/></w:pPr>
    <w:rPr><w:b w:val="0"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>
  </w:style>
</w:styles>`;

function paragraph(text: string, style?: string): string {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function table(label: string, verticalAlignment = "center", fill?: string): string {
  return `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3600"/></w:tblGrid><w:tr><w:tc><w:tcPr>${
    fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""
  }<w:vAlign w:val="${verticalAlignment}"/></w:tcPr>${paragraph(label)}</w:tc></w:tr></w:tbl>`;
}

function documentXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    ${paragraph("A complete manuscript title", "Heading")}
    ${paragraph("Abstract: A controlled abstract for the manuscript.", "Abstract")}
    <w:p><w:pPr><w:pStyle w:val="Text"/></w:pPr><w:hyperlink r:id="rIdLink"><w:r><w:t>Linked evidence</w:t></w:r></w:hyperlink><w:bookmarkStart w:id="1" w:name="evidence"/><w:bookmarkEnd w:id="1"/><w:fldSimple w:instr="REF evidence"><w:r><w:t>1</w:t></w:r></w:fldSimple><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p>
    ${paragraph("This first body paragraph contains enough prose to exercise paragraph formatting across the manuscript.", "Text")}
    ${paragraph("This middle body paragraph is selected by the independent oracle from the center of the complete document.", "Text")}
    ${paragraph("References")}
    ${paragraph("Example, A. Independent XML acceptance for manuscript repair. Journal of Controlled Fixtures, 2026.", "References")}
    ${table("First table")}
    ${table("Middle table")}
    ${table("Last table")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1008" w:right="936" w:bottom="1008" w:left="936"/><w:cols w:num="2" w:space="288" w:equalWidth="true" w:sep="false"/></w:sectPr>
  </w:body>
</w:document>`;
}

function fixture(
  document = documentXml(),
  extraParts: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(document),
      "word/styles.xml": strToU8(styles),
      "word/_rels/document.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/evidence" TargetMode="External"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`,
      ),
      "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
      ...extraParts,
    },
    { level: 6 },
  );
}

describe("word manuscript XML oracle", () => {
  it("reads independent package and document facts", () => {
    const oracle = readManuscriptOracle(fixture());
    expect(oracle.document).toMatchObject({
      paragraphCount: 10,
      topLevelParagraphCount: 7,
      tableCount: 3,
      sectionCount: 1,
    });
    expect(oracle.sections[0]).toMatchObject({
      pageWidthTwips: 11906,
      pageHeightTwips: 16838,
      columns: {
        count: 2,
        spaceTwips: 288,
        separator: false,
      },
    });
    expect(oracle.semantics.hyperlinks).toHaveLength(1);
    expect(oracle.semantics.bookmarks).toHaveLength(1);
    expect(oracle.semantics.fields).toHaveLength(1);
    expect(oracle.semantics.formulas).toHaveLength(1);
    expect(oracle.semantics.mediaParts).toHaveLength(1);
    expect(oracle.semantics.relationships).toHaveLength(3);
  });

  it("resolves only WordprocessingML elements, not foreign namespace lookalikes", () => {
    const foreign = documentXml()
      .replace(
        'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
        'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:x="urn:oleafly:foreign"',
      )
      .replace(
        "</w:body>",
        '<x:p><x:r><x:t>Foreign title</x:t></x:r></x:p></w:body>',
      );
    const oracle = readManuscriptOracle(fixture(foreign));
    expect(oracle.document).toMatchObject({
      paragraphCount: 10,
      topLevelParagraphCount: 7,
      tableCount: 3,
      sectionCount: 1,
    });
    expect(oracle.paragraphs.some((paragraph) => paragraph.text === "Foreign title")).toBe(
      false,
    );
  });

  it("creates the fixed eight distributed targets and verifies a repair", () => {
    const source = fixture();
    const control = createControlledManuscript(source, source);
    expect(control.targets.map((target) => target.id)).toEqual([
      "title",
      "abstract",
      "body-middle",
      "references-tail",
      "table-first",
      "table-middle",
      "table-last",
      "section-first",
    ]);
    expect(control.targets.filter((target) => target.kind === "paragraph")).toHaveLength(4);
    expect(control.targets.filter((target) => target.kind === "table-cell")).toHaveLength(3);
    expect(control.targets.filter((target) => target.kind === "section")).toHaveLength(1);
    expect(control.targets[0].expected).toEqual({
      fontSizePt: 24,
      bold: false,
      alignment: "Centered",
    });
    expect(control.targets[1].expected).toEqual({
      fontSizePt: 9,
      bold: true,
      alignment: "Justified",
    });
    expect(control.targets[2].expected).toEqual({
      fontSizePt: 10,
      bold: false,
      alignment: "Justified",
    });
    expect(control.targets[3].expected).toEqual({
      fontSizePt: 8,
      bold: false,
      alignment: "Justified",
    });
    expect(control.expected.damagedSha256).toMatch(/^[0-9a-f]{64}$/u);
    const titleTarget = control.targets.find((target) => target.id === "title");
    if (!titleTarget || titleTarget.kind !== "paragraph") {
      throw new Error("Missing paragraph title target.");
    }
    const damagedTitle =
      readManuscriptOracle(control.bytes).paragraphs[
        titleTarget.location.paragraphIndex
      ]!;
    const sourceTitle =
      readManuscriptOracle(source).paragraphs[titleTarget.location.paragraphIndex]!;
    expect(damagedTitle.mark).toMatchObject({
      fontSizePt: titleTarget.damaged.fontSizePt,
      complexScriptFontSizePt: titleTarget.damaged.fontSizePt,
      bold: titleTarget.damaged.bold,
      complexScriptBold: sourceTitle.mark.complexScriptBold,
    });
    for (const [index, run] of damagedTitle.runs.entries()) {
      expect(run).toMatchObject({
        fontSizePt: titleTarget.damaged.fontSizePt,
        complexScriptFontSizePt: titleTarget.damaged.fontSizePt,
        bold: titleTarget.damaged.bold,
        complexScriptBold: sourceTitle.runs[index]!.complexScriptBold,
      });
    }
    const facts = assertManuscriptRepair(source, control.bytes, source, control);
    expect(facts.passed).toBe(true);
    expect(facts.damagedVsSource.changedParts).toEqual(["word/document.xml"]);
    expect(facts.semantics.protectedXmlAndBinaryPartsEqual).toBe(true);
  });

  it("inserts fixture properties in schema order while preserving other properties", () => {
    const original = documentXml()
      .replace(
        '<w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
        '<w:pPr><w:pStyle w:val="Heading"/><w:jc w:val="center"/><w:textAlignment w:val="baseline"/><w:rPr><w:i/><w:color w:val="112233"/><w:u w:val="single"/></w:rPr></w:pPr>',
      )
      .replace(
        '<w:r><w:t xml:space="preserve">A complete manuscript title',
        '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:i/><w:iCs/><w:color w:val="112233"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">A complete manuscript title',
      )
      .replace(
        '<w:tcPr><w:vAlign w:val="center"/></w:tcPr>',
        '<w:tcPr><w:tcW w:w="3600" w:type="dxa"/><w:noWrap/><w:tcMar/><w:textDirection w:val="lrTb"/><w:vAlign w:val="center"/><w:hideMark/></w:tcPr>',
      )
      .replace(
        '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1008" w:right="936" w:bottom="1008" w:left="936"/>',
        "",
      );
    const control = createControlledManuscript(fixture(original), fixture());
    const xml = strFromU8(unzipSync(control.bytes)["word/document.xml"]!).replace(
      /\s+\/>/gu,
      "/>",
    );
    expect(xml).toContain(
      '<w:pPr><w:pStyle w:val="Heading"/><w:jc w:val="left"/><w:textAlignment w:val="baseline"/><w:rPr><w:b w:val="1"/><w:i/><w:color w:val="112233"/><w:sz w:val="52"/><w:szCs w:val="52"/><w:u w:val="single"/></w:rPr></w:pPr>',
    );
    expect(xml).toContain(
      '<w:rPr><w:rFonts w:ascii="Times New Roman"/><w:b w:val="1"/><w:i/><w:iCs/><w:color w:val="112233"/><w:sz w:val="52"/><w:szCs w:val="52"/><w:u w:val="single"/></w:rPr>',
    );
    expect(xml).toContain(
      '<w:tcPr><w:tcW w:w="3600" w:type="dxa"/><w:shd w:fill="D9EAF7"/><w:noWrap/><w:tcMar/><w:textDirection w:val="lrTb"/><w:vAlign w:val="bottom"/><w:hideMark/></w:tcPr>',
    );
    expect(xml).toContain(
      '<w:sectPr><w:pgSz w:w="12106" w:h="17038"/><w:pgMar w:top="1128" w:right="1056" w:bottom="1128" w:left="1056"/><w:cols w:num="2" w:space="288" w:equalWidth="true" w:sep="false"/></w:sectPr>',
    );
  });

  it("preserves source bCs and rejects changes to target runs or paragraph marks", () => {
    const original = documentXml()
      .replace(
        '<w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
        '<w:pPr><w:pStyle w:val="Heading"/><w:rPr><w:bCs w:val="1"/></w:rPr></w:pPr>',
      )
      .replace(
        '<w:r><w:t xml:space="preserve">A complete manuscript title',
        '<w:r><w:rPr><w:bCs w:val="0"/></w:rPr><w:t xml:space="preserve">A complete manuscript title',
      );
    const source = fixture(original);
    const control = createControlledManuscript(source, source);
    const damagedTitle = readManuscriptOracle(control.bytes).paragraphs[0]!;
    expect(damagedTitle.mark.complexScriptBold).toBe(true);
    expect(damagedTitle.runs[0]!.complexScriptBold).toBe(false);
    expect(
      assertManuscriptRepair(source, control.bytes, source, control).passed,
    ).toBe(true);

    for (const modified of [
      original.replace('<w:bCs w:val="1"/>', '<w:bCs w:val="0"/>'),
      original.replace('<w:bCs w:val="0"/>', '<w:bCs w:val="1"/>'),
      original.replace('<w:bCs w:val="1"/>', ""),
    ]) {
      expect(() =>
        assertManuscriptRepair(source, control.bytes, fixture(modified), control),
      ).toThrow(/Repair changed content outside the exact marker\/format allowlist/u);
    }
  });

  it("rejects deleting a table shading node that also carries source attributes", () => {
    const shaded = documentXml().replace(
      '<w:tcPr><w:vAlign w:val="center"/></w:tcPr>',
      '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr>',
    );
    const source = fixture(shaded);
    const control = createControlledManuscript(source, source);
    const lossyRepair = fixture(
      shaded.replace('<w:shd w:val="clear" w:color="auto" w:fill="auto"/>', ""),
    );
    expect(() =>
      assertManuscriptRepair(source, control.bytes, lossyRepair, control),
    ).toThrow(/Repair changed content outside the exact marker\/format allowlist/u);
  });

  it("registers the exact table-last default-auto shading removal only", () => {
    const withDefaultAuto = documentXml().replace(
      table("Last table"),
      table("Last table").replace(
        "<w:tcPr>",
        '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="auto"/>',
      ),
    );
    const source = fixture(withDefaultAuto);
    const control = createControlledManuscript(source, source);
    expect(control.expected.defaultAutoShadingRemovals).toEqual([
      {
        targetId: "table-last",
        tableIndex: 2,
        rowIndex: 0,
        columnIndex: 0,
        originalXml: '<w:shd w:val="clear" w:color="auto" w:fill="auto"/>',
        reason: "explicit_direct_shading_removal",
      },
    ]);
    const repaired = fixture(
      withDefaultAuto.replace(
        '<w:shd w:val="clear" w:color="auto" w:fill="auto"/>',
        "",
      ),
    );
    expect(
      assertManuscriptRepair(source, control.bytes, repaired, control)
        .defaultAutoShadingRemovals,
    ).toEqual(control.expected.defaultAutoShadingRemovals);
    expect(() =>
      assertManuscriptRepair(source, control.bytes, source, control),
    ).toThrow(/registered default-auto direct shading was not removed/u);
  });

  it("normalizes only registered invalid identities and applies that map to repair", () => {
    const invalid = documentXml().replace(
      '<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
      '<w:p w14:paraId="80000000"><w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
    );
    const source = fixture(invalid);
    const control = createControlledManuscript(source, source);
    expect(control.expected.identityNormalizations).toEqual([
      expect.objectContaining({
        part: "word/document.xml",
        paragraphIndex: 0,
        originalParaId: "80000000",
        originalTextId: null,
        replacementTextId: null,
        reason: expect.stringContaining("invalid"),
      }),
    ]);
    const replacement =
      control.expected.identityNormalizations[0]!.replacementParaId!;
    expect(replacement).toMatch(/^[0-9A-F]{8}$/u);
    const repaired = fixture(invalid.replace("80000000", replacement));
    expect(
      assertManuscriptRepair(source, control.bytes, repaired, control)
        .identityNormalizations,
    ).toEqual(control.expected.identityNormalizations);
  });

  it("records unchanged identity lanes and normalizes duplicate pairs", () => {
    const mixed = documentXml()
      .replace(
        '<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
        '<w:p w14:paraId="12345678" w14:textId="80000001"><w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
      )
      .replace(
        '<w:p><w:pPr><w:pStyle w:val="Abstract"/></w:pPr>',
        '<w:p w14:paraId="80000002" w14:textId="22345678"><w:pPr><w:pStyle w:val="Abstract"/></w:pPr>',
      )
      .replace(
        '<w:p><w:pPr><w:pStyle w:val="Text"/></w:pPr><w:r><w:t xml:space="preserve">This first',
        '<w:p w14:paraId="3456789A" w14:textId="3456789A"><w:pPr><w:pStyle w:val="Text"/></w:pPr><w:r><w:t xml:space="preserve">This first',
      )
      .replace(
        '<w:p><w:pPr><w:pStyle w:val="Text"/></w:pPr><w:r><w:t xml:space="preserve">This middle',
        '<w:p w14:paraId="3456789A" w14:textId="3456789A"><w:pPr><w:pStyle w:val="Text"/></w:pPr><w:r><w:t xml:space="preserve">This middle',
      );
    const control = createControlledManuscript(fixture(mixed), fixture(mixed));
    const byIndex = new Map(
      control.expected.identityNormalizations.map((item) => [
        item.paragraphIndex,
        item,
      ]),
    );
    expect(byIndex.get(0)).toMatchObject({
      originalParaId: "12345678",
      replacementParaId: "12345678",
      originalTextId: "80000001",
    });
    expect(byIndex.get(0)?.replacementTextId).not.toBe("80000001");
    expect(byIndex.get(1)).toMatchObject({
      originalTextId: "22345678",
      replacementTextId: "22345678",
      originalParaId: "80000002",
    });
    expect(byIndex.get(1)?.replacementParaId).not.toBe("80000002");
    expect(byIndex.get(3)).toBeUndefined();
    expect(byIndex.get(4)).toMatchObject({
      originalParaId: "3456789A",
      originalTextId: "3456789A",
    });
    expect(byIndex.get(4)?.replacementParaId).toBe(
      byIndex.get(4)?.replacementTextId,
    );
    expect(byIndex.get(4)?.replacementParaId).not.toBe("3456789A");
  });

  it("keeps initial export stricter than target repair", () => {
    const source = fixture();
    const facts = assertManuscriptInitialExport(source, source);
    expect(facts.passed).toBe(true);
    expect(facts.semantics.targetPropertiesRemoved).toBe(false);

    const reorderedProperties = fixture(
      documentXml().replace(
        '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1008" w:right="936" w:bottom="1008" w:left="936"/>',
        '<w:pgMar w:top="1008" w:right="936" w:bottom="1008" w:left="936"/><w:pgSz w:w="11906" w:h="16838"/>',
      ),
    );
    expect(() =>
      assertManuscriptInitialExport(source, reorderedProperties),
    ).toThrow(/Initial export changed XML attributes or structure/u);

    const redundantSpaceRemoved = fixture(
      documentXml().replace(' xml:space="preserve"', ""),
    );
    expect(() =>
      assertManuscriptInitialExport(source, redundantSpaceRemoved),
    ).not.toThrow();

    const withParagraphId = fixture(
      documentXml().replace(
        '<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
        '<w:p w14:paraId="00000001"><w:pPr><w:pStyle w:val="Heading"/></w:pPr>',
      ),
    );
    expect(() =>
      assertManuscriptInitialExport(source, withParagraphId),
    ).toThrow(/Initial export changed XML attributes or structure/u);

    const spacedSource = fixture(
      documentXml().replace(
        '<w:t xml:space="preserve">A complete manuscript title</w:t>',
        '<w:t xml:space="preserve"> A complete manuscript title </w:t>',
      ),
    );
    const spaceLost = fixture(
      documentXml().replace(
        '<w:t xml:space="preserve">A complete manuscript title</w:t>',
        '<w:t> A complete manuscript title </w:t>',
      ),
    );
    expect(() => assertManuscriptInitialExport(spacedSource, spaceLost)).toThrow(
      /Initial export changed XML attributes or structure/u,
    );

    const namespaced = documentXml().replace(
      '<w:document xmlns:w=',
      '<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" mc:Ignorable="wp14" xmlns:w=',
    );
    const missingBinding = namespaced.replace(
      ' xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
      "",
    );
    expect(() =>
      assertManuscriptInitialExport(fixture(namespaced), fixture(missingBinding)),
    ).toThrow(/Namespace prefix referenced by[\s\S]*is not declared[\s\S]*wp14/u);
  });

  it("allows only valid missing note identities and rejects abnormal source IDs", () => {
    const footnote = (paragraphAttributes = "") =>
      `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="${WORD_NAMESPACE}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:footnote w:id="1"><w:p${paragraphAttributes}><w:r><w:t>Note text</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const source = fixture(documentXml(), {
      "word/footnotes.xml": strToU8(footnote()),
    });
    const withIds = fixture(documentXml(), {
      "word/footnotes.xml": strToU8(
        footnote(' w14:paraId="12345678" w14:textId="12345678"'),
      ),
    });
    expect(
      assertManuscriptInitialExport(source, withIds).semantics
        .allowedNoteIdentityAdditions,
    ).toEqual([
      {
        part: "word/footnotes.xml",
        paragraphIndex: 0,
        paraId: "12345678",
        textId: "12345678",
      },
    ]);

    const abnormal = fixture(documentXml(), {
      "word/footnotes.xml": strToU8(
        footnote(' w14:paraId="80000000" w14:textId="81234567"'),
      ),
    });
    expect(() => assertManuscriptInitialExport(abnormal, abnormal)).toThrow(
      /abnormal paragraph identity data[\s\S]*80000000/u,
    );
  });

  it("applies the same note-ID and redundant-space allowlist during repair", () => {
    const footnote = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="${WORD_NAMESPACE}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:footnote w:id="1"><w:p><w:r><w:t>Note text</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const source = fixture(documentXml(), {
      "word/footnotes.xml": strToU8(footnote),
    });
    const control = createControlledManuscript(source, source);
    const repaired = fixture(
      documentXml().replace(' xml:space="preserve"', ""),
      {
        "word/footnotes.xml": strToU8(
          footnote.replace(
            "<w:p>",
            '<w:p w14:paraId="12345678" w14:textId="12345678">',
          ),
        ),
      },
    );
    const facts = assertManuscriptRepair(
      source,
      control.bytes,
      repaired,
      control,
    );
    expect(facts.semantics.allowedNoteIdentityAdditions).toEqual([
      {
        part: "word/footnotes.xml",
        paragraphIndex: 0,
        paraId: "12345678",
        textId: "12345678",
      },
    ]);
    expect(facts.semantics.redundantSpaceRemovalsAccepted).toBe(true);

    const spacedSource = fixture(
      documentXml().replace(
        '<w:t xml:space="preserve">A complete manuscript title</w:t>',
        '<w:t xml:space="preserve"> A complete manuscript title </w:t>',
      ),
    );
    const spacedControl = createControlledManuscript(spacedSource, spacedSource);
    const lostEdgeSpace = fixture(
      documentXml().replace(
        '<w:t xml:space="preserve">A complete manuscript title</w:t>',
        '<w:t> A complete manuscript title </w:t>',
      ),
    );
    expect(() =>
      assertManuscriptRepair(
        spacedSource,
        spacedControl.bytes,
        lostEdgeSpace,
        spacedControl,
      ),
    ).toThrow(/Repair changed content outside the exact marker\/format allowlist/u);
  });
});

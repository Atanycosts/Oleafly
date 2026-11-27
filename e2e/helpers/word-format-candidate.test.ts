import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { verifyWordFormatCandidateBytes } from "./word-format-candidate";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";

function document(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:w14="${W14}" xmlns:m="${M}"><w:body>${body}</w:body></w:document>`;
}

function mcDocument(
  body: string,
  prefix = "w14",
  namespaceUri = W14,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:${prefix}="${namespaceUri}" ` +
    `mc:Ignorable="${prefix}" mc:MustUnderstand="${prefix}" ` +
    `mc:PreserveElements="${prefix}:paraId" ` +
    `mc:PreserveAttributes="${prefix}:textId" ` +
    `mc:ProcessContent="${prefix}:p">` +
    `<w:body>${body}</w:body></w:document>`;
}

function docx(
  body: string,
  extra: Record<string, Uint8Array> = {},
  level: 0 | 6 | 9 = 6,
): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
      "</Types>",
    ),
    "_rels/.rels": strToU8(`<Relationships xmlns="${REL}"/>`),
    "word/document.xml": strToU8(document(body)),
    "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}"/>`),
    "word/theme/theme1.xml": strToU8('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'),
    "word/media/image1.png": Uint8Array.from([137, 80, 78, 71, 1, 2, 3]),
    ...extra,
  }, { level });
}

const sourceBody =
  '<w:p w:rsidR="00112233"><w:r><w:t xml:space="preserve">Hello</w:t></w:r>' +
  '<w:bookmarkStart w:id="1" w:name="first"/></w:p>' +
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';

describe("independent Word format-candidate verification", () => {
  it("accepts supported direct story formatting", () => {
    const source = docx(sourceBody);
    const candidate = docx(
      '<w:p w14:paraId="12345678"><w:pPr><w:jc w:val="center"/></w:pPr>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r>' +
        '<w:bookmarkStart w:id="1" w:name="first"/>' +
      '</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
    );

    const result = verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    });

    expect(result).toMatchObject({
      passed: true,
      methodVersion: "independent-docx-format-2.6.0",
      package: {
        partSetPreserved: true,
        changedStoryParts: ["/word/document.xml"],
        binaryPartsPreserved: true,
        protectedXmlPreserved: true,
        pageFlowPreserved: true,
        tableFormattingPreserved: true,
        actualFormatChange: true,
      },
    });
    expect(result.package.changedParts).toEqual(["/word/document.xml"]);
    expect(result.ignoredNormalizations).toContain(
      "w:rsid* and w:textId/w14:textId attributes; w:paraId/w14:paraId outside w:comments; redundant xml:space where text has no edge whitespace",
    );
  });

  it("rejects a layout override in the style definitions", () => {
    const candidate = docx(sourceBody.replace('<w:t xml:space="preserve">', '<w:rPr><w:b/></w:rPr><w:t>'), {
      "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}"><w:docDefaults><w:pPrDefault><w:pPr><w:pageBreakBefore/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`),
    });
    expect(() => verifyWordFormatCandidateBytes({ sourceBytes: docx(sourceBody), candidateBytes: candidate }))
      .toThrow("A protected package part changed: /word/styles.xml");
  });

  it("allows changing the font of the paragraph mark without allowing a style-reference change", () => {
    const format = '<w:pPr><w:rPr><w:rStyle w:val="Mark"/><w:sz w:val="24"/></w:rPr></w:pPr>';
    const before = sourceBody.replace("<w:r>", `${format}<w:r>`);
    const after = before.replace('w:val="24"', 'w:val="28"');
    expect(verifyWordFormatCandidateBytes({ sourceBytes: docx(before), candidateBytes: docx(after) }).passed).toBe(true);
    expect(() => verifyWordFormatCandidateBytes({ sourceBytes: docx(before), candidateBytes: docx(after.replace('w:val="Mark"', 'w:val="Other"')) }))
      .toThrow(/protected paragraph and run properties/);
  });

  it("keeps line spacing and complex-script font slots protected beside writable attributes", () => {
    const before = '<w:p><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Tahoma"/></w:rPr><w:t>Hello</w:t></w:r></w:p>';
    const after = before.replace('w:after="120"', 'w:after="240"').replace('w:ascii="Arial"', 'w:ascii="Calibri"');
    const sourceBytes = docx(before);

    expect(verifyWordFormatCandidateBytes({ sourceBytes, candidateBytes: docx(after) }).passed).toBe(true);
    for (const changed of [
      after.replace('w:line="276"', 'w:line="300"'),
      after.replace('w:lineRule="auto"', 'w:lineRule="exact"'),
      after.replace('w:cs="Tahoma"', 'w:cs="Calibri"'),
    ]) {
      expect(() => verifyWordFormatCandidateBytes({ sourceBytes, candidateBytes: docx(changed) }))
        .toThrow(/protected paragraph and run properties/);
    }
  });

  it("rejects removing an existing table header's bold formatting", () => {
    const table = (bold: string) => `<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr>${bold}</w:rPr><w:t>Header</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: docx(table("<w:b/>") + sourceBody),
      candidateBytes: docx(table('<w:b w:val="0"/>') + sourceBody),
    })).toThrow(/changed an existing table's formatting/);
  });

  it("allows adding enabled row pagination flags but rejects removing or overriding existing ones", () => {
    const table = (properties: string) => `<w:tbl><w:tr>${properties}<w:tc><w:p/></w:tc></w:tr></w:tbl>`;
    const after = docx(table("<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>"));
    const before = docx(table(""));
    expect(verifyWordFormatCandidateBytes({ sourceBytes: before, candidateBytes: after }).package.tableFormattingPreserved).toBe(true);
    expect(() => verifyWordFormatCandidateBytes({ sourceBytes: after, candidateBytes: before })).toThrow(/changed an existing table's formatting/);
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: docx(table('<w:trPr><w:cantSplit w:val="0"/></w:trPr>')),
      candidateBytes: after,
    })).toThrow(/changed an existing table's formatting/);
  });

  it("accepts namespace-only XML serialization around a real format change", () => {
    const source = docx(sourceBody);
    const candidate = docx("<ignored/>", {
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<w:document xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
          `xmlns:w14="${W14}" xmlns:w="${W}"><w:body>` +
          '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Hello</w:t></w:r>' +
          '<w:bookmarkStart w:id="1" w:name="first"/></w:p>' +
          '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
          "</w:body></w:document>",
      ),
    });

    expect(verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    }).package).toMatchObject({
      changedStoryParts: ["/word/document.xml"],
      actualFormatChange: true,
    });
  });

  it("does not count namespace-only serialization as a format change", () => {
    const source = docx(sourceBody);
    const namespaceOnly = docx(sourceBody, {
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<w:document xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
          `xmlns:w14="${W14}" xmlns:w="${W}"><w:body>${sourceBody}</w:body></w:document>`,
      ),
    });

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: namespaceOnly,
    })).toThrow(/no actual XML format change/);
  });

  it("rejects namespace bindings that change expanded element names", () => {
    const source = docx(sourceBody);
    const changedBinding = docx(sourceBody, {
      "word/document.xml": strToU8(
        document(sourceBody).replace(W, "urn:not-wordprocessingml"),
      ),
    });

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: changedBinding,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);
  });

  it("protects meaningful xml:space on text and inherited containers", () => {
    const directSource = docx(
      '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r></w:p>',
    );
    const directCandidate = docx(
      '<w:p><w:r><w:t>Hello </w:t></w:r></w:p>',
    );
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: directSource,
      candidateBytes: directCandidate,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);

    const inheritedSource = docx(
      '<w:p xml:space="preserve"><w:r><w:t> Hello</w:t></w:r></w:p>',
    );
    const inheritedCandidate = docx(
      '<w:p><w:r><w:t> Hello</w:t></w:r></w:p>',
    );
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: inheritedSource,
      candidateBytes: inheritedCandidate,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);
  });

  it("tolerates redundant xml:space when text has no edge XML whitespace", () => {
    const source = docx(
      '<w:p xml:space="preserve"><w:pPr><w:jc w:val="left"/></w:pPr>' +
        '<w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>',
    );
    const candidate = docx(
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
        '<w:r><w:t>Hello</w:t></w:r></w:p>',
    );

    expect(verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    }).package.actualFormatChange).toBe(true);
  });

  it("protects comment paragraph IDs inside w:comments", () => {
    const body = (alignment: string) =>
      `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr>` +
        '<w:r><w:t>Hello</w:t></w:r></w:p>';
    const comments = (paragraphId: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:comments xmlns:w="${W}" xmlns:w14="${W14}"><w:comment w:id="0">` +
      `<w:p w14:paraId="${paragraphId}"><w:r><w:t>Comment</w:t></w:r></w:p>` +
      "</w:comment></w:comments>";
    const source = docx(body("left"), {
      "word/comments.xml": strToU8(comments("11111111")),
    });
    const candidate = docx(body("center"), {
      "word/comments.xml": strToU8(comments("22222222")),
    });

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    })).toThrow("A protected package part changed: /word/comments.xml");
  });

  it("rejects direct formatting changes in a header", () => {
    const header = (alignment: string) => strToU8(`<w:hdr xmlns:w="${W}">` +
      `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`);
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: docx(sourceBody, { "word/header1.xml": header("left") }),
      candidateBytes: docx(sourceBody, { "word/header1.xml": header("center") }),
    })).toThrow("A protected package part changed: /word/header1.xml");
  });

  it("resolves namespace aliases used by MC attributes and choices", () => {
    const body = (prefix: string, alignment: string) =>
      `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr>` +
        '<w:r><w:t>Hello</w:t></w:r></w:p>' +
        `<mc:AlternateContent><mc:Choice Requires="${prefix}">` +
        '<w:p><w:r><w:t>Choice</w:t></w:r></w:p></mc:Choice>' +
        '<mc:Fallback><w:p><w:r><w:t>Fallback</w:t></w:r></w:p></mc:Fallback>' +
        "</mc:AlternateContent>";
    const source = docx("", {
      "word/document.xml": strToU8(mcDocument(body("w14", "left"), "w14")),
    });
    const candidate = docx("", {
      "word/document.xml": strToU8(mcDocument(body("w2010", "center"), "w2010")),
    });

    expect(verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    }).package.actualFormatChange).toBe(true);
  });

  it("rejects MC namespace bindings that change resolved meaning", () => {
    const body = (prefix: string, alignment: string) =>
      `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr>` +
        '<w:r><w:t>Hello</w:t></w:r></w:p>';
    const source = docx("", {
      "word/document.xml": strToU8(mcDocument(body("w14", "left"), "w14")),
    });
    const candidate = docx("", {
      "word/document.xml": strToU8(
        mcDocument(body("w14", "center"), "w14", "urn:not-markup-compatibility"),
      ),
    });

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);
  });

  it("accepts recorded Word identity and cache normalizations with a real format change", () => {
    const source = docx(
      '<w:p w:rsidR="00112233"><w:proofErr w:type="spellStart"/>' +
        '<w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>',
    );
    const candidate = docx(
      '<w:p w14:paraId="12345678" w14:textId="12345678" w:rsidR="00AABBCC">' +
        '<w:pPr><w:jc w:val="center"/></w:pPr><w:lastRenderedPageBreak/>' +
        '<w:r><w:t>Hello</w:t></w:r></w:p>',
    );

    expect(verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: candidate,
    }).package.actualFormatChange).toBe(true);
  });

  it("rejects a package rewrite that has no actual XML format change", () => {
    const source = docx(sourceBody, {}, 9);
    const noOpSave = docx(sourceBody, {}, 0);
    expect(Buffer.from(noOpSave).equals(Buffer.from(source))).toBe(false);

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: noOpSave,
    })).toThrow(/no actual XML format change/);
  });

  it("rejects text changes even when the same candidate includes formatting", () => {
    const source = docx(sourceBody);
    const changedText = docx(
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
        '<w:r><w:t>Hallo</w:t></w:r><w:bookmarkStart w:id="1" w:name="first"/>' +
      '</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
    );

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: changedText,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);
  });

  it("rejects formula and drawing changes", () => {
    const source = docx(
      '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>' +
        '<w:r><w:drawing><w:docPr w:id="1"/></w:drawing></w:r></w:p>',
    );
    const changedFormula = docx(
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath>' +
        '<w:r><w:drawing><w:docPr w:id="1"/></w:drawing></w:r></w:p>',
    );
    const changedDrawing = docx(
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>' +
        '<w:r><w:drawing><w:docPr w:id="2"/></w:drawing></w:r></w:p>',
    );

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: changedFormula,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: changedDrawing,
    })).toThrow(/changed text, formulas, drawings, relationships or protected structure/);
  });

  it("rejects relationship and binary-part changes", () => {
    const source = docx(sourceBody);
    const changedRelationship = docx(sourceBody, {
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="image" Target="media/image2.png"/></Relationships>`,
      ),
    });
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: docx(sourceBody, {
        "word/_rels/document.xml.rels": strToU8(
          `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="image" Target="media/image1.png"/></Relationships>`,
        ),
      }),
      candidateBytes: changedRelationship,
    })).toThrow(/protected package part changed/);

    const changedImage = docx(sourceBody, {
      "word/media/image1.png": Uint8Array.from([137, 80, 78, 71, 9, 9, 9]),
    });
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: changedImage,
    })).toThrow(/binary package part changed/);
  });

  it.each([
    ['<w:framePr w:dropCap="drop"/>', ""],
    ["<w:keepNext/>", '<w:keepNext w:val="0"/>'],
    ["<w:keepLines/>", ""],
    ['<w:tabs><w:tab w:val="right" w:pos="8306"/></w:tabs>', ""],
    ['<w:sectPr><w:cols w:num="1"/></w:sectPr>', '<w:sectPr><w:cols w:num="2"/></w:sectPr>'],
  ])("rejects automatic page-flow changes to %s", (before, after) => {
    const body = (layout: string, alignment: string) =>
      `<w:p><w:pPr>${layout}<w:jc w:val="${alignment}"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p>`;
    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: docx(body(before, "left")),
      candidateBytes: docx(body(after, "center")),
    })).toThrow(/changed sections or protected paragraph and run properties/);
  });

  it("rejects added or removed package parts", () => {
    const source = docx(sourceBody);
    const addedPart = docx(sourceBody, {
      "word/extra.xml": strToU8(`<w:extra xmlns:w="${W}"/>`),
    });

    expect(() => verifyWordFormatCandidateBytes({
      sourceBytes: source,
      candidateBytes: addedPart,
    })).toThrow(/changed its part set/);
  });
});

import { readFileSync } from "node:fs";
import { createServerAutomationHost } from "@docx-editor.dev/core/automation";
import { readOoxmlPackage } from "@docx-editor.dev/core/store";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  classifyDocxFieldCode,
  readDocxFieldAction,
  readParagraphFieldClassifications,
} from "./docx-citation-fields";
import { createDocxHostSession, type DocxParagraphSemantics } from "./docx-session";

const zoteroCode = (items: unknown[]) => `ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify({ citationItems: items })}`;

function paragraphWithFields(...codes: string[]): DocxParagraphSemantics {
  return {
    paragraphRef: "paper", revision: 4, modelText: "\uFFFC".repeat(codes.length), displayText: "[1]", editableRanges: [],
    atoms: codes.map((code, index) => ({
      kind: "field", objectRef: `field-${index}`, modelRange: { start: index, end: index + 1 },
      displayRange: { start: 0, end: 3 }, displayText: "[1]", readable: true, complete: true, editable: false, payload: { code },
    })),
  };
}

describe("DOCX contextual field actions", () => {
  it("resolves every embedded CSL source on the exact field without using private manager URIs", () => {
    const paragraph = paragraphWithFields(zoteroCode([
      { uris: ["http://zotero.org/users/123/items/ABC"], itemData: { title: "First source", DOI: "10.1234/a#b" } },
      { itemData: { title: "Second source", URL: "https://example.org/research" } },
    ]), "REF FigureOne \\h");
    expect(readDocxFieldAction(paragraph, { start: 0, end: 1 })).toEqual({
      action: { kind: "citation", sources: [
        { title: "First source", url: "https://doi.org/10.1234/a%23b" },
        { title: "Second source", url: "https://example.org/research" },
      ] }, range: { start: 0, end: 1 }, revision: 4,
    });
    expect(readDocxFieldAction(paragraph, { start: 1, end: 1 })).toBeNull();
    expect(readDocxFieldAction(paragraph, { start: 0, end: 2 })).toBeNull();
    expect(readDocxFieldAction(paragraph, { start: 1, end: 2 })?.action).toEqual({ kind: "reference", bookmark: "FigureOne" });
  });

  it("reads embedded titles without exposing privileged URLs, and refuses unresolved clusters", () => {
    const range = { start: 0, end: 1 };
    expect(readDocxFieldAction(paragraphWithFields(zoteroCode([
      { itemData: { title: "Local title", URL: "file:///private/author.pdf" } },
    ])), range)?.action).toEqual({ kind: "citation", sources: [{ title: "Local title", url: null }] });
    for (const code of ["ADDIN CSL_CITATION {broken", zoteroCode([{ id: "internal-id" }, { itemData: { title: "Local title" } }]),
      "CITATION Smith2024", "PAGE", "ADDIN EN.CITE <EndNote/>"]) {
      expect(readDocxFieldAction(paragraphWithFields(code), range)).toBeNull();
    }
  });

  it("opens an encoded resolver link without encoding it a second time", () => {
    const item = { title: "Linked study", DOI: "https://doi.org/10.1234/A%23B" };
    const action = readDocxFieldAction(paragraphWithFields(zoteroCode([{ itemData: item }])), { start: 0, end: 1 })?.action;
    expect(action).toEqual({ kind: "citation", sources: [
      { title: "Linked study", url: "https://doi.org/10.1234/a%23b" },
    ] });
  });

  it("matches native citation tags only in the related Word bibliography", () => {
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const rootRels = "http://schemas.openxmlformats.org/package/2006/relationships";
    const sources = (entries: string) => `<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography">${entries}</b:Sources>`;
    const entry = (tag: string, title: string, identifiers = "") => `<b:Source><b:Tag>${tag}</b:Tag><b:Title>${title}</b:Title>${identifiers}</b:Source>`;
    const opened = readOoxmlPackage(zipSync({
      "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "_rels/.rels": strToU8(`<Relationships xmlns="${rootRels}"><Relationship Id="doc" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`),
      "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'),
      "word/_rels/document.xml.rels": strToU8(`<Relationships xmlns="${rootRels}"><Relationship Id="sources" Type="${rel}/customXml" Target="../customXml/item1.xml"/></Relationships>`),
      "customXml/item1.xml": strToU8(sources(
        entry("First", "Original source") + entry("Second", "Second source") + entry("Duplicate", "One") + entry("Duplicate", "Two") +
        entry("Linked", "Linked source", "<b:DOI>https://doi.org/10.1234/A%23B</b:DOI><b:URL>https://doi.org/10.1234/a%23b</b:URL>") +
        entry("Conflict", "Conflicting source", "<b:DOI>10.1234/first</b:DOI><b:URL>https://doi.org/10.1234/second</b:URL>"),
      )),
      "customXml/item2.xml": strToU8(sources(entry("First", "Do not use") + entry("Unrelated", "Do not use"))),
    }));
    if (!opened.ok) throw new Error(opened.reason);
    const action = (code: string) => readDocxFieldAction(paragraphWithFields(code), { start: 0, end: 1 }, () => opened.package)?.action;
    expect(action('CITATION First \\l 1033 \\f "see also" \\m Second')).toEqual({ kind: "citation", sources: [
      { title: "Original source", url: null }, { title: "Second source", url: null },
    ] });
    expect(action("CITATION Linked \\m Conflict")).toEqual({ kind: "citation", sources: [
      { title: "Linked source", url: "https://doi.org/10.1234/a%23b" }, { title: "Conflicting source", url: null },
    ] });
    for (const code of ["CITATION Unrelated", "CITATION Duplicate", "CITATION First \\m Unrelated", 'CITATION "First']) {
      expect(action(code)).toBeUndefined();
    }
  });
});

describe("DOCX field classification", () => {
  it.each([
    {
      name: "Word citation",
      code: " CITATION Smith2024 \\l 1033 ",
      expected: { kind: "citation", family: "word" },
    },
    {
      name: "case-insensitive Word bibliography",
      code: "bibliography \\l 1033",
      expected: { kind: "bibliography", family: "word" },
    },
    {
      name: "Zotero citation",
      code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[]}',
      expected: { kind: "citation", family: "zotero" },
    },
    {
      name: "Zotero bibliography",
      code: 'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY',
      expected: { kind: "bibliography", family: "zotero" },
    },
    {
      name: "CSL add-in citation",
      code: 'ADDIN CSL_CITATION {"citationItems":[],"schema":"csl"}',
      expected: { kind: "citation", family: "csl" },
    },
    {
      name: "Mendeley bibliography",
      code: "ADDIN Mendeley Bibliography CSL_BIBLIOGRAPHY",
      expected: { kind: "bibliography", family: "mendeley" },
    },
    {
      name: "EndNote citation",
      code: "ADDIN EN.CITE <EndNote><Cite><ID>1</ID></Cite></EndNote>",
      expected: { kind: "citation", family: "endnote" },
    },
    {
      name: "EndNote bibliography",
      code: "ADDIN EN.REFLIST",
      expected: { kind: "bibliography", family: "endnote" },
    },
    {
      name: "REF cross-reference",
      code: "REF Target \\h",
      expected: { kind: "cross-reference", family: "word" },
    },
    {
      name: "PAGEREF cross-reference",
      code: "PAGEREF _Ref123 \\h",
      expected: { kind: "cross-reference", family: "word" },
    },
    {
      name: "SEQ field",
      code: "SEQ Figure \\* ARABIC",
      expected: { kind: "unknown", family: null },
    },
    {
      name: "plain citation text",
      code: "(Smith, 2024)",
      expected: { kind: "unknown", family: null },
    },
    {
      name: "other add-in field",
      code: "ADDIN OTHER_TOOL command",
      expected: { kind: "unknown", family: null },
    },
    {
      name: "incomplete Zotero marker",
      code: "ADDIN ZOTERO_ITEM",
      expected: { kind: "unknown", family: null },
    },
    {
      name: "incomplete Word citation",
      code: "CITATION \\l 1033",
      expected: { kind: "unknown", family: null },
    },
    {
      name: "incomplete REF field",
      code: "REF",
      expected: { kind: "unknown", family: null },
    },
    {
      name: "lookalike CSL marker",
      code: "ADDIN CSL_CITATION_OTHER",
      expected: { kind: "unknown", family: null },
    },
  ])("$name", ({ code, expected }) => {
    expect(classifyDocxFieldCode(code)).toEqual({
      ...expected,
      editable: false,
    });
  });

  it("does not return field instructions or private payloads", () => {
    const result = classifyDocxFieldCode(
      'ADDIN CSL_CITATION {"citationItems":[{"id":"private-source"}]}',
    );

    expect(Object.keys(result).sort()).toEqual([
      "editable",
      "family",
      "kind",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-source");
  });

  it("reads field atoms from the Workbench DOCX fixture", () => {
    const opened = createServerAutomationHost(
      readFileSync(
        new URL(
          "../../services/research-workbench/tests/fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx",
          import.meta.url,
        ),
      ),
    );
    if (!opened.ok) throw new Error(opened.reason);
    const session = createDocxHostSession(opened.host);

    try {
      const paragraphs = session.listParagraphs();
      const fields = (marker: string) => {
        const paragraph = paragraphs.find((item) =>
          item.text.includes(marker),
        );
        if (!paragraph) throw new Error(`Missing fixture marker: ${marker}`);
        return readParagraphFieldClassifications(
          session.readParagraph(paragraph.handle),
        );
      };

      const zotero = fields("RFW-FX-RF-ZOTERO-FIELD-001");
      expect(zotero).toEqual([
        {
          objectRef: expect.any(String),
          kind: "citation",
          family: "zotero",
          editable: false,
        },
      ]);

      const crossReference = fields("RFW-FX-RF-XREF-RESULT-001");
      expect(crossReference).toContainEqual({
        objectRef: expect.any(String),
        kind: "cross-reference",
        family: "word",
        editable: false,
      });
      expect(JSON.stringify([zotero, crossReference])).not.toContain(
        "citationItems",
      );
    } finally {
      session.dispose();
    }
  });
});

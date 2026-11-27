import { readOoxmlPackage, type OoxmlNode } from "@docx-editor.dev/core/store";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createDocxReferenceReader } from "./docx-live-references";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
  });
}

function findNode(node: OoxmlNode, localName: string): OoxmlNode | undefined {
  if (node.kind === "textValue") return undefined;
  if (node.localName === localName) return node;
  for (const child of node.children) {
    const found = findNode(child, localName);
    if (found) return found;
  }
}

describe("DOCX live references", () => {
  it("keeps unresolved point, range, and incomplete comments distinguishable without a comments part", () => {
    const bytes = docx(
      '<w:p>' +
      '<w:commentRangeStart w:id="1"/><w:r><w:t>Alpha</w:t></w:r>' +
      '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>' +
      '<w:commentRangeStart w:id="2"/><w:r><w:t>Beta</w:t></w:r>' +
      '<w:r><w:commentReference w:id="3"/></w:r><w:commentRangeEnd w:id="4"/>' +
      "</w:p>",
    );
    const opened = readOoxmlPackage(bytes);
    if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
    const part = opened.package.parts.get("/word/document.xml");
    if (!part) throw new Error("Expected the document part.");

    const reader = createDocxReferenceReader(opened.package, part);
    const [paragraphComments] = [...reader.comments.values()];
    expect(paragraphComments?.map(({ kind, readable, payload }) => ({
      kind,
      readable,
      id: (payload as { id: string }).id,
      bodyPart: (payload as { bodyPart?: string }).bodyPart,
    }))).toEqual([
      { kind: "range", readable: false, id: "1", bodyPart: undefined },
      { kind: "incomplete_range", readable: false, id: "2", bodyPart: undefined },
      { kind: "point", readable: false, id: "3", bodyPart: undefined },
      { kind: "incomplete_range", readable: false, id: "4", bodyPart: undefined },
    ]);
    expect(reader.textboxesOf("missing-drawing")).toBeUndefined();
  });

  it("reports missing note parts and preserves exact point and range references", () => {
    const bytes = docx(
      '<w:p><w:r><w:t>Cited</w:t><w:footnoteReference w:id="7"/>' +
      '<w:endnoteReference w:id="8"/></w:r></w:p>',
    );
    const opened = readOoxmlPackage(bytes);
    if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
    const part = opened.package.parts.get("/word/document.xml");
    if (!part) throw new Error("Expected the document part.");
    const reader = createDocxReferenceReader(opened.package, part);
    const footnoteReference = findNode(part.root, "footnoteReference");
    const endnoteReference = findNode(part.root, "endnoteReference");
    if (!footnoteReference || !endnoteReference) throw new Error("Expected both note references.");

    expect(reader.noteOf(footnoteReference)).toEqual({
      readable: false,
      complete: false,
      payload: {
        kind: "footnote",
        id: 7,
        bodyPart: undefined,
        reason: "No footnote with this ID was found in the related part.",
      },
    });
    expect(reader.noteOf(endnoteReference)).toMatchObject({
      readable: false,
      payload: { kind: "endnote", id: 8, bodyPart: undefined },
    });
    expect(reader.noteOf(part.root)).toBeUndefined();

    const start = { paragraphRef: "/word/document.xml#p0", offset: 2 };
    const end = { paragraphRef: "/word/document.xml#p0", offset: 5 };
    expect(reader.reference("point", start)).toEqual({
      part: "/word/document.xml",
      kind: "point",
      start,
    });
    expect(reader.reference("range", start, end)).toEqual({
      part: "/word/document.xml",
      kind: "range",
      start,
      end,
    });
  });
});

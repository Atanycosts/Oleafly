import { readOoxmlPackage, writeOoxmlPackage } from "@docx-editor.dev/core/store";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDocxFormatFacts } from "./docx-format";
import {
  applyDocxTablePagination,
  planDocxTablePagination,
  verifyDocxTablePagination,
} from "./docx-table-pagination";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docx(
  body: string,
  styles?: string,
  section = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      (styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : "") +
      "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}"><w:body>${body}${section}</w:body></w:document>`,
    ),
  };
  if (styles) {
    parts["word/_rels/document.xml.rels"] = strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    );
    parts["word/styles.xml"] = strToU8(`<w:styles xmlns:w="${W}">${styles}</w:styles>`);
  }
  return zipSync(parts);
}

const textCell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const row = (text: string, properties = "", cell = textCell("42")) =>
  `<w:tr>${properties ? `<w:trPr>${properties}</w:trPr>` : ""}${textCell(text)}${cell}</w:tr>`;
const table = (rows: string, styleId?: string) =>
  `<w:tbl><w:tblPr>${styleId ? `<w:tblStyle w:val="${styleId}"/>` : ""}</w:tblPr>` +
  `<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>${rows}</w:tbl>`;
const template = [{ column_count: 2, rows: [{ object_id: "template-header", location: "Heading" }] }];

describe("DOCX table pagination", () => {
  it("honors split constraints inherited through named and default table styles", async () => {
    const facts = await openDocxFormatFacts(docx(
      table(row("Named header") + row("Named body"), "HeaderRows") +
      table(row("Default header") + row("Default body"), "MissingStyle"),
      '<w:docDefaults/><w:style w:type="paragraph" w:styleId="Body"/>' +
      '<w:style w:type="table" w:styleId="Base" w:default="1"><w:trPr><w:cantSplit/></w:trPr></w:style>' +
      '<w:style w:type="table" w:styleId="HeaderRows"><w:basedOn w:val="Base"/><w:tblStylePr w:type="firstRow">' +
      '<w:trPr><w:tblHeader/></w:trPr></w:tblStylePr></w:style>',
    ));

    expect(planDocxTablePagination(facts, template)).toEqual([]);
  });

  it("leaves exact-height, hidden, compound-cell, and table-property rows on their authored pagination", async () => {
    const twoParagraphs = `<w:tc><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:tc>`;
    const facts = await openDocxFormatFacts(docx(table(
      row("Heading", "<w:tblHeader/>") +
      row("Short", '<w:trHeight w:val="320" w:hRule="atLeast"/>') +
      row("Exact", '<w:trHeight w:val="4000" w:hRule="exact"/>') +
      row("Hidden", "<w:hidden/>") +
      row("Compound", "", twoParagraphs) +
      `<w:tr><w:tblPrEx><w:tblBorders/></w:tblPrEx>${textCell("Properties")}${textCell("42")}</w:tr>`,
    )));

    expect(planDocxTablePagination(facts, template).map(({ row: rowNumber, flag }) => [rowNumber, flag])).toEqual([
      [2, "cantSplit"],
    ]);
  });

  it("does not paginate a table without a two-column body section or a simple row grid", async () => {
    const oneColumn = `<w:tbl><w:tblGrid><w:gridCol w:w="8000"/></w:tblGrid>` +
      row("One") + row("Two") + "</w:tbl>";
    const floating = `<w:tbl><w:tblPr><w:tblpPr w:leftFromText="0" w:rightFromText="0" ` +
      'w:topFromText="0" w:bottomFromText="0" w:vertAnchor="text" w:horzAnchor="text" ' +
      'w:tblpXSpec="center" w:tblpYSpec="top"/></w:tblPr>' +
      `<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>` +
      row("One") + row("Two") + "</w:tbl>";
    const shortSection = '<w:sectPr><w:pgSz w:w="11906" w:h="1000"/><w:pgMar w:top="800" w:bottom="800"/></w:sectPr>';

    const [plain, single, floatingFacts, short] = await Promise.all([
      openDocxFormatFacts(docx("<w:p><w:r><w:t>No table</w:t></w:r></w:p>")),
      openDocxFormatFacts(docx(oneColumn)),
      openDocxFormatFacts(docx(floating)),
      openDocxFormatFacts(docx(table(row("One") + row("Two")), undefined, shortSection)),
    ]);

    expect(planDocxTablePagination(plain, template)).toEqual([]);
    expect(planDocxTablePagination(single, template)).toEqual([]);
    expect(planDocxTablePagination(floatingFacts, template)).toEqual([]);
    expect(planDocxTablePagination(short, template)).toEqual([]);
  });

  it("leaves table, row, and paragraph structures outside the simple pagination model untouched", async () => {
    const tableBookmark = table(
      `<w:bookmarkStart w:id="0" w:name="table-mark"/>${row("Heading", "<w:tblHeader/>")}${row("Short")}`,
    );
    const rowBookmark = table(
      row("Heading", "<w:tblHeader/>") +
      `<w:tr><w:bookmarkStart w:id="1" w:name="row-mark"/>${textCell("Bookmarked")}${textCell("42")}</w:tr>` +
      row("Short"),
    );
    const tabCell = `<w:tc><w:p><w:r><w:t>Tabbed</w:t><w:tab/></w:r></w:p></w:tc>`;
    const paragraphTab = table(
      row("Heading", "<w:tblHeader/>") +
      row("Tabbed", "", tabCell) +
      row("Short"),
    );

    const [tableFacts, rowFacts, paragraphFacts] = await Promise.all([
      openDocxFormatFacts(docx(tableBookmark)),
      openDocxFormatFacts(docx(rowBookmark)),
      openDocxFormatFacts(docx(paragraphTab)),
    ]);

    expect(planDocxTablePagination(tableFacts, template)).toEqual([]);
    expect(planDocxTablePagination(paragraphFacts, template).map(({ row: rowNumber, flag }) => [rowNumber, flag])).toEqual([
      [3, "cantSplit"],
    ]);
    expect(planDocxTablePagination(rowFacts, template).map(({ row: rowNumber, flag }) => [rowNumber, flag])).toEqual([
      [3, "cantSplit"],
    ]);
  });

  it("keeps short rows splittable when their line spacing and paragraph mark determine the height", async () => {
    const spaced = `<w:tc><w:p><w:pPr><w:spacing w:line="240" w:lineRule="auto"/>` +
      '<w:rPr><w:sz w:val="40"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="40"/></w:rPr>' +
      "<w:t>Spaced</w:t></w:r></w:p></w:tc>";
    const facts = await openDocxFormatFacts(docx(table(
      row("Heading", "<w:tblHeader/>") + row("Spaced", "", spaced),
    )));

    expect(planDocxTablePagination(facts, template).map(({ row: rowNumber, flag }) => [rowNumber, flag])).toEqual([
      [2, "cantSplit"],
    ]);
  });

  it("does not add body-row pagination to single-row or all-header tables", async () => {
    const [single, headers] = await Promise.all([
      openDocxFormatFacts(docx(table(row("Only")))),
      openDocxFormatFacts(docx(table(
        row("Header one", "<w:tblHeader/>") + row("Header two", "<w:tblHeader/>"),
      ))),
    ]);

    expect(planDocxTablePagination(single, template)).toEqual([]);
    expect(planDocxTablePagination(headers, template)).toEqual([]);
  });

  it("keeps table-property exclusions in schema order and verifies only rows present in the saved snapshot", async () => {
    const bytes = docx(table(
      `<w:tr><w:tblPrEx><w:tblBorders/></w:tblPrEx>${textCell("Properties")}${textCell("42")}</w:tr>` +
      row("Header", "<w:tblHeader/>") +
      row("Plain") +
      row("Retained", '<w:jc w:val="center"/>'),
    ));
    const facts = await openDocxFormatFacts(bytes);
    const rows = facts.snapshot.objects.filter(
      ({ kind, table_context }) => kind === "tr" && table_context?.table_object_id,
    );
    const changes = rows.map((rowObject, index) => ({
      flag: index === 3 ? "tblHeader" as const : "cantSplit" as const,
      property: index === 3 ? "row.isHeader" as const : "row.cantSplit" as const,
      rowId: rowObject.object_id,
      row: index + 1,
      tableNumber: 1,
    }));
    const firstChange = changes[0];
    if (!firstChange) throw new Error("Expected the first pagination change.");
    const opened = readOoxmlPackage(bytes);
    if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
    const part = opened.package.parts.get(facts.documentPart.name);
    if (!part) throw new Error("Expected the document part.");

    const applied = applyDocxTablePagination(part, changes);
    const savedBytes = writeOoxmlPackage({
      ...opened.package,
      parts: new Map(opened.package.parts).set(part.name, applied),
    });
    const saved = await openDocxFormatFacts(savedBytes);
    const savedXml = new TextDecoder().decode(unzipSync(savedBytes)["word/document.xml"]);

    expect(savedXml).toMatch(
      /<w:tr><w:tblPrEx><w:tblBorders\/><\/w:tblPrEx><w:trPr><w:cantSplit\/><\/w:trPr><w:tc>/,
    );
    expect(savedXml).toMatch(/<w:trPr><w:cantSplit\/><w:tblHeader\/><\/w:trPr>/);
    expect(savedXml).toMatch(/<w:tr><w:trPr><w:cantSplit\/><\/w:trPr><w:tc>/);
    expect(savedXml).toMatch(/<w:tblHeader\/><w:jc w:val="center"\/>/);
    expect(verifyDocxTablePagination(saved, changes)).toMatchObject([
      { confirmed: true, text: "Properties" },
      { confirmed: true, text: "Header" },
      { confirmed: true, text: "Plain" },
      { confirmed: true, text: "Retained" },
    ]);
    expect(verifyDocxTablePagination(saved, [{ ...firstChange, tableNumber: 99 }])).toMatchObject([
      { confirmed: false, id: "table-99-row-1" },
    ]);
    expect(() => applyDocxTablePagination(applied, changes)).toThrow(
      "The planned DOCX table row no longer matches.",
    );
    expect(() => applyDocxTablePagination(part, [{ ...firstChange, rowId: "missing" }])).toThrow(
      "The planned DOCX table row is missing from the edit tree.",
    );
  });
});

import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import { openTreeSession } from "@docx-editor.dev/core/binding";
import type {
  DocxEditorInstance,
  TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import {
  writeOoxmlPackage,
  type TreeDocOp,
} from "@docx-editor.dev/core/store";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createDocxSession } from "./docx-session";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STYLES_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";

function syntheticDocx(body: string, styles = ""): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles ? `<Override PartName="/word/styles.xml" ContentType="${STYLES_TYPE}"/>` : ""}</Types>`,
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr></w:body></w:document>`,
    ),
    ...(styles
      ? {
          "word/_rels/document.xml.rels": strToU8(
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
          ),
          "word/styles.xml": strToU8(
            `<?xml version="1.0"?><w:styles xmlns:w="${WORD_NS}">${styles}</w:styles>`,
          ),
        }
      : {}),
  });
}

function editorSession(bytes: Uint8Array, rejectTreeOps = false) {
  const opened = openTreeSession(bytes);
  if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
  const tree = opened.session;
  const batches: TreeDocOp[][] = [];
  const sessionView = new Proxy(tree, {
    get(target, property) {
      if (property === "applyTreeOps") {
        return (operations: readonly TreeDocOp[]) => {
          batches.push([...operations]);
          return rejectTreeOps
            ? {
                committed: false,
                rejected: true,
                opCount: operations.length,
                reason: "locked-content",
              }
            : target.applyTreeOps(operations);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TreeDocxSessionView;
  const surface = {
    session: sessionView,
    packageRevision: () => tree.packageRevision(),
    flushPendingInput: () => {},
    applyAutomationOps(
      staged: (
        relate: (url: string) => string | null,
      ) => readonly TreeDocOp[] | null,
    ) {
      const operations = staged((url) => url);
      return operations === null
        ? {
            committed: false,
            rejected: true,
            opCount: 0,
            reason: "planned operation refused",
          }
        : sessionView.applyTreeOps(operations);
    },
    editingMode: () => "edit" as const,
    collaborationSession: () => null,
    revisionDisplayMode: () => "allMarkup" as const,
    save: () => writeOoxmlPackage(tree.currentPackage()),
  };
  const editor = {
    surface,
    exec: () => ({ ok: true }),
    on: () => () => {},
    can: () => ({ ok: false }),
  } as unknown as DocxEditorInstance;
  return {
    session: createDocxSession(editor),
    tree,
    batches,
    save: () => writeOoxmlPackage(tree.currentPackage()),
    xml: () =>
      new TextDecoder().decode(unzipSync(writeOoxmlPackage(tree.currentPackage()))["word/document.xml"]),
  };
}

function paragraph(text: string, pPr = ""): string {
  return `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function tableStyle(styleId: string): string {
  return `<w:style w:type="table" w:styleId="${styleId}"><w:name w:val="${styleId}"/></w:style>`;
}

function nestedTableBody(): string {
  return [
    paragraph("Before"),
    `<w:tbl><w:tblPr><w:tblStyle w:val="OuterStyle"/><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="8000"/></w:tblGrid><w:tr><w:trPr><w:trHeight w:val="500" w:hRule="atLeast"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:shd w:val="clear" w:fill="ABCDEF"/><w:vAlign w:val="bottom"/></w:tcPr>${paragraph("Outer")}<w:tbl><w:tblPr><w:tblStyle w:val="OuterStyle"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:trPr><w:trHeight w:val="240" w:hRule="exact"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:fill="112233"/></w:tcPr>${paragraph("Nested")}</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`,
    paragraph("After"),
  ].join("");
}

function paragraphHandle(text: string, fixture: ReturnType<typeof editorSession>) {
  const paragraph = fixture.session.listParagraphs().find((item) => item.text === text);
  if (!paragraph) throw new Error(`Paragraph ${text} is missing.`);
  return paragraph.handle;
}

describe("DOCX object formatting", () => {
  it("writes only the section governing the anchor paragraph", () => {
    const fixture = editorSession(syntheticDocx([
      paragraph("First", '<w:sectPr><w:pgSz w:w="10000" w:h="14000"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/><w:cols w:num="2"/></w:sectPr>'),
      paragraph("Second"),
    ].join("")));

    expect(fixture.session.formatObject?.(paragraphHandle("First", fixture), 0, {
      kind: "section",
      section: {
        pageWidthTwips: 12000,
        pageHeightTwips: 16000,
        orientation: "landscape",
        marginLeftTwips: 720,
      },
    })).toEqual({ ok: true, revision: 1, changed: true });

    const xml = fixture.xml();
    expect(xml).toMatch(/<w:pgSz[^>]*w:h="16000"[^>]*w:orient="landscape"[^>]*w:w="12000"\/>/);
    expect(xml).toMatch(/<w:pgMar[^>]*w:left="720"[^>]*\/>/);
    expect(xml).toContain('<w:cols w:num="2"/>');
    expect(xml).toMatch(/<w:pgSz[^>]*w:h="16838"[^>]*w:w="11906"\/>/);
    expect(xml).toMatch(/<w:pgMar[^>]*w:left="1800"[^>]*\/>/);
  });

  it("uses the nearest nested table, row and cell for each object scope", () => {
    const fixture = editorSession(syntheticDocx(
      nestedTableBody(),
      `${tableStyle("OuterStyle")}${tableStyle("InnerStyle")}`,
    ));
    const nested = paragraphHandle("Nested", fixture);

    expect(fixture.session.formatObject?.(nested, 0, {
      kind: "table",
      table: {
        styleId: "InnerStyle",
        headerRowCount: 1,
        columnWidthsTwips: [3200],
      },
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(fixture.session.formatObject?.(nested, 1, {
      kind: "row",
      row: { heightTwips: 600 },
    })).toEqual({ ok: true, revision: 2, changed: true });

    const xml = fixture.xml();
    expect(xml.match(/<w:tblStyle w:val="OuterStyle"\/>/g)).toHaveLength(1);
    expect(xml).toContain('<w:tblStyle w:val="InnerStyle"/>');
    expect(xml).toContain('<w:tblHeader w:val="1"/>');
    expect(xml).toContain('<w:trHeight w:hRule="exact" w:val="600"/>');
    expect(xml).toContain('<w:trHeight w:hRule="atLeast" w:val="500"/>');
    expect(xml).toContain('<w:gridCol w:w="3200"/>');
  });

  it("applies cell fill and vertical alignment in one transaction and removes direct fill with null", () => {
    const fixture = editorSession(syntheticDocx(
      nestedTableBody(),
      `${tableStyle("OuterStyle")}${tableStyle("InnerStyle")}`,
    ));
    const nested = paragraphHandle("Nested", fixture);

    expect(fixture.session.formatObject?.(nested, 0, {
      kind: "cell",
      cell: { fill: "#00ff00", verticalAlignment: "center" },
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.batches[0]?.map((operation) => operation.op)).toEqual([
      "setTableCellFill",
      "setTableCellVerticalAlignment",
    ]);
    expect(fixture.xml()).toMatch(
      /<w:tcPr><w:tcW w:type="dxa" w:w="3000"\/><w:shd w:fill="00FF00" w:val="clear"\/><w:vAlign w:val="center"\/><\/w:tcPr>/,
    );

    expect(fixture.session.formatObject?.(nested, 1, {
      kind: "cell",
      cell: { fill: null },
    })).toEqual({ ok: true, revision: 2, changed: true });
    const innerCell = fixture.xml().match(
      /<w:tcPr><w:tcW w:type="dxa" w:w="3000"\/>(.*?)<\/w:tcPr>/s,
    )?.[1];
    expect(innerCell).not.toContain("<w:shd");
    expect(innerCell).toContain('<w:vAlign w:val="center"/>');
    expect(fixture.xml()).toContain('<w:shd w:fill="ABCDEF" w:val="clear"/>');
  });

  it("rejects unknown styles, unknown fields and objects outside an ancestor without changing bytes", () => {
    const fixture = editorSession(syntheticDocx(
      nestedTableBody(),
      `${tableStyle("OuterStyle")}${tableStyle("InnerStyle")}`,
    ));
    const nested = paragraphHandle("Nested", fixture);
    const before = fixture.save();
    const invalid = {
      kind: "section",
      section: {
        pageWidthTwips: 12000,
        op: "setTableProperties",
        anchorParagraphId: "other",
      },
    } as never;

    expect(fixture.session.formatObject?.(nested, 0, invalid)).toMatchObject({
      ok: false,
      code: "invalid-format",
      revision: 0,
    });
    expect(fixture.session.formatObject?.(nested, 0, {
      kind: "section",
      section: { marginTopTwips: 720 },
      op: "setSectionProperties",
    } as never)).toMatchObject({
      ok: false,
      code: "invalid-format",
      revision: 0,
    });
    expect(fixture.session.formatObject?.(nested, 0, {
      kind: "table",
      table: { op: "setTableProperties" },
    } as never)).toMatchObject({
      ok: false,
      code: "invalid-format",
      revision: 0,
    });
    expect(fixture.session.formatObject?.(nested, 0, {
      kind: "table",
      table: { styleId: "Missing" },
    })).toMatchObject({ ok: false, code: "invalid-format", revision: 0 });
    expect(fixture.session.formatObject?.(
      paragraphHandle("Before", fixture),
      0,
      { kind: "cell", cell: { fill: "#FFFFFF" } },
    )).toMatchObject({ ok: false, code: "unsupported-target", revision: 0 });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("rejects stale targets without writing", () => {
    const fixture = editorSession(syntheticDocx(nestedTableBody()));
    const before = fixture.save();

    expect(fixture.session.formatObject?.(
      paragraphHandle("Nested", fixture),
      1,
      { kind: "table", table: { headerRowCount: 1 } },
    )).toMatchObject({ ok: false, code: "stale-target", revision: 0 });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("maps an invalid paragraph handle to a stale target without writing", () => {
    const fixture = editorSession(syntheticDocx(nestedTableBody()));
    const before = fixture.save();

    expect(fixture.session.formatObject?.(
      { kind: "paragraph", ref: "paragraph:missing:1" } as AutomationHandle<"paragraph">,
      0,
      { kind: "table", table: { headerRowCount: 1 } },
    )).toMatchObject({ ok: false, code: "stale-target", revision: 0 });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("reports a refused tree transaction without writing", () => {
    const fixture = editorSession(syntheticDocx(nestedTableBody()), true);
    const before = fixture.save();

    expect(fixture.session.formatObject?.(
      paragraphHandle("Nested", fixture),
      0,
      { kind: "table", table: { headerRowCount: 1 } },
    )).toEqual({
      ok: false,
      code: "transaction-refused",
      message: "locked-content",
      revision: 0,
      changed: false,
    });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("saves and reopens object formatting while preserving unrelated properties", () => {
    const fixture = editorSession(syntheticDocx(
      nestedTableBody(),
      `${tableStyle("OuterStyle")}${tableStyle("InnerStyle")}`,
    ));
    const nested = paragraphHandle("Nested", fixture);
    expect(fixture.session.formatObject?.(nested, 0, {
      kind: "table",
      table: { styleId: "InnerStyle" },
    })).toMatchObject({ ok: true, revision: 1 });
    expect(fixture.session.formatObject?.(nested, 1, {
      kind: "cell",
      cell: { fill: "AABBCC" },
    })).toMatchObject({ ok: true, revision: 2 });

    const reopened = editorSession(fixture.save());
    expect(reopened.session.listParagraphs().map((item) => item.text)).toEqual(
      fixture.session.listParagraphs().map((item) => item.text),
    );
    const xml = reopened.xml();
    expect(xml).toContain('<w:tblStyle w:val="InnerStyle"/>');
    expect(xml).toContain('<w:tcW w:type="dxa" w:w="3000"/>');
    expect(xml).toContain('w:fill="AABBCC"');
    expect(xml).toContain('<w:shd w:fill="ABCDEF" w:val="clear"/>');
  });
});

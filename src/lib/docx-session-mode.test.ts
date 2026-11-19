// @vitest-environment jsdom
import {
  mountPaginatedSurface,
  type DocxEditorInstance,
  type PaginatedSurface,
} from "@docx-editor.dev/core/editor";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, it } from "vitest";
import type { DocxObjectFormatMutation } from "@oleafly/ai-tools";
import { createDocxSession, type DocxParagraphFormatWriteInput } from "./docx-session";

function documentBytes(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="SimSun"/></w:rPr><w:t>Mode target 中文</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:left="1440" w:right="1440" w:bottom="1440"/></w:sectPr></w:body></w:document>'),
  });
}

function mounted(mode: ReturnType<PaginatedSurface["editingMode"]>) {
  const container = document.createElement("div");
  document.body.append(container);
  const opened = mountPaginatedSurface(container, documentBytes(), {
    editingMode: mode,
    author: "Mode Gate Author",
    measurer: {
      measure: (text) => text.length * 6,
      lineMetrics: () => ({ height: 14, baseline: 11 }),
    },
  });
  if (!opened.ok) throw new Error(opened.reason);
  const surface = opened.surface;
  const editor = {
    surface,
    exec: () => ({ ok: true }),
    on: () => () => {},
    can: () => ({ ok: false }),
  } as unknown as DocxEditorInstance;
  const session = createDocxSession(editor);
  const paragraph = session.listParagraphs()[0].handle;
  return {
    surface,
    session,
    paragraph,
    xml: () => strFromU8(unzipSync(surface.save())["word/document.xml"]),
    dispose() {
      session.dispose();
      surface.destroy();
      container.remove();
    },
  };
}

const paragraphFormats: DocxParagraphFormatWriteInput[] = [
  { font: { nameEastAsia: "SimHei" } },
  { paragraph: { keepNext: true, keepLines: true, pageBreakBefore: true } },
  { font: { nameEastAsia: "SimHei", bold: true }, paragraph: { keepLines: true } },
];

it.each(paragraphFormats)("refuses paragraph formatting through the real viewing surface: %j", (format) => {
  const fixture = mounted("view");
  try {
    const before = fixture.surface.save();
    expect(fixture.session.formatParagraph?.(fixture.paragraph, 0, format)).toMatchObject({
      ok: false, changed: false, revision: 0,
    });
    expect(fixture.session.revision()).toBe(0);
    expect(fixture.surface.save()).toEqual(before);
  } finally { fixture.dispose(); }
});

const objectFormats: DocxObjectFormatMutation[] = [
  { kind: "section", section: { marginTopTwips: 1800 } },
  { kind: "table", table: { headerRowCount: 1 } },
  { kind: "row", row: { heightTwips: 480 } },
  { kind: "cell", cell: { fill: "ABCDEF", verticalAlignment: "center" } },
];

it.each(objectFormats)("refuses object formatting through the real viewing surface: %j", (format) => {
  const fixture = mounted("view");
  try {
    const before = fixture.surface.save();
    expect(fixture.session.formatObject?.(fixture.paragraph, 0, format)).toMatchObject({
      ok: false, code: "transaction-refused", changed: false, revision: 0,
      message: "the document is open for viewing",
    });
    expect(fixture.session.revision()).toBe(0);
    expect(fixture.surface.save()).toEqual(before);
  } finally { fixture.dispose(); }
});

it.each(objectFormats)("refuses untrackable object formats in suggesting mode: %j", (format) => {
  const fixture = mounted("suggest");
  try {
    const before = fixture.surface.save();
    expect(fixture.surface.editingMode()).toBe("suggest");
    expect(fixture.session.formatObject?.(fixture.paragraph, 0, format)).toMatchObject({
      ok: false, code: "unsupported-target", changed: false, revision: 0,
      message: expect.stringContaining("cannot be recorded as a suggested revision"),
    });
    expect(fixture.surface.save()).toEqual(before);
  } finally { fixture.dispose(); }
});

it.each(["view", "suggest"] as const)("refuses a mixed font and object batch atomically in %s mode", (mode) => {
  const fixture = mounted(mode);
  try {
    const before = fixture.surface.save();
    const result = fixture.session.formatBatch?.([
      { target: fixture.paragraph, font: { bold: true } },
      {
        target: fixture.paragraph,
        objectFormat: { kind: "table", table: { headerRowCount: 1 } },
      },
    ], 0);

    if (mode === "view") {
      expect(result).toEqual({
        ok: false,
        code: "transaction-refused",
        message: "the document store refused the transaction",
        revision: 0,
        changed: false,
      });
    } else {
      expect(result).toEqual({
        ok: false,
        code: "unsupported-target",
        message:
          "Section and table object formatting cannot be recorded as a suggested revision. Switch to editing mode to apply it.",
        revision: 0,
        changed: false,
      });
    }
    expect(fixture.session.revision()).toBe(0);
    expect(fixture.surface.save()).toEqual(before);
  } finally { fixture.dispose(); }
});

it("records paragraph controls and East Asian font with the suggesting author's revisions", () => {
  const fixture = mounted("suggest");
  try {
    expect(fixture.surface.editingMode()).toBe("suggest");
    expect(fixture.session.formatParagraph?.(fixture.paragraph, 0, {
      paragraph: { keepLines: true },
    })).toMatchObject({ ok: true, changed: true, revision: 1 });
    expect(fixture.xml()).toMatch(/<w:pPrChange\b[^>]*w:author="Mode Gate Author"/);
    expect(fixture.session.formatParagraph?.(fixture.paragraph, 1, {
      font: { nameEastAsia: "SimHei" },
    })).toMatchObject({ ok: true, changed: true, revision: 2 });
    expect(fixture.xml()).toMatch(/<w:rPrChange\b[^>]*w:author="Mode Gate Author"/);
  } finally { fixture.dispose(); }
});

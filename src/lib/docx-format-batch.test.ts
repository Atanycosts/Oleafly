// @vitest-environment jsdom
import {
  mountPaginatedSurface,
  type DocxEditorInstance,
} from "@docx-editor.dev/core/editor";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, it } from "vitest";
import { createDocxSession } from "./docx-session";
import { openDocxFormatFacts } from "./docx-format";
import { createDocxFormatReader } from "./docx-format-reader";

function mounted(
  body = '<w:p><w:r><w:t>Alpha </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Symbol"/></w:rPr><w:t>β</w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath><w:r><w:rPr><w:i/></w:rPr><w:t> omega</w:t></w:r></w:p><w:p><w:r><w:t>Second 中文</w:t></w:r></w:p>',
  mode: "edit" | "view" | "suggest" = "edit",
  styles = "",
  theme = "",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const bytes = zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
  });
  const parts = unzipSync(bytes);
  if (styles) {
    parts["word/styles.xml"] = strToU8(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`,
    );
    parts["word/_rels/document.xml.rels"] = strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    );
    parts["[Content_Types].xml"] = strToU8(
      strFromU8(parts["[Content_Types].xml"]).replace(
        "</Types>",
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      ),
    );
  }
  if (theme) {
    parts["word/theme/theme1.xml"] = strToU8(theme);
    const relationships = parts["word/_rels/document.xml.rels"]
      ? strFromU8(parts["word/_rels/document.xml.rels"])
      : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    parts["word/_rels/document.xml.rels"] = strToU8(
      relationships.replace(
        "</Relationships>",
        '<Relationship Id="theme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>',
      ),
    );
    parts["[Content_Types].xml"] = strToU8(
      strFromU8(parts["[Content_Types].xml"]).replace(
        "</Types>",
        '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
      ),
    );
  }
  const opened = mountPaginatedSurface(
    container,
    styles || theme ? zipSync(parts) : bytes,
    {
      editingMode: mode,
      author: "Batch Author",
      measurer: {
        measure: (text) => text.length * 6,
        lineMetrics: () => ({ height: 14, baseline: 11 }),
      },
    },
  );
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
    paragraphs: session.listParagraphs(),
    xml: () => strFromU8(unzipSync(surface.save())["word/document.xml"]),
    dispose() {
      session.dispose();
      surface.destroy();
      container.remove();
    },
  };
}

it("changes only a model span after field and math atoms and undoes the entire group once", () => {
  const f = mounted();
  try {
    const [first, second] = f.paragraphs;
    const model = f.session.readParagraphModelText!(first.handle);
    expect(model).toContain("\uFFFC");
    const before = f.xml();
    expect(
      f.session.formatBatch!(
        [
          {
            target: first.handle,
            range: { start: model.indexOf("omega"), end: model.length },
            font: { name: "Arial", nameEastAsia: "SimHei", bold: true },
          },
          {
            target: second.handle,
            paragraph: { keepLines: true },
            font: { nameEastAsia: "SimSun" },
          },
        ],
        0,
      ),
    ).toEqual({ ok: true, revision: 1, changed: true });
    const dom = new DOMParser().parseFromString(f.xml(), "text/xml");
    const paragraphs = [...dom.getElementsByTagName("w:p")];
    expect(paragraphs[0].getElementsByTagName("m:oMath")[0].textContent).toBe(
      "x+1",
    );
    const runs = [...paragraphs[0].getElementsByTagName("w:r")];
    const symbol = runs.find((run) => run.textContent === "β")!;
    expect(
      symbol.getElementsByTagName("w:rFonts")[0].getAttribute("w:ascii"),
    ).toBe("Symbol");
    expect(symbol.getElementsByTagName("w:b")).toHaveLength(0);
    const omega = runs.find((run) => run.textContent === "omega")!;
    expect(omega.getElementsByTagName("w:i")).toHaveLength(1);
    expect(omega.getElementsByTagName("w:b")).toHaveLength(1);
    expect(
      omega.getElementsByTagName("w:rFonts")[0].getAttribute("w:eastAsia"),
    ).toBe("SimHei");
    expect(paragraphs[0].getElementsByTagName("w:keepLines")).toHaveLength(0);
    expect(paragraphs[1].getElementsByTagName("w:keepLines")).toHaveLength(1);
    expect(
      paragraphs[1]
        .getElementsByTagName("w:rFonts")[0]
        .getAttribute("w:eastAsia"),
    ).toBe("SimSun");
    f.surface.undo();
    expect(f.xml()).toBe(before);
  } finally {
    f.dispose();
  }
});

it.each([
  { start: 5, end: 2 },
  { start: -1, end: 2 },
  { start: 0, end: 999 },
  { start: 1, end: 1 },
])("rejects an invalid range atomically: %j", (range) => {
  const f = mounted();
  try {
    const before = f.xml();
    expect(
      f.session.formatBatch!(
        [
          { target: f.paragraphs[1].handle, font: { bold: true } },
          { target: f.paragraphs[0].handle, range, font: { italic: true } },
        ],
        0,
      ),
    ).toMatchObject({ ok: false, revision: 0, changed: false });
    expect(f.xml()).toBe(before);
  } finally {
    f.dispose();
  }
});

it("rejects a core-invalid format in a group before any earlier change commits", () => {
  const f = mounted();
  try {
    const before = f.xml();
    expect(
      f.session.formatBatch!(
        [
          { target: f.paragraphs[0].handle, font: { bold: true } },
          { target: f.paragraphs[1].handle, font: { size: -3 } },
        ],
        0,
      ),
    ).toMatchObject({ ok: false, changed: false, revision: 0 });
    expect(f.xml()).toBe(before);
  } finally {
    f.dispose();
  }
});

it("refuses grouped changes in viewing mode and records font spans in suggesting mode", () => {
  for (const mode of ["view", "suggest"] as const) {
    const f = mounted(undefined, mode);
    try {
      const before = f.xml();
      const result = f.session.formatBatch!(
        [
          {
            target: f.paragraphs[0].handle,
            range: { start: 0, end: 5 },
            font: { nameEastAsia: "SimHei", bold: true },
          },
          { target: f.paragraphs[1].handle, paragraph: { keepNext: true } },
        ],
        0,
      );
      if (mode === "view") {
        expect(result).toMatchObject({ ok: false, revision: 0 });
        expect(f.xml()).toBe(before);
      } else {
        expect(result).toMatchObject({ ok: true, revision: 1 });
        expect(f.xml()).toContain('w:author="Batch Author"');
        expect(f.xml()).toContain("w:rPrChange");
        expect(f.xml()).toContain("w:pPrChange");
      }
    } finally {
      f.dispose();
    }
  }
});

it("writes and removes a paragraph frame beside actual section columns atomically", () => {
  const f = mounted(
    "<w:p><w:pPr><w:keepNext/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p>",
  );
  try {
    expect(
      f.session.formatBatch!(
        [
          {
            target: f.paragraphs[0].handle,
            paragraph: { alignment: "Centered" },
            objectFormat: {
              kind: "frame",
              frame: {
                widthTwips: 10000,
                horizontalAnchor: "page",
                verticalAnchor: "text",
                horizontalAlignment: "center",
                yTwips: 1,
                wrap: "notBeside",
                verticalSpaceTwips: 100,
              },
            },
          },
          {
            target: f.paragraphs[1].handle,
            objectFormat: {
              kind: "section",
              section: {
                columns: { count: 2, spaceTwips: 720, separator: true },
              },
            },
          },
        ],
        0,
      ),
    ).toEqual({ ok: true, revision: 1, changed: true });
    const dom = new DOMParser().parseFromString(f.xml(), "text/xml");
    const frame = dom.getElementsByTagName("w:framePr")[0];
    expect(frame.getAttribute("w:w")).toBe("10000");
    expect(frame.getAttribute("w:wrap")).toBe("notBeside");
    expect(dom.getElementsByTagName("w:keepNext")).toHaveLength(1);
    expect(dom.getElementsByTagName("w:jc")[0].getAttribute("w:val")).toBe(
      "center",
    );
    const columns = dom.getElementsByTagName("w:cols")[0];
    expect(columns.getAttribute("w:num")).toBe("2");
    expect(columns.getAttribute("w:equalWidth")).toBeNull();
    expect(columns.getAttribute("w:space")).toBe("720");
    expect(columns.getAttribute("w:sep")).toBe("1");
    expect(
      f.session.formatObject!(f.paragraphs[0].handle, 1, {
        kind: "frame",
        frame: null,
      }),
    ).toEqual({ ok: true, revision: 2, changed: true });
    const removed = new DOMParser().parseFromString(f.xml(), "text/xml");
    expect(removed.getElementsByTagName("w:framePr")).toHaveLength(0);
    expect(removed.getElementsByTagName("w:keepNext")).toHaveLength(1);
    expect(removed.getElementsByTagName("w:jc")[0].getAttribute("w:val")).toBe(
      "center",
    );
    f.surface.undo();
    expect(f.xml()).toContain("w:framePr");
  } finally {
    f.dispose();
  }
});

it("records frame changes as suggestions and prevents frame/column groups in viewing mode", () => {
  for (const mode of ["view", "suggest"] as const) {
    const f = mounted(undefined, mode);
    try {
      const before = f.xml();
      const result = f.session.formatObject!(f.paragraphs[0].handle, 0, {
        kind: "frame",
        frame: { widthTwips: 10000, wrap: "notBeside" },
      });
      if (mode === "view") {
        expect(result).toMatchObject({ ok: false, revision: 0 });
        expect(f.xml()).toBe(before);
      } else {
        expect(result).toMatchObject({ ok: true, revision: 1 });
        expect(f.xml()).toContain("w:pPrChange");
      }
    } finally {
      f.dispose();
    }
  }
});

it("uses model offsets for an East Asian only span after a complex field", () => {
  const f = mounted(
    '<w:p><w:r><w:t>Lead</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF long_instruction </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Long field result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>Target</w:t></w:r></w:p>',
  );
  try {
    const text = f.session.readParagraphModelText!(f.paragraphs[0].handle);
    expect(text).toBe("Lead\uFFFCTarget");
    expect(
      f.session.formatBatch!(
        [
          {
            target: f.paragraphs[0].handle,
            range: { start: 5, end: 11 },
            font: { nameEastAsia: "SimHei" },
          },
        ],
        0,
      ),
    ).toMatchObject({ ok: true, revision: 1 });
    const dom = new DOMParser().parseFromString(f.xml(), "text/xml");
    const runs = [...dom.getElementsByTagName("w:r")];
    expect(
      runs
        .find((r) => r.textContent === "Target")!
        .getElementsByTagName("w:rFonts")[0]
        .getAttribute("w:eastAsia"),
    ).toBe("SimHei");
    expect(
      runs
        .find((r) => r.textContent === "Long field result")!
        .getElementsByTagName("w:rFonts"),
    ).toHaveLength(0);
    expect(dom.getElementsByTagName("w:instrText")[0].textContent).toBe(
      " REF long_instruction ",
    );
  } finally {
    f.dispose();
  }
});

it("formats separate spans in one paragraph and refuses overlapping spans", () => {
  const f = mounted("<w:p><w:r><w:t>Alpha Middle Omega</w:t></w:r></w:p>");
  try {
    const target = f.paragraphs[0].handle;
    expect(
      f.session.formatBatch!(
        [
          {
            target,
            range: { start: 0, end: 5 },
            font: { bold: true, nameEastAsia: "SimSun" },
          },
          {
            target,
            range: { start: 13, end: 18 },
            font: { italic: true, nameEastAsia: "SimHei" },
          },
        ],
        0,
      ),
    ).toEqual({ ok: true, changed: true, revision: 1 });
    const runs = [
      ...new DOMParser()
        .parseFromString(f.xml(), "text/xml")
        .getElementsByTagName("w:r"),
    ];
    expect(
      runs.find((r) => r.textContent === "Alpha")!.getElementsByTagName("w:b"),
    ).toHaveLength(1);
    expect(
      runs.find((r) => r.textContent === "Omega")!.getElementsByTagName("w:i"),
    ).toHaveLength(1);
    expect(
      runs
        .find((r) => r.textContent === " Middle ")!
        .getElementsByTagName("w:rPr"),
    ).toHaveLength(0);
    const before = f.xml();
    expect(
      f.session.formatBatch!(
        [
          { target, range: { start: 0, end: 8 }, font: { bold: false } },
          { target, range: { start: 5, end: 12 }, font: { italic: true } },
        ],
        1,
      ),
    ).toMatchObject({ ok: false, revision: 1 });
    expect(f.xml()).toBe(before);
  } finally {
    f.dispose();
  }
});

it("imports a template style dependency closure in one reversible package transaction", () => {
  const source = mounted();
  const f = mounted();
  try {
    const parts = unzipSync(source.surface.save());
    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    parts["word/styles.xml"] = strToU8(
      `<w:styles xmlns:w="${ns}"><w:style w:type="paragraph" w:styleId="ImportedBase"><w:name w:val="Imported base"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ImportedTitle"><w:name w:val="Imported title"/><w:basedOn w:val="ImportedBase"/><w:pPr><w:framePr w:w="10000" w:wrap="notBeside"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Unselected"><w:name w:val="Unselected"/></w:style></w:styles>`,
    );
    parts["word/_rels/document.xml.rels"] = strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    );
    parts["[Content_Types].xml"] = strToU8(
      strFromU8(parts["[Content_Types].xml"]).replace(
        "</Types>",
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      ),
    );
    const before = f.surface.save();
    const documentBefore = f.xml();
    expect(
      f.session.importTemplateStyles!(zipSync(parts), ["ImportedTitle"], 0),
    ).toMatchObject({
      ok: true,
      changed: true,
      revision: 1,
      styleIdMap: {
        ImportedTitle: "ImportedTitle",
        ImportedBase: "ImportedBase",
      },
    });
    const saved = unzipSync(f.surface.save());
    expect(strFromU8(saved["word/styles.xml"])).toContain(
      'w:styleId="ImportedBase"',
    );
    expect(strFromU8(saved["word/styles.xml"])).not.toContain(
      'w:styleId="Unselected"',
    );
    expect(f.xml()).toBe(documentBefore);
    const viewer = mounted(undefined, "view");
    const suggesting = mounted(undefined, "suggest");
    try {
      for (const fixture of [viewer, suggesting]) {
        const untouched = fixture.surface.save();
        expect(
          fixture.session.importTemplateStyles!(
            zipSync(parts),
            ["ImportedTitle"],
            0,
          ),
        ).toMatchObject({ ok: false, changed: false, revision: 0 });
        expect(fixture.surface.save()).toEqual(untouched);
      }
    } finally {
      viewer.dispose();
      suggesting.dispose();
    }
    f.surface.undo();
    expect(f.surface.save()).toEqual(before);
    const revision = f.session.revision();
    expect(
      f.session.importTemplateStyles!(zipSync(parts), ["Missing"], revision),
    ).toMatchObject({ ok: false, changed: false, revision });
    expect(f.surface.save()).toEqual(before);
  } finally {
    source.dispose();
    f.dispose();
  }
});

it("refuses style imports through viewing and suggesting modes without modifying package bytes", () => {
  for (const mode of ["view", "suggest"] as const) {
    const f = mounted(undefined, mode);
    try {
      const before = f.surface.save();
      expect(
        f.session.importTemplateStyles!(before, ["Missing"], 0),
      ).toMatchObject({ ok: false, changed: false, revision: 0 });
      expect(f.surface.save()).toEqual(before);
    } finally {
      f.dispose();
    }
  }
});

it("resolves an imported conflicting style ID to its name before applying and independently undoing it", async () => {
  const body = "<w:p><w:r><w:t>Apply imported title</w:t></w:r></w:p>";
  const targetStyle =
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Journal display title"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style>';
  const sourceStyles =
    '<w:style w:type="paragraph" w:styleId="TemplateBase"><w:name w:val="Template base"/><w:rPr><w:sz w:val="32"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Journal display title"/><w:basedOn w:val="TemplateBase"/><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr></w:style>';
  const source = mounted(body, "edit", sourceStyles);
  const target = mounted(body, "edit", targetStyle);
  try {
    const original = target.surface.save();
    const imported = target.session.importTemplateStyles!(
      source.surface.save(),
      ["Title"],
      0,
    );
    expect(imported).toMatchObject({
      ok: true,
      changed: true,
      revision: 1,
      styleIdMap: { Title: "TitlePasted", TemplateBase: "TemplateBase" },
    });
    const mappedId = imported.styleIdMap?.Title;
    expect(mappedId).toBe("TitlePasted");
    const afterImport = target.surface.save();
    const read = createDocxFormatReader({
      session: target.session,
      exportBytes: async () => target.surface.save(),
      document: () => ({
        sessionId: "style-test",
        baselineId: "baseline",
        savedRevision: 0,
        filename: "style-test.docx",
      }),
    });
    const styles = await read({ kind: "styles", styleId: mappedId, limit: 1 });
    const name = styles.styles?.[0]?.name;
    expect(name).toBe("Journal display title (pasted)");
    expect(name).not.toBe(mappedId);
    if (typeof name !== "string")
      throw new Error("The imported style name is missing.");
    const paragraph = target.paragraphs[0].handle;
    expect(
      target.session.formatParagraph!(paragraph, 1, {
        paragraph: { style: mappedId },
      }),
    ).toMatchObject({ ok: false, changed: false, revision: 1 });
    expect(target.surface.save()).toEqual(afterImport);
    expect(
      target.session.formatParagraph!(paragraph, 1, {
        paragraph: { style: name },
      }),
    ).toEqual({ ok: true, changed: true, revision: 2 });
    const saved = target.surface.save();
    const xml = new DOMParser().parseFromString(
      strFromU8(unzipSync(saved)["word/document.xml"]),
      "text/xml",
    );
    expect(xml.getElementsByTagName("w:pStyle")[0].getAttribute("w:val")).toBe(
      mappedId,
    );
    expect(xml.getElementsByTagName("w:b")).toHaveLength(0);
    expect(xml.getElementsByTagName("w:sz")).toHaveLength(0);
    const facts = await openDocxFormatFacts(saved);
    expect(
      facts.snapshot.objects.find((object) => object.kind === "paragraph"),
    ).toMatchObject({
      style_id: mappedId,
      properties: { paragraph: { alignment: "center", keepNext: true } },
    });
    expect(
      facts.snapshot.objects.find((object) => object.kind === "run"),
    ).toMatchObject({ properties: { run: { bold: true, fontSizePt: 16 } } });
    target.surface.undo();
    expect(target.surface.save()).toEqual(afterImport);
    expect(
      strFromU8(unzipSync(target.surface.save())["word/styles.xml"]),
    ).toContain('w:styleId="TitlePasted"');
    expect(target.xml()).not.toContain("w:pStyle");
    target.surface.undo();
    expect(target.surface.save()).toEqual(original);
    expect(
      strFromU8(unzipSync(target.surface.save())["word/styles.xml"]),
    ).not.toContain('w:styleId="TitlePasted"');
  } finally {
    source.dispose();
    target.dispose();
  }
});

it("preserves every omitted direct frame attribute when changing only width", () => {
  const f = mounted(
    '<w:p><w:pPr><w:keepNext/><w:framePr w:w="10000" w:wrap="notBeside" w:hAnchor="page" w:vAnchor="text" w:hSpace="180" w:xAlign="center" w:vSpace="120" w:y="1"/></w:pPr><w:r><w:t>Framed title</w:t></w:r></w:p>',
  );
  try {
    const attributes = (xml: string) =>
      Object.fromEntries(
        [
          ...new DOMParser()
            .parseFromString(xml, "text/xml")
            .getElementsByTagName("w:framePr")[0].attributes,
        ].map((attribute) => [attribute.name, attribute.value]),
      );
    const before = f.xml();
    const original = attributes(before);
    expect(
      f.session.formatObject!(f.paragraphs[0].handle, 0, {
        kind: "frame",
        frame: { widthTwips: 9600 },
      }),
    ).toEqual({ ok: true, changed: true, revision: 1 });
    expect(attributes(f.xml())).toEqual({ ...original, "w:w": "9600" });
    expect(f.xml().replace('w:w="9600"', 'w:w="10000"')).toBe(before);
    f.surface.undo();
    expect(f.xml()).toBe(before);
  } finally {
    f.dispose();
  }
});

it("keeps omitted inherited frame attributes in the style cascade when overriding only width", async () => {
  const styles =
    '<w:style w:type="paragraph" w:styleId="Framed"><w:name w:val="Framed title"/><w:pPr><w:framePr w:w="10000" w:wrap="notBeside" w:hAnchor="page" w:vAnchor="text" w:hSpace="180" w:xAlign="center"/></w:pPr></w:style>';
  const f = mounted(
    '<w:p><w:pPr><w:pStyle w:val="Framed"/></w:pPr><w:r><w:t>Inherited frame</w:t></w:r></w:p>',
    "edit",
    styles,
  );
  try {
    const before = unzipSync(f.surface.save())["word/styles.xml"];
    const original = (
      await openDocxFormatFacts(f.surface.save())
    ).snapshot.objects.find((object) => object.kind === "paragraph")!.properties
      .paragraph;
    expect(
      f.session.formatObject!(f.paragraphs[0].handle, 0, {
        kind: "frame",
        frame: { widthTwips: 9600 },
      }),
    ).toMatchObject({ ok: true, revision: 1 });
    const saved = f.surface.save();
    const frame = new DOMParser()
      .parseFromString(f.xml(), "text/xml")
      .getElementsByTagName("w:framePr")[0];
    expect(
      [...frame.attributes].map((attribute) => [
        attribute.name,
        attribute.value,
      ]),
    ).toEqual([["w:w", "9600"]]);
    expect(unzipSync(saved)["word/styles.xml"]).toEqual(before);
    const effective = (await openDocxFormatFacts(saved)).snapshot.objects.find(
      (object) => object.kind === "paragraph",
    )!.properties.paragraph;
    expect(effective).toMatchObject({
      framePresent: true,
      frame: { ...(original as { frame: object }).frame, widthPt: 480 },
    });
  } finally {
    f.dispose();
  }
});

it.each([
  {
    sourceTypeface: "Resolved Source Theme Face",
    expected: "Resolved Source Theme Face",
  },
  { sourceTypeface: null, expected: "Stored fallback" },
])(
  "imports source theme font priority without replacing the host theme: %j",
  ({ sourceTypeface, expected }) => {
    const makeTheme = (face: string) =>
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Test"><a:majorFont><a:latin typeface="${face}"/></a:majorFont><a:minorFont><a:latin typeface="Body Face"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    const source = mounted(
      undefined,
      "edit",
      '<w:style w:type="paragraph" w:styleId="ThemeTitle"><w:name w:val="Theme title"/><w:rPr><w:rFonts w:ascii="Stored fallback" w:hAnsi="Stored high fallback" w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/></w:rPr></w:style>',
      sourceTypeface ? makeTheme(sourceTypeface) : "",
    );
    const target = mounted(undefined, "edit", "", makeTheme("Host Theme Face"));
    try {
      const before = unzipSync(target.surface.save());
      expect(
        target.session.importTemplateStyles!(
          source.surface.save(),
          ["ThemeTitle"],
          0,
        ),
      ).toMatchObject({
        ok: true,
        revision: 1,
        themePolicy: "literal-source-fonts-and-stored-color-fallbacks",
      });
      const saved = unzipSync(target.surface.save());
      const xml = new DOMParser().parseFromString(
        strFromU8(saved["word/styles.xml"]),
        "text/xml",
      );
      const fonts = xml.getElementsByTagName("w:rFonts")[0];
      expect(fonts.getAttribute("w:ascii")).toBe(expected);
      expect(fonts.getAttribute("w:hAnsi")).toBe(
        sourceTypeface ?? "Stored high fallback",
      );
      expect(fonts.hasAttribute("w:asciiTheme")).toBe(false);
      expect(fonts.hasAttribute("w:hAnsiTheme")).toBe(false);
      expect(saved["word/theme/theme1.xml"]).toEqual(
        before["word/theme/theme1.xml"],
      );
      expect(saved["word/document.xml"]).toEqual(before["word/document.xml"]);
      target.surface.undo();
      expect(unzipSync(target.surface.save())["word/theme/theme1.xml"]).toEqual(
        before["word/theme/theme1.xml"],
      );
    } finally {
      source.dispose();
      target.dispose();
    }
  },
);

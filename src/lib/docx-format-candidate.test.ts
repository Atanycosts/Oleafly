import { strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import type { DocxSource } from "@/lib/docx-workbench";
import { JournalWorkbenchError, type JournalProject } from "@/lib/journal-workbench";

const transport = vi.hoisted(() => ({
  journalRequest: vi.fn(),
  loadSource: vi.fn(),
}));

vi.mock("@/lib/journal-workbench", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/journal-workbench")>(),
  journalRequest: transport.journalRequest,
}));
vi.mock("@/lib/docx-workbench", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/docx-workbench")>(),
  loadDocxSource: transport.loadSource,
}));

import {
  adoptDocxFormatCandidate,
  createDocxFormatCandidateCopy,
  saveDocxFormatCandidateCopy,
  validateDocxFormatCandidateBytes,
} from "./docx-format-candidate";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${R}/image" Target="media/image1.png"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:styleId="Body">
    <w:name w:val="Body"/>
    <w:rPr><w:sz w:val="24"/></w:rPr>
  </w:style>
</w:styles>`;

const SOURCE_BODY = `
  <w:p w:rsidR="00112233">
    <w:pPr><w:spacing w:after="120" w:line="240"/></w:pPr>
    <w:bookmarkStart w:id="1" w:name="First"/>
    <w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r>
    <m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>
    <w:r><w:t xml:space="preserve"> formula </w:t></w:r>
    <w:r>
      <w:drawing>
        <wp:inline>
          <a:graphic><a:graphicData uri="picture">
            <a:blip r:embed="rId1"/>
          </a:graphicData></a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>
  <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`;

const CANDIDATE_BODY = `
  <w2:p w14:paraId="12345678" w:rsidR="44556677">
    <w2:pPr><w2:spacing w2:line="240" w2:after="240"/></w2:pPr>
    <w2:bookmarkStart w2:id="1" w2:name="First"/>
    <w2:r><w2:rPr><w2:b w2:val="0"/></w2:rPr><w2:t>Hello</w2:t></w2:r>
    <m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>
    <w2:r><w2:t xml:space="preserve"> formula </w2:t></w2:r>
    <w2:r>
      <w2:drawing>
        <wp:inline>
          <a:graphic><a:graphicData uri="picture">
            <a:blip r:embed="rId1"/>
          </a:graphicData></a:graphic>
        </wp:inline>
      </w2:drawing>
    </w2:r>
  </w2:p>
  <w2:sectPr><w2:pgSz w2:w="12240" w2:h="15840"/></w2:sectPr>`;

function documentXml(body: string, prefix = "w"): string {
  const declarations = prefix === "w"
    ? `xmlns:w="${W}"`
    : `xmlns:${prefix}="${W}" xmlns:w="${W}"`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${prefix}:document ${declarations} xmlns:m="${M}" xmlns:a="${A}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <${prefix}:body>${body}</${prefix}:body>
</${prefix}:document>`;
}

function packageBytes(options: {
  body?: string;
  prefix?: string;
  styles?: string;
  image?: Uint8Array;
  rels?: string;
  core?: string;
  parts?: Record<string, string>;
} = {}): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    "word/document.xml": strToU8(documentXml(options.body ?? SOURCE_BODY, options.prefix)),
    "word/styles.xml": strToU8(options.styles ?? STYLES),
    "word/_rels/document.xml.rels": strToU8(options.rels ?? RELS),
    "word/media/image1.png": options.image ?? Uint8Array.from([137, 80, 78, 71, 1, 2, 3]),
  };
  if (options.core) entries["docProps/core.xml"] = strToU8(options.core);
  for (const [name, xml] of Object.entries(options.parts ?? {})) entries[name] = strToU8(xml);
  return zipSync(entries);
}

const SOURCE = packageBytes();
const FORMAT_ONLY = packageBytes({
  body: CANDIDATE_BODY,
  prefix: "w2",
});

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function source(bytes = SOURCE, sourceSha256 = "a".repeat(64)): Promise<DocxSource> {
  return {
    project_id: "manuscript-project",
    baseline_id: "baseline-source",
    source_sha256: sourceSha256,
    filename: "paper.docx",
    bytes,
  };
}

function project(overrides: Partial<JournalProject> = {}): JournalProject {
  return {
    project_id: "candidate-project",
    name: "Format candidate",
    baseline_id: "baseline-candidate",
    binding: null,
    latest_check: null,
    role: "format_candidate",
    ...overrides,
  };
}

function retainedSource(
  projectId: string,
  baselineId: string,
  bytes: Uint8Array,
  sourceSha256: string,
): DocxSource {
  return {
    project_id: projectId,
    baseline_id: baselineId,
    source_sha256: sourceSha256,
    filename: "paper.docx",
    bytes,
  };
}

beforeEach(() => {
  transport.journalRequest.mockReset();
  transport.loadSource.mockReset();
});

describe("pure-format candidate bytes", () => {
  it("accepts supported direct formatting, prefix, attribute-order and insignificant XML changes", async () => {
    const result = await validateDocxFormatCandidateBytes(SOURCE, FORMAT_ONLY);

    expect(result).toMatchObject({
      status: "accepted",
      issues: [],
    });
    expect(result.changedParts).toEqual(["/word/document.xml"]);
    expect(result.sourceSha256).toBe(await digest(SOURCE));
    expect(result.candidateSha256).toBe(await digest(FORMAT_ONLY));
  });

  it.each([
    ["word/styles.xml", STYLES, STYLES.replace("<w:rPr>", '<w:pPr><w:keepNext/><w:pageBreakBefore/></w:pPr><w:rPr>')],
    ["word/settings.xml", `<w:settings xmlns:w="${W}"/>`, `<w:settings xmlns:w="${W}"><w:mirrorMargins/></w:settings>`],
    ["word/numbering.xml", `<w:numbering xmlns:w="${W}"/>`, `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"/></w:numbering>`],
    ["word/theme/theme1.xml", `<a:theme xmlns:a="${A}" name="Office"/>`, `<a:theme xmlns:a="${A}" name="Other"/>`],
  ])("does not let changes to %s bypass the story-level comparison", async (part, before, after) => {
    const result = await validateDocxFormatCandidateBytes(
      packageBytes({ parts: { [part]: before } }),
      packageBytes({ body: CANDIDATE_BODY, prefix: "w2", parts: { [part]: after } }),
    );
    expect(result).toMatchObject({ status: "rejected", issues: [
      expect.objectContaining({ code: "content_structure_changed", part: `/${part}` }),
    ] });
  });

  it.each([
    ["word/header1.xml", "hdr", ""],
    ["word/footer1.xml", "ftr", ""],
    ["word/footnotes.xml", "footnotes", "footnote"],
    ["word/endnotes.xml", "endnotes", "endnote"],
    ["word/comments.xml", "comments", "comment"],
  ])("protects formatting in the read-only story %s", async (part, root, entry) => {
    const xml = (alignment: string) => {
      const p = `<w:p><w:pPr><w:jc w:val="${alignment}"/></w:pPr><w:r><w:t>Text</w:t></w:r></w:p>`;
      return `<w:${root} xmlns:w="${W}">${entry ? `<w:${entry} w:id="1">${p}</w:${entry}>` : p}</w:${root}>`;
    };
    const result = await validateDocxFormatCandidateBytes(
      packageBytes({ parts: { [part]: xml("left") } }),
      packageBytes({ body: CANDIDATE_BODY, prefix: "w2", parts: { [part]: xml("center") } }),
    );
    expect(result).toMatchObject({ status: "rejected", issues: [
      expect.objectContaining({ code: "content_structure_changed", part: `/${part}` }),
    ] });
  });

  it("accepts formatting-only property containers added where the source had none", async () => {
    const section = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';
    const result = await validateDocxFormatCandidateBytes(
      packageBytes({ body: `<w:p><w:r><w:t>Hello</w:t></w:r></w:p>${section}` }),
      packageBytes({
        body: `<w:p><w:pPr w:rsidR="00112233"><w:spacing w:after="120"/><w:jc w:val="center"/></w:pPr>` +
          `<w:r><w:rPr w:rsidRPr="00112233"><w:b/><w:sz w:val="24"/></w:rPr><w:t>Hello</w:t></w:r></w:p>${section}`,
      }),
    );

    expect(result).toMatchObject({ status: "accepted", issues: [] });
  });

  it("allows supported font and paragraph edits while retaining section, table-free flow and revision semantics", async () => {
    const body = (spacingAfter: number, indent: number, alignment: string, font: string, emphasis: string) => `
      <w:p>
        <w:pPr>
          <w:pStyle w:val="Body"/>
          <w:keepNext/>
          <w:framePr w:dropCap="drop"/>
          <w:tabs><w:tab w:val="right" w:pos="8306"/></w:tabs>
          <w:spacing w:after="${spacingAfter}"/>
          <w:ind w:left="${indent}"/>
          <w:jc w:val="${alignment}"/>
          <w:rPr><w:color w:val="445566"/></w:rPr>
          <w:pPrChange w:id="1" w:author="Reviewer"><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrChange>
        </w:pPr>
        <w:r>
          <w:rPr>
            ${emphasis}
            <w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>
            <w:color w:val="445566"/>
            <w:rPrChange w:id="2" w:author="Reviewer"><w:rPr><w:i/></w:rPr></w:rPrChange>
          </w:rPr>
          <w:t>Hello</w:t>
        </w:r>
      </w:p>
      <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`;
    const result = await validateDocxFormatCandidateBytes(
      packageBytes({ body: body(120, 0, "left", "Arial", "") }),
      packageBytes({ body: body(240, 360, "center", "Times New Roman", "<w:b/><w:i/><w:sz w:val=\"24\"/>") }),
    );

    expect(result).toMatchObject({ status: "accepted", issues: [] });
  });

  it("rejects page geometry changes in the body and in nested sections", async () => {
    const sectioned = (width: number) => `
      <w:p><w:pPr><w:sectPr><w:pgSz w:w="${width}" w:h="15840"/><w:cols w:num="1"/></w:sectPr></w:pPr>
        <w:r><w:t>Sectioned</w:t></w:r></w:p>
      ${SOURCE_BODY}`;
    for (const [before, after] of [
      [SOURCE_BODY, SOURCE_BODY.replace('w:w="12240" w:h="15840"', 'w:w="11906" w:h="16838"')],
      [SOURCE_BODY, SOURCE_BODY.replace('w:h="15840"', 'w:h="15840" w:orient="landscape"')],
      [sectioned(12240), sectioned(11906)],
    ]) {
      const result = await validateDocxFormatCandidateBytes(packageBytes({ body: before }), packageBytes({ body: after }));
      expect(result.status).toBe("rejected");
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "content_structure_changed",
        part: "/word/document.xml",
      }));
    }
  });

  it.each([
    ["line spacing", SOURCE_BODY, CANDIDATE_BODY.replace('w2:line="240"', 'w2:line="300"'), "w2"],
    ["line rule", SOURCE_BODY, CANDIDATE_BODY.replace('w2:line="240"', 'w2:line="240" w2:lineRule="exact"'), "w2"],
    ["automatic spacing", SOURCE_BODY, CANDIDATE_BODY.replace('w2:after="240"', 'w2:after="240" w2:afterAutospacing="1"'), "w2"],
    ["character indentation",
      '<w:p><w:pPr><w:ind w:left="120" w:rightChars="100"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:ind w:left="240"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p>', "w"],
    ["complex-script font",
      '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Times New Roman"/></w:rPr><w:t>Hello</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:cs="Arial"/></w:rPr><w:t>Hello</w:t></w:r></w:p>', "w"],
    ["complex-script emphasis",
      '<w:p><w:r><w:rPr><w:bCs/></w:rPr><w:t>Hello</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:b/><w:bCs w:val="0"/></w:rPr><w:t>Hello</w:t></w:r></w:p>', "w"],
  ])("rejects a change to %s alongside supported formatting", async (_field, before, after, prefix) => {
    const result = await validateDocxFormatCandidateBytes(packageBytes({ body: before }), packageBytes({ body: after, prefix }));
    expect(result).toMatchObject({ status: "rejected", issues: [
      expect.objectContaining({ code: "content_structure_changed", part: "/word/document.xml" }),
    ] });
  });

  it("protects the space attribute that keeps leading or trailing text whitespace", async () => {
    const result = await validateDocxFormatCandidateBytes(SOURCE,
      packageBytes({ body: SOURCE_BODY.replace(' xml:space="preserve"', "") }));
    expect(result.status).toBe("rejected");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "text_changed", part: "/word/document.xml" }),
      expect.objectContaining({ code: "content_structure_changed", part: "/word/document.xml" }),
    ]));
  });

  it("protects the paragraph identity used by threaded Word comments", async () => {
    const w14 = "http://schemas.microsoft.com/office/word/2010/wordml";
    const w15 = "http://schemas.microsoft.com/office/word/2012/wordml";
    const comments = `<w:comments xmlns:w="${W}" xmlns:w14="${w14}"><w:comment w:id="1">` +
      `<w:p w14:paraId="12345678"><w:r><w:t>Reviewer note</w:t></w:r></w:p></w:comment></w:comments>`;
    const parts = {
      "word/comments.xml": comments,
      "word/commentsExtended.xml": `<w15:commentsEx xmlns:w15="${w15}"><w15:commentEx w15:paraId="12345678"/></w15:commentsEx>`,
    };
    const result = await validateDocxFormatCandidateBytes(packageBytes({ parts }), packageBytes({
      parts: { ...parts, "word/comments.xml": comments.replace("12345678", "12345679") },
    }));
    expect(result).toMatchObject({ status: "rejected", issues: [
      expect.objectContaining({ code: "content_structure_changed", part: "/word/comments.xml" }),
    ] });
  });

  it("preserves compatibility branch namespaces, not the spelling of their prefixes", async () => {
    const uri = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing";
    const story = (prefix: string, namespace: string) =>
      `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
      `xmlns:${prefix}="${namespace}"><mc:Choice Requires="${prefix}"><w:p><w:r><w:t>Choice</w:t></w:r></w:p>` +
      `</mc:Choice><mc:Fallback><w:p><w:r><w:t>Fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>`;
    const source = packageBytes({ body: story("wp14", uri) + SOURCE_BODY });
    const alias = packageBytes({ body: story("alias", uri) + SOURCE_BODY });
    const different = packageBytes({ body: story("wp14", "urn:other") + SOURCE_BODY });

    expect(await validateDocxFormatCandidateBytes(source, alias)).toMatchObject({ status: "accepted" });
    expect(await validateDocxFormatCandidateBytes(source, different)).toMatchObject({ status: "rejected" });
  });

  it("resolves compatibility namespaces inherited by protected row properties", async () => {
    const supported = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing";
    const table = (prefix: string, namespace: string) =>
      `<w:tbl><w:tr xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:${prefix}="${namespace}">` +
      `<w:trPr><mc:AlternateContent><mc:Choice Requires="${prefix}"><w:trHeight w:val="240"/></mc:Choice>` +
      `<mc:Fallback><w:trHeight w:val="480"/></mc:Fallback></mc:AlternateContent></w:trPr>` +
      '<w:tc><w:p/></w:tc></w:tr></w:tbl>';
    const original = packageBytes({ body: table("wp14", supported) });

    expect(await validateDocxFormatCandidateBytes(original, packageBytes({ body: table("alias", supported) })))
      .toMatchObject({ status: "accepted" });
    expect(await validateDocxFormatCandidateBytes(original, packageBytes({ body: table("wp14", "urn:other") })))
      .toMatchObject({ status: "rejected", issues: [expect.objectContaining({ code: "row_properties_changed" })] });
  });

  it("rejects table grid, table property, cell property and cell formatting changes", async () => {
    const table = `
      <w:tbl>
        <w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLook w:firstRow="1"/></w:tblPr>
        <w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid>
        <w:tr>
          <w:trPr><w:trHeight w:val="240"/></w:trPr>
          <w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:gridSpan w:val="1"/></w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Header</w:t></w:r></w:p></w:tc>
          <w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>`;
    const before = table + SOURCE_BODY;
    for (const after of [
      table.replace('<w:gridCol w:w="3000"/>', '<w:gridCol w:w="3600"/>') + SOURCE_BODY,
      table.replace('w:w="9000"', 'w:w="8400"') + SOURCE_BODY,
      table.replace('<w:gridSpan w:val="1"/>', '<w:gridSpan w:val="2"/>') + SOURCE_BODY,
      table.replace("<w:b/>", '<w:b w:val="0"/>') + SOURCE_BODY,
      table.replace(/<w:tr>.*?<\/w:tr>/su, "") + SOURCE_BODY,
    ]) {
      const result = await validateDocxFormatCandidateBytes(packageBytes({ body: before }), packageBytes({ body: after }));
      expect(result.status).toBe("rejected");
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "content_structure_changed",
        part: "/word/document.xml",
      }));
    }
  });

  it.each([
    ["frame", '<w:framePr w:dropCap="drop"/>', ""],
    ["tab stops", '<w:tabs><w:tab w:val="right" w:pos="8306"/></w:tabs>', ""],
    ["keep-next", "<w:keepNext/>", '<w:keepNext w:val="0"/>'],
    ["keep-lines", "<w:keepLines/>", ""],
    ["widow control", '<w:widowControl w:val="0"/>', '<w:widowControl w:val="1"/>'],
    ["page break before", "<w:pageBreakBefore/>", ""],
    ["paragraph style", '<w:pStyle w:val="Body"/>', '<w:pStyle w:val="Other"/>'],
    ["numbering", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>', ""],
    ["outline level", '<w:outlineLvl w:val="1"/>', '<w:outlineLvl w:val="2"/>'],
  ])("rejects a paragraph semantic change to %s", async (_label, beforeLayout, afterLayout) => {
    const body = (layout: string, alignment: string) =>
      `<w:p><w:pPr>${layout}<w:jc w:val="${alignment}"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p>`;
    const result = await validateDocxFormatCandidateBytes(
      packageBytes({ body: body(beforeLayout, "left") }),
      packageBytes({ body: body(afterLayout, "center") }),
    );

    expect(result.status).toBe("rejected");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "content_structure_changed" }));
  });

  it("rejects edits to tracked paragraph and run formatting history", async () => {
    const paragraphRevision = (previousSpacing: number) => `
      <w:p>
        <w:pPr>
          <w:pPrChange w:id="1" w:author="Reviewer"><w:pPr><w:spacing w:after="${previousSpacing}"/></w:pPr></w:pPrChange>
          <w:jc w:val="left"/>
        </w:pPr>
        <w:r><w:t>Tracked paragraph</w:t></w:r>
      </w:p>`;
    const runRevision = (currentFont: string, previousFont: string) => `
      <w:p>
        <w:r>
          <w:rPr>
            ${currentFont}
            <w:rPrChange w:id="2" w:author="Reviewer"><w:rPr>${previousFont}</w:rPr></w:rPrChange>
          </w:rPr>
          <w:t>Tracked run</w:t>
        </w:r>
      </w:p>`;
    for (const [before, after] of [
      [`${paragraphRevision(120)}<w:p><w:pPr><w:jc w:val="left"/></w:pPr></w:p>`,
        `${paragraphRevision(240)}<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>`],
      [runRevision("<w:b/>", "<w:i/>"), runRevision('<w:b/><w:sz w:val="24"/>', "<w:b/>")],
    ]) {
      const result = await validateDocxFormatCandidateBytes(packageBytes({ body: before }), packageBytes({ body: after }));
      expect(result.status).toBe("rejected");
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "content_structure_changed" }));
    }
  });

  it("rejects changed document text", async () => {
    const changed = packageBytes({ body: SOURCE_BODY.replace("Hello", "Hallo") });
    const result = await validateDocxFormatCandidateBytes(SOURCE, changed);

    expect(result.status).toBe("rejected");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "text_changed", part: "/word/document.xml" }),
    ]));
  });

  it("rejects changed formulas even when the visible text is otherwise intact", async () => {
    const changed = packageBytes({ body: SOURCE_BODY.replace("x+1", "x+2") });
    const result = await validateDocxFormatCandidateBytes(SOURCE, changed);

    expect(result.status).toBe("rejected");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "formula_changed", part: "/word/document.xml" }),
    ]));
  });

  it("rejects changed media bytes and drawing references", async () => {
    const changedImage = packageBytes({ image: Uint8Array.from([137, 80, 78, 71, 9, 9, 9]) });
    const imageResult = await validateDocxFormatCandidateBytes(SOURCE, changedImage);
    expect(imageResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "image_changed", part: "/word/media/image1.png" }),
    ]));

    const changedDrawing = packageBytes({
      body: SOURCE_BODY.replace('r:embed="rId1"', 'r:embed="rId2"'),
    });
    const drawingResult = await validateDocxFormatCandidateBytes(SOURCE, changedDrawing);
    expect(drawingResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "image_changed", part: "/word/document.xml" }),
    ]));
  });

  it("rejects structural and non-format XML changes", async () => {
    const bookmark = packageBytes({ body: SOURCE_BODY.replace('w:id="1"', 'w:id="2"') });
    expect((await validateDocxFormatCandidateBytes(SOURCE, bookmark)).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "content_structure_changed", part: "/word/document.xml" }),
    ]));

    const coreSource = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Paper</dc:title></cp:coreProperties>';
    const coreCandidate = coreSource.replace("Paper", "Other");
    const result = await validateDocxFormatCandidateBytes(
      packageBytes({ core: coreSource }),
      packageBytes({ core: coreCandidate }),
    );
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "content_structure_changed", part: "/docProps/core.xml" }),
    ]));
  });

  it("allows turning on absent pagination flags but never rewriting existing row properties", async () => {
    const table = (rowProperties: string) => `<w:tbl><w:tr>${rowProperties}<w:tc><w:p/></w:tc></w:tr></w:tbl>`;
    const source = (properties: string) => packageBytes({ body: table(properties) + SOURCE_BODY });
    const original = '<w:trPr><w:trHeight w:val="238"/><w:jc w:val="center"/></w:trPr>';
    const added = '<w:trPr><w:cantSplit/><w:trHeight w:val="238"/><w:tblHeader/><w:jc w:val="center"/></w:trPr>';
    expect((await validateDocxFormatCandidateBytes(source(original), source(added))).status).toBe("accepted");
    expect((await validateDocxFormatCandidateBytes(source(""), source("<w:trPr><w:cantSplit/></w:trPr>"))).status).toBe("accepted");
    const optedOut = original.replace("<w:trPr>", '<w:trPr><w:cantSplit w:val="false"/>');
    for (const [before, after] of [
      [added, original],
      [optedOut, added],
      [added, added.replace('<w:jc w:val="center"/>', "")],
      [original, original.replace("</w:trPr>", '<w:tblHeader w:val="0"/></w:trPr>')],
      [original, original.replace("</w:trPr>", '<w:cantSplit w:val="0"/></w:trPr>')],
      [original, original.replace("</w:trPr>", "<w:hidden/></w:trPr>")],
    ]) {
      const result = await validateDocxFormatCandidateBytes(source(before), source(after));
      expect(result.status).toBe("rejected");
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "row_properties_changed" }));
    }
  });

  it("accepts cosmetic relationship XML spelling but rejects package entries and target changes", async () => {
    const cosmeticRels = RELS.replace(
      `<Relationship Id="rId1" Type="${R}/image" Target="media/image1.png"/>`,
      `<Relationship Target="media/image1.png" Type="${R}/image" Id="rId1"/>`,
    );
    expect((await validateDocxFormatCandidateBytes(SOURCE, packageBytes({ rels: cosmeticRels }))).status)
      .toBe("accepted");

    const changedTarget = packageBytes({ rels: RELS.replace("media/image1.png", "media/image2.png") });
    expect((await validateDocxFormatCandidateBytes(SOURCE, changedTarget)).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "content_structure_changed", part: "/word/_rels/document.xml.rels" }),
    ]));

    const entries = {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
      "word/document.xml": strToU8(documentXml(SOURCE_BODY)),
      "word/styles.xml": strToU8(STYLES),
      "word/_rels/document.xml.rels": strToU8(RELS),
      "word/media/image1.png": Uint8Array.from([137, 80, 78, 71, 1, 2, 3]),
      "word/media/image2.png": Uint8Array.from([1]),
    };
    const added = await validateDocxFormatCandidateBytes(SOURCE, zipSync(entries));
    expect(added.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "package_entry_added", part: "/word/media/image2.png" }),
      expect.objectContaining({ code: "image_changed", part: "/word/media/image2.png" }),
    ]));
  });

  it("rejects a truncated archive and unreadable changed XML", async () => {
    await expect(validateDocxFormatCandidateBytes(SOURCE, SOURCE.slice(0, 20))).resolves.toMatchObject({
      status: "rejected", changedParts: [], issues: [{ code: "invalid_docx" }],
    });

    for (const invalidXml of [strToU8(`<w:styles xmlns:w="${W}">`), Uint8Array.of(0xff)]) {
      const entries = unzipSync(SOURCE);
      entries["word/styles.xml"] = invalidXml;
      await expect(validateDocxFormatCandidateBytes(SOURCE, zipSync(entries))).resolves.toMatchObject({
        status: "rejected", changedParts: ["/word/styles.xml"],
        issues: [{ code: "xml_unreadable", part: "/word/styles.xml" }],
      });
    }
  });

  it("protects media and other package parts even when body XML is identical", async () => {
    const entries = unzipSync(SOURCE);
    entries["word/embeddings/oleObject1.bin"] = Uint8Array.of(1);
    const before = zipSync(entries);
    delete entries["word/media/image1.png"];
    delete entries["word/styles.xml"];
    entries["word/embeddings/oleObject1.bin"] = Uint8Array.of(2);
    entries["word/styles-backup.xml"] = strToU8(STYLES);

    const result = await validateDocxFormatCandidateBytes(before, zipSync(entries));
    expect(result).toMatchObject({ status: "rejected", changedParts: ["/word/embeddings/oleObject1.bin"] });
    expect(result.issues).toHaveLength(5);
    expect(result.issues.map(({ code, part }) => [code, part])).toEqual(expect.arrayContaining([
      ["package_entry_removed", "/word/styles.xml"],
      ["package_entry_removed", "/word/media/image1.png"],
      ["image_changed", "/word/media/image1.png"],
      ["package_entry_added", "/word/styles-backup.xml"],
      ["binary_part_changed", "/word/embeddings/oleObject1.bin"],
    ]));
  });

  it.each([
    ["header1.xml", "hdr", ""],
    ["footer1.xml", "ftr", ""],
    ["footnotes.xml", "footnotes", "footnote"],
  ])("keeps formatting outside the manuscript body read-only (%s)", async (part, root, wrapper) => {
    const story = (size: number) => {
      const paragraph = `<w:p><w:r><w:rPr><w:sz w:val="${size}"/></w:rPr><w:t>Retained story</w:t></w:r></w:p>`;
      return `<w:${root} xmlns:w="${W}">${wrapper ? `<w:${wrapper} w:id="1">${paragraph}</w:${wrapper}>` : paragraph}</w:${root}>`;
    };
    await expect(validateDocxFormatCandidateBytes(
      packageBytes({ parts: { [`word/${part}`]: story(24) } }),
      packageBytes({ parts: { [`word/${part}`]: story(22) } }),
    )).resolves.toMatchObject({ status: "rejected", issues: [
      { code: "content_structure_changed", part: `/word/${part}` },
    ] });
  });
});

describe("independent candidate copy", () => {
  it("imports frozen start bytes once and verifies the retained copy", async () => {
    const captured = await source();
    const created = project();
    transport.journalRequest.mockResolvedValue(created);
    transport.loadSource.mockResolvedValue(retainedSource(
      created.project_id,
      created.baseline_id,
      captured.bytes,
      await digest(captured.bytes),
    ));

    await expect(createDocxFormatCandidateCopy("Format candidate", captured)).resolves.toEqual(created);
    expect(transport.journalRequest).toHaveBeenCalledExactlyOnceWith("/api/projects", {
      name: "Format candidate",
      filename: captured.filename,
      content_base64: bytesToBase64(captured.bytes),
      role: "format_candidate",
    });
    expect(transport.loadSource).toHaveBeenCalledExactlyOnceWith(created.project_id, created.baseline_id);
  });

  it("rejects a project that Workbench did not retain in candidate isolation", async () => {
    const captured = await source();
    transport.journalRequest.mockResolvedValue(project({ role: "manuscript" }));

    await expect(createDocxFormatCandidateCopy("Format candidate", captured))
      .rejects.toThrow("did not create an isolated format candidate");
    expect(transport.loadSource).not.toHaveBeenCalled();
  });

  it("rejects the imported copy if Workbench did not retain the frozen bytes", async () => {
    const captured = await source();
    const created = project();
    transport.journalRequest.mockResolvedValue(created);
    transport.loadSource.mockResolvedValue(retainedSource(
      created.project_id, created.baseline_id, FORMAT_ONLY, await digest(FORMAT_ONLY),
    ));

    await expect(createDocxFormatCandidateCopy("Format candidate", captured))
      .rejects.toThrow("did not retain the frozen start bytes");
  });

  it("saves each round into the same project with compare-and-swap and exact readback", async () => {
    const captured = await source();
    const candidate = FORMAT_ONLY;
    const candidateSha256 = await digest(candidate);
    const current = project({ baseline_id: "baseline-round-1" });
    transport.journalRequest.mockResolvedValue({
      status: "APPLIED",
      result_baseline_id: "baseline-round-2",
    });
    transport.loadSource.mockResolvedValue(retainedSource(
      current.project_id,
      "baseline-round-2",
      candidate,
      candidateSha256,
    ));

    const saved = await saveDocxFormatCandidateCopy(current, captured, candidate);

    expect(saved).toEqual({ ...current, baseline_id: "baseline-round-2" });
    expect(transport.journalRequest).toHaveBeenCalledExactlyOnceWith("/api/baseline", {
      project_id: current.project_id,
      expected_baseline_id: "baseline-round-1",
      filename: captured.filename,
      content_base64: bytesToBase64(candidate),
      request_id: expect.stringMatching(/^docx-format-/),
      reason: `Saved isolated DOCX format candidate ${candidateSha256.slice(0, 12)} from frozen source ${captured.source_sha256.slice(0, 12)}.`,
    });
    expect(transport.loadSource).toHaveBeenCalledExactlyOnceWith(current.project_id, "baseline-round-2");
  });

  it("retries an uncertain round with the same fixed request and bytes", async () => {
    const captured = await source();
    const candidate = FORMAT_ONLY;
    const current = project({ baseline_id: "baseline-round-1" });
    transport.journalRequest
      .mockRejectedValueOnce(new Error("connection lost after dispatch"))
      .mockResolvedValueOnce({ status: "APPLIED", result_baseline_id: "baseline-round-2" });
    transport.loadSource.mockResolvedValue(retainedSource(
      current.project_id,
      "baseline-round-2",
      candidate,
      await digest(candidate),
    ));

    await expect(saveDocxFormatCandidateCopy(current, captured, candidate)).rejects.toThrow("connection lost");
    await saveDocxFormatCandidateCopy(current, captured, candidate);

    expect(transport.journalRequest.mock.calls[0]?.[1]).toEqual(transport.journalRequest.mock.calls[1]?.[1]);
  });

  it("does not report a saved round when readback omits the requested edit", async () => {
    const captured = await source();
    const current = project();
    transport.journalRequest.mockResolvedValue({ status: "APPLIED", result_baseline_id: "round-2" });
    transport.loadSource.mockResolvedValue(retainedSource(
      current.project_id, "round-2", SOURCE, await digest(SOURCE),
    ));

    await expect(saveDocxFormatCandidateCopy(current, captured, FORMAT_ONLY))
      .rejects.toThrow("did not retain the exact saved bytes");
    expect(transport.loadSource).toHaveBeenCalledExactlyOnceWith(current.project_id, "round-2");
  });

  it("rejects text, formula and media changes before Workbench receives a round", async () => {
    const captured = await source();
    transport.loadSource.mockResolvedValue(retainedSource(
      "candidate-project",
      "baseline-candidate",
      SOURCE,
      await digest(SOURCE),
    ));
    for (const bytes of [
      packageBytes({ body: SOURCE_BODY.replace("Hello", "Changed") }),
      packageBytes({ body: SOURCE_BODY.replace("x+1", "x+2") }),
      packageBytes({ image: Uint8Array.from([9, 9, 9]) }),
    ]) {
      await expect(saveDocxFormatCandidateCopy(project(), captured, bytes))
        .rejects.toThrow("changed protected content");
    }
    expect(transport.journalRequest).not.toHaveBeenCalled();
  });

  it("refuses to save a round into an ordinary manuscript project", async () => {
    const captured = await source();
    await expect(saveDocxFormatCandidateCopy(
      project({ role: "manuscript" }),
      captured,
      FORMAT_ONLY,
    )).rejects.toThrow("isolated format candidate project");
    expect(transport.journalRequest).not.toHaveBeenCalled();
    expect(transport.loadSource).not.toHaveBeenCalled();
  });
});

describe("candidate adoption", () => {
  const expectedBinding = { binding_id: "original-binding", baseline_id: "baseline-source", world_version_id: "old-world" };
  const checkedBinding = { binding_id: "candidate-binding", baseline_id: "baseline-final", world_version_id: "candidate-world" };
  const adoptedBinding = { ...checkedBinding, binding_id: "new-binding", baseline_id: "baseline-adopted" };
  const receipt = { result_baseline_id: "baseline-adopted", binding: adoptedBinding };
  const finalCandidate = project({ baseline_id: "baseline-final", binding: checkedBinding });
  const review = async (targetBindingId: string | null = expectedBinding.binding_id, candidateBytes = FORMAT_ONLY) => ({
    target_binding_id: targetBindingId,
    input_source_sha256: await digest(SOURCE),
    candidate_project_id: finalCandidate.project_id,
    candidate_baseline_id: finalCandidate.baseline_id,
    candidate_binding_id: checkedBinding.binding_id,
    candidate_check_id: "check-final",
    candidate_source_sha256: await digest(candidateBytes),
  });

  it("rechecks content, uses captured-baseline CAS and returns the exact adopted source", async () => {
    const captured = await source();
    const candidate = project({ baseline_id: "baseline-final", binding: checkedBinding });
    const candidateSha256 = await digest(FORMAT_ONLY);
    transport.journalRequest.mockResolvedValue(receipt);
    transport.loadSource.mockImplementation(async (projectId: string, baselineId: string) => {
      if (projectId === candidate.project_id && baselineId === candidate.baseline_id) {
        return retainedSource(projectId, baselineId, FORMAT_ONLY, candidateSha256);
      }
      if (projectId === captured.project_id && baselineId === "baseline-adopted") {
        return retainedSource(projectId, baselineId, FORMAT_ONLY, candidateSha256);
      }
      throw new Error("Unexpected source request");
    });

    const adopted = await adoptDocxFormatCandidate(captured, await review());

    expect(adopted).toEqual({
      source: retainedSource(captured.project_id, "baseline-adopted", FORMAT_ONLY, candidateSha256),
      binding: adoptedBinding,
    });
    expect(transport.journalRequest).toHaveBeenCalledExactlyOnceWith("/api/template-candidate-adopt", {
      project_id: captured.project_id,
      expected_baseline_id: captured.baseline_id,
      expected_binding_id: expectedBinding.binding_id,
      candidate_project_id: candidate.project_id,
      candidate_baseline_id: candidate.baseline_id,
      expected_candidate_binding_id: checkedBinding.binding_id,
      candidate_source_sha256: candidateSha256,
      candidate_check_id: "check-final",
      request_id: expect.stringMatching(/^docx-format-/),
    });
  });

  it("refuses a candidate project that is no longer on the selected baseline", async () => {
    const captured = await source();
    const candidate = project({ baseline_id: "baseline-final", binding: checkedBinding });
    transport.journalRequest.mockRejectedValue(new JournalWorkbenchError({ error: "Candidate changed", code: "baseline_conflict" }));
    transport.loadSource.mockResolvedValue(retainedSource(candidate.project_id, candidate.baseline_id, FORMAT_ONLY, await digest(FORMAT_ONLY)));

    await expect(adoptDocxFormatCandidate(captured, await review()))
      .rejects.toMatchObject({ detail: { code: "baseline_conflict" } });
    expect(transport.loadSource).toHaveBeenCalledTimes(1);
  });

  it("refuses retained candidate bytes that mutate protected content", async () => {
    const captured = await source();
    const candidate = project({ baseline_id: "baseline-final", binding: checkedBinding });
    const changed = packageBytes({ body: CANDIDATE_BODY.replace("Hello", "Changed"), prefix: "w2" });
    transport.loadSource.mockResolvedValue(retainedSource(
      candidate.project_id,
      candidate.baseline_id,
      changed,
      await digest(changed),
    ));

    await expect(adoptDocxFormatCandidate(captured, await review(expectedBinding.binding_id, changed)))
      .rejects.toThrow("changed protected content");
    expect(transport.journalRequest).not.toHaveBeenCalled();
  });

  it("does not adopt different format-only bytes from the ones reviewed", async () => {
    const captured = await source();
    transport.loadSource.mockResolvedValue(retainedSource(finalCandidate.project_id, finalCandidate.baseline_id, SOURCE, await digest(SOURCE)));
    await expect(adoptDocxFormatCandidate(captured, await review())).rejects.toThrow("retained candidate changed");
    expect(transport.journalRequest).not.toHaveBeenCalled();
  });

  it("rejects an adopted readback that is format-valid but not the exact candidate bytes", async () => {
    const captured = await source();
    const candidate = project({ baseline_id: "baseline-final", binding: checkedBinding });
    const substituted = packageBytes({
      body: CANDIDATE_BODY.replace('w2:after="240"', 'w2:after="360"'),
      prefix: "w2",
    });
    transport.journalRequest.mockResolvedValue(receipt);
    transport.loadSource.mockImplementation(async (projectId: string, baselineId: string) => {
      if (projectId === candidate.project_id && baselineId === candidate.baseline_id) {
        return retainedSource(projectId, baselineId, FORMAT_ONLY, await digest(FORMAT_ONLY));
      }
      if (projectId === captured.project_id && baselineId === "baseline-adopted") {
        return retainedSource(projectId, baselineId, substituted, await digest(substituted));
      }
      throw new Error("Unexpected source request");
    });

    await expect(adoptDocxFormatCandidate(captured, await review()))
      .rejects.toThrow("did not retain the exact adopted candidate bytes");
    expect(transport.journalRequest.mock.calls.map(([path]) => path)).toEqual(["/api/template-candidate-adopt"]);
  });

  it("reuses the fixed adoption request after an uncertain response", async () => {
    const captured = await source();
    const candidateSha256 = await digest(FORMAT_ONLY);
    transport.journalRequest
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(receipt);
    transport.loadSource.mockImplementation(async (projectId: string, baselineId: string) =>
      retainedSource(projectId, baselineId, FORMAT_ONLY, candidateSha256));

    const pending = await review(null);
    await expect(adoptDocxFormatCandidate(captured, pending)).rejects.toThrow("response lost");
    await adoptDocxFormatCandidate(captured, pending);

    const payloads = transport.journalRequest.mock.calls
      .filter(([path]) => path === "/api/template-candidate-adopt")
      .map(([, payload]) => payload);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
  });
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDocxFormatFacts, type DocxFormatObject, type DocxFormatProperties } from "./docx-format";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function docx(body: string, styles = "", extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8(`<Relationships xmlns="${REL}"><Relationship Id="doc" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<Relationships xmlns="${REL}"><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="theme" Type="${R}/theme" Target="theme/theme1.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<w:document xmlns:w="${W}" xmlns:x="urn:custom"><w:body>${body}</w:body></w:document>`),
    "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}">${styles}</w:styles>`),
    "word/theme/theme1.xml": strToU8(`<a:theme xmlns:a="${A}"><a:themeElements><a:fontScheme name="Test"><a:majorFont><a:latin typeface="Theme Head"/><a:ea typeface="Theme Head CJK"/><a:cs typeface="Theme Complex"/></a:majorFont><a:minorFont><a:latin typeface="Theme Body"/><a:ea typeface="Theme Body CJK"/><a:cs typeface="Theme Body Complex"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`),
    ...extra,
  });
}
function p(text: string, style = "", directRun = "", pPr = ""): string {
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${pPr}</w:pPr><w:r><w:rPr>${directRun}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
}
function sectionParagraph(text: string, pPr: string, style = ""): string {
  return p(text, style, "", pPr);
}
function group(object: DocxFormatObject, key: string): DocxFormatProperties {
  return object.properties[key] as DocxFormatProperties;
}
function runs(objects: DocxFormatObject[]): DocxFormatObject[] {
  return objects.filter((object) => object.kind === "run");
}

describe("DOCX content-bound format facts", () => {
  it("uses effective formatting instead of style identity and distinguishes direct overrides", async () => {
    const bytes = docx(
      p("Same style", "Body") + p("Direct override", "Body", '<w:sz w:val="30"/>') + p("Alias style", "Alias"),
      '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body Text"/><w:rPr><w:rFonts w:ascii="Exact Face"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Alias"><w:basedOn w:val="Body"/></w:style>',
    );
    const facts = await openDocxFormatFacts(bytes);
    const [first, changed, alias] = runs(facts.snapshot.objects);
    expect(group(first, "run")).toEqual(group(alias, "run"));
    expect(group(first, "run").fontSizePt).toBe(11);
    expect(group(changed, "run").fontSizePt).toBe(15);
    expect(group(changed, "run").fontFamily).toBe("Exact Face");
    expect(facts.snapshot.source_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(JSON.parse(JSON.stringify(facts.snapshot))).toEqual(facts.snapshot);
  });

  it("resolves docDefaults, basedOn, theme lanes, paragraph marks, and character toggle hierarchy", async () => {
    const styles = '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="80"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:jc w:val="center"/><w:ind w:left="200"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="Unexplained special style"/><w:basedOn w:val="Base"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Toggle"><w:rPr><w:b/></w:rPr></w:style>';
    const bytes = docx(p("Mixed 字", "Custom", '<w:rStyle w:val="Toggle"/><w:rFonts w:eastAsia="Exact CJK"/>', '<w:rPr><w:sz w:val="60"/></w:rPr>'), styles);
    const facts = await openDocxFormatFacts(bytes);
    const run = runs(facts.snapshot.objects)[0];
    const paragraph = facts.snapshot.objects.find((object) => object.kind === "paragraph");
    if (!paragraph) throw new Error("Expected paragraph facts");
    expect(group(run, "run")).toMatchObject({ fontFamily: "Theme Body", fontFamilyEastAsia: "Exact CJK", fontSizePt: 10, bold: false, italic: true });
    expect(group(paragraph, "paragraph")).toMatchObject({ alignment: "center", outlineLevel: 1, indent: { left: 10 }, spacing: { before: 4 } });
    expect(group(paragraph, "paragraph_mark").fontSizePt).toBe(30);
    expect(paragraph.role).toBe("heading");
    expect(run.role).toBe("heading");
    expect(group(run, "script_usage")).toMatchObject({ latin: true, east_asian: true });
    const themeOnly = await openDocxFormatFacts(docx(p("主题 Theme"), styles));
    expect(group(runs(themeOnly.snapshot.objects)[0], "run")).toMatchObject({ fontFamily: "Theme Body", fontFamilyEastAsia: "Theme Body CJK" });
  });

  it("keeps unknown roles uncertain and supports explicit role evidence without reading node ids", async () => {
    const facts = await openDocxFormatFacts(docx(p("Unlabelled", "custom") + p("Abstract") + p("Keywords: test"), '<w:style w:type="paragraph" w:styleId="custom"><w:name w:val="Custom 42"/></w:style>'));
    const paragraphs = facts.snapshot.objects.filter((object) => object.kind === "paragraph");
    expect(paragraphs.map((object) => object.role)).toEqual(["unknown", "abstract_heading", "keywords"]);
    expect(paragraphs[0].role_basis).toContainEqual({ source: "style_name", value: "Custom 42", certainty: "uncertain" });
  });

  it("prioritizes direct outline and labelled content over generic styles and keeps table titles distinct", async () => {
    const styles = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="TableTitle"><w:name w:val="Table Title"/></w:style><w:style w:type="paragraph" w:styleId="Opaque"><w:name w:val="IJAM_Text"/></w:style><w:style w:type="paragraph" w:styleId="IndexTerms"/><w:style w:type="paragraph" w:styleId="ReferenceHead"><w:name w:val="Reference Head"/></w:style><w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="My title decoration"/></w:style>';
    const facts = await openDocxFormatFacts(docx(
      p("Methods", "Normal", "", '<w:outlineLvl w:val="1"/>') +
      p("摘要：研究正文", "Normal") + p("Keywords: methods", "Normal") +
      p("TABLE IV", "TableTitle") + p("Measurements of the trial", "TableTitle") +
      p("Ordinary body prose", "Opaque") + p("Index Terms—sampling", "IndexTerms") +
      p("Appendix", "ReferenceHead") + p("Acknowledgment", "ReferenceHead") +
      p("Unexplained material", "Custom") + p("Table IV summarizes the results.", "Normal") +
      p("Figure 5将实验划分为三个阶段。", "Normal"), styles));
    const paragraphs = facts.snapshot.objects.filter((object) => object.kind === "paragraph");
    expect(paragraphs.map((object) => object.role)).toEqual([
      "heading", "abstract", "keywords", "caption", "caption", "body", "keywords", "heading", "heading", "unknown", "body", "body",
    ]);
    expect(paragraphs[0].role_basis).toContainEqual({ source: "outline_level", value: "1", certainty: "explicit" });
  });

  it("infers front-matter titles using author/abstract context and presentation, and propagates roles to runs", async () => {
    const styles = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading"><w:name w:val="Heading"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="42"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Authors"><w:name w:val="Authors"/></w:style>';
    const template = await openDocxFormatFacts(docx(
      p("An Unseen Scientific Title", "Heading") + p("A. Researcher", "Authors") +
      p("[AFFILIATION(S)]", "Authors") + p("Corresponding author: person@example.org", "Authors") +
      p("Abstract—The experiment tests a new method.", "Normal") + p("Index Terms—method", "Normal") +
      p("Introduction", "Normal", "", '<w:outlineLvl w:val="0"/>'), styles));
    const templateParagraphs = template.snapshot.objects.filter((object) => object.kind === "paragraph");
    expect(templateParagraphs.map((object) => object.role)).toEqual(["document_title", "author", "affiliation", "affiliation", "abstract", "keywords", "heading"]);
    expect(templateParagraphs[0].role_basis.some((basis) => basis.source === "context" && basis.certainty === "inferred")).toBe(true);
    const bilingual = await openDocxFormatFacts(docx(
      p("一种新的测量方法", "Normal", '<w:sz w:val="32"/>', '<w:jc w:val="center"/>') +
      p("摘要：方法与结果。", "Normal") + p("关键词：测量", "Normal") +
      p("A New Measurement Method", "Normal", '<w:b/><w:sz w:val="24"/>', '<w:jc w:val="center"/>') +
      p("Abstract: Methods and results.", "Normal") + p("Keywords: measurement", "Normal") +
      p("1 Introduction", "Normal", "", '<w:outlineLvl w:val="0"/>'), styles));
    expect(bilingual.snapshot.objects.filter((object) => object.kind === "paragraph").map((object) => object.role)).toEqual(["document_title", "abstract", "keywords", "document_title", "abstract", "keywords", "heading"]);
    expect(runs(bilingual.snapshot.objects).map((object) => object.role)).toEqual(["document_title", "abstract", "keywords", "document_title", "abstract", "keywords", "heading"]);
  });

  it("does not infer a title from position alone and bounds abstract/reference context at section headings", async () => {
    const styles = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="List"><w:name w:val="List Paragraph"/></w:style>';
    const facts = await openDocxFormatFacts(docx(
      p("An ordinary introductory sentence.", "Normal") + p("Abstract", "Normal") +
      p("We compare two protocols.", "Normal") + p("Keywords: protocols", "Normal") +
      p("References", "Normal") + p("A. Researcher. A protocol. Journal, 2024.", "List") +
      p("Appendix", "Normal") + p("A note written in 2025 remains ordinary prose.", "Normal"), styles));
    expect(facts.snapshot.objects.filter((object) => object.kind === "paragraph").map((object) => object.role)).toEqual(["body", "abstract_heading", "abstract", "keywords", "heading", "reference", "heading", "body"]);
    const ambiguous = await openDocxFormatFacts(docx(p("A short unstyled line") + p("Abstract: Prose without title evidence.")));
    expect(ambiguous.snapshot.objects.find((object) => object.kind === "paragraph")?.role).toBe("unknown");
  });

  it("binds semantic regions to core sections and propagates the exact section to table descendants", async () => {
    const table = `<w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${p("Cell data")}</w:tc></w:tr></w:tbl>`;
    const facts = await openDocxFormatFacts(docx(
      sectionParagraph("Exact Title", '<w:sectPr><w:cols w:num="1"/></w:sectPr>', "Title") +
      p("Introduction", "Normal", "", '<w:outlineLvl w:val="0"/>') +
      p("Body prose.", "Normal") + table +
      '<w:sectPr><w:cols w:num="2"/></w:sectPr>',
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>',
    ));
    const sections = facts.snapshot.objects.filter((object) => object.kind === "section");
    expect(sections.map((section) => (section.properties.section as DocxFormatProperties).columns)).toMatchObject([
      { count: 1 },
      { count: 2 },
    ]);
    expect(sections.every((section) => section.region?.section_object_id === section.object_id)).toBe(true);
    const title = facts.snapshot.objects.find((object) => object.text === "Exact Title");
    const body = facts.snapshot.objects.find((object) => object.text === "Body prose.");
    if (!title?.region || !body?.region) throw new Error("Expected paragraph regions");
    expect(title.region.role).toBe("front_matter");
    expect(body.region.role).toBe("body");
    const bodySection = sections.find((section) => section.object_id === body.region?.section_object_id);
    const titleSection = sections.find((section) => section.object_id === title.region?.section_object_id);
    if (!bodySection?.region || !titleSection?.region) throw new Error("Expected section regions");
    expect(bodySection.region.section_object_id).toBe(bodySection.object_id);
    expect(titleSection.region.section_object_id).toBe(titleSection.object_id);
    expect(titleSection.evidence.core_section).toMatchObject({ boundary: "paragraph_properties", membership: "enumerateDocumentSectionsBounded" });
    expect(bodySection.evidence.core_section).toMatchObject({ boundary: "body_section", membership: "enumerateDocumentSectionsBounded" });
    for (const kind of ["table", "tr", "tc"]) {
      expect(facts.snapshot.objects.find((object) => object.kind === kind)?.region?.section_object_id).toBe(body.region.section_object_id);
    }
    expect(facts.snapshot.objects.find((object) => object.kind === "run" && object.text === "Cell data")?.region?.section_object_id)
      .toBe(body.region.section_object_id);
  });

  it("marks a multi-category section mixed and an unsupported section unknown", async () => {
    const mixed = await openDocxFormatFacts(docx(
      p("A Styled Title", "Title") + p("Introduction", "Normal", "", '<w:outlineLvl w:val="0"/>') + p("Body prose.", "Normal"),
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>',
    ));
    const mixedSection = mixed.snapshot.objects.find((object) => object.kind === "section");
    if (!mixedSection?.region) throw new Error("Expected implicit section region");
    expect(mixedSection.evidence.core_section).toMatchObject({ boundary: "implicit", membership: "enumerateDocumentSectionsBounded" });
    expect(mixedSection.region.role).toBe("mixed");
    expect(mixedSection.region.role_basis).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "context", value: expect.stringMatching(/^front_matter:/), certainty: "inferred" }),
      expect.objectContaining({ source: "context", value: expect.stringMatching(/^body:/), certainty: "inferred" }),
      expect.objectContaining({ source: "context", value: expect.stringMatching(/^mixed:/), certainty: "uncertain" }),
    ]));

    const unknown = await openDocxFormatFacts(docx(
      p("Unexplained material", "Custom"),
      '<w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="Custom 42"/></w:style>',
    ));
    const unknownSection = unknown.snapshot.objects.find((object) => object.kind === "section");
    if (!unknownSection?.region) throw new Error("Expected implicit section region");
    expect(unknownSection.region.role).toBe("unknown");
    expect(unknownSection.region.role_basis).toEqual([
      { source: "context", value: "unknown: no supported semantic category evidence in section", certainty: "uncertain" },
    ]);
  });

  it("separates references and appendix regions and reports a section that spans both as mixed", async () => {
    const paragraphs = p("References") +
      sectionParagraph("A. Researcher. A protocol. Journal, 2024.", '<w:sectPr><w:cols w:num="1"/></w:sectPr>') +
      sectionParagraph("Appendix", '<w:sectPr><w:cols w:num="1"/></w:sectPr>');
    const separated = await openDocxFormatFacts(docx(paragraphs));
    const separatedSections = separated.snapshot.objects.filter((object) => object.kind === "section");
    expect(separatedSections.map((section) => section.region?.role)).toEqual(["references", "appendix"]);

    const spanning = await openDocxFormatFacts(docx(
      p("References") + p("A. Researcher. A protocol. Journal, 2024.") +
      sectionParagraph("Appendix", '<w:sectPr><w:cols w:num="1"/></w:sectPr>'),
    ));
    const spanningSection = spanning.snapshot.objects.find((object) => object.kind === "section");
    expect(spanningSection?.region?.role).toBe("mixed");
    expect(spanningSection?.region?.role_basis).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.stringMatching(/^references:/) }),
      expect.objectContaining({ value: expect.stringMatching(/^appendix:/) }),
    ]));
  });

  it("keeps references and appendix context through body content and tables until a peer body heading", async () => {
    const table = `<w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${p("Nested table content")}</w:tc></w:tr></w:tbl>`;
    const facts = await openDocxFormatFacts(docx(
      p("References") + p("Ordinary continuation after the heading.", "Normal") + table +
      sectionParagraph("End references", '<w:sectPr><w:cols w:num="1"/></w:sectPr>') +
      p("Appendix A", "Normal", "", '<w:outlineLvl w:val="0"/>') +
      p("Detailed methods", "Normal", "", '<w:outlineLvl w:val="1"/>') +
      p("Appendix prose.", "Normal") + table +
      sectionParagraph("End appendix", '<w:sectPr><w:cols w:num="1"/></w:sectPr>') +
      p("Main section", "Normal", "", '<w:outlineLvl w:val="0"/>') +
      p("Main body prose.", "Normal") +
      '<w:sectPr><w:cols w:num="1"/></w:sectPr>',
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    ));
    const sections = facts.snapshot.objects.filter((object) => object.kind === "section");
    expect(sections.map((section) => section.region?.role)).toEqual(["references", "appendix", "body"]);
    expect(sections[0].region?.role_basis).toEqual([
      { source: "context", value: "references: heading: References", certainty: "inferred" },
    ]);
    expect(sections[1].region?.role_basis).toEqual([
      { source: "context", value: "appendix: heading: Appendix A", certainty: "inferred" },
    ]);
  });

  it("retains every package entry, namespace, custom attribute and relationship without mutations", async () => {
    const binary = new Uint8Array([0, 255, 3, 4, 82]);
    const bytes = docx(`${p("Text")}<x:widget x:flag="original" odd="kept"><x:child/></x:widget>`, "", { "custom/opaque.bin": binary, "custom/item.xml": strToU8('<e:root xmlns:e="urn:else" e:attr="42"/>') });
    const before = new Uint8Array(bytes);
    const facts = await openDocxFormatFacts(bytes);
    expect(bytes).toEqual(before);
    expect(facts.snapshot.parts.some((part) => part.name === "/custom/opaque.bin" && part.byte_length === 5)).toBe(true);
    const raw = facts.query({ kind: "part", part: "/custom/opaque.bin", format: "bytes" });
    expect(raw).toMatchObject({ kind: "part", format: "bytes", data: binary, source_sha256: facts.snapshot.source_sha256 });
    if (raw.kind === "part" && raw.format === "bytes") raw.data[0] = 91;
    expect(facts.query({ kind: "part", part: "/custom/opaque.bin", format: "bytes" })).toMatchObject({ data: binary });
    const queried = facts.query({ kind: "nodes", namespace_uri: "urn:custom", attribute: { namespace_uri: "urn:custom", local_name: "flag", value: "original" } });
    expect(queried.kind).toBe("nodes");
    if (queried.kind === "nodes") {
      expect(queried.total).toBe(1);
      expect(queried.nodes[0].node).toMatchObject({ namespaceBindings: [], attributes: expect.arrayContaining([expect.objectContaining({ localName: "odd", value: "kept" })]) });
      expect(facts.query({ kind: "nodes", part: queried.nodes[0].part, path: queried.nodes[0].path })).toMatchObject({ total: 1 });
    }
    expect(facts.query({ kind: "nodes", namespace_uri: "urn:else", local_name: "root" })).toMatchObject({ total: 1 });
    expect(facts.query({ kind: "relationships", part: "/word/document.xml" })).toMatchObject({ relationships: expect.arrayContaining([expect.objectContaining({ id: "theme", rawTarget: "theme/theme1.xml" })]) });
    expect(facts.snapshot.objects.some((object) => object.kind === "unsupported_node")).toBe(true);
  });

  it("uses conditional table style inheritance and exposes sections and other stories structurally", async () => {
    const table = `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblLook w:firstRow="1" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${p("Cell")}</w:tc></w:tr></w:tbl>`;
    const facts = await openDocxFormatFacts(docx(`${table}<w:sectPr><w:pgSz w:w="12000" w:h="16000"/><w:cols w:num="2" w:space="400"/></w:sectPr>`, '<w:style w:type="table" w:styleId="Grid"><w:tblStylePr w:type="firstRow"><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr></w:tblStylePr></w:style>', {
      "word/header1.xml": strToU8(`<w:hdr xmlns:w="${W}">${p("Header")}</w:hdr>`),
      "word/footnotes.xml": strToU8(`<w:footnotes xmlns:w="${W}"><w:footnote w:id="1">${p("Note")}</w:footnote></w:footnotes>`),
    }));
    const cell = facts.snapshot.objects.find((object) => object.kind === "run" && object.text === "Cell");
    if (!cell) throw new Error("Expected cell run facts");
    expect(group(cell, "run").bold).toBe(true);
    expect(facts.snapshot.objects.find((object) => object.kind === "paragraph" && object.text === "Cell")?.properties.paragraph).toMatchObject({ alignment: "center" });
    expect(facts.snapshot.objects.find((object) => object.kind === "section")?.properties.section).toMatchObject({ pageSize: { widthTwips: 12000, heightTwips: 16000 }, columns: { count: 2 } });
    expect(facts.snapshot.objects.find((object) => object.kind === "run" && object.text === "Header")?.role).toBe("header");
    expect(facts.snapshot.objects.find((object) => object.kind === "run" && object.text === "Note")?.role).toBe("footnote");
    expect(facts.snapshot.objects.find((object) => object.kind === "run" && object.text === "Header")?.region).toBeUndefined();
    expect(facts.snapshot.objects.find((object) => object.kind === "run" && object.text === "Note")?.region).toBeUndefined();
    expect(facts.snapshot.objects.find((object) => object.kind === "tc")?.properties.cell).toMatchObject({ gridSpan: 1 });
  });

  it.runIf(process.env.OLEAFLY_DOCX_FORMAT_ACCEPTANCE === "1")("reads real retained author inputs without changing their bytes", async () => {
    const paths = [".private/journal-template-acceptance/template.docx", "/Volumes/Studio/Research/研/交付文件/英文稿/IJAM_english_working.docx", "/Volumes/Studio/Research/研/交付文件/中文稿/批注.docx"];
    for (const path of paths) {
      const bytes = new Uint8Array(await readFile(path));
      const hash = createHash("sha256").update(bytes).digest("hex");
      const facts = await openDocxFormatFacts(bytes);
      expect(facts.snapshot.source_sha256).toBe(hash);
      expect(facts.snapshot.objects.filter((object) => object.kind === "run").length).toBeGreaterThan(100);
      expect(facts.snapshot.parts.every((part) => part.sha256.length === 64)).toBe(true);
      const paragraphs = facts.snapshot.objects.filter((object) => object.kind === "paragraph");
      expect(paragraphs.some((object) => object.role === "document_title")).toBe(true);
      expect(paragraphs.some((object) => object.role === "keywords")).toBe(true);
      for (const paragraph of paragraphs) {
        const layout = group(paragraph, "paragraph");
        const styleName = (paragraph.evidence.style_chain as DocxFormatProperties[])[0]?.name;
        if (styleName === "Table Title") expect(paragraph.role).toBe("caption");
        if (paragraph.evidence.top_level_body && layout.outlineLevel !== null) expect(paragraph.role).toBe("heading");
      }
      expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(hash);
    }
  });
});

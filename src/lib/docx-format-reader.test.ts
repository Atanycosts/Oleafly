import type { DocxEditorInstance } from "@docx-editor.dev/core/editor";
import type { DocxFormatReadQuery } from "@oleafly/ai-tools";
import { openTreeSession } from "@docx-editor.dev/core/binding";
import { writeOoxmlPackage } from "@docx-editor.dev/core/store";
import { strToU8, zipSync } from "fflate";
import { assert, describe, expect, it, vi } from "vitest";
import { createDocxSession } from "./docx-session";
import { createDocxFormatReader } from "./docx-format-reader";
import { openDocxFormatFacts } from "./docx-format";
import { packToolOutput, TOOL_RESULT_MAX_CHARS } from "./ai-context-pack";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const p = (text: string, props = "", run = "") => `<w:p><w:pPr>${props}</w:pPr><w:r><w:rPr>${run}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
function fixture(body: string) {
  const bytes = zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="header" Type="${R}/header" Target="header1.xml"/><Relationship Id="footnotes" Type="${R}/footnotes" Target="footnotes.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
    "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:keepNext/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Unused"><w:basedOn w:val="Base"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="Grid"><w:tblPr><w:tblBorders/></w:tblPr></w:style></w:styles>`),
    "word/header1.xml": strToU8(`<w:hdr xmlns:w="${W}">${p("Header text")}</w:hdr>`),
    "word/footnotes.xml": strToU8(`<w:footnotes xmlns:w="${W}"><w:footnote w:id="1">${p("Note text")}</w:footnote></w:footnotes>`),
  });
  const opened = openTreeSession(bytes);
  if (!opened.ok) throw new Error(opened.reason);
  const tree = opened.session;
  const surface = {
    session: tree, packageRevision: () => tree.packageRevision(), flushPendingInput() {},
    applyAutomationOps(stage: (relate: (url: string) => string) => Parameters<typeof tree.applyTreeOps>[0] | null) {
      const ops = stage((url) => url);
      return ops === null ? { committed: false, rejected: true, opCount: 0 } : tree.applyTreeOps(ops);
    },
    editingMode: () => "edit", collaborationSession: () => null, revisionDisplayMode: () => "allMarkup",
    save: () => writeOoxmlPackage(tree.currentPackage()),
  };
  const session = createDocxSession({ surface, exec: () => ({ ok: true }), on: () => () => {}, can: () => ({ ok: false }) } as unknown as DocxEditorInstance);
  const exportBytes = vi.fn(async () => writeOoxmlPackage(tree.currentPackage()));
  const openFacts = vi.fn(openDocxFormatFacts);
  const read = createDocxFormatReader({ session, exportBytes, openFacts,
    document: () => ({ sessionId: "live", filename: "test.docx", baselineId: "saved-baseline", savedRevision: 0 }) });
  return { session, read, exportBytes, openFacts };
}

describe("live DOCX format reader", () => {
  it("distinguishes retained XML node counts from semantic reading and links model placeholders to content atoms", async () => {
    const f = fixture(p("First") + `<w:p><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub></m:sSub></m:oMath></w:p>`);
    const semantics = vi.spyOn(f.session, "readParagraph");
    const overview = await f.read({ kind: "overview" });
    expect(overview.overview).toMatchObject({
      countUnits: { unsupported_node: "xml_node" },
      gaps: expect.arrayContaining([expect.objectContaining({ code: "structural_only", unit: "xml_node", semanticReading: "read_docx_document" })]),
      read: { content: { tool: "read_docx_document", arguments: { offset: 0, expected_revision: 0 } } },
    });
    expect(semantics).not.toHaveBeenCalled();
    const result = await f.read({ kind: "paragraphs", part: "/word/document.xml", offset: 1, limit: 1 });
    expect(result.paragraphs?.[0]).toMatchObject({
      modelText: "\uFFFC",
      contentCoverage: { projection: "addressing_text", semanticAtomsIncluded: false },
      contentRead: { tool: "read_docx_document", arguments: { offset: 1, limit: 1, expected_revision: 0 } },
    });
  });

  it("keeps format pages and continuation queries intact through the Agent transport", async () => {
    const text = '中文😀 "quoted"\\path '.repeat(1500).trimEnd();
    const f = fixture(p(text));
    f.openFacts.mockImplementationOnce(async (bytes) => {
      const facts = await openDocxFormatFacts(bytes);
      const style = facts.snapshot.style_definitions?.[0];
      if (!style) throw new Error("Missing style");
      style.properties.run.large_metadata = '"\\\n格式'.repeat(3000);
      return facts;
    });
    for (const kind of ["overview", "paragraphs", "objects", "nodes", "styles"] as const) {
      const result = await f.read({ kind, limit: 50, textLimit: 16000 });
      expect(JSON.stringify(result).length, kind).toBeLessThanOrEqual(10_000);
      expect(JSON.stringify(result).length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
      expect(packToolOutput(result), kind).toEqual(result);
      expect(result).toHaveProperty("nextQuery");
      expect(result).not.toHaveProperty("preview");
    }
    let offset = 0;
    let reconstructed = "";
    do {
      const result = await f.read({ kind: "paragraphs", part: "/word/document.xml", textOffset: offset, textLimit: 16000, limit: 1 });
      expect(packToolOutput(result)).toEqual(result);
      const paragraph = result.paragraphs?.[0];
      reconstructed += paragraph?.modelText;
      const next = paragraph?.textContinuation as { text_offset: number; expected_revision: number } | null;
      if (!next) break;
      expect(next.expected_revision).toBe(result.revision);
      expect(next.text_offset).toBeGreaterThan(offset);
      offset = next.text_offset;
    } while (offset < text.length);
    expect(reconstructed).toBe(text);
  });

  it("reads raw nodes and declared styles without building the live paragraph directory", async () => {
    const f = fixture(p("First") + p("Second"));
    const list = vi.spyOn(f.session, "listParagraphs");
    const locate = vi.spyOn(f.session, "paragraphLocator");
    const nodes = await f.read({ kind: "nodes", part: "/word/document.xml", localName: "t", limit: 1 });
    const next = await f.read({ kind: "nodes", part: "/word/document.xml", localName: "t", offset: nodes.nextOffset ?? 1, limit: 1 });
    expect(nodes.nextOffset).toBe(1);
    expect(nodes.nextQuery).toMatchObject({ kind: "nodes", part: "/word/document.xml", local_name: "t", offset: 1, limit: 1, expected_revision: nodes.revision });
    expect(nodes.nodes).toHaveLength(1);
    expect(next.nodes).toHaveLength(1);
    expect(next.nextOffset).toBeNull();
    expect(next.nextQuery).toBeNull();
    const stylesPage = await f.read({ kind: "styles", limit: 1 });
    expect(stylesPage.nextQuery).toMatchObject({ kind: "styles", offset: 1, limit: 1, expected_revision: stylesPage.revision });
    const styles = await f.read({ kind: "styles", styleId: "Unused" });
    expect(styles.styles?.[0]).toMatchObject({ style_id: "Unused" });
    expect(list).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(f.exportBytes).toHaveBeenCalledTimes(1);
    expect(f.openFacts).toHaveBeenCalledTimes(1);
  });

  it("preserves attribute selectors while continuing a raw node page", async () => {
    const f = fixture(p("Text"));
    const first = await f.read({
      kind: "nodes",
      part: "/word/styles.xml",
      namespaceUri: W,
      localName: "style",
      attribute: { namespaceUri: W, localName: "type", value: "paragraph" },
      limit: 1,
    });
    expect(first.nextQuery).toMatchObject({
      kind: "nodes",
      part: "/word/styles.xml",
      namespace_uri: W,
      local_name: "style",
      attribute: { namespace_uri: W, local_name: "type", value: "paragraph" },
      offset: 1,
      limit: 1,
      expected_revision: first.revision,
    });
    const continuation = first.nextQuery as Record<string, unknown>;
    const attribute = continuation.attribute as Record<string, unknown>;
    const second = await f.read({
      kind: "nodes",
      part: String(continuation.part),
      namespaceUri: String(continuation.namespace_uri),
      localName: String(continuation.local_name),
      attribute: {
        namespaceUri: String(attribute.namespace_uri),
        localName: String(attribute.local_name),
        value: String(attribute.value),
      },
      offset: Number(continuation.offset),
      limit: Number(continuation.limit),
      expectedRevision: Number(continuation.expected_revision),
    });
    const styleIds = [first, second].flatMap((result) => result.nodes ?? []).map((record) => {
      const node = record.node as { attributes?: { localName: string; value: string }[] };
      return node.attributes?.find((entry) => entry.localName === "styleId")?.value;
    });
    expect(styleIds).toEqual(["Base", "Unused"]);
    expect(second.nextQuery).toBeNull();
  });

  it("reuses the live paragraph directory across pages and rebuilds it after mutation", async () => {
    const f = fixture(p("First") + p("Second"));
    const list = vi.spyOn(f.session, "listParagraphs");
    const locate = vi.spyOn(f.session, "paragraphLocator");
    const [first, second] = await Promise.all([
      f.read({ kind: "paragraphs", part: "/word/document.xml", limit: 1 }),
      f.read({ kind: "paragraphs", part: "/word/document.xml", offset: 1, limit: 1 }),
    ]);
    expect(first.paragraphs?.[0]).toMatchObject({ modelText: "First" });
    expect(second.paragraphs?.[0]).toMatchObject({ modelText: "Second" });
    expect(first.nextQuery).toMatchObject({ kind: "paragraphs", part: "/word/document.xml", offset: 1, limit: 1,
      expected_revision: first.revision });
    const overview = await f.read({ kind: "overview", limit: 1 });
    expect(overview.nextQuery).toMatchObject({ kind: "overview", offset: 1, limit: 1, expected_revision: overview.revision });
    const objects = await f.read({ kind: "objects", limit: 1 });
    expect(objects.nextQuery).toMatchObject({ kind: "objects", offset: 1, limit: 1, expected_revision: objects.revision });
    await f.read({ kind: "objects", paragraphRef: String(second.paragraphs?.[0].paragraphRef) });
    expect(list).toHaveBeenCalledTimes(1);
    expect(locate).toHaveBeenCalledTimes(2);
    const paragraph = list.mock.results[0].value[0];
    expect(f.session.formatParagraph?.(paragraph.handle, f.session.revision(), { paragraph: { keepNext: true } })?.ok).toBe(true);
    const changed = await f.read({ kind: "paragraphs", part: "/word/document.xml", limit: 1 });
    expect(changed.paragraphs?.[0]).toMatchObject({ modelText: "First", properties: { paragraph: { keepNext: true } } });
    expect(changed.document).toMatchObject({ sessionRevision: 1, dirty: true });
    await f.read({ kind: "paragraphs", part: "/word/document.xml", offset: 1, limit: 1 });
    expect(list).toHaveBeenCalledTimes(2);
    expect(locate).toHaveBeenCalledTimes(4);
    expect(f.exportBytes).toHaveBeenCalledTimes(2);
    expect(f.openFacts).toHaveBeenCalledTimes(2);
  });

  it("does not replace the current directory when an older facts read finishes after mutation", async () => {
    const f = fixture(p("Before"));
    const paragraph = f.session.listParagraphs()[0];
    const list = vi.spyOn(f.session, "listParagraphs");
    const locate = vi.spyOn(f.session, "paragraphLocator");
    let complete!: () => void;
    f.openFacts.mockImplementationOnce(async (bytes) => {
      const facts = await openDocxFormatFacts(bytes);
      return new Promise((resolve) => { complete = () => resolve(facts); });
    });
    const pending = f.read({ kind: "paragraphs" });
    const rejected = expect(pending).rejects.toThrow("session changed");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(f.session.formatParagraph?.(paragraph.handle, 0, { paragraph: { keepNext: true } })?.ok).toBe(true);
    const current = await f.read({ kind: "paragraphs", part: "/word/document.xml" });
    expect(current.paragraphs?.[0]).toMatchObject({ properties: { paragraph: { keepNext: true } } });
    complete();
    await rejected;
    expect((await f.read({ kind: "paragraphs", part: "/word/document.xml" })).sourceSha256).toBe(current.sourceSha256);
    expect(list).toHaveBeenCalledTimes(1);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(f.openFacts).toHaveBeenCalledTimes(2);
  });

  it("keeps the serialized paragraph stable while following oversized record continuation", async () => {
    const text = "变化中文😀".repeat(2000);
    const f = fixture(p(text));
    f.openFacts.mockImplementationOnce(async (bytes) => {
      const facts = await openDocxFormatFacts(bytes);
      const paragraph = facts.snapshot.objects.find((object) => object.kind === "paragraph");
      if (!paragraph) throw new Error("Missing paragraph");
      paragraph.properties.large_metadata = "格式".repeat(10000);
      return facts;
    });
    let offset = 0;
    let json = "";
    let recordLength: unknown;
    do {
      const result = await f.read({ kind: "paragraphs", part: "/word/document.xml", textOffset: offset, limit: 1 });
      const record = result.paragraphs?.[0];
      recordLength ??= record?.recordJsonLength;
      expect(record?.recordJsonLength).toBe(recordLength);
      expect(record?.recordJsonOffset).toBe(offset);
      json += record?.recordJson;
      const next = record?.recordJsonContinuation as { text_offset: number } | null;
      if (!next) break;
      expect(next).toMatchObject({ expected_revision: result.revision });
      offset = next.text_offset;
    } while (offset < Number(recordLength));
    expect(JSON.parse(json)).toMatchObject({ text, modelText: text, modelTextOffset: 0, textOffset: 0 });
  });

  it("bounds final Chinese paragraph and shallow-node UTF8 pages and reconstructs every text unit", async () => {
    const text = "中文长段😀".repeat(3000);
    const f = fixture(p(text));
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let offset = 0;
    let reconstructed = "";
    do {
      const result = await f.read({ kind: "paragraphs", part: "/word/document.xml", textOffset: offset, textLimit: 16000, limit: 50 });
      expect(bytes(result)).toBeLessThanOrEqual(24 * 1024);
      const paragraph = result.paragraphs?.[0];
      expect(paragraph?.modelTextOffset).toBe(offset);
      reconstructed += paragraph?.modelText;
      const next = paragraph?.textContinuation as { text_offset: number } | null;
      if (!next) break;
      expect(next).toMatchObject({ expected_revision: result.revision });
      expect(next.text_offset).toBeGreaterThan(offset);
      offset = next.text_offset;
    } while (offset < text.length);
    expect(reconstructed).toBe(text);
    const initial = await f.read({ kind: "nodes", part: "/word/document.xml", localName: "t", limit: 50 });
    expect(bytes(initial)).toBeLessThanOrEqual(24 * 1024);
    const node = initial.nodes?.[0];
    let json = String(node?.nodeJson);
    let next = node?.nodeJsonContinuation as { part: string; path: number[]; text_offset: number } | null;
    while (next) {
      const result = await f.read({ kind: "nodes", part: next.part, path: next.path, textOffset: next.text_offset, limit: 1 });
      expect(bytes(result)).toBeLessThanOrEqual(24 * 1024);
      json += result.nodes?.[0].nodeJson;
      next = result.nodes?.[0].nodeJsonContinuation as typeof next;
      if (next) expect(next).toMatchObject({ expected_revision: result.revision });
    }
    expect(JSON.parse(json).textValues.map((item: { value: string }) => item.value).join("")).toBe(text);
  });

  it("reads inherited formats, unused styles and nonbody text from the actual core export", async () => {
    const f = fixture(p("Inherited", '<w:pStyle w:val="Base"/>') + p("Override", '<w:pStyle w:val="Base"/><w:keepNext w:val="0"/>', '<w:b/>'));
    const overview = await f.read({ kind: "overview", limit: 1 });
    expect(overview.overview).toMatchObject({ counts: { paragraphs: 4, styles: 4 }, capabilities: { rawPathsWritable: false },
      gaps: expect.arrayContaining([expect.objectContaining({ code: "live_handle_coverage", count: 2 })]),
      read: { paragraphs: { kind: "paragraphs", offset: 0, limit: 1 } } });
    expect(overview.total).toBeGreaterThan(1);
    const inherited = await f.read({ kind: "paragraphs", text: "Inherited" });
    expect(inherited.paragraphs?.[0]).toMatchObject({ paragraphRef: expect.any(String), modelText: "Inherited",
      properties: { paragraph: { keepNext: true } }, evidence: { style_chain: [{ style_id: "Base" }] } });
    const override = await f.read({ text: "Override", objectKind: "paragraph" });
    expect(override.objects?.[0]).toMatchObject({ properties: { paragraph: { keepNext: false } },
      source: { addressing: "export_evidence_only" }, paragraphRef: expect.any(String) });
    const styles = await f.read({ kind: "styles" });
    const styleRecords = [...(styles.styles ?? [])];
    let nextStyle = styles.nextOffset;
    while (nextStyle !== null) {
      const page = await f.read({ kind: "styles", offset: nextStyle, expectedRevision: styles.revision });
      styleRecords.push(...(page.styles ?? []));
      nextStyle = page.nextOffset;
    }
    expect(styleRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ style_id: "Unused", effective_status: "paragraph_and_run", properties: expect.objectContaining({ run: expect.objectContaining({ fontSizePt: 12 }) }) }),
      expect.objectContaining({ style_id: "Strong", effective_status: "run", properties: expect.objectContaining({ run: expect.objectContaining({ bold: true }) }) }),
      expect.objectContaining({ style_id: "Grid", effective_status: "declaration_only", properties: expect.objectContaining({ paragraph: {}, run: {} }), declared: expect.any(Object) }),
    ]));
    const header = await f.read({ kind: "paragraphs", role: "header" });
    expect(header.paragraphs?.[0]).toMatchObject({ text: "Header text", liveAddressing: "unavailable", textProjection: "export_text" });
    expect(header.paragraphs?.[0]).not.toHaveProperty("modelText");
    expect((await f.read({ kind: "paragraphs", role: "footnote" })).paragraphs?.[0]).toMatchObject({ text: "Note text" });
    expect(f.exportBytes).toHaveBeenCalledTimes(1);
    expect(f.openFacts).toHaveBeenCalledTimes(1);
  });

  it("reports paragraph coverage by part and gives a direct route to export-only stories", async () => {
    const f = fixture(`${p("Body")}<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${p("Cell")}</w:tc></w:tr></w:tbl>`);
    const overview = await f.read({ kind: "overview", limit: 10 });
    expect(overview.overview).toMatchObject({
      coverage: {
        paragraphs: {
          total: 4,
          live: 2,
          exportOnly: 2,
          table: 1,
          tableLive: 1,
          byRole: { unknown: 2, header: 1, footnote: 1 },
          byPart: {
            "/word/document.xml": { total: 2, live: 2, exportOnly: 0, table: 1, tableLive: 1, unknown: 2 },
            "/word/header1.xml": { total: 1, live: 0, exportOnly: 1, table: 0, tableLive: 0, unknown: 0 },
            "/word/footnotes.xml": { total: 1, live: 0, exportOnly: 1, table: 0, tableLive: 0, unknown: 0 },
          },
        },
      },
      gaps: expect.arrayContaining([expect.objectContaining({
        code: "live_handle_coverage",
        count: 2,
        byPart: { "/word/header1.xml": 1, "/word/footnotes.xml": 1 },
        read: expect.objectContaining({ kind: "paragraphs", object_id: expect.any(String) }),
      })]),
    });
    assert(overview.overview, "Expected overview details.");
    const gaps = overview.overview.gaps;
    assert(Array.isArray(gaps), "Expected overview gaps.");
    const gap = (gaps as { code: string; read: Record<string, unknown> }[])
      .find((item) => item.code === "live_handle_coverage");
    assert(gap, "Expected a live handle coverage gap.");
    const drilldown = await f.read({ kind: "paragraphs", objectId: String(gap.read.object_id), offset: 0, limit: 1 });
    expect(drilldown.paragraphs?.[0]).toMatchObject({ text: "Header text", liveAddressing: "unavailable", textProjection: "export_text" });
  });

  it("preserves unknown paragraph and run roles through public reads", async () => {
    const f = fixture(p("Unclassified observation"));
    const paragraph = (await f.read({ kind: "paragraphs", role: "unknown", limit: 10 })).paragraphs?.[0];
    expect(paragraph).toMatchObject({
      role: "unknown",
      role_basis: expect.arrayContaining([expect.objectContaining({ source: "context", value: "No supported semantic role evidence" })]),
      modelText: "Unclassified observation",
    });
    const objects = await f.read({ paragraphRef: String(paragraph?.paragraphRef), limit: 10 });
    expect(objects.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "paragraph", role: "unknown" }),
      expect.objectContaining({ kind: "run", role: "unknown", text: "Unclassified observation" }),
    ]));
    expect(objects.objects?.some((object) => object.role === "body")).toBe(false);
  });

  it("paginates without loss and links duplicate/empty/table paragraphs by live structural identity", async () => {
    const f = fixture(`${p("Duplicate")}${p("")}<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${p("Duplicate")}</w:tc></w:tr></w:tbl>${p("End")}`);
    const refs = f.session.listParagraphs().map((item) => item.handle.ref);
    const first = await f.read({ kind: "paragraphs", part: "/word/document.xml", limit: 2 });
    const second = await f.read({ kind: "paragraphs", part: "/word/document.xml", offset: first.nextOffset ?? 0, limit: 2 });
    expect([...(first.paragraphs ?? []), ...(second.paragraphs ?? [])].map((item) => item.paragraphRef)).toEqual(refs);
    expect(second.nextOffset).toBeNull();
    const duplicate = await f.read({ kind: "paragraphs", text: "Duplicate" });
    expect(duplicate.paragraphs?.map((item) => item.paragraphRef)).toEqual([refs[0], refs[2]]);
    const focused = await f.read({ paragraphRef: refs[2] });
    expect(focused.objects).toHaveLength(2);
    expect(focused.objects?.every((item) => item.paragraphRef === refs[2])).toBe(true);
  });

  it("returns bounded direct formatting and object text for an oversized live paragraph", async () => {
    const text = "A".repeat(1200);
    const f = fixture(p(text, "<w:keepNext/>", "<w:b/>"));
    const listed = await f.read({ kind: "paragraphs", text: "A", limit: 1, textLimit: 20 });
    const focused = await f.read({ paragraphRef: String(listed.paragraphs?.[0].paragraphRef), textLimit: 100 });
    expect(focused.paragraph).toMatchObject({
      paragraphRef: listed.paragraphs?.[0].paragraphRef,
      text: "A".repeat(1000),
      textTruncated: true,
      textLength: text.length,
      paragraph: { keepNext: true },
      readText: { kind: "paragraphs", paragraph_ref: listed.paragraphs?.[0].paragraphRef, text_offset: 0, limit: 1, expected_revision: focused.revision },
    });
    const paragraph = focused.objects?.find((object) => object.kind === "paragraph");
    const run = focused.objects?.find((object) => object.kind === "run");
    expect(paragraph).toMatchObject({
      text: "A".repeat(100),
      textTruncated: true,
      textLength: text.length,
      readText: { object_id: paragraph?.object_id, text_offset: 0, text_limit: 100, limit: 1, expected_revision: focused.revision },
    });
    expect(run).toMatchObject({
      text: "A".repeat(100),
      textTruncated: true,
      textLength: text.length,
      readText: { object_id: paragraph?.object_id, text_offset: 0, text_limit: 100, limit: 1, expected_revision: focused.revision },
    });
  });

  it("reads model fields without inventing snapshot offsets and leaves missing model interfaces read-only", async () => {
    const f = fixture(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>99</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> tail😀</w:t></w:r></w:p>`);
    const read = await f.read({ kind: "paragraphs", part: "/word/document.xml" });
    expect(read.paragraphs?.[0]).toMatchObject({ modelText: "\uFFFC tail😀", modelTextLength: 8,
      modelTextAddressable: true, rangeWritePolicy: "protected_plain_text" });
    expect(read.paragraphs?.[0]).not.toHaveProperty("writableTextRange");
    f.session.readParagraphModelText = undefined;
    const readOnly = await f.read({ kind: "paragraphs", part: "/word/document.xml" });
    expect(readOnly.paragraphs?.[0]).toMatchObject({ modelTextAddressable: false, textProjection: "export_text" });
    expect(readOnly.paragraphs?.[0]).not.toHaveProperty("modelText");
  });

  it("recomputes live export after mutation and rejects in-flight stale revisions", async () => {
    const f = fixture(p("Before"));
    await Promise.all([f.read({ kind: "overview" }), f.read({ kind: "styles" })]);
    const paragraph = f.session.listParagraphs()[0];
    const result = f.session.formatParagraph?.(paragraph.handle, f.session.revision(), { paragraph: { keepNext: true } });
    expect(result?.ok).toBe(true);
    const changed = await f.read({ kind: "paragraphs", part: "/word/document.xml" });
    expect(changed.paragraphs?.[0]).toMatchObject({ modelText: "Before", properties: { paragraph: { keepNext: true } } });
    expect(changed.document.dirty).toBe(true);
    expect(f.openFacts).toHaveBeenCalledTimes(2);
    let complete!: (bytes: Uint8Array) => void;
    const stale = createDocxFormatReader({ session: f.session, exportBytes: () => new Promise((resolve) => { complete = resolve; }),
      document: () => changed.document });
    const pending = stale({ kind: "overview" });
    f.session.formatParagraph?.(paragraph.handle, f.session.revision(), { paragraph: { keepNext: false } });
    complete(new Uint8Array());
    await expect(pending).rejects.toThrow("session changed");
  });

  it("rejects a continuation that was created for an older revision", async () => {
    const f = fixture(p("Same") + p("Same"));
    const first = await f.read({ kind: "paragraphs", text: "Same", limit: 1 });
    expect(first.nextQuery).toMatchObject({ kind: "paragraphs", text: "Same", offset: 1, limit: 1,
      expected_revision: first.revision });
    const replayed = await f.read({
      kind: "paragraphs",
      text: String(first.nextQuery?.text),
      offset: Number(first.nextQuery?.offset),
      limit: Number(first.nextQuery?.limit),
      expectedRevision: Number(first.nextQuery?.expected_revision),
    });
    expect(replayed.paragraphs?.[0]).toMatchObject({ modelText: "Same" });
    const paragraph = f.session.listParagraphs()[0];
    expect(f.session.formatParagraph?.(paragraph.handle, first.revision, { paragraph: { keepNext: true } })?.ok).toBe(true);
    const exportsBeforeRejection = f.exportBytes.mock.calls.length;
    const continuation = {
      kind: "paragraphs",
      text: "Same",
      offset: first.nextOffset ?? 0,
      limit: 1,
      expectedRevision: Number(first.nextQuery?.expected_revision),
    } satisfies DocxFormatReadQuery;
    await expect(f.read(continuation)).rejects.toThrow("continuation");
    expect(f.exportBytes).toHaveBeenCalledTimes(exportsBeforeRejection);
    const current = await f.read({ kind: "paragraphs", limit: 1, expectedRevision: 1 });
    expect(current.revision).toBe(1);
    expect(current.paragraphs?.[0]).toMatchObject({ modelText: "Same", properties: { paragraph: { keepNext: true } } });
    expect(f.exportBytes).toHaveBeenCalledTimes(exportsBeforeRejection + 1);
  });

  it("bounds text with exact UTF16 continuation and bounds raw node trees", async () => {
    const f = fixture(p("A😀BC😀D"));
    const first = await f.read({ kind: "paragraphs", text: "A😀", textLimit: 2 });
    expect(first.paragraphs?.[0]).toMatchObject({ modelText: "A", modelTextOffset: 0, modelTextLength: 8,
      textContinuation: { text_offset: 1 }, offsets: { origin: "complete_paragraph" } });
    expect(first.paragraphs?.[0].textContinuation).toMatchObject({ expected_revision: first.revision });
    const parts: string[] = [];
    let next: Record<string, unknown> | null = { kind: "paragraphs", objectId: first.paragraphs?.[0].object_id, textLimit: 2 };
    while (next) {
      const result = await f.read({ ...next, objectId: next.object_id as string | undefined, textOffset: next.text_offset as number | undefined, textLimit: (next.text_limit ?? next.textLimit) as number | undefined });
      parts.push(String(result.paragraphs?.[0].modelText));
      next = result.paragraphs?.[0].textContinuation as Record<string, unknown> | null;
    }
    expect(parts.join("")).toBe("A😀BC😀D");
    const nodes = await f.read({ kind: "nodes", part: "/word/document.xml", path: [0], limit: 1 });
    expect(nodes.nodes?.[0]).toMatchObject({ childrenOmitted: true, childCount: 1 });
    expect(nodes.nodes?.[0].node).not.toHaveProperty("children");
    await expect(f.read({ limit: 51 })).rejects.toThrow("1 to 50");
  });

  it.each([
    [{ expectedRevision: -1 }, "expectedRevision must be a nonnegative integer"],
    [{ expectedRevision: 0.5 }, "expectedRevision must be a nonnegative integer"],
    [{ offset: -1 }, "read offset must be a nonnegative integer"],
    [{ offset: 0.5 }, "read offset must be a nonnegative integer"],
    [{ limit: 0 }, "read limit must be an integer from 1 to 50"],
    [{ limit: 51 }, "read limit must be an integer from 1 to 50"],
    [{ limit: 1.5 }, "read limit must be an integer from 1 to 50"],
    [{ textOffset: -1 }, "textOffset must be a nonnegative UTF-16 offset"],
    [{ textOffset: 0.5 }, "textOffset must be a nonnegative UTF-16 offset"],
    [{ textLimit: 0 }, "textLimit must be an integer from 1 to 16000"],
    [{ textLimit: 16_001 }, "textLimit must be an integer from 1 to 16000"],
    [{ textLimit: 1.5 }, "textLimit must be an integer from 1 to 16000"],
  ])("rejects an invalid live read window before exporting (%j)", async (query, message) => {
    const f = fixture(p("Text"));
    await expect(f.read(query as DocxFormatReadQuery)).rejects.toThrow(message);
    expect(f.exportBytes).not.toHaveBeenCalled();
    expect(f.openFacts).not.toHaveBeenCalled();
  });

  it("reports a missing live export and retries after a later successful export", async () => {
    const f = fixture(p("Text"));
    f.exportBytes.mockResolvedValueOnce(null);
    await expect(f.read({ kind: "overview" })).rejects.toThrow("did not export its live content");
    expect((await f.read({ kind: "overview" })).overview).toMatchObject({ counts: expect.any(Object) });
    expect(f.exportBytes).toHaveBeenCalledTimes(2);
    expect(f.openFacts).toHaveBeenCalledOnce();
  });

  it("retries package analysis after a failed facts read instead of caching the rejection", async () => {
    const f = fixture(p("Text"));
    f.openFacts.mockRejectedValueOnce(new Error("temporary package failure"));
    await expect(f.read({ kind: "overview" })).rejects.toThrow("temporary package failure");
    expect((await f.read({ kind: "overview" })).overview).toMatchObject({ counts: expect.any(Object) });
    expect(f.exportBytes).toHaveBeenCalledTimes(2);
    expect(f.openFacts).toHaveBeenCalledTimes(2);
  });

  it("applies object selectors together and keeps every selector in a raw-node continuation", async () => {
    const f = fixture(
      p("Same", '<w:pStyle w:val="Base"/>') +
      p("Same", '<w:pStyle w:val="Base"/>') +
      p("Different"),
    );
    const filtered = await f.read({
      styleId: "Base",
      role: "unknown",
      objectKind: "paragraph",
      text: "Same",
      limit: 10,
    });
    expect(filtered.objects?.map((object) => object.text)).toEqual(["Same", "Same"]);
    const first = await f.read({
      kind: "nodes",
      part: "/word/document.xml",
      localName: "pStyle",
      namespaceUri: W,
      attribute: { localName: "val" },
      objectKind: "paragraph",
      styleId: "Base",
      objectId: "unused-for-node-query",
      role: "body",
      text: "Same",
      paragraphRef: "unused-for-node-query",
      textOffset: 2,
      textLimit: 30,
      limit: 1,
    } as DocxFormatReadQuery);
    expect(first.nextQuery).toMatchObject({
      kind: "nodes",
      part: "/word/document.xml",
      namespace_uri: W,
      local_name: "pStyle",
      attribute: { local_name: "val" },
      object_kind: "paragraph",
      style_id: "Base",
      object_id: "unused-for-node-query",
      role: "body",
      text: "Same",
      paragraph_ref: "unused-for-node-query",
      text_offset: 2,
      text_limit: 30,
      offset: 1,
      limit: 1,
    });
  });

  it("does not select styles when a continuation is scoped to a live paragraph", async () => {
    const f = fixture(p("Text", '<w:pStyle w:val="Base"/>'));
    const result = await f.read({
      kind: "styles",
      paragraphRef: f.session.listParagraphs()[0]!.handle.ref,
      styleId: "Base",
    });
    expect(result.styles).toEqual([]);
    expect(result.nextQuery).toBeNull();
  });

  it("keeps paragraph text windows on whole UTF-16 surrogate pairs", async () => {
    const f = fixture(p("A😀Z"));
    const fromLowSurrogate = await f.read({
      kind: "paragraphs",
      textOffset: 2,
      textLimit: 1,
    });
    expect(fromLowSurrogate.paragraphs?.[0]).toMatchObject({
      text: "😀",
      textOffset: 1,
      textTruncated: true,
    });

    const acrossHighSurrogate = await f.read({
      kind: "paragraphs",
      textOffset: 0,
      textLimit: 2,
    });
    expect(acrossHighSurrogate.paragraphs?.[0]).toMatchObject({
      text: "A",
      textOffset: 0,
      textTruncated: true,
    });
  });
});

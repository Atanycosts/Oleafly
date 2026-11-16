import { describe, expect, it, vi } from "vitest";
import {
  createDocxTools,
  type DocxFormatReadQuery,
  type DocxFormatReadResult,
  type DocxToolsHost,
} from "./tools";

function host(overrides: Partial<DocxToolsHost> = {}): DocxToolsHost {
  return {
    listDocuments: vi.fn(async () => []),
    readDocument: vi.fn(async () => ({
      document: {
        sessionId: "s1",
        sourceSha256: "a".repeat(64),
        appProjectId: "p1",
        workbenchProjectId: "paper",
        title: "Paper",
        filename: "paper.docx",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
      },
      paragraphs: [{
        paragraphRef: "para-1", text: "Text", modelText: "Text", displayText: "Text",
        revision: 2, atoms: [], editableRanges: [{ start: 0, end: 4 }],
      }],
      offset: 0, nextOffset: null, totalParagraphs: 1, nextQuery: null,
    })),
    captureTarget: vi.fn(async () => ({
      sessionId: "s1",
      baselineId: "b1",
      sessionRevision: 2,
      savedRevision: 1,
      dirty: true,
      filename: "paper.docx",
      targetId: "target-1",
      paragraphRef: "para-1",
      text: "Text",
      revision: 2,
    })),
    suggestChange: vi.fn(async () => ({
      target: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
        filename: "paper.docx",
        targetId: "target-2",
        paragraphRef: "para-1",
        text: "Text",
        revision: 2,
      },
      proposed: "Changed",
      document: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
      },
    })),
    applySuggestion: vi.fn(async () => ({
      ok: true,
      changed: true,
      document: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 3,
        savedRevision: 1,
        dirty: true,
      },
    })),
    inspectTarget: vi.fn(async () => ({
      sessionId: "s1",
      baselineId: "b1",
      sessionRevision: 2,
      savedRevision: 1,
      dirty: true,
      filename: "paper.docx",
      targetId: "target-2",
      paragraphRef: "para-1",
      text: "Text",
      revision: 2,
    })),
    ...overrides,
  };
}

function pngBytes(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("source-authored DOCX equations", () => {
  const result = { ok: true, changed: true, revision: 3, warnings: [], sourceHash: "b".repeat(64), document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3, savedRevision: 1, dirty: true } };

  it("passes a revision-bound insertion and runtime attribution through the existing host", async () => {
    const writeEquation = vi.fn(async () => result);
    const attribution = { taskId: "task", memberId: "member" };
    const tool = createDocxTools(host({ writeEquation }), { attribution }).write_docx_equation;
    expect(await tool.execute({ session_id: "s1", paragraph_ref: "p1", expected_revision: 2, latex: "\\mathbb{R}^d", macros: "", offset: 4, display: false })).toEqual(result);
    expect(writeEquation).toHaveBeenCalledWith({ sessionId: "s1", paragraphRef: "p1", expectedRevision: 2, latex: "\\mathbb{R}^d", macros: "", offset: 4, display: false }, { attribution });
    expect(tool.inputSchema.required).toEqual(["paragraph_ref", "expected_revision", "latex"]);
  });

  it("preserves explicit replacement fingerprint and source adoption", async () => {
    const writeEquation = vi.fn(async () => result);
    await createDocxTools(host({ writeEquation })).write_docx_equation.execute({ paragraph_ref: "p1", expected_revision: 2, latex: "x+1", object_ref: "math-1", expected_fingerprint: "fingerprint", adopt_source: true });
    expect(writeEquation).toHaveBeenCalledWith({ paragraphRef: "p1", expectedRevision: 2, latex: "x+1", objectRef: "math-1", expectedFingerprint: "fingerprint", adoptSource: true }, undefined);
  });

  it.each([
    { object_ref: "math-1" },
    { object_ref: "math-1", expected_fingerprint: "f", offset: 0 },
    {}, { offset: -1 }, { offset: 0.2 }, { offset: 0, expected_fingerprint: "f" },
    { offset: 0, adopt_source: true }, { offset: 0, display: "block" },
  ])("rejects ambiguous or incomplete equation addresses (%j)", async (address) => {
    const writeEquation = vi.fn(async () => result);
    const response = await createDocxTools(host({ writeEquation })).write_docx_equation.execute({ paragraph_ref: "p1", expected_revision: 2, latex: "x", ...address });
    expect(response).toHaveProperty("error");
    expect(writeEquation).not.toHaveBeenCalled();
  });

  it("uses approval and rechecks cancellation before source compilation begins", async () => {
    const writeEquation = vi.fn(async () => result);
    const controller = new AbortController();
    const confirm = vi.fn(async () => { controller.abort(); return true; });
    expect(await createDocxTools(host({ writeEquation }), { confirm, signal: controller.signal }).write_docx_equation.execute({ paragraph_ref: "p1", expected_revision: 2, latex: "x", offset: 0 })).toHaveProperty("error");
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ tool: "write_docx_equation", diff: expect.objectContaining({ newText: expect.stringContaining('"latex": "x"') }) }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ diff: expect.objectContaining({ newText: expect.stringContaining('"display": false') }) }));
    expect(writeEquation).not.toHaveBeenCalled();
    expect(await createDocxTools(host({ writeEquation }), { confirm: async () => false }).write_docx_equation.execute({ paragraph_ref: "p1", expected_revision: 2, latex: "x", offset: 0 })).toMatchObject({ declined: true });
    expect(writeEquation).not.toHaveBeenCalled();
  });

  it("returns conversion diagnostics from the writing host", async () => {
    const writeEquation = vi.fn(async () => { throw new Error("Pandoc reported equation conversion loss: unsupported macro"); });
    expect(await createDocxTools(host({ writeEquation })).write_docx_equation.execute({ paragraph_ref: "p1", expected_revision: 2, latex: "x", offset: 0 })).toMatchObject({ error: expect.stringContaining("unsupported macro") });
  });
});

function imageDocument(revision = 2) {
  return {
    sessionId: "s1",
    baselineId: "b1",
    sessionRevision: revision,
    savedRevision: 1,
    dirty: revision !== 1,
    appProjectId: "p1",
    workbenchProjectId: "paper",
    title: "Paper",
    filename: "paper.docx",
    sourceSha256: "a".repeat(64),
  };
}

describe("DOCX business tools", () => {
  it("reads workspace identity and requests navigation without claiming it was displayed", async () => {
    const context = { viewed: null, writable: [], selectionWriteTarget: null, targeting: "explicit" };
    const workspaceContext = vi.fn(async () => context);
    const revealWorkingCopy = vi.fn(async () => ({ document: (await host().readDocument()).document, navigation: "requested" as const }));
    const tools = createDocxTools(host({ workspaceContext, revealWorkingCopy }));
    expect(await tools.get_docx_workspace_context.execute()).toBe(context);
    expect(await tools.reveal_docx_working_copy.execute({ session_id: "s1", paragraph_ref: "p1", expected_revision: 2 })).toMatchObject({ navigation: "requested" });
    expect(revealWorkingCopy).toHaveBeenCalledExactlyOnceWith({ sessionId: "s1", paragraphRef: "p1", expectedRevision: 2 });
    expect(await tools.reveal_docx_working_copy.execute({ expected_revision: -1 })).toHaveProperty("error");
    expect(revealWorkingCopy).toHaveBeenCalledOnce();
  });

  it("uses actual font and export receipts and honors cancelled authorization", async () => {
    const prepareFonts = vi.fn(async () => ({ missing: ["SimSun"], resolving: true }));
    const exportDocument = vi.fn(async () => ({ status: "cancelled", sessionRevision: 2 }));
    const tools = createDocxTools(host({ prepareFonts, exportDocument }));
    expect(await tools.prepare_docx_fonts.execute({ session_id: "s1" })).toEqual({ missing: ["SimSun"], resolving: true });
    expect(await tools.export_docx_document.execute({ session_id: "s1" })).toEqual({ status: "cancelled", sessionRevision: 2 });
    const blocked = createDocxTools(host({ prepareFonts, exportDocument }), { mutationAllowed: () => false });
    expect(await blocked.prepare_docx_fonts.execute({})).toHaveProperty("error");
    expect(await blocked.export_docx_document.execute({})).toHaveProperty("error");
    expect(prepareFonts).toHaveBeenCalledOnce();
    expect(exportDocument).toHaveBeenCalledOnce();
  });
  it("imports explicit retained template styles and rejects ambiguous or declined requests", async () => {
    const importTemplateStyles = vi.fn();
    const tools = createDocxTools(host({ importTemplateStyles }));
    await tools.import_docx_template_styles.execute({ template: "world-selected", expected_revision: 2, style_ids: ["Title", "Heading2"] });
    expect(importTemplateStyles).toHaveBeenCalledExactlyOnceWith(undefined, "world-selected", ["Title", "Heading2"], 2, undefined);
    importTemplateStyles.mockClear();
    expect(await tools.import_docx_template_styles.execute({ template: "world-selected", expected_revision: 2, style_ids: ["Title", "Title"] })).toHaveProperty("error");
    expect(await createDocxTools(host({ importTemplateStyles }), { confirm: async () => false }).import_docx_template_styles.execute({ template: "world-selected", expected_revision: 2, style_ids: ["Title"] })).toMatchObject({ declined: true });
    expect(importTemplateStyles).not.toHaveBeenCalled();
  });
  it("passes unified read filters and absolute model text windows without losing continuation fields", async () => {
    const readFormat = vi.fn();
    await createDocxTools(host({ readFormat })).read_docx_format.execute({ query: {
      kind: "paragraphs", object_kind: "paragraph", role: "heading", style_id: "Heading2",
      object_id: "/word/document.xml#0.2", text: "Text", text_offset: 4000, text_limit: 2000,
      offset: 1, limit: 3,
    } });
    expect(readFormat).toHaveBeenCalledExactlyOnceWith(undefined, {
      kind: "paragraphs", objectKind: "paragraph", role: "heading", styleId: "Heading2",
      objectId: "/word/document.xml#0.2", text: "Text", textOffset: 4000, textLimit: 2000, offset: 1, limit: 3,
    });
  });

  it("routes one atomic group and refuses invalid range scopes before mutation", async () => {
    const formatBatch = vi.fn(async () => ({ ok: true, changed: true,
      document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3, savedRevision: 1, dirty: true } }));
    const tools = createDocxTools(host({ formatBatch }));
    expect(await tools.apply_docx_format_batch.execute({ expected_revision: 2, operations: [
      { paragraph_ref: "p1", range: { start: 3, end: 7 }, font: { name: "Times New Roman" } },
      { paragraph_ref: "p2", scope: "frame", frame: null },
      { paragraph_ref: "p2", scope: "section", section: { columns: { count: 2 } } },
    ] })).toMatchObject({ ok: true });
    expect(formatBatch).toHaveBeenCalledExactlyOnceWith(undefined, 2, [
      { paragraphRef: "p1", range: { start: 3, end: 7 }, font: { name: "Times New Roman" } },
      { paragraphRef: "p2", objectFormat: { kind: "frame", frame: null } },
      { paragraphRef: "p2", objectFormat: { kind: "section", section: { columns: { count: 2 } } } },
    ], undefined);
    formatBatch.mockClear();
    expect(await tools.apply_docx_format_batch.execute({ expected_revision: 2, operations: [
      { paragraph_ref: "p1", range: { start: 0, end: 3 }, font: { bold: true } },
      { paragraph_ref: "p2", range: { start: 0, end: 3 }, paragraph: { keepNext: true } },
    ] })).toHaveProperty("error");
    expect(formatBatch).not.toHaveBeenCalled();
  });

  it("carries an exact font range through the ordinary format tool", async () => {
    const formatBatch = vi.fn();
    await createDocxTools(host({ formatBatch })).apply_docx_format.execute({ paragraph_ref: "p1", expected_revision: 2,
      range: { start: 2, end: 5 }, font: { bold: true } });
    expect(formatBatch).toHaveBeenCalledWith(undefined, 2, [{ paragraphRef: "p1", range: { start: 2, end: 5 }, font: { bold: true } }], undefined);
  });
  it("routes containing-cell formatting and rejects mixed scopes before mutation", async () => {
    const formatObject = vi.fn(async () => ({
      ok: true as const, changed: true,
      document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3, savedRevision: 1, dirty: true },
    }));
    const api = host({ formatObject, formatParagraph: vi.fn() });
    const tools = createDocxTools(api);
    expect(await tools.apply_docx_format.execute({
      session_id: "s1", paragraph_ref: "para-1", expected_revision: 2,
      scope: "cell", cell: { fill: "D9EAF7", verticalAlignment: "center" },
    })).toMatchObject({ ok: true, changed: true });
    expect(formatObject).toHaveBeenCalledWith("s1", "para-1", 2, {
      kind: "cell", cell: { fill: "D9EAF7", verticalAlignment: "center" },
    }, undefined);
    formatObject.mockClear();
    expect(await tools.apply_docx_format.execute({
      paragraph_ref: "para-1", expected_revision: 2,
      scope: "cell", cell: { fill: null }, font: { bold: true },
    })).toHaveProperty("error");
    expect(await tools.apply_docx_format.execute({
      paragraph_ref: "para-1", expected_revision: 2, cell: { fill: null },
    })).toHaveProperty("error");
    expect(formatObject).not.toHaveBeenCalled();
    expect(api.formatParagraph).not.toHaveBeenCalled();
  });

  it("delegates list, read, capture, suggestion and application to one host", async () => {
    const api = host();
    const tools = createDocxTools(api);

    await tools.list_docx_documents.execute();
    await tools.read_docx_document.execute({ session_id: "s1" });
    await tools.capture_docx_target.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
    });
    await tools.suggest_docx_change.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
      instruction: "Revise",
      expected_revision: 2,
    });
    await tools.apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    });

    expect(api.readDocument).toHaveBeenCalledWith({
      sessionId: "s1", offset: 0, limit: 20,
    });
    expect(api.captureTarget).toHaveBeenCalledWith("s1", "para-1");
    expect(api.suggestChange).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        paragraphRef: "para-1",
        instruction: "Revise",
        expectedRevision: 2,
      },
      undefined,
    );
    expect(api.applySuggestion).toHaveBeenCalledWith(
      {
        targetId: "target-2",
        expectedRevision: 2,
        text: "Changed",
      },
      undefined,
    );
    expect(api.inspectTarget).toHaveBeenCalledWith("target-2");
  });

  it("passes only the attribution supplied by the runtime to mutations", async () => {
    const api = host();
    const attribution = Object.freeze({
      taskId: "task-1",
      workId: "work-1",
      memberId: "member-1",
      executionId: "execution-1",
    });
    const tools = createDocxTools(api, { attribution });

    await tools.apply_docx_suggestion.execute({
      target_id: "target-1",
      expected_revision: 2,
      text: "Changed",
    });

    expect(api.applySuggestion).toHaveBeenCalledWith(
      expect.any(Object),
      { attribution },
    );
  });

  it("reads a structured page and maps a protected model range to the host", async () => {
    const readDocument = vi.fn(async (query) => {
      expect(query).toEqual({
        sessionId: "s1", offset: 3, limit: 2, expectedRevision: 2,
      });
      return {
        document: {
          sessionId: "s1", sourceSha256: "a".repeat(64), appProjectId: "p1",
          workbenchProjectId: "paper", title: "Paper", filename: "paper.docx",
          baselineId: "b1", sessionRevision: 2, savedRevision: 1, dirty: true,
        },
        paragraphs: [{
          paragraphRef: "para-1", text: "ledgers [1]", modelText: "ledgers [\uFFFC]",
          displayText: "ledgers [1]", revision: 2,
          atoms: [{ objectRef: "field-1", kind: "field" as const, modelRange: { start: 9, end: 10 },
            displayRange: { start: 9, end: 12 }, displayText: "1", readable: true,
            complete: true, editable: false as const,
            payload: { instruction: " REF Bookmark " } }],
          editableRanges: [{ start: 0, end: 7 }],
        }],
        offset: 3, nextOffset: null, totalParagraphs: 4, nextQuery: null,
      };
    });
    const replaceTextRange = vi.fn(async () => ({
      ok: true, changed: true, revision: 3,
      document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3,
        savedRevision: 1, dirty: true },
    }));
    const tools = createDocxTools(host({ readDocument, replaceTextRange }));
    const page = await tools.read_docx_document.execute({
      session_id: "s1", offset: 3, limit: 2, expected_revision: 2,
    });
    expect(page).toMatchObject({
      offset: 3, totalParagraphs: 4,
      paragraphs: [{ paragraphRef: "para-1", text: "ledgers [1]",
        modelText: "ledgers [\uFFFC]", atoms: [{ kind: "field" }] }],
    });
    expect(await tools.replace_docx_text_range.execute({
      session_id: "s1", paragraph_ref: "para-1", expected_revision: 2,
      range: { start: 0, end: 7 }, expected_text: "ledgers", replacement: "records",
    })).toMatchObject({ ok: true, changed: true });
    expect(replaceTextRange).toHaveBeenCalledWith({
      sessionId: "s1", paragraphRef: "para-1", expectedRevision: 2,
      range: { start: 0, end: 7 }, expectedText: "ledgers", replacement: "records",
    }, undefined);
  });

  it("sends DOCX pixels through the image channel and returns metadata only", async () => {
    const bytes = pngBytes(2, 3);
    const readImage = vi.fn(async () => ({
      revision: 2,
      objectRef: "drawing-1",
      part: "word/document.xml",
      relationshipId: "rId5",
      mediaPart: "word/media/image1.png",
      mimeType: "image/png",
      bytes,
      imageSha256: "b".repeat(64),
      document: imageDocument(),
      sourceSha256: "a".repeat(64),
      description: "Figure 1",
      widthEmu: 914_400,
      heightEmu: 1_371_600,
    }));
    const onImage = vi.fn();
    const tools = createDocxTools(host({ readImage }), { onImage, imageSupported: true });
    const result = await tools.read_docx_image.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
      object_ref: "drawing-1",
      expected_revision: 2,
    });
    expect(result).toMatchObject({
      source: "live-docx",
      imageReadComplete: true,
      contentStatus: "pixels_provided",
      editable: false,
      document: imageDocument(),
      sourceSha256: "a".repeat(64),
      sessionId: "s1",
      paragraphRef: "para-1",
      objectRef: "drawing-1",
      revision: 2,
      mimeType: "image/png",
      imageSha256: "b".repeat(64),
      width: 2,
      height: 3,
      relationshipId: "rId5",
      mediaPart: "word/media/image1.png",
    });
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(JSON.stringify(result)).not.toMatch(/\bbytes\b/);
    expect(result).not.toHaveProperty("complete");
    expect(onImage).toHaveBeenCalledExactlyOnceWith(
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    );
    expect(readImage).toHaveBeenCalledWith("s1", {
      paragraphRef: "para-1",
      objectRef: "drawing-1",
      expectedRevision: 2,
    });
  });

  it("refuses stale, unsupported, over-budget and transport-less DOCX images", async () => {
    const valid = {
      revision: 2,
      objectRef: "drawing-1",
      part: "word/document.xml",
      relationshipId: "rId5",
      mediaPart: "word/media/image1.png",
      mimeType: "image/png",
      bytes: pngBytes(),
      imageSha256: "b".repeat(64),
      document: imageDocument(),
      sourceSha256: "a".repeat(64),
    };
    const readImage = vi.fn(async () => valid);
    const request = {
      paragraph_ref: "para-1",
      object_ref: "drawing-1",
      expected_revision: 2,
    };
    const onImage = vi.fn();
    const tools = createDocxTools(host({ readImage }), { onImage });

    expect(await tools.read_docx_image.execute({ ...request, expected_revision: 3 }))
      .toMatchObject({ error: expect.stringContaining("requested revision") });
    expect(await tools.read_docx_image.execute({ ...request, object_ref: "drawing-2" }))
      .toMatchObject({ error: expect.stringContaining("requested revision and object") });

    readImage.mockResolvedValueOnce({ ...valid, mimeType: "image/jpeg" });
    expect(await tools.read_docx_image.execute(request))
      .toMatchObject({ error: expect.stringContaining("does not match") });

    readImage.mockResolvedValueOnce({
      ...valid,
      document: { ...valid.document, sessionRevision: 3 },
    });
    expect(await tools.read_docx_image.execute(request))
      .toMatchObject({ error: expect.stringContaining("current document source identity") });

    readImage.mockResolvedValueOnce({ ...valid, sourceSha256: "c".repeat(64) });
    expect(await tools.read_docx_image.execute(request))
      .toMatchObject({ error: expect.stringContaining("current document source identity") });

    readImage.mockResolvedValueOnce({ ...valid, bytes: new Uint8Array(8 * 1024 * 1024 + 1) });
    expect(await tools.read_docx_image.execute(request))
      .toMatchObject({ error: expect.stringContaining("MiB limit") });
    expect(onImage).not.toHaveBeenCalled();

    expect(await createDocxTools(host({ readImage })).read_docx_image.execute(request))
      .toEqual({ unavailable: true, error: "The active Agent transport cannot receive DOCX images." });
    expect(await createDocxTools(host(), { onImage }).read_docx_image.execute(request))
      .toEqual({ unavailable: true, error: "Live DOCX image reading is unavailable." });

    readImage.mockClear();
    expect(await createDocxTools(host({ readImage }), {
      onImage,
      imageSupported: false,
    }).read_docx_image.execute(request)).toMatchObject({
      error: expect.stringContaining("does not accept image input"),
    });
    expect(readImage).not.toHaveBeenCalled();
  });

  it("explains math, object-route and image boundaries in DOCX read schemas", () => {
    const tools = createDocxTools(host());
    expect(tools.read_docx_document.description).toContain("readableMath");
    expect(tools.read_docx_document.description).toContain("read_docx_image");
    expect(tools.read_docx_document.description).toContain("fields");
    expect(tools.read_docx_document.description).toContain("modelText");
    expect(tools.read_docx_image.description).toContain("actual PNG, JPEG or GIF pixels");
    expect(tools.read_docx_image.description).toContain("field");
    expect(tools.read_docx_image.inputSchema.required).toEqual([
      "paragraph_ref",
      "object_ref",
      "expected_revision",
    ]);
  });

  it("requires a text window to fit and does not split ranges across display coordinates", async () => {
    const readDocument = vi.fn();
    const tools = createDocxTools(host({ readDocument }));
    expect(await tools.read_docx_document.execute({
      offset: 0, limit: 20, text_offset: 4,
    })).toHaveProperty("error");
    expect(await tools.read_docx_document.execute({
      expected_revision: -1,
    })).toHaveProperty("error");
    expect(readDocument).not.toHaveBeenCalled();
    expect(await tools.replace_docx_text_range.execute({
      paragraph_ref: "p1", expected_revision: 2,
      range: { start: 4, end: 4 }, expected_text: "", replacement: "x",
    })).toHaveProperty("error");
  });

  it("emits snake_case continuations that can be replayed unchanged", async () => {
    const document = {
      sessionId: "s1", sourceSha256: "a".repeat(64), appProjectId: "p1",
      workbenchProjectId: "paper", title: "Paper", filename: "paper.docx",
      baselineId: "b1", sessionRevision: 2, savedRevision: 1, dirty: true,
    };
    const readDocument = vi.fn()
      .mockResolvedValueOnce({
        document,
        paragraphs: [{
          paragraphRef: "p1", text: "\uFFFC", modelText: "\uFFFC", displayText: "\uFFFC",
          revision: 2, editableRanges: [], atoms: [{
            objectRef: "math", kind: "math" as const,
            modelRange: { start: 0, end: 1 }, displayRange: { start: 0, end: 1 },
            displayText: "\uFFFC", readable: true, complete: true, editable: false as const,
            payloadJson: "{\"formula\":", payloadOffset: 0, payloadLength: 100,
            payloadContinuation: {
              sessionId: "s1", offset: 0, limit: 20, expectedRevision: 2,
              textOffset: 0, textLimit: 1, atomOffset: 0, payloadOffset: 11,
            },
          }],
        }],
        offset: 0, nextOffset: 1, totalParagraphs: 2,
        nextQuery: {
          sessionId: "s1", offset: 1, limit: 20, expectedRevision: 2,
          textOffset: 0, textLimit: 1, atomOffset: 0, payloadOffset: 11,
        },
      })
      .mockResolvedValueOnce({
        document, paragraphs: [], offset: 1, nextOffset: null,
        totalParagraphs: 2, nextQuery: null,
      });
    const tools = createDocxTools(host({ readDocument }));
    const first = await tools.read_docx_document.execute({ session_id: "s1" }) as {
      next_query: Record<string, unknown>;
      paragraphs: { atoms: Record<string, unknown>[] }[];
    };
    expect(first).toMatchObject({
      next_query: {
        session_id: "s1", offset: 1, limit: 20, expected_revision: 2,
        text_offset: 0, text_limit: 1, atom_offset: 0, payload_offset: 11,
      },
      paragraphs: [{ atoms: [{ payload_continuation: {
        session_id: "s1", offset: 0, limit: 20, expected_revision: 2,
        text_offset: 0, text_limit: 1, atom_offset: 0, payload_offset: 11,
      } }] }],
    });
    expect(first).not.toHaveProperty("nextQuery");
    expect(first.paragraphs[0].atoms[0]).not.toHaveProperty("payloadContinuation");
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(10_000);
    await tools.read_docx_document.execute(first.next_query);
    expect(readDocument).toHaveBeenLastCalledWith({
      sessionId: "s1", offset: 1, limit: 20, expectedRevision: 2,
      textOffset: 0, textLimit: 1, atomOffset: 0, payloadOffset: 11,
    });
  });

  it("returns host failures as tool errors", async () => {
    const api = host({
      readDocument: vi.fn(async () => {
        throw new Error("not bound");
      }),
    });
    expect(await createDocxTools(api).read_docx_document.execute({})).toEqual({
      error: "Error: not bound",
    });
  });

  it("asks with a diff, then rechecks cancellation and the target before applying", async () => {
    const api = host();
    const confirm = vi.fn(async () => true);
    const mutationAllowed = vi.fn(() => true);
    const tools = createDocxTools(api, { confirm, mutationAllowed });

    await tools.apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    });

    expect(confirm).toHaveBeenCalledWith({
      tool: "apply_docx_suggestion",
      summary: "Apply a DOCX suggestion to paper.docx at para-1",
      path: "paper.docx#para-1",
      diff: {
        path: "paper.docx#para-1",
        oldText: "Text",
        newText: "Changed",
      },
    });
    expect(api.inspectTarget).toHaveBeenCalledTimes(2);
    expect(mutationAllowed).toHaveBeenCalledTimes(2);
    expect(api.applySuggestion).toHaveBeenCalledOnce();
  });

  it("does not apply after a decline or cancellation", async () => {
    const declinedApi = host();
    expect(await createDocxTools(declinedApi, {
      confirm: async () => false,
    }).apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    })).toMatchObject({ declined: true });
    expect(declinedApi.applySuggestion).not.toHaveBeenCalled();

    const cancelledApi = host();
    expect(await createDocxTools(cancelledApi, {
      confirm: async () => true,
      mutationAllowed: () => false,
    }).apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    })).toEqual({
      error: "The external request was cancelled before mutation.",
    });
    expect(cancelledApi.applySuggestion).not.toHaveBeenCalled();
  });

  it("does not apply when the target changes while approval is pending", async () => {
    const inspectTarget = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
        filename: "paper.docx",
        targetId: "target-2",
        paragraphRef: "para-1",
        text: "Text",
        revision: 2,
      })
      .mockRejectedValueOnce(
        new Error("The DOCX suggestion target changed since it was captured."),
      );
    const api = host({ inspectTarget });

    expect(await createDocxTools(api, {
      confirm: async () => true,
    }).apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    })).toEqual({
      error:
        "Error: The DOCX suggestion target changed since it was captured.",
    });
    expect(inspectTarget).toHaveBeenCalledTimes(2);
    expect(api.applySuggestion).not.toHaveBeenCalled();
  });

  it("reads live format scope and applies a revisioned font and paragraph change", async () => {
    const api = host({
      readFormat: vi.fn(async (
        _sessionId: string | undefined,
        _query: DocxFormatReadQuery,
      ): Promise<DocxFormatReadResult> => ({
        document: { sessionId: "s1", baselineId: "b1", sessionRevision: 2,
          savedRevision: 1, dirty: true, filename: "paper.docx" },
        sourceSha256: "c".repeat(64),
        revision: 2,
        paragraph: {
          paragraphRef: "para-1",
          text: "Text",
          revision: 2,
          font: { bold: null, italic: null, underline: null, strikeThrough: null,
            highlightColor: null, subscript: null, superscript: null,
            name: null, size: null, color: null },
          paragraph: { alignment: "Left" as const, style: null, firstLineIndent: null,
            leftIndent: null, rightIndent: null, lineSpacing: null, spaceBefore: null,
            spaceAfter: null, widowControl: null, keepNext: null, keepLines: null,
            pageBreakBefore: null, readingOrder: "LeftToRight" as const },
        },
        nextOffset: null,
      })),
      formatParagraph: vi.fn(async () => ({
        revision: 3,
        ok: true,
        changed: true,
        document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3,
          savedRevision: 1, dirty: true },
      })),
    });
    const confirm = vi.fn(async () => true);
    const mutationAllowed = vi.fn(() => true);
    const tools = createDocxTools(api, { confirm, mutationAllowed });

    expect(await tools.read_docx_format.execute({
      session_id: "s1",
      query: { paragraph_ref: "para-1", offset: 0, limit: 1, expected_revision: 2 },
    })).toMatchObject({
      sourceSha256: "c".repeat(64),
      paragraph: {
        paragraphRef: "para-1",
        paragraph: {
          keepNext: null,
          keepLines: null,
          pageBreakBefore: null,
        },
      },
    });
    expect(await tools.apply_docx_format.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
      expected_revision: 2,
      font: { name: "Arial", size: 12 },
      paragraph: {
        alignment: "Centered",
        spaceAfter: 6,
        keepNext: true,
        keepLines: false,
        pageBreakBefore: true,
      },
    })).toMatchObject({ ok: true, changed: true, revision: 3 });

    expect(api.readFormat).toHaveBeenNthCalledWith(1, "s1", {
      paragraphRef: "para-1",
      offset: 0,
      limit: 1,
      expectedRevision: 2,
    });
    expect(api.formatParagraph).toHaveBeenCalledWith(
      "s1",
      "para-1",
      2,
      {
        font: { name: "Arial", size: 12 },
        paragraph: {
          alignment: "Centered",
          spaceAfter: 6,
          keepNext: true,
          keepLines: false,
          pageBreakBefore: true,
        },
      },
      undefined,
    );
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      tool: "apply_docx_format",
      summary: "Format a DOCX paragraph in paper.docx at para-1",
      diff: expect.objectContaining({
        path: "paper.docx#para-1",
        oldText: expect.stringContaining('"alignment": "Left"'),
        newText: expect.stringContaining('"name": "Arial"'),
      }),
    }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      diff: expect.objectContaining({
        newText: expect.stringContaining('"keepNext": true'),
      }),
    }));
    expect(mutationAllowed).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid format continuation revision before reading", async () => {
    const api = host({ readFormat: vi.fn() });
    const tools = createDocxTools(api);
    for (const revision of [-1, 1.5, "2", null]) {
      expect(await tools.read_docx_format.execute({
        query: { kind: "paragraphs", offset: 20, expected_revision: revision },
      })).toEqual({ error: "Error: expected_revision must be a non-negative session revision." });
    }
    expect(api.readFormat).not.toHaveBeenCalled();
  });

  it("does not format after a declined approval or a cancellation", async () => {
    const readFormat = vi.fn(async () => ({
      document: { sessionId: "s1", baselineId: "b1", sessionRevision: 2,
        savedRevision: 1, dirty: true, filename: "paper.docx" },
      sourceSha256: "c".repeat(64), revision: 2, nextOffset: null,
    }));
    const declined = host({ readFormat, formatParagraph: vi.fn() });
    expect(await createDocxTools(declined, {
      confirm: async () => false,
    }).apply_docx_format.execute({
      paragraph_ref: "para-1", expected_revision: 2, font: { bold: true },
    })).toMatchObject({ declined: true });
    expect(declined.formatParagraph).not.toHaveBeenCalled();

    const cancelledApi = host({ formatParagraph: vi.fn() });
    const controller = new AbortController();
    controller.abort();
    expect(await createDocxTools(cancelledApi, {
      signal: controller.signal,
    }).apply_docx_format.execute({
      paragraph_ref: "para-1", expected_revision: 2, font: { bold: true },
    })).toEqual({
      error: "The external request was cancelled before mutation.",
    });
    expect(cancelledApi.formatParagraph).not.toHaveBeenCalled();

    const committed = new AbortController();
    const committedApi = host({
      formatParagraph: vi.fn(async () => {
        committed.abort();
        return { ok: true, changed: true, revision: 3,
          document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3,
            savedRevision: 1, dirty: true } };
      }),
    });
    expect(await createDocxTools(committedApi, { signal: committed.signal })
      .apply_docx_format.execute({
        paragraph_ref: "para-1", expected_revision: 2, font: { bold: true },
      })).toMatchObject({ ok: true, changed: true, revision: 3 });
  });

  it("saves at the explicit revision and checks only the supplied world version", async () => {
    const saveDocument = vi.fn(async () => ({
      baselineId: "b2", revision: 3, sourceSha256: "d".repeat(64),
      document: { sessionId: "s1", baselineId: "b2", sessionRevision: 3,
        savedRevision: 3, dirty: false },
    }));
    const checkTemplate = vi.fn(async (session, template) => ({
      template,
      check: { project_id: session === "s1" ? "paper" : "" },
    }));
    const api = host({ saveDocument, checkTemplate });
    const controller = new AbortController();
    const tools = createDocxTools(api, { signal: controller.signal });

    expect(await tools.save_docx_document.execute({
      session_id: "s1", expected_revision: 3,
    })).toMatchObject({ baselineId: "b2", revision: 3 });
    expect(await tools.check_docx_template.execute({
      session_id: "s1", template: "world-v7",
    })).toEqual({
      template: "world-v7",
      check: { project_id: "paper" },
    });
    expect(saveDocument).toHaveBeenCalledWith(
      "s1",
      3,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(checkTemplate).toHaveBeenCalledWith(
      "s1",
      "world-v7",
      expect.objectContaining({ signal: controller.signal }),
    );

    const saved = new AbortController();
    expect(await createDocxTools(host({
      saveDocument: vi.fn(async () => {
        saved.abort();
        return {
          baselineId: "b2", revision: 3, sourceSha256: "d".repeat(64),
          document: { sessionId: "s1", baselineId: "b2", sessionRevision: 3,
            savedRevision: 3, dirty: false },
        };
      }),
    }), { signal: saved.signal }).save_docx_document.execute({
      expected_revision: 3,
    })).toMatchObject({ baselineId: "b2", revision: 3 });

    const checked = new AbortController();
    expect(await createDocxTools(host({
      checkTemplate: vi.fn(async () => {
        checked.abort();
        return { template: "world-v7", check: { check_id: "check-7" } };
      }),
    }), { signal: checked.signal }).check_docx_template.execute({
      template: "world-v7",
    })).toMatchObject({ template: "world-v7", check: { check_id: "check-7" } });
  });

  it("returns unavailable capabilities instead of inventing a fallback", async () => {
    const tools = createDocxTools(host());
    for (const [run, error] of [
      [() => tools.read_docx_format.execute({}), "Live DOCX format reading is unavailable."],
      [() => tools.apply_docx_format.execute({ paragraph_ref: "para-1",
        expected_revision: 2, font: { bold: true } }), "Live DOCX formatting is unavailable for the requested scope."],
      [() => tools.save_docx_document.execute({ expected_revision: 2 }),
        "Live DOCX saving is unavailable."],
      [() => tools.check_docx_template.execute({ template: "world-v7" }),
        "Explicit DOCX template checking is unavailable."],
    ] as const) expect(await run()).toEqual({ unavailable: true, error });
  });
});

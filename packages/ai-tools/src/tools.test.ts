import { describe, expect, it, vi } from "vitest";
import {
  createDocxTools,
  createFigureTools,
  createOleaflyTools,
  type AiToolsHost,
  type DocxFormatReadResult,
  type DocxImageReadHostResult,
  type DocxToolsHost,
  type RevealLocationResult,
} from "./tools";

function makeHost(
  revealLocation?: (target: {
    path?: string;
    line?: number;
    page?: number;
  }) => Promise<RevealLocationResult>,
): AiToolsHost {
  return {
    getProjectId: () => "proj",
    ...(revealLocation ? { revealLocation } : {}),
  } as unknown as AiToolsHost;
}

function makeDocxHost(overrides: Partial<DocxToolsHost>): DocxToolsHost {
  return overrides as unknown as DocxToolsHost;
}

function readableFormat(): DocxFormatReadResult {
  return {
    document: {
      sessionId: "s1",
      baselineId: "b1",
      sessionRevision: 2,
      savedRevision: 1,
      dirty: true,
      filename: "paper.docx",
    },
    sourceSha256: "a".repeat(64),
    revision: 2,
    nodes: [{ object_id: "word/document.xml#0.2", kind: "paragraph" }],
    total: 1,
    nextOffset: null,
  };
}

function docxPng(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function imageResult(): DocxImageReadHostResult {
  return {
    revision: 2,
    objectRef: "drawing-1",
    part: "word/document.xml",
    relationshipId: "rId5",
    mediaPart: "word/media/image1.png",
    mimeType: "image/png",
    bytes: docxPng(),
    imageSha256: "b".repeat(64),
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
    sourceSha256: "a".repeat(64),
  };
}

describe("show_location tool", () => {
  it("declares an optional path/line/page schema", () => {
    const tool = createOleaflyTools(makeHost()).show_location;
    expect(tool.description).toContain("SyncTeX");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: [],
      additionalProperties: false,
    });
    expect(tool.inputSchema.properties).toMatchObject({
      path: { type: "string" },
      line: { type: "integer", minimum: 1 },
      page: { type: "integer", minimum: 1 },
    });
  });

  it("refuses a call with neither a path nor a page", async () => {
    const reveal = vi.fn();
    const tools = createOleaflyTools(makeHost(reveal));
    const result = await tools.show_location.execute({});
    expect(result).toMatchObject({ error: expect.stringContaining("Pass a path") });
    expect(reveal).not.toHaveBeenCalled();
  });

  it("rejects a line or page below one, or a fractional one", async () => {
    const reveal = vi.fn();
    const tools = createOleaflyTools(makeHost(reveal));
    expect(await tools.show_location.execute({ path: "main.tex", line: 0 })).toMatchObject({
      error: expect.stringContaining("line"),
    });
    expect(await tools.show_location.execute({ page: 2.5 })).toMatchObject({
      error: expect.stringContaining("page"),
    });
    expect(await tools.show_location.execute({ path: 12 })).toMatchObject({
      error: expect.stringContaining("path"),
    });
    expect(reveal).not.toHaveBeenCalled();
  });

  it("reveals a file line and echoes what it revealed", async () => {
    const reveal = vi.fn(async () => ({ revealed: true }));
    const tools = createOleaflyTools(makeHost(reveal));

    const result = await tools.show_location.execute({ path: "sections/intro.tex", line: 42 });

    expect(reveal).toHaveBeenCalledWith({ path: "sections/intro.tex", line: 42 });
    expect(result).toEqual({ success: true, revealed: true, path: "sections/intro.tex", line: 42 });
  });

  it("passes a page-only request straight through", async () => {
    const reveal = vi.fn(async () => ({ revealed: true }));
    const tools = createOleaflyTools(makeHost(reveal));

    const result = await tools.show_location.execute({ page: 7 });

    expect(reveal).toHaveBeenCalledWith({ page: 7 });
    expect(result).toEqual({ success: true, revealed: true, page: 7 });
  });

  it("keeps the host note when only part of the jump worked", async () => {
    const reveal = vi.fn(async () => ({
      revealed: true,
      note: "The PDF preview did not move.",
    }));
    const tools = createOleaflyTools(makeHost(reveal));

    const result = await tools.show_location.execute({ path: "main.tex", line: 3 });

    expect(result).toEqual({
      success: true,
      revealed: true,
      path: "main.tex",
      line: 3,
      note: "The PDF preview did not move.",
    });
  });

  it("reports a failed reveal as an error with the host's reason", async () => {
    const reveal = vi.fn(async () => ({ revealed: false, note: "No project open." }));
    const tools = createOleaflyTools(makeHost(reveal));

    expect(await tools.show_location.execute({ path: "main.tex" })).toEqual({
      error: "No project open.",
    });
  });

  it("gives a generic reason when the host gives none", async () => {
    const reveal = vi.fn(async () => ({ revealed: false }));
    const tools = createOleaflyTools(makeHost(reveal));

    expect(await tools.show_location.execute({ page: 3 })).toEqual({
      error: "Could not reveal that location.",
    });
  });

  it("stays usable on a host that cannot reveal anything", async () => {
    const tools = createOleaflyTools(makeHost());
    expect(await tools.show_location.execute({ path: "main.tex" })).toMatchObject({
      error: expect.stringContaining("no editor or preview"),
    });
  });

  it("never throws when the host rejects", async () => {
    const reveal = vi.fn(async () => {
      throw new Error("viewer gone");
    });
    const tools = createOleaflyTools(makeHost(reveal));

    expect(await tools.show_location.execute({ page: 1 })).toMatchObject({
      error: expect.stringContaining("viewer gone"),
    });
  });
});

describe("insert_figure tool", () => {
  function figureHost(overrides: Partial<AiToolsHost> = {}): AiToolsHost {
    return {
      getProjectId: () => "proj",
      prepareExternalMutation: vi.fn(async () => 3),
      getLastFigurePreview: () => ({ pdfBytes: new Uint8Array([1]) }),
      pdfToPng: vi.fn(async () => "data:image/png;base64,AAAA"),
      getFigureInsertTarget: () => null,
      insertAtCursor: vi.fn(async () => true),
      replaceRange: vi.fn(async () => true),
      writeProjectBytes: vi.fn(async () => ({})),
      refreshTree: vi.fn(async () => {}),
      insertTargetPath: () => "chapters/results.tex",
      ...overrides,
    } as unknown as AiToolsHost;
  }

  it("names the document it edited and the PNG it saved, so the turn can claim both", async () => {
    const host = figureHost();
    const tools = createFigureTools(host);

    const result = await tools.insert_figure.execute({ code: String.raw`\draw (0,0);`, caption: "Loss curve" });

    expect(host.insertAtCursor).toHaveBeenCalled();
    expect(host.writeProjectBytes).toHaveBeenCalledWith("proj", "figures/loss-curve.png", "AAAA", 3);
    expect(result).toEqual({
      success: true,
      path: "chapters/results.tex",
      figure: "figures/loss-curve.png",
    });
  });

  it("leaves out the PNG when there was no preview to save", async () => {
    const host = figureHost({ getLastFigurePreview: () => null });
    const tools = createFigureTools(host);

    const result = await tools.insert_figure.execute({ code: String.raw`\draw (0,0);` });

    expect(host.writeProjectBytes).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, path: "chapters/results.tex" });
  });

  it("leaves out the PNG when saving it failed", async () => {
    const host = figureHost({ writeProjectBytes: vi.fn(async () => { throw new Error("disk full"); }) });
    const tools = createFigureTools(host);

    const result = await tools.insert_figure.execute({ code: String.raw`\draw (0,0);`, label: "fig:a" });

    expect(result).toEqual({ success: true, path: "chapters/results.tex" });
  });
});

describe("figure tools in a Typst project", () => {
  const CANVAS = '#import "@preview/cetz:0.4.2"\n#cetz.canvas({ cetz.draw.circle((0, 0)) })';

  function typstHost(overrides: Partial<AiToolsHost> = {}): AiToolsHost {
    let preview: unknown = null;
    return {
      getProjectId: () => "proj",
      getFigureEngine: () => "typst",
      renderTypstFigure: vi.fn(async () => ({ ok: true, pngBase64: "UE5H", diagnostics: [] })),
      compileIsolated: vi.fn(),
      readIsolatedPdf: vi.fn(),
      pdfToPng: vi.fn(),
      setLastFigurePreview: vi.fn((value: unknown) => {
        preview = value;
      }),
      getLastFigurePreview: () => preview,
      getFigureInsertTarget: () => null,
      prepareExternalMutation: vi.fn(async () => 7),
      insertAtCursor: vi.fn(async () => true),
      replaceRange: vi.fn(async () => true),
      writeProjectBytes: vi.fn(async () => ({})),
      refreshTree: vi.fn(async () => {}),
      readFileContent: vi.fn(async () => "= Results\n"),
      insertTargetPath: () => "main.typ",
      ...overrides,
    } as unknown as AiToolsHost;
  }

  it("previews through the Typst renderer and hands the image to the model", async () => {
    const host = typstHost();
    const onImage = vi.fn();
    const tools = createFigureTools(host, { onImage });

    const result = await tools.preview_figure.execute({ code: CANVAS });

    expect(host.renderTypstFigure).toHaveBeenCalledWith(
      "proj",
      `#set page(fill: white, margin: 6pt)\n${CANVAS}`,
    );
    expect(host.compileIsolated).not.toHaveBeenCalled();
    expect(onImage).toHaveBeenCalledWith("data:image/png;base64,UE5H");
    expect(host.setLastFigurePreview).toHaveBeenCalledWith({
      pngDataUrl: "data:image/png;base64,UE5H",
      projectId: "proj",
    });
    expect(result).toEqual({ success: true, has_image: true, errors: [], warnings: [] });
  });

  it("reports Typst errors against the model's own line numbers and clears the old preview", async () => {
    const host = typstHost({
      renderTypstFigure: vi.fn(async () => ({
        ok: false as const,
        diagnostics: [
          { severity: "error" as const, message: "unknown variable: cetz", line: 3, column: 2 },
        ],
      })),
    });
    const onImage = vi.fn();
    const tools = createFigureTools(host, { onImage });

    const result = await tools.preview_figure.execute({ code: "#cetz.canvas({})" });

    expect(onImage).not.toHaveBeenCalled();
    expect(host.setLastFigurePreview).toHaveBeenCalledWith(null);
    expect(result).toEqual({
      success: false,
      has_image: false,
      warnings: [],
      errors: [{ severity: "error", message: "unknown variable: cetz", line: 2, column: 2 }],
    });
  });

  it("inserts a #figure with its caption and label, and saves the previewed PNG", async () => {
    const confirm = vi.fn(async () => true);
    const host = typstHost();
    const tools = createFigureTools(host, { confirm });
    await tools.preview_figure.execute({ code: CANVAS });

    const result = await tools.insert_figure.execute({
      code: CANVAS,
      caption: "Unit circle",
      label: "fig:circle",
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "insert_figure", image: "data:image/png;base64,UE5H" }),
    );
    expect(host.insertAtCursor).toHaveBeenCalledWith(
      "proj",
      '#import "@preview/cetz:0.4.2"\n#figure(caption: [Unit circle])[\n  #cetz.canvas({ cetz.draw.circle((0, 0)) })\n] <fig:circle>',
      expect.any(Function),
    );
    expect(host.pdfToPng).not.toHaveBeenCalled();
    expect(host.writeProjectBytes).toHaveBeenCalledWith("proj", "figures/unit-circle.png", "UE5H", 7);
    expect(result).toEqual({ success: true, path: "main.typ", figure: "figures/unit-circle.png" });
  });

  it("does not repeat an import the document already has", async () => {
    const host = typstHost({
      readFileContent: vi.fn(async () => '#import "@preview/cetz:0.4.2"\n= Results\n'),
    });
    const tools = createFigureTools(host);

    await tools.insert_figure.execute({ code: CANVAS });

    expect(host.readFileContent).toHaveBeenCalledWith("proj", "main.typ");
    expect(host.insertAtCursor).toHaveBeenCalledWith(
      "proj",
      "#figure[\n  #cetz.canvas({ cetz.draw.circle((0, 0)) })\n]",
      expect.any(Function),
    );
  });

  it("refuses to preview or insert when the project's engine has no figure support", async () => {
    const host = typstHost({ getFigureEngine: () => null });
    const tools = createFigureTools(host);

    expect(await tools.preview_figure.execute({ code: "x" })).toEqual({
      error: "Figure tools work only in LaTeX and Typst projects.",
    });
    expect(await tools.insert_figure.execute({ code: "x" })).toEqual({
      error: "Figure tools work only in LaTeX and Typst projects.",
    });
    expect(host.renderTypstFigure).not.toHaveBeenCalled();
    expect(host.insertAtCursor).not.toHaveBeenCalled();
  });

  it("describes both engines in the preview tool", () => {
    const description = createFigureTools(typstHost()).preview_figure.description;
    expect(description).toContain("TikZ");
    expect(description).toContain("CeTZ");
    expect(description).toContain("fletcher");
  });
});

describe("load_image in any project", () => {
  it("loads a project image even when the engine has no figure support", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 4, 0, 0, 0, 3,
    ]);
    const onImage = vi.fn();
    const host = {
      getProjectId: () => "proj",
      getFigureEngine: () => null,
      readProjectBytes: vi.fn(async () => png),
    } as unknown as AiToolsHost;

    const result = await createFigureTools(host, { onImage }).load_image.execute({ path: "sketch.png" });

    expect(result).toEqual({ loaded: true, path: "sketch.png", width: 4, height: 3 });
    expect(onImage).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
  });
});

describe("DOCX host contracts", () => {
  it("forwards the complete XML node and attribute route for format reads", async () => {
    const readFormat = vi.fn(async () => readableFormat());
    const tools = createDocxTools(makeDocxHost({ readFormat }));

    await tools.read_docx_format.execute({
      session_id: "s1",
      query: {
        kind: "nodes",
        expected_revision: 2,
        paragraph_ref: "p1",
        part: "word/document.xml",
        path: [0, 2, 1],
        namespace_uri: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        local_name: "pPr",
        attribute: {
          namespace_uri: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
          local_name: "val",
          value: "keepNext",
        },
      },
    });

    expect(readFormat).toHaveBeenCalledExactlyOnceWith("s1", {
      kind: "nodes",
      expectedRevision: 2,
      paragraphRef: "p1",
      part: "word/document.xml",
      path: [0, 2, 1],
      namespaceUri: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      localName: "pPr",
      attribute: {
        namespaceUri: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        localName: "val",
        value: "keepNext",
      },
    });
  });

  it("reports unavailable workspace context and failed document listing as tool results", async () => {
    const workspaceContext = vi.fn(async () => {
      throw new Error("context store closed");
    });
    const listDocuments = vi.fn(async () => {
      throw new Error("document index closed");
    });
    const tools = createDocxTools(makeDocxHost({ workspaceContext, listDocuments }));

    expect(await tools.get_docx_workspace_context.execute({})).toEqual({
      error: "Error: context store closed",
    });
    expect(await tools.list_docx_documents.execute({})).toEqual({
      error: "Error: document index closed",
    });
  });

  it("refuses format approval when no live reader can produce the before snapshot", async () => {
    const formatParagraph = vi.fn();
    const formatBatch = vi.fn();
    const confirm = vi.fn(async () => true);
    const tools = createDocxTools(makeDocxHost({ formatParagraph, formatBatch }), { confirm });

    expect(await tools.apply_docx_format.execute({
      paragraph_ref: "p1",
      expected_revision: 2,
      font: { bold: true },
    })).toEqual({
      unavailable: true,
      error: "Format approval requires live DOCX formatting reads.",
    });
    expect(await tools.apply_docx_format_batch.execute({
      expected_revision: 2,
      operations: [{ paragraph_ref: "p1", font: { bold: true } }],
    })).toEqual({
      unavailable: true,
      error: "Format approval requires live DOCX formatting reads.",
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(formatParagraph).not.toHaveBeenCalled();
    expect(formatBatch).not.toHaveBeenCalled();
  });

  it("shows the live overview before a batch format and applies nothing after decline", async () => {
    const before = readableFormat();
    const readFormat = vi.fn(async () => before);
    const formatBatch = vi.fn(async () => ({
      ok: true as const,
      changed: true,
      revision: 3,
      document: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 3,
        savedRevision: 1,
        dirty: true,
      },
    }));
    const confirm = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const tools = createDocxTools(makeDocxHost({ readFormat, formatBatch }), { confirm });
    const input = {
      expected_revision: 2,
      operations: [
        { paragraph_ref: "p1", font: { bold: true } },
        { paragraph_ref: "p2", paragraph: { keepNext: true } },
      ],
    };

    expect(await tools.apply_docx_format_batch.execute(input)).toMatchObject({
      ok: true,
      changed: true,
      revision: 3,
    });
    expect(readFormat).toHaveBeenCalledExactlyOnceWith(undefined, { kind: "overview" });
    expect(confirm).toHaveBeenCalledWith({
      tool: "apply_docx_format_batch",
      summary: "Apply 2 DOCX format operations in paper.docx",
      path: "paper.docx",
      diff: {
        path: "paper.docx",
        oldText: expect.stringContaining('"sourceSha256"'),
        newText: JSON.stringify([
          { paragraphRef: "p1", font: { bold: true } },
          { paragraphRef: "p2", paragraph: { keepNext: true } },
        ], null, 2),
      },
    });
    expect(formatBatch).toHaveBeenCalledExactlyOnceWith(undefined, 2, [
      { paragraphRef: "p1", font: { bold: true } },
      { paragraphRef: "p2", paragraph: { keepNext: true } },
    ], undefined);

    expect(await tools.apply_docx_format_batch.execute(input)).toMatchObject({
      declined: true,
      tool: "apply_docx_format_batch",
    });
    expect(formatBatch).toHaveBeenCalledOnce();
    expect(readFormat).toHaveBeenCalledTimes(2);
  });

  it("loads an active-session image through the image channel without inventing a session ID", async () => {
    const readImage = vi.fn(async () => imageResult());
    const onImage = vi.fn();
    const tools = createDocxTools(makeDocxHost({ readImage }), {
      onImage,
      imageSupported: true,
    });

    const metadata = await tools.read_docx_image.execute({
      paragraph_ref: "p1",
      object_ref: "drawing-1",
      expected_revision: 2,
    });

    expect(readImage).toHaveBeenCalledExactlyOnceWith(undefined, {
      paragraphRef: "p1",
      objectRef: "drawing-1",
      expectedRevision: 2,
    });
    expect(metadata).toMatchObject({
      document: { sessionId: "s1", sourceSha256: "a".repeat(64) },
      sourceSha256: "a".repeat(64),
      paragraphRef: "p1",
      objectRef: "drawing-1",
      revision: 2,
      width: 2,
      height: 3,
    });
    expect(metadata).not.toHaveProperty("sessionId");
    expect(onImage).toHaveBeenCalledWith(
      `data:image/png;base64,${Buffer.from(docxPng()).toString("base64")}`,
    );
  });

  it("discards image pixels that complete after the request is cancelled", async () => {
    const readImage = vi.fn(async () => imageResult());
    const onImage = vi.fn();
    const mutationAllowed = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const tools = createDocxTools(makeDocxHost({ readImage }), {
      onImage,
      mutationAllowed,
    });

    expect(await tools.read_docx_image.execute({
      session_id: "s1",
      paragraph_ref: "p1",
      object_ref: "drawing-1",
      expected_revision: 2,
    })).toEqual({ error: "The external request was cancelled before mutation." });
    expect(readImage).toHaveBeenCalledOnce();
    expect(onImage).not.toHaveBeenCalled();
  });

  it("refuses pixels whose document identity belongs to another session", async () => {
    const readImage = vi.fn(async () => ({
      ...imageResult(),
      document: { ...imageResult().document, sessionId: "s2" },
    }));
    const onImage = vi.fn();
    const tools = createDocxTools(makeDocxHost({ readImage }), {
      onImage,
      imageSupported: true,
    });

    expect(await tools.read_docx_image.execute({
      session_id: "s1",
      paragraph_ref: "p1",
      object_ref: "drawing-1",
      expected_revision: 2,
    })).toMatchObject({
      error: expect.stringContaining("current document source identity"),
    });
    expect(onImage).not.toHaveBeenCalled();
  });

  it("rejects unsupported image bytes and images above the pixel limit", async () => {
    const readImage = vi.fn()
      .mockResolvedValueOnce({ ...imageResult(), bytes: new Uint8Array([1, 2, 3, 4]) })
      .mockResolvedValueOnce({ ...imageResult(), bytes: docxPng(8_000, 5_000) });
    const onImage = vi.fn();
    const tools = createDocxTools(makeDocxHost({ readImage }), {
      onImage,
      imageSupported: true,
    });
    const input = {
      paragraph_ref: "p1",
      object_ref: "drawing-1",
      expected_revision: 2,
    };

    expect(await tools.read_docx_image.execute(input)).toEqual({
      error: "Error: Only valid PNG, JPEG, and GIF DOCX images are supported.",
    });
    expect(await tools.read_docx_image.execute(input)).toMatchObject({
      error: expect.stringContaining("pixel limit"),
    });
    expect(onImage).not.toHaveBeenCalled();
  });
});

describe("project-bound asynchronous previews", () => {
  it("discards PDF page text that arrives after the open project changes", async () => {
    let finishExtraction!: (value: { pages: string[]; numPages: number }) => void;
    const getProjectId = vi.fn(() => "proj");
    const extractPdfText = vi.fn(() => new Promise<{ pages: string[]; numPages: number }>((resolve) => {
      finishExtraction = resolve;
    }));
    const onImage = vi.fn();
    const tools = createOleaflyTools({
      getProjectId,
      getAiPdfCaptureEnabled: vi.fn(() => true),
      getPdfBytes: vi.fn(() => new Uint8Array([37, 80, 68, 70])),
      extractPdfText,
      pdfToPng: vi.fn(),
    } as unknown as AiToolsHost, { onImage });

    const pending = tools.verify_pdf_pages.execute({ pages: [1] });
    expect(extractPdfText).toHaveBeenCalledOnce();
    getProjectId.mockReturnValue("other");
    finishExtraction({ pages: ["Page from the old project"], numPages: 1 });

    expect(await pending).toEqual({
      error: "The open project changed before PDF page verification finished.",
    });
    expect(onImage).not.toHaveBeenCalled();
  });

  it("does not retain figure PDF bytes that arrive after the project changes", async () => {
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let finishRead!: (bytes: Uint8Array) => void;
    const getProjectId = vi.fn(() => "proj");
    const setLastFigurePreview = vi.fn();
    const host = {
      getProjectId,
      getFigureEngine: vi.fn(() => "latex" as const),
      compileIsolated: vi.fn(async () => ({
        ok: true,
        errors: [],
        has_pdf: true,
        log: "compiled",
      })),
      readIsolatedPdf: vi.fn(() => {
        markReadStarted();
        return new Promise<Uint8Array>((resolve) => {
          finishRead = resolve;
        });
      }),
      pdfToPng: vi.fn(),
      setLastFigurePreview,
    } as unknown as AiToolsHost;
    const onImage = vi.fn();
    const pending = createFigureTools(host, { onImage }).preview_figure.execute({
      code: String.raw`\draw (0,0) circle (1);`,
    });

    await readStarted;
    getProjectId.mockReturnValue("other");
    finishRead(new Uint8Array([37, 80, 68, 70]));

    expect(await pending).toEqual({
      error: "The open project changed or the figure request was cancelled before completion.",
    });
    expect(setLastFigurePreview).not.toHaveBeenCalled();
    expect(onImage).not.toHaveBeenCalled();
  });

  it("does not publish a figure image rendered after the project changes", async () => {
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    let finishRender!: (dataUrl: string) => void;
    const getProjectId = vi.fn(() => "proj");
    const setLastFigurePreview = vi.fn();
    const host = {
      getProjectId,
      getFigureEngine: vi.fn(() => "latex" as const),
      compileIsolated: vi.fn(async () => ({
        ok: true,
        errors: [],
        has_pdf: true,
        log: "compiled",
      })),
      readIsolatedPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
      pdfToPng: vi.fn(() => {
        markRenderStarted();
        return new Promise<string>((resolve) => {
          finishRender = resolve;
        });
      }),
      setLastFigurePreview,
    } as unknown as AiToolsHost;
    const onImage = vi.fn();
    const pending = createFigureTools(host, { onImage }).preview_figure.execute({
      code: String.raw`\draw (0,0) circle (1);`,
    });

    await renderStarted;
    getProjectId.mockReturnValue("other");
    finishRender("data:image/png;base64,T0xE");

    expect(await pending).toEqual({
      error: "The open project changed or the figure request was cancelled before completion.",
    });
    expect(setLastFigurePreview).not.toHaveBeenCalled();
    expect(onImage).not.toHaveBeenCalled();
  });
});

import {
  createServerAutomationHost,
  type AutomationBatchRequest,
  type AutomationBatchResponse,
  type AutomationHandle,
  type AutomationHost,
  type AutomationOperationResult,
  type AutomationValue,
} from "@docx-editor.dev/core/automation";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  applyDocxSuggestion,
  captureDocxTarget,
  createDocxHostSession,
  createDocxSession,
  DocxSessionError,
  formatDocxParagraph,
  inspectDocxParagraph,
  listDocxParagraphs,
  type DocxTarget,
} from "./docx-session";
import {
  openHeadlessDocument,
  storyParagraphs,
  writeOoxmlPackage,
  type OoxmlParagraphNode,
  type TreeDocOp,
} from "@docx-editor.dev/core/store";
import { openTreeSession } from "@docx-editor.dev/core/binding";
import type {
  DocxEditorInstance,
  TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import { openDocxFormatFacts } from "./docx-format";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MATH_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PICTURE_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const VML_NS = "urn:schemas-microsoft-com:vml";
const OFFICE_NS = "urn:schemas-microsoft-com:office:office";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function syntheticDocx(paragraphs: readonly string[], styles?: string): Uint8Array {
  const body = paragraphs
    .map((text) =>
      text.startsWith("<w:p>") || text.startsWith("<w:tbl>")
        ? text
        : `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`,
    )
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : ""}</Types>`,
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}" xmlns:m="${MATH_NS}" xmlns:wp="${WP_NS}" xmlns:a="${DRAWING_NS}" xmlns:pic="${PICTURE_NS}" xmlns:v="${VML_NS}" xmlns:o="${OFFICE_NS}" xmlns:r="${REL_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
    ...(styles
      ? {
          "word/_rels/document.xml.rels": strToU8(
            `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
          ),
          "word/styles.xml": strToU8(
            `<?xml version="1.0"?><w:styles xmlns:w="${WORD_NS}">${styles}</w:styles>`,
          ),
        }
      : {}),
  });
}

function open(body: string | readonly string[]): AutomationHost {
  const paragraphs = typeof body === "string" ? [body] : body;
  const opened = createServerAutomationHost(syntheticDocx(paragraphs));
  if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
  return opened.host;
}

function treeParagraph(body: string | readonly string[]): OoxmlParagraphNode {
  const paragraphs = typeof body === "string" ? [body] : body;
  const opened = openHeadlessDocument(syntheticDocx(paragraphs));
  if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
  const paragraph = storyParagraphs(opened.view.part().root.children[0])[0];
  if (paragraph?.kind !== "paragraph") {
    throw new Error("The synthetic DOCX has no paragraph.");
  }
  return paragraph;
}

function editorSession(bytes: Uint8Array) {
  const opened = openTreeSession(bytes);
  if (!opened.ok) throw new Error(`The synthetic DOCX did not open: ${opened.reason}`);
  const tree: TreeDocxSessionView = opened.session;
  const treeBatches: TreeDocOp[][] = [];
  const sessionView = new Proxy(tree, {
    get(target, property) {
      if (property === "applyTreeOps") {
        return target.applyTreeOps.bind(target);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const surface = {
    session: sessionView,
    packageRevision: () => tree.packageRevision(),
    flushPendingInput: () => {},
    applyAutomationOps(
      staged: (
        relate: (url: string) => string | null,
      ) => Parameters<TreeDocxSessionView["applyTreeOps"]>[0] | null,
    ) {
      const operations = staged((url) => url);
      if (operations !== null) {
        treeBatches.push([...operations]);
      }
      if (operations === null) {
        return {
          committed: false,
          rejected: true,
          opCount: 0,
          reason: "planned operation refused",
        };
      }
      return tree.applyTreeOps(operations);
    },
    editingMode: () => "edit" as const,
    collaborationSession: () => null,
    revisionDisplayMode: () => "allMarkup" as const,
    replacementLanding: () => null,
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
    treeBatches,
    save: () => writeOoxmlPackage(tree.currentPackage()),
  };
}

function one(host: AutomationHost, operation: AutomationBatchRequest["operations"][number]) {
  const response = host.execute({ operations: [operation] });
  if (!response.ok) throw new Error(`The DOCX operation failed: ${JSON.stringify(response)}`);
  return response.results[0];
}

function replaceParagraph(host: AutomationHost, target: DocxTarget, text: string) {
  return host.execute({
    expectedRevision: host.revision(),
    operations: [
      {
        op: "replaceSpan",
        span: {
          start: { paragraph: target.paragraph, offset: 0, readAt: target.revision },
          end: {
            paragraph: target.paragraph,
            offset: target.original.length,
            readAt: target.revision,
          },
        },
        text,
      },
    ],
  });
}

function paragraphHandle(ref: string): AutomationHandle<"paragraph"> {
  return { kind: "paragraph", ref } as AutomationHandle<"paragraph">;
}

function target(handle = paragraphHandle("paragraph:test:1")): DocxTarget {
  return { paragraph: handle, original: "Original.", revision: 0 };
}

function answer(...values: readonly AutomationValue[]): AutomationBatchResponse {
  return {
    ok: true,
    results: values.map((value) => ({ status: "ok", value })),
    revision: 0,
    changed: false,
  };
}

function failure(
  code: "invalid-handle" | "stale-revision" | "transaction-refused",
  message: string,
): AutomationBatchResponse {
  return {
    ok: false,
    results: [{ status: "error", error: { code, message } }],
    revision: 0,
    changed: false,
  };
}

function fakeHost(
  execute: (request: AutomationBatchRequest) => AutomationBatchResponse,
): AutomationHost {
  return {
    capabilities: {
      document: true,
      save: false,
      events: true,
      selection: false,
      scrolling: false,
      layout: false,
    },
    revision: () => 0,
    execute,
    save: () => ({
      ok: false,
      error: { code: "unsupported-capability", message: "The live editor owns save." },
    }),
    subscribe: () => () => {},
    dispose: () => {},
  };
}

function malformed(result: AutomationOperationResult): AutomationBatchResponse {
  return { ok: true, results: [result], revision: 0, changed: false };
}

describe("DOCX paragraph adapter over the real core", () => {
  it("lists paragraph handles without reading their content", () => {
    const fixture = editorSession(syntheticDocx([
      "First paragraph.",
      "Second paragraph.",
    ]));

    expect(fixture.session.listParagraphHandles()).toHaveLength(2);
    expect(fixture.session.listParagraphHandles().every(
      (handle) => handle.kind === "paragraph",
    )).toBe(true);
  });

  it("resolves the selected paragraph identity from handles after an edit", () => {
    const fixture = editorSession(syntheticDocx(["First paragraph.", "Second paragraph."]));
    const second = fixture.session.listParagraphs()[1];
    expect(fixture.session.paragraphHandleForId?.(second.paraId!)).toEqual(second.handle);
    const result = fixture.session.replaceParagraphRange({ paragraphRef: second.handle.ref,
      expectedRevision: 0, modelRange: { start: 0, end: 6 }, expectedText: "Second", text: "Changed" });
    expect(result.ok).toBe(true);
    expect(fixture.session.paragraphHandleForId?.(second.paraId!)).toEqual(second.handle);
    expect(fixture.session.paragraphHandleForId?.("missing")).toBeUndefined();
  });

  it("reads whole-paragraph model and display coordinates with atomic fields", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF Target </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Long result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> B </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics).toMatchObject({
      paragraphRef: paragraph.handle.ref,
      revision: 0,
      modelText: "A ￼ B ￼",
      displayText: "A Long result B 7",
      editableRanges: [
        { start: 0, end: 2 },
        { start: 3, end: 6 },
      ],
    });
    expect(semantics.atoms).toHaveLength(2);
    expect(semantics.atoms[0]).toMatchObject({
      kind: "field",
      modelRange: { start: 2, end: 3 },
      displayRange: { start: 2, end: 13 },
      displayText: "Long result",
      readable: true,
      complete: true,
      editable: false,
      payload: { code: " REF Target " },
    });
    expect(semantics.atoms[1]).toMatchObject({
      kind: "field",
      modelRange: { start: 6, end: 7 },
      displayRange: { start: 16, end: 17 },
      displayText: "7",
    });
  });

  it("marks nested field results unavailable instead of assigning them by position", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>OUTER</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>X</w:t><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INNER</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Y</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>B</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.atoms).toMatchObject([
      {
        kind: "field",
        displayText: "￼",
        readable: false,
        complete: false,
      },
    ]);
    expect(semantics.displayText).toBe("A￼B");
    expect(semantics.displayText).not.toContain("OUTER");
    expect(semantics.displayText).not.toContain("INNER");
    expect(semantics.atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual(["￼"]);
  });

  it("keeps VML inside a field owned by the field atom", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:fldSimple w:instr="EMBED"><w:r><w:pict><v:shape id="_x0000_i1026" type="#_x0000_t75"><v:imagedata r:id="rId99" o:title=""/></v:shape></w:pict></w:r></w:fldSimple></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.modelText).toBe("\uFFFC");
    expect(semantics.displayText).toBe("");
    expect(semantics.atoms).toMatchObject([
      {
        kind: "field",
        modelRange: { start: 0, end: 1 },
        displayRange: { start: 0, end: 0 },
        displayText: "",
      },
    ]);
    expect(semantics.atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual([""]);
  });

  it("reads equations with bounded linear payloads and marks them uneditable", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t xml:space="preserve">Equation: </w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.modelText).toBe("Equation: ￼ after");
    expect(semantics.displayText).toBe("Equation: ￼ after");
    expect(semantics.atoms).toHaveLength(1);
    expect(semantics.atoms[0]).toMatchObject({
      kind: "math",
      modelRange: { start: 10, end: 11 },
      displayRange: { start: 10, end: 11 },
      displayText: "￼",
      readable: true,
      complete: true,
      editable: false,
      payload: { fallbackText: "x+1", truncated: false, linear: "x+1" },
    });
    expect(semantics.editableRanges).toEqual([
      { start: 0, end: 10 },
      { start: 11, end: 17 },
    ]);
  });

  it("reports an unsupported equation as readable fallback without claiming completeness", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><m:oMath><m:foo><m:r><m:t>x</m:t></m:r></m:foo></m:oMath></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.readParagraph(paragraph.handle).atoms[0]).toMatchObject({
      kind: "math",
      readable: true,
      complete: false,
      payload: { fallbackText: "x", truncated: false },
    });
  });

  it("reports a nested equation fallback without claiming completeness", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><m:oMath><m:f><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:foo><m:r><m:t>y</m:t></m:r></m:foo></m:den></m:f></m:oMath></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.readParagraph(paragraph.handle).atoms[0]).toMatchObject({
      kind: "math",
      readable: true,
      complete: false,
    });
  });

  it("reads an equation paragraph as one math atom", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:oMathPara></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.readParagraph(paragraph.handle).atoms).toMatchObject([
      {
        kind: "math",
        modelRange: { start: 0, end: 1 },
        displayRange: { start: 0, end: 1 },
      },
    ]);
  });

  it("keeps atomic refs stable when earlier text changes", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t>Before </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const before = fixture.session.readParagraph(paragraph.handle).atoms[0]!.objectRef;

    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 6 },
      expectedText: "Before",
      text: "Changed",
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(fixture.session.readParagraph(paragraph.handle).atoms[0]!.objectRef).toBe(before);
  });

  it("uses distinct tree-node references for VML and DrawingML objects", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:pict><v:shape id="_x0000_i1025" type="#_x0000_t75"><v:imagedata r:id="rId99" o:title=""/></v:shape></w:pict></w:r><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill/><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);
    const atoms = semantics.atoms;
    const objectRefPrefix = `${paragraph.handle.ref}:`;
    expect(atoms.every((atom) => atom.objectRef.startsWith(objectRefPrefix))).toBe(true);
    expect(atoms).toMatchObject([
      {
        kind: "drawing",
        modelRange: { start: 0, end: 0 },
        displayRange: { start: 0, end: 1 },
      },
      {
        kind: "drawing",
        modelRange: { start: 0, end: 1 },
        displayRange: { start: 1, end: 2 },
        displayText: "￼",
      },
    ]);
    expect(semantics.displayText).toBe("￼￼");
    expect(atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual(["￼", "￼"]);
    expect(new Set(atoms.map((atom) => atom.objectRef))).toHaveLength(2);
  });

  it("projects adjacent VML and DrawingML objects in XML order without moving model coordinates", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r><w:pict><v:shape id="_x0000_i1025" type="#_x0000_t75"><v:imagedata r:id="rId99" o:title=""/></v:shape></w:pict></w:r><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill/><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t xml:space="preserve"> After</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.modelText).toBe("Before \uFFFC After");
    expect(semantics.atoms.map((atom) => atom.modelRange)).toEqual([
      { start: 7, end: 7 },
      { start: 7, end: 8 },
    ]);
    expect(semantics.displayText).toBe("Before \uFFFC\uFFFC After");
    expect(semantics.atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual(["\uFFFC", "\uFFFC"]);
    expect(semantics.atoms.map((atom) => atom.displayRange)).toEqual([
      { start: 7, end: 8 },
      { start: 8, end: 9 },
    ]);
  });

  it("keeps drawing node references stable when earlier text changes", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r><w:pict><v:shape id="_x0000_i1025" type="#_x0000_t75"><v:imagedata r:id="rId99" o:title=""/></v:shape></w:pict></w:r><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill/><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const before = fixture.session.readParagraph(paragraph.handle).atoms.map(
      (atom) => atom.objectRef,
    );

    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 6 },
      expectedText: "Before",
      text: "Changed",
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(
      fixture.session.readParagraph(paragraph.handle).atoms.map(
        (atom) => atom.objectRef,
      ),
    ).toEqual(before);
  });

  it("splits editable ranges around non-editable inline controls", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t xml:space="preserve">A </w:t><w:tab/><w:br/><w:t xml:space="preserve"> B</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.modelText).toBe("A \t\u000B B");
    expect(semantics.editableRanges).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
    expect(semantics.atoms).toMatchObject([
      {
        kind: "tab",
        modelRange: { start: 2, end: 3 },
        displayRange: { start: 2, end: 3 },
        displayText: "\t",
      },
      {
        kind: "break",
        modelRange: { start: 3, end: 4 },
        displayRange: { start: 3, end: 4 },
        displayText: "\u000B",
      },
    ]);
    expect(semantics.displayText).toBe("A \t\u000B B");
    expect(semantics.atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual(["\t", "\u000B"]);
  });

  it("does not project property, instruction, or unknown-container text", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:pPr><w:rPr><w:t>PPR_LEAK</w:t></w:rPr></w:pPr><w:r><w:rPr><w:t>RPR_LEAK</w:t></w:rPr><w:t>Visible</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INSTRUCTION_LEAK</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:unknown><w:r><w:t>UNKNOWN_LEAK</w:t></w:r></w:unknown><w:r><w:t>!</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.displayText).toBe("VisibleResult!");
    expect(semantics.displayText).not.toContain("PPR_LEAK");
    expect(semantics.displayText).not.toContain("RPR_LEAK");
    expect(semantics.displayText).not.toContain("INSTRUCTION_LEAK");
    expect(semantics.displayText).not.toContain("UNKNOWN_LEAK");
    expect(semantics.atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual(["Result"]);
  });

  it("keeps inline character segments and following field coordinates aligned", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t>A</w:t><w:noBreakHyphen/><w:t>B</w:t><w:softHyphen/><w:t>C</w:t><w:sym w:font="Wingdings" w:char="F0FC"/></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple><w:r><w:t>Z</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.modelText).toBe("A\u001eB\u001fC(￼Z");
    expect(semantics.displayText).toBe("A\u2011B\u00adC(7Z");
    expect(semantics.atoms).toMatchObject([
      {
        kind: "field",
        modelRange: { start: 6, end: 7 },
        displayRange: { start: 6, end: 7 },
        displayText: "7",
      },
    ]);
    expect(semantics.atoms.map((atom) =>
      semantics.displayText.slice(atom.displayRange.start, atom.displayRange.end)
    )).toEqual(["7"]);
    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 1, end: 2 },
      expectedText: "\u001e",
      text: "-",
    })).toMatchObject({ ok: false, code: "atomic-overlap", changed: false });
  });

  it("replaces only protected plain text within one run", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r><w:t xml:space="preserve">Target words</w:t></w:r><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: semantics.revision,
      modelRange: { start: 7, end: 13 },
      expectedText: "Target",
      text: "Changed",
    })).toEqual({ ok: true, revision: 1, changed: true });

    expect(fixture.session.readParagraph(paragraph.handle)).toMatchObject({
      revision: 1,
      modelText: "Before Changed words after",
    });
    expect(fixture.tree.packageRevision()).toBe(1);
    expect(fixture.treeBatches).toHaveLength(1);
  });

  it("allows a plain range adjacent to zero-width bookmark markers", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:bookmarkStart w:id="1" w:name="Target"/><w:r><w:t>Near marker</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const semantics = fixture.session.readParagraph(paragraph.handle);

    expect(semantics.editableRanges).toEqual([{ start: 0, end: 11 }]);
    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 4 },
      expectedText: "Near",
      text: "Close",
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(fixture.session.readParagraph(paragraph.handle).modelText)
      .toBe("Close marker");
  });

  it("reports no editable text inside a hyperlink and refuses the write", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:hyperlink w:anchor="Target"><w:r><w:t>Linked words</w:t></w:r></w:hyperlink></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.readParagraph(paragraph.handle).editableRanges).toEqual([]);
    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 6 },
      expectedText: "Linked",
      text: "Bound",
    })).toMatchObject({ ok: false, code: "container-boundary", changed: false });
    expect(fixture.tree.packageRevision()).toBe(0);
  });

  it("refuses atomic, format, and wrapper boundaries without changing the document", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:bookmarkStart w:id="1" w:name="Target"/><w:r><w:t>One</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Two</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>',
    ]));
    const [plain, math] = fixture.session.listParagraphs();
    const before = fixture.save();

    expect(fixture.session.replaceParagraphRange({
      paragraphRef: plain.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 6 },
      expectedText: "OneTwo",
      text: "All",
    })).toMatchObject({
      ok: false,
      code: "format-boundary",
      revision: 0,
      changed: false,
    });
    expect(fixture.session.replaceParagraphRange({
      paragraphRef: math.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 2, end: 3 },
      expectedText: "￼",
      text: "x",
    })).toMatchObject({
      ok: false,
      code: "atomic-overlap",
      revision: 0,
      changed: false,
    });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("rejects stale revisions and expected-text mismatches before writing", () => {
    const fixture = editorSession(syntheticDocx([
      "Target sentence.",
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 1,
      modelRange: { start: 0, end: 6 },
      expectedText: "Target",
      text: "Changed",
    })).toMatchObject({
      ok: false,
      code: "stale-target",
      revision: 0,
      changed: false,
    });
    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 6 },
      expectedText: "Wrong",
      text: "Changed",
    })).toMatchObject({
      ok: false,
      code: "expected-text-mismatch",
      revision: 0,
      changed: false,
    });
    expect(fixture.tree.packageRevision()).toBe(0);
  });

  it("keeps paragraph refs stable and preserves revision after save and reopen", () => {
    const fixture = editorSession(syntheticDocx([
      "Target sentence.",
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    expect(fixture.session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 6 },
      expectedText: "Target",
      text: "Saved",
    })).toEqual({ ok: true, revision: 1, changed: true });
    const after = fixture.session.readParagraph(paragraph.handle);
    expect(after).toMatchObject({
      paragraphRef: paragraph.handle.ref,
      revision: 1,
      modelText: "Saved sentence.",
    });

    const reopened = editorSession(fixture.save());
    expect(reopened.session.listParagraphs()[0].text).toBe("Saved sentence.");
  });

  it("returns readable host-only semantics but refuses unverified range writes", () => {
    const host = open([
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p>',
    ]);
    const session = createDocxHostSession(host);
    const paragraph = session.listParagraphs()[0];
    const semantics = session.readParagraph(paragraph.handle);

    expect(semantics).toMatchObject({
      modelText: "A ￼",
      displayText: "A 7",
      editableRanges: [],
    });
    expect(semantics.atoms).toMatchObject([
      {
        kind: "field",
        modelRange: { start: 2, end: 3 },
        displayRange: { start: 2, end: 3 },
        displayText: "7",
        readable: true,
        editable: false,
      },
    ]);
    expect(session.replaceParagraphRange({
      paragraphRef: paragraph.handle.ref,
      expectedRevision: 0,
      modelRange: { start: 0, end: 1 },
      expectedText: "A",
      text: "B",
    })).toMatchObject({
      ok: false,
      code: "unsupported-target",
      revision: 0,
      changed: false,
    });
    expect(session.listParagraphs()[0].text).toBe("A ￼");
  });

  it("returns no paragraphs for an empty body", () => {
    expect(listDocxParagraphs(open([]))).toEqual([]);
  });

  it("lists paragraphs with text and paragraph ids in reading order", () => {
    const host = open(["First paragraph.", "Selected paragraph.", "Last paragraph."]);

    const paragraphs = listDocxParagraphs(host);

    expect(
      paragraphs.map(({ text, paraId }) => ({
        text,
        hasParaId: /^[0-9A-F]{8}$/.test(paraId ?? ""),
      })),
    ).toEqual([
      { text: "First paragraph.", hasParaId: true },
      { text: "Selected paragraph.", hasParaId: true },
      { text: "Last paragraph.", hasParaId: true },
    ]);
    expect(paragraphs.every(({ handle }) => handle.kind === "paragraph")).toBe(true);
  });

  it("captures a target and replaces it as ordinary permanent text", () => {
    const host = open(["Before.", "Target sentence.", "After."]);
    const captured = listDocxParagraphs(host)[1];
    const capturedTarget = captureDocxTarget(host, captured.handle);

    expect(capturedTarget).toMatchObject({
      paragraph: captured.handle,
      original: "Target sentence.",
      revision: 0,
      paraId: captured.paraId,
    });
    expect(applyDocxSuggestion(host, capturedTarget, "Revised sentence.")).toEqual({
      ok: true,
      revision: 1,
      changed: true,
    });
    expect(listDocxParagraphs(host)[1].text).toBe("Revised sentence.");
  });

  it("allows acceptance after another paragraph changed when the target text is unchanged", () => {
    const host = open(["Target sentence.", "Other."]);
    const [targetParagraph, otherParagraph] = listDocxParagraphs(host);
    const target = captureDocxTarget(host, targetParagraph.handle);
    const other = captureDocxTarget(host, otherParagraph.handle);
    expect(replaceParagraph(host, other, "Changed elsewhere.")).toMatchObject({
      ok: true,
      revision: 1,
    });

    expect(applyDocxSuggestion(host, target, "Revised target.")).toEqual({
      ok: true,
      revision: 2,
      changed: true,
    });
    expect(listDocxParagraphs(host).map(({ text }) => text)).toEqual([
      "Revised target.",
      "Changed elsewhere.",
    ]);
  });

  it("rejects a target whose current text changed", () => {
    const host = open(["Target sentence.", "Other."]);
    const target = captureDocxTarget(host, listDocxParagraphs(host)[0].handle);
    expect(replaceParagraph(host, target, "Changed target.").ok).toBe(true);

    expect(applyDocxSuggestion(host, target, "Second suggestion.")).toEqual({
      ok: false,
      code: "stale-target",
      message: "The target paragraph changed or was deleted since it was read.",
      revision: 1,
      changed: false,
    });
    expect(listDocxParagraphs(host)[0].text).toBe("Changed target.");
  });

  it("accepts a permanent change away and back when the current text still matches", () => {
    const host = open(["Target sentence.", "Other."]);
    const target = captureDocxTarget(host, listDocxParagraphs(host)[0].handle);
    expect(replaceParagraph(host, target, "Changed target.").ok).toBe(true);
    const changed = captureDocxTarget(host, target.paragraph);
    expect(replaceParagraph(host, changed, target.original).ok).toBe(true);

    expect(applyDocxSuggestion(host, target, "Accepted.")).toMatchObject({
      ok: true,
      revision: 3,
    });
    expect(listDocxParagraphs(host)[0].text).toBe("Accepted.");
  });

  it("rejects a deleted target without recreating it", () => {
    const host = open(["Target sentence.", "Delete me.", "After."]);
    const target = captureDocxTarget(host, listDocxParagraphs(host)[1].handle);
    const deleted = one(host, { op: "deleteParagraph", paragraph: target.paragraph });
    expect(deleted).toMatchObject({ status: "ok", value: { kind: "applied" } });
    expect(() => captureDocxTarget(host, target.paragraph)).toThrow(
      "The paragraph is not present in this DOCX document.",
    );

    expect(applyDocxSuggestion(host, target, "Revised target.")).toMatchObject({
      ok: false,
      code: "stale-target",
      revision: 1,
    });
  });

  it("saves the ordinary edit and reopens it without tracked revision markup", () => {
    const host = open(["Target sentence.", "After."]);
    const target = captureDocxTarget(host, listDocxParagraphs(host)[0].handle);
    expect(applyDocxSuggestion(host, target, "Saved revision.").ok).toBe(true);

    const saved = host.save();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const reopened = createServerAutomationHost(saved.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.reason);

    expect(listDocxParagraphs(reopened.host).map(({ text }) => text)).toEqual([
      "Saved revision.",
      "After.",
    ]);
    const xml = new TextDecoder().decode(unzipSync(saved.bytes)["word/document.xml"]);
    expect(xml).not.toContain("<w:del ");
    expect(xml).not.toContain("<w:ins ");
  });

  it("exposes paragraph, target, and apply operations through the host session", () => {
    const host = open(["Target sentence.", "After."]);
    const session = createDocxHostSession(host);
    const paragraph = session.listParagraphs()[0];
    const target = session.captureTarget(paragraph.handle);

    expect(session.revision()).toBe(0);
    expect(session.applySuggestion(target, "Session revision.")).toEqual({
      ok: true,
      revision: 1,
      changed: true,
    });
    expect(session.revision()).toBe(1);
    expect(session.listParagraphs().map(({ text }) => text)).toEqual([
      "Session revision.",
      "After.",
    ]);
    session.dispose();
    expect(() => session.listParagraphs()).toThrow();
  });

  it("formats a whole paragraph without replacing nested hyperlinks or equations", () => {
    const host = open([
      '<w:p><w:hyperlink w:anchor="target"><w:r><w:t>Linked</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p>',
      "Other.",
    ]);
    const paragraph = listDocxParagraphs(host)[0];
    const session = createDocxHostSession(host);

    expect(formatDocxParagraph(host, paragraph.handle, 0, {
      font: { bold: true, name: "Arial", size: 12, color: "#112233" },
      paragraph: {
        alignment: "Centered",
        leftIndent: 12,
        spaceAfter: 6,
      },
    })).toEqual({ ok: true, revision: 1, changed: true });

    expect(session.readParagraphFormatting?.(paragraph.handle)).toMatchObject({
      paragraphRef: paragraph.handle.ref,
      text: paragraph.text,
      revision: 1,
      font: { bold: true, name: "Arial", size: 12, color: "#112233" },
      paragraph: { alignment: "Centered", leftIndent: 12, spaceAfter: 6 },
    });
    const saved = host.save();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const xml = new TextDecoder().decode(unzipSync(saved.bytes)["word/document.xml"]);
    expect(xml).toContain("<w:hyperlink");
    expect(xml).toContain("<m:oMath");
    expect(xml).toContain("<m:t>x+1</m:t>");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain('<w:jc w:val="center"');
    expect(formatDocxParagraph(host, paragraph.handle, 0, {
      font: { italic: true },
    })).toEqual({
      ok: false,
      code: "stale-target",
      message: "The target paragraph changed or was deleted since it was read.",
      revision: 1,
      changed: false,
    });
    expect(session.readParagraphFormatting?.(paragraph.handle)?.font.italic).toBeNull();
  });

  it("writes Latin and East Asian font slots with paragraph formatting in one tree transaction", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:pPr><w:keepNext/><w:rPr><w:rFonts w:ascii="Old Latin" w:hAnsi="Old Latin" w:eastAsia="旧体" w:cs="Courier New" w:hint="eastAsia"/><w:color w:val="445566"/></w:rPr></w:pPr><w:hyperlink w:anchor="target"><w:r><w:rPr><w:rFonts w:ascii="Old Latin" w:hAnsi="Old Latin" w:eastAsia="旧体" w:cs="Courier New" w:hint="eastAsia"/><w:color w:val="445566"/></w:rPr><w:t>Linked</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and 中文 </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p>',
      '<w:tbl><w:tblGrid><w:gridCol w:w="1200"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.session.formatParagraph?.(paragraph.handle, 0, {
      font: { name: "Arial", nameEastAsia: "宋体", size: 12 },
      paragraph: {
        alignment: "Centered",
        leftIndent: 12,
        spaceAfter: 6,
        keepNext: true,
        keepLines: true,
        pageBreakBefore: true,
      },
    })).toEqual({ ok: true, revision: 1, changed: true });

    expect(fixture.tree.packageRevision()).toBe(1);
    expect(fixture.treeBatches).toHaveLength(1);
    expect(fixture.session.readParagraphFormatting?.(paragraph.handle)).toMatchObject({
      revision: 1,
      font: { name: "Arial", size: 12 },
      paragraph: {
        alignment: "Centered",
        leftIndent: 12,
        spaceAfter: 6,
        keepNext: true,
        keepLines: true,
        pageBreakBefore: true,
      },
    });
    expect(fixture.treeBatches).toHaveLength(1);
    expect(
      fixture.treeBatches[0]?.filter((operation) => operation.op === "setParagraphProperties"),
    ).toHaveLength(1);

    const xml = new TextDecoder().decode(unzipSync(fixture.save())["word/document.xml"]);
    expect(xml).toMatch(
      /<w:rFonts[^>]*w:ascii="Arial"[^>]*w:cs="Courier New"[^>]*w:eastAsia="宋体"[^>]*w:hAnsi="Arial"[^>]*w:hint="eastAsia"\/>/,
    );
    expect(xml).toMatch(
      /<w:pPr><w:keepNext\/>.*?<w:keepLines\/>.*?<w:pageBreakBefore\/>.*?<w:spacing w:after="120"\/>.*?<w:ind w:left="240"\/>.*?<w:jc w:val="center"\/>.*?<w:rPr><w:rFonts[^>]*w:eastAsia="宋体"[^>]*\/>.*?<\/w:rPr>/s,
    );
    expect(xml).toContain('<w:sz w:val="24"/>');
    expect(xml).toContain("<w:hyperlink");
    expect(xml).toContain("<w:fldSimple");
    expect(xml).toContain("<m:oMath");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:t>Cell</w:t>");

    expect(fixture.session.formatParagraph?.(paragraph.handle, 0, {
      font: { nameEastAsia: "黑体" },
    })).toEqual({
      ok: false,
      code: "stale-target",
      message: "The target paragraph changed or was deleted since it was read.",
      revision: 1,
      changed: false,
    });
    expect(fixture.tree.packageRevision()).toBe(1);
  });

  it("writes a single pagination flag without changing the other direct paragraph properties", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:pPr><w:pStyle w:val="BodyText"/><w:spacing w:after="120"/><w:ind w:left="240"/><w:keepNext w:val="0"/></w:pPr><w:r><w:t>Target</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.formatParagraph?.(paragraph.handle, 0, {
      paragraph: { keepNext: true },
    })).toEqual({ ok: true, revision: 1, changed: true });

    expect(fixture.tree.packageRevision()).toBe(1);
    expect(fixture.treeBatches).toHaveLength(1);
    expect(fixture.session.readParagraphFormatting?.(paragraph.handle)).toMatchObject({
      revision: 1,
      paragraph: { keepNext: true, keepLines: false, pageBreakBefore: false },
    });
    const xml = new TextDecoder().decode(unzipSync(fixture.save())["word/document.xml"]);
    expect(xml).toContain("<w:pPr><w:pStyle");
    expect(xml).toContain('<w:spacing w:after="120"/>');
    expect(xml).toContain('<w:ind w:left="240"/>');
    expect(xml).toContain("<w:keepNext/>");
    expect(xml).not.toContain('<w:keepNext w:val="0"/>');

    expect(fixture.session.formatParagraph?.(paragraph.handle, 1, {
      paragraph: { alignment: "Centered", keepLines: false },
    })).toEqual({ ok: true, revision: 2, changed: true });
    expect(fixture.tree.packageRevision()).toBe(2);
    expect(fixture.treeBatches).toHaveLength(2);
    expect(
      fixture.treeBatches[1]?.filter((operation) => operation.op === "setParagraphProperties"),
    ).toHaveLength(1);
    expect(
      new TextDecoder().decode(unzipSync(fixture.save())["word/document.xml"]),
    ).toContain('<w:keepLines w:val="0"/>');
    expect(fixture.session.readParagraphFormatting?.(paragraph.handle)?.paragraph)
      .toMatchObject({
        alignment: "Centered",
        keepNext: true,
        keepLines: false,
        pageBreakBefore: false,
      });
    expect(
      fixture.session.formatParagraph?.(paragraph.handle, 2, {
        paragraph: { keepLines: true },
      }),
    ).toEqual({ ok: true, revision: 3, changed: true });
    expect(fixture.tree.packageRevision()).toBe(3);
    expect(fixture.session.readParagraphFormatting?.(paragraph.handle)?.paragraph)
      .toMatchObject({
        keepNext: true,
        keepLines: true,
        pageBreakBefore: false,
      });
    const savedXml = new TextDecoder().decode(
      unzipSync(fixture.save())["word/document.xml"],
    );
    expect(savedXml).not.toContain('<w:keepLines w:val="0"/>');
  });

  it.each(["false", null, 1])("rejects a non-boolean pagination flag without changing bytes: %j", (value) => {
    const fixture = editorSession(syntheticDocx(['<w:p><w:r><w:t>Target</w:t></w:r></w:p>']));
    const paragraph = fixture.session.listParagraphs()[0];
    const before = fixture.save();
    expect(fixture.session.formatParagraph?.(paragraph.handle, 0, {
      paragraph: { keepNext: value as never },
    })).toMatchObject({ ok: false, code: "invalid-format", revision: 0, changed: false });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("reads direct pagination overrides over inherited style values", () => {
    const fixture = editorSession(syntheticDocx(
      ['<w:p><w:pPr><w:pStyle w:val="Pagination"/><w:keepNext w:val="0"/><w:keepLines w:val="off"/></w:pPr><w:r><w:t>Target</w:t></w:r></w:p>'],
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Pagination"><w:name w:val="Pagination"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:pageBreakBefore/></w:pPr></w:style>',
    ));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.readParagraphFormatting?.(paragraph.handle)?.paragraph).toMatchObject({
      keepNext: false,
      keepLines: false,
      pageBreakBefore: true,
    });
  });

  it("reads table first-row pagination styles, direct false overrides and save/reopen state", () => {
    const fixture = editorSession(syntheticDocx(
      [
        '<w:tbl><w:tblPr><w:tblStyle w:val="HeaderRow"/><w:tblLook w:firstRow="1" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Inherited header</w:t></w:r></w:p></w:tc><w:tc><w:p><w:pPr><w:keepNext w:val="0"/><w:keepLines w:val="off"/><w:pageBreakBefore w:val="false"/></w:pPr><w:r><w:t>Overridden header</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Body row</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ],
      '<w:style w:type="table" w:styleId="HeaderRow"><w:name w:val="Header Row"/><w:tblStylePr w:type="firstRow"><w:pPr><w:keepNext/><w:keepLines/><w:pageBreakBefore/></w:pPr></w:tblStylePr></w:style>',
    ));
    const read = (text: string) => {
      const paragraph = fixture.session.listParagraphs().find((item) => item.text === text);
      if (!paragraph) throw new Error(`Paragraph ${text} is missing.`);
      return fixture.session.readParagraphFormatting?.(paragraph.handle)?.paragraph;
    };

    expect(read("Inherited header")).toMatchObject({
      keepNext: true,
      keepLines: true,
      pageBreakBefore: true,
    });
    expect(read("Overridden header")).toMatchObject({
      keepNext: false,
      keepLines: false,
      pageBreakBefore: false,
    });
    expect(read("Body row")).toMatchObject({
      keepNext: false,
      keepLines: false,
      pageBreakBefore: false,
    });

    const reopened = editorSession(fixture.save());
    const readReopened = (text: string) => {
      const paragraph = reopened.session.listParagraphs().find((item) => item.text === text);
      if (!paragraph) throw new Error(`Paragraph ${text} is missing after reopen.`);
      return reopened.session.readParagraphFormatting?.(paragraph.handle)?.paragraph;
    };
    expect(readReopened("Inherited header")).toMatchObject({
      keepNext: true,
      keepLines: true,
      pageBreakBefore: true,
    });
    expect(readReopened("Overridden header")).toMatchObject({
      keepNext: false,
      keepLines: false,
      pageBreakBefore: false,
    });
  });

  it("refuses an East Asian font on a host without a live tree and keeps ordinary fonts working", () => {
    const host = open(["Target sentence."]);
    const session = createDocxHostSession(host);
    const paragraph = session.listParagraphs()[0];

    expect(session.formatParagraph?.(paragraph.handle, 0, {
      font: { nameEastAsia: "宋体" },
    })).toEqual({
      ok: false,
      code: "unsupported-target",
      message:
        "East Asian font slots require a live editor tree session; this DOCX host cannot write them.",
      revision: 0,
      changed: false,
    });
    expect(session.formatParagraph?.(paragraph.handle, 0, {
      font: { italic: true },
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(session.paragraphLocator?.(paragraph.handle)).toBeNull();
  });

  it("refuses pagination flags on a host without a live tree without changing the document", () => {
    const host = open(["Target sentence."]);
    const session = createDocxHostSession(host);
    const paragraph = session.listParagraphs()[0];
    expect(session.formatObject).toBeUndefined();
    const savedBefore = host.save();
    expect(savedBefore.ok).toBe(true);
    if (!savedBefore.ok) throw new Error(savedBefore.error.message);
    const before = new TextDecoder().decode(
      unzipSync(savedBefore.bytes)["word/document.xml"],
    );

    expect(session.formatParagraph?.(paragraph.handle, 0, {
      paragraph: { keepNext: true },
    })).toEqual({
      ok: false,
      code: "unsupported-target",
      message:
        "Paragraph pagination controls require a live editor tree session; this DOCX host cannot write them.",
      revision: 0,
      changed: false,
    });
    const saved = host.save();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(new TextDecoder().decode(unzipSync(saved.bytes)["word/document.xml"])).toBe(before);
    expect(host.revision()).toBe(0);
  });

  it("routes object formatting through the live tree session", () => {
    const fixture = editorSession(syntheticDocx(
      ['<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'],
      '<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/></w:style>',
    ));
    const paragraph = fixture.session.listParagraphs()[0];

    expect(fixture.session.formatObject?.(paragraph.handle, 0, {
      kind: "table",
      table: { styleId: "Grid", headerRowCount: 1 },
    })).toEqual({ ok: true, revision: 1, changed: true });
    expect(fixture.session.formatObject?.(paragraph.handle, 1, {
      kind: "cell",
      cell: { fill: "#ABCDEF", verticalAlignment: "center" },
    })).toEqual({ ok: true, revision: 2, changed: true });
    expect(fixture.tree.packageRevision()).toBe(2);

    const xml = new TextDecoder().decode(
      unzipSync(fixture.save())["word/document.xml"],
    );
    expect(xml).toContain('<w:tblStyle w:val="Grid"/>');
    expect(xml).toContain('<w:tblHeader w:val="1"/>');
    expect(xml).toContain('w:fill="ABCDEF"');
    expect(xml).toContain('<w:vAlign w:val="center"/>');
  });

  it("leaves the document unchanged when a pagination write is stale or the mixed batch is refused", () => {
    const fixture = editorSession(syntheticDocx([
      '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t>Target</w:t></w:r></w:p>',
    ]));
    const paragraph = fixture.session.listParagraphs()[0];
    const before = fixture.save();

    expect(fixture.session.formatParagraph?.(paragraph.handle, 1, {
      paragraph: { keepNext: true },
    })).toMatchObject({ ok: false, code: "stale-target", revision: 0 });
    expect(fixture.session.formatParagraph?.(paragraph.handle, 0, {
      font: { nameEastAsia: "宋体" },
      paragraph: { style: "Missing Style", keepNext: true },
    })).toMatchObject({ ok: false, revision: 0 });
    expect(fixture.tree.packageRevision()).toBe(0);
    expect(fixture.save()).toEqual(before);
  });

  it("locates a generated paragraph identity by canonical path after writer reparse", async () => {
    const text = "Paragraph without an authored identity.";
    const source = syntheticDocx([text, text]);
    const sourceXml = new TextDecoder().decode(unzipSync(source)["word/document.xml"]);
    expect(sourceXml).not.toContain("w14:paraId");
    const fixture = editorSession(source);
    const paragraph = fixture.session.listParagraphs()[1];
    expect(paragraph.paraId).toBeDefined();

    const locator = fixture.session.paragraphLocator?.(paragraph.handle);
    expect(locator).not.toBeNull();
    if (!locator) throw new Error("The live paragraph has no canonical locator.");

    const saved = fixture.save();
    const facts = await openDocxFormatFacts(saved);
    const objects = facts.snapshot.objects.filter(
      (object) =>
        object.kind === "paragraph" &&
        object.part === locator.part &&
        object.path.length === locator.path.length &&
        object.path.every((value, index) => value === locator.path[index]),
    );
    expect(objects).toHaveLength(1);
    expect(objects[0]?.text).toBe(text);
  });
});

describe("DOCX target safety", () => {
  it("rejects mixed formatting before a whole-paragraph replacement can flatten it", () => {
    const body =
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> plain</w:t></w:r></w:p>';
    const paragraph = treeParagraph(body);
    const host = open(body);
    const inspect = () => inspectDocxParagraph(paragraph);
    const target = captureDocxTarget(host, listDocxParagraphs(host)[0].handle, inspect);

    expect(target.structure).toBeTypeOf("string");
    expect(applyDocxSuggestion(host, target, "New text", inspect)).toMatchObject({
      ok: false,
      code: "unsupported-target",
    });
    expect(listDocxParagraphs(host)[0].text).toBe("Bold plain");
  });

  it("rejects structured inline content even when its text is ordinary", () => {
    const bodies = [
      '<w:p><w:hyperlink w:anchor="target"><w:r><w:t>Linked</w:t></w:r></w:hyperlink></w:p>',
      '<w:p><w:bookmarkStart w:id="1" w:name="target"/><w:r><w:t>Bookmarked</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
      '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Commented</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>',
      '<w:p><w:sdt><w:sdtContent><w:r><w:t>Controlled</w:t></w:r></w:sdtContent></w:sdt></w:p>',
      "<w:p><w:r><w:t>Before</w:t><w:tab/><w:t>After</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>Before</w:t><w:br/><w:t>After</w:t></w:r></w:p>",
    ];

    for (const body of bodies) {
      const paragraph = treeParagraph(body);
      const host = open(body);
      const inspect = () => inspectDocxParagraph(paragraph);
      const target = captureDocxTarget(host, listDocxParagraphs(host)[0].handle, inspect);

      expect(applyDocxSuggestion(host, target, "Rewrite.", inspect), body).toMatchObject({
        ok: false,
        code: "unsupported-target",
      });
    }
  });

  it("treats a same-text structure change as stale", () => {
    const body = "<w:p><w:r><w:t>Target sentence.</w:t></w:r></w:p>";
    const paragraph = treeParagraph(body);
    const host = open(body);
    let current = paragraph;
    const inspect = () => inspectDocxParagraph(current);
    const target = captureDocxTarget(host, listDocxParagraphs(host)[0].handle, inspect);
    const changed = treeParagraph(
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Target sentence.</w:t></w:r></w:p>',
    );
    current = changed;

    expect(applyDocxSuggestion(host, target, "Accepted.", inspect)).toMatchObject({
      ok: false,
      code: "stale-target",
    });
    expect(listDocxParagraphs(host)[0].text).toBe("Target sentence.");
  });

  it("recognizes the U+FFFC atom inside a complex Zotero-style field", () => {
    const host = open(
      '<w:p><w:r><w:t>See </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>(Smith, 2024)</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>.</w:t></w:r></w:p>',
    );
    const paragraph = listDocxParagraphs(host)[0];

    expect(paragraph.text).toBe("See\uFFFC.");
    expect(
      applyDocxSuggestion(host, captureDocxTarget(host, paragraph.handle), "Rewrite."),
    ).toMatchObject({
      ok: false,
      code: "unsupported-target",
    });
  });

  it("marks fields and equations read-only through their U+FFFC model placeholder", () => {
    const field = open(
      '<w:p><w:r><w:t>Before </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple><w:r><w:t> after</w:t></w:r></w:p>',
    );
    const math = open(
      '<w:p><w:r><w:t>Before </w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath><w:r><w:t> after</w:t></w:r></w:p>',
    );

    for (const host of [field, math]) {
      const paragraph = listDocxParagraphs(host)[0];
      expect(paragraph.text).toContain("\uFFFC");
      expect(
        applyDocxSuggestion(host, captureDocxTarget(host, paragraph.handle), "Rewrite."),
      ).toMatchObject({
        ok: false,
        code: "unsupported-target",
        revision: 0,
      });
      expect(listDocxParagraphs(host)[0].text).toBe(paragraph.text);
    }
  });

  it("marks an inline drawing read-only even when its model text has no placeholder", () => {
    const host = open(
      '<w:p><w:r><w:t>Before </w:t></w:r><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill/><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t> after</w:t></w:r></w:p>',
    );
    const paragraph = listDocxParagraphs(host)[0];
    expect(paragraph.text).toBe("Before\uFFFCafter");

    expect(
      applyDocxSuggestion(host, captureDocxTarget(host, paragraph.handle), "Rewrite."),
    ).toMatchObject({
      ok: false,
      code: "unsupported-target",
    });
  });

  it("uses getShapes to reject VML/OLE content that model text does not mark", () => {
    const host = open(
      '<w:p><w:r><w:t>Before </w:t></w:r><w:r><w:pict><v:shape id="_x0000_i1025" type="#_x0000_t75"><v:imagedata r:id="rId99" o:title=""/></v:shape></w:pict></w:r><w:r><w:t> after</w:t></w:r></w:p>',
    );
    const paragraph = listDocxParagraphs(host)[0];
    expect(paragraph.text).toBe("Beforeafter");

    expect(
      applyDocxSuggestion(host, captureDocxTarget(host, paragraph.handle), "Rewrite."),
    ).toMatchObject({
      ok: false,
      code: "unsupported-target",
    });
    expect(listDocxParagraphs(host)[0].text).toBe("Beforeafter");
  });

  it("rejects a target that already contains a tracked insertion", () => {
    const host = open(
      '<w:p><w:ins w:id="1" w:author="Reviewer" w:date="2026-11-10T00:00:00Z"><w:r><w:t>Tracked sentence.</w:t></w:r></w:ins></w:p>',
    );
    const paragraph = listDocxParagraphs(host)[0];
    expect(paragraph.text).toBe("Tracked sentence.");

    expect(
      applyDocxSuggestion(host, captureDocxTarget(host, paragraph.handle), "Rewrite."),
    ).toEqual({
      ok: false,
      code: "stale-target",
      message: "The target paragraph changed or was deleted since it was read.",
      revision: 0,
      changed: false,
    });
    expect(listDocxParagraphs(host)[0].text).toBe("Tracked sentence.");
  });

  it("keeps ordinary paragraphs editable when another paragraph is read-only", () => {
    const host = open([
      "Ordinary paragraph.",
      '<w:p><w:r><w:t>Before </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p>',
    ]);
    const ordinary = listDocxParagraphs(host)[0];
    const field = listDocxParagraphs(host)[1];

    expect(
      applyDocxSuggestion(host, captureDocxTarget(host, ordinary.handle), "Accepted.").ok,
    ).toBe(true);
    expect(
      applyDocxSuggestion(host, captureDocxTarget(host, field.handle), "Rejected."),
    ).toMatchObject({
      ok: false,
      code: "unsupported-target",
    });
  });
});

describe("DOCX session and typed failures", () => {
  it("omits an absent paragraph id from list and target identities", () => {
    const document = { kind: "document", ref: "document:test:1" } as AutomationHandle<"document">;
    const body = { kind: "body", ref: "body:test:1" } as AutomationHandle<"body">;
    const paragraph = paragraphHandle("paragraph:test:1");
    const host = fakeHost((request) => {
      if (request.operations[0]?.op === "getDocument") {
        return answer({ kind: "handle", handle: document });
      }
      if (request.operations[0]?.op === "getBody") {
        return answer({ kind: "handle", handle: body });
      }
      if (request.operations[0]?.op === "getParagraphs") {
        return answer({ kind: "handles", handles: [paragraph] });
      }
      return answer(
        { kind: "text", text: "" },
        { kind: "text", text: "Original." },
        { kind: "handles", handles: [] },
        { kind: "handles", handles: [] },
        { kind: "handles", handles: [] },
      );
    });

    expect(listDocxParagraphs(host)).toEqual([{ handle: paragraph, text: "Original." }]);
    expect(captureDocxTarget(host, paragraph)).toEqual({
      paragraph,
      original: "Original.",
      revision: 0,
    });
  });

  it("forwards host revisions through subscribe and returns its unsubscribe", () => {
    let notify: ((event: { revision: number }) => void) | undefined;
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const host = fakeHost(() => answer());
    host.subscribe = (listener) => {
      notify = listener;
      return unsubscribe;
    };
    host.dispose = dispose;
    const session = createDocxHostSession(host);

    const listener = vi.fn();
    expect(session.subscribe(listener)).toBe(unsubscribe);
    notify?.({ revision: 9 });
    expect(listener).toHaveBeenCalledWith(9);
    session.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns the typed DocxSessionError for a failed read batch", () => {
    const host = fakeHost((request) => {
      if (request.operations[0]?.op === "getDocument") {
        return {
          ok: false,
          results: [
            {
              status: "error",
              error: { code: "document-unavailable", message: "No document is open." },
            },
          ],
          revision: 7,
          changed: false,
        };
      }
      return answer();
    });

    try {
      listDocxParagraphs(host);
      throw new Error("Expected the DOCX read to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(DocxSessionError);
      expect(error).toMatchObject({
        name: "DocxSessionError",
        code: "document-unavailable",
        message: "No document is open.",
        revision: 7,
      });
    }
  });

  it("surfaces malformed read answers instead of treating them as an empty document", () => {
    const document = { kind: "document", ref: "document:test:1" } as AutomationHandle<"document">;
    const body = { kind: "body", ref: "body:test:1" } as AutomationHandle<"body">;
    const cases: Array<{
      operation: string;
      response: AutomationBatchResponse;
      message: string;
    }> = [
      {
        operation: "getDocument",
        response: malformed({
          status: "ok",
          value: { kind: "handle", handle: body },
        }),
        message: "The DOCX host did not answer a document handle.",
      },
      {
        operation: "getBody",
        response: malformed({
          status: "ok",
          value: { kind: "handle", handle: document },
        }),
        message: "The DOCX host did not answer a body handle.",
      },
      {
        operation: "getParagraphs",
        response: malformed({ status: "ok", value: { kind: "text", text: "not handles" } }),
        message: "The DOCX host did not answer handles.",
      },
      {
        operation: "getParagraphs",
        response: malformed({
          status: "ok",
          value: { kind: "handles", handles: [body] },
        }),
        message: "The DOCX host answered a non-paragraph handle.",
      },
      {
        operation: "getDocument",
        response: malformed({ status: "skipped" }),
        message: "The DOCX host did not answer operation 0.",
      },
      {
        operation: "getParagraphId",
        response: malformed({ status: "ok", value: { kind: "handles", handles: [] } }),
        message: "The DOCX host did not answer text.",
      },
      {
        operation: "getDocument",
        response: {
          ok: false,
          results: [{ status: "skipped" }],
          revision: 0,
          changed: false,
        },
        message: "The DOCX host refused a batch without naming an operation error.",
      },
    ];
    for (const entry of cases) {
      const host = fakeHost((request) => {
        const operation = request.operations[0]?.op;
        if (operation === entry.operation) return entry.response;
        if (operation === "getDocument") {
          return entry.operation === "getDocument"
            ? entry.response
            : answer({ kind: "handle", handle: document });
        }
        if (operation === "getBody") {
          return entry.operation === "getBody"
            ? entry.response
            : answer({ kind: "handle", handle: body });
        }
        if (operation === "getParagraphs") {
          return entry.operation === "getParagraphs"
            ? entry.response
            : answer({ kind: "handles", handles: [paragraphHandle("paragraph:test:1")] });
        }
        return entry.response;
      });
      expect(() => listDocxParagraphs(host)).toThrow(entry.message);
    }
  });

  it("returns a non-conflict replacement refusal unchanged", () => {
    const document = { kind: "document", ref: "document:test:1" } as AutomationHandle<"document">;
    const body = { kind: "body", ref: "body:test:1" } as AutomationHandle<"body">;
    const paragraph = paragraphHandle("paragraph:test:1");
    const host = fakeHost((request) => {
      if (request.operations[0]?.op === "getDocument") {
        return answer({ kind: "handle", handle: document });
      }
      if (request.operations[0]?.op === "getBody") {
        return answer({ kind: "handle", handle: body });
      }
      if (request.operations[0]?.op === "getParagraphs") {
        return answer({ kind: "handles", handles: [paragraph] });
      }
      if (request.operations[0]?.op === "getRevisions") {
        return answer({ kind: "handles", handles: [] });
      }
      if (request.operations[0]?.op === "replaceSpan") {
        return failure("transaction-refused", "The document is read-only.");
      }
      return answer(
        { kind: "text", text: "ABC12345" },
        { kind: "text", text: "Original." },
        { kind: "handles", handles: [] },
        { kind: "handles", handles: [] },
        { kind: "handles", handles: [] },
      );
    });

    expect(applyDocxSuggestion(host, target(paragraph), "New.")).toEqual({
      ok: false,
      code: "transaction-refused",
      message: "The document is read-only.",
      revision: 0,
      changed: false,
    });
  });

  it("does not overwrite a target deleted before the replacement commits", () => {
    const paragraph = paragraphHandle("paragraph:test:1");
    let reads = 0;
    let conflict = false;
    const host: AutomationHost = {
      ...fakeHost((request) => {
        if (request.operations[0]?.op === "getRevisions") {
          return answer({ kind: "handles", handles: [] });
        }
        if (request.operations[0]?.op === "replaceSpan") {
          conflict = true;
          return {
            ok: false,
            results: [
              {
                status: "error",
                error: { code: "stale-revision", message: "The document moved." },
              },
            ],
            revision: 2,
            changed: false,
          };
        }
        if (conflict && request.operations[0]?.op === "getParagraphId") {
          return failure("invalid-handle", "The paragraph was deleted.");
        }
        const text = reads++ === 0 ? "Original." : "Changed elsewhere.";
        return {
          ...answer(
            { kind: "text", text: "ABC12345" },
            { kind: "text", text },
            { kind: "handles", handles: [] },
            { kind: "handles", handles: [] },
            { kind: "handles", handles: [] },
          ),
          revision: reads,
        };
      }),
      revision: () => 2,
    };

    expect(applyDocxSuggestion(host, target(paragraph), "New.")).toEqual({
      ok: false,
      code: "stale-target",
      message: "The target paragraph changed or was deleted since it was read.",
      revision: 2,
      changed: false,
    });
  });

  it("reports a stale revision when the target is deleted during replacement", () => {
    const paragraph = paragraphHandle("paragraph:test:1");
    let conflict = false;
    const host: AutomationHost = {
      ...fakeHost((request) => {
        if (request.operations[0]?.op === "getRevisions") {
          return answer({ kind: "handles", handles: [] });
        }
        if (request.operations[0]?.op === "replaceSpan") {
          conflict = true;
          return failure("stale-revision", "The document moved.");
        }
        if (conflict && request.operations[0]?.op === "getParagraphId") {
          return failure("stale-revision", "The paragraph was deleted.");
        }
        return answer(
          { kind: "text", text: "ABC12345" },
          { kind: "text", text: "Original." },
          { kind: "handles", handles: [] },
          { kind: "handles", handles: [] },
          { kind: "handles", handles: [] },
        );
      }),
      revision: () => 2,
    };

    expect(applyDocxSuggestion(host, target(paragraph), "New.")).toEqual({
      ok: false,
      code: "stale-target",
      message: "The target paragraph changed or was deleted since it was read.",
      revision: 0,
      changed: false,
    });
  });

});

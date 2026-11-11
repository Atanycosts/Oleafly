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
  DocxSessionError,
  inspectDocxParagraph,
  listDocxParagraphs,
  type DocxTarget,
} from "./docx-session";
import {
  openHeadlessDocument,
  storyParagraphs,
  type OoxmlParagraphNode,
} from "@docx-editor.dev/core/store";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MATH_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PICTURE_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const VML_NS = "urn:schemas-microsoft-com:vml";
const OFFICE_NS = "urn:schemas-microsoft-com:office:office";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function syntheticDocx(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs
    .map((text) =>
      text.startsWith("<w:p>") ? text : `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`,
    )
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${WORD_NS}" xmlns:m="${MATH_NS}" xmlns:wp="${WP_NS}" xmlns:a="${DRAWING_NS}" xmlns:pic="${PICTURE_NS}" xmlns:v="${VML_NS}" xmlns:o="${OFFICE_NS}" xmlns:r="${REL_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
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

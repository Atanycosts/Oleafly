// @vitest-environment jsdom
import {
  createServerAutomationHost,
  type AutomationHost,
} from "@docx-editor.dev/core/automation";
import {
  mountPaginatedSurface,
  type DocxEditorInstance,
} from "@docx-editor.dev/core/editor";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  createDocxHostSession,
  createDocxSession,
  DocxImageReadError,
} from "./docx-session";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const V = "urn:schemas-microsoft-com:vml";
const O = "urn:schemas-microsoft-com:office:office";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const IMAGE_REL = `${R}/image`;
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  ),
);

function drawing(
  relationshipId = "rIdImage",
  attribute: "embed" | "link" = "embed",
): string {
  return `<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Picture 1" descr="Chart preview"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:${attribute}="${relationshipId}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function vml(relationshipId = "rIdImage"): string {
  return `<w:pict><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:72pt;height:36pt"><v:imagedata r:id="${relationshipId}" o:title="Legacy diagram"/></v:shape></w:pict>`;
}

function packageBytes(input: {
  readonly body: string;
  readonly relationships?: string;
  readonly media?: Uint8Array | null;
  readonly contentType?: string;
}): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="${input.contentType ?? "image/png"}"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:m="${M}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:v="${V}" xmlns:o="${O}" xmlns:r="${R}"><w:body>${input.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
  };
  if (input.relationships !== undefined) {
    parts["word/_rels/document.xml.rels"] = strToU8(
      `<Relationships xmlns="${PACKAGE_REL}">${input.relationships}</Relationships>`,
    );
  }
  if (input.media !== null) {
    parts["word/media/image1.png"] = input.media ?? PNG;
  }
  return zipSync(parts);
}

function imageRelationship(
  id = "rIdImage",
  type = IMAGE_REL,
  target = "media/image1.png",
  targetMode?: "External",
): string {
  return `<Relationship Id="${id}" Type="${type}" Target="${target}"${targetMode === undefined ? "" : ` TargetMode="${targetMode}"`}/>`;
}

function mounted(
  body: string,
  options: {
    readonly relationships?: string;
    readonly media?: Uint8Array | null;
    readonly contentType?: string;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const opened = mountPaginatedSurface(
    container,
    packageBytes({
      body,
      relationships: options.relationships ?? imageRelationship(),
      media: options.media,
      contentType: options.contentType,
    }),
    {
      editingMode: "edit",
      author: "Image Test",
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
    tree: surface.session,
    paragraphs: session.listParagraphs(),
    save: () => surface.save(),
    dispose() {
      session.dispose();
      surface.destroy();
      container.remove();
    },
  };
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DocxImageReadError);
    return (error as DocxImageReadError).code;
  }
  throw new Error("The image operation succeeded unexpectedly.");
}

describe("DOCX image inventory", () => {
  it("projects and reads one embedded DrawingML image without exporting the document", () => {
    const fixture = mounted(
      `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r>${drawing()}</w:r><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>`,
    );
    try {
      const paragraph = fixture.paragraphs[0]!;
      const atom = fixture.session
        .readParagraph(paragraph.handle)
        .atoms.find((candidate) => candidate.kind === "drawing")!;
      expect(atom).toMatchObject({
        readable: true,
        complete: false,
        payload: {
          contentStatus: "not_inspected",
          relationshipId: "rIdImage",
          mediaPart: expect.stringContaining("word/media/image1.png"),
          contentType: "image/png",
          byteLength: PNG.byteLength,
          description: "Chart preview",
          widthEmu: 914400,
          heightEmu: 457200,
          next: {
            tool: "read_docx_image",
            arguments: {
              paragraph_ref: paragraph.handle.ref,
              object_ref: atom.objectRef,
              expected_revision: 0,
            },
          },
        },
      });

      const result = fixture.session.readImage!({
        paragraphRef: paragraph.handle.ref,
        objectRef: atom.objectRef,
        expectedRevision: 0,
      });
      expect(result).toMatchObject({
        revision: 0,
        objectRef: atom.objectRef,
        part: expect.stringContaining("word/document.xml"),
        relationshipId: "rIdImage",
        mediaPart: expect.stringContaining("word/media/image1.png"),
        mimeType: "image/png",
        description: "Chart preview",
        widthEmu: 914400,
        heightEmu: 457200,
      });
      expect(Array.from(result.bytes)).toEqual(Array.from(PNG));
    } finally {
      fixture.dispose();
    }
  });

  it("projects and reads one embedded VML image with its style extent", () => {
    const fixture = mounted(
      `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r>${vml()}</w:r></w:p>`,
    );
    try {
      const paragraph = fixture.paragraphs[0]!;
      const atom = fixture.session
        .readParagraph(paragraph.handle)
        .atoms.find((candidate) => candidate.kind === "drawing")!;
      expect(atom.payload).toMatchObject({
        contentStatus: "not_inspected",
        relationshipId: "rIdImage",
        mediaPart: expect.stringContaining("word/media/image1.png"),
        contentType: "image/png",
        byteLength: PNG.byteLength,
        description: "Legacy diagram",
        widthEmu: 914400,
        heightEmu: 457200,
      });

      const result = fixture.session.readImage!({
        paragraphRef: paragraph.handle.ref,
        objectRef: atom.objectRef,
        expectedRevision: 0,
      });
      expect(result).toMatchObject({
        revision: 0,
        relationshipId: "rIdImage",
        mimeType: "image/png",
        description: "Legacy diagram",
        widthEmu: 914400,
        heightEmu: 457200,
      });
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    ["DrawingML", drawing()],
    ["VML", vml()],
  ])(
    "keeps a %s image inside its existing field atom and makes it readable",
    (_format, image) => {
      const fixture = mounted(
        `<w:p><w:fldSimple w:instr="EMBED"><w:r>${image}</w:r></w:fldSimple></w:p>`,
      );
      try {
        const paragraph = fixture.paragraphs[0]!;
        const semantics = fixture.session.readParagraph(paragraph.handle);
        expect(semantics.atoms).toHaveLength(1);
        expect(semantics.atoms[0]).toMatchObject({
          kind: "field",
          readable: true,
          complete: false,
          displayText: "",
          payload: {
            code: "EMBED",
            contentStatus: "not_inspected",
            relationshipId: "rIdImage",
            mediaPart: expect.stringContaining("word/media/image1.png"),
            next: {
              tool: "read_docx_image",
              arguments: {
                paragraph_ref: paragraph.handle.ref,
                object_ref: semantics.atoms[0]!.objectRef,
                expected_revision: 0,
              },
            },
          },
        });

        const result = fixture.session.readImage!({
          paragraphRef: paragraph.handle.ref,
          objectRef: semantics.atoms[0]!.objectRef,
          expectedRevision: 0,
        });
        expect(Array.from(result.bytes)).toEqual(Array.from(PNG));
      } finally {
        fixture.dispose();
      }
    },
  );

  it("reads a DrawingML result from a complex field without creating a second atom", () => {
    const fixture = mounted(
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> EMBED </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${drawing()}</w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    );
    try {
      const paragraph = fixture.paragraphs[0]!;
      const semantics = fixture.session.readParagraph(paragraph.handle);
      expect(semantics.atoms).toHaveLength(1);
      expect(semantics.atoms[0]).toMatchObject({
        kind: "field",
        readable: true,
        complete: false,
        payload: {
          code: " EMBED ",
          contentStatus: "not_inspected",
          relationshipId: "rIdImage",
        },
      });
      expect(
        fixture.session.readImage!({
          paragraphRef: paragraph.handle.ref,
          objectRef: semantics.atoms[0]!.objectRef,
          expectedRevision: 0,
        }).mimeType,
      ).toBe("image/png");
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a field that contains more than one image", () => {
    const fixture = mounted(
      `<w:p><w:fldSimple w:instr="EMBED"><w:r>${drawing()}</w:r><w:r>${vml()}</w:r></w:fldSimple></w:p>`,
    );
    try {
      const paragraph = fixture.paragraphs[0]!;
      const atom = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
      expect(atom).toMatchObject({
        kind: "field",
        readable: true,
        complete: false,
        payload: {
          code: "EMBED",
          contentStatus: "not_inspected",
          error: { code: "not-image" },
        },
      });
      expect(
        errorCode(() =>
          fixture.session.readImage!({
            paragraphRef: paragraph.handle.ref,
            objectRef: atom.objectRef,
            expectedRevision: 0,
          }),
        ),
      ).toBe("not-image");
    } finally {
      fixture.dispose();
    }
  });

  it("reports stale revisions, missing paragraphs, and objects from another paragraph", () => {
    const fixture = mounted(
      `<w:p><w:r>${drawing()}</w:r></w:p><w:p><w:r>${vml()}</w:r></w:p>`,
    );
    try {
      const [first, second] = fixture.paragraphs;
      const firstAtom = fixture.session.readParagraph(first!.handle).atoms[0]!;
      const secondAtom = fixture.session.readParagraph(second!.handle).atoms[0]!;
      expect(
        errorCode(() =>
          fixture.session.readImage!({
            paragraphRef: first!.handle.ref,
            objectRef: firstAtom.objectRef,
            expectedRevision: 99,
          }),
        ),
      ).toBe("stale-revision");
      expect(
        errorCode(() =>
          fixture.session.readImage!({
            paragraphRef: "paragraph:missing",
            objectRef: "paragraph:missing:0",
            expectedRevision: 0,
          }),
        ),
      ).toBe("paragraph-not-found");
      expect(
        errorCode(() =>
          fixture.session.readImage!({
            paragraphRef: first!.handle.ref,
            objectRef: secondAtom.objectRef,
            expectedRevision: 0,
          }),
        ),
      ).toBe("object-not-found");
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    [
      "missing",
      "",
      "relationship-missing",
    ],
    [
      "non-image",
      imageRelationship(
        "rIdImage",
        `${R}/hyperlink`,
        "media/image1.png",
      ),
      "relationship-missing",
    ],
  ])(
    "rejects a %s image relationship",
    (_label, relationships, expectedCode) => {
      const fixture = mounted(`<w:p><w:r>${drawing()}</w:r></w:p>`, {
        relationships,
      });
      try {
        const paragraph = fixture.paragraphs[0]!;
        const atom = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
        expect(atom).toMatchObject({
          readable: false,
          complete: false,
          payload: {
            contentStatus: "not_inspected",
            error: { code: expectedCode },
          },
        });
        expect(
          errorCode(() =>
            fixture.session.readImage!({
              paragraphRef: paragraph.handle.ref,
              objectRef: atom.objectRef,
              expectedRevision: 0,
            }),
          ),
        ).toBe(expectedCode);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("rejects DrawingML links and VML external sources", () => {
    for (const [body, relationships] of [
      [
        `<w:p><w:r>${drawing("rIdExternal", "link")}</w:r></w:p>`,
        imageRelationship(
          "rIdExternal",
          IMAGE_REL,
          "https://example.com/image.png",
          "External",
        ),
      ],
      [
        `<w:p><w:r><w:pict><v:shape style="width:1in;height:1in"><v:imagedata src="https://example.com/image.png"/></v:shape></w:pict></w:r></w:p>`,
        "",
      ],
    ] as const) {
      const fixture = mounted(body, { relationships });
      try {
        const paragraph = fixture.paragraphs[0]!;
        const atom = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
        expect(atom).toMatchObject({
          readable: false,
          complete: false,
          payload: {
            contentStatus: "not_inspected",
            error: { code: "external-image" },
          },
        });
        expect(
          errorCode(() =>
            fixture.session.readImage!({
              paragraphRef: paragraph.handle.ref,
              objectRef: atom.objectRef,
              expectedRevision: 0,
            }),
          ),
        ).toBe("external-image");
      } finally {
        fixture.dispose();
      }
    }
  });

  it("distinguishes missing and unsupported image media", () => {
    for (const [media, expectedCode] of [
      [null, "media-missing"],
      [new Uint8Array([1, 2, 3, 4]), "unsupported-media"],
    ] as const) {
      const fixture = mounted(`<w:p><w:r>${drawing()}</w:r></w:p>`, {
        media,
      });
      try {
        const paragraph = fixture.paragraphs[0]!;
        const atom = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
        expect(
          errorCode(() =>
            fixture.session.readImage!({
              paragraphRef: paragraph.handle.ref,
              objectRef: atom.objectRef,
              expectedRevision: 0,
            }),
          ),
        ).toBe(expectedCode);
      } finally {
        fixture.dispose();
      }
    }
  });

  it("does not expose image reads on a host-only session", () => {
    const opened = createServerAutomationHost(
      packageBytes({
        body: `<w:p><w:r>${drawing()}</w:r></w:p>`,
        relationships: imageRelationship(),
      }),
    );
    if (!opened.ok) throw new Error(opened.reason);
    const host: AutomationHost = opened.host;
    try {
      expect(createDocxHostSession(host).readImage).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it("keeps revisions, package parts, and media bytes unchanged while reading", () => {
    const fixture = mounted(`<w:p><w:r>${drawing()}</w:r></w:p>`);
    try {
      const paragraph = fixture.paragraphs[0]!;
      const atom = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
      const beforeDocument = fixture.save();
      const beforePackage = fixture.tree.currentPackage();
      const mediaPart = Array.from(beforePackage.partBytes.keys()).find(
        (part) => part.endsWith("word/media/image1.png"),
      )!;
      const beforeMedia = new Uint8Array(
        beforePackage.partBytes.get(mediaPart)!,
      );
      const beforeRevision = fixture.session.revision();

      fixture.session.readImage!({
        paragraphRef: paragraph.handle.ref,
        objectRef: atom.objectRef,
        expectedRevision: beforeRevision,
      });

      const afterPackage = fixture.tree.currentPackage();
      expect(fixture.session.revision()).toBe(beforeRevision);
      expect(Array.from(fixture.save())).toEqual(Array.from(beforeDocument));
      expect(
        Array.from(afterPackage.partBytes.get(mediaPart)!),
      ).toEqual(Array.from(beforeMedia));
    } finally {
      fixture.dispose();
    }
  });

  it("keeps an image object reference stable after text edits", () => {
    const fixture = mounted(
      `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r>${drawing()}</w:r></w:p>`,
    );
    try {
      const paragraph = fixture.paragraphs[0]!;
      const before = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
      expect(
        fixture.session.replaceParagraphRange({
          paragraphRef: paragraph.handle.ref,
          expectedRevision: 0,
          modelRange: { start: 0, end: 6 },
          expectedText: "Before",
          text: "Changed",
        }),
      ).toEqual({ ok: true, revision: 1, changed: true });

      const after = fixture.session.readParagraph(paragraph.handle).atoms[0]!;
      expect(after.objectRef).toBe(before.objectRef);
      expect(
        fixture.session.readImage!({
          paragraphRef: paragraph.handle.ref,
          objectRef: after.objectRef,
          expectedRevision: 1,
        }).revision,
      ).toBe(1);
      expect(
        errorCode(() =>
          fixture.session.readImage!({
            paragraphRef: paragraph.handle.ref,
            objectRef: after.objectRef,
            expectedRevision: 0,
          }),
        ),
      ).toBe("stale-revision");
    } finally {
      fixture.dispose();
    }
  });
});

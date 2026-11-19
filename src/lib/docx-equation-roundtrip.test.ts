// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import { openTreeSession } from "@docx-editor.dev/core/binding";
import type {
  DocxEditorInstance,
  PaginatedSurface,
  TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import {
  createFixedMeasurer,
  layoutEquation,
  resolveRunStyle,
  type EquationGeometry,
} from "@docx-editor.dev/core/layout";
import {
  paragraphOffsetIndex,
  projectOmmlAtom,
  storyParagraphs,
  writeOoxmlPackage,
} from "@docx-editor.dev/core/store";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "./base64";
import {
  compileDocxEquation,
  DocxEquationConversionError,
  type DocxEquationInput,
} from "./docx-equation-conversion";
import { createDocxSession, type DocxSession } from "./docx-session";
import { convertAdHoc } from "./tauri";

vi.mock("./tauri", () => ({ convertAdHoc: vi.fn() }));

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const SOURCE_NAMESPACE = "https://oleafly.com/ns/equation-source/1";
const pandoc = resolve("src-tauri/binaries/pandoc-aarch64-apple-darwin");
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  ),
);

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("A required fixture value is missing.");
  }
  return value;
}

function packageBytes(display = false): Uint8Array {
  const drawing =
    '<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/>' +
    '<wp:docPr id="1" name="Picture 1" descr="Adjacent chart"/><a:graphic>' +
    `<a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr>` +
    '<pic:cNvPr id="0" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill>' +
    "<pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>";
  const neighbors =
    '<w:r><w:t xml:space="preserve">Before </w:t></w:r>' +
    '<w:fldSimple w:instr=" REF theorem1 \\h "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
    `<w:r>${drawing}</w:r><w:r><w:t xml:space="preserve"> after</w:t></w:r>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${REL}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships xmlns="${REL}"><Relationship Id="rIdImage" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:m="${M}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}">` +
        `<w:body>${display ? "<w:p/>" : ""}<w:p>${neighbors}</w:p><w:sectPr/></w:body></w:document>`,
    ),
    "word/media/image1.png": png,
  });
}

function openSession(bytes: Uint8Array) {
  const opened = openTreeSession(bytes);
  if (!opened.ok) throw new Error(opened.reason);
  const tree: TreeDocxSessionView = opened.session;
  // Keep the production surface transaction boundary, including package history.
  const surface = {
    session: tree,
    packageRevision: () => tree.packageRevision(),
    flushPendingInput: () => {},
    applyAutomationOps(
      staged: Parameters<PaginatedSurface["applyAutomationOps"]>[0],
      scope?: Parameters<PaginatedSurface["applyAutomationOps"]>[1],
      packageEdits?: Parameters<PaginatedSurface["applyAutomationOps"]>[2],
    ) {
      const operations = staged((url) => url);
      if (operations === null) {
        return {
          committed: false,
          rejected: true,
          opCount: 0,
          reason: "planned operation refused",
        };
      }
      const edits = packageEdits ? [...packageEdits] : [];
      return tree.applyTreeOps(
        operations,
        undefined,
        undefined,
        scope,
        edits.length ? { packageEdits: edits } : undefined,
      );
    },
    editingMode: () => "edit" as const,
    collaborationSession: () => null,
    revisionDisplayMode: () => "allMarkup" as const,
    replacementLanding: () => null,
    save: () => writeOoxmlPackage(tree.currentPackage()),
  };
  const session = createDocxSession({
    surface,
    exec: () => ({ ok: true }),
    on: () => () => {},
    can: () => ({ ok: false }),
  } as unknown as DocxEditorInstance);
  return {
    session,
    tree,
    save: () => writeOoxmlPackage(tree.currentPackage()),
  };
}

function firstParagraph(session: DocxSession) {
  const paragraph = session.listParagraphs()[0];
  if (!paragraph) throw new Error("The fixture paragraph is missing.");
  return paragraph;
}

async function compileAndWrite(session: DocxSession, input: DocxEquationInput) {
  const paragraph = firstParagraph(session);
  const expectedRevision = session.revision();
  const compiled = await compileDocxEquation(input);
  if (!session.writeEquation) throw new Error("Equation writes are unavailable.");
  return session.writeEquation(
    {
      paragraphRef: paragraph.handle.ref,
      expectedRevision,
      ...input,
      offset: input.display ? 0 : 7,
    },
    compiled,
  );
}

function parseXml(bytes: Uint8Array): XMLDocument {
  const xml = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  expect(xml.getElementsByTagName("parsererror")).toHaveLength(0);
  return xml;
}

function elements(node: Document | Element, namespace: string, name: string) {
  return Array.from(node.getElementsByTagNameNS(namespace, name));
}

function onlyElement(node: Document | Element, namespace: string, name: string) {
  const matches = elements(node, namespace, name);
  expect(matches, `${namespace} ${name}`).toHaveLength(1);
  return required(matches[0]);
}

function canonicalElement(node: Element): unknown {
  return {
    namespace: node.namespaceURI,
    name: node.localName,
    attributes: Array.from(node.attributes)
      .filter(
        (attribute) => attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/",
      )
      .map((attribute) => [
        attribute.namespaceURI,
        attribute.localName,
        attribute.value,
      ])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    children: Array.from(node.childNodes).map((child) =>
      child.nodeType === Node.ELEMENT_NODE
        ? canonicalElement(child as Element)
        : child.textContent,
    ),
  };
}

function inspectPackage(bytes: Uint8Array) {
  const parts = unzipSync(bytes);
  const documentXml = parseXml(parts["word/document.xml"]);
  const relationships = parseXml(parts["word/_rels/document.xml.rels"]);
  const imageRelation = required(
    elements(relationships, REL, "Relationship").find(
      (node) => node.getAttribute("Id") === "rIdImage",
    ),
  );
  const sources = Object.entries(parts).flatMap(([partName, value]) => {
    if (!/^customXml\/.*\.xml$/.test(partName)) return [];
    const xml = parseXml(value);
    if (xml.documentElement.namespaceURI !== SOURCE_NAMESPACE) return [];
    const related = elements(relationships, REL, "Relationship").filter((node) => {
      const target = required(node.getAttribute("Target"));
      return (
        node.getAttribute("Type") === `${R}/customXml` &&
        posix.normalize(
          target.startsWith("/") ? target.slice(1) : posix.join("word", target),
        ) === partName
      );
    });
    expect(related).toHaveLength(1);
    return elements(xml, SOURCE_NAMESPACE, "data").map((data) =>
      JSON.parse(required(data.textContent)),
    );
  });
  return {
    documentXml,
    sources,
    equations: elements(documentXml, M, "oMath"),
    adjacent: {
      reference: canonicalElement(onlyElement(documentXml, W, "fldSimple")),
      drawing: canonicalElement(onlyElement(documentXml, W, "drawing")),
      imageRelation: canonicalElement(imageRelation),
      image: Array.from(parts["word/media/image1.png"]),
    },
  };
}

function assertSavedBinding(bytes: Uint8Array, input: DocxEquationInput) {
  const saved = inspectPackage(bytes);
  expect(saved.equations).toHaveLength(1);
  expect(saved.sources).toHaveLength(1);
  const equation = required(saved.equations[0]);
  // Check the saved namespace independently of the core's math projection.
  expect(elements(saved.documentXml, "*", "oMath")).toEqual([equation]);
  for (const node of [equation, ...elements(equation, "*", "*")]) {
    if (node.prefix === "m") expect(node.namespaceURI).toBe(M);
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        latex: input.latex,
        macros: input.macros ?? "",
        display: input.display ?? true,
      }),
    )
    .digest("hex");
  const record = required(saved.sources[0]);
  expect(record).toMatchObject({
    version: 1,
    latex: input.latex,
    macros: input.macros ?? "",
    sourceHash: hash,
    display: input.display,
    outputFingerprint: expect.any(String),
  });
  const starts = elements(saved.documentXml, W, "bookmarkStart").filter(
    (node) => node.getAttributeNS(W, "name") === record.bookmark,
  );
  expect(starts).toHaveLength(1);
  const start = required(starts[0]);
  const ends = elements(saved.documentXml, W, "bookmarkEnd").filter(
    (node) => node.getAttributeNS(W, "id") === start.getAttributeNS(W, "id"),
  );
  expect(ends).toHaveLength(1);
  const atom = input.display ? required(equation.parentElement) : equation;
  expect(atom.namespaceURI).toBe(M);
  expect(atom.localName).toBe(input.display ? "oMathPara" : "oMath");
  expect(start.parentElement).toBe(atom.parentElement);
  expect(required(ends[0]).parentElement).toBe(atom.parentElement);
  expect(start.nextElementSibling).toBe(atom);
  expect(atom.nextElementSibling).toBe(ends[0]);
  return saved;
}

function assertLiveBinding(session: DocxSession, input: DocxEquationInput) {
  const paragraph = firstParagraph(session);
  const semantics = session.readParagraph(paragraph.handle);
  const math = semantics.atoms.filter((atom) => atom.kind === "math");
  expect(math).toHaveLength(1);
  expect(math[0]).toMatchObject({
    readable: true,
    complete: true,
    payload: {
      diagnostics: [],
      source: {
        status: "bound",
        latex: input.latex,
        macros: input.macros ?? "",
        display: input.display,
      },
    },
  });
  expect(semantics.modelText).toBe(
    input.display ? "\uFFFC" : "Before \uFFFC\uFFFC\uFFFC after",
  );
}

function geometryNodes(node: EquationGeometry): EquationGeometry[] {
  const nested: EquationGeometry[] = [];
  switch (node.kind) {
    case "row":
    case "delimiter":
      nested.push(...node.items);
      break;
    case "matrix":
      nested.push(...node.rows.flat());
      break;
    case "fraction":
      nested.push(node.numerator, node.denominator);
      break;
    case "radical":
      nested.push(node.sign, node.radicand, ...(node.degree ? [node.degree] : []));
      break;
    case "bar":
    case "borderBox":
      nested.push(node.body);
      break;
    case "script":
      nested.push(
        node.base,
        ...(node.subscript ? [node.subscript] : []),
        ...(node.superscript ? [node.superscript] : []),
      );
      break;
    case "nary":
      nested.push(
        node.operator,
        node.body,
        ...(node.lowerLimit ? [node.lowerLimit] : []),
        ...(node.upperLimit ? [node.upperLimit] : []),
      );
      break;
  }
  return [node, ...nested.flatMap(geometryNodes)];
}

function assertStructuredGeometry(
  tree: TreeDocxSessionView,
  expected: readonly string[],
) {
  const paragraph = storyParagraphs(tree.part().root.children[0])[0];
  if (paragraph?.kind !== "paragraph")
    throw new Error("The geometry fixture paragraph is missing.");
  const projection = paragraphOffsetIndex(paragraph)
    .segments.map((segment) => projectOmmlAtom(segment.node))
    .find((value) => value !== null);
  if (!projection) throw new Error("The saved formula has no OMML projection.");
  const layout = layoutEquation(
    projection,
    createFixedMeasurer(6, 14),
    resolveRunStyle([]),
  );
  expect(layout.truncated).toBe(false);
  const nodes = geometryNodes(layout.geometry);
  expect(nodes.some((node) => node.kind === "fallback")).toBe(false);
  expect(nodes.map((node) => node.kind)).toEqual(expect.arrayContaining([...expected]));
  for (const node of nodes) {
    for (const value of Object.values(node.box))
      expect(Number.isFinite(value)).toBe(true);
    expect(node.box.width).toBeGreaterThanOrEqual(0);
    expect(node.box.height).toBeGreaterThanOrEqual(0);
  }
  const matrix = nodes.find((node) => node.kind === "matrix");
  if (matrix?.kind === "matrix") {
    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rows.every((row) => row.length >= 1)).toBe(true);
    expect(required(required(matrix.rows[1])[0]).box.y).toBeGreaterThan(
      required(required(matrix.rows[0])[0]).box.y,
    );
  }
}

interface FormulaCase {
  name: string;
  latex: string;
  macros?: string;
  structure: string;
  script?: string;
  styles?: Record<string, string>;
  geometry?: string[];
}

const formulas: FormulaCase[] = [
  {
    name: "fraction and radical",
    latex: "\\frac{x_i^2+1}{\\sqrt{y}}",
    structure: "f",
    geometry: ["fraction", "radical", "script"],
  },
  {
    name: "sum",
    latex: "\\sum_{i=1}^n x_i",
    structure: "nary",
    geometry: ["nary"],
  },
  {
    name: "double-struck alphabet",
    latex: "\\mathbb{R}^d",
    structure: "scr",
    script: "double-struck",
  },
  {
    name: "sans-serif alphabet",
    latex: "U^{\\mathsf{T}}",
    structure: "scr",
    script: "sans-serif",
  },
  {
    name: "aligned",
    latex: "\\begin{aligned}a&=b+c\\\\d&=e-f\\end{aligned}",
    structure: "eqArr",
    geometry: ["matrix"],
  },
  {
    name: "split",
    latex: "\\begin{split}a&=b\\\\&=c\\end{split}",
    structure: "eqArr",
    geometry: ["matrix"],
  },
  {
    name: "cases",
    latex: "f(x)=\\begin{cases}x&x>0\\\\0&x<0\\end{cases}",
    structure: "m",
    geometry: ["matrix", "delimiter"],
  },
  {
    name: "explicit macros",
    latex: "\\vect{x}+\\Law(X)",
    macros:
      "\\newcommand{\\vect}[1]{\\mathbf{#1}}\n\\DeclareMathOperator{\\Law}{Law}",
    structure: "sty",
    styles: { x: "b", Law: "p" },
  },
  {
    name: "mixed bold styles",
    latex: "\\mathbf{x}+\\boldsymbol{y}",
    structure: "sty",
    styles: { x: "b", y: "bi" },
  },
];

describe.skipIf(!existsSync(pandoc))("real Pandoc equation roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    vi.mocked(convertAdHoc).mockImplementation(async (request) => {
      const bytes = execFileSync(
        pandoc,
        ["--from=latex", "--to=docx", "--sandbox"],
        {
          input: request.text,
          maxBuffer: 1024 * 1024,
        },
      );
      return {
        kind: "binary",
        text: null,
        dataBase64: bytesToBase64(bytes),
        fileName: "converted.docx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        files: [],
        report: [],
      };
    });
  });

  it.each(formulas)(
    "preserves $name through write, undo/redo and reopen",
    async (formula) => {
      const input = {
        latex: formula.latex,
        macros: formula.macros,
        display: false,
      };
      const original = packageBytes();
      const adjacent = inspectPackage(original).adjacent;
      const fixture = openSession(original);
      expect(await compileAndWrite(fixture.session, input)).toMatchObject({
        ok: true,
        changed: true,
      });
      expect(convertAdHoc).toHaveBeenCalledTimes(1);
      assertLiveBinding(fixture.session, input);
      expect(inspectPackage(fixture.save()).adjacent).toEqual(adjacent);

      fixture.tree.undo();
      const undone = inspectPackage(fixture.save());
      expect(undone.equations).toHaveLength(0);
      expect(undone.sources).toHaveLength(0);
      expect(undone.adjacent).toEqual(adjacent);
      expect(
        fixture.session
          .readParagraph(firstParagraph(fixture.session).handle)
          .atoms.map((atom) => atom.kind),
      ).toEqual(["field", "drawing"]);

      fixture.tree.redo();
      assertLiveBinding(fixture.session, input);
      const saved = fixture.save();
      const inspected = assertSavedBinding(saved, input);
      expect(inspected.adjacent).toEqual(adjacent);
      const equation = required(inspected.equations[0]);
      expect(elements(equation, M, formula.structure).length).toBeGreaterThan(0);
      if (formula.script) {
        expect(
          elements(equation, M, "scr").map((node) => node.getAttributeNS(M, "val")),
        ).toContain(formula.script);
      }
      for (const [text, style] of Object.entries(formula.styles ?? {})) {
        const run = elements(equation, M, "r").find(
          (node) =>
            elements(node, M, "t")
              .map((part) => part.textContent)
              .join("") === text,
        );
        expect(run, `math run ${text}`).toBeDefined();
        expect(onlyElement(required(run), M, "sty").getAttributeNS(M, "val")).toBe(
          style,
        );
      }
      const reopened = openSession(saved);
      assertLiveBinding(reopened.session, input);
      expect(assertSavedBinding(reopened.save(), input).adjacent).toEqual(adjacent);
      if (formula.geometry)
        assertStructuredGeometry(reopened.tree, formula.geometry);
    },
  );

  it("retains display placement and atomic source history after reopening", async () => {
    const input = {
      latex: "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
      display: true,
    };
    const original = packageBytes(true);
    const fixture = openSession(original);
    expect(await compileAndWrite(fixture.session, input)).toMatchObject({
      ok: true,
      changed: true,
    });
    assertLiveBinding(fixture.session, input);
    fixture.tree.undo();
    expect(inspectPackage(fixture.save()).sources).toHaveLength(0);
    expect(inspectPackage(fixture.save()).equations).toHaveLength(0);
    fixture.tree.redo();
    const bytes = fixture.save();
    expect(assertSavedBinding(bytes, input).adjacent).toEqual(
      inspectPackage(original).adjacent,
    );
    const reopened = openSession(bytes);
    assertLiveBinding(reopened.session, input);
    assertStructuredGeometry(reopened.tree, ["matrix"]);
  });

  it.each(["{x", "\\UnknownMath{x}"])(
    "leaves the revision and existing package intact for invalid LaTeX %s",
    async (latex) => {
      const fixture = openSession(packageBytes());
      const input = { latex: "x+1", display: false };
      expect(await compileAndWrite(fixture.session, input)).toMatchObject({
        ok: true,
        changed: true,
      });
      const revision = fixture.session.revision();
      const before = unzipSync(fixture.save());
      await expect(
        compileAndWrite(fixture.session, { latex, display: false }),
      ).rejects.toBeInstanceOf(DocxEquationConversionError);
      expect(fixture.session.revision()).toBe(revision);
      expect(unzipSync(fixture.save())).toEqual(before);
      expect(convertAdHoc).toHaveBeenCalledTimes(1);
      assertLiveBinding(fixture.session, input);
    },
  );
});

import { openTreeSession } from "@docx-editor.dev/core/binding";
import type {
  DocxEditorInstance,
  PaginatedSurface,
  TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import {
  canonicalOoxmlFingerprint,
  customXmlNodes,
  findCustomXmlDataPart,
  listBookmarks,
  paragraphOffsetIndex,
  storyParagraphs,
  withCustomXmlNode,
  writeOoxmlPackage,
  type OoxmlPackage,
} from "@docx-editor.dev/core/store";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { CompiledDocxEquation } from "./docx-equation-conversion";
import {
  equationOfAtom,
  readDocxEquationSource,
  type DocxEquationWriteRequest,
} from "./docx-equations";
import {
  createDocxSession,
  type DocxSession,
} from "./docx-session";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SOURCE_NAMESPACE = "https://oleafly.com/ns/equation-source/1";

type PackageEdit = (pkg: OoxmlPackage) => OoxmlPackage;

function run(text: string): string {
  return `<m:r><m:t>${text}</m:t></m:r>`;
}

function equationArray(left: string, right: string): string {
  return (
    `<m:eqArr><m:e>${run(left)}${run("&amp;")}${run("=")}${run("1")}</m:e>` +
    `<m:e>${run(right)}${run("&amp;")}${run("=")}${run("2")}</m:e>` +
    "</m:eqArr>"
  );
}

function compiledEquation(
  latex: string,
  content: string,
  display = false,
): CompiledDocxEquation {
  return {
    latex,
    macros: "",
    omml: `<m:oMath>${content}</m:oMath>`,
    snippet: "",
    warnings: [],
    sourceHash: `hash:${latex}`,
    shape: {
      expectedMathObjects: 1,
      actualMathObjects: 1,
      display,
      structures: [],
      mathVariants: [],
      variantCorrections: [],
    },
  };
}

function syntheticDocx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="document" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
        "</Relationships>",
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${body}<w:sectPr/>` +
        "</w:body></w:document>",
    ),
  });
}

function fixture(body: string) {
  const opened = openTreeSession(syntheticDocx(body));
  if (!opened.ok) throw new Error(opened.reason);
  const tree: TreeDocxSessionView = opened.session;
  const packageEditBatches: PackageEdit[][] = [];

  const surface = {
    session: tree,
    packageRevision: () => tree.packageRevision(),
    flushPendingInput: () => {},
    applyAutomationOps(
      staged: Parameters<PaginatedSurface["applyAutomationOps"]>[0],
      scope?: Parameters<PaginatedSurface["applyAutomationOps"]>[1],
      packageEdits?: Parameters<PaginatedSurface["applyAutomationOps"]>[2],
      _requiresReview?: Parameters<
        PaginatedSurface["applyAutomationOps"]
      >[3],
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
      packageEditBatches.push(edits);
      // PaginatedSurface passes package edits through the fifth applyTreeOps argument.
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
  const editor = {
    surface,
    exec: () => ({ ok: true }),
    on: () => () => {},
    can: () => ({ ok: false }),
  } as unknown as DocxEditorInstance;

  return {
    session: createDocxSession(editor),
    tree,
    packageEditBatches,
    save: () => writeOoxmlPackage(tree.currentPackage()),
  };
}

function paragraphOf(tree: TreeDocxSessionView) {
  const paragraph = storyParagraphs(tree.part().root.children[0])[0];
  if (paragraph?.kind !== "paragraph") {
    throw new Error("The fixture has no paragraph.");
  }
  return paragraph;
}

function equationsIn(tree: TreeDocxSessionView) {
  const paragraph = paragraphOf(tree);
  const pkg = tree.currentPackage();
  const bookmarks = listBookmarks(tree.part());
  return paragraphOffsetIndex(paragraph).segments.flatMap((segment) => {
    const equation = equationOfAtom(segment.node);
    if (!equation) return [];
    return [
      {
        atom: segment.node,
        equation,
        start: segment.start,
        end: segment.end,
        fingerprint: canonicalOoxmlFingerprint(equation),
        source: readDocxEquationSource(
          pkg,
          paragraph,
          segment.node,
          segment.start,
          segment.end,
        ),
        bookmarks: bookmarks.filter(
          (bookmark) =>
            bookmark.start.paragraphId === paragraph.id &&
            bookmark.end.paragraphId === paragraph.id &&
            bookmark.start.offset === segment.start &&
            bookmark.end.offset === segment.end,
        ),
      },
    ];
  });
}

function sourceRecordCount(tree: TreeDocxSessionView): number {
  const pkg = tree.currentPackage();
  const part = findCustomXmlDataPart(
    pkg,
    pkg.mainDocumentPart,
    SOURCE_NAMESPACE,
  );
  return part ? customXmlNodes(pkg, part.partName).length : 0;
}

function firstParagraph(session: DocxSession) {
  const paragraph = session.listParagraphs()[0];
  if (!paragraph) throw new Error("The fixture has no paragraph.");
  return paragraph;
}

function firstEquation(tree: TreeDocxSessionView) {
  const equation = equationsIn(tree)[0];
  if (!equation) throw new Error("The fixture has no equation.");
  return equation;
}

function writeEquation(
  session: DocxSession,
  request: DocxEquationWriteRequest,
  compiled: CompiledDocxEquation,
) {
  if (!session.writeEquation) {
    throw new Error("The fixture session cannot write equations.");
  }
  return session.writeEquation(request, compiled);
}

function reopened(bytes: Uint8Array): TreeDocxSessionView {
  const opened = openTreeSession(bytes);
  if (!opened.ok) throw new Error(opened.reason);
  return opened.session;
}

function xmlPart(bytes: Uint8Array, name: string): string {
  const part = unzipSync(bytes)[name];
  return part ? new TextDecoder().decode(part) : "";
}

function mathAtom(session: DocxSession) {
  const paragraph = firstParagraph(session);
  const atom = session
    .readParagraph(paragraph.handle)
    .atoms.find((item) => item.kind === "math");
  if (!atom) throw new Error("The fixture has no equation atom.");
  return { paragraph, atom };
}

describe("DOCX equation source binding", () => {
  it("inserts inline math, saves its source atomically, and preserves adjacent content", () => {
    const f = fixture(
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r>' +
        '<w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple>' +
        '<w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>',
    );
    const paragraph = firstParagraph(f.session);
    const before = f.session.readParagraph(paragraph.handle);
    expect(before.modelText).toBe("Before \uFFFC after");
    expect(before.atoms.map((atom) => atom.kind)).toEqual(["field"]);

    const result = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: before.revision,
        latex: "x+1",
        offset: 7,
      },
      compiledEquation("x+1", `${run("x")}${run("+1")}`),
    );
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(f.packageEditBatches.map((batch) => batch.length)).toEqual([1]);

    const after = f.session.readParagraph(paragraph.handle);
    expect(after.modelText).toBe("Before \uFFFC\uFFFC after");
    expect(after.atoms.map((atom) => atom.kind)).toEqual(["math", "field"]);
    expect(after.atoms[1]).toMatchObject({
      kind: "field",
      displayText: "7",
      complete: true,
    });
    expect(equationsIn(f.tree)).toMatchObject([
      {
        source: {
          status: "bound",
          latex: "x+1",
          display: false,
        },
      },
    ]);

    const saved = f.save();
    expect(xmlPart(saved, "word/document.xml")).toContain(
      "<m:oMath>",
    );
    expect(equationsIn(reopened(saved))).toMatchObject([
      {
        source: {
          status: "bound",
          latex: "x+1",
          display: false,
        },
      },
    ]);

    f.tree.undo();
    expect(equationsIn(f.tree)).toHaveLength(0);
    expect(sourceRecordCount(f.tree)).toBe(0);
    expect(f.session.readParagraph(paragraph.handle).atoms).toMatchObject([
      { kind: "field", displayText: "7" },
    ]);
    f.tree.redo();
    expect(equationsIn(f.tree)).toMatchObject([
      { source: { status: "bound", latex: "x+1" } },
    ]);
    expect(sourceRecordCount(f.tree)).toBe(1);
  });

  it("binds adjacent equations inserted at the end of a trailing simple field", () => {
    const f = fixture(
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r>' +
        `<m:oMath>${run("x")}</m:oMath>` +
        '<w:r><w:t xml:space="preserve"> after </w:t></w:r>' +
        '<w:fldSimple w:instr=" REF theorem1 \\h "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
        "</w:p>",
    );
    const paragraph = firstParagraph(f.session);
    const before = f.session.readParagraph(paragraph.handle);
    const field = before.atoms.find((atom) => atom.kind === "field");
    if (!field) throw new Error("The fixture has no field atom.");
    const insertionStart = before.modelText.length;

    const first = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: before.revision,
        latex: "y+1",
        offset: insertionStart,
      },
      compiledEquation("y+1", `${run("y")}${run("+1")}`),
    );
    expect(first).toMatchObject({ ok: true, changed: true });
    if (!first.ok) return;

    const second = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: first.revision,
        latex: "z+2",
        offset: insertionStart + 1,
      },
      compiledEquation("z+2", `${run("z")}${run("+2")}`),
    );
    expect(second).toMatchObject({ ok: true, changed: true });

    const after = f.session.readParagraph(paragraph.handle);
    expect(after.modelText).toBe(`${before.modelText}\uFFFC\uFFFC`);
    expect(after.atoms.map((atom) => atom.kind)).toEqual([
      "math",
      "field",
      "math",
      "math",
    ]);
    expect(after.atoms[1]).toMatchObject({
      kind: "field",
      modelRange: field.modelRange,
    });

    const equations = equationsIn(f.tree);
    expect(equations.map((item) => item.source.status)).toEqual([
      "unbound",
      "bound",
      "bound",
    ]);
    expect(equations.slice(1).map((item) => item.source.latex)).toEqual([
      "y+1",
      "z+2",
    ]);
    expect(
      equations.slice(1).map((item) => ({
        range: [{ start: item.start, end: item.end }, item.bookmarks.map((bookmark) => [
          bookmark.start.offset,
          bookmark.end.offset,
        ])],
      })),
    ).toEqual([
      {
        range: [
          { start: insertionStart, end: insertionStart + 1 },
          [[insertionStart, insertionStart + 1]],
        ],
      },
      {
        range: [
          { start: insertionStart + 1, end: insertionStart + 2 },
          [[insertionStart + 1, insertionStart + 2]],
        ],
      },
    ]);
    expect(sourceRecordCount(f.tree)).toBe(2);

    f.tree.undo();
    expect(equationsIn(f.tree).map((item) => item.source.status)).toEqual([
      "unbound",
      "bound",
    ]);
    f.tree.redo();
    expect(equationsIn(f.tree).map((item) => item.source.status)).toEqual([
      "unbound",
      "bound",
      "bound",
    ]);

    const saved = reopened(f.save());
    expect(equationsIn(saved).map((item) => item.source.status)).toEqual([
      "unbound",
      "bound",
      "bound",
    ]);
    expect(equationsIn(saved).slice(1).map((item) => item.source.latex)).toEqual([
      "y+1",
      "z+2",
    ]);
  });

  it("keeps an existing source bound when another formula is inserted at its start", () => {
    const f = fixture('<w:p><w:r><w:t>AB</w:t></w:r></w:p>');
    const paragraph = firstParagraph(f.session);
    for (const [revision, source] of ["x", "y"].entries()) {
      expect(writeEquation(f.session, {
        paragraphRef: paragraph.handle.ref, expectedRevision: revision,
        latex: source, offset: 1,
      }, compiledEquation(source, run(source)))).toMatchObject({ ok: true, changed: true });
    }
    const bindings = equationsIn(f.tree);
    expect(bindings.map((item) => item.source)).toMatchObject([
      { status: "bound", latex: "y" }, { status: "bound", latex: "x" },
    ]);
    expect(bindings.map((item) => item.bookmarks.map((bookmark) => [bookmark.start.offset, bookmark.end.offset])))
      .toEqual([[[1, 2]], [[2, 3]]]);
    expect(equationsIn(reopened(f.save())).map((item) => item.source)).toMatchObject([
      { status: "bound", latex: "y" }, { status: "bound", latex: "x" },
    ]);
  });

  it("inserts display math as a closed oMathPara and records display placement", () => {
    const f = fixture("<w:p/>");
    const paragraph = firstParagraph(f.session);
    const result = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: 0,
        latex: "x^2",
        offset: 0,
        display: true,
      },
      compiledEquation("x^2", `<m:sSup><m:e>${run("x")}</m:e>` +
        `<m:sup>${run("2")}</m:sup></m:sSup>`, true),
    );

    expect(result).toMatchObject({ ok: true, changed: true });
    const binding = firstEquation(f.tree);
    expect(binding.atom).toMatchObject({
      kind: "generic",
      namespaceUri: M,
      localName: "oMathPara",
    });
    expect(binding.source).toMatchObject({
      status: "bound",
      latex: "x^2",
      display: true,
    });
    expect(xmlPart(f.save(), "word/document.xml")).toContain(
      "<m:oMathPara>",
    );
  });

  it("requires explicit adoption and the current fingerprint for imported complex math", () => {
    const f = fixture(
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r>' +
        `<m:oMath>${equationArray("x", "verylong")}</m:oMath>` +
        '<w:r><w:t xml:space="preserve"> after </w:t></w:r>' +
        '<w:fldSimple w:instr="PAGE"><w:r><w:t>7</w:t></w:r></w:fldSimple>' +
        "</w:p>",
    );
    const { paragraph, atom } = mathAtom(f.session);
    const semantics = f.session.readParagraph(paragraph.handle);
    const imported = firstEquation(f.tree);
    expect(atom.complete).toBe(true);
    expect(imported.source.status).toBe("unbound");
    expect(semantics.modelText).toBe("Before \uFFFC after \uFFFC");

    const replacement = compiledEquation(
      "\\begin{aligned}y&=3\\\\z&=4\\end{aligned}",
      equationArray("y", "z"),
    );
    const request = {
      paragraphRef: paragraph.handle.ref,
      latex: replacement.latex,
      objectRef: atom.objectRef,
      expectedRevision: semantics.revision,
      expectedFingerprint: imported.fingerprint,
    };

    expect(
      writeEquation(
        f.session,
        { ...request, expectedRevision: semantics.revision + 1 },
        replacement,
      ),
    ).toMatchObject({ ok: false, code: "stale-target", changed: false });
    expect(
      writeEquation(
        f.session,
        { ...request, expectedFingerprint: "wrong-fingerprint" },
        replacement,
      ),
    ).toMatchObject({ ok: false, code: "stale-target", changed: false });
    expect(writeEquation(f.session, request, replacement)).toMatchObject({
      ok: false,
      code: "unsupported-target",
      changed: false,
    });
    expect(sourceRecordCount(f.tree)).toBe(0);

    expect(
      writeEquation(
        f.session,
        { ...request, adoptSource: true },
        replacement,
      ),
    ).toMatchObject({ ok: true, changed: true });
    const adopted = firstEquation(f.tree);
    expect(adopted.source).toMatchObject({
      status: "bound",
      latex: replacement.latex,
    });
    expect(f.session.readParagraph(paragraph.handle)).toMatchObject({
      modelText: "Before \uFFFC after \uFFFC",
      atoms: [{ kind: "math" }, { kind: "field" }],
    });
  });

  it("collapses duplicate source metadata into one binding only when adoption is explicit", () => {
    const f = fixture('<w:p><w:r><w:t>AB</w:t></w:r></w:p>');
    const paragraph = firstParagraph(f.session);
    const inserted = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: 0,
        latex: "x+1",
        offset: 1,
      },
      compiledEquation("x+1", `${run("x")}${run("+1")}`),
    );
    expect(inserted).toMatchObject({ ok: true, changed: true });
    if (!inserted.ok) return;

    const { paragraph: sourceParagraph, atom } = mathAtom(f.session);
    const prefix = `${sourceParagraph.handle.ref}:`;
    const atomId = atom.objectRef.startsWith(prefix)
      ? atom.objectRef.slice(prefix.length)
      : "";
    const segment = paragraphOffsetIndex(paragraphOf(f.tree)).segments.find(
      (item) => item.node.id === atomId,
    );
    if (!segment) throw new Error("The inserted equation has no paragraph span.");
    const pkg = f.tree.currentPackage();
    const dataPart = findCustomXmlDataPart(
      pkg,
      pkg.mainDocumentPart,
      SOURCE_NAMESPACE,
    );
    if (!dataPart) throw new Error("The fixture has no equation source part.");
    const [record] = customXmlNodes(pkg, dataPart.partName);
    if (!record) throw new Error("The fixture has no equation source record.");
    const sourceData = JSON.parse(record.data) as { bookmark: string };
    const duplicateBookmark = "_OleaflyEq_duplicate";
    const duplicate = f.tree.applyTreeOps([], undefined, undefined, undefined, {
      packageEdits: [
        (current) =>
          withCustomXmlNode(current, dataPart.partName, {
            id: `${record.id}_duplicate`,
            label: record.label,
            data: JSON.stringify({ ...sourceData, bookmark: duplicateBookmark }),
          }),
      ],
    });
    expect(duplicate).toMatchObject({ committed: true, rejected: false });
    const duplicateMarkers = f.tree.applyTreeOps([
      {
        op: "insertBookmark",
        name: duplicateBookmark,
        start: { paragraphId: paragraphOf(f.tree).id, offset: segment.start },
        end: { paragraphId: paragraphOf(f.tree).id, offset: segment.end },
      },
    ]);
    expect(duplicateMarkers).toMatchObject({ committed: true, rejected: false });
    expect(sourceRecordCount(f.tree)).toBe(2);
    expect(firstEquation(f.tree).source.status).toBe("stale");

    const before = f.session.readParagraph(sourceParagraph.handle);
    const original = firstEquation(f.tree);
    const replacement = compiledEquation("z+1", `${run("z")}${run("+1")}`);
    const adopted = writeEquation(
      f.session,
      {
        paragraphRef: sourceParagraph.handle.ref,
        expectedRevision: before.revision,
        latex: replacement.latex,
        objectRef: atom.objectRef,
        expectedFingerprint: original.fingerprint,
        adoptSource: true,
      },
      replacement,
    );
    expect(adopted).toMatchObject({ ok: true, changed: true });
    expect(sourceRecordCount(f.tree)).toBe(1);
    expect(firstEquation(f.tree).source).toMatchObject({
      status: "bound",
      latex: "z+1",
    });

    f.tree.undo();
    expect(sourceRecordCount(f.tree)).toBe(2);
    expect(firstEquation(f.tree).source.status).toBe("stale");
    expect(firstEquation(f.tree).bookmarks).toHaveLength(2);
    f.tree.redo();
    expect(sourceRecordCount(f.tree)).toBe(1);
    expect(firstEquation(f.tree).bookmarks).toHaveLength(1);

    const saved = reopened(f.save());
    expect(sourceRecordCount(saved)).toBe(1);
    expect(equationsIn(saved)[0]?.source).toMatchObject({
      status: "bound",
      latex: "z+1",
    });
  });

  it("keeps duplicate formulas independently bound and marks external math edits stale", () => {
    const f = fixture(
      '<w:p><w:r><w:t>AB</w:t></w:r></w:p>',
    );
    const paragraph = firstParagraph(f.session);
    const first = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: 0,
        latex: "x+1",
        offset: 1,
      },
      compiledEquation("x+1", `${run("x")}${run("+1")}`),
    );
    expect(first).toMatchObject({ ok: true, changed: true });
    if (!first.ok) return;

    const second = writeEquation(
      f.session,
      {
        paragraphRef: paragraph.handle.ref,
        expectedRevision: first.revision,
        latex: "x+1",
        offset: 3,
      },
      compiledEquation("x+1", `${run("x")}${run("+1")}`),
    );
    expect(second).toMatchObject({ ok: true, changed: true });

    const initial = equationsIn(f.tree);
    expect(initial).toHaveLength(2);
    const [firstFormula, secondFormula] = initial;
    if (!firstFormula || !secondFormula) {
      throw new Error("The fixture did not create two equations.");
    }
    expect(initial.map((item) => item.source.status)).toEqual([
      "bound",
      "bound",
    ]);
    const bookmarkNames = initial.flatMap((item) =>
      item.bookmarks.map((bookmark) => bookmark.name),
    );
    expect(bookmarkNames).toHaveLength(2);
    expect(new Set(bookmarkNames).size).toBe(2);
    expect(sourceRecordCount(f.tree)).toBe(2);

    const external = f.tree.applyTreeOps([
      {
        op: "setMathEquation",
        equationId: firstFormula.equation.id,
        linear: "z",
      },
    ]);
    expect(external.committed).toBe(true);
    const changed = equationsIn(f.tree);
    const [changedFirst] = changed;
    if (!changedFirst) throw new Error("The changed equation is missing.");
    expect(changed.map((item) => item.source.status)).toEqual([
      "stale",
      "bound",
    ]);

    const current = mathAtom(f.session);
    const rejected = writeEquation(
      f.session,
      {
        paragraphRef: current.paragraph.handle.ref,
        expectedRevision: f.session.revision(),
        latex: "z+1",
        objectRef: current.atom.objectRef,
        expectedFingerprint: changedFirst.fingerprint,
      },
      compiledEquation("z+1", `${run("z")}${run("+1")}`),
    );
    expect(rejected).toMatchObject({
      ok: false,
      code: "unsupported-target",
      changed: false,
    });
  });
});

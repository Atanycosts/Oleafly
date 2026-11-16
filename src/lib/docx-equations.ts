import type { AutomationHandle, AutomationHost } from "@docx-editor.dev/core/automation";
import type { PaginatedSurface } from "@docx-editor.dev/core/editor";
import {
  canonicalOoxmlFingerprint,
  customXmlNodes,
  findCustomXmlDataPart,
  listBookmarks,
  paragraphOffsetIndex,
  readMathEquationOoxml,
  withCustomXmlDataPart,
  withCustomXmlNode,
  withoutCustomXmlNode,
  type OoxmlGenericElementNode,
  type OoxmlNode,
  type OoxmlPackage,
  type OoxmlParagraphNode,
  type OoxmlPart,
  type TreeDocOp,
} from "@docx-editor.dev/core/store";
import type { CompiledDocxEquation } from "./docx-equation-conversion";
import type { DocxApplyResult } from "./docx-session";
import { readDocxMathPayload } from "./docx-math";

const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const SOURCE_NAMESPACE = "https://oleafly.com/ns/equation-source/1";

export interface DocxEquationWriteRequest {
  paragraphRef: string;
  expectedRevision: number;
  latex: string;
  macros?: string;
  /** Replace exactly this equation atom, or insert at offset when absent. */
  objectRef?: string;
  expectedFingerprint?: string;
  /** Explicit adoption of imported OMML or an externally changed source formula. */
  adoptSource?: boolean;
  offset?: number;
  display?: boolean;
}

interface EquationSource {
  version: 1;
  bookmark: string;
  latex: string;
  macros: string;
  sourceHash: string;
  outputFingerprint: string;
  display: boolean;
}

export interface DocxEquationSourceView {
  status: "bound" | "stale" | "unbound";
  latex?: string;
  macros?: string;
  sourceHash?: string;
  display?: boolean;
}

function children(node: OoxmlNode): readonly OoxmlNode[] {
  return node.kind === "textValue" ? [] : node.children;
}

function math(node: OoxmlNode, name: string): node is OoxmlGenericElementNode {
  return node.kind === "generic" && node.namespaceUri === MATH && node.localName === name;
}

export function equationOfAtom(node: OoxmlNode): OoxmlGenericElementNode | null {
  if (math(node, "oMath")) return node;
  if (!math(node, "oMathPara")) return null;
  const equations = children(node).filter((child) => math(child, "oMath"));
  return equations.length === 1 ? equations[0] as OoxmlGenericElementNode : null;
}

const sourceCache = new WeakMap<OoxmlPackage, readonly (EquationSource & { id: string })[]>();
const bookmarkCache = new WeakMap<OoxmlPart, ReturnType<typeof listBookmarks>>();

function bookmarksOf(part: OoxmlPart) {
  let bookmarks = bookmarkCache.get(part);
  if (!bookmarks) {
    bookmarks = listBookmarks(part);
    bookmarkCache.set(part, bookmarks);
  }
  return bookmarks;
}

function sourceRecords(pkg: OoxmlPackage): readonly (EquationSource & { id: string })[] {
  const cached = sourceCache.get(pkg);
  if (cached) return cached;
  const dataPart = findCustomXmlDataPart(pkg, pkg.mainDocumentPart, SOURCE_NAMESPACE);
  if (!dataPart) return [];
  const records = customXmlNodes(pkg, dataPart.partName).flatMap((node) => {
    try {
      const record = JSON.parse(node.data) as Partial<EquationSource>;
      if (record.version !== 1 || typeof record.bookmark !== "string" ||
          typeof record.latex !== "string" || typeof record.macros !== "string" ||
          typeof record.sourceHash !== "string" || typeof record.outputFingerprint !== "string" ||
          typeof record.display !== "boolean") return [];
      return [{ ...record as EquationSource, id: node.id }];
    } catch { return []; }
  });
  sourceCache.set(pkg, records);
  return records;
}

/** A binding uses a bookmark instance and its output, never equation text alone. */
export function readDocxEquationSource(
  pkg: OoxmlPackage,
  paragraph: OoxmlParagraphNode,
  atom: OoxmlNode,
  start: number,
  end: number,
): DocxEquationSourceView {
  const equation = equationOfAtom(atom);
  if (!equation) return { status: "unbound" };
  const part = pkg.parts.get(pkg.mainDocumentPart);
  if (!part) throw new Error("The equation's document part is unavailable.");
  const bookmarks = bookmarksOf(part).filter((bookmark) =>
    bookmark.start.paragraphId === paragraph.id && bookmark.end.paragraphId === paragraph.id &&
    bookmark.start.offset === start && bookmark.end.offset === end);
  const matches = sourceRecords(pkg).flatMap((record) => {
    const bookmark = bookmarks.find((candidate) => candidate.name === record.bookmark);
    return bookmark ? [{ record, bookmark }] : [];
  });
  const match = matches[0];
  if (!match || matches.length !== 1) return { status: matches.length ? "stale" : "unbound", display: math(atom, "oMathPara") };
  const { record, bookmark } = match;
  return {
    status: bookmark.copies === 1 && record.display === math(atom, "oMathPara") && record.outputFingerprint === canonicalOoxmlFingerprint(equation)
      ? "bound" : "stale",
    latex: record.latex, macros: record.macros, sourceHash: record.sourceHash, display: math(atom, "oMathPara"),
  };
}

function findParagraph(node: OoxmlNode, id: string): OoxmlParagraphNode | null {
  if (node.id === id && node.kind === "paragraph") return node;
  for (const child of children(node)) {
    const found = findParagraph(child, id);
    if (found) return found;
  }
  return null;
}

function fail(revision: number, message: string, code: "stale-target" | "unsupported-target" | "invalid-range" | "transaction-refused" = "unsupported-target"): DocxApplyResult {
  return { ok: false, code, message, changed: false, revision };
}

/** All source and math changes enter the existing package transaction and history. */
export function writeDocxEquation(
  host: AutomationHost,
  surface: PaginatedSurface,
  paragraphHandle: AutomationHandle<"paragraph">,
  request: DocxEquationWriteRequest,
  compiled: CompiledDocxEquation,
): DocxApplyResult {
  surface.flushPendingInput();
  if (host.revision() !== request.expectedRevision) return fail(host.revision(), "The equation revision changed. Read it again.", "stale-target");
  if (surface.editingMode() !== "edit") return fail(host.revision(), "Source equation writes require editing mode; tracked equation replacement is not available.");
  const response = host.execute({ operations: [{ op: "getParagraphId", paragraph: paragraphHandle }] });
  const value = response.results[0];
  if (value?.status !== "ok" || value.value.kind !== "text") return fail(host.revision(), "The paragraph is no longer available.", "stale-target");
  const paragraphId = surface.session.nodeIdOf(value.value.text);
  const pkg = surface.session.currentPackage();
  const part = surface.session.part();
  const paragraph = paragraphId ? findParagraph(part.root, paragraphId) : null;
  if (!paragraph || paragraphHandle.ref !== request.paragraphRef) return fail(host.revision(), "The paragraph is no longer available.", "stale-target");
  const parsed = readMathEquationOoxml(compiled.omml);
  if (!parsed.ok) return fail(host.revision(), `The generated equation was refused: ${parsed.reason}`);
  const projection = readDocxMathPayload(parsed.equation);
  if (!projection.complete) return fail(host.revision(), `The generated equation has unsupported content: ${projection.payload.diagnostics.map((item) => `${item.path}: ${item.reason}`).join("; ")}`);
  const index = paragraphOffsetIndex(paragraph);
  if (request.objectRef && request.offset !== undefined) return fail(host.revision(), "Choose either an existing equation or an insertion offset.", "invalid-range");
  const operations: TreeDocOp[] = [];
  const existingRecords = sourceRecords(pkg);
  const staleNames = new Set<string>();
  let start: number;
  let display: boolean;
  let bookmarkName: string | undefined;
  let sourceId: string | undefined;
  if (request.objectRef) {
    const prefix = `${paragraphHandle.ref}:`;
    const atomId = request.objectRef.startsWith(prefix) ? request.objectRef.slice(prefix.length) : "";
    const segment = index.segments.find((item) => item.node.id === atomId);
    const equation = segment ? equationOfAtom(segment.node) : null;
    if (!segment || !equation) return fail(host.revision(), "Read and select exactly one equation atom before replacing it.", "stale-target");
    if (!request.expectedFingerprint || request.expectedFingerprint !== canonicalOoxmlFingerprint(equation)) return fail(host.revision(), "The original equation changed. Read it again before replacing it.", "stale-target");
    const source = readDocxEquationSource(pkg, paragraph, segment.node, segment.start, segment.end);
    if (source.status !== "bound" && request.adoptSource !== true) {
      return fail(host.revision(), "Replacing original or externally modified math requires explicit adoption of the supplied LaTeX source.");
    }
    const boundaryBookmarks = bookmarksOf(part).filter((bookmark) =>
      bookmark.start.paragraphId === paragraph.id && bookmark.end.paragraphId === paragraph.id &&
      bookmark.start.offset === segment.start && bookmark.end.offset === segment.end);
    for (const bookmark of boundaryBookmarks) {
      if (existingRecords.some((record) => record.bookmark === bookmark.name)) {
        staleNames.add(bookmark.name);
      }
    }
    const bindings = boundaryBookmarks.filter((bookmark) =>
      bookmark.copies === 1 &&
      existingRecords.some((record) => record.bookmark === bookmark.name));
    const bound = bindings.length === 1 ? bindings[0] : undefined;
    if (bound) {
      bookmarkName = bound.name;
      sourceId = existingRecords.find((record) => record.bookmark === bound.name)?.id;
    } else {
      for (const name of staleNames) operations.push({ op: "deleteBookmark", name });
    }
    start = segment.start;
    display = math(segment.node, "oMathPara");
    if (request.display !== undefined && request.display !== display) return fail(host.revision(), "Replacement retains the original inline/display placement.");
    operations.push({ op: "setMathEquation", equationId: equation.id, equation: parsed.equation });
  } else {
    if (request.offset === undefined || !Number.isInteger(request.offset) || request.offset < 0 || request.offset > index.length) return fail(host.revision(), "Insert at a current paragraph modelText offset.", "invalid-range");
    start = request.offset;
    display = request.display ?? false;
    if (display && index.length !== 0) return fail(host.revision(), "Insert a display equation into an empty paragraph.");
    operations.push({ op: "insertEquation", paragraphId: paragraph.id, offset: start,
      nodes: [parsed.equation], length: 1, ...(display ? { display: true } : {}) });
    // Word range markers can grow when content is inserted at an edge. A source
    // bookmark owns exactly its equation, so restore adjacent bindings in this
    // same transaction rather than letting the new equation join their ranges.
    for (const bookmark of bookmarksOf(part)) {
      if (bookmark.copies !== 1 || bookmark.start.paragraphId !== paragraph.id ||
          bookmark.end.paragraphId !== paragraph.id ||
          !existingRecords.some((record) => record.bookmark === bookmark.name) ||
          (bookmark.start.offset !== start && bookmark.end.offset !== start)) continue;
      const atom = index.segments.find((segment) => segment.start === bookmark.start.offset &&
        segment.end === bookmark.end.offset && equationOfAtom(segment.node));
      if (!atom) continue;
      const shift = atom.start >= start ? 1 : 0;
      operations.push({ op: "insertBookmark", name: bookmark.name,
        start: { paragraphId: paragraph.id, offset: atom.start + shift },
        end: { paragraphId: paragraph.id, offset: atom.end + shift } });
    }
  }
  sourceId ??= `eq_${crypto.randomUUID().replaceAll("-", "")}`;
  const recordId = sourceId;
  bookmarkName ??= `_OleaflyEq_${sourceId.slice(3, 27)}`;
  if (!bookmarksOf(part).some((bookmark) => bookmark.name === bookmarkName)) {
    operations.push({ op: "insertBookmark", name: bookmarkName,
      start: { paragraphId: paragraph.id, offset: start }, end: { paragraphId: paragraph.id, offset: start + 1 } });
  }
  const record: EquationSource = { version: 1, bookmark: bookmarkName, latex: compiled.latex,
    macros: compiled.macros, sourceHash: compiled.sourceHash,
    outputFingerprint: canonicalOoxmlFingerprint(parsed.equation), display };
  const editSource = (current: OoxmlPackage): OoxmlPackage => {
    const created = withCustomXmlDataPart(current, current.mainDocumentPart, SOURCE_NAMESPACE, "equations");
    if (!created.part) throw new Error("The equation source could not be retained.");
    let next = withCustomXmlNode(created.pkg, created.part.partName, {
      id: recordId, label: "LaTeX equation", data: JSON.stringify(record),
    });
    for (const stale of existingRecords) {
      if (stale.id !== recordId && staleNames.has(stale.bookmark)) {
        next = withoutCustomXmlNode(next, created.part.partName, stale.id);
      }
    }
    const matching = customXmlNodes(next, created.part.partName).filter((item) =>
      item.id === sourceId && item.data === JSON.stringify(record));
    if (matching.length !== 1 ||
        sourceRecords(next).some((item) => item.id !== recordId && staleNames.has(item.bookmark))) {
      throw new Error("The equation source transaction was refused.");
    }
    return next;
  };
  const result = surface.applyAutomationOps(() => operations, undefined, [editSource]);
  return result.rejected
    ? fail(host.revision(), result.reason ?? "The equation transaction was refused.", "transaction-refused")
    : { ok: true, revision: host.revision(), changed: result.committed };
}

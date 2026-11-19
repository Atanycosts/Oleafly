import type {
  AutomationBatchRequest,
  AutomationBatchResponse,
  AutomationChangeEvent,
  AutomationError,
  AutomationErrorCode,
  AutomationFontRead,
  AutomationFontWrite,
  AutomationHandle,
  AutomationHost,
  AutomationOperationResult,
  AutomationParagraphFormatRead,
  AutomationParagraphFormatWrite,
  AutomationSpanRef,
  AutomationUnsubscribe,
  AutomationValue,
} from "@docx-editor.dev/core/automation";
import type { DocxObjectFormatMutation } from "@oleafly/ai-tools";
import {
  DocxImageReadError,
  imageAtomPayload,
  readDocxImageObject,
  type DocxImageReadRequest,
  type DocxImageReadResult,
} from "./docx-images";
import {
  createBrowserAutomationHost,
  type DocxEditorInstance,
  type PaginatedSurface,
  type TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import {
  buildStyleCascadeTable,
  cascadeParagraphFormatting,
  paragraphBreaksBefore,
  readTableStructure,
} from "@docx-editor.dev/core/layout";
import {
  canonicalOoxmlFingerprint,
  directParagraphProperties,
  fldCharType,
  fldSimpleInstr,
  mergedParagraphMarkProperties,
  mergedProperties,
  ooxmlTreesEqual,
  paragraphOffsetIndex,
  paragraphTextOf,
  planImportStyles,
  readOoxmlPackage,
  instrTextValue,
  propertyContainer,
  runPropertyEdits,
  segmentsOf,
  type OoxmlElement,
  type OoxmlNode,
  type OoxmlParagraphNode,
  type OoxmlProperty,
  type TreeDocOp,
} from "@docx-editor.dev/core/store";
import { planDocxObjectFormat } from "./docx-object-format";
import { readDocxMathPayload } from "./docx-math";
import { readDocxEquationSource, equationOfAtom, writeDocxEquation, type DocxEquationWriteRequest } from "./docx-equations";
import type { CompiledDocxEquation } from "./docx-equation-conversion";

export interface DocxParagraph {
  readonly handle: AutomationHandle<"paragraph">;
  readonly text: string;
  /** Present only when the host can answer the paragraph's OOXML identity. */
  readonly paraId?: string;
}

export interface DocxTarget {
  /** The paragraph handle stays valid for the life of the host. */
  readonly paragraph: AutomationHandle<"paragraph">;
  readonly original: string;
  /** The revision at which `original` was read. */
  readonly revision: number;
  /** Present only when the host can answer the paragraph's OOXML identity. */
  readonly paraId?: string;
  /** Canonical paragraph structure captured by the live editor, when available. */
  readonly structure?: string;
}

export interface DocxParagraphLocator {
  readonly part: string;
  readonly path: number[];
  readonly paragraphIndex?: number;
}

export interface DocxModelRange {
  /** UTF-16, half-open range in the paragraph's model text. */
  readonly start: number;
  readonly end: number;
}

export type DocxInlineAtomKind =
  | "field"
  | "math"
  | "drawing"
  | "note"
  | "tab"
  | "break";

export interface DocxInlineAtom {
  readonly objectRef: string;
  readonly kind: DocxInlineAtomKind;
  /** Whole-paragraph model coordinates. */
  readonly modelRange: DocxModelRange;
  /** Whole-paragraph display coordinates. */
  readonly displayRange: DocxModelRange;
  readonly displayText: string;
  /** Whether the payload identifies the atom itself. */
  readonly readable: boolean;
  /** Whether the payload is a complete semantic projection. */
  readonly complete: boolean;
  readonly editable: false;
  readonly payload?: unknown;
}

export interface DocxParagraphSemantics {
  readonly paragraphRef: string;
  readonly revision: number;
  readonly paraId?: string;
  readonly modelText: string;
  readonly displayText: string;
  readonly atoms: readonly DocxInlineAtom[];
  /** Whole-paragraph model ranges where a protected plain-text replacement is allowed. */
  readonly editableRanges: readonly DocxModelRange[];
}

export interface DocxReplaceParagraphRangeInput {
  readonly paragraphRef: string;
  readonly expectedRevision: number;
  readonly modelRange: DocxModelRange;
  readonly expectedText: string;
  readonly text: string;
}

export type DocxApplyErrorCode =
  | AutomationErrorCode
  | "stale-target"
  | "unsupported-target"
  | "invalid-format"
  | "invalid-range"
  | "expected-text-mismatch"
  | "atomic-overlap"
  | "format-boundary"
  | "container-boundary";

export type DocxApplyResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: DocxApplyErrorCode;
      readonly message: string;
      readonly revision: number;
      readonly changed: false;
    };

export interface DocxSession {
  revision(): number;
  /** Body paragraph handles in reading order, without reading paragraph content. */
  listParagraphHandles(): readonly AutomationHandle<"paragraph">[];
  /** Resolve a selection identity without reading every paragraph's content or format. */
  paragraphHandleForId?(paraId: string): AutomationHandle<"paragraph"> | undefined;
  listParagraphs(): readonly DocxParagraph[];
  captureTarget(paragraph: AutomationHandle<"paragraph">): DocxTarget;
  applySuggestion(target: DocxTarget, text: string): DocxApplyResult;
  formatParagraph?(
    paragraph: AutomationHandle<"paragraph">,
    expectedRevision: number,
    format: DocxParagraphFormatWriteInput,
  ): DocxApplyResult;
  formatObject?(
    paragraph: AutomationHandle<"paragraph">,
    expectedRevision: number,
    mutation: DocxObjectFormatMutation,
  ): DocxApplyResult;
  formatBatch?(
    operations: readonly DocxFormatBatchOperation[],
    expectedRevision: number,
  ): DocxApplyResult;
  importTemplateStyles?(
    bytes: Uint8Array,
    styleIds: readonly string[],
    expectedRevision: number,
  ): DocxStyleImportResult;
  readParagraph(
    paragraph: AutomationHandle<"paragraph">,
  ): DocxParagraphSemantics;
  readParagraphModelText?(paragraph: AutomationHandle<"paragraph">): string;
  readImage?(input: DocxImageReadRequest): DocxImageReadResult;
  writeEquation?(input: DocxEquationWriteRequest, compiled: CompiledDocxEquation): DocxApplyResult;
  readParagraphFormatting?(
    paragraph: AutomationHandle<"paragraph">,
  ): DocxParagraphFormatting;
  paragraphLocator?(
    paragraph: AutomationHandle<"paragraph">,
  ): DocxParagraphLocator | null;
  replaceParagraphRange(
    input: DocxReplaceParagraphRangeInput,
  ): DocxApplyResult;
  isSuggestionApplied(target: DocxTarget, text: string): boolean;
  subscribe(listener: (revision: number) => void): AutomationUnsubscribe;
  dispose(): void;
}

export { DocxImageReadError } from "./docx-images";
export type {
  DocxImageReadRequest,
  DocxImageReadResult,
} from "./docx-images";

export type DocxStyleImportResult = DocxApplyResult & {
  readonly styleIdMap?: Readonly<Record<string, string>>;
  readonly themePolicy?: string;
};

export interface DocxParagraphFormatWriteInput {
  readonly font?: AutomationFontWrite & {
    /** `w:rFonts/@w:eastAsia`, which the public automation font write does not expose yet. */
    readonly nameEastAsia?: string;
  };
  readonly paragraph?: AutomationParagraphFormatWrite & DocxParagraphFlags;
}

export interface DocxFormatBatchOperation
  extends DocxParagraphFormatWriteInput {
  readonly target: AutomationHandle<"paragraph">;
  readonly range?: { readonly start: number; readonly end: number };
  readonly objectFormat?: DocxObjectFormatMutation;
}

export interface DocxParagraphFlags {
  readonly keepNext?: boolean;
  readonly keepLines?: boolean;
  readonly pageBreakBefore?: boolean;
}

export interface DocxParagraphFlagsRead {
  readonly keepNext: boolean | null;
  readonly keepLines: boolean | null;
  readonly pageBreakBefore: boolean | null;
}

export interface DocxParagraphFormatting {
  readonly paragraphRef: string;
  readonly text: string;
  readonly revision: number;
  readonly paraId?: string;
  readonly font: AutomationFontRead;
  readonly paragraph: AutomationParagraphFormatRead & DocxParagraphFlagsRead;
}

export class DocxSessionError extends Error {
  readonly code: AutomationErrorCode;
  readonly revision: number;

  constructor(error: AutomationError, revision: number) {
    super(error.message);
    this.name = "DocxSessionError";
    this.code = error.code;
    this.revision = revision;
  }
}

function errorAt(response: AutomationBatchResponse): AutomationError {
  const failure = response.results.find(
    (
      result,
    ): result is Extract<AutomationOperationResult, { status: "error" }> =>
      result.status === "error",
  );
  if (!failure) {
    throw new Error(
      "The DOCX host refused a batch without naming an operation error.",
    );
  }
  return failure.error;
}

function execute(
  host: AutomationHost,
  request: AutomationBatchRequest,
): AutomationBatchResponse {
  const response = host.execute(request);
  if (!response.ok)
    throw new DocxSessionError(errorAt(response), response.revision);
  return response;
}

function valueAt(
  response: AutomationBatchResponse,
  index: number,
): AutomationValue {
  const result = response.results[index];
  if (result?.status !== "ok") {
    throw new Error(`The DOCX host did not answer operation ${String(index)}.`);
  }
  return result.value;
}

function handleAt<K extends "document" | "body">(
  response: AutomationBatchResponse,
  index: number,
  kind: K,
): AutomationHandle<K> {
  const value = valueAt(response, index);
  if (value.kind !== "handle" || value.handle.kind !== kind) {
    throw new Error(`The DOCX host did not answer a ${kind} handle.`);
  }
  return value.handle as AutomationHandle<K>;
}

function handlesAt(
  response: AutomationBatchResponse,
  index: number,
): readonly AutomationHandle[] {
  const value = valueAt(response, index);
  if (value.kind !== "handles") {
    throw new Error("The DOCX host did not answer handles.");
  }
  return value.handles;
}

function textAt(response: AutomationBatchResponse, index: number): string {
  const value = valueAt(response, index);
  if (value.kind !== "text")
    throw new Error("The DOCX host did not answer text.");
  return value.text;
}

function bodyOf(host: AutomationHost): AutomationHandle<"body"> {
  const document = handleAt(
    execute(host, { operations: [{ op: "getDocument" }] }),
    0,
    "document",
  );
  return handleAt(
    execute(host, { operations: [{ op: "getBody", document }] }),
    0,
    "body",
  );
}

function paragraphHandles(
  host: AutomationHost,
  body: AutomationHandle<"body">,
): readonly AutomationHandle<"paragraph">[] {
  return handlesAt(
    execute(host, { operations: [{ op: "getParagraphs", body }] }),
    0,
  ).map((handle) => {
    if (handle.kind !== "paragraph") {
      throw new Error("The DOCX host answered a non-paragraph handle.");
    }
    return handle as AutomationHandle<"paragraph">;
  });
}

interface ParagraphDetails {
  readonly paragraph: AutomationHandle<"paragraph">;
  readonly paraId?: string;
  readonly text: string;
  readonly revision: number;
  readonly supported: boolean;
}

interface CanonicalParagraph {
  readonly structure: string;
  readonly supported: boolean;
}

type CanonicalInspector = (
  paraId: string | undefined,
) => CanonicalParagraph | null;

function canonicalParagraph(
  session: TreeDocxSessionView,
  paraId: string | undefined,
): CanonicalParagraph | null {
  if (!paraId) return null;
  const nodeId = session.nodeIdOf(paraId);
  if (!nodeId) return null;
  const part = session.part();
  const node = findParagraph(part.root, nodeId);
  if (node?.kind !== "paragraph") return null;
  return inspectDocxParagraph(node);
}

export function inspectDocxParagraph(
  node: OoxmlParagraphNode,
): CanonicalParagraph {
  return {
    structure: canonicalOoxmlFingerprint(node),
    supported: safeForWholeParagraphReplacement(node),
  };
}

function findParagraph(
  node: OoxmlNode,
  nodeId: string,
): OoxmlParagraphNode | null {
  if (node.id === nodeId) return node.kind === "paragraph" ? node : null;
  if (node.kind === "textValue") return null;
  for (const child of node.children) {
    const paragraph = findParagraph(child, nodeId);
    if (paragraph) return paragraph;
  }
  return null;
}

function findOoxmlNode(node: OoxmlNode, nodeId: string): OoxmlNode | null {
  if (node.id === nodeId) return node;
  if (node.kind === "textValue") return null;
  for (const child of node.children) {
    const found = findOoxmlNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function ancestorElements(
  node: OoxmlNode,
  nodeId: string,
  path: readonly OoxmlElement[],
): readonly OoxmlElement[] | null {
  if (node.id === nodeId) return path;
  if (node.kind === "textValue") return null;
  const next = node.kind === "document" ? path : [...path, node];
  for (const child of node.children) {
    const found = ancestorElements(child, nodeId, next);
    if (found) return found;
  }
  return null;
}

function findNodePath(
  node: OoxmlNode,
  nodeId: string,
  path: readonly number[],
): number[] | null {
  if (node.id === nodeId) return [...path];
  if (node.kind === "textValue") return null;
  for (const [index, child] of node.children.entries()) {
    const found = findNodePath(child, nodeId, [...path, index]);
    if (found) return found;
  }
  return null;
}

function paragraphLocator(
  host: AutomationHost,
  tree: TreeDocxSessionView,
  paragraph: AutomationHandle<"paragraph">,
): DocxParagraphLocator | null {
  let paraId: string;
  try {
    paraId = textAt(
      execute(host, { operations: [{ op: "getParagraphId", paragraph }] }),
      0,
    );
  } catch (error) {
    if (
      error instanceof DocxSessionError &&
      (error.code === "invalid-handle" || error.code === "stale-revision")
    ) {
      return null;
    }
    throw error;
  }
  if (paraId === "") return null;
  const nodeId = tree.nodeIdOf(paraId);
  if (!nodeId) return null;
  const part = tree.part();
  const path = findNodePath(part.root, nodeId, [0]);
  const paragraphs: string[] = [];
  const collect = (node: OoxmlNode) => {
    if (node.kind === "paragraph") paragraphs.push(node.id);
    if (node.kind !== "textValue") node.children.forEach(collect);
  };
  collect(part.root);
  return path === null
    ? null
    : {
        part: part.name,
        path,
        ...(paragraphs.indexOf(nodeId) < 0
          ? {}
          : { paragraphIndex: paragraphs.indexOf(nodeId) }),
      };
}

function safeForWholeParagraphReplacement(node: OoxmlParagraphNode): boolean {
  const runs = node.children.filter(
    (child): child is Extract<OoxmlNode, { kind: "run" }> =>
      child.kind === "run",
  );
  if (
    runs.length === 0 ||
    runs.length !==
      node.children.filter((child) => child.kind !== "paragraphProperties")
        .length
  )
    return false;

  const textRuns = runs.map((run) => ({
    properties: run.children.find((child) => child.kind === "runProperties"),
    simple:
      run.children.every(
        (child) => child.kind === "runProperties" || child.kind === "text",
      ) && run.children.filter((child) => child.kind === "text").length === 1,
  }));
  if (!textRuns.every(({ simple }) => simple)) return false;

  const firstProperties = textRuns[0]?.properties;
  return textRuns.every(({ properties }) => {
    if (firstProperties === undefined) return properties === undefined;
    if (properties === undefined) return false;
    return ooxmlTreesEqual(firstProperties, properties);
  });
}

function readParagraphs(
  host: AutomationHost,
  paragraphs: readonly AutomationHandle<"paragraph">[],
): readonly ParagraphDetails[] {
  if (paragraphs.length === 0) return [];
  const response = execute(host, {
    operations: paragraphs.flatMap((paragraph) => [
      { op: "getParagraphId" as const, paragraph },
      {
        op: "getText" as const,
        target: paragraph,
        projection: "model" as const,
      },
      { op: "getFields" as const, span: { paragraph } },
      { op: "getInlinePictures" as const, span: { paragraph } },
      { op: "getShapes" as const, span: { paragraph } },
    ]),
  });
  return paragraphs.map((paragraph, index) => {
    const paraId = textAt(response, index * 5);
    const text = textAt(response, index * 5 + 1);
    return {
      paragraph,
      ...(paraId === "" ? {} : { paraId }),
      text,
      revision: response.revision,
      supported:
        !text.includes("\uFFFC") &&
        handlesAt(response, index * 5 + 2).length === 0 &&
        handlesAt(response, index * 5 + 3).length === 0 &&
        handlesAt(response, index * 5 + 4).length === 0,
    };
  });
}

function hasTrackedChange(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
): boolean {
  return (
    handlesAt(
      execute(host, {
        operations: [{ op: "getRevisions", scope: { paragraph } }],
      }),
      0,
    ).length > 0
  );
}

function readParagraph(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
): ParagraphDetails | null {
  try {
    return readParagraphs(host, [paragraph])[0] ?? null;
  } catch (error) {
    if (
      error instanceof DocxSessionError &&
      (error.code === "invalid-handle" || error.code === "stale-revision")
    ) {
      return null;
    }
    throw error;
  }
}

interface ParagraphSemanticsRead {
  readonly paraId?: string;
  readonly modelText: string;
  readonly displayText: string;
  readonly fields: readonly AutomationHandle<"field">[];
  readonly pictures: readonly AutomationHandle<"inlinePicture">[];
  readonly shapes: readonly AutomationHandle<"shape">[];
  readonly revision: number;
}

interface FieldRead {
  readonly code: string;
  readonly result: string;
  readonly handle: AutomationHandle<"field">;
}

function paragraphSemanticsRead(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
): ParagraphSemanticsRead {
  const response = execute(host, {
    operations: [
      { op: "getParagraphId", paragraph },
      { op: "getText", target: paragraph, projection: "model" },
      { op: "getText", target: paragraph, projection: "allMarkup" },
      { op: "getFields", span: { paragraph } },
      { op: "getInlinePictures", span: { paragraph } },
      { op: "getShapes", span: { paragraph } },
    ],
  });
  const fieldHandles = handlesAt(response, 3);
  const pictureHandles = handlesAt(response, 4);
  const shapeHandles = handlesAt(response, 5);
  const paraId = textAt(response, 0);
  return {
    ...(paraId === "" ? {} : { paraId }),
    modelText: textAt(response, 1),
    displayText: textAt(response, 2),
    fields: fieldHandles.map((handle) => {
      if (handle.kind !== "field") {
        throw new Error("The DOCX host answered a non-field field handle.");
      }
      return handle as AutomationHandle<"field">;
    }),
    pictures: pictureHandles.map((handle) => {
      if (handle.kind !== "inlinePicture") {
        throw new Error("The DOCX host answered a non-picture handle.");
      }
      return handle as AutomationHandle<"inlinePicture">;
    }),
    shapes: shapeHandles.map((handle) => {
      if (handle.kind !== "shape") {
        throw new Error("The DOCX host answered a non-shape handle.");
      }
      return handle as AutomationHandle<"shape">;
    }),
    revision: response.revision,
  };
}

function readFields(
  host: AutomationHost,
  fields: readonly AutomationHandle<"field">[],
): readonly FieldRead[] {
  if (fields.length === 0) return [];
  const response = execute(host, {
    operations: fields.flatMap((field) => [
      { op: "getField" as const, field },
      {
        op: "getFieldResult" as const,
        field,
        projection: "allMarkup" as const,
      },
    ]),
  });
  return fields.map((_, index) => {
    const field = valueAt(response, index * 2);
    if (field.kind !== "field") {
      throw new Error("The DOCX host did not answer a field code.");
    }
    return {
      code: field.field.code,
      result: textAt(response, index * 2 + 1),
      handle: fields[index]!,
    };
  });
}

function range(start: number, end: number): DocxModelRange {
  return { start, end };
}

function modelReplacementOffsets(text: string): readonly number[] {
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\uFFFC") offsets.push(index);
  }
  return offsets;
}

function fieldAtomsFromHost(
  read: ParagraphSemanticsRead,
  fields: readonly FieldRead[],
): readonly DocxInlineAtom[] {
  if (
    read.pictures.length > 0 ||
    read.shapes.length > 0 ||
    fields.length !== read.fields.length
  )
    return [];
  const offsets = modelReplacementOffsets(read.modelText);
  if (offsets.length !== fields.length) return [];
  let displayOffset = 0;
  let modelOffset = 0;
  return fields.map((field, index) => {
    const offset = offsets[index]!;
    displayOffset += read.modelText.slice(modelOffset, offset).length;
    const displayText = field.result;
    const atom: DocxInlineAtom = {
      objectRef: read.fields[index]!.ref,
      kind: "field",
      modelRange: range(offset, offset + 1),
      displayRange: range(displayOffset, displayOffset + displayText.length),
      displayText,
      readable: true,
      complete: true,
      editable: false,
      payload: { code: field.code },
    };
    displayOffset += displayText.length;
    modelOffset = offset + 1;
    return atom;
  });
}

function atomKind(node: OoxmlNode): DocxInlineAtomKind | null {
  if (node.kind === "textValue") return null;
  if (
    node.kind === "fldChar" ||
    node.kind === "fldSimple"
  )
    return "field";
  if (node.kind === "tab") return "tab";
  if (node.kind === "hardBreak") return "break";
  if (
    node.kind === "noteReference" ||
    node.kind === "noteRef" ||
    node.kind === "separator" ||
    node.kind === "continuationSeparator"
  )
    return "note";
  if (
    node.kind === "drawing" ||
    node.kind === "inlineDrawing" ||
    node.kind === "anchoredDrawing" ||
    node.localName === "drawing"
  )
    return "drawing";
  if (node.localName === "oMath" || node.localName === "oMathPara")
    return "math";
  return null;
}

function paragraphFieldInstructions(node: OoxmlParagraphNode): readonly string[] {
  const events: OoxmlNode[] = [];
  const collect = (child: OoxmlNode) => {
    if (child.kind === "textValue") return;
    events.push(child);
    if (child.kind !== "fldSimple") child.children.forEach(collect);
  };
  node.children.forEach(collect);

  const instructions: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind === "fldSimple") {
      instructions.push(fldSimpleInstr(event) ?? "");
      continue;
    }
    if (event.kind !== "fldChar" || fldCharType(event) !== "begin")
      continue;

    let depth = 1;
    let phase: "instruction" | "result" = "instruction";
    let instruction = "";
    let end = index;
    for (let cursor = index + 1; cursor < events.length; cursor += 1) {
      const current = events[cursor]!;
      if (current.kind === "fldChar") {
        const type = fldCharType(current);
        if (type === "begin") {
          depth += 1;
          continue;
        }
        if (type === "separate" && depth === 1) phase = "result";
        if (type === "end") {
          depth -= 1;
          if (depth === 0) {
            end = cursor;
            break;
          }
        }
      }
      if (depth === 1 && phase === "instruction" && current.kind === "instrText")
        instruction += instrTextValue(current);
    }
    instructions.push(instruction);
    index = end;
  }
  return instructions;
}

function atomDisplayText(
  kind: DocxInlineAtomKind,
  field: FieldRead | undefined,
  modelText: string,
  segment: { readonly start: number; readonly end: number },
): string {
  if (kind === "field") return field?.result ?? "\uFFFC";
  if (kind === "tab" || kind === "break") {
    return modelText.slice(segment.start, segment.end);
  }
  return "\uFFFC";
}

function inlineCharacterDisplayText(node: OoxmlNode): string | null {
  if (
    node.kind !== "generic" ||
    node.namespaceUri !== "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  ) {
    return null;
  }
  if (node.localName === "noBreakHyphen") return "\u2011";
  if (node.localName === "softHyphen") return "\u00ad";
  // Core reads w:sym as one "(" model unit; this does not identify its font glyph.
  if (node.localName === "sym") return "(";
  return null;
}

function fieldImageNodesForSegment(
  paragraph: OoxmlParagraphNode,
  segment: ReturnType<typeof segmentsOf>[number],
): readonly OoxmlNode[] {
  if (segment.node.kind === "fldSimple") return [segment.node];
  if (
    segment.node.kind !== "fldChar" ||
    fldCharType(segment.node) !== "begin"
  )
    return [];

  const events: OoxmlNode[] = [];
  const collect = (node: OoxmlNode) => {
    if (node.kind === "textValue") return;
    events.push(node);
    node.children.forEach(collect);
  };
  paragraph.children.forEach(collect);
  const start = events.findIndex((node) => node.id === segment.node.id);
  if (start < 0) return [];
  let depth = 0;
  for (let index = start; index < events.length; index += 1) {
    const node = events[index]!;
    if (node.kind !== "fldChar") continue;
    const type = fldCharType(node);
    if (type === "begin") {
      depth += 1;
      continue;
    }
    if (type !== "end") continue;
    depth -= 1;
    if (depth === 0) return events.slice(start, index + 1);
  }
  return events.slice(start);
}

function containsImageRoot(node: OoxmlNode): boolean {
  if (node.kind === "textValue") return false;
  return (
    (node.namespaceUri ===
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main" &&
      (node.localName === "drawing" || node.localName === "pict")) ||
    node.children.some(containsImageRoot)
  );
}

function containedImageRoots(nodes: readonly OoxmlNode[]): readonly OoxmlNode[] {
  const roots: OoxmlNode[] = [];
  const seen = new Set<string>();
  const visit = (node: OoxmlNode) => {
    if (node.kind === "textValue") return;
    if (
      node.namespaceUri ===
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main" &&
      (node.localName === "drawing" || node.localName === "pict")
    ) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        roots.push(node);
      }
      return;
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return roots;
}

function liveSemantics(
  read: ParagraphSemanticsRead,
  paragraph: AutomationHandle<"paragraph">,
  node: OoxmlParagraphNode,
  fields: readonly FieldRead[],
  tree: TreeDocxSessionView,
): DocxParagraphSemantics {
  const segments = segmentsOf(node);
  const source = tree.currentPackage();
  const ownerPart = tree.part().name;
  const fieldInstructions = paragraphFieldInstructions(node);
  const fieldAtomSegments = segments.filter(
    (segment) =>
      segment.node.kind === "fldSimple" ||
      (segment.node.kind === "fldChar" &&
        fldCharType(segment.node) === "begin"),
  );
  const fieldReadsAligned =
    fieldInstructions.length === fields.length &&
    fieldAtomSegments.length === fields.length &&
    fieldInstructions.every((code, index) => fields[index]?.code === code);
  const fieldImageNodeSets = fieldAtomSegments.map((segment) =>
    fieldImageNodesForSegment(node, segment),
  );
  const fieldOwnedNodeIds = new Set(
    fieldImageNodeSets.flatMap(containedImageRoots).map((root) => root.id),
  );
  let fieldIndex = 0;
  const atoms: DocxInlineAtom[] = [];
  const atomNodeIds = new Map<DocxInlineAtom, string>();
  for (const segment of segments) {
    const kind = atomKind(segment.node);
    if (kind === null) {
      continue;
    }
    if (kind !== "field" && fieldOwnedNodeIds.has(segment.node.id)) {
      continue;
    }
    const field =
      kind === "field" && fieldReadsAligned
        ? fields[fieldIndex++]
        : undefined;
    const fieldImageNodesForAtom =
      kind === "field" && fieldReadsAligned
        ? (fieldImageNodeSets[fieldIndex - 1] ?? [])
        : [];
    const displayText = atomDisplayText(kind, field, read.modelText, segment);
    const fieldHandle =
      kind === "field" && fieldReadsAligned
        ? field?.handle
        : undefined;
    const structuralRef = `${paragraph.ref}:${segment.node.id}`;
    const objectRef =
      fieldHandle?.ref ??
      structuralRef;
    const fieldImage =
      fieldImageNodesForAtom.some(containsImageRoot)
        ? imageAtomPayload({
            nodes: fieldImageNodesForAtom,
            source,
            ownerPart,
            paragraphRef: paragraph.ref,
            objectRef,
            revision: read.revision,
          })
        : undefined;
    const math =
      kind === "math"
        ? readDocxMathPayload(segment.node)
        : kind === "drawing"
          ? imageAtomPayload({
              nodes: [segment.node],
              source,
              ownerPart,
              paragraphRef: paragraph.ref,
              objectRef,
              revision: read.revision,
            })
        : {
            readable: kind !== "field" || fieldReadsAligned,
            complete: kind !== "field" || fieldReadsAligned,
            payload: undefined,
          };
    const fieldPayload =
      field === undefined
        ? undefined
        : { code: field.code, ...fieldImage?.payload };
    const equation = kind === "math" ? equationOfAtom(segment.node) : null;
    const payload = equation && source
      ? { ...math.payload, equationFingerprint: canonicalOoxmlFingerprint(equation),
          source: readDocxEquationSource(source, node, segment.node, segment.start, segment.end) }
      : math.payload ?? fieldPayload;
    const atom: DocxInlineAtom = {
      objectRef,
      kind,
      modelRange: range(segment.start, segment.end),
      displayRange: range(0, 0),
      displayText,
      readable: field === undefined ? math.readable : true,
      complete: fieldImage === undefined ? math.complete : false,
      editable: false,
      ...(payload === undefined ? {} : { payload }),
    };
    atoms.push(atom);
    atomNodeIds.set(atom, segment.node.id);
  }
  const segmentByNodeId = new Map(
    segments.map((segment) => [segment.node.id, segment]),
  );
  const suppressedNodeIds = new Set<string>();
  for (const atom of atoms) {
    const nodeId = atomNodeIds.get(atom);
    if (!nodeId) continue;
    for (const suppressed of segmentByNodeId.get(nodeId)?.removeNodeIds ?? []) {
      if (suppressed !== nodeId) suppressedNodeIds.add(suppressed);
    }
  }

  const structuralAtoms: DocxInlineAtom[] = [];
  const structuralNodeIds = new Map<DocxInlineAtom, string>();
  const visit = (child: OoxmlNode) => {
    if (child.kind === "textValue") return;
    if (child.localName === "pict") {
      if (suppressedNodeIds.has(child.id)) return;
      const span = paragraphOffsetIndex(node).spanOf(child);
      if (span) {
        const objectRef = `${paragraph.ref}:${child.id}`;
        const image = imageAtomPayload({
          nodes: [child],
          source,
          ownerPart,
          paragraphRef: paragraph.ref,
          objectRef,
          revision: read.revision,
        });
        const atom: DocxInlineAtom = {
          objectRef,
          kind: "drawing",
          modelRange: range(span.start, span.end),
          displayRange: range(0, 0),
          displayText: "\uFFFC",
          readable: image.readable,
          complete: image.complete,
          editable: false,
          payload: image.payload,
        };
        structuralAtoms.push(atom);
        structuralNodeIds.set(atom, child.id);
      }
      return;
    }
    child.children.forEach(visit);
  };
  node.children.forEach(visit);
  const atomByNodeId = new Map<string, DocxInlineAtom>();
  for (const atom of atoms) {
    const nodeId = atomNodeIds.get(atom);
    if (nodeId) atomByNodeId.set(nodeId, atom);
  }
  for (const atom of structuralAtoms) {
    const nodeId = structuralNodeIds.get(atom);
    if (nodeId) atomByNodeId.set(nodeId, atom);
  }

  const nodeOrder = new Map<string, number>();
  const recordOrder = (child: OoxmlNode) => {
    nodeOrder.set(child.id, nodeOrder.size);
    if (child.kind === "textValue") return;
    child.children.forEach(recordOrder);
  };
  node.children.forEach(recordOrder);

  const displayEntries: {
    readonly nodeId: string;
    readonly displayText: string;
    readonly atom?: DocxInlineAtom;
  }[] = [];
  for (const segment of segments) {
    if (segment.node.kind === "textValue") {
      displayEntries.push({
        nodeId: segment.node.id,
        displayText: segment.node.value,
      });
      continue;
    }
    const atom = atomByNodeId.get(segment.node.id);
    if (atom) {
      displayEntries.push({
        nodeId: segment.node.id,
        displayText: atom.displayText,
        atom,
      });
      continue;
    }
    displayEntries.push({
      nodeId: segment.node.id,
      displayText:
        inlineCharacterDisplayText(segment.node) ??
        "\uFFFC".repeat(segment.end - segment.start),
    });
  }
  for (const atom of structuralAtoms) {
    const nodeId = structuralNodeIds.get(atom);
    if (nodeId) {
      displayEntries.push({
        nodeId,
        displayText: atom.displayText,
        atom,
      });
    }
  }
  displayEntries.sort(
    (left, right) =>
      (nodeOrder.get(left.nodeId) ?? 0) -
      (nodeOrder.get(right.nodeId) ?? 0),
  );

  let displayOffset = 0;
  let projectedDisplay = "";
  const projectedRanges = new Map<DocxInlineAtom, DocxModelRange>();
  for (const entry of displayEntries) {
    const start = displayOffset;
    projectedDisplay += entry.displayText;
    displayOffset += entry.displayText.length;
    if (entry.atom) {
      projectedRanges.set(entry.atom, range(start, displayOffset));
    }
  }

  const nodeIdOfAtom = (atom: DocxInlineAtom) =>
    atomNodeIds.get(atom) ?? structuralNodeIds.get(atom);
  const orderedAtoms = [...atoms, ...structuralAtoms]
    .filter((atom) => projectedRanges.has(atom))
    .sort((left, right) => {
      const leftId = nodeIdOfAtom(left);
      const rightId = nodeIdOfAtom(right);
      return (nodeOrder.get(leftId ?? "") ?? 0) -
        (nodeOrder.get(rightId ?? "") ?? 0);
    });
  const allAtoms = orderedAtoms.map((atom) => ({
    ...atom,
    displayRange: projectedRanges.get(atom)!,
  }));
  return {
    paragraphRef: paragraph.ref,
    revision: read.revision,
    ...(read.paraId === undefined ? {} : { paraId: read.paraId }),
    modelText: read.modelText,
    displayText: projectedDisplay,
    atoms: allAtoms,
    editableRanges: editableRanges(node, segments),
  };
}

function editableRanges(
  paragraph: OoxmlParagraphNode,
  segments: ReturnType<typeof segmentsOf>,
): readonly DocxModelRange[] {
  const index = paragraphOffsetIndex(paragraph);
  const protectedRanges: DocxModelRange[] = [];
  const visit = (node: OoxmlNode) => {
    if (node.kind === "textValue") return;
    const protectedNode =
      node.kind === "bookmarkStart" ||
      node.kind === "bookmarkEnd" ||
      node.kind === "moveFromRangeStart" ||
      node.kind === "moveFromRangeEnd" ||
      node.kind === "moveToRangeStart" ||
      node.kind === "moveToRangeEnd" ||
      node.kind === "commentRangeStart" ||
      node.kind === "commentRangeEnd" ||
      node.kind === "commentReference" ||
      node.kind === "revisionInsert" ||
      node.kind === "revisionDelete" ||
      node.kind === "revisionMoveFrom" ||
      node.kind === "revisionMoveTo" ||
      node.kind === "hyperlink" ||
      node.kind === "contentControl" ||
      node.kind === "contentControlContent" ||
      node.localName === "pict";
    if (protectedNode) {
      const span = index.spanOf(node);
      if (span) {
        if (span.end > span.start)
          protectedRanges.push(range(span.start, span.end));
      }
    }
    node.children.forEach(visit);
  };
  visit(paragraph);

  const result: DocxModelRange[] = [];
  for (const segment of segments) {
    if (segment.node.kind !== "textValue" || segment.end <= segment.start)
      continue;
    if (
      protectedRanges.some((protectedRange) =>
        rangesOverlap(range(segment.start, segment.end), protectedRange),
      )
    )
      continue;
    result.push(range(segment.start, segment.end));
  }
  return result;
}

function rangesOverlap(
  left: DocxModelRange,
  right: DocxModelRange,
): boolean {
  return left.start < right.end && right.start < left.end;
}

function invalidRange(revision: number): DocxApplyResult {
  return {
    ok: false,
    code: "invalid-range",
    message: "The model range must be a non-empty integer UTF-16 range inside the paragraph.",
    revision,
    changed: false,
  };
}

function rangeFailure(
  code:
    | "atomic-overlap"
    | "format-boundary"
    | "container-boundary",
  revision: number,
): DocxApplyResult {
  const messages = {
    "atomic-overlap":
      "The range overlaps a field, equation, drawing, note, tab, or break.",
    "format-boundary":
      "The range crosses a run or formatting boundary.",
    "container-boundary":
      "The range crosses a bookmark, comment, revision, hyperlink, or content-control boundary.",
  };
  return {
    ok: false,
    code,
    message: messages[code],
    revision,
    changed: false,
  };
}

function hostOnlySemantics(
  paragraph: AutomationHandle<"paragraph">,
  read: ParagraphSemanticsRead,
  fields: readonly FieldRead[],
): DocxParagraphSemantics {
  return {
    paragraphRef: paragraph.ref,
    revision: read.revision,
    ...(read.paraId === undefined ? {} : { paraId: read.paraId }),
    modelText: read.modelText,
    displayText: read.displayText,
    atoms: fieldAtomsFromHost(read, fields),
    editableRanges: [],
  };
}

function readParagraphSemantics(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
  tree?: TreeDocxSessionView,
): DocxParagraphSemantics {
  const read = paragraphSemanticsRead(host, paragraph);
  const fields = readFields(host, read.fields);
  if (!tree || !read.paraId) return hostOnlySemantics(paragraph, read, fields);
  const nodeId = tree.nodeIdOf(read.paraId);
  if (!nodeId) return hostOnlySemantics(paragraph, read, fields);
  const node = findParagraph(tree.part().root, nodeId);
  if (!node) return hostOnlySemantics(paragraph, read, fields);
  return liveSemantics(read, paragraph, node, fields, tree);
}

function paragraphHandleByRef(
  host: AutomationHost,
  paragraphRef: string,
): AutomationHandle<"paragraph"> | null {
  return (
    paragraphHandles(host, bodyOf(host)).find(
      (paragraph) => paragraph.ref === paragraphRef,
    ) ?? null
  );
}

function fieldImageNodes(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
  paragraphNode: OoxmlParagraphNode,
  objectRef: string,
): readonly OoxmlNode[] | null {
  const fields = handlesAt(
    execute(host, {
      operations: [{ op: "getFields", span: { paragraph } }],
    }),
    0,
  );
  if (fields.some((field) => field.kind !== "field")) return null;
  const fieldElements = fields.map((field) => field as AutomationHandle<"field">);
  const matchingField = fieldElements.findIndex(
    (field) => field.ref === objectRef,
  );
  if (matchingField < 0) return null;

  const segments = segmentsOf(paragraphNode);
  const fieldSegments = segments.filter(
    (segment) =>
      segment.node.kind === "fldSimple" ||
      (segment.node.kind === "fldChar" &&
        fldCharType(segment.node) === "begin"),
  );
  const instructions = paragraphFieldInstructions(paragraphNode);
  const fieldReads = readFields(host, fieldElements);
  if (
    fieldElements.length !== fieldSegments.length ||
    fieldElements.length !== instructions.length ||
    instructions.some((code, index) => fieldReads[index]?.code !== code)
  )
    return null;
  return fieldImageNodesForSegment(
    paragraphNode,
    fieldSegments[matchingField]!,
  );
}

function readTreeImage(
  host: AutomationHost,
  tree: TreeDocxSessionView,
  input: DocxImageReadRequest,
): DocxImageReadResult {
  const revision = host.revision();
  if (input.expectedRevision !== revision) {
    throw new DocxImageReadError(
      "stale-revision",
      revision,
      `The image target is stale: expected revision ${input.expectedRevision}, current revision ${revision}.`,
    );
  }
  const paragraph = paragraphHandleByRef(host, input.paragraphRef);
  if (!paragraph) {
    throw new DocxImageReadError(
      "paragraph-not-found",
      revision,
      `The image paragraph ${input.paragraphRef} is not present.`,
    );
  }
  const paraId = textAt(
    execute(host, { operations: [{ op: "getParagraphId", paragraph }] }),
    0,
  );
  const nodeId = paraId === "" ? null : tree.nodeIdOf(paraId);
  const paragraphNode = nodeId
    ? findParagraph(tree.part().root, nodeId)
    : null;
  if (!paragraphNode) {
    throw new DocxImageReadError(
      "paragraph-not-found",
      revision,
      `The image paragraph ${input.paragraphRef} is not present in the current package.`,
    );
  }
  const prefix = `${input.paragraphRef}:`;
  const object = input.objectRef.startsWith(prefix)
    ? findOoxmlNode(
        paragraphNode,
        input.objectRef.slice(prefix.length),
      )
    : null;
  const nodes = object
    ? [object]
    : fieldImageNodes(
        host,
        paragraph,
        paragraphNode,
        input.objectRef,
      );
  if (!nodes) {
    throw new DocxImageReadError(
      "object-not-found",
      revision,
      `The image object ${input.objectRef} is not present in ${input.paragraphRef}.`,
    );
  }
  return readDocxImageObject({
    nodes,
    source: tree.currentPackage(),
    ownerPart: tree.part().name,
    objectRef: input.objectRef,
    revision,
  });
}

function safeRangeFailure(
  paragraph: OoxmlParagraphNode,
  modelRange: DocxModelRange,
): Exclude<DocxApplyResult, { ok: true }>["code"] | null {
  const segments = segmentsOf(paragraph);
  const index = paragraphOffsetIndex(paragraph);
  const atom = segments.find(
    (segment) =>
      segment.node.kind !== "textValue" &&
      rangesOverlap(modelRange, range(segment.start, segment.end)),
  );
  if (atom) return "atomic-overlap";

  const textSegments = segments.filter(
    (segment) =>
      segment.node.kind === "textValue" &&
      rangesOverlap(modelRange, range(segment.start, segment.end)),
  );
  if (textSegments.length !== 1) return "format-boundary";
  if (
    textSegments.some(
      (segment) =>
        segment.start > modelRange.start || segment.end < modelRange.end,
    )
  )
    return "format-boundary";
  let containerFailure = false;
  const visit = (node: OoxmlNode) => {
    if (node.kind === "textValue") return;
    const marker =
      node.kind === "bookmarkStart" ||
      node.kind === "bookmarkEnd" ||
      node.kind === "moveFromRangeStart" ||
      node.kind === "moveFromRangeEnd" ||
      node.kind === "moveToRangeStart" ||
      node.kind === "moveToRangeEnd" ||
      node.kind === "commentRangeStart" ||
      node.kind === "commentRangeEnd" ||
      node.kind === "commentReference";
    const wrapper =
      node.kind === "revisionInsert" ||
      node.kind === "revisionDelete" ||
      node.kind === "revisionMoveFrom" ||
      node.kind === "revisionMoveTo" ||
      node.kind === "hyperlink" ||
      node.kind === "contentControl" ||
      node.kind === "contentControlContent" ||
      node.localName === "pict";
    if (marker || wrapper) {
      const span = index.spanOf(node);
      if (span) {
        if (
          marker &&
          span.start === span.end &&
          span.start > modelRange.start &&
          span.start < modelRange.end
        )
          containerFailure = true;
        if (
          wrapper &&
          rangesOverlap(modelRange, span)
        )
          containerFailure = true;
      }
    }
    node.children.forEach(visit);
  };
  visit(paragraph);
  return containerFailure ? "container-boundary" : null;
}

function replaceParagraphRange(
  host: AutomationHost,
  input: DocxReplaceParagraphRangeInput,
  tree?: TreeDocxSessionView,
): DocxApplyResult {
  if (host.revision() !== input.expectedRevision)
    return staleTarget(host.revision());
  const paragraph = paragraphHandleByRef(host, input.paragraphRef);
  if (!paragraph) return staleTarget(host.revision());
  if (!tree)
    return {
      ok: false,
      code: "unsupported-target",
      message:
        "Protected range writes require a live editor tree session; this DOCX host cannot prove the range is safe.",
      revision: host.revision(),
      changed: false,
    };

  const semantics = readParagraphSemantics(host, paragraph, tree);
  const { modelRange, expectedText, text } = input;
  if (
    !Number.isInteger(modelRange.start) ||
    !Number.isInteger(modelRange.end) ||
    modelRange.start < 0 ||
    modelRange.end <= modelRange.start ||
    modelRange.end > semantics.modelText.length
  )
    return invalidRange(semantics.revision);
  if (
    modelRange.start > 0 &&
    modelRange.start < semantics.modelText.length &&
    /[\uD800-\uDBFF]/.test(semantics.modelText[modelRange.start - 1]!) &&
    /[\uDC00-\uDFFF]/.test(semantics.modelText[modelRange.start]!)
  )
    return invalidRange(semantics.revision);
  if (
    modelRange.end > 0 &&
    modelRange.end < semantics.modelText.length &&
    /[\uD800-\uDBFF]/.test(semantics.modelText[modelRange.end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(semantics.modelText[modelRange.end]!)
  )
    return invalidRange(semantics.revision);
  if (
    semantics.modelText.slice(modelRange.start, modelRange.end) !== expectedText
  )
    return {
      ok: false,
      code: "expected-text-mismatch",
      message: "The paragraph no longer contains expectedText at modelRange.",
      revision: semantics.revision,
      changed: false,
    };

  const nodeId = semantics.paraId
    ? tree.nodeIdOf(semantics.paraId)
    : null;
  const node = nodeId ? findParagraph(tree.part().root, nodeId) : null;
  if (!node) return staleTarget(host.revision());
  const failure = safeRangeFailure(node, modelRange);
  if (failure)
    return rangeFailure(
      failure as
        | "atomic-overlap"
        | "format-boundary"
        | "container-boundary",
      semantics.revision,
    );

  const response = host.execute({
    expectedRevision: input.expectedRevision,
    operations: [
      {
        op: "replaceSpan",
        span: {
          start: {
            paragraph,
            offset: modelRange.start,
            readAt: input.expectedRevision,
          },
          end: {
            paragraph,
            offset: modelRange.end,
            readAt: input.expectedRevision,
          },
        },
        text,
      },
    ],
  });
  if (response.ok)
    return { ok: true, revision: response.revision, changed: response.changed };
  const error = errorAt(response);
  return error.code === "stale-revision" || error.code === "invalid-handle"
    ? staleTarget(response.revision)
    : {
        ok: false,
        code: error.code,
        message: error.message,
        revision: response.revision,
        changed: false,
      };
}

function publicTarget(
  details: ParagraphDetails,
  canonical: CanonicalParagraph | null,
): DocxTarget {
  return {
    paragraph: details.paragraph,
    original: details.text,
    revision: details.revision,
    ...(details.paraId === undefined ? {} : { paraId: details.paraId }),
    ...(canonical === null ? {} : { structure: canonical.structure }),
  };
}

function unsupportedTarget(revision: number): DocxApplyResult {
  return {
    ok: false,
    code: "unsupported-target",
    message:
      "Whole-paragraph suggestions require plain text with uniform formatting. This paragraph contains formatting or objects that need a narrower edit.",
    revision,
    changed: false,
  };
}

function staleTarget(revision: number): DocxApplyResult {
  return {
    ok: false,
    code: "stale-target",
    message: "The target paragraph changed or was deleted since it was read.",
    revision,
    changed: false,
  };
}

function invalidFormat(revision: number): DocxApplyResult {
  return {
    ok: false,
    code: "invalid-format",
    message: "Supply at least one font or paragraph format field.",
    revision,
    changed: false,
  };
}

function invalidFormatMessage(
  revision: number,
  message: string,
): DocxApplyResult {
  return {
    ok: false,
    code: "invalid-format",
    message,
    revision,
    changed: false,
  };
}

function unsupportedEastAsiaFont(revision: number): DocxApplyResult {
  return {
    ok: false,
    code: "unsupported-target",
    message:
      "East Asian font slots require a live editor tree session; this DOCX host cannot write them.",
    revision,
    changed: false,
  };
}

function unsupportedParagraphFlags(revision: number): DocxApplyResult {
  return {
    ok: false,
    code: "unsupported-target",
    message:
      "Paragraph pagination controls require a live editor tree session; this DOCX host cannot write them.",
    revision,
    changed: false,
  };
}

export function listDocxParagraphs(
  host: AutomationHost,
): readonly DocxParagraph[] {
  return readParagraphs(host, paragraphHandles(host, bodyOf(host))).map(
    (details) => ({
      handle: details.paragraph,
      text: details.text,
      ...(details.paraId === undefined ? {} : { paraId: details.paraId }),
    }),
  );
}

export function captureDocxTarget(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
  inspect?: CanonicalInspector,
): DocxTarget {
  const details = readParagraph(host, paragraph);
  if (!details)
    throw new Error("The paragraph is not present in this DOCX document.");
  return publicTarget(details, inspect?.(details.paraId) ?? null);
}

export function applyDocxSuggestion(
  host: AutomationHost,
  target: DocxTarget,
  text: string,
  inspect?: CanonicalInspector,
): DocxApplyResult {
  const current = readParagraph(host, target.paragraph);
  if (!current || current.text !== target.original) {
    return staleTarget(current?.revision ?? host.revision());
  }
  if (inspect) {
    const canonical = inspect(current.paraId);
    if (!canonical || canonical.structure !== target.structure) {
      return staleTarget(current.revision);
    }
    if (!canonical.supported) return unsupportedTarget(current.revision);
  }
  if (!current.supported) return unsupportedTarget(current.revision);
  if (hasTrackedChange(host, target.paragraph))
    return staleTarget(current.revision);

  const span: AutomationSpanRef = {
    start: { paragraph: target.paragraph, offset: 0 },
    end: { paragraph: target.paragraph, offset: target.original.length },
  };
  const response = host.execute({
    expectedRevision: current.revision,
    operations: [{ op: "replaceSpan", span, text }],
  });
  if (response.ok) {
    return { ok: true, revision: response.revision, changed: response.changed };
  }

  const error = errorAt(response);
  if (error.code === "stale-revision" || error.code === "invalid-handle") {
    const after = readParagraph(host, target.paragraph);
    if (!after || after.text !== target.original) {
      return staleTarget(after?.revision ?? response.revision);
    }
  }
  return {
    ok: false,
    code: error.code,
    message: error.message,
    revision: response.revision,
    changed: false,
  };
}

export function formatDocxParagraph(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
  expectedRevision: number,
  format: DocxParagraphFormatWriteInput,
): DocxApplyResult {
  const invalidFlag = invalidParagraphFlag(format.paragraph);
  if (invalidFlag) return invalidFormatMessage(host.revision(), invalidFlag);
  const flags = format.paragraph
    ? paragraphFlagProperties(format.paragraph)
    : [];
  const automationParagraph = format.paragraph
    ? withoutParagraphFlags(format.paragraph)
    : undefined;
  if (
    (!format.font || Object.keys(format.font).length === 0) &&
    (!automationParagraph || Object.keys(automationParagraph).length === 0) &&
    flags.length === 0
  )
    return invalidFormat(host.revision());
  if (host.revision() !== expectedRevision) return staleTarget(host.revision());
  if (flags.length > 0) return unsupportedParagraphFlags(host.revision());
  if (format.font?.nameEastAsia !== undefined)
    return unsupportedEastAsiaFont(host.revision());
  const font = format.font
    ? {
        bold: format.font.bold,
        italic: format.font.italic,
        underline: format.font.underline,
        strikeThrough: format.font.strikeThrough,
        highlightColor: format.font.highlightColor,
        subscript: format.font.subscript,
        superscript: format.font.superscript,
        name: format.font.name,
        size: format.font.size,
        color: format.font.color,
      }
    : undefined;
  const operations: AutomationBatchRequest["operations"] = [
    ...(font ? [{ op: "setFont" as const, span: { paragraph }, font }] : []),
    ...(automationParagraph && Object.keys(automationParagraph).length > 0
      ? [
          {
            op: "setParagraphFormat" as const,
            paragraph: { paragraph },
            format: automationParagraph,
          },
        ]
      : []),
  ];
  const response = host.execute({ expectedRevision, operations });
  if (response.ok) {
    return { ok: true, revision: response.revision, changed: response.changed };
  }
  const error = errorAt(response);
  if (error.code === "stale-revision" || error.code === "invalid-handle") {
    return staleTarget(response.revision);
  }
  return {
    ok: false,
    code: error.code,
    message: error.message,
    revision: response.revision,
    changed: false,
  };
}

function eastAsiaProperties(
  properties: readonly OoxmlProperty[],
  eastAsia: string,
): readonly OoxmlProperty[] {
  const current = properties.find(
    (property) => property.localName === "rFonts",
  );
  const attributes: Record<string, string> = {
    ...current?.attributes,
    eastAsia,
  };
  delete attributes.eastAsiaTheme;
  return current
    ? properties.map((property) =>
        property === current ? { localName: "rFonts", attributes } : property,
      )
    : [...properties, { localName: "rFonts", attributes }];
}

const PARAGRAPH_FLAG_NAMES = [
  "keepNext",
  "keepLines",
  "pageBreakBefore",
] as const;

function invalidParagraphFlag(
  paragraph: DocxParagraphFlags | undefined,
): string | null {
  for (const name of PARAGRAPH_FLAG_NAMES) {
    if (paragraph?.[name] !== undefined && typeof paragraph[name] !== "boolean")
      return `${name} must be a boolean.`;
  }
  return null;
}

function paragraphFlagProperties(
  flags: DocxParagraphFlags,
): readonly OoxmlProperty[] {
  return PARAGRAPH_FLAG_NAMES.flatMap((localName) => {
    const value = flags[localName];
    if (value === undefined) return [];
    return [
      {
        localName,
        ...(value ? {} : { attributes: { val: "0" } }),
      },
    ];
  });
}

function withoutParagraphFlags(
  paragraph: AutomationParagraphFormatWrite & DocxParagraphFlags,
): AutomationParagraphFormatWrite {
  const {
    keepNext: _keepNext,
    keepLines: _keepLines,
    pageBreakBefore: _pageBreakBefore,
    ...automation
  } = paragraph;
  return automation;
}

function paragraphFlagTreeOp(
  tree: TreeDocxSessionView,
  paragraphId: string,
  flags: readonly OoxmlProperty[],
): TreeDocOp {
  return {
    op: "setParagraphProperties",
    paragraphId,
    properties: mergedProperties(
      directParagraphProperties(tree.part(), paragraphId),
      flags,
    ),
  };
}

interface PendingTreeWrite {
  readonly paragraphId: string;
  readonly range?: { readonly start: number; readonly end: number };
  readonly eastAsia: string | null;
  readonly paragraphFlags: readonly OoxmlProperty[];
}

interface PendingBatchWrite {
  readonly targets: readonly PendingTreeWrite[];
  readonly objects: readonly TreeDocOp[];
  readonly displayMode?: ReturnType<PaginatedSurface["revisionDisplayMode"]>;
}

function patchTreeWriteOps(
  operations: readonly TreeDocOp[],
  tree: TreeDocxSessionView,
  pending: PendingBatchWrite,
): readonly TreeDocOp[] {
  let patched = [...operations];
  for (const target of pending.targets) {
    const { paragraphId, range, eastAsia, paragraphFlags } = target;
    if (eastAsia !== null) {
      const start = range?.start ?? 0;
      const end =
        range?.end ?? paragraphTextOf(tree.part(), paragraphId)?.length ?? 0;
      let found = false;
      patched = patched.map((operation) => {
        if (
          operation.op === "setRunProperties" &&
          operation.paragraphId === paragraphId &&
          operation.start >= start &&
          operation.end <= end
        ) {
          found = true;
          return {
            ...operation,
            properties: eastAsiaProperties(operation.properties, eastAsia),
          };
        }
        if (
          !range &&
          operation.op === "setParagraphMarkProperties" &&
          operation.paragraphId === paragraphId
        ) {
          return {
            ...operation,
            properties: eastAsiaProperties(operation.properties, eastAsia),
          };
        }
        return operation;
      });
      const properties = [{ localName: "rFonts", attributes: { eastAsia } }];
      if (!found) {
        patched.push(
          ...runPropertyEdits(
            tree.part(),
            paragraphId,
            start,
            end,
            properties,
            pending.displayMode === "simple-markup"
              ? "proposed"
              : (pending.displayMode ?? "all-markup"),
          ).map((edit) => ({
            op: "setRunProperties" as const,
            paragraphId,
            ...edit,
          })),
        );
      }
      if (
        !range &&
        !patched.some(
          (op) =>
            op.op === "setParagraphMarkProperties" &&
            op.paragraphId === paragraphId,
        )
      ) {
        patched.push({
          op: "setParagraphMarkProperties",
          paragraphId,
          properties: mergedParagraphMarkProperties(
            tree.part(),
            paragraphId,
            properties,
          ),
        });
      }
    }
    if (paragraphFlags.length > 0) {
      const existing = [...patched]
        .reverse()
        .find(
          (op) =>
            op.op === "setParagraphProperties" &&
            op.paragraphId === paragraphId,
        );
      if (existing?.op === "setParagraphProperties") {
        patched = patched.filter(
          (op) =>
            op.op !== "setParagraphProperties" ||
            op.paragraphId !== paragraphId,
        );
        patched.push({
          ...existing,
          properties: mergedProperties(existing.properties, paragraphFlags),
        });
      } else
        patched.push(paragraphFlagTreeOp(tree, paragraphId, paragraphFlags));
    }
  }
  for (const object of pending.objects) {
    if (object.op === "setParagraphProperties") {
      const existing = [...patched]
        .reverse()
        .find(
          (op) =>
            op.op === "setParagraphProperties" &&
            op.paragraphId === object.paragraphId,
        );
      if (existing?.op === "setParagraphProperties") {
        patched = patched.filter(
          (op) =>
            op.op !== "setParagraphProperties" ||
            op.paragraphId !== object.paragraphId,
        );
        patched.push({
          ...existing,
          properties: [
            ...existing.properties.filter(
              (property) => property.localName !== "framePr",
            ),
            ...object.properties.filter(
              (property) => property.localName === "framePr",
            ),
          ],
        });
        continue;
      }
    }
    patched.push(object);
  }
  return patched;
}

function withTreeWriteAutomation(
  editor: DocxEditorInstance,
  pending: () => PendingBatchWrite | null,
): DocxEditorInstance {
  return new Proxy(editor, {
    get(target, property, receiver) {
      if (property === "surface") {
        const surface = target.surface;
        if (!surface) return null;
        return new Proxy(surface, {
          get(surfaceTarget, surfaceProperty) {
            const value = Reflect.get(
              surfaceTarget,
              surfaceProperty,
              surfaceTarget,
            );
            if (
              surfaceProperty !== "applyAutomationOps" ||
              typeof value !== "function"
            ) {
              return typeof value === "function"
                ? value.bind(surfaceTarget)
                : value;
            }
            return (
              staged: Parameters<typeof surfaceTarget.applyAutomationOps>[0],
              scope?: Parameters<typeof surfaceTarget.applyAutomationOps>[1],
              packageEdits?: Parameters<
                typeof surfaceTarget.applyAutomationOps
              >[2],
              requiresReview?: Parameters<
                typeof surfaceTarget.applyAutomationOps
              >[3],
            ) => {
              const treeWrite = pending();
              if (treeWrite === null) {
                return surfaceTarget.applyAutomationOps(
                  staged,
                  scope,
                  packageEdits,
                  requiresReview,
                );
              }
              return surfaceTarget.applyAutomationOps(
                (relate) => {
                  const operations = staged(relate);
                  return operations === null
                    ? null
                    : patchTreeWriteOps(
                        operations,
                        surfaceTarget.session,
                        treeWrite,
                      );
                },
                scope,
                packageEdits,
                requiresReview,
              );
            };
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const EMPTY_PARAGRAPH_FLAGS: DocxParagraphFlagsRead = {
  keepNext: null,
  keepLines: null,
  pageBreakBefore: null,
};

const DEFAULT_PARAGRAPH_FLAGS: DocxParagraphFlagsRead = {
  keepNext: false,
  keepLines: false,
  pageBreakBefore: false,
};

function lastParagraphFlag(
  properties: readonly OoxmlProperty[],
  localName: (typeof PARAGRAPH_FLAG_NAMES)[number],
): OoxmlProperty | undefined {
  for (let index = properties.length - 1; index >= 0; index -= 1) {
    const property = properties[index];
    if (property?.localName === localName) return property;
  }
  return undefined;
}

function toggleValue(property: OoxmlProperty): boolean {
  const value = property.attributes?.val?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function readParagraphFlags(
  tree: TreeDocxSessionView,
  paraId: string | undefined,
): DocxParagraphFlagsRead {
  if (!paraId) return DEFAULT_PARAGRAPH_FLAGS;
  const paragraphId = tree.nodeIdOf(paraId);
  if (!paragraphId) return DEFAULT_PARAGRAPH_FLAGS;
  const paragraph = findParagraph(tree.part().root, paragraphId);
  if (!paragraph) return DEFAULT_PARAGRAPH_FLAGS;
  const styleTable = buildStyleCascadeTable(
    tree.stylesRoot(),
    tree.documentThemeFonts(),
    tree.settingsRoot(),
  );
  const ancestors = ancestorElements(tree.part().root, paragraphId, []) ?? [];
  const table = [...ancestors].reverse().find((node) => node.kind === "table");
  const cell = [...ancestors]
    .reverse()
    .find((node) => node.kind === "tableCell");
  const cellStyle =
    table && cell
      ? readTableStructure(table, 468, 0, styleTable)
          ?.rows.flatMap((row) => row.cells)
          .find((candidate) => candidate.id === cell.id)?.styleFormatting
      : undefined;
  const properties = cascadeParagraphFormatting(
    styleTable,
    propertyContainer(paragraph, "paragraphProperties", "pPr"),
    cellStyle,
  ).paragraphProperties;
  const keepNext = lastParagraphFlag(properties, "keepNext");
  const keepLines = lastParagraphFlag(properties, "keepLines");
  const pageBreakBefore = lastParagraphFlag(properties, "pageBreakBefore");
  return {
    keepNext: keepNext ? toggleValue(keepNext) : false,
    keepLines: keepLines ? toggleValue(keepLines) : false,
    pageBreakBefore: pageBreakBefore
      ? paragraphBreaksBefore(properties)
      : false,
  };
}

export function readDocxParagraphFormatting(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
  readFlags: (paraId: string | undefined) => DocxParagraphFlagsRead = () =>
    EMPTY_PARAGRAPH_FLAGS,
): DocxParagraphFormatting {
  const response = execute(host, {
    operations: [
      { op: "getParagraphId", paragraph },
      { op: "getText", target: paragraph, projection: "model" },
      { op: "getFont", span: { paragraph } },
      { op: "getParagraphFormat", paragraph: { paragraph } },
    ],
  });
  const font = valueAt(response, 2);
  const format = valueAt(response, 3);
  if (font.kind !== "font")
    throw new Error("The DOCX host did not answer font formatting.");
  if (format.kind !== "paragraphFormat") {
    throw new Error("The DOCX host did not answer paragraph formatting.");
  }
  const paraId = textAt(response, 0);
  return {
    paragraphRef: paragraph.ref,
    text: textAt(response, 1),
    revision: response.revision,
    ...(paraId === "" ? {} : { paraId }),
    font: font.font,
    paragraph: {
      ...format.format,
      ...readFlags(paraId === "" ? undefined : paraId),
    },
  };
}

export function createDocxHostSession(host: AutomationHost): DocxSession {
  return createDocxSessionFromHost(host);
}

function createDocxSessionFromHost(
  host: AutomationHost,
  inspect?: CanonicalInspector,
  formatParagraph: (
    paragraph: AutomationHandle<"paragraph">,
    expectedRevision: number,
    format: DocxParagraphFormatWriteInput,
  ) => DocxApplyResult = (paragraph, expectedRevision, format) =>
    formatDocxParagraph(host, paragraph, expectedRevision, format),
  locateParagraph?: (
    paragraph: AutomationHandle<"paragraph">,
  ) => DocxParagraphLocator | null,
  readFlags?: (paraId: string | undefined) => DocxParagraphFlagsRead,
  formatObject?: (
    paragraph: AutomationHandle<"paragraph">,
    expectedRevision: number,
    mutation: DocxObjectFormatMutation,
  ) => DocxApplyResult,
  formatBatch?: (
    operations: readonly DocxFormatBatchOperation[],
    expectedRevision: number,
  ) => DocxApplyResult,
  tree?: TreeDocxSessionView,
): DocxSession {
  let identityRevision = -1;
  let identityHandles = new Map<string, AutomationHandle<"paragraph">>();
  return {
    revision: () => host.revision(),
    listParagraphHandles: () =>
      paragraphHandles(host, bodyOf(host)),
    paragraphHandleForId: (paraId) => {
      if (identityRevision !== host.revision()) {
        const handles = paragraphHandles(host, bodyOf(host));
        const values = execute(host, { operations: handles.map((paragraph) => ({ op: "getParagraphId" as const, paragraph })) });
        identityHandles = new Map(handles.map((handle, index) => [textAt(values, index), handle]));
        identityRevision = values.revision;
      }
      return identityHandles.get(paraId);
    },
    listParagraphs: () => listDocxParagraphs(host),
    captureTarget: (paragraph) => captureDocxTarget(host, paragraph, inspect),
    applySuggestion: (target, text) =>
      applyDocxSuggestion(host, target, text, inspect),
    formatParagraph,
    formatBatch:
      formatBatch ??
      ((operations, expectedRevision) =>
        formatDocxBatch(host, null, operations, expectedRevision)),
    readParagraphModelText: (paragraph) =>
      textAt(
        execute(host, {
          operations: [
            { op: "getText", target: paragraph, projection: "model" },
          ],
        }),
        0,
      ),
    readParagraph: (paragraph) =>
      readParagraphSemantics(host, paragraph, tree),
    ...(tree
      ? { readImage: (input: DocxImageReadRequest) => readTreeImage(host, tree, input) }
      : {}),
    ...(formatObject ? { formatObject } : {}),
    readParagraphFormatting: (paragraph) =>
      readDocxParagraphFormatting(host, paragraph, readFlags),
    paragraphLocator: locateParagraph ?? (() => null),
    replaceParagraphRange: (input) =>
      replaceParagraphRange(host, input, tree),
    isSuggestionApplied(target, text) {
      const current = readParagraph(host, target.paragraph);
      if (!current || current.text !== text) return false;
      if (inspect) {
        const canonical = inspect(current.paraId);
        if (!canonical?.supported) return false;
      }
      return true;
    },
    subscribe(listener) {
      return host.subscribe((event: AutomationChangeEvent) =>
        listener(event.revision),
      );
    },
    dispose: () => host.dispose(),
  };
}

function formatDocxBatch(
  host: AutomationHost,
  surface: PaginatedSurface | null,
  items: readonly DocxFormatBatchOperation[],
  expectedRevision: number,
  run?: (
    pending: PendingBatchWrite,
    operations: AutomationBatchRequest["operations"],
  ) => DocxApplyResult,
): DocxApplyResult {
  if (host.revision() !== expectedRevision) return staleTarget(host.revision());
  if (items.length === 0) return invalidFormat(host.revision());
  const operations: AutomationBatchRequest["operations"][number][] = [];
  const targets: PendingTreeWrite[] = [];
  const objects: TreeDocOp[] = [];
  const fontRanges = new Map<string, { start: number; end: number }[]>();
  for (const item of items) {
    const flagError = invalidParagraphFlag(item.paragraph);
    if (flagError) return invalidFormatMessage(host.revision(), flagError);
    const text = readParagraph(host, item.target);
    if (!text) return staleTarget(host.revision());
    const { range } = item;
    if (
      range &&
      (!Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start ||
        range.end > text.text.length ||
        item.paragraph !== undefined ||
        item.objectFormat !== undefined ||
        !item.font)
    ) {
      return invalidFormatMessage(
        host.revision(),
        "range must be a non-empty UTF-16 model text range and may only accompany font formatting.",
      );
    }
    if (
      range &&
      [range.start, range.end].some(
        (offset) =>
          offset > 0 &&
          offset < text.text.length &&
          /[\uD800-\uDBFF]/.test(text.text[offset - 1]) &&
          /[\uDC00-\uDFFF]/.test(text.text[offset]),
      )
    ) {
      return invalidFormatMessage(
        host.revision(),
        "range cannot split a UTF-16 surrogate pair.",
      );
    }
    if (
      item.font &&
      Object.values(item.font).some((value) => value !== undefined)
    ) {
      const selection = range ?? { start: 0, end: text.text.length };
      const previous = fontRanges.get(item.target.ref) ?? [];
      if (
        previous.some(
          (other) => selection.start < other.end && other.start < selection.end,
        )
      ) {
        return invalidFormatMessage(
          host.revision(),
          "Font ranges in a formatting group must not overlap.",
        );
      }
      fontRanges.set(item.target.ref, [...previous, selection]);
    }
    const eastAsia = item.font?.nameEastAsia;
    if (
      eastAsia !== undefined &&
      (typeof eastAsia !== "string" ||
        eastAsia.trim().length === 0 ||
        eastAsia.length > 128)
    ) {
      return invalidFormatMessage(
        host.revision(),
        "nameEastAsia must be a non-empty font name of at most 128 characters.",
      );
    }
    const { nameEastAsia: _eastAsia, ...font } = item.font ?? {};
    const standardFont = Object.fromEntries(
      Object.entries(font).filter(([, value]) => value !== undefined),
    );
    const paragraph = item.paragraph
      ? withoutParagraphFlags(item.paragraph)
      : undefined;
    const flags = item.paragraph ? paragraphFlagProperties(item.paragraph) : [];
    const hasFont = Object.keys(standardFont).length > 0;
    const hasParagraph =
      paragraph !== undefined && Object.keys(paragraph).length > 0;
    if (
      !hasFont &&
      !hasParagraph &&
      eastAsia === undefined &&
      flags.length === 0 &&
      !item.objectFormat
    )
      return invalidFormat(host.revision());
    if (hasFont)
      operations.push({
        op: "setFont",
        span: range
          ? {
              start: { paragraph: item.target, offset: range.start },
              end: { paragraph: item.target, offset: range.end },
            }
          : { paragraph: item.target },
        font: standardFont,
      });
    if (hasParagraph && paragraph)
      operations.push({
        op: "setParagraphFormat",
        paragraph: { paragraph: item.target },
        format: paragraph,
      });
    if (eastAsia !== undefined || flags.length > 0) {
      if (!surface)
        return flags.length
          ? unsupportedParagraphFlags(host.revision())
          : unsupportedEastAsiaFont(host.revision());
      const paragraphId = text.paraId
        ? surface.session.nodeIdOf(text.paraId)
        : null;
      if (!paragraphId) return staleTarget(host.revision());
      targets.push({
        paragraphId,
        range,
        eastAsia: eastAsia ?? null,
        paragraphFlags: flags,
      });
    }
    if (item.objectFormat) {
      const planned = planDocxObjectFormat(
        host,
        surface,
        item.target,
        expectedRevision,
        item.objectFormat,
      );
      if (!Array.isArray(planned)) return planned as DocxApplyResult;
      objects.push(...planned);
    }
  }
  const pending = {
    targets,
    objects,
    displayMode: surface?.revisionDisplayMode(),
  };
  if (run) return run(pending, operations);
  const response = host.execute({ expectedRevision, operations });
  if (response.ok)
    return { ok: true, revision: response.revision, changed: response.changed };
  const error = errorAt(response);
  return error.code === "stale-revision" || error.code === "invalid-handle"
    ? staleTarget(response.revision)
    : {
        ok: false,
        code: error.code,
        message: error.message,
        changed: false,
        revision: response.revision,
      };
}

export function createDocxSession(editor: DocxEditorInstance): DocxSession {
  let pendingTreeWrite: PendingBatchWrite | null = null;
  const host = createBrowserAutomationHost(
    withTreeWriteAutomation(editor, () => pendingTreeWrite),
  );
  const formatBatch = (
    items: readonly DocxFormatBatchOperation[],
    expectedRevision: number,
  ) =>
    formatDocxBatch(
      host,
      editor.surface,
      items,
      expectedRevision,
      (pending, operations) => {
        if (operations.length === 0) {
          const surface = editor.surface!;
          const result = surface.applyAutomationOps(() =>
            patchTreeWriteOps([], surface.session, pending),
          );
          return result.rejected
            ? {
                ok: false,
                code: "transaction-refused",
                message:
                  result.reason ??
                  "The DOCX tree refused the formatting transaction.",
                revision: host.revision(),
                changed: false,
              }
            : {
                ok: true,
                revision: host.revision(),
                changed: result.committed,
              };
        }
        pendingTreeWrite = pending;
        try {
          const response = host.execute({ expectedRevision, operations });
          if (response.ok)
            return {
              ok: true,
              revision: response.revision,
              changed: response.changed,
            };
          const error = errorAt(response);
          return error.code === "stale-revision" ||
            error.code === "invalid-handle"
            ? staleTarget(response.revision)
            : {
                ok: false,
                code: error.code,
                message: error.message,
                revision: response.revision,
                changed: false,
              };
        } finally {
          pendingTreeWrite = null;
        }
      },
    );
  const session = createDocxSessionFromHost(
    host,
    (paraId) =>
      editor.surface
        ? canonicalParagraph(editor.surface.session, paraId)
        : null,
    (target, expectedRevision, format) =>
      formatBatch([{ target, ...format }], expectedRevision),
    (paragraph) =>
      editor.surface
        ? paragraphLocator(host, editor.surface.session, paragraph)
        : null,
    (paraId) =>
      editor.surface
        ? readParagraphFlags(editor.surface.session, paraId)
        : EMPTY_PARAGRAPH_FLAGS,
    (target, expectedRevision, objectFormat) =>
      formatBatch([{ target, objectFormat }], expectedRevision),
    formatBatch,
    editor.surface?.session,
  );
  return {
    ...session,
    writeEquation(input, compiled) {
      const surface = editor.surface;
      if (!surface) return { ok: false, code: "unsupported-target", changed: false,
        revision: host.revision(), message: "Equation writes require a live editor tree session." };
      const paragraph = session.listParagraphHandles().find((item) => item.ref === input.paragraphRef);
      if (!paragraph) return staleTarget(host.revision());
      return writeDocxEquation(host, surface, paragraph, input, compiled);
    },
    importTemplateStyles(bytes, styleIds, expectedRevision) {
      if (host.revision() !== expectedRevision)
        return staleTarget(host.revision());
      const surface = editor.surface;
      if (!surface)
        return {
          ok: false,
          code: "unsupported-target",
          message: "Style imports require a live editor tree session.",
          revision: host.revision(),
          changed: false,
        };
      if (surface.editingMode() === "suggest")
        return {
          ok: false,
          code: "unsupported-target",
          message:
            "Style definitions cannot be recorded as suggested revisions. Switch to editing mode to import styles.",
          revision: host.revision(),
          changed: false,
        };
      const source = readOoxmlPackage(bytes);
      if (!source.ok)
        return invalidFormatMessage(
          host.revision(),
          `The template DOCX could not be read: ${source.reason}`,
        );
      const planned = planImportStyles(
        surface.session.currentPackage(),
        source.package,
        styleIds,
      );
      if (!planned.ok)
        return invalidFormatMessage(
          host.revision(),
          `The template styles could not be imported: ${planned.reason}`,
        );
      const result = surface.applyAutomationOps(() => [], undefined, [
        () => planned.pkg,
      ]);
      if (result.rejected)
        return {
          ok: false,
          code: "transaction-refused",
          message: result.reason ?? "The DOCX tree refused the style import.",
          revision: host.revision(),
          changed: false,
        };
      return {
        ok: true,
        changed: result.committed,
        revision: host.revision(),
        styleIdMap: Object.fromEntries(planned.styleIdMap),
        themePolicy: planned.themePolicy,
      };
    },
  };
}

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
import {
  createBrowserAutomationHost,
  type DocxEditorInstance,
  type TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import {
  canonicalOoxmlFingerprint,
  mergedParagraphMarkProperties,
  ooxmlTreesEqual,
  paragraphTextOf,
  runPropertyEdits,
  type OoxmlNode,
  type OoxmlParagraphNode,
  type OoxmlProperty,
  type TreeDocOp,
} from "@docx-editor.dev/core/store";

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
}

export type DocxApplyErrorCode =
  | AutomationErrorCode
  | "stale-target"
  | "unsupported-target"
  | "invalid-format";

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
  listParagraphs(): readonly DocxParagraph[];
  captureTarget(paragraph: AutomationHandle<"paragraph">): DocxTarget;
  applySuggestion(target: DocxTarget, text: string): DocxApplyResult;
  formatParagraph?(
    paragraph: AutomationHandle<"paragraph">,
    expectedRevision: number,
    format: DocxParagraphFormatWriteInput,
  ): DocxApplyResult;
  readParagraphFormatting?(paragraph: AutomationHandle<"paragraph">): DocxParagraphFormatting;
  paragraphLocator?(
    paragraph: AutomationHandle<"paragraph">,
  ): DocxParagraphLocator | null;
  isSuggestionApplied(target: DocxTarget, text: string): boolean;
  subscribe(listener: (revision: number) => void): AutomationUnsubscribe;
  dispose(): void;
}

export interface DocxParagraphFormatWriteInput {
  readonly font?: AutomationFontWrite & {
    /** `w:rFonts/@w:eastAsia`, which the public automation font write does not expose yet. */
    readonly nameEastAsia?: string;
  };
  readonly paragraph?: AutomationParagraphFormatWrite;
}

export interface DocxParagraphFormatting {
  readonly paragraphRef: string;
  readonly text: string;
  readonly revision: number;
  readonly paraId?: string;
  readonly font: AutomationFontRead;
  readonly paragraph: AutomationParagraphFormatRead;
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
    (result): result is Extract<AutomationOperationResult, { status: "error" }> =>
      result.status === "error",
  );
  if (!failure) {
    throw new Error("The DOCX host refused a batch without naming an operation error.");
  }
  return failure.error;
}

function execute(host: AutomationHost, request: AutomationBatchRequest): AutomationBatchResponse {
  const response = host.execute(request);
  if (!response.ok) throw new DocxSessionError(errorAt(response), response.revision);
  return response;
}

function valueAt(response: AutomationBatchResponse, index: number): AutomationValue {
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

function handlesAt(response: AutomationBatchResponse, index: number): readonly AutomationHandle[] {
  const value = valueAt(response, index);
  if (value.kind !== "handles") {
    throw new Error("The DOCX host did not answer handles.");
  }
  return value.handles;
}

function textAt(response: AutomationBatchResponse, index: number): string {
  const value = valueAt(response, index);
  if (value.kind !== "text") throw new Error("The DOCX host did not answer text.");
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

type CanonicalInspector = (paraId: string | undefined) => CanonicalParagraph | null;

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

export function inspectDocxParagraph(node: OoxmlParagraphNode): CanonicalParagraph {
  return {
    structure: canonicalOoxmlFingerprint(node),
    supported: safeForWholeParagraphReplacement(node),
  };
}

function findParagraph(node: OoxmlNode, nodeId: string): OoxmlParagraphNode | null {
  if (node.id === nodeId) return node.kind === "paragraph" ? node : null;
  if (node.kind === "textValue") return null;
  for (const child of node.children) {
    const paragraph = findParagraph(child, nodeId);
    if (paragraph) return paragraph;
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
  return path === null ? null : { part: part.name, path };
}

function safeForWholeParagraphReplacement(node: OoxmlParagraphNode): boolean {
  const runs = node.children.filter(
    (child): child is Extract<OoxmlNode, { kind: "run" }> => child.kind === "run",
  );
  if (runs.length === 0 || runs.length !== node.children.filter(
    (child) => child.kind !== "paragraphProperties",
  ).length) return false;

  const textRuns = runs.map((run) => ({
    properties: run.children.find((child) => child.kind === "runProperties"),
    simple:
      run.children.every(
        (child) => child.kind === "runProperties" || child.kind === "text",
      ) &&
      run.children.filter((child) => child.kind === "text").length === 1,
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
      { op: "getText" as const, target: paragraph, projection: "model" as const },
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
  return handlesAt(
    execute(host, {
      operations: [{ op: "getRevisions", scope: { paragraph } }],
    }),
    0,
  ).length > 0;
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

function invalidFormatMessage(revision: number, message: string): DocxApplyResult {
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

export function listDocxParagraphs(host: AutomationHost): readonly DocxParagraph[] {
  return readParagraphs(host, paragraphHandles(host, bodyOf(host))).map((details) => ({
    handle: details.paragraph,
    text: details.text,
    ...(details.paraId === undefined ? {} : { paraId: details.paraId }),
  }));
}

export function captureDocxTarget(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
  inspect?: CanonicalInspector,
): DocxTarget {
  const details = readParagraph(host, paragraph);
  if (!details) throw new Error("The paragraph is not present in this DOCX document.");
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
  if (hasTrackedChange(host, target.paragraph)) return staleTarget(current.revision);

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
  if (
    (!format.font || Object.keys(format.font).length === 0) &&
    (!format.paragraph || Object.keys(format.paragraph).length === 0)
  ) return invalidFormat(host.revision());
  if (host.revision() !== expectedRevision) return staleTarget(host.revision());
  if (format.font?.nameEastAsia !== undefined) return unsupportedEastAsiaFont(host.revision());
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
    ...(font
      ? [{ op: "setFont" as const, span: { paragraph }, font }]
      : []),
    ...(format.paragraph
      ? [{
          op: "setParagraphFormat" as const,
          paragraph: { paragraph },
          format: format.paragraph,
        }]
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
  const current = properties.find((property) => property.localName === "rFonts");
  const attributes: Record<string, string> = { ...current?.attributes, eastAsia };
  delete attributes.eastAsiaTheme;
  return current
    ? properties.map((property) =>
        property === current ? { localName: "rFonts", attributes } : property,
      )
    : [...properties, { localName: "rFonts", attributes }];
}

function eastAsiaTreeOps(
  tree: TreeDocxSessionView,
  paragraphId: string,
  eastAsia: string,
): readonly TreeDocOp[] {
  const part = tree.part();
  const properties = [{ localName: "rFonts", attributes: { eastAsia } }];
  const textLength = paragraphTextOf(part, paragraphId)?.length ?? 0;
  return [
    ...runPropertyEdits(part, paragraphId, 0, textLength, properties).map(
      (edit) => ({
        op: "setRunProperties" as const,
        paragraphId,
        start: edit.start,
        end: edit.end,
        properties: edit.properties,
        ...(edit.targetRunIds === undefined
          ? {}
          : { targetRunIds: edit.targetRunIds }),
      }),
    ),
    {
      op: "setParagraphMarkProperties",
      paragraphId,
      properties: mergedParagraphMarkProperties(part, paragraphId, properties),
    },
  ];
}

function patchEastAsiaOps(
  operations: readonly TreeDocOp[],
  tree: TreeDocxSessionView,
  eastAsia: string,
): readonly TreeDocOp[] {
  let patchedRuns = false;
  const patched = operations.map((operation): TreeDocOp => {
    if (
      operation.op === "setRunProperties" ||
      operation.op === "setParagraphMarkProperties"
    ) {
      patchedRuns = true;
      return {
        ...operation,
        properties: eastAsiaProperties(operation.properties, eastAsia),
      };
    }
    return operation;
  });
  if (patchedRuns) return patched;

  const paragraphId = operations.find(
    (operation): operation is Extract<TreeDocOp, { paragraphId: string }> =>
      "paragraphId" in operation,
  )?.paragraphId;
  return paragraphId
    ? [...eastAsiaTreeOps(tree, paragraphId, eastAsia), ...patched]
    : patched;
}

function formatDocxEastAsiaOnly(
  host: AutomationHost,
  tree: TreeDocxSessionView | null,
  paragraph: AutomationHandle<"paragraph">,
  expectedRevision: number,
  eastAsia: string,
): DocxApplyResult {
  if (host.revision() !== expectedRevision) return staleTarget(host.revision());
  if (!tree) return unsupportedEastAsiaFont(host.revision());
  const paraId = textAt(
    execute(host, { operations: [{ op: "getParagraphId", paragraph }] }),
    0,
  );
  const paragraphId = paraId === "" ? null : tree.nodeIdOf(paraId);
  if (!paragraphId) return unsupportedTarget(host.revision());
  const result = tree.applyTreeOps(eastAsiaTreeOps(tree, paragraphId, eastAsia));
  if (result.rejected) {
    return {
      ok: false,
      code: "transaction-refused",
      message: result.reason ?? "The DOCX tree refused the font transaction.",
      revision: host.revision(),
      changed: false,
    };
  }
  return {
    ok: true,
    revision: host.revision(),
    changed: result.committed,
  };
}

function withEastAsiaAutomation(
  editor: DocxEditorInstance,
  pending: () => string | null,
): DocxEditorInstance {
  return new Proxy(editor, {
    get(target, property, receiver) {
      if (property === "surface") {
        const surface = target.surface;
        if (!surface) return null;
        return new Proxy(surface, {
          get(surfaceTarget, surfaceProperty) {
            const value = Reflect.get(surfaceTarget, surfaceProperty, surfaceTarget);
            if (surfaceProperty !== "applyAutomationOps" || typeof value !== "function") {
              return typeof value === "function" ? value.bind(surfaceTarget) : value;
            }
            return (
              staged: Parameters<typeof surfaceTarget.applyAutomationOps>[0],
              scope?: Parameters<typeof surfaceTarget.applyAutomationOps>[1],
              packageEdits?: Parameters<typeof surfaceTarget.applyAutomationOps>[2],
              requiresReview?: Parameters<typeof surfaceTarget.applyAutomationOps>[3],
            ) => {
              const eastAsia = pending();
              if (eastAsia === null) {
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
                    : patchEastAsiaOps(operations, surfaceTarget.session, eastAsia);
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

export function readDocxParagraphFormatting(
  host: AutomationHost,
  paragraph: AutomationHandle<"paragraph">,
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
  if (font.kind !== "font") throw new Error("The DOCX host did not answer font formatting.");
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
    paragraph: format.format,
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
): DocxSession {
  return {
    revision: () => host.revision(),
    listParagraphs: () => listDocxParagraphs(host),
    captureTarget: (paragraph) => captureDocxTarget(host, paragraph, inspect),
    applySuggestion: (target, text) =>
      applyDocxSuggestion(host, target, text, inspect),
    formatParagraph,
    readParagraphFormatting: (paragraph) => readDocxParagraphFormatting(host, paragraph),
    paragraphLocator: locateParagraph ?? (() => null),
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
      return host.subscribe((event: AutomationChangeEvent) => listener(event.revision));
    },
    dispose: () => host.dispose(),
  };
}

export function createDocxSession(editor: DocxEditorInstance): DocxSession {
  let pendingEastAsia: string | null = null;
  const host = createBrowserAutomationHost(
    withEastAsiaAutomation(editor, () => pendingEastAsia),
  );
  return createDocxSessionFromHost(
    host,
    (paraId) => {
      const tree = editor.surface?.session;
      return tree ? canonicalParagraph(tree, paraId) : null;
    },
    (paragraph, expectedRevision, format) => {
      const eastAsia = format.font?.nameEastAsia;
      if (eastAsia === undefined) {
        return formatDocxParagraph(host, paragraph, expectedRevision, format);
      }
      if (eastAsia.trim().length === 0 || eastAsia.length > 128) {
        return invalidFormatMessage(
          host.revision(),
          "nameEastAsia must be a non-empty font name of at most 128 characters.",
        );
      }
      const font = { ...format.font };
      delete font.nameEastAsia;
      const standardFont = Object.fromEntries(
        Object.entries(font).filter(([, value]) => value !== undefined),
      );
      const hasFont = Object.keys(standardFont).length > 0;
      const hasParagraph =
        format.paragraph !== undefined &&
        Object.keys(format.paragraph).length > 0;
      const tree = editor.surface?.session ?? null;
      if (!tree) return unsupportedEastAsiaFont(host.revision());
      if (!hasFont && !hasParagraph) {
        return formatDocxEastAsiaOnly(
          host,
          tree,
          paragraph,
          expectedRevision,
          eastAsia,
        );
      }
      pendingEastAsia = eastAsia;
      try {
        return formatDocxParagraph(host, paragraph, expectedRevision, {
          ...(hasFont ? { font: standardFont } : {}),
          ...(hasParagraph ? { paragraph: format.paragraph } : {}),
        });
      } finally {
        pendingEastAsia = null;
      }
    },
    (paragraph) => {
      const tree = editor.surface?.session;
      return tree ? paragraphLocator(host, tree, paragraph) : null;
    },
  );
}

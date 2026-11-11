import type {
  AutomationBatchRequest,
  AutomationBatchResponse,
  AutomationChangeEvent,
  AutomationError,
  AutomationErrorCode,
  AutomationHandle,
  AutomationHost,
  AutomationOperationResult,
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
  ooxmlTreesEqual,
  type OoxmlNode,
  type OoxmlParagraphNode,
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

export type DocxApplyErrorCode =
  | AutomationErrorCode
  | "stale-target"
  | "unsupported-target";

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
  isSuggestionApplied(target: DocxTarget, text: string): boolean;
  subscribe(listener: (revision: number) => void): AutomationUnsubscribe;
  dispose(): void;
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

export function createDocxHostSession(host: AutomationHost): DocxSession {
  return createDocxSessionFromHost(host);
}

function createDocxSessionFromHost(
  host: AutomationHost,
  inspect?: CanonicalInspector,
): DocxSession {
  return {
    revision: () => host.revision(),
    listParagraphs: () => listDocxParagraphs(host),
    captureTarget: (paragraph) => captureDocxTarget(host, paragraph, inspect),
    applySuggestion: (target, text) =>
      applyDocxSuggestion(host, target, text, inspect),
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
  return createDocxSessionFromHost(
    createBrowserAutomationHost(editor),
    (paraId) => {
      const tree = editor.surface?.session;
      return tree ? canonicalParagraph(tree, paraId) : null;
    },
  );
}

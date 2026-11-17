import {
  buildStandaloneDoc,
  slugifyFigureName,
  bytesToBase64,
  normalizeFigureCode,
} from "@oleafly/latex";
import { pickPagesToVerify } from "./pick-pages";
import { projectMapFromIndex } from "./project-map";
import type { TypstFigureRender } from "./typst-figure";
import { DOCX_OBJECT_FORMAT_SCHEMAS, docxObjectFormatMutation, type DocxObjectFormatMutation } from "./docx-object-format";

export type FigureEngine = "latex" | "typst";
export type FigurePreview =
  | { pdfBytes: Uint8Array; projectId?: string }
  | { pngDataUrl: string; projectId?: string };

export interface IndexDefView {
  kind: string;
  name: string;
  level?: number;
  file?: string;
  line?: number;
}

export interface IndexUseView {
  kind: string;
  name: string;
  file?: string;
  target?: string;
}

export interface ProjectIndexView {
  defs: IndexDefView[];
  uses: IndexUseView[];
  definitionFor(use: IndexUseView): unknown;
}

export interface RevealLocationTarget {
  path?: string;
  line?: number;
  page?: number;
}

export interface RevealLocationResult {
  revealed: boolean;
  note?: string;
}

export interface AiToolsHost {
  getProjectId(): string | null;
  readFileContent(projectId: string, path: string): Promise<string>;
  writeFileContent(
    projectId: string,
    path: string,
    content: string,
    expectedGeneration?: number,
  ): Promise<unknown>;
  createFile(
    projectId: string,
    path: string,
    isDir: boolean,
    expectedGeneration?: number,
  ): Promise<unknown>;
  deleteFile(projectId: string, path: string, expectedGeneration?: number): Promise<unknown>;
  renameFile(
    projectId: string,
    from: string,
    to: string,
    expectedGeneration?: number,
  ): Promise<unknown>;
  setMainDoc(projectId: string, path: string): Promise<{ main_doc: string }>;
  listFiles(projectId: string): Promise<unknown[]>;
  searchProject(projectId: string, query: string): Promise<unknown[]>;
  readProjectBytes(projectId: string, path: string): Promise<ArrayBuffer | ArrayLike<number>>;
  writeProjectBytes(
    projectId: string,
    relPath: string,
    dataBase64: string,
    expectedGeneration?: number,
  ): Promise<unknown>;
  prepareExternalMutation(projectId: string): Promise<number>;
  applyExternalWrite(projectId: string, path: string, content: string): boolean;
  applyExternalRename(projectId: string, from: string, to: string): boolean;
  applyExternalDelete(projectId: string, path: string): boolean;
  refreshTree(projectId: string): Promise<void>;
  refreshOpenFiles?(projectId: string): void;
  recompile(): Promise<
    { ok?: boolean; errors?: unknown[]; has_pdf?: boolean; log?: string | null } | null | undefined
  >;
  getCompileLog(): string | null;
  getPdfBytes(): Uint8Array | null;
  extractPdfText(bytes: Uint8Array): Promise<{ pages: string[]; numPages: number }>;
  getPdfCursorPage?(): number | null | undefined;
  getProjectIndex(): Promise<ProjectIndexView | null>;
  compileIsolated(
    projectId: string,
    source: string,
  ): Promise<{ ok: boolean; errors: unknown[]; has_pdf: boolean; log?: string | null }>;
  readIsolatedPdf(projectId: string): Promise<ArrayBuffer | ArrayLike<number>>;
  pdfToPng(bytes: Uint8Array, page: number, scale: number): Promise<string>;
  setLastFigurePreview(v: FigurePreview | null): void;
  getLastFigurePreview(): FigurePreview | null;
  getFigureInsertTarget(): { from: number; to: number } | null;
  getFigureEngine?(): FigureEngine | null;
  renderTypstFigure?(projectId: string, source: string): Promise<TypstFigureRender>;
  insertAtCursor(
    projectId: string,
    text: string,
    mutationAllowed?: () => boolean,
  ): boolean | Promise<boolean>;
  replaceRange(
    projectId: string,
    from: number,
    to: number,
    text: string,
    mutationAllowed?: () => boolean,
  ): boolean | Promise<boolean>;
  insertTargetPath?(projectId: string): string | null;
  getAgentTodos(): { id: string; content: string; status: string }[];
  setAgentTodos(todos: { id: string; content: string; status: string }[]): void;
  getAiPdfCaptureEnabled(): boolean;
  revealLocation?(target: RevealLocationTarget): Promise<RevealLocationResult>;
  rememberNote(content: string): { id: string; content: string } | { error: string };
  forgetNote(id: string): { success: boolean; error?: string };
  listNotes(): { id: string; content: string }[];
}

export interface DocxDocumentState {
  sessionId: string;
  baselineId: string;
  sessionRevision: number;
  savedRevision: number;
  dirty: boolean;
}

export interface DocxFormatDocumentState extends DocxDocumentState {
  filename: string;
}

export interface DocxActivityDocument extends DocxDocumentState {
  sourceSha256: string;
  appProjectId: string;
  workbenchProjectId: string;
  title: string;
  filename: string;
}

export interface DocxParagraphView {
  paragraphRef: string;
  /** Display projection. Fields use their cached result; formula and drawing atoms use U+FFFC. */
  text: string;
  paraId?: string;
  /** Revision at which this paragraph and its ranges were read. */
  revision: number;
  /** Canonical editable projection. Range offsets below always refer to this string. */
  modelText: string;
  displayText: string;
  /** UTF-16 offset of modelText within the complete paragraph when this view is windowed. */
  modelTextOffset?: number;
  modelTextLength?: number;
  modelTextTruncated?: boolean;
  /** UTF-16 offset of displayText within the complete paragraph when this view is windowed. */
  displayTextOffset?: number;
  displayTextLength?: number;
  displayTextTruncated?: boolean;
  atoms: DocxInlineAtom[];
  /**
   * Safe ordinary-text ranges in the complete paragraph's modelText UTF-16 coordinates.
   * A text window only filters which ranges are returned. Empty means no range in this
   * window is currently editable.
   */
  editableRanges: DocxModelRange[];
}

export interface DocxModelRange { start: number; end: number }

export type DocxInlineAtomKind =
  | "field" | "math" | "drawing" | "note" | "tab" | "break";

export interface DocxInlineAtom {
  objectRef: string;
  kind: DocxInlineAtomKind;
  /** UTF-16 half-open range in the paragraph's modelText. */
  modelRange: DocxModelRange;
  /** UTF-16 half-open range in the paragraph's displayText when available. */
  displayRange: DocxModelRange;
  displayText?: string;
  readable?: boolean;
  /** Whether the payload is a complete semantic projection of the atom. */
  complete: boolean;
  editable: false;
  payload?: unknown;
  /** A JSON fragment of payload when the complete value cannot fit in this page. */
  payloadJson?: string;
  payloadOffset?: number;
  payloadLength?: number;
  /** Continue this atom's payload without changing its model/display range. */
  payloadContinuation?: DocxReadContinuation | null;
}

/** Host-side continuation. read_docx_document emits the same fields in snake_case. */
export interface DocxReadContinuation {
  sessionId?: string;
  offset?: number;
  limit?: number;
  expectedRevision: number;
  textOffset?: number;
  textLimit?: number;
  atomOffset?: number;
  payloadOffset?: number;
}

export interface DocxReadQuery {
  sessionId?: string;
  offset?: number;
  limit?: number;
  expectedRevision?: number;
  /** Continue within one paragraph. These offsets are UTF-16 half-open modelText coordinates. */
  textOffset?: number;
  textLimit?: number;
  /** Continue atom metadata after the text window has been established. */
  atomOffset?: number;
  /** Continue the selected atom's serialized payload. */
  payloadOffset?: number;
}

export interface DocxDocumentRead {
  document: DocxActivityDocument;
  paragraphs: DocxParagraphView[];
  offset: number;
  nextOffset: number | null;
  totalParagraphs: number;
  /** Host-side continuation; the tool output exposes the same fields in snake_case. */
  nextQuery: DocxReadContinuation | null;
  /** True only when a paragraph was continued with text_offset/text_limit. */
  textWindow?: {
    paragraphRef: string;
    offset: number;
    nextOffset: number | null;
    textLength: number;
  };
  /** Atom metadata continuation for the active text window. */
  atomWindow?: {
    paragraphRef: string;
    offset: number;
    nextOffset: number | null;
    total: number;
  };
}

export interface DocxTextRangeReplaceRequest {
  sessionId?: string;
  paragraphRef: string;
  expectedRevision: number;
  /** UTF-16 half-open modelText range. Never a display-text coordinate. */
  range: DocxModelRange;
  expectedText: string;
  replacement: string;
}

export interface DocxTextRangeReplaceResult {
  ok: boolean;
  code?: string;
  message?: string;
  changed: boolean;
  revision: number;
  document: DocxDocumentState;
}

export interface DocxImageReadRequest {
  paragraphRef: string;
  objectRef: string;
  expectedRevision: number;
}

export interface DocxImageReadResult {
  revision: number;
  objectRef: string;
  part: string;
  relationshipId: string;
  mediaPart: string;
  mimeType: string;
  bytes: Uint8Array;
  description?: string;
  widthEmu?: number;
  heightEmu?: number;
}

/** The application host adds the exact byte hash before exposing the image to a tool. */
export interface DocxImageReadHostResult extends DocxImageReadResult {
  imageSha256: string;
  document: DocxActivityDocument;
  sourceSha256: string;
}

export interface DocxImageToolMetadata {
  source: "live-docx";
  imageReadComplete: true;
  contentStatus: "pixels_provided";
  editable: false;
  document: DocxActivityDocument;
  sourceSha256: string;
  sessionId?: string;
  paragraphRef: string;
  objectRef: string;
  revision: number;
  part: string;
  relationshipId: string;
  mediaPart: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif";
  imageSha256: string;
  width: number;
  height: number;
  description?: string;
  widthEmu?: number;
  heightEmu?: number;
}

export const DOCX_READ_MAX_CHARS = 10_000;

export interface DocxWorkspaceContext {
  viewed: {
    projectId: string; documentId: string; title: string; kind: string; role: string;
    revision: string; sessionId?: string; sessionRevision?: number; dirty?: boolean;
    selection?: { revision: string; paragraphRef?: string; paraId?: string; quote?: string } | null;
  } | null;
  writable: DocxActivityDocument[];
  capabilities?: { sessionId: string; operations: string[] }[];
  selectionWriteTarget: { sessionId: string; paragraphRef: string; revision: number } | null;
  targeting: string;
}

export interface DocxRevealRequest {
  sessionId?: string;
  paragraphRef?: string;
  paraId?: string;
  expectedRevision?: number;
}

export interface DocxTargetView extends DocxDocumentState {
  filename: string;
  targetId: string;
  paragraphRef: string;
  text: string;
  revision: number;
  paraId?: string;
  structure?: string;
}

export interface DocxSuggestion {
  target: DocxTargetView;
  proposed: string;
}

export interface DocxSuggestionResult extends DocxSuggestion {
  document: DocxDocumentState;
}

export interface DocxSuggestionApplyResult {
  ok: boolean;
  code?: string;
  message?: string;
  changed: boolean;
  document: DocxDocumentState;
}

export interface DocxEquationWriteRequest {
  sessionId?: string;
  paragraphRef: string;
  expectedRevision: number;
  latex: string;
  macros?: string;
  objectRef?: string;
  expectedFingerprint?: string;
  adoptSource?: boolean;
  offset?: number;
  display?: boolean;
}

export interface DocxEquationWriteResult extends DocxSuggestionApplyResult {
  revision: number;
  warnings: string[];
  sourceHash?: string;
}

export type DocxAlignment = "Mixed" | "Unknown" | "Left" | "Centered" | "Right" | "Justified";
export type DocxReadingOrder = "LeftToRight" | "RightToLeft";

export interface DocxFontFormatRead {
  bold: boolean | null; italic: boolean | null; underline: string | null; strikeThrough: boolean | null;
  highlightColor: string | null; subscript: boolean | null; superscript: boolean | null;
  name: string | null; size: number | null; color: string | null;
}
export interface DocxFontFormatWrite {
  bold?: boolean; italic?: boolean; underline?: string; strikeThrough?: boolean; highlightColor?: string | null;
  subscript?: boolean; superscript?: boolean; name?: string; nameEastAsia?: string; size?: number; color?: string;
}
export interface DocxParagraphFormatRead {
  alignment: DocxAlignment; style: string | null; firstLineIndent: number | null;
  leftIndent: number | null; rightIndent: number | null; lineSpacing: number | null;
  spaceBefore: number | null; spaceAfter: number | null; widowControl: boolean | null;
  keepNext: boolean | null; keepLines: boolean | null; pageBreakBefore: boolean | null;
  readingOrder: DocxReadingOrder;
}
export interface DocxParagraphFormatWrite {
  alignment?: DocxAlignment; /** Exact style display name (`w:name`), not the style ID. */ style?: string; firstLineIndent?: number; leftIndent?: number;
  rightIndent?: number; lineSpacing?: number; spaceBefore?: number; spaceAfter?: number;
  widowControl?: boolean; keepNext?: boolean; keepLines?: boolean;
  pageBreakBefore?: boolean; readingOrder?: DocxReadingOrder;
}
export interface DocxParagraphFormatting {
  paragraphRef: string; text: string; revision: number; paraId?: string;
  font: DocxFontFormatRead; paragraph: DocxParagraphFormatRead;
}
export interface DocxFormatMutation { font?: DocxFontFormatWrite; paragraph?: DocxParagraphFormatWrite }
export interface DocxFormatRange { start: number; end: number }
export interface DocxFormatBatchItem extends DocxFormatMutation {
  paragraphRef: string;
  /** UTF-16 offsets in the system-provided modelText, with fields represented by U+FFFC. */
  range?: DocxFormatRange;
  objectFormat?: DocxObjectFormatMutation;
}

export interface DocxFormatReadQuery {
  kind?: "overview" | "paragraphs" | "styles" | "objects" | "nodes";
  expectedRevision?: number;
  paragraphRef?: string; part?: string; path?: number[];
  objectKind?: string; role?: string; styleId?: string; objectId?: string; text?: string;
  textOffset?: number; textLimit?: number;
  namespaceUri?: string; localName?: string;
  attribute?: { namespaceUri?: string; localName: string; value?: string };
  offset?: number; limit?: number;
}
export type DocxFormatRecord = { [key: string]: unknown };
export interface DocxFormatReadResult {
  document: DocxFormatDocumentState; sourceSha256: string; revision: number;
  paragraph?: DocxParagraphFormatting; objects?: DocxFormatRecord[];
  overview?: DocxFormatRecord; paragraphs?: DocxFormatRecord[]; styles?: DocxFormatRecord[];
  nodes?: DocxFormatRecord[]; total?: number; nextOffset: number | null;
  /** Tool query with the original selectors and revision for continuing this page. */
  nextQuery?: DocxFormatRecord | null;
}
export interface DocxSaveResult {
  baselineId: string; revision: number; sourceSha256: string; document: DocxDocumentState;
  formatStatus?: "recorded" | "failed" | "not_requested";
  formatError?: string;
}
export interface DocxTemplateCheckResult { template: string; check: Record<string, unknown> }
export interface DocxTemplateStyleImportResult extends DocxSuggestionApplyResult {
  template: string;
  templateSourceSha256: string;
  styleIdMap?: Readonly<Record<string, string>>;
  themePolicy?: string;
}

/** Runtime-owned task facts. UI state must not be used to invent these values. */
export interface DocxAgentAttribution {
  taskId?: string;
  workId?: string;
  memberId?: string;
  executionId?: string;
}

export interface DocxOperationContext {
  attribution?: DocxAgentAttribution;
  signal?: AbortSignal;
  onToken?: (full: string) => void;
}

export interface DocxSuggestionRequest {
  sessionId?: string;
  paragraphRef: string;
  instruction: string;
  expectedRevision?: number;
}

export interface DocxSuggestionApplyRequest {
  targetId: string;
  expectedRevision: number;
  text: string;
}

export interface DocxToolsHost {
  workspaceContext?(): Promise<DocxWorkspaceContext>;
  revealWorkingCopy?(input: DocxRevealRequest): Promise<{ document: DocxActivityDocument; navigation: "requested" }>;
  prepareFonts?(sessionId?: string): Promise<unknown>;
  exportDocument?(sessionId?: string): Promise<unknown>;
  listDocuments(): Promise<DocxActivityDocument[]>;
  readDocument(query?: DocxReadQuery): Promise<DocxDocumentRead>;
  replaceTextRange?(
    input: DocxTextRangeReplaceRequest,
    context?: DocxOperationContext,
  ): Promise<DocxTextRangeReplaceResult>;
  writeEquation?(
    input: DocxEquationWriteRequest,
    context?: DocxOperationContext,
  ): Promise<DocxEquationWriteResult>;
  captureTarget(sessionId: string | undefined, paragraphRef: string): Promise<DocxTargetView>;
  inspectTarget(targetId: string): Promise<DocxTargetView>;
  suggestChange(
    input: DocxSuggestionRequest,
    context?: DocxOperationContext,
  ): Promise<DocxSuggestionResult>;
  applySuggestion(
    input: DocxSuggestionApplyRequest,
    context?: DocxOperationContext,
  ): Promise<DocxSuggestionApplyResult>;
  readFormat?(
    sessionId: string | undefined,
    query: DocxFormatReadQuery,
  ): Promise<DocxFormatReadResult>;
  readImage?(
    sessionId: string | undefined,
    input: DocxImageReadRequest,
  ): Promise<DocxImageReadHostResult>;
  formatParagraph?(
    sessionId: string | undefined,
    paragraphRef: string,
    expectedRevision: number,
    format: DocxFormatMutation,
    context?: DocxOperationContext,
  ): Promise<DocxSuggestionApplyResult>;
  formatObject?(
    sessionId: string | undefined,
    paragraphRef: string,
    expectedRevision: number,
    format: DocxObjectFormatMutation,
    context?: DocxOperationContext,
  ): Promise<DocxSuggestionApplyResult>;
  formatBatch?(
    sessionId: string | undefined,
    expectedRevision: number,
    operations: DocxFormatBatchItem[],
    context?: DocxOperationContext,
  ): Promise<DocxSuggestionApplyResult>;
  importTemplateStyles?(
    sessionId: string | undefined,
    template: string,
    styleIds: string[],
    expectedRevision: number,
    context?: DocxOperationContext,
  ): Promise<DocxTemplateStyleImportResult>;
  saveDocument?(
    sessionId: string | undefined,
    expectedRevision: number,
    context?: DocxOperationContext,
  ): Promise<DocxSaveResult>;
  checkTemplate?(
    sessionId: string | undefined,
    template: string,
    context?: DocxOperationContext,
  ): Promise<DocxTemplateCheckResult>;
}

type RawSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
};

type RawToolDef = {
  description: string;
  inputSchema: RawSchema;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export interface ToolApprovalRequest {
  tool: string;
  summary: string;
  projectId?: string;
  command?: string;
  cwd?: string;
  path?: string;
  diff?: { path: string; oldText: string; newText: string };
  image?: string;
}

export type ConfirmFn = (req: ToolApprovalRequest) => Promise<boolean>;

export interface DocxToolsOptions {
  runId?: () => string | null;
  attribution?: DocxAgentAttribution;
  confirm?: ConfirmFn;
  mutationAllowed?: () => boolean;
  /** Explicit ordinary-chat model capability. Omit for transports that carry images natively. */
  imageSupported?: boolean;
  signal?: AbortSignal;
  onToken?: (full: string) => void;
  onImage?: (dataUrl: string) => void;
}

export interface ExecAuthorization {
  approvalToken: string;
  runId: string;
}

const MAX_MUTATION_BYTES = 16 * 1024 * 1024;

const DOCX_FONT_SCHEMA = {
  type: "object", required: [], additionalProperties: false,
  properties: {
    bold: { type: "boolean" }, italic: { type: "boolean" }, underline: { type: "string" },
    strikeThrough: { type: "boolean" }, highlightColor: { type: ["string", "null"] },
    subscript: { type: "boolean" }, superscript: { type: "boolean" },
    name: { type: "string", description: "Latin font family." },
    nameEastAsia: { type: "string", minLength: 1, description: "Exact East Asian font family, for example SimSun." },
    size: { type: "number", description: "Points." },
    color: { type: "string", description: "#RRGGBB." },
  },
} as const;

const DOCX_PARAGRAPH_FORMAT_SCHEMA = {
  type: "object", required: [], additionalProperties: false,
  properties: {
    alignment: { enum: ["Left", "Centered", "Right", "Justified"] },
    style: { type: "string", description: "Exact existing style display name (w:name), not w:styleId. Resolve imported IDs with a styles read." },
    firstLineIndent: { type: "number" }, leftIndent: { type: "number" },
    rightIndent: { type: "number" }, lineSpacing: { type: "number" },
    spaceBefore: { type: "number" }, spaceAfter: { type: "number" },
    widowControl: { type: "boolean" },
    keepNext: { type: "boolean", description: "Keep this paragraph on the same page as the next." },
    keepLines: { type: "boolean", description: "Keep the paragraph's lines on one page." },
    pageBreakBefore: { type: "boolean", description: "Start this paragraph on a new page." },
    readingOrder: { enum: ["LeftToRight", "RightToLeft"] },
  },
} as const;

const DOCX_SESSION_SCHEMA = {
  type: "string",
  description: "Session ID from list_docx_documents. Omit for the active session.",
} as const;

const DOCX_READ_QUERY_SCHEMA = {
  session_id: DOCX_SESSION_SCHEMA,
  offset: { type: "integer", minimum: 0, default: 0 },
  limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  expected_revision: { type: "integer", minimum: 0 },
  text_offset: { type: "integer", minimum: 0 },
  text_limit: { type: "integer", minimum: 1, maximum: 8000 },
  atom_offset: { type: "integer", minimum: 0 },
  payload_offset: { type: "integer", minimum: 0 },
} as const;

const DOCX_MODEL_RANGE_SCHEMA = {
  type: "object", required: ["start", "end"], additionalProperties: false,
  properties: {
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 1 },
  },
} as const;

const DOCX_RANGE_SCHEMA = {
  type: "object", required: ["start", "end"], additionalProperties: false,
  description: "A same-paragraph font range using UTF-16 offsets in the modelText returned by read_docx_format kind paragraphs. Fields occupy one U+FFFC character.",
  properties: { start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } },
} as const;

function docxFormatItem(input: Record<string, unknown>): DocxFormatBatchItem {
  if (typeof input.paragraph_ref !== "string" || !input.paragraph_ref.trim()) {
    throw new Error("A DOCX format operation needs a paragraph reference.");
  }
  const objectFormat = docxObjectFormatMutation(input);
  const range = input.range as DocxFormatRange | undefined;
  if (range !== undefined && (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start)) {
    throw new Error("A DOCX font range requires integer offsets with 0 <= start < end.");
  }
  if (range && (objectFormat || input.paragraph !== undefined || input.font === undefined)) {
    throw new Error("A DOCX range applies only to font formatting; omit paragraph and object formats.");
  }
  if (objectFormat) return { paragraphRef: input.paragraph_ref, objectFormat };
  return {
    paragraphRef: input.paragraph_ref,
    ...(range ? { range } : {}),
    ...(input.font ? { font: input.font as DocxFontFormatWrite } : {}),
    ...(input.paragraph ? { paragraph: input.paragraph as DocxParagraphFormatWrite } : {}),
  };
}

function docxFormatQuery(value: unknown): DocxFormatReadQuery {
  const query = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (query.expected_revision !== undefined && docxRevision(query.expected_revision) === null)
    throw new Error("expected_revision must be a non-negative session revision.");
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || Number(query.offset) < 0))
    throw new Error("A DOCX format offset must be a non-negative integer.");
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 50))
    throw new Error("Read one to fifty DOCX format objects per window.");
  if (query.path !== undefined && (!Array.isArray(query.path) || query.path.some((index) => !Number.isInteger(index) || index < 0)))
    throw new Error("A DOCX node path must contain non-negative integer child indices.");
  if (query.text_offset !== undefined && (!Number.isInteger(query.text_offset) || Number(query.text_offset) < 0))
    throw new Error("A DOCX text offset must be a non-negative UTF-16 offset.");
  if (query.text_limit !== undefined && (!Number.isInteger(query.text_limit) || Number(query.text_limit) < 1 || Number(query.text_limit) > 16000))
    throw new Error("A DOCX text window must contain one to sixteen thousand UTF-16 units.");
  const attribute = query.attribute && typeof query.attribute === "object"
    ? query.attribute as Record<string, unknown>
    : {};
  return {
    ...(["overview", "paragraphs", "styles", "objects", "nodes"].includes(String(query.kind))
      ? { kind: query.kind as DocxFormatReadQuery["kind"] } : {}),
    ...(typeof query.expected_revision === "number" ? { expectedRevision: query.expected_revision } : {}),
    ...(typeof query.object_kind === "string" ? { objectKind: query.object_kind } : {}),
    ...(typeof query.role === "string" ? { role: query.role } : {}),
    ...(typeof query.style_id === "string" ? { styleId: query.style_id } : {}),
    ...(typeof query.object_id === "string" ? { objectId: query.object_id } : {}),
    ...(typeof query.text === "string" ? { text: query.text } : {}),
    ...(typeof query.text_offset === "number" ? { textOffset: query.text_offset } : {}),
    ...(typeof query.text_limit === "number" ? { textLimit: query.text_limit } : {}),
    ...(typeof query.paragraph_ref === "string" ? { paragraphRef: query.paragraph_ref } : {}),
    ...(typeof query.part === "string" ? { part: query.part } : {}),
    ...(Array.isArray(query.path)
      ? { path: query.path.filter((item): item is number => Number.isInteger(item)) }
      : {}),
    ...(typeof query.namespace_uri === "string" ? { namespaceUri: query.namespace_uri } : {}),
    ...(typeof query.local_name === "string" ? { localName: query.local_name } : {}),
    ...(typeof attribute.local_name === "string"
      ? {
          attribute: {
            localName: attribute.local_name,
            ...(typeof attribute.namespace_uri === "string"
              ? { namespaceUri: attribute.namespace_uri }
              : {}),
            ...(typeof attribute.value === "string" ? { value: attribute.value } : {}),
          },
        }
      : {}),
    ...(typeof query.offset === "number" ? { offset: query.offset } : {}),
    ...(typeof query.limit === "number" ? { limit: query.limit } : {}),
  };
}

function docxRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function continuationForTool(
  continuation: DocxReadContinuation | Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (continuation === undefined || continuation === null) return continuation;
  const value = continuation as Record<string, unknown>;
  const field = (camel: string, snake: string) => value[camel] ?? value[snake];
  return {
    ...(field("sessionId", "session_id")
      ? { session_id: field("sessionId", "session_id") } : {}),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    expected_revision: field("expectedRevision", "expected_revision"),
    ...(field("textOffset", "text_offset") === undefined
      ? {} : { text_offset: field("textOffset", "text_offset") }),
    ...(field("textLimit", "text_limit") === undefined
      ? {} : { text_limit: field("textLimit", "text_limit") }),
    ...(field("atomOffset", "atom_offset") === undefined
      ? {} : { atom_offset: field("atomOffset", "atom_offset") }),
    ...(field("payloadOffset", "payload_offset") === undefined
      ? {} : { payload_offset: field("payloadOffset", "payload_offset") }),
  };
}

export function docxReadForTool(result: DocxDocumentRead): Record<string, unknown> {
  const { nextQuery, paragraphs, ...rest } = result;
  return {
    ...rest,
    next_query: continuationForTool(nextQuery),
    paragraphs: paragraphs.map((paragraph) => {
      const { atoms, ...paragraphRest } = paragraph;
      return {
        ...paragraphRest,
        atoms: atoms.map((atom) => {
          const { payloadContinuation, ...atomRest } = atom;
          return {
            ...atomRest,
            ...(payloadContinuation === undefined
              ? {}
              : { payload_continuation: continuationForTool(payloadContinuation) }),
          };
        }),
      };
    }),
  };
}

const MAX_REPLACEMENTS = 100_000;
const textEncoder = new TextEncoder();

function mutationSizeError(content: string): string | null {
  if (content.length > MAX_MUTATION_BYTES || textEncoder.encode(content).byteLength > MAX_MUTATION_BYTES) {
    return `File content exceeds the ${MAX_MUTATION_BYTES / (1024 * 1024)} MiB write limit.`;
  }
  return null;
}

function occurrenceCount(text: string, needle: string, replaceAll: boolean): number {
  const first = text.indexOf(needle);
  if (first < 0) return 0;
  if (!replaceAll) return 1;
  let count = 0;
  let at = first;
  while (at >= 0) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

const declined = (tool: string) => ({
  message: "The user declined this change.",
  declined: true as const,
  status: "declined" as const,
  tool,
});

function positiveInteger(
  value: unknown,
  name: string,
): number | { error: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { error: `${name} must be a whole number of 1 or more` };
  }
  return value;
}

function mutationGuards(host: AiToolsHost, mutationAllowedOpt?: () => boolean) {
  const pid = () => host.getProjectId();
  const mutationAllowed = () => mutationAllowedOpt?.() ?? true;
  const assertMutationAllowed = (projectId: string) => {
    if (pid() !== projectId || !mutationAllowed()) {
      throw new Error("Project changed or the external request was cancelled before mutation.");
    }
  };
  const prepareMutation = async (projectId: string) => {
    assertMutationAllowed(projectId);
    const generation = await host.prepareExternalMutation(projectId);
    assertMutationAllowed(projectId);
    return generation;
  };
  return { pid, mutationAllowed, assertMutationAllowed, prepareMutation };
}

export function createOleaflyTools(
  host: AiToolsHost,
  opts?: {
    confirm?: ConfirmFn;
    onImage?: (dataUrl: string) => void;
    mutationAllowed?: () => boolean;
    resolveExecCwd?: (projectId: string) => Promise<string>;
    authorizeExec?: (
      projectId: string,
      command: string,
      runIdOverride?: string,
    ) => Promise<ExecAuthorization>;
    execCommand?: (
      projectId: string,
      command: string,
      authorization: ExecAuthorization,
    ) => Promise<{
      command: string;
      output: string;
      exit_code: number | null;
      status: string;
      truncated: boolean;
      timed_out: boolean;
    }>;
  },
) {
  const confirm = opts?.confirm;
  const onImage = opts?.onImage;
  const {
    readFileContent,
    writeFileContent,
    createFile: apiCreateFile,
    deleteFile: apiDeleteFile,
    renameFile: apiRenameFile,
    setMainDoc: setMainDocCmd,
    listFiles,
    searchProject,
    extractPdfText,
  } = host;
  const { pid, mutationAllowed, assertMutationAllowed, prepareMutation } = mutationGuards(
    host,
    opts?.mutationAllowed,
  );
  const approveStateMutation = async (tool: string, summary: string): Promise<boolean> => {
    if (!opts?.mutationAllowed) return true;
    const projectId = pid();
    if (!projectId) throw new Error("No project open");
    if (confirm && !(await confirm({ tool, summary }))) return false;
    assertMutationAllowed(projectId);
    return true;
  };

  const tools: Record<string, RawToolDef> = {
    spawn_agent: {
      description:
        "Delegate a task to a background agent. Task names form paths such as /root/task1/task_3. Built-in agents inherit your provider and model. Set providerId or modelId when a different selection is requested. For an ACP agent, set runtime to acp and use its configured agentId. ACP modelId must be offered by that agent. Built-in children share project tools and approval gates. ACP agents receive scoped research tools and request their own permissions. Delegation follows the configured depth limit. Use wait_agent to collect the answer.",
      inputSchema: {
        type: "object",
        properties: {
          task_name: {
            type: "string",
            description: "Short unique name for the task (alphanumeric, _ and -)",
          },
          prompt: {
            type: "string",
            description: "Complete, self-contained instructions for the subagent",
          },
          label: {
            type: "string",
            description: "Optional display name shown while it works",
          },
          runtime: {
            type: "string",
            enum: ["built-in", "acp"],
            description: "Agent runtime. Defaults to built-in",
          },
          providerId: {
            type: "string",
            description: "Configured provider for a built-in agent",
          },
          modelId: {
            type: "string",
            description: "Enabled provider model or a model offered by the ACP agent",
          },
          agentId: {
            type: "string",
            description: "Configured ACP agent ID. Required when runtime is acp",
          },
        },
        required: ["task_name", "prompt"],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    send_message: {
      description:
        "Send a message to a running built-in agent at its next message boundary. ACP agents must finish their current turn before receiving a followup_task.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent id or canonical task name" },
          message: { type: "string", description: "The message text" },
        },
        required: ["agent", "message"],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    followup_task: {
      description:
        "Continue an agent with a new task in the same session, keeping its runtime, provider and model. A running built-in agent receives the message at its next boundary. Wait for a running ACP agent to finish before continuing it.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent id or canonical task name" },
          message: { type: "string", description: "The new task" },
        },
        required: ["agent", "message"],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    wait_agent: {
      description:
        "Wait for the listed agents and return whichever finishes first, with a bounded view of its final answer. Prefer longer waits (minutes) over busy polling. Pass multiple ids to wait on whichever finishes first.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Agent ids to wait on (omitting waits on all)",
          },
          timeout_ms: { type: "number", description: "Optional wait window in milliseconds" },
          max_output_chars: {
            type: "number",
            description: "Optional character budget for the returned answer",
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    interrupt_agent: {
      description:
        "Interrupt an agent's current turn, if any. The agent stays available for messages and follow-up tasks.",
      inputSchema: {
        type: "object",
        properties: { agent: { type: "string" } },
        required: ["agent"],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    list_agents: {
      description:
        "List the live agents in this run with their canonical task paths and statuses. Optionally filter by task-path prefix.",
      inputSchema: {
        type: "object",
        properties: {
          path_prefix: { type: "string", description: "Canonical path prefix filter" },
        },
        required: [],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    close_agent: {
      description:
        "Close an agent when its work is done. Completed agents stay open and count toward the concurrency limit until closed, so close agents you no longer need.",
      inputSchema: {
        type: "object",
        properties: { agent: { type: "string" } },
        required: ["agent"],
        additionalProperties: false,
      },
      execute: () => Promise.resolve({ error: "subagents are only available in agentic runs" }),
    },
    read_file: {
      description:
        "Read a file in the current project. Prefer offset/limit for large files. Returns truncated content when over the size cap. Read another slice if needed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path, e.g. 'main.tex', 'main.typ', or 'sections/intro.tex'" },
          offset: {
            type: "number",
            description: "1-based line number to start reading (default 1)",
          },
          limit: {
            type: "number",
            description: "Max number of lines to return (default: all remaining, hard-capped)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const path = input.path as string;
        const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
        const limitRaw = input.limit != null ? Math.floor(Number(input.limit)) : null;
        const id = pid();
        if (!id) return { error: "No project open" };
        try {
          const full = await readFileContent(id, path);
          const lines = full.split("\n");
          const start = Math.min(offset - 1, lines.length);
          const maxLines = 800;
          const take = Math.min(limitRaw != null && limitRaw > 0 ? limitRaw : maxLines, maxLines);
          const slice = lines.slice(start, start + take);
          let content = slice.join("\n");
          const MAX_CHARS = 40_000;
          let truncated = start + slice.length < lines.length;
          if (content.length > MAX_CHARS) {
            content = content.slice(0, MAX_CHARS);
            truncated = true;
          }
          const legacy = content.includes("\uFFFD");
          return {
            path,
            offset,
            lines_returned: slice.length,
            total_lines: lines.length,
            truncated,
            ...(legacy
              ? {
                  encoding: "lossy-utf8" as const,
                  encoding_note:
                    "This file contains bytes outside UTF-8 (likely a legacy encoding like Latin-1); unreadable characters appear as \uFFFD. Do not rewrite the whole file from this read — edit only the exact lines you must change.",
                }
              : {}),
            content,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    write_file: {
      description:
        "Write or overwrite a file in the current project. Use for editing document source, adding content, or fixing issues.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path" },
          content: {
            type: "string",
            maxLength: MAX_MUTATION_BYTES,
            description: "The full file content to write",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { path, content } = input as { path: string; content: string };
        const id = pid();
        if (!id) return { error: "No project open" };
        try {
          const sizeError = mutationSizeError(content);
          if (sizeError) return { error: sizeError };
          let expectedGeneration: number;
          if (confirm) {
            await prepareMutation(id);
            const oldText = await readFileContent(id, path).catch(() => "");
            if (!(await confirm({
              tool: "write_file",
              summary: `Write ${path}`,
              path,
              diff: { path, oldText, newText: content },
            }))) {
              return declined("write_file");
            }
            expectedGeneration = await prepareMutation(id);
            const latest = await readFileContent(id, path).catch(() => "");
            if (latest !== oldText) {
              return { error: `${path} changed while approval was pending. Review and retry.` };
            }
            assertMutationAllowed(id);
          } else {
            expectedGeneration = await prepareMutation(id);
          }
          await writeFileContent(id, path, content, expectedGeneration);
          if (!host.applyExternalWrite(id, path, content)) {
            return {
              error: `${path} changed locally while the external write was running. The local edit was preserved. Review and retry.`,
              conflict: true,
            };
          }
          return { success: true, path, bytes: content.length };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    replace_in_file: {
      description:
        "Replace occurrences of an exact string in a file. Prefer this over write_file for small, precise source fixes. Set replace_all=true to replace every occurrence. Fails if the find string is not present.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path" },
          find: {
            type: "string",
            minLength: 1,
            description: "Exact string to search for (verbatim, including backslashes)",
          },
          replace: {
            type: "string",
            maxLength: MAX_MUTATION_BYTES,
            description: "String to replace it with",
          },
          replace_all: { type: "boolean", description: "Replace every occurrence (default: false - first only)", default: false },
        },
        required: ["path", "find", "replace"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { path, find, replace, replace_all } = input as {
          path: string; find: string; replace: string; replace_all?: boolean;
        };
        const id = pid();
        if (!id) return { error: "No project open" };
        if (!find) return { error: "find must not be empty" };
        try {
          await prepareMutation(id);
          const original = await readFileContent(id, path);
          const count = occurrenceCount(original, find, !!replace_all);
          if (count === 0) {
            return { error: "find string not found in file", path };
          }
          const outputChars = original.length + count * (replace.length - find.length);
          if (!Number.isSafeInteger(outputChars) || outputChars > MAX_MUTATION_BYTES) {
            return { error: `Replacement output exceeds the ${MAX_MUTATION_BYTES / (1024 * 1024)} MiB write limit.` };
          }
          if (count > MAX_REPLACEMENTS) {
            return { error: `Replacement count exceeds the ${MAX_REPLACEMENTS.toLocaleString()} operation limit.` };
          }
          const idx = original.indexOf(find);
          const updated = replace_all
            ? original.replaceAll(find, () => replace)
            : original.slice(0, idx) + replace + original.slice(idx + find.length);
          const sizeError = mutationSizeError(updated);
          if (sizeError) return { error: sizeError };
          if (confirm && !(await confirm({
            tool: "replace_in_file",
            summary: `Edit ${path}`,
            path,
            diff: { path, oldText: original, newText: updated },
          }))) {
            return declined("replace_in_file");
          }
          const expectedGeneration = await prepareMutation(id);
          const latest = await readFileContent(id, path);
          if (latest !== original) {
            return { error: `${path} changed while approval was pending. Review and retry.` };
          }
          assertMutationAllowed(id);
          await writeFileContent(id, path, updated, expectedGeneration);
          if (!host.applyExternalWrite(id, path, updated)) {
            return {
              error: `${path} changed locally while the external edit was running. The local edit was preserved. Review and retry.`,
              conflict: true,
            };
          }
          return { success: true, path, replacements: count };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    create_file: {
      description: "Create a new file or folder in the current project.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path for the new file or folder" },
          is_dir: { type: "boolean", description: "True to create a folder", default: false },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { path, is_dir } = input as { path: string; is_dir?: boolean };
        const id = pid();
        if (!id) return { error: "No project open" };
        const summary = is_dir ? `Create folder ${path}` : `Create file ${path}`;
        if (confirm && !(await confirm({ tool: "create_file", summary, path }))) {
          return declined("create_file");
        }
        try {
          const expectedGeneration = await prepareMutation(id);
          await apiCreateFile(id, path, is_dir ?? false, expectedGeneration);
          await host.refreshTree(id);
          return { success: true, path, is_dir: is_dir ?? false };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    rename_file: {
      description: "Rename or move a file/folder to a new path.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Current project-relative path" },
          to: { type: "string", description: "New project-relative path" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { from, to } = input as { from: string; to: string };
        const id = pid();
        if (!id) return { error: "No project open" };
        if (confirm && !(await confirm({ tool: "rename_file", summary: `Rename ${from} → ${to}`, path: from }))) {
          return declined("rename_file");
        }
        try {
          const expectedGeneration = await prepareMutation(id);
          await apiRenameFile(id, from, to, expectedGeneration);
          if (!host.applyExternalRename(id, from, to)) {
            return { error: "Project changed while the rename was running.", conflict: true };
          }
          return { success: true, from, to };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    delete_file: {
      description: "Delete a file or folder from the current project.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path of the file/folder to delete" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const path = input.path as string;
        const id = pid();
        if (!id) return { error: "No project open" };
        if (confirm && !(await confirm({ tool: "delete_file", summary: `Delete ${path}`, path }))) {
          return declined("delete_file");
        }
        try {
          const expectedGeneration = await prepareMutation(id);
          await apiDeleteFile(id, path, expectedGeneration);
          if (!host.applyExternalDelete(id, path)) {
            return {
              error: `${path} changed locally while deletion was running. Unsaved local edits were restored. Review and retry.`,
              conflict: true,
            };
          }
          return { success: true, path };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    compile: {
      description:
        "Compile the current document project to PDF with its selected engine. Persists the active editor file first, runs the build, and returns the outcome. Always check `success` and `errors`. If errors remain, read them, fix the file, then compile again until success is true.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        try {
          const result = await host.recompile();
          const log = result?.log ?? "";
          return {
            success: result?.ok ?? false,
            errors: result?.errors ?? [],
            has_pdf: result?.has_pdf ?? false,
            log_tail: log.slice(-4000),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    get_log: {
      description:
        "Return the full document-engine compile log from the last compile. Use this when `compile` reports errors and you need surrounding context to diagnose them.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        const log = host.getCompileLog();
        if (!log) return { error: "No compile log yet. Run compile first." };
        return { log: log.slice(-20000) };
      },
    },

    get_pdf_text: {
      description:
        "Extract and return the text content of the last compiled PDF, page by page. Use to verify the rendered output (e.g. confirm a section, name, or link appears correctly).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        const bytes = host.getPdfBytes();
        if (!bytes) return { error: "No PDF available. Run compile first." };
        try {
          const { pages, numPages } = await extractPdfText(bytes);
          const body = pages
            .map((t, i) => `--- Page ${i + 1}/${numPages} ---\n${t.slice(0, 2000)}`)
            .join("\n\n");
          return { numPages, text: body.slice(0, 20000) };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    set_main_doc: {
      description: "Set the project's main document (the compile entry point, e.g. main.tex, main.typ, or main.md). Execution follows the active approval policy.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path of the new main document" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const path = input.path as string;
        const id = pid();
        if (!id) return { error: "No project open" };
        if (confirm && !(await confirm({
          tool: "set_main_doc",
          summary: `Set main document to ${path}`,
          path,
        }))) {
          return declined("set_main_doc");
        }
        try {
          await prepareMutation(id);
          const meta = await setMainDocCmd(id, path);
          return { success: true, main_doc: meta.main_doc };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    search_project: {
      description:
        "Search the CURRENT project's documents for a query string. Returns matching lines with file paths and line numbers. For broader topical retrieval of source chunks, relevant excerpts are also auto-injected each turn via project RAG.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The text to search for" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const query = input.query as string;
        const id = pid();
        if (!id) return { error: "No project open" };
        try {
          const hits = await searchProject(id, query);
          return { results: hits, total: hits.length };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    list_files: {
      description: "List all files in the current project tree (read fresh from disk).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        const id = pid();
        if (!id) return { error: "No project open" };
        try {
          const files = await listFiles(id);
          return { files };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    toggle_theme: {
      description: "Toggle the app between light and dark mode.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        try {
          if (!(await approveStateMutation("toggle_theme", "Toggle the application theme"))) {
            return declined("toggle_theme");
          }
          if (!mutationAllowed()) return { error: "The external request was cancelled before mutation." };
          window.dispatchEvent(new CustomEvent("oleafly:toggle-theme"));
          return { success: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    show_location: {
      description:
        "Reveal a project file at a line in the editor and, when SyncTeX is available, move the PDF preview to that spot. With only a page number, jump the PDF preview to that page.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative path of the file to reveal",
          },
          line: {
            type: "integer",
            minimum: 1,
            description: "1-based line in that file",
          },
          page: {
            type: "integer",
            minimum: 1,
            description: "1-based PDF page to show",
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (input) => {
        try {
          const rawPath = input.path;
          const rawLine = input.line;
          const rawPage = input.page;
          if (rawPath !== undefined && typeof rawPath !== "string") {
            return { error: "path must be a string" };
          }
          const path = typeof rawPath === "string" ? rawPath.trim() : undefined;
          const line = positiveInteger(rawLine, "line");
          if (line !== undefined && typeof line !== "number") return line;
          const page = positiveInteger(rawPage, "page");
          if (page !== undefined && typeof page !== "number") return page;
          if (!path && page === undefined) {
            return { error: "Pass a path to reveal in the editor, a page to show in the PDF, or both." };
          }
          if (!host.revealLocation) {
            return { error: "This window has no editor or preview to reveal a location in." };
          }
          const target: RevealLocationTarget = {
            ...(path ? { path } : {}),
            ...(typeof line === "number" ? { line } : {}),
            ...(typeof page === "number" ? { page } : {}),
          };
          const result = await host.revealLocation(target);
          if (!result.revealed) {
            return { error: result.note ?? "Could not reveal that location." };
          }
          return {
            success: true,
            revealed: true,
            ...target,
            ...(result.note ? { note: result.note } : {}),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    project_map: {
      description:
        "Get a structural map of the whole project: the section outline, labels, citation keys, macros, theorem and glossary names, included/imported files, and unresolved links. Typst @key uses are reported as ambiguous because the syntax can mean either a label reference or a citation. Call this before cross-cutting edits.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        const index = await host.getProjectIndex();
        if (!index) return { error: "No project open" };
        return projectMapFromIndex(index);
      },
    },

    update_todos: {
      description:
        "Create or replace the agent's plan checklist for this session. Use for multi-step work: set items to pending, mark the current one in_progress, complete items as you go. Keeps the user oriented.",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Full replacement list of todo items",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable id for this item" },
                content: { type: "string", description: "Short task description" },
                status: {
                  type: "string",
                  description: "pending | in_progress | completed | cancelled",
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
      execute: async (input) => {
        if (!(await approveStateMutation("update_todos", "Replace the agent checklist"))) {
          return declined("update_todos");
        }
        const raw = (input.todos as { id: string; content: string; status: string }[]) ?? [];
        const allowed = new Set(["pending", "in_progress", "completed", "cancelled"]);
        const todos = raw
          .filter((t) => t?.id && t.content)
          .slice(0, 30)
          .map((t) => ({
            id: String(t.id).slice(0, 64),
            content: String(t.content).slice(0, 240),
            status: allowed.has(t.status) ? t.status : "pending",
          }));
        host.setAgentTodos(todos);
        return { success: true, count: todos.length, todos };
      },
    },

    get_todos: {
      description: "Read the current agent plan checklist (from update_todos).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => ({ todos: host.getAgentTodos() }),
    },

    remember_note: {
      description:
        "Save a short sticky note about this project for future agent turns (conventions, decisions, preferences). Use sparingly for durable facts the user would want remembered.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Note text for short, durable project knowledge" },
        },
        required: ["content"],
        additionalProperties: false,
      },
      execute: async (input) => {
        if (!(await approveStateMutation("remember_note", "Save a project memory note"))) {
          return declined("remember_note");
        }
        return host.rememberNote(String((input.content as string | undefined) ?? ""));
      },
    },

    forget_note: {
      description: "Remove a sticky project note by id (from remember_note / list_notes).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note id" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (input) => {
        if (!(await approveStateMutation("forget_note", "Remove a project memory note"))) {
          return declined("forget_note");
        }
        return host.forgetNote(String((input.id as string | undefined) ?? ""));
      },
    },

    list_notes: {
      description: "List sticky project memory notes saved with remember_note.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => ({ notes: host.listNotes() }),
    },

    verify_pdf_pages: {
      description:
        "After a successful compile, inspect rendered PDF pages for layout issues (overflow, cut-off text, empty regions). Vision models receive page PNGs. Text-only models get page text excerpts. Prefer after structural edits. Respects the user setting that allows PDF page capture.",
      inputSchema: {
        type: "object",
        properties: {
          pages: {
            type: "array",
            items: { type: "number" },
            description: "Optional 1-based page numbers (default: first, last, and a few middle pages, max 4)",
          },
          max_pages: {
            type: "number",
            description: "Max pages to capture when pages is omitted (default 4, max 6)",
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (input) => {
        const projectId = pid();
        if (!projectId) return { error: "No project open" };
        if (!host.getAiPdfCaptureEnabled()) {
          return {
            error:
              "PDF page capture is disabled in Settings → AI Assistant. Enable “Allow PDF page capture for AI” or use get_pdf_text instead.",
            capture_disabled: true,
          };
        }
        const bytes = host.getPdfBytes();
        if (!bytes) return { error: "No PDF available. Run compile first (and ensure it succeeds)." };
        try {
          const { pages: pageTexts, numPages } = await extractPdfText(bytes);
          if (pid() !== projectId || !mutationAllowed()) {
            return { error: "The open project changed before PDF page verification finished." };
          }
          if (!numPages) return { error: "PDF has no pages." };
          const maxPages = Math.min(6, Math.max(1, Math.floor(Number(input.max_pages) || 4)));
          let selected: number[];
          if (Array.isArray(input.pages) && input.pages.length) {
            selected = [
              ...new Set(
                (input.pages as number[])
                  .map((p) => Math.floor(Number(p)))
                  .filter((p) => p >= 1 && p <= numPages),
              ),
            ]
              .sort((a, b) => a - b)
              .slice(0, maxPages);
          } else {
            const cursorPage = host.getPdfCursorPage?.() ?? undefined;
            selected = pickPagesToVerify(numPages, {
              cursorPage: cursorPage ?? undefined,
              maxPages,
            });
          }
          const images: { page: number; dataUrl: string }[] = [];
          for (const page of selected) {
            let dataUrl: string | null = null;
            try {
              dataUrl = await host.pdfToPng(bytes, page, 1.5);
            } catch {
              /* skip failed page raster */
            }
            if (pid() !== projectId || !mutationAllowed()) {
              return { error: "The open project changed before PDF page verification finished." };
            }
            if (dataUrl) images.push({ page, dataUrl });
          }
          if (onImage) {
            for (const img of images) onImage(img.dataUrl);
          }
          const text = selected
            .map((p) => {
              const t = pageTexts[p - 1] ?? "";
              return `--- Page ${p}/${numPages} ---\n${t.slice(0, 1500)}`;
            })
            .join("\n\n");
          return {
            success: true,
            numPages,
            pages: selected,
            images_captured: images.length,
            text: text.slice(0, 12000),
            note:
              images.length > 0
                ? "Page images were attached for vision models. Inspect for overflow, cut-off text, and empty regions."
                : "No images captured. Inspect text excerpts only.",
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },
  };

  if (opts?.execCommand && opts.resolveExecCwd && opts.authorizeExec) {
    const execCommand = opts.execCommand;
    const resolveExecCwd = opts.resolveExecCwd;
    const authorizeExec = opts.authorizeExec;
    tools.run_command = {
      description:
        "Run a shell command in the current project directory and return its output and exit status. Use for build tooling, git, file inspection, or scripts the dedicated tools do not cover. Execution follows the active approval policy.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "A single shell command line, run from the project root",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const command = String((input.command as string | undefined) ?? "").trim();
        if (!command) return { error: "command is required" };
        const projectId = pid();
        if (!projectId) return { error: "No project open" };
        if (!confirm) return { ...declined("run_command"), command };
        const ownerOverride =
          typeof input.__execOwner === "string" ? input.__execOwner : undefined;
        try {
          const cwd = await resolveExecCwd(projectId);
          assertMutationAllowed(projectId);
          if (!(await confirm({
            tool: "run_command",
            summary: `$ ${command}`,
            projectId,
            command,
            cwd,
          }))) {
            return { ...declined("run_command"), command };
          }
          await prepareMutation(projectId);
          const authorization = await authorizeExec(projectId, command, ownerOverride);
          assertMutationAllowed(projectId);
          let result: Awaited<ReturnType<typeof execCommand>>;
          try {
            result = await execCommand(projectId, command, authorization);
          } finally {
            host.refreshOpenFiles?.(projectId);
          }
          return {
            exec: true,
            command: result.command,
            exit_code: result.exit_code,
            status: result.status,
            timed_out: result.timed_out,
            truncated: result.truncated,
            output: result.output,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    };
  }

  return tools;
}

export function createDocxTools(
  host: DocxToolsHost,
  opts?: DocxToolsOptions,
) {
  const context: DocxOperationContext | undefined =
    opts?.attribution || opts?.signal || opts?.onToken
      ? {
          ...(opts.attribution
            ? { attribution: Object.freeze({ ...opts.attribution }) }
            : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onToken ? { onToken: opts.onToken } : {}),
        }
      : undefined;
  const mutationAllowed = () => opts?.mutationAllowed?.() ?? true;
  const cancelled = () => ({
    error: "The external request was cancelled before mutation.",
  });
  const unavailableOrError = (error: unknown) => {
    const message = String(error).replace(/^Error: /, "");
    return message.includes("unavailable")
      ? { unavailable: true as const, error: message }
      : { error: String(error) };
  };
  const stringField = (input: Record<string, unknown>, name: string): string =>
    typeof input[name] === "string" ? input[name] : "";
  const optionalString = (input: Record<string, unknown>, name: string): string | undefined => {
    const value = stringField(input, name);
    return value || undefined;
  };

  return {
    get_docx_workspace_context: {
      description: "Read the material currently being viewed and its selection separately from writable live Word sessions. Historical selections are reference evidence, never implicit write targets. Refresh before acting on 'this' or 'here'.",
      inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        if (!host.workspaceContext) return { unavailable: true, error: "DOCX workspace context is unavailable." };
        try { return await host.workspaceContext(); } catch (error) { return { error: String(error) }; }
      },
    },
    reveal_docx_working_copy: {
      description: "Request that the product show the writable Word working copy and optionally locate a current paragraph. Uses the existing navigation/follow state; when following is paused the target is queued until the user resumes. This does not edit or save.",
      inputSchema: { type: "object" as const, properties: {
        session_id: DOCX_SESSION_SCHEMA,
        paragraph_ref: { type: "string", minLength: 1 },
        expected_revision: { type: "integer", minimum: 0 },
      }, required: [], additionalProperties: false },
      execute: async (input: Record<string, unknown>) => {
        if (!host.revealWorkingCopy) return { unavailable: true, error: "Word navigation is unavailable." };
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const expectedRevision = input.expected_revision === undefined ? undefined : docxRevision(input.expected_revision);
          if (expectedRevision === null) throw new Error("expected_revision must be a non-negative session revision.");
          if (input.paragraph_ref && expectedRevision === undefined) throw new Error("Locating a paragraph requires its expected_revision.");
          return await host.revealWorkingCopy({ sessionId: optionalString(input, "session_id"),
            paragraphRef: optionalString(input, "paragraph_ref"), ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        } catch (error) { return { error: String(error) }; }
      },
    },
    prepare_docx_fonts: {
      description: "Refresh the bound Word session through the product's existing font service and return actual font resolution and measurement status. An available family or completed refresh does not by itself mean every face is ready or journal requirements pass.",
      inputSchema: { type: "object" as const, properties: { session_id: DOCX_SESSION_SCHEMA }, required: [], additionalProperties: false },
      execute: async (input: Record<string, unknown>) => {
        if (!host.prepareFonts) return { unavailable: true, error: "Word font preparation is unavailable." };
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        const sessionId = optionalString(input, "session_id");
        if (opts?.confirm && !(await opts.confirm({
          tool: "prepare_docx_fonts",
          summary: sessionId
            ? `Refresh fonts for DOCX session ${sessionId}`
            : "Refresh fonts for the active Word working copy",
          ...(sessionId ? { path: `DOCX#${sessionId}` } : {}),
        }))) return declined("prepare_docx_fonts");
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const result = await host.prepareFonts(sessionId);
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          return result;
        } catch (error) { return unavailableOrError(error); }
      },
    },
    export_docx_document: {
      description: "Export the current live Word working copy through the same download operation as the user. Returns the exported session revision and output receipt. Export does not save a Workbench baseline or run a check.",
      inputSchema: { type: "object" as const, properties: { session_id: DOCX_SESSION_SCHEMA }, required: [], additionalProperties: false },
      execute: async (input: Record<string, unknown>) => {
        if (!host.exportDocument) return { unavailable: true, error: "Word export is unavailable." };
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        const sessionId = optionalString(input, "session_id");
        if (opts?.confirm && !(await opts.confirm({
          tool: "export_docx_document",
          summary: sessionId
            ? `Export DOCX session ${sessionId}`
            : "Export the active Word working copy",
          ...(sessionId ? { path: `DOCX#${sessionId}` } : {}),
        }))) return declined("export_docx_document");
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const result = await host.exportDocument(sessionId);
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          return result;
        } catch (error) { return unavailableOrError(error); }
      },
    },
    list_docx_documents: {
      description:
        "List active Oleafly DOCX working copies. Session revision, saved revision, dirty state and the Workbench baseline are distinct.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        try {
          return { documents: await host.listDocuments() };
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    read_docx_document: {
      description:
        "Read a bounded page from the live DOCX. `text` is display text; ranges use whole-paragraph `modelText` UTF-16 offsets. Every paragraph carries the exact route for continuing its own modelText window, so keep those offsets in that paragraph. Math payloads report readableMath and diagnostics rather than an image. Drawing objects and fields whose payload contains one embedded-image route remain opaque metadata here; call read_docx_image with the attached paragraph_ref, object_ref and expected_revision to receive their actual pixels. Continue metadata or a long payload with next_query and the returned continuation fields.",
      inputSchema: {
        type: "object" as const,
        properties: DOCX_READ_QUERY_SCHEMA,
        required: [],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        try {
          const offset = input.offset === undefined ? 0 : Number(input.offset);
          const limit = input.limit === undefined ? 20 : Number(input.limit);
          if (!Number.isInteger(offset) || offset < 0)
            throw new Error("DOCX read offset must be a non-negative integer.");
          if (!Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new Error("Read one to fifty DOCX paragraphs per page.");
          const expectedRevision = input.expected_revision === undefined
            ? undefined : docxRevision(input.expected_revision);
          if (expectedRevision === null)
            throw new Error("expected_revision must be a non-negative session revision.");
          const textOffset = input.text_offset === undefined ? undefined : Number(input.text_offset);
          const textLimit = input.text_limit === undefined ? undefined : Number(input.text_limit);
          const atomOffset = input.atom_offset === undefined ? undefined : Number(input.atom_offset);
          const payloadOffset = input.payload_offset === undefined ? undefined : Number(input.payload_offset);
          if (textOffset !== undefined && (!Number.isInteger(textOffset) || textOffset < 0))
            throw new Error("text_offset must be a non-negative UTF-16 offset.");
          if (textLimit !== undefined && (!Number.isInteger(textLimit) || textLimit < 1 || textLimit > 8000))
            throw new Error("text_limit must contain one to eight thousand UTF-16 units.");
          if ((textOffset === undefined) !== (textLimit === undefined))
            throw new Error("text_offset and text_limit must be supplied together.");
          if (atomOffset !== undefined && (!Number.isInteger(atomOffset) || atomOffset < 0))
            throw new Error("atom_offset must be a non-negative atom index.");
          if (payloadOffset !== undefined && (!Number.isInteger(payloadOffset) || payloadOffset < 0))
            throw new Error("payload_offset must be a non-negative UTF-16 offset.");
          if (atomOffset !== undefined && textOffset === undefined)
            throw new Error("atom_offset requires text_offset and text_limit.");
          if (payloadOffset !== undefined && atomOffset === undefined)
            throw new Error("payload_offset requires atom_offset.");
          const sessionId = optionalString(input, "session_id");
          const result = await host.readDocument({
            ...(sessionId ? { sessionId } : {}),
            offset, limit,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            ...(textOffset === undefined ? {} : { textOffset, textLimit }),
            ...(atomOffset === undefined ? {} : { atomOffset }),
            ...(payloadOffset === undefined ? {} : { payloadOffset }),
          });
          const modelResult = docxReadForTool(result);
          const serialized = JSON.stringify(modelResult);
          if (serialized.length > DOCX_READ_MAX_CHARS)
            throw new Error(`The DOCX read page exceeds the ${DOCX_READ_MAX_CHARS}-character transport budget.`);
          return modelResult;
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    read_docx_image: {
      description:
        "Read the current embedded raster image referenced by one DrawingML or VML drawing, or by a field whose payload contains one embedded-image route, in the live DOCX. Use exactly the read_docx_image route attached in read_docx_document; arbitrary media paths and external images are refused. The response contains document/source identity and image metadata while the actual PNG, JPEG or GIF pixels travel through the tool's image channel for visual inspection. This does not edit, save or export the document.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          paragraph_ref: {
            type: "string",
            minLength: 1,
            description: "The paragraph_ref attached to the drawing's read_docx_image route.",
          },
          object_ref: {
            type: "string",
            minLength: 1,
            description: "The drawing or field object_ref whose route requested this image.",
          },
          expected_revision: {
            type: "integer",
            minimum: 0,
            description: "The exact drawing-route revision in this live DOCX session.",
          },
        },
        required: ["paragraph_ref", "object_ref", "expected_revision"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.readImage) {
          return { unavailable: true, error: "Live DOCX image reading is unavailable." };
        }
        if (!opts?.onImage) {
          return { unavailable: true, error: "The active Agent transport cannot receive DOCX images." };
        }
        if (opts.imageSupported === false) {
          return { error: "The active model does not accept image input. Use read_docx_document for text, math and drawing metadata." };
        }
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const paragraphRef = stringField(input, "paragraph_ref");
          const objectRef = stringField(input, "object_ref");
          const expectedRevision = docxRevision(input.expected_revision);
          if (!paragraphRef) throw new Error("paragraph_ref is required.");
          if (!objectRef) throw new Error("object_ref is required.");
          if (expectedRevision === null) {
            throw new Error("expected_revision must be a non-negative session revision.");
          }
          const sessionId = optionalString(input, "session_id");
          const request: DocxImageReadRequest = {
            paragraphRef,
            objectRef,
            expectedRevision,
          };
          const result = await host.readImage(sessionId, request);
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          const image = docxImageForTool(result, request, sessionId);
          opts.onImage(image.dataUrl);
          return image.metadata;
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    replace_docx_text_range: {
      description:
        "Replace one ordinary text range in the live DOCX. range and expected_text use whole-paragraph modelText UTF-16 offsets. It refuses fields, equations, drawings, notes, formatting/container boundaries and stale revisions; the change is one undoable edit and does not save.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          paragraph_ref: { type: "string", minLength: 1 },
          expected_revision: { type: "integer", minimum: 0 },
          range: DOCX_MODEL_RANGE_SCHEMA,
          expected_text: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["paragraph_ref", "expected_revision", "range", "expected_text", "replacement"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.replaceTextRange)
          return { unavailable: true, error: "Safe DOCX text-range editing is unavailable." };
        if (!mutationAllowed()) return cancelled();
        if (context?.signal?.aborted) return cancelled();
        try {
          const paragraphRef = stringField(input, "paragraph_ref");
          const expectedRevision = docxRevision(input.expected_revision);
          const range = input.range as DocxModelRange | undefined;
          if (!paragraphRef) throw new Error("paragraph_ref is required.");
          if (expectedRevision === null)
            throw new Error("expected_revision must be a non-negative session revision.");
          if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
              range.start < 0 || range.end <= range.start)
            throw new Error("range must use integer UTF-16 offsets with 0 <= start < end.");
          if (typeof input.expected_text !== "string" || typeof input.replacement !== "string")
            throw new Error("expected_text and replacement must be strings.");
          if (input.expected_text === input.replacement)
            throw new Error("The replacement is unchanged.");
          const sessionId = optionalString(input, "session_id");
          const request: DocxTextRangeReplaceRequest = {
            ...(sessionId ? { sessionId } : {}),
            paragraphRef, expectedRevision, range,
            expectedText: input.expected_text,
            replacement: input.replacement,
          };
          if (opts?.confirm && !(await opts.confirm({
            tool: "replace_docx_text_range",
            summary: `Replace text in DOCX paragraph ${paragraphRef}`,
            path: `DOCX#${paragraphRef}`,
            diff: { path: `DOCX#${paragraphRef}`, oldText: input.expected_text, newText: input.replacement },
          }))) return {
            message: "The user declined this change.", declined: true as const,
            status: "declined" as const, tool: "replace_docx_text_range",
          };
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          return await host.replaceTextRange(request, context);
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    capture_docx_target: {
      description:
        "Capture one paragraph from an active DOCX session as a stable suggestion target. The returned target ID is scoped to this app session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          paragraph_ref: {
            type: "string",
            description: "Paragraph reference returned by read_docx_document.",
          },
        },
        required: ["paragraph_ref"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        try {
          return await host.captureTarget(
            optionalString(input, "session_id"),
            stringField(input, "paragraph_ref"),
          );
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    suggest_docx_change: {
      description:
        "Generate a whole-paragraph replacement for an active DOCX target without changing the document. The returned target must be applied with apply_docx_suggestion.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "Session ID from list_docx_documents. Omit for the active session.",
          },
          paragraph_ref: {
            type: "string",
            description: "Paragraph reference returned by read_docx_document.",
          },
          instruction: {
            type: "string",
            description: "The requested prose change.",
          },
          expected_revision: {
            type: "number",
            description: "Optional paragraph revision returned by capture_docx_target.",
          },
        },
        required: ["paragraph_ref", "instruction"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!mutationAllowed()) return cancelled();
        try {
          return await host.suggestChange(
            {
              ...(optionalString(input, "session_id")
                ? { sessionId: optionalString(input, "session_id") }
                : {}),
              paragraphRef: stringField(input, "paragraph_ref"),
              instruction: stringField(input, "instruction"),
              ...(typeof input.expected_revision === "number"
                ? { expectedRevision: input.expected_revision }
                : {}),
            },
            context,
          );
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    write_docx_equation: {
      description: "Compile one LaTeX equation body with explicit math macro declarations and write editable Word math. Insert at a modelText UTF-16 offset, or replace one current math object using its object_ref and exact expected_fingerprint. Replacement and offset are mutually exclusive. Use adopt_source only to explicitly replace an equation whose source is absent or changed outside this source workflow. Whole documents, algorithms, labels and numbering commands are refused. Conversion losses are reported, and the document is not saved by this tool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          paragraph_ref: { type: "string", minLength: 1 },
          expected_revision: { type: "integer", minimum: 0 },
          latex: { type: "string", minLength: 1, maxLength: 16384 },
          macros: { type: "string", maxLength: 16384 },
          object_ref: { type: "string", minLength: 1 },
          expected_fingerprint: { type: "string", minLength: 1 },
          adopt_source: { type: "boolean" },
          offset: { type: "integer", minimum: 0 },
          display: { type: "boolean" },
        },
        required: ["paragraph_ref", "expected_revision", "latex"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.writeEquation) return { unavailable: true, error: "DOCX equation writing is unavailable." };
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const expectedRevision = docxRevision(input.expected_revision);
          const paragraphRef = stringField(input, "paragraph_ref");
          const latex = stringField(input, "latex");
          const objectRef = optionalString(input, "object_ref");
          const expectedFingerprint = optionalString(input, "expected_fingerprint");
          if (expectedRevision === null || !paragraphRef.trim() || !latex.trim()) throw new Error("Supply one equation body, its paragraph_ref and current non-negative expected_revision.");
          if (input.macros !== undefined && typeof input.macros !== "string" || latex.length + stringField(input, "macros").length > 16_384) throw new Error("The equation and explicit macro context must contain at most 16,384 characters.");
          if (objectRef ? !expectedFingerprint || input.offset !== undefined : !Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || input.expected_fingerprint !== undefined || input.adopt_source !== undefined) throw new Error("Replace with object_ref and expected_fingerprint, or insert at offset. Do not combine these addresses.");
          for (const name of ["adopt_source", "display"]) if (input[name] !== undefined && typeof input[name] !== "boolean") throw new Error(`${name} must be boolean.`);
          const request: DocxEquationWriteRequest = {
            ...(optionalString(input, "session_id") ? { sessionId: optionalString(input, "session_id") } : {}),
            paragraphRef, expectedRevision, latex,
            ...(input.macros === undefined ? {} : { macros: input.macros as string }),
            ...(objectRef ? { objectRef, expectedFingerprint, ...(input.adopt_source === undefined ? {} : { adoptSource: input.adopt_source as boolean }) } : { offset: Number(input.offset) }),
            ...(input.display === undefined ? {} : { display: input.display as boolean }),
          };
          if (opts?.confirm && !(await opts.confirm({
            tool: "write_docx_equation",
            summary: `${objectRef ? "Replace" : "Insert"} an editable Word equation at ${paragraphRef}`,
            diff: { path: paragraphRef, oldText: objectRef ? `Equation ${objectRef}, fingerprint ${expectedFingerprint}` : "", newText: JSON.stringify({ latex, macros: request.macros ?? "", display: request.display ?? (objectRef ? "retain existing placement" : false) }, null, 2) },
          }))) return declined("write_docx_equation");
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          return await host.writeEquation(request, context);
        } catch (error) { return unavailableOrError(error); }
      },
    },
    apply_docx_suggestion: {
      description:
        "Apply one whole-paragraph suggestion to the live DOCX session. This does not save a Workbench baseline. It refuses stale targets and paragraphs with complex inline structure.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_id: {
            type: "string",
            description: "Target ID returned by capture_docx_target or suggest_docx_change.",
          },
          expected_revision: {
            type: "number",
            description: "Target paragraph revision that the suggestion was based on.",
          },
          text: {
            type: "string",
            description: "The complete replacement text for the paragraph.",
          },
        },
        required: ["target_id", "expected_revision", "text"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!mutationAllowed()) return cancelled();
        try {
          const targetId = stringField(input, "target_id");
          const text = stringField(input, "text");
          const before = await host.inspectTarget(targetId);
          if (
            opts?.confirm &&
            !(await opts.confirm({
              tool: "apply_docx_suggestion",
              summary: `Apply a DOCX suggestion to ${before.filename} at ${before.paragraphRef}`,
              path: `${before.filename}#${before.paragraphRef}`,
              diff: {
                path: `${before.filename}#${before.paragraphRef}`,
                oldText: before.text,
                newText: text,
              },
            }))
          ) {
            return {
              message: "The user declined this change.",
              declined: true as const,
              status: "declined" as const,
              tool: "apply_docx_suggestion",
            };
          }
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          await host.inspectTarget(targetId);
          return await host.applySuggestion(
            {
              targetId,
              expectedRevision: Number(input.expected_revision),
              text,
            },
            context,
          );
        } catch (error) {
          return { error: String(error) };
        }
      },
    },
    read_docx_format: {
      description:
        "Read system-parsed DOCX text, structure, styles and effective formatting. Begin with kind overview for the directory and reading routes; continue paragraphs, styles or objects with nextOffset and the returned revision as query.expected_revision. If the revision changed, refresh the directory before continuing. Paragraphs include editable references and modelText for exact font ranges. Use nodes for XML diagnosis. Returns the live revision and exact export hash.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "Session ID from list_docx_documents. Omit for the active session.",
          },
          query: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["overview", "paragraphs", "styles", "objects", "nodes"] },
              expected_revision: { type: "integer", minimum: 0, description: "Live revision returned by the preceding page. Keeps continued reading on the same document revision." },
              object_kind: { type: "string" }, role: { type: "string" },
              style_id: { type: "string" }, object_id: { type: "string" }, text: { type: "string" },
              text_offset: { type: "integer", minimum: 0 }, text_limit: { type: "integer", minimum: 1, maximum: 16000 },
              paragraph_ref: { type: "string" }, part: { type: "string" },
              path: { type: "array", items: { type: "integer", minimum: 0 } },
              namespace_uri: { type: "string" }, local_name: { type: "string" },
              attribute: { type: "object", additionalProperties: false, required: ["local_name"], properties: {
                namespace_uri: { type: "string" }, local_name: { type: "string" }, value: { type: "string" },
              } },
              offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 },
            },
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.readFormat) {
          return { unavailable: true, error: "Live DOCX format reading is unavailable." };
        }
        try {
          return await host.readFormat(
            optionalString(input, "session_id"),
            docxFormatQuery(input.query),
          );
        } catch (error) {
          return unavailableOrError(error);
        }
      },
    },
    apply_docx_format: {
      description:
        "Apply formatting to a live DOCX paragraph, an exact font range, or its containing section, table, row or cell. A range uses system-provided modelText offsets. Supply the live revision. Scope defaults to paragraph; omitted fields stay unchanged. Styles must already exist. This does not save; use apply_docx_format_batch for an atomic group.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description: "Session ID from list_docx_documents. Omit for the active session.",
          },
          paragraph_ref: {
            type: "string",
            description: "Paragraph reference returned by read_docx_document or read_docx_format.",
          },
          expected_revision: {
            type: "number",
            description: "Session revision read before this format change.",
          },
          range: DOCX_RANGE_SCHEMA,
          font: DOCX_FONT_SCHEMA,
          paragraph: DOCX_PARAGRAPH_FORMAT_SCHEMA,
          ...DOCX_OBJECT_FORMAT_SCHEMAS,
        },
        required: ["paragraph_ref", "expected_revision"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!mutationAllowed()) return cancelled();
        if (context?.signal?.aborted) return cancelled();
        const expectedRevision = docxRevision(input.expected_revision);
        if (expectedRevision === null) {
          return { error: "expected_revision must be the non-negative session revision that was read." };
        }
        const font = input.font as DocxFontFormatWrite | undefined;
        const paragraph = input.paragraph as DocxParagraphFormatWrite | undefined;
        const paragraphRef = stringField(input, "paragraph_ref");
        const sessionId = optionalString(input, "session_id");
        try {
          const item = docxFormatItem(input);
          const objectFormat = item.objectFormat;
          if (item.range ? !host.formatBatch : objectFormat ? !host.formatObject : !host.formatParagraph) {
            return { unavailable: true, error: "Live DOCX formatting is unavailable for the requested scope." };
          }
          if (opts?.confirm) {
            if (!host.readFormat) {
              return {
                unavailable: true,
                error: "Format approval requires live DOCX formatting reads.",
              };
            }
            const before = await host.readFormat(sessionId, { paragraphRef });
            const oldFormat = objectFormat ? before.objects : before.paragraph
              ? { font: before.paragraph.font, paragraph: before.paragraph.paragraph }
              : {};
            if (!(await opts.confirm({
              tool: "apply_docx_format",
              summary: `Format a DOCX ${objectFormat?.kind ?? "paragraph"} in ${before.document.filename} at ${paragraphRef}`,
              path: `${before.document.filename}#${paragraphRef}`,
              diff: {
                path: `${before.document.filename}#${paragraphRef}`,
                oldText: JSON.stringify(oldFormat, null, 2),
                newText: JSON.stringify(item, null, 2),
              },
            }))) {
              return {
                message: "The user declined this format change.",
                declined: true as const,
                status: "declined" as const,
                tool: "apply_docx_format",
              };
            }
          }
          if (!mutationAllowed()) return cancelled();
          if (context?.signal?.aborted) return cancelled();
          if (item.range && host.formatBatch) return await host.formatBatch(sessionId, expectedRevision, [item], context);
          if (objectFormat && host.formatObject) {
            return await host.formatObject(sessionId, paragraphRef, expectedRevision, objectFormat, context);
          }
          return await host.formatParagraph!(
            sessionId,
            paragraphRef,
            expectedRevision,
            { ...(font ? { font } : {}), ...(paragraph ? { paragraph } : {}) },
            context,
          );
        } catch (error) {
          return unavailableOrError(error);
        }
      },
    },
    apply_docx_format_batch: {
      description:
        "Apply a group of DOCX format operations as one atomic transaction and one undo step at expected_revision. If any operation is invalid nothing changes. Use exact paragraph references; optional font ranges use modelText UTF-16 offsets returned by read_docx_format. This does not save the working copy.",
      inputSchema: {
        type: "object" as const, required: ["expected_revision", "operations"], additionalProperties: false,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          expected_revision: { type: "integer", minimum: 0 },
          operations: { type: "array", minItems: 1, maxItems: 100, items: {
            type: "object", required: ["paragraph_ref"], additionalProperties: false,
            properties: { paragraph_ref: { type: "string", minLength: 1 }, range: DOCX_RANGE_SCHEMA,
              font: DOCX_FONT_SCHEMA, paragraph: DOCX_PARAGRAPH_FORMAT_SCHEMA, ...DOCX_OBJECT_FORMAT_SCHEMAS },
          } },
        },
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.formatBatch) return { unavailable: true, error: "Atomic DOCX formatting is unavailable." };
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const expectedRevision = docxRevision(input.expected_revision);
          if (expectedRevision === null) throw new Error("expected_revision must be the non-negative session revision that was read.");
          if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) throw new Error("Supply one to one hundred DOCX format operations.");
          const operations = input.operations.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("A DOCX format operation must be an object.");
            return docxFormatItem(item as Record<string, unknown>);
          });
          const sessionId = optionalString(input, "session_id");
          if (opts?.confirm) {
            if (!host.readFormat) return { unavailable: true, error: "Format approval requires live DOCX formatting reads." };
            const before = await host.readFormat(sessionId, { kind: "overview" });
            if (!(await opts.confirm({ tool: "apply_docx_format_batch",
              summary: `Apply ${operations.length} DOCX format operations in ${before.document.filename}`,
              path: before.document.filename, diff: { path: before.document.filename,
                oldText: JSON.stringify(before, null, 2), newText: JSON.stringify(operations, null, 2) },
            }))) return declined("apply_docx_format_batch");
          }
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          return await host.formatBatch(sessionId, expectedRevision, operations, context);
        } catch (error) { return unavailableOrError(error); }
      },
    },
    import_docx_template_styles: {
      description: "Import selected style definitions and their style/numbering dependencies from an explicit retained Word template into the live working copy. Existing manuscript styles are preserved. Resolve each returned styleIdMap value with read_docx_format kind styles and style_id, then apply the returned exact name through paragraph.style; paragraph.style accepts w:name, not w:styleId. Resolvable source theme fonts override literal fallbacks; unresolved references retain existing literal fonts. Colors use stored fallbacks. Document defaults and the entire theme are not copied, so unspecified values use target defaults. Styles with resource relationships are refused. Read effective formatting after applying. This is one undoable edit and does not save or assign styles to paragraphs.",
      inputSchema: {
        type: "object" as const, required: ["template", "style_ids", "expected_revision"], additionalProperties: false,
        properties: {
          session_id: DOCX_SESSION_SCHEMA, template: { type: "string", minLength: 1 },
          expected_revision: { type: "integer", minimum: 0 },
          style_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.importTemplateStyles) return { unavailable: true, error: "DOCX template style import is unavailable." };
        if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
        try {
          const expectedRevision = docxRevision(input.expected_revision);
          if (expectedRevision === null) throw new Error("Supply the current non-negative expected_revision.");
          const template = stringField(input, "template").trim();
          if (!template) throw new Error("Choose an explicit retained Word template world.");
          if (!Array.isArray(input.style_ids) || input.style_ids.length < 1 || input.style_ids.length > 100 ||
            input.style_ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(input.style_ids).size !== input.style_ids.length) {
            throw new Error("Supply one to one hundred unique template style IDs.");
          }
          const styleIds = input.style_ids as string[];
          if (opts?.confirm && !(await opts.confirm({ tool: "import_docx_template_styles",
            summary: `Import ${styleIds.length} style definitions from template ${template}`,
            diff: { path: template, oldText: "Existing manuscript styles", newText: JSON.stringify({ template, styleIds }, null, 2) },
          }))) return declined("import_docx_template_styles");
          if (!mutationAllowed() || context?.signal?.aborted) return cancelled();
          return await host.importTemplateStyles(optionalString(input, "session_id"), template, styleIds, expectedRevision, context);
        } catch (error) { return unavailableOrError(error); }
      },
    },
    save_docx_document: {
      description:
        "Save the current live DOCX through the same retained baseline path as the working-copy Save action. Supply the session revision being saved.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          expected_revision: { type: "number", description: "Live session revision to save." },
        },
        required: ["expected_revision"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.saveDocument) {
          return { unavailable: true, error: "Live DOCX saving is unavailable." };
        }
        if (!mutationAllowed()) return cancelled();
        if (context?.signal?.aborted) return cancelled();
        const expectedRevision = docxRevision(input.expected_revision);
        if (expectedRevision === null) {
          return { error: "expected_revision must be the non-negative session revision to save." };
        }
        try {
          return await host.saveDocument(
            optionalString(input, "session_id"),
            expectedRevision,
            context,
          );
        } catch (error) {
          return unavailableOrError(error);
        }
      },
    },
    check_docx_template: {
      description:
        "Run the explicit retained template or world check for the active DOCX baseline. The template argument is the world version ID and is required.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: DOCX_SESSION_SCHEMA,
          template: { type: "string", description: "Explicit world version ID." },
        },
        required: ["template"],
        additionalProperties: false,
      },
      execute: async (input: Record<string, unknown>) => {
        if (!host.checkTemplate) {
          return { unavailable: true, error: "Explicit DOCX template checking is unavailable." };
        }
        if (!mutationAllowed()) return cancelled();
        if (context?.signal?.aborted) return cancelled();
        const template = stringField(input, "template").trim();
        if (!template) {
          return { error: "template must be an explicit world version ID." };
        }
        try {
          return await host.checkTemplate(
            optionalString(input, "session_id"),
            template,
            context,
          );
        } catch (error) {
          return unavailableOrError(error);
        }
      },
    },
  };
}

function pngDataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

const NO_FIGURE_ENGINE = "Figure tools work only in LaTeX and Typst projects.";
const TYPST_RENDERER_MISSING = "Typst figure previews are not available in this app.";

async function previewImage(
  preview: FigurePreview | null,
  pdfToPng: AiToolsHost["pdfToPng"],
): Promise<string | null> {
  if (!preview) return null;
  if ("pngDataUrl" in preview) return preview.pngDataUrl;
  try {
    return await pdfToPng(preview.pdfBytes, 1, 2);
  } catch {
    return null;
  }
}

function figureLatex(code: string, caption?: string, label?: string, raw?: boolean): string {
  const normalizedCode = normalizeFigureCode(code);
  const captionLine = caption ? `\\caption{${caption}}\n` : "";
  const labelLine = label ? `\\label{${label}}\n` : "";
  return raw
    ? normalizedCode
    : `\\begin{figure}[htbp]\n\\centering\n${normalizedCode}\n${captionLine}${labelLine}\\end{figure}`;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
type ImageDimensions = {
  mime: "image/png" | "image/jpeg" | "image/gif";
  width: number;
  height: number;
};

function imageTypeAndDimensions(bytes: Uint8Array): ImageDimensions | null {
  return pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes);
}

export function docxImageForTool(
  result: DocxImageReadHostResult,
  request: DocxImageReadRequest,
  sessionId?: string,
): { metadata: DocxImageToolMetadata; dataUrl: string } {
  if (result.revision !== request.expectedRevision || result.objectRef !== request.objectRef) {
    throw new Error("The DOCX image result does not describe the requested revision and object.");
  }
  if (
    result.document.sessionRevision !== request.expectedRevision ||
    result.document.sourceSha256 !== result.sourceSha256 ||
    (sessionId !== undefined && result.document.sessionId !== sessionId)
  ) {
    throw new Error("The DOCX image result does not match its current document source identity.");
  }
  if (result.bytes.byteLength === 0) throw new Error("The DOCX image is empty.");
  if (result.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`DOCX image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB limit.`);
  }
  const image = imageTypeAndDimensions(result.bytes);
  if (!image || image.width <= 0 || image.height <= 0) {
    throw new Error("Only valid PNG, JPEG, and GIF DOCX images are supported.");
  }
  if (image.width * image.height > MAX_IMAGE_PIXELS) {
    throw new Error(
      `DOCX image dimensions exceed the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel limit.`,
    );
  }
  if (result.mimeType.toLowerCase() !== image.mime) {
    throw new Error(
      `The DOCX image MIME type ${result.mimeType} does not match its ${image.mime} bytes.`,
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(result.imageSha256)) {
    throw new Error("The DOCX image result has an invalid SHA-256 hash.");
  }
  for (const [name, value] of [
    ["part", result.part],
    ["relationshipId", result.relationshipId],
    ["mediaPart", result.mediaPart],
  ] as const) {
    if (!value.trim()) throw new Error(`The DOCX image result has no ${name}.`);
  }
  for (const [name, value] of [
    ["widthEmu", result.widthEmu],
    ["heightEmu", result.heightEmu],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`The DOCX image result has an invalid ${name}.`);
    }
  }
  const metadata: DocxImageToolMetadata = {
    source: "live-docx",
    imageReadComplete: true,
    contentStatus: "pixels_provided",
    editable: false,
    document: result.document,
    sourceSha256: result.sourceSha256,
    ...(sessionId ? { sessionId } : {}),
    paragraphRef: request.paragraphRef,
    objectRef: result.objectRef,
    revision: result.revision,
    part: result.part,
    relationshipId: result.relationshipId,
    mediaPart: result.mediaPart,
    mimeType: image.mime,
    imageSha256: result.imageSha256.toLowerCase(),
    width: image.width,
    height: image.height,
    ...(result.description === undefined ? {} : { description: result.description }),
    ...(result.widthEmu === undefined ? {} : { widthEmu: result.widthEmu }),
    ...(result.heightEmu === undefined ? {} : { heightEmu: result.heightEmu }),
  };
  if (JSON.stringify(metadata).length > DOCX_READ_MAX_CHARS) {
    throw new Error(
      `The DOCX image metadata exceeds the ${DOCX_READ_MAX_CHARS}-character transport budget.`,
    );
  }
  return {
    metadata,
    dataUrl: `data:${image.mime};base64,${bytesToBase64(result.bytes)}`,
  };
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || !hasBytePrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10 || !hasBytePrefix(bytes, [0x47, 0x49, 0x46])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || !hasBytePrefix(bytes, [0xff, 0xd8])) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    const length = jpegSegmentLength(bytes, offset, marker);
    if (length === null) break;
    const dimensions = jpegFrameDimensions(bytes, offset, marker, length, startOfFrame);
    if (dimensions) return dimensions;
    offset += length;
  }
  return null;
}

function hasBytePrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function jpegSegmentLength(bytes: Uint8Array, offset: number, marker: number): number | null {
  if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) return null;
  const length = (bytes[offset] << 8) | bytes[offset + 1];
  return length >= 2 && offset + length <= bytes.length ? length : null;
}

function jpegFrameDimensions(
  bytes: Uint8Array,
  offset: number,
  marker: number,
  length: number,
  startOfFrame: ReadonlySet<number>,
): ImageDimensions | null {
  if (!startOfFrame.has(marker) || length < 7) return null;
  const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
  const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
  return { mime: "image/jpeg", width, height };
}

export function createFigureTools(
  host: AiToolsHost,
  opts?: {
    confirm?: ConfirmFn;
    onImage?: (dataUrl: string) => void;
    mutationAllowed?: () => boolean;
  },
) {
  const confirm = opts?.confirm;
  const onImage = opts?.onImage;
  const {
    compileIsolated,
    readIsolatedPdf,
    readProjectBytes,
    writeProjectBytes,
    pdfToPng: pdfPageToPng,
    setLastFigurePreview,
    getLastFigurePreview,
    getFigureInsertTarget,
    insertAtCursor,
    replaceRange,
  } = host;
  const insertTargetPath = (projectId: string) => host.insertTargetPath?.(projectId) ?? null;
  const { pid, mutationAllowed, prepareMutation } = mutationGuards(host, opts?.mutationAllowed);
  const figureEngine = (): FigureEngine | null =>
    host.getFigureEngine ? host.getFigureEngine() : "latex";
  const requestActive = (projectId: string) => pid() === projectId && mutationAllowed();
  const requestInterrupted = () => ({
    error: "The open project changed or the figure request was cancelled before completion.",
  });
  const previewForProject = (projectId: string): FigurePreview | null => {
    const preview = getLastFigurePreview();
    return !preview?.projectId || preview.projectId === projectId ? preview : null;
  };

  const previewTypst = async (id: string, code: string) => {
    if (!host.renderTypstFigure) return { error: TYPST_RENDERER_MISSING };
    try {
      const { typstPreviewOutcome, typstPreviewSource } = await import("./typst-figure");
      const render = await host.renderTypstFigure(id, typstPreviewSource(code));
      if (!requestActive(id)) return requestInterrupted();
      const { pngDataUrl, result } = typstPreviewOutcome(render);
      setLastFigurePreview(pngDataUrl ? { pngDataUrl, projectId: id } : null);
      if (pngDataUrl && onImage) onImage(pngDataUrl);
      return result;
    } catch (e) {
      return { error: String(e) };
    }
  };

  const typstFigureText = async (
    id: string,
    input: { code: string; caption?: string; label?: string; raw?: boolean },
  ) => {
    const { typstFigureMarkup } = await import("./typst-figure");
    const path = insertTargetPath(id);
    let existingSource = "";
    if (path) {
      try {
        existingSource = await host.readFileContent(id, path);
      } catch {
        existingSource = "";
      }
    }
    return typstFigureMarkup(input.code, { ...input, existingSource });
  };

  const tools: Record<string, RawToolDef> = {
    preview_figure: {
      description:
        "Render a figure on its own and return the outcome. In a LaTeX project pass `code` as a TikZ picture or other figure body, plus optional `packages` and `libraries` it needs. Returns { success, errors, log_tail }. In a Typst project pass `code` as Typst markup, such as a CeTZ canvas, a fletcher diagram, or plain content, with any #import lines it needs at the top. `packages` and `libraries` are ignored there. Returns { success, errors, warnings }. The figure is rendered alone, so it cannot read other project files. Iterate: fix errors and call again until success is true.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: String.raw`The figure body, e.g. \begin{tikzpicture}...\end{tikzpicture} in LaTeX, or #import "@preview/cetz:0.4.2" followed by #cetz.canvas({ ... }) in Typst`,
          },
          packages: {
            type: "array",
            items: { type: "string" },
            description: "Extra LaTeX packages (tikz is always included). LaTeX only.",
          },
          libraries: {
            type: "array",
            items: { type: "string" },
            description: "TikZ libraries, e.g. arrows.meta, positioning. LaTeX only.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { code, packages, libraries } = input as {
          code: string;
          packages?: string[];
          libraries?: string[];
        };
        const id = pid();
        if (!id) return { error: "No project open" };
        const engine = figureEngine();
        if (!engine) return { error: NO_FIGURE_ENGINE };
        if (engine === "typst") return previewTypst(id, code);
        try {
          const source = buildStandaloneDoc({ code, packages, libraries });
          const result = await compileIsolated(id, source);
          if (!requestActive(id)) return requestInterrupted();
          let bytes: Uint8Array | null = null;
          let previewImageDataUrl: string | null = null;
          if (result.has_pdf) {
            bytes = new Uint8Array(await readIsolatedPdf(id));
            if (!requestActive(id)) return requestInterrupted();
          }
          if (bytes && onImage) {
            try {
              previewImageDataUrl = await pdfPageToPng(bytes, 1, 2);
            } catch {
              /* rendering is best-effort; text refine still works */
            }
            if (!requestActive(id)) return requestInterrupted();
          }
          setLastFigurePreview(bytes ? { pdfBytes: bytes, projectId: id } : null);
          if (previewImageDataUrl) onImage?.(previewImageDataUrl);
          return {
            success: result.ok,
            errors: result.errors,
            has_pdf: result.has_pdf,
            log_tail: (result.log ?? "").slice(-4000),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },

    insert_figure: {
      description:
        "Insert the finished figure into the document at the user's cursor (or the selected paragraph it was generated from), and save a PNG copy to figures/. Provide the final `code`, and optionally a `caption` and `label`. In LaTeX the code goes inside a figure environment. In Typst it goes inside #figure, the label follows it as <label>, and leading #import lines are placed above it. Set raw=true to insert the bare code without the figure wrapper.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "The final figure body" },
          caption: { type: "string", description: "Figure caption (omit for none)" },
          label: { type: "string", description: "Figure label, e.g. fig:transformer" },
          raw: {
            type: "boolean",
            description: "Insert the bare code without the figure wrapper",
            default: false,
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { code, caption, label, raw } = input as {
          code: string;
          caption?: string;
          label?: string;
          raw?: boolean;
        };
        const id = pid();
        if (!id) return { error: "No project open" };
        const engine = figureEngine();
        if (!engine) return { error: NO_FIGURE_ENGINE };
        const figureSource =
          engine === "typst"
            ? await typstFigureText(id, { code, caption, label, raw })
            : figureLatex(code, caption, label, raw);
        const png = await previewImage(previewForProject(id), pdfPageToPng);
        if (!requestActive(id)) return requestInterrupted();
        if (
          confirm &&
          !(await confirm({
            tool: "insert_figure",
            summary: "Insert this figure into the document",
            ...(png ? { image: png } : {}),
          }))
        ) {
          return declined("insert_figure");
        }
        try {
          await prepareMutation(id);
        } catch (e) {
          return { error: String(e) };
        }
        const target = getFigureInsertTarget();
        const documentPath = insertTargetPath(id);
        const inserted = target
          ? await replaceRange(id, target.from, target.to, figureSource, mutationAllowed)
          : await insertAtCursor(id, figureSource, mutationAllowed);
        if (!inserted) return { error: "No editable document is open" };
        let figure: string | null = null;
        try {
          if (png) {
            const name = slugifyFigureName(caption || label || "figure");
            const expectedGeneration = await prepareMutation(id);
            await writeProjectBytes(
              id,
              `figures/${name}.png`,
              pngDataUrlToBase64(png),
              expectedGeneration,
            );
            figure = `figures/${name}.png`;
            await host.refreshTree(id);
          }
        } catch {
          /* saving the raster copy is optional; the LaTeX is already inserted */
        }
        return {
          success: true,
          ...(documentPath ? { path: documentPath } : {}),
          ...(figure ? { figure } : {}),
        };
      },
    },

    load_image: {
      description:
        "Load an image already in the project (e.g. a hand-drawn sketch the user added) so you can look at it and reproduce it as a figure. Pass its project-relative path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative image path, e.g. sketch.png",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const path = input.path as string;
        const id = pid();
        if (!id) return { error: "No project open" };
        try {
          const bytes = new Uint8Array(await readProjectBytes(id, path));
          if (!requestActive(id)) return requestInterrupted();
          if (bytes.byteLength > MAX_IMAGE_BYTES) {
            return { error: `Image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB limit.` };
          }
          const image = imageTypeAndDimensions(bytes);
          if (!image || image.width <= 0 || image.height <= 0) {
            return { error: "Only valid PNG, JPEG, and GIF images are supported." };
          }
          if (image.width * image.height > MAX_IMAGE_PIXELS) {
            return { error: `Image dimensions exceed the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel limit.` };
          }
          const b64 = bytesToBase64(bytes);
          if (onImage) onImage(`data:${image.mime};base64,${b64}`);
          return { loaded: true, path, width: image.width, height: image.height };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },
  };

  return tools;
}

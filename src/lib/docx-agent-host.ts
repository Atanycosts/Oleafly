import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import { invoke } from "@tauri-apps/api/core";
import {
  createDocxTools,
  docxReadForTool,
  DOCX_READ_MAX_CHARS,
  type DocxActivityDocument,
  type DocxDocumentRead,
  type DocxReadQuery,
  type DocxInlineAtom,
  type DocxModelRange,
  type DocxParagraphView,
  type DocxTextRangeReplaceResult,
  type DocxDocumentState,
  type DocxFormatMutation,
  type DocxFormatBatchItem,
  type DocxObjectFormatMutation,
  type DocxFormatReadQuery,
  type DocxFormatReadResult,
  type DocxFormatCandidatePreparation,
  type DocxFormatCandidateRefusal,
  type DocxFormatCandidateTemplate,
  type DocxImageReadHostResult,
  type DocxImageReadRequest,
  type DocxEquationWriteRequest,
  type DocxEquationWriteResult,
  type DocxOperationContext,
  type DocxSaveResult,
  type DocxSuggestionApplyResult,
  type DocxSuggestionResult,
  type DocxTargetView,
  type DocxTemplateCheckResult,
  type DocxTemplateStyleImportResult,
  type DocxToolsOptions,
  type DocxToolsHost,
  type DocxWorkspaceContext,
  type DocxRevealRequest,
} from "@oleafly/ai-tools";
import { runInlineCompletion } from "@/lib/ai-inline";
import { docxContentSha256 } from "@/lib/docx-recovery";
import { journalTemplates, loadTemplateSource } from "@/lib/docx-template-client";
import { journalRequest, JournalWorkbenchError, type JournalState, type JournalTemplateSummary } from "@/lib/journal-workbench";
import type { CompiledDocxEquation } from "@/lib/docx-equation-conversion";
import type { DocxApplyResult, DocxSession, DocxTarget } from "@/lib/docx-session";
import type { DocxActivity, DocxDocumentIdentity } from "@/lib/docx-task-activity";
import { useFilesStore } from "@/store/files";
import { activeChatRun } from "@/components/ai/chat-run-registry";
import { useAgentWorkspaceStore, type AgentExecutionOrigin, type AgentWorkspaceTarget } from "@/store/agent-workspace";

export interface DocxAgentRegistration {
  sessionId: string;
  appProjectId: string;
  workbenchProjectId: string;
  title: string;
  filename: string;
  baselineId: string;
  savedRevision: number;
  sourceSha256: string;
  canPresentSuggestion?(): boolean;
  onTaskSuggestion?(activity: DocxActivity, target: DocxTarget): void;
  session: DocxSession;
  reveal?(request: Omit<DocxRevealRequest, "sessionId"> & { signal?: AbortSignal }): Promise<void> | void;
  prepareFonts?(): Promise<unknown>;
  exportDocument?(): Promise<unknown>;
  readFormat?(query: DocxFormatReadQuery): Promise<DocxFormatReadResult>;
  save?(request: {
    expectedRevision: number;
    signal?: AbortSignal;
    operation?: {
      operationId: string;
      document: DocxDocumentIdentity;
    };
  }): Promise<DocxSaveResult>;
  check?(request: {
    template: string;
    signal?: AbortSignal;
  }): Promise<DocxTemplateCheckResult>;
  prepareFormatCandidate?(request: {
    signal?: AbortSignal;
    worldVersionId?: string;
  }): Promise<DocxFormatCandidatePreparation>;
  getFormatCandidateTemplates?(): { selected: DocxFormatCandidateTemplate | null; bound: DocxFormatCandidateTemplate | null };
  getFormatCandidateBasis?(): { check_id: string; matches: boolean } | undefined;
  onTaskOperation?(receipt: {
    operationId: string;
    document: DocxDocumentIdentity;
    result: DocxTaskOperationResult;
  }): Promise<void>;
  onTaskOperationRecorded?(operationId: string): Promise<void>;
  onSuggestion?(event: {
    target: DocxTarget;
    proposed: string;
    phase: "streaming" | "reviewing" | "withdrawn";
    controller: AbortController;
  }): void;
  onApplied?(target: DocxTarget, proposed: string): void;
}

export interface RegisteredDocxSession extends DocxAgentRegistration {
  readonly baselineId: string;
  readonly savedRevision: number;
}

interface TargetRecord {
  sessionId: string;
  paragraph: AutomationHandle<"paragraph">;
  original: string;
  revision: number;
  paraId?: string;
  structure?: string;
}

const sessions = new Map<string, RegisteredDocxSession>();
const sessionSubscriptions = new Map<string, () => void>();
const targets = new Map<string, TargetRecord>();
const generations = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let activeSessionId: string | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function currentRegistration(registration: RegisteredDocxSession): RegisteredDocxSession {
  const current = registrationFor(registration.sessionId);
  if (current.session !== registration.session) {
    throw new Error("The DOCX session closed or changed while the suggestion was generated.");
  }
  return current;
}

function state(registration: RegisteredDocxSession): DocxDocumentState {
  const sessionRevision = registration.session.revision();
  return {
    sessionId: registration.sessionId,
    baselineId: registration.baselineId,
    sessionRevision,
    savedRevision: registration.savedRevision,
    dirty: sessionRevision !== registration.savedRevision,
  };
}

function document(registration: RegisteredDocxSession): DocxActivityDocument {
  return {
    ...state(registration),
    appProjectId: registration.appProjectId,
    workbenchProjectId: registration.workbenchProjectId,
    title: registration.title,
    filename: registration.filename,
    sourceSha256: registration.sourceSha256,
  };
}

function taskDocument(registration: RegisteredDocxSession): DocxDocumentIdentity {
  const { sessionId, baselineId, sessionRevision, savedRevision } = state(registration);
  return {
    sessionId,
    appProjectId: registration.appProjectId,
    workbenchProjectId: registration.workbenchProjectId,
    baselineId,
    sourceSha256: registration.sourceSha256,
    sessionRevision,
    savedRevision,
  };
}

function liveDocument(registration: RegisteredDocxSession): DocxActivityDocument {
  const current = sessions.get(registration.sessionId);
  return document(current?.session === registration.session ? current : registration);
}

type DocxSaveReceiptResult = DocxSaveResult & {
  ok?: false;
  expectedRevision?: number;
  message?: string;
};

function applySaveReceipt(
  registration: RegisteredDocxSession,
  expectedRevision: number,
  result: DocxSaveResult,
): {
  registration: RegisteredDocxSession;
  result: DocxSaveReceiptResult;
  mismatch?: { expectedRevision: number; message: string };
} {
  const sessionRevision = registration.session.revision();
  if (
    result.document.sessionId !== registration.sessionId ||
    result.document.sessionRevision < result.revision ||
    sessionRevision < result.revision ||
    result.document.baselineId !== result.baselineId ||
    result.document.savedRevision !== result.revision
  ) {
    throw new Error("The DOCX save receipt does not describe the registered working copy.");
  }
  const next = {
    ...registration,
    baselineId: result.baselineId,
    savedRevision: result.revision,
    sourceSha256: result.sourceSha256,
  };
  if (sessions.get(registration.sessionId)?.session === registration.session) {
    sessions.set(registration.sessionId, next);
    notify();
  }
  const normalized = { ...result, document: state(next) };
  if (result.revision !== expectedRevision) {
    const message =
      `The DOCX save committed revision ${result.revision}, not the requested revision ${expectedRevision}. ` +
      `The current working copy is at revision ${sessionRevision}.`;
    return {
      registration: next,
      result: { ...normalized, ok: false, expectedRevision, message },
      mismatch: { expectedRevision, message },
    };
  }
  return {
    registration: next,
    result: normalized,
  };
}

function assertSavedForCheck(registration: RegisteredDocxSession): void {
  if (registration.session.revision() !== registration.savedRevision) {
    throw new Error("Save the current DOCX working copy before checking it.");
  }
}

function assertTemplateCheckReceipt(
  identity: Pick<DocxDocumentIdentity, "workbenchProjectId" | "baselineId" | "sourceSha256">,
  template: string,
  result: DocxTemplateCheckResult,
): void {
  const check = result.check;
  if (
    result.template !== template ||
    check.project_id !== identity.workbenchProjectId ||
    check.baseline_id !== identity.baselineId ||
    check.world_version_id !== template ||
    check.source_sha256 !== identity.sourceSha256 ||
    check.validity !== "CURRENT"
  ) {
    throw new Error(
      "The DOCX template check receipt does not describe the requested saved baseline, world and source with a current result.",
    );
  }
}

export function getDocxWorkspaceContext(projectId = useFilesStore.getState().projectId): DocxWorkspaceContext {
  const viewed = projectId ? useAgentWorkspaceStore.getState().views[projectId] ?? null : null;
  const available = [...sessions.values()].filter((item) => item.appProjectId === projectId);
  const writable = available.map(document);
  const capabilities = available.map((item) => ({ sessionId: item.sessionId, operations: [
    "read_docx_document", "capture_docx_target", "apply_docx_suggestion",
    ...(item.session.readImage ? ["read_docx_image"] : []),
    ...(item.readFormat ? ["read_docx_format"] : []),
    ...(item.session.formatParagraph ? ["apply_docx_format"] : []),
    ...(item.session.formatBatch ? ["apply_docx_format_batch"] : []),
    ...(item.session.writeEquation ? ["write_docx_equation"] : []),
    ...(item.session.importTemplateStyles ? ["import_docx_template_styles"] : []),
    ...(item.save ? ["save_docx_document"] : []), ...(item.check ? ["check_docx_template"] : []),
    ...(item.prepareFonts ? ["prepare_docx_fonts"] : []), ...(item.exportDocument ? ["export_docx_document"] : []),
    ...(item.reveal ? ["reveal_docx_working_copy"] : []),
    ...(item.prepareFormatCandidate ? ["create_docx_format_candidate"] : []),
  ] }));
  const journalTemplates = available.flatMap((item) => item.getFormatCandidateTemplates
    ? [{ sessionId: item.sessionId, ...item.getFormatCandidateTemplates() }] : []);
  const selected = viewed?.selection;
  const working = viewed?.role === "working" ? writable.find((item) => item.sessionId === viewed.sessionId) : undefined;
  const selectedParagraph = working && selected && selected.revision === String(working.sessionRevision) &&
    (selected.paragraphRef || selected.paraId)
    ? sessions.get(working.sessionId)?.session.listParagraphs().find((item) =>
      (!selected.paragraphRef || item.handle.ref === selected.paragraphRef) && (!selected.paraId || item.paraId === selected.paraId)) : undefined;
  const selectionWriteTarget = working && selectedParagraph
    ? { sessionId: working.sessionId, paragraphRef: selectedParagraph.handle.ref, revision: working.sessionRevision } : null;
  return { viewed, writable, capabilities, selectionWriteTarget, ...(journalTemplates.length ? { journalTemplates } : {}),
    targeting: "Viewed materials and writable Word sessions are separate. Original/history/evidence selections are reference data. Only selectionWriteTarget is a verified current live write address. Read the chosen live session and use its exact revision before editing. Saving and checking are separate operations." };
}

export function describeDocxFormatTemplate(summary: JournalTemplateSummary): DocxFormatCandidateTemplate {
  return { versionId: summary.version_id, journal: summary.journal_name, version: summary.version_ordinal,
    status: summary.template_preparation.state, analyzerVersion: summary.template_preparation.analyzer_version };
}

/** Called by the workspace host only after its follow/pause policy accepts navigation. */
export async function revealDocxWorkspaceTarget(target: AgentWorkspaceTarget, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  if (target.projectId !== useFilesStore.getState().projectId) throw new Error("The Word navigation target belongs to another project.");
  const registration = registrationFor(target.sessionId);
  if (target.sessionRevision !== undefined && target.sessionRevision !== registration.session.revision()) {
    throw new Error("The Word navigation target belongs to an earlier revision. Refresh the working copy context.");
  }
  if (!registration.reveal) throw new Error("Word navigation is unavailable for this working copy.");
  const paragraph = target.paragraphRef ? registration.session.listParagraphs().find((item) => item.handle.ref === target.paragraphRef) : undefined;
  if (target.paragraphRef && !paragraph) throw new Error("The Word navigation paragraph is no longer present.");
  await registration.reveal({ paragraphRef: target.paragraphRef, paraId: paragraph?.paraId ?? target.paraId,
    expectedRevision: target.sessionRevision, ...(signal ? { signal } : {}) });
}

function ordinaryOrigin(opts?: DocxToolsOptions): AgentExecutionOrigin {
  const run = activeChatRun();
  if (run && run.projectId === useFilesStore.getState().projectId && opts?.signal === run.controller.signal) {
    return { kind: "chat", flowId: run.flowId, chatId: run.chatId };
  }
  return { kind: "external", flowId: opts?.runId?.() ?? crypto.randomUUID() };
}

async function reportDocxOperation<T>(
  registration: RegisteredDocxSession, operation: string, origin: AgentExecutionOrigin,
  action: () => Promise<T>, paragraphRef?: string, operationId: string = crypto.randomUUID(),
): Promise<T> {
  const target = () => ({ projectId: registration.appProjectId, sessionId: registration.sessionId,
    sessionRevision: registration.session.revision(), ...(paragraphRef ? { paragraphRef,
      paraId: registration.session.listParagraphs().find((item) => item.handle.ref === paragraphRef)?.paraId } : {}) });
  const base = { id: operationId, projectId: registration.appProjectId, sessionId: registration.sessionId,
    title: registration.title, origin, operation };
  const navigationTarget = () => operation === "context" ? {} : { target: target() };
  useAgentWorkspaceStore.getState().report({ ...base, phase: "started", ...navigationTarget() });
  try {
    const result = await action();
    const value = result as { ok?: boolean; message?: string; error?: string; checkpoint?: { status: string; error?: string } };
    const failed = value?.ok === false || value?.checkpoint?.status === "failed";
    useAgentWorkspaceStore.getState().report({ ...base, phase: failed ? "failed" : "succeeded", ...navigationTarget(), result,
      ...(failed ? { error: value.error ?? value.message ?? value.checkpoint?.error ?? "The Word operation was refused." } : {}) });
    return result;
  } catch (cause) {
    useAgentWorkspaceStore.getState().report({ ...base, phase: "failed", ...navigationTarget(), error: String(cause) });
    throw cause;
  }
}

function registrationFor(sessionId?: string): RegisteredDocxSession {
  const projectId = useFilesStore.getState().projectId;
  const projectSessions = [...sessions.values()].filter(
    (registration) => registration.appProjectId === projectId,
  );
  const viewed = useAgentWorkspaceStore.getState().views[projectId ?? ""];
  const viewedSession = viewed?.kind === "docx" ? projectSessions.find((item) =>
    item.sessionId === viewed.sessionId || `docx:${item.workbenchProjectId}` === viewed.documentId) : undefined;
  const id = sessionId ?? (
    viewedSession ? viewedSession.sessionId :
    activeSessionId &&
    projectSessions.some((registration) => registration.sessionId === activeSessionId)
      ? activeSessionId
      : projectSessions.at(-1)?.sessionId
  );
  if (!id) throw new Error("No active DOCX working copy is bound to the Agent.");
  const registration = sessions.get(id);
  if (!registration || registration.appProjectId !== projectId) {
    throw new Error(`DOCX session ${id} is not bound to the Agent for this project.`);
  }
  return registration;
}

function targetView(
  registration: RegisteredDocxSession,
  targetId: string,
  target: TargetRecord,
): DocxTargetView {
  return {
    ...state(registration),
    filename: registration.filename,
    targetId,
    paragraphRef: target.paragraph.ref,
    text: target.original,
    revision: target.revision,
    ...(target.paraId === undefined ? {} : { paraId: target.paraId }),
    ...(target.structure === undefined ? {} : { structure: target.structure }),
  };
}

function targetFrom(registration: RegisteredDocxSession, target: DocxTarget): {
  targetId: string;
  view: DocxTargetView;
} {
  const targetId = `docx-target-${crypto.randomUUID()}`;
  const record: TargetRecord = {
    sessionId: registration.sessionId,
    paragraph: target.paragraph,
    original: target.original,
    revision: target.revision,
    ...(target.paraId === undefined ? {} : { paraId: target.paraId }),
    ...(target.structure === undefined ? {} : { structure: target.structure }),
  };
  targets.set(targetId, record);
  return { targetId, view: targetView(registration, targetId, record) };
}

function targetFor(targetId: string): {
  registration: RegisteredDocxSession;
  record: TargetRecord;
} {
  const record = targets.get(targetId);
  if (!record) throw new Error(`DOCX suggestion target ${targetId} is no longer available.`);
  let registration: RegisteredDocxSession;
  try {
    registration = registrationFor(record.sessionId);
  } catch {
    targets.delete(targetId);
    throw new Error(`DOCX session ${record.sessionId} is not bound to the Agent for this project.`);
  }
  return { registration, record };
}

function assertAttribution(context?: DocxOperationContext): void {
  const attribution = context?.attribution;
  if (
    attribution &&
    Object.values(attribution).some(
      (value) => value !== undefined && (typeof value !== "string" || !value.trim()),
    )
  ) {
    throw new Error("DOCX Agent attribution must use non-empty runtime IDs.");
  }
}

function paragraphIndex(registration: RegisteredDocxSession, paragraphRef: string): number {
  const index = registration.session
    .listParagraphs()
    .findIndex((paragraph) => paragraph.handle.ref === paragraphRef);
  if (index < 0) throw new Error(`Paragraph ${paragraphRef} is not present in this DOCX session.`);
  return index;
}

function sliceUtf16(text: string, offset: number, limit: number) {
  const lowSurrogate = (index: number) => {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  let start = Math.min(offset, text.length);
  if (start > 0 && lowSurrogate(start)) start--;
  let end = Math.min(start + limit, text.length);
  if (end < text.length && lowSurrogate(end)) {
    end = end > start + 1 ? end - 1 : end + 1;
  }
  return { text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null };
}

function pageNextQuery(
  query: DocxReadQuery,
  revision: number,
  nextOffset: number | null,
  text?: { nextOffset: number; textLimit: number },
  atom?: { atomOffset: number },
  payload?: { atomOffset: number; payloadOffset: number },
): DocxDocumentRead["nextQuery"] {
  const base = {
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.paragraphRef ? { paragraphRef: query.paragraphRef } : {}),
    ...(query.readVersion ? { readVersion: query.readVersion } : {}),
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
    expectedRevision: revision,
  };
  if (payload) return {
    ...base,
    textOffset: query.textOffset ?? 0,
    textLimit: query.textLimit ?? 4000,
    atomOffset: payload.atomOffset,
    payloadOffset: payload.payloadOffset,
  };
  if (atom) return {
    ...base,
    textOffset: query.textOffset ?? 0,
    textLimit: query.textLimit ?? 4000,
    atomOffset: atom.atomOffset,
  };
  if (text) return {
    ...base,
    textOffset: text.nextOffset,
    textLimit: text.textLimit,
  };
  return nextOffset === null ? null : { ...base, offset: nextOffset };
}

function intersects(range: DocxModelRange, start: number, end: number): boolean {
  return range.end > start && range.start < end;
}

function atomIntersects(
  range: DocxModelRange,
  start: number,
  end: number,
  includeEnd: boolean,
): boolean {
  if (range.start < range.end) return intersects(range, start, end);
  return range.start >= start && (range.start < end || (includeEnd && range.start === end));
}

function displayWindow(
  displayText: string,
  atoms: readonly DocxInlineAtom[],
  selected: readonly DocxInlineAtom[],
  modelStart: number,
  modelEnd: number,
): { start: number; end: number } {
  const selectedRefs = new Set(selected.map((atom) => atom.objectRef));
  const included = atoms.filter((atom) => selectedRefs.has(atom.objectRef));
  const mappedBoundary = (position: number) => {
    let mapped = position;
    for (const atom of atoms) {
      const { start, end } = atom.modelRange;
      if (start < end && end <= position) {
        mapped +=
          (atom.displayRange.end - atom.displayRange.start) - (end - start);
      } else if (start === end && start < position) {
        mapped += atom.displayRange.end - atom.displayRange.start;
      }
    }
    return Math.max(0, Math.min(displayText.length, mapped));
  };
  const boundary = (position: number, side: "start" | "end") => {
    const anchored = included.filter((atom) => {
      const { start, end } = atom.modelRange;
      return side === "start"
        ? start === position || (start < position && position < end)
        : end === position || (start < position && position < end);
    });
    if (anchored.length > 0) {
      return side === "start"
        ? Math.min(...anchored.map((atom) => atom.displayRange.start))
        : Math.max(...anchored.map((atom) => atom.displayRange.end));
    }
    return mappedBoundary(position);
  };
  return {
    start: boundary(modelStart, "start"),
    end: Math.max(boundary(modelStart, "start"), boundary(modelEnd, "end")),
  };
}

function paragraphView(
  paragraphRef: string,
  semantics: {
    revision: number;
    paraId?: string;
    modelText: string;
    displayText: string;
    atoms: readonly DocxInlineAtom[];
    editableRanges: readonly DocxModelRange[];
  },
  window?: {
    modelText: ReturnType<typeof sliceUtf16>;
    atoms: DocxInlineAtom[];
    omitText?: boolean;
  },
): DocxParagraphView {
  const model = window?.modelText
    ?? { text: semantics.modelText, offset: 0, nextOffset: null };
  const modelEnd = model.offset + model.text.length;
  const displayRange = window
    ? displayWindow(
        semantics.displayText,
        semantics.atoms,
        window.atoms,
        model.offset,
        modelEnd,
      )
    : { start: 0, end: semantics.displayText.length };
  const omitText = window?.omitText === true;
  const display = omitText
    ? ""
    : semantics.displayText.slice(displayRange.start, displayRange.end);
  const includeEndBoundary = modelEnd === semantics.modelText.length;
  const atoms = window?.atoms
    ?? [...semantics.atoms].filter((atom) =>
      atomIntersects(atom.modelRange, model.offset, modelEnd, includeEndBoundary));
  const editableRanges = [...semantics.editableRanges].filter((range) =>
    intersects(range, model.offset, modelEnd));
  return {
    paragraphRef,
    text: display,
    ...(semantics.paraId ? { paraId: semantics.paraId } : {}),
    revision: semantics.revision,
    modelText: omitText ? "" : model.text,
    displayText: display,
    ...(window ? {
      modelTextOffset: model.offset,
      modelTextLength: semantics.modelText.length,
      modelTextTruncated: omitText || model.offset > 0 || model.nextOffset !== null,
      displayTextOffset: displayRange.start,
      displayTextLength: semantics.displayText.length,
      displayTextTruncated:
        omitText || displayRange.start > 0 || displayRange.end < semantics.displayText.length,
    } : {}),
    atoms,
    editableRanges,
  };
}

function readDocumentPage(
  registration: RegisteredDocxSession,
  query: DocxReadQuery = {},
): DocxDocumentRead {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("DOCX read offset must be a non-negative integer.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Read one to fifty DOCX paragraphs per page.");
  const textOffset = query.textOffset;
  const textLimit = query.textLimit;
  if ((textOffset === undefined) !== (textLimit === undefined))
    throw new Error("DOCX textOffset and textLimit must be supplied together.");
  if (textOffset !== undefined && (!Number.isInteger(textOffset) || textOffset < 0))
    throw new Error("DOCX textOffset must be a non-negative UTF-16 offset.");
  if (textLimit !== undefined && (!Number.isInteger(textLimit) || textLimit < 1 || textLimit > 8000))
    throw new Error("DOCX textLimit must contain one to eight thousand UTF-16 units.");
  const atomOffset = query.atomOffset;
  const payloadOffset = query.payloadOffset;
  if (atomOffset !== undefined && (!Number.isInteger(atomOffset) || atomOffset < 0))
    throw new Error("DOCX atomOffset must be a non-negative atom index.");
  if (payloadOffset !== undefined && (!Number.isInteger(payloadOffset) || payloadOffset < 0))
    throw new Error("DOCX payloadOffset must be a non-negative UTF-16 offset.");
  if (atomOffset !== undefined && textOffset === undefined)
    throw new Error("DOCX atomOffset requires textOffset and textLimit.");
  if (payloadOffset !== undefined && atomOffset === undefined)
    throw new Error("DOCX payloadOffset requires atomOffset.");
  if (query.expectedRevision !== undefined &&
      (!Number.isInteger(query.expectedRevision) || query.expectedRevision < 0))
    throw new Error("DOCX expectedRevision must be a non-negative integer.");
  if (query.readVersion && (!query.sessionId || query.expectedRevision === undefined))
    throw new Error("read_version requires session_id and expected_revision.");
  if (query.paragraphRef && (!query.readVersion || offset !== 0))
    throw new Error("paragraph_ref requires the exact versioned read route, without a nonzero offset.");
  const page = readBoundDocumentPage(registration, query, offset, limit, textOffset, textLimit);
  if (page.document.sessionRevision !== registration.session.revision() ||
      page.readVersion !== registration.session.readVersion?.())
    throw new Error("The DOCX changed during this read. Read the current working copy again.");
  return page;
}

function readBoundDocumentPage(
  registration: RegisteredDocxSession,
  query: DocxReadQuery,
  offset: number,
  limit: number,
  textOffset?: number,
  textLimit?: number,
): DocxDocumentRead {
  const handles = registration.session.listParagraphHandles();
  const revision = registration.session.revision();
  if (query.expectedRevision !== undefined && query.expectedRevision !== revision)
    throw new Error(`The DOCX read continuation is stale: expected revision ${query.expectedRevision}, current ${revision}.`);
  const readVersion = registration.session.readVersion?.();
  if (query.readVersion && query.readVersion !== readVersion)
    throw new Error("The live DOCX package has changed. Read the current working copy again.");
  const boundQuery = { ...query, sessionId: registration.sessionId, readVersion };
  const paragraphIndex = query.paragraphRef ? handles.findIndex((handle) => handle.ref === query.paragraphRef) : offset;
  if (paragraphIndex < 0) throw new Error("The DOCX reference paragraph is not present in this session.");
  if (textOffset !== undefined && offset >= handles.length)
    throw new Error("The DOCX text window does not identify an existing paragraph.");
  const windowed = textOffset !== undefined && textLimit !== undefined;
  const requestedEnd = Math.min(handles.length, paragraphIndex + (windowed || query.paragraphRef ? 1 : limit));
  const nextAfter = (index: number) => !query.paragraphRef && index < handles.length ? index : null;
  const documentAtRead = document(registration);
  if (windowed) {
    const semantics = registration.session.readParagraph(handles[paragraphIndex]);
    return readParagraphPage(documentAtRead, boundQuery, paragraphIndex, semantics,
      textOffset, textLimit, nextAfter(requestedEnd), handles.length);
  }

  const paragraphs: DocxParagraphView[] = [];
  let previous: DocxDocumentRead | null = null;
  for (let index = paragraphIndex; index < requestedEnd; index++) {
    const semantics = registration.session.readParagraph(handles[index]);
    const view = paragraphView(handles[index].ref, semantics);
    const nextOffset = nextAfter(index + 1);
    const result = {
      document: documentAtRead,
      ...(readVersion ? { readVersion } : {}),
      paragraphs: [...paragraphs, view],
      offset: paragraphIndex,
      nextOffset,
      totalParagraphs: handles.length,
      nextQuery: pageNextQuery(boundQuery, revision, nextOffset),
    } satisfies DocxDocumentRead;
    if (JSON.stringify(docxReadForTool(result)).length <= DOCX_READ_MAX_CHARS) {
      paragraphs.push(view);
      previous = result;
      continue;
    }
    if (paragraphs.length) return previous!;
    return readParagraphPage(documentAtRead, boundQuery, index, semantics,
      0, 4000, nextOffset, handles.length);
  }
  if (previous) return previous;
  return {
    document: documentAtRead,
    ...(readVersion ? { readVersion } : {}),
    paragraphs: [],
    offset,
    nextOffset: null,
    totalParagraphs: handles.length,
    nextQuery: null,
  };
}

function readParagraphPage(
  documentAtRead: DocxActivityDocument,
  query: DocxReadQuery,
  paragraphIndex: number,
  semantics: ReturnType<DocxSession["readParagraph"]>,
  textOffset: number,
  textLimit: number,
  paragraphNextOffset: number | null,
  totalParagraphs: number,
): DocxDocumentRead {
  const paragraphRef = semantics.paragraphRef;
  let modelWindow = sliceUtf16(semantics.modelText, textOffset, textLimit);
  const fixedWindow =
    query.atomOffset !== undefined || query.payloadOffset !== undefined;
  const atomStart = query.atomOffset ?? 0;
  const modelEnd = modelWindow.offset + modelWindow.text.length;
  let maxAtoms = query.payloadOffset !== undefined ? 1 : semantics.atoms.filter((atom) =>
    atomIntersects(
      atom.modelRange,
      modelWindow.offset,
      modelEnd,
      modelEnd === semantics.modelText.length,
    )).length;
  let payloadChunk = 1200;
  let compactAtom = false;
  let omitText = false;

  const build = (): DocxDocumentRead => {
    const textNext = modelWindow.nextOffset;
    const windowEnd = modelWindow.offset + modelWindow.text.length;
    const includeEndBoundary = windowEnd === semantics.modelText.length;
    const intersecting = semantics.atoms.filter((atom) =>
      atomIntersects(atom.modelRange, modelWindow.offset, windowEnd, includeEndBoundary));
    if (atomStart > intersecting.length)
      throw new Error("The DOCX atomOffset is beyond the atoms in this text window.");
    const selected = intersecting.slice(atomStart, atomStart + maxAtoms);
    let payloadNext: { atomOffset: number; payloadOffset: number } | null = null;
    const windowQuery: DocxReadQuery = {
      ...query,
      textOffset: modelWindow.offset,
      textLimit: Math.max(1, modelWindow.text.length),
    };
    const atoms = selected.map((atom, index) => {
      const value: DocxInlineAtom = compactAtom && index === 0
        ? { ...atom, displayText: undefined }
        : atom;
      if (value.payload === undefined) {
        if (value.payloadJson === undefined) return value;
        const start = query.payloadOffset !== undefined && index === 0 ? query.payloadOffset : 0;
        const end = Math.min(value.payloadLength ?? value.payloadJson.length, start + payloadChunk);
        const needsContinuation = end < (value.payloadLength ?? value.payloadJson.length);
        if (needsContinuation && payloadNext === null)
          payloadNext = { atomOffset: atomStart + index, payloadOffset: end };
        return {
          ...value,
          payloadJson: (value.payloadJson ?? "").slice(start, end),
          payloadOffset: start,
          payloadLength: value.payloadLength ?? value.payloadJson?.length,
          payloadContinuation: needsContinuation
            ? pageNextQuery({ ...windowQuery, offset: query.offset ?? 0 }, semantics.revision,
                null, undefined, undefined,
                { atomOffset: atomStart + index, payloadOffset: end })
            : null,
        };
      }
      const payloadJson = JSON.stringify(value.payload);
      const start = query.payloadOffset !== undefined && index === 0 ? query.payloadOffset : 0;
      const end = Math.min(payloadJson.length, start + payloadChunk);
      const needsContinuation = end < payloadJson.length;
      if (needsContinuation && payloadNext === null)
        payloadNext = { atomOffset: atomStart + index, payloadOffset: end };
      return {
        ...value,
        payload: undefined,
        payloadJson: payloadJson.slice(start, end),
        payloadOffset: start,
        payloadLength: payloadJson.length,
        payloadContinuation: needsContinuation
          ? pageNextQuery({ ...windowQuery, offset: query.offset ?? 0 }, semantics.revision,
              null, undefined, undefined,
              { atomOffset: atomStart + index, payloadOffset: end })
          : null,
      };
    });
    const atomNext = atomStart + selected.length < intersecting.length
      ? { atomOffset: atomStart + selected.length } : null;
    const nextQuery = payloadNext
        ? pageNextQuery({ ...windowQuery, offset: query.offset ?? 0 }, semantics.revision,
            null, undefined, undefined, payloadNext)
        : atomNext
          ? pageNextQuery({ ...windowQuery, offset: query.offset ?? 0 }, semantics.revision,
              null, undefined, atomNext)
          : textNext !== null
            ? pageNextQuery({ ...windowQuery, offset: query.offset ?? 0 }, semantics.revision,
                null, { nextOffset: textNext, textLimit: modelWindow.text.length })
            : paragraphNextOffset === null
              ? null
              : pageNextQuery(query, semantics.revision, paragraphNextOffset);
    const view = paragraphView(paragraphRef, semantics, {
      modelText: modelWindow,
      atoms,
      omitText,
    });
    return {
      document: documentAtRead,
      ...(query.readVersion ? { readVersion: query.readVersion } : {}),
      paragraphs: [view],
      offset: paragraphIndex,
      nextOffset: paragraphNextOffset,
      totalParagraphs,
      nextQuery,
      ...(textNext !== null ? {
        textWindow: {
          paragraphRef, offset: modelWindow.offset, nextOffset: textNext,
          textLength: semantics.modelText.length,
        },
      } : {}),
      ...(atomNext ? {
        atomWindow: {
          paragraphRef, offset: atomStart, nextOffset: atomNext.atomOffset,
          total: intersecting.length,
        },
      } : {}),
    };
  };

  let result = build();
  while (JSON.stringify(docxReadForTool(result)).length > DOCX_READ_MAX_CHARS) {
    if (query.payloadOffset !== undefined && payloadChunk > 64) {
      payloadChunk = Math.max(64, Math.floor(payloadChunk / 2));
      result = build();
      continue;
    }
    if (maxAtoms > 1) {
      maxAtoms--;
      result = build();
      continue;
    }
    if (maxAtoms === 1 && !compactAtom) {
      compactAtom = true;
      result = build();
      continue;
    }
    if (!fixedWindow && modelWindow.text.length > 1) {
      modelWindow = sliceUtf16(semantics.modelText, modelWindow.offset,
        Math.max(1, Math.floor(modelWindow.text.length / 2)));
      result = build();
      continue;
    }
    if (fixedWindow && !omitText) {
      omitText = true;
      result = build();
      continue;
    }
    throw new Error(`The DOCX read page cannot fit in ${DOCX_READ_MAX_CHARS} JSON characters.`);
  }
  return result;
}

function capture(
  registration: RegisteredDocxSession,
  paragraphRef: string,
): { targetId: string; view: DocxTargetView } {
  const paragraphs = registration.session.listParagraphs();
  const paragraph = paragraphs.find((item) => item.handle.ref === paragraphRef);
  if (!paragraph) throw new Error(`Paragraph ${paragraphRef} is not present in this DOCX session.`);
  return targetFrom(registration, registration.session.captureTarget(paragraph.handle));
}

function compactTemplateCheck(result: DocxTemplateCheckResult): DocxTemplateCheckResult {
  const retained = result.check;
  const fields = (source: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  const check = fields(retained, [
    "check_id", "project_id", "baseline_id", "binding_id", "world_version_id", "source_sha256",
    "checker_version", "reader_version", "created_at", "validity", "stale_reasons", "update_available", "summary",
  ]);
  for (const [source, target] of [["coverage_gaps", "coverage_gap_count"], ["limitations", "limitation_count"]] as const) {
    if (Array.isArray(retained[source])) check[target] = retained[source].length;
  }
  const comparison = retained.template_comparison;
  if (comparison !== null && typeof comparison === "object" && !Array.isArray(comparison)) {
    check.template_comparison = fields(comparison as Record<string, unknown>, [
      "schema_version", "template_source_sha256", "source_sha256", "template_engine", "engine",
      "finding_summary", "total", "findings_artifact_version_id",
    ]);
  }
  check.objectRead = {
    tool: "journal_read",
    arguments: { operation: "object", kind: "check", object_id: retained.check_id, world_version_id: retained.world_version_id },
  };
  if (comparison) {
    check.findingsRead = {
      tool: "journal_read",
      arguments: { operation: "findings", check_id: retained.check_id, offset: 0, limit: 20 },
    };
  }
  check.detail = "compact";
  check.readBoundary = "The complete check, world, rule results, coverage gaps and findings remain retained. Read objectRead or page findingsRead before judging omitted content.";
  return { template: result.template, check };
}

function templateCheckRead(sessionId: string, checkId?: unknown) {
  return { tool: "read_docx_template_check", arguments: { session_id: sessionId, operation: "status",
    ...(typeof checkId === "string" ? { check_id: checkId } : {}) } };
}

function candidateReviewRead(sessionId: string, checkId?: string) {
  return { tool: "read_docx_candidate_review", arguments: { session_id: sessionId,
    ...(checkId === undefined ? {} : { check_id: checkId }) } };
}

async function performEquationWrite(
  registration: RegisteredDocxSession,
  input: DocxEquationWriteRequest,
  context?: DocxOperationContext,
  beforeCommit?: () => Promise<void>,
): Promise<DocxEquationWriteResult> {
  assertAttribution(context);
  const write = registration.session.writeEquation;
  if (!write) throw new Error("LaTeX equation writing is unavailable for this working copy.");
  if (context?.signal?.aborted) throw new Error("The equation write was cancelled before conversion.");
  if (registration.session.revision() !== input.expectedRevision) return {
    ok: false, changed: false, code: "stale-target", message: "The equation revision changed. Read the current paragraph again.",
    revision: registration.session.revision(), document: state(registration), warnings: [],
  };
  let display = input.display ?? false;
  if (input.objectRef) {
    const paragraph = registration.session.listParagraphHandles().find((handle) => handle.ref === input.paragraphRef);
    const atom = paragraph && registration.session.readParagraph(paragraph).atoms.find((item) => item.objectRef === input.objectRef);
    const payload = atom?.payload as { source?: { display?: boolean } } | undefined;
    const source = payload?.source;
    if (source?.display !== undefined) display = input.display ?? source.display;
  }
  const { compileDocxEquation, DocxEquationConversionError } = await import("@/lib/docx-equation-conversion");
  let compiled: CompiledDocxEquation;
  try {
    compiled = await compileDocxEquation({ ...input, display });
  } catch (error) {
    if (!(error instanceof DocxEquationConversionError)) throw error;
    return { ok: false, changed: false, code: error.code, message: error.message,
      revision: registration.session.revision(), document: state(registration), warnings: [...error.diagnostics] };
  }
  if (context?.signal?.aborted) throw new Error("The equation write was cancelled before mutation.");
  assertAttribution(context);
  await beforeCommit?.();
  const latest = currentRegistration(registration);
  if (context?.signal?.aborted) throw new Error("The equation write was cancelled before mutation.");
  const result = write(input, compiled);
  return { ...result, document: state(latest), warnings: compiled.warnings,
    ...(result.ok ? { sourceHash: compiled.sourceHash } : {}) };
}

export const DOCX_AGENT_HOST: DocxToolsHost = {
  workspaceContext: async () => getDocxWorkspaceContext(),
  revealWorkingCopy: async (input) => {
    const registration = registrationFor(input.sessionId);
    if (input.expectedRevision !== undefined && registration.session.revision() !== input.expectedRevision) throw new Error("The Word navigation revision changed.");
    if (input.paragraphRef) paragraphIndex(registration, input.paragraphRef);
    if (!registration.reveal) throw new Error("Word navigation is unavailable for this working copy.");
    return { document: document(registration), navigation: "requested" as const };
  },
  prepareFonts: async (sessionId) => {
    const registration = registrationFor(sessionId);
    if (!registration.prepareFonts) throw new Error("Word font preparation is unavailable for this working copy.");
    return registration.prepareFonts();
  },
  exportDocument: async (sessionId) => {
    const registration = registrationFor(sessionId);
    if (!registration.exportDocument) throw new Error("Word export is unavailable for this working copy.");
    return registration.exportDocument();
  },
  listDocuments: async () =>
    [...sessions.values()]
      .filter(
        (registration) =>
          registration.appProjectId === useFilesStore.getState().projectId,
      )
      .map(document),
  readDocument: async (query) => readDocumentPage(registrationFor(query?.sessionId), query),
  writeEquation: (input, context) => performEquationWrite(registrationFor(input.sessionId), input, context),
  replaceTextRange: async (input, context) => {
    assertAttribution(context);
    if (context?.signal?.aborted)
      throw new Error("The DOCX text replacement was cancelled before mutation.");
    const registration = registrationFor(input.sessionId);
    const paragraph = registration.session.listParagraphHandles()
      .find((handle) => handle.ref === input.paragraphRef);
    if (!paragraph)
      throw new Error(`Paragraph ${input.paragraphRef} is not present in this DOCX session.`);
    if (!registration.session.replaceParagraphRange)
      throw new Error("Safe DOCX text-range editing is unavailable for this working copy.");
    const result = registration.session.replaceParagraphRange({
      paragraphRef: input.paragraphRef,
      expectedRevision: input.expectedRevision,
      modelRange: input.range,
      expectedText: input.expectedText,
      text: input.replacement,
    });
    return {
      ...result,
      document: state(registration),
    } satisfies DocxTextRangeReplaceResult;
  },
  captureTarget: async (sessionId, paragraphRef) => {
    const registration = registrationFor(sessionId);
    return capture(registration, paragraphRef).view;
  },
  inspectTarget: async (targetId) => {
    const { registration, record } = targetFor(targetId);
    const current = registration.session.captureTarget(record.paragraph);
    if (
      current.original !== record.original ||
      current.structure !== record.structure
    ) {
      throw new Error("The DOCX suggestion target changed since it was captured.");
    }
    return targetView(registration, targetId, record);
  },
  suggestChange: async (input, context) => {
    assertAttribution(context);
    const registration = registrationFor(input.sessionId);
    if (generations.has(registration.sessionId) || registration.canPresentSuggestion?.() === false) {
      throw new Error("A DOCX suggestion is already streaming.");
    }
    const index = paragraphIndex(registration, input.paragraphRef);
    const paragraphs = registration.session.listParagraphs();
    const captured = registration.session.captureTarget(paragraphs[index].handle);
    if (
      input.expectedRevision !== undefined &&
      captured.revision !== input.expectedRevision
    ) {
      throw new Error(
        `DOCX target changed: expected revision ${input.expectedRevision}, current revision ${captured.revision}.`,
      );
    }
    const controller = new AbortController();
    generations.set(registration.sessionId, controller);
    const abort = () => controller.abort();
    context?.signal?.addEventListener("abort", abort, { once: true });
    if (context?.signal?.aborted) controller.abort();
    const stopWatching = registration.session.subscribe(() => {
      try {
        const current = registration.session.captureTarget(captured.paragraph);
        if (current.original !== captured.original || current.structure !== captured.structure) controller.abort();
      } catch {
        controller.abort();
      }
    });
    let published = false;
    let proposed = "";
    const publish = (text: string, phase: "streaming" | "reviewing" | "withdrawn") =>
      registration.onSuggestion?.({ target: captured, proposed: text, phase, controller });
    try {
      publish("", "streaming");
      published = true;
      proposed = await runInlineCompletion({
        instruction: input.instruction.trim(),
        selection: captured.original,
        context: {
          before: paragraphs[index - 1]?.text ?? "",
          after: paragraphs[index + 1]?.text ?? "",
        },
        signal: controller.signal,
        onToken: (full) => {
          if (controller.signal.aborted) return;
          proposed = full;
          publish(full, "streaming");
          context?.onToken?.(full);
        },
      });
      if (controller.signal.aborted) {
        throw new Error("The DOCX request was cancelled or its target changed.");
      }
      const latest = currentRegistration(registration);
      const current = latest.session.captureTarget(captured.paragraph);
      if (
        current.original !== captured.original ||
        current.structure !== captured.structure
      ) {
        throw new Error("The DOCX target changed while the suggestion was generated.");
      }
      publish(proposed, "reviewing");
      return {
        target: targetFrom(latest, current).view,
        proposed,
        document: state(latest),
      } satisfies DocxSuggestionResult;
    } catch (cause) {
      if (published) publish(proposed, "withdrawn");
      throw cause;
    } finally {
      stopWatching();
      context?.signal?.removeEventListener("abort", abort);
      if (generations.get(registration.sessionId) === controller) {
        generations.delete(registration.sessionId);
      }
    }
  },
  applySuggestion: async (input, context) => {
    assertAttribution(context);
    if (context?.signal?.aborted) {
      throw new Error("The DOCX request was cancelled before mutation.");
    }
    const { registration, record } = targetFor(input.targetId);
    if (record.revision !== input.expectedRevision) {
      return {
        ok: false,
        code: "stale-target",
        message: "The expected revision does not match the captured DOCX target.",
        changed: false,
        document: state(registration),
      } satisfies DocxSuggestionApplyResult;
    }
    const target: DocxTarget = {
      paragraph: record.paragraph,
      original: record.original,
      revision: record.revision,
      ...(record.paraId === undefined ? {} : { paraId: record.paraId }),
      ...(record.structure === undefined ? {} : { structure: record.structure }),
    };
    const result = registration.session.applySuggestion(target, input.text);
    if (result.ok) registration.onApplied?.(target, input.text);
    return {
      ...result,
      document: state(registration),
    } satisfies DocxSuggestionApplyResult;
  },
  readFormat: async (sessionId, query) => {
    const registration = registrationFor(sessionId);
    if (!registration.readFormat) throw new Error("Live DOCX formatting reads are unavailable for this working copy.");
    if (query.paragraphRef) paragraphIndex(registration, query.paragraphRef);
    return registration.readFormat(query);
  },
  readImage: async (
    sessionId: string | undefined,
    input: DocxImageReadRequest,
  ): Promise<DocxImageReadHostResult> => {
    const registration = registrationFor(sessionId);
    if (!registration.session.readImage) {
      throw new Error("Live DOCX image reading is unavailable for this working copy.");
    }
    paragraphIndex(registration, input.paragraphRef);
    if (registration.session.revision() !== input.expectedRevision) {
      throw new Error(
        `DOCX image revision changed: expected ${input.expectedRevision}, current ${registration.session.revision()}.`,
      );
    }
    const result = registration.session.readImage(input);
    currentRegistration(registration);
    if (
      registration.session.revision() !== input.expectedRevision ||
      result.revision !== input.expectedRevision ||
      result.objectRef !== input.objectRef
    ) {
      throw new Error("The DOCX image changed while its embedded pixels were being read.");
    }
    const imageSha256 = await docxContentSha256(result.bytes);
    const current = currentRegistration(registration);
    if (
      current.session.revision() !== input.expectedRevision ||
      current.baselineId !== registration.baselineId ||
      current.sourceSha256 !== registration.sourceSha256
    ) {
      throw new Error("The DOCX image changed while its pixels were being hashed.");
    }
    return {
      ...result,
      imageSha256,
      document: document(current),
      sourceSha256: current.sourceSha256,
    };
  },
  formatParagraph: async (sessionId, paragraphRef, expectedRevision, format, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.session.formatParagraph) throw new Error("Live DOCX formatting is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX format request was cancelled before mutation.");
    const index = paragraphIndex(registration, paragraphRef);
    const paragraph = registration.session.listParagraphs()[index];
    const result = registration.session.formatParagraph(paragraph.handle, expectedRevision, format);
    return { ...result, document: state(registration) } satisfies DocxSuggestionApplyResult;
  },
  formatObject: async (sessionId, paragraphRef, expectedRevision, format, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.session.formatObject) throw new Error("Live DOCX object formatting is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX format request was cancelled before mutation.");
    const paragraph = registration.session.listParagraphs()[paragraphIndex(registration, paragraphRef)];
    const result = registration.session.formatObject(paragraph.handle, expectedRevision, format);
    return { ...result, document: state(registration) } satisfies DocxSuggestionApplyResult;
  },
  formatBatch: async (sessionId, expectedRevision, operations, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.session.formatBatch) throw new Error("Atomic DOCX formatting is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX format request was cancelled before mutation.");
    const paragraphs = registration.session.listParagraphs();
    const resolved = operations.map(({ paragraphRef, ...format }) => {
      const paragraph = paragraphs.find((item) => item.handle.ref === paragraphRef);
      if (!paragraph) throw new Error(`Paragraph ${paragraphRef} is not present in this DOCX session.`);
      return { target: paragraph.handle, ...format };
    });
    const result = registration.session.formatBatch(resolved, expectedRevision);
    return { ...result, document: state(registration) } satisfies DocxSuggestionApplyResult;
  },
  importTemplateStyles: async (sessionId, template, styleIds, expectedRevision, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.session.importTemplateStyles) throw new Error("DOCX template style import is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX style import was cancelled before mutation.");
    const source = await loadTemplateSource(template);
    currentRegistration(registration);
    if (context?.signal?.aborted) throw new Error("The DOCX style import was cancelled before mutation.");
    const result = registration.session.importTemplateStyles(source.bytes, styleIds, expectedRevision);
    return { ...result, document: state(registration), template, templateSourceSha256: source.sourceSha256 } satisfies DocxTemplateStyleImportResult;
  },
  saveDocument: async (sessionId, expectedRevision, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.save) throw new Error("Live DOCX saving is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX save request was cancelled before it started.");
    if (registration.session.revision() !== expectedRevision) {
      throw new Error(`DOCX save revision changed: expected ${expectedRevision}, current ${registration.session.revision()}.`);
    }
    const result = await registration.save({
      expectedRevision,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return applySaveReceipt(registration, expectedRevision, result).result;
  },
  checkTemplate: async (sessionId, template, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.check) throw new Error("Explicit DOCX template checking is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX template check was cancelled before it started.");
    const before = document(registration);
    assertSavedForCheck(registration);
    const result = await registration.check({
      template,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const current = document(currentRegistration(registration));
    if (current.sessionRevision !== before.sessionRevision || current.savedRevision !== before.savedRevision ||
      current.baselineId !== before.baselineId || current.sourceSha256 !== before.sourceSha256) {
      throw new Error("The DOCX working copy changed while its saved baseline was being checked. Read the current document before checking again.");
    }
    assertTemplateCheckReceipt(before, template, result);
    return compactTemplateCheck(result);
  },
};

export interface DocxTaskScope {
  projectId: string;
  workbenchProjectId: string | null;
  operationId?: string;
  origin?: Extract<AgentExecutionOrigin, { kind: "task" }>;
  /** Revalidate the native task after preparation, before starting a side effect. */
  beforeCommit?(): Promise<void>;
}

function taskRegistration(scope: DocxTaskScope, sessionId?: string): RegisteredDocxSession {
  const matching = [...sessions.values()].filter((item) =>
    item.appProjectId === scope.projectId && (scope.workbenchProjectId === null || item.workbenchProjectId === scope.workbenchProjectId) &&
    (sessionId === undefined || item.sessionId === sessionId));
  if (matching.length !== 1) throw new Error("The task's DOCX working copy is unavailable or ambiguous.");
  return matching[0];
}

async function authorizeTaskCommit(scope: DocxTaskScope, registration: RegisteredDocxSession) {
  await scope.beforeCommit?.();
  if (taskRegistration(scope, registration.sessionId).session !== registration.session) {
    throw new Error("The DOCX session closed or changed before the task operation started.");
  }
}

export function docxTaskDocument(scope: DocxTaskScope, sessionId?: string): DocxDocumentIdentity {
  const registration = taskRegistration(scope, sessionId);
  return taskDocument(registration);
}

export async function settleTaskDocxOperation(
  scope: DocxTaskScope, operationId: string, sessionId?: string,
): Promise<void> {
  await taskRegistration(scope, sessionId).onTaskOperationRecorded?.(operationId);
}

export interface DocxTaskReadFormatArgs { query: DocxFormatReadQuery }
export type DocxTaskReadArgs = DocxReadQuery;
export interface DocxTaskReplaceRangeArgs {
  paragraphRef: string;
  expectedRevision: number;
  range: DocxModelRange;
  expectedText: string;
  replacement: string;
}
export type DocxTaskFormatArgs = {
  paragraphRef: string; expectedRevision: number;
} & ({ format: DocxFormatMutation; objectFormat?: never } | { format?: never; objectFormat: DocxObjectFormatMutation });
export interface DocxTaskFormatBatchArgs { expectedRevision: number; operations: DocxFormatBatchItem[] }
export interface DocxTaskStyleImportArgs { expectedRevision: number; template: string; styleIds: string[] }
export interface DocxTaskApplyArgs {
  targetId: string; expectedRevision: number; text: string;
}
export interface DocxTaskSaveArgs { expectedRevision: number }
export interface DocxTaskCheckArgs { template: string }
export interface DocxTaskRevealArgs { paragraphRef?: string; expectedRevision?: number }
export type DocxTaskEquationArgs = Omit<DocxEquationWriteRequest, "sessionId">;

export type DocxTaskOperation = "read_format" | "replace_range" | "write_equation" | "format" | "format_batch" | "import_styles" | "apply" | "save" | "check" | "context" | "reveal" | "prepare_fonts" | "export";
export type DocxTaskOperationArgs =
  | DocxTaskReadFormatArgs | DocxTaskReplaceRangeArgs | DocxTaskFormatArgs | DocxTaskFormatBatchArgs | DocxTaskApplyArgs
  | DocxTaskSaveArgs | DocxTaskCheckArgs | DocxTaskStyleImportArgs | DocxTaskRevealArgs | DocxTaskEquationArgs;
export type DocxTaskOperationResult = (
  | { operation: "context" | "reveal" | "prepare_fonts" | "export"; ok: true; document: DocxDocumentIdentity; result: unknown }
  | {
      operation: "read_format"; ok: true; document: DocxDocumentIdentity;
      result: DocxFormatReadResult;
    }
  | {
      operation: "replace_range"; ok: boolean; document: DocxDocumentIdentity;
      result: DocxTextRangeReplaceResult;
    }
  | {
      operation: "write_equation"; ok: boolean; document: DocxDocumentIdentity;
      result: DocxEquationWriteResult;
    }
  | {
      operation: "format" | "format_batch" | "apply"; ok: boolean; document: DocxDocumentIdentity;
      result: DocxApplyResult;
    }
  | {
      operation: "save"; ok: boolean; document: DocxDocumentIdentity;
      result: DocxSaveResult;
    }
  | {
      operation: "import_styles"; ok: boolean; document: DocxDocumentIdentity;
      result: DocxTemplateStyleImportResult;
    }
  | {
      operation: "check"; ok: true; document: DocxDocumentIdentity;
      result: DocxTemplateCheckResult;
    }) & { checkpoint?: { status: "recorded" | "failed"; error?: string }; message?: string };

async function checkpointTaskOperation(
  scope: DocxTaskScope,
  registration: RegisteredDocxSession,
  result: DocxTaskOperationResult,
): Promise<DocxTaskOperationResult> {
  if (!scope.operationId || result.operation === "read_format") return result;
  if (!registration.onTaskOperation) {
    return { ...result, checkpoint: { status: "failed", error: "The DOCX operation checkpoint is unavailable." } };
  }
  try {
    const receipt = result.operation === "check" ? {
      ...result,
      result: { template: result.result.template, check: Object.fromEntries(
        ["check_id", "project_id", "baseline_id", "world_version_id", "source_sha256", "validity", "summary", "objectRead", "findingsRead"].filter((key) => result.result.check[key] !== undefined).map(
          (key) => [key, result.result.check[key]],
        ),
      ) },
    } : result;
    await registration.onTaskOperation({ operationId: scope.operationId, document: result.document, result: receipt });
    return { ...result, checkpoint: { status: "recorded" } };
  } catch (cause) {
    return { ...result, checkpoint: { status: "failed", error: String(cause) } };
  }
}

export function runTaskDocxOperation(
  scope: DocxTaskScope, sessionId: string | undefined,
  operation: "context" | "reveal" | "prepare_fonts" | "export", args: DocxTaskRevealArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "context" | "reveal" | "prepare_fonts" | "export" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope, sessionId: string | undefined,
  operation: "write_equation", args: DocxTaskEquationArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "write_equation" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "read_format",
  args: DocxTaskReadFormatArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "read_format" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "replace_range",
  args: DocxTaskReplaceRangeArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "replace_range" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "format",
  args: DocxTaskFormatArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "format" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "format_batch",
  args: DocxTaskFormatBatchArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "format" | "format_batch" | "apply" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "import_styles",
  args: DocxTaskStyleImportArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "import_styles" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "apply",
  args: DocxTaskApplyArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "apply" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "save",
  args: DocxTaskSaveArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "save" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "check",
  args: DocxTaskCheckArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "check" }>>;
export async function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: DocxTaskOperation,
  args: DocxTaskOperationArgs,
): Promise<DocxTaskOperationResult> {
  const registration = taskRegistration(scope, sessionId);
  const paragraphRef = "paragraphRef" in args ? args.paragraphRef :
    "operations" in args ? args.operations[0]?.paragraphRef :
    "targetId" in args ? targets.get(args.targetId)?.paragraph.ref : undefined;
  return reportDocxOperation(registration, operation, scope.origin ?? { kind: "external", flowId: scope.operationId ?? crypto.randomUUID() },
    () => executeTaskDocxOperation(scope, registration, operation, args), paragraphRef, scope.operationId);
}

async function executeTaskDocxOperation(
  scope: DocxTaskScope, registration: RegisteredDocxSession,
  operation: DocxTaskOperation, args: DocxTaskOperationArgs,
): Promise<DocxTaskOperationResult> {
  if (scope.beforeCommit && operation !== "context" && operation !== "read_format" && operation !== "import_styles" && operation !== "write_equation") {
    await authorizeTaskCommit(scope, registration);
  }
  if (operation === "context") {
    const context = getDocxWorkspaceContext(scope.projectId);
    context.writable = context.writable.filter((item) => item.sessionId === registration.sessionId);
    context.capabilities = context.capabilities?.filter((item) => item.sessionId === registration.sessionId);
    context.journalTemplates = context.journalTemplates?.filter((item) => item.sessionId === registration.sessionId);
    if (context.selectionWriteTarget?.sessionId !== registration.sessionId) context.selectionWriteTarget = null;
    return { operation, ok: true, document: docxTaskDocument(scope, registration.sessionId), result: context };
  }
  if (operation === "reveal" || operation === "prepare_fonts" || operation === "export") {
    let result: unknown;
    if (operation === "reveal") result = await DOCX_AGENT_HOST.revealWorkingCopy!({
      sessionId: registration.sessionId, ...(args as DocxTaskRevealArgs),
    });
    else if (operation === "prepare_fonts") result = await DOCX_AGENT_HOST.prepareFonts!(registration.sessionId);
    else result = await DOCX_AGENT_HOST.exportDocument!(registration.sessionId);
    return { operation, ok: true, document: docxTaskDocument(scope, registration.sessionId), result };
  }
  if (operation === "read_format") {
    if (!registration.readFormat) throw new Error("Live DOCX formatting reads are unavailable for this working copy.");
    const document = taskDocument(registration);
    const result = await registration.readFormat((args as DocxTaskReadFormatArgs).query);
    if (taskRegistration(scope, registration.sessionId).session !== registration.session ||
        registration.session.revision() !== document.sessionRevision) {
      throw new Error("The DOCX session closed or changed while its formatting was read.");
    }
    return { operation, ok: true, document, result };
  }
  if (operation === "replace_range") {
    const input = args as DocxTaskReplaceRangeArgs;
    if (!DOCX_AGENT_HOST.replaceTextRange)
      throw new Error("Safe DOCX text-range editing is unavailable for this working copy.");
    const result = await DOCX_AGENT_HOST.replaceTextRange({
      sessionId: registration.sessionId,
      paragraphRef: input.paragraphRef,
      expectedRevision: input.expectedRevision,
      range: input.range,
      expectedText: input.expectedText,
      replacement: input.replacement,
    }, { signal: undefined });
    return checkpointTaskOperation(scope, registration, {
      operation, ok: result.ok, document: docxTaskDocument(scope, registration.sessionId), result,
    }) as Promise<Extract<DocxTaskOperationResult, { operation: "replace_range" }>>;
  }
  if (operation === "write_equation") {
    const result = await performEquationWrite(registration, args as DocxTaskEquationArgs, undefined,
      () => authorizeTaskCommit(scope, registration));
    return checkpointTaskOperation(scope, registration, {
      operation, ok: result.ok, document: docxTaskDocument(scope, registration.sessionId), result,
    });
  }
  if (operation === "format") {
    const input = args as DocxTaskFormatArgs;
    const paragraph = registration.session.listParagraphs().find(
      (item) => item.handle.ref === input.paragraphRef,
    );
    if (!paragraph) throw new Error(`Paragraph ${input.paragraphRef} is not present in this DOCX session.`);
    let result: DocxApplyResult;
    if (input.objectFormat) {
      if (!registration.session.formatObject) throw new Error("Live DOCX object formatting is unavailable for this working copy.");
      result = registration.session.formatObject(paragraph.handle, input.expectedRevision, input.objectFormat);
    } else {
      if (!registration.session.formatParagraph) throw new Error("Live DOCX formatting is unavailable for this working copy.");
      result = registration.session.formatParagraph(paragraph.handle, input.expectedRevision, input.format);
    }
    return checkpointTaskOperation(scope, registration, {
      operation, ok: result.ok, document: docxTaskDocument(scope, registration.sessionId), result,
    }) as Promise<Extract<DocxTaskOperationResult, { operation: "format" }>>;
  }
  if (operation === "format_batch") {
    const input = args as DocxTaskFormatBatchArgs;
    if (!registration.session.formatBatch) throw new Error("Atomic DOCX formatting is unavailable for this working copy.");
    const paragraphs = registration.session.listParagraphs();
    const resolved = input.operations.map(({ paragraphRef, ...format }) => {
      const paragraph = paragraphs.find((item) => item.handle.ref === paragraphRef);
      if (!paragraph) throw new Error(`Paragraph ${paragraphRef} is not present in this DOCX session.`);
      return { target: paragraph.handle, ...format };
    });
    const result = registration.session.formatBatch(resolved, input.expectedRevision);
    return checkpointTaskOperation(scope, registration, {
      operation, ok: result.ok, document: docxTaskDocument(scope, registration.sessionId), result,
    });
  }
  if (operation === "import_styles") {
    const input = args as DocxTaskStyleImportArgs;
    if (!registration.session.importTemplateStyles) throw new Error("DOCX template style import is unavailable for this working copy.");
    const source = await loadTemplateSource(input.template);
    await authorizeTaskCommit(scope, registration);
    const result = registration.session.importTemplateStyles(source.bytes, input.styleIds, input.expectedRevision);
    return checkpointTaskOperation(scope, registration, {
      operation, ok: result.ok, document: docxTaskDocument(scope, registration.sessionId),
      result: { ...result, document: state(registration), template: input.template, templateSourceSha256: source.sourceSha256 },
    });
  }
  if (operation === "apply") {
    const input = args as DocxTaskApplyArgs;
    validateTaskDocxProposal(scope, input.targetId, input.expectedRevision, input.text, registration.sessionId);
    const record = targets.get(input.targetId);
    if (!record) throw new Error("The DOCX target is no longer available. Capture a fresh target.");
    const latest = taskRegistration(scope, record.sessionId);
    const target: DocxTarget = { paragraph: record.paragraph, original: record.original,
      revision: record.revision, ...(record.paraId ? { paraId: record.paraId } : {}),
      ...(record.structure ? { structure: record.structure } : {}) };
    const result = latest.session.applySuggestion(target, input.text);
    if (result.ok) latest.onApplied?.(target, input.text);
    return checkpointTaskOperation(scope, latest, {
      operation, ok: result.ok, document: docxTaskDocument(scope, latest.sessionId), result,
    }) as Promise<Extract<DocxTaskOperationResult, { operation: "apply" }>>;
  }
  if (operation === "save") {
    if (!registration.save) throw new Error("Live DOCX saving is unavailable for this working copy.");
    const input = args as DocxTaskSaveArgs;
    if (registration.session.revision() !== input.expectedRevision) {
      throw new Error(`DOCX save revision changed: expected ${input.expectedRevision}, current ${registration.session.revision()}.`);
    }
    const document = docxTaskDocument(scope, registration.sessionId);
    const receipt = applySaveReceipt(
      registration,
      input.expectedRevision,
      await registration.save({
        expectedRevision: input.expectedRevision,
        ...(scope.operationId ? { operation: { operationId: scope.operationId, document } } : {}),
      }),
    );
    const latest = receipt.registration;
    return {
      operation,
      ok: !receipt.mismatch,
      ...(receipt.mismatch ? { message: receipt.mismatch.message } : {}),
      document: taskDocument(latest),
      result: receipt.result,
    } as Extract<DocxTaskOperationResult, { operation: "save" }>;
  }
  if (!registration.check) throw new Error("Explicit DOCX template checking is unavailable for this working copy.");
  const input = args as DocxTaskCheckArgs;
  if (!input.template.trim()) throw new Error("template must be an explicit world version ID.");
  const document = docxTaskDocument(scope, registration.sessionId);
  assertSavedForCheck(registration);
  const result = await registration.check({ template: input.template });
  const current = liveDocument(registration);
  if (current.sessionRevision !== document.sessionRevision || current.savedRevision !== document.savedRevision ||
    current.baselineId !== document.baselineId || current.sourceSha256 !== document.sourceSha256) {
    throw new Error("The DOCX working copy changed while its saved baseline was being checked. Read the current document before checking again.");
  }
  assertTemplateCheckReceipt(document, input.template, result);
  return checkpointTaskOperation(scope, registration, {
    operation, ok: true, document, result: compactTemplateCheck(result),
  }) as Promise<Extract<DocxTaskOperationResult, { operation: "check" }>>;
}

export function listTaskDocxDocuments(scope: DocxTaskScope, sessionId?: string) {
  return [...sessions.values()].filter((item) => item.appProjectId === scope.projectId &&
    item.workbenchProjectId === scope.workbenchProjectId && (sessionId === undefined || item.sessionId === sessionId)).map((item) => docxTaskDocument(scope, item.sessionId));
}

export function readTaskDocxDocument(scope: DocxTaskScope, sessionId?: string, offset = 0, limit = 20) {
  const registration = taskRegistration(scope, sessionId);
  return readDocumentPage(registration, { ...(sessionId ? { sessionId } : {}), offset, limit });
}

export function readTaskDocxDocumentPage(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  query: DocxReadQuery,
) {
  return readDocumentPage(taskRegistration(scope, sessionId), { ...query, sessionId });
}

export function readTaskDocxImage(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  input: DocxImageReadRequest,
): Promise<DocxImageReadHostResult> {
  const registration = taskRegistration(scope, sessionId);
  if (!DOCX_AGENT_HOST.readImage) {
    throw new Error("Live DOCX image reading is unavailable for this working copy.");
  }
  return DOCX_AGENT_HOST.readImage(registration.sessionId, input);
}

export function captureTaskDocxTarget(scope: DocxTaskScope, sessionId: string | undefined, paragraphRef: string) {
  const registration = taskRegistration(scope, sessionId);
  const view = capture(registration, paragraphRef).view;
  return { document: docxTaskDocument(scope, registration.sessionId), target: {
    targetId: view.targetId, paragraphRef: view.paragraphRef, revision: view.revision,
    original: view.text, paraId: view.paraId, structure: view.structure,
  } };
}

export function validateTaskDocxProposal(scope: DocxTaskScope, targetId: string, expectedRevision: number, text: string, sessionId?: string) {
  const record = targets.get(targetId);
  if (!record) throw new Error("The DOCX target is no longer available. Capture a fresh target.");
  if (sessionId !== undefined && sessionId !== record.sessionId) throw new Error("The DOCX target belongs to another session.");
  const registration = taskRegistration(scope, record.sessionId);
  if (record.revision !== expectedRevision) throw new Error("The DOCX target revision changed.");
  const target = registration.session.captureTarget(record.paragraph);
  if (target.original !== record.original || target.structure !== record.structure)
    throw new Error("The DOCX target changed. Capture a fresh target.");
  if (generations.has(registration.sessionId) || registration.canPresentSuggestion?.() === false)
    throw new Error("A DOCX suggestion is already awaiting review.");
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) throw new Error("The DOCX proposal exceeds 32 KiB.");
  return { document: docxTaskDocument(scope, registration.sessionId), target: {
    targetId, paragraphRef: record.paragraph.ref, revision: record.revision, original: record.original,
    paraId: record.paraId, structure: record.structure,
  } };
}

export function presentTaskDocxProposal(scope: DocxTaskScope, activity: DocxActivity): void {
  if (activity.event.type !== "runtime" || activity.event.event.kind !== "proposed")
    throw new Error("Only a retained DOCX proposal can be presented.");
  const { target, proposed } = activity.event.event;
  const current = validateTaskDocxProposal(scope, target.targetId, target.revision, proposed);
  const identity = activity.document;
  if (identity.sessionId !== current.document.sessionId || identity.appProjectId !== scope.projectId ||
    identity.workbenchProjectId !== scope.workbenchProjectId || identity.baselineId !== current.document.baselineId ||
    identity.sourceSha256 !== current.document.sourceSha256 || target.original !== current.target.original ||
    target.structure !== current.target.structure || target.paragraphRef !== current.target.paragraphRef)
    throw new Error("The retained DOCX proposal belongs to a different working copy.");
  const registration = taskRegistration(scope, identity.sessionId);
  if (!registration.onTaskSuggestion) throw new Error("The DOCX review surface is unavailable.");
  const targetRecord = targets.get(target.targetId);
  if (!targetRecord) throw new Error("The DOCX target is no longer available.");
  registration.onTaskSuggestion(activity, { paragraph: targetRecord.paragraph, original: targetRecord.original,
    revision: targetRecord.revision, paraId: targetRecord.paraId, structure: targetRecord.structure });
}

export function registerDocxAgentSession(
  registration: DocxAgentRegistration,
): RegisteredDocxSession {
  const previous = sessions.get(registration.sessionId);
  if (previous) {
    throw new Error(`DOCX session ${registration.sessionId} is already registered.`);
  }
  const registered: RegisteredDocxSession = { ...registration };
  sessions.set(registration.sessionId, registered);
  if (registration.appProjectId === useFilesStore.getState().projectId) {
    activeSessionId = registration.sessionId;
  }
  sessionSubscriptions.set(
    registration.sessionId,
    registration.session.subscribe(notify),
  );
  notify();
  return registered;
}

export function updateDocxAgentSession(
  sessionId: string,
  update: { baselineId?: string; savedRevision?: number; sourceSha256?: string },
): void {
  const registration = registrationFor(sessionId);
  const next: RegisteredDocxSession = { ...registration, ...update };
  sessions.set(sessionId, next);
  notify();
}

export function unregisterDocxAgentSession(sessionId: string): RegisteredDocxSession | undefined {
  const registration = sessions.get(sessionId);
  if (!registration) return;
  generations.get(sessionId)?.abort();
  sessionSubscriptions.get(sessionId)?.();
  sessionSubscriptions.delete(sessionId);
  sessions.delete(sessionId);
  for (const [targetId, target] of targets) {
    if (target.sessionId === sessionId) targets.delete(targetId);
  }
  if (activeSessionId === sessionId) {
    activeSessionId = [...sessions.values()]
      .filter(
        (candidate) =>
          candidate.appProjectId === useFilesStore.getState().projectId,
      )
      .at(-1)?.sessionId ?? null;
  }
  notify();
  return registration;
}

export function createDocxAgentTools(
  opts?: DocxToolsOptions,
) {
  const candidateRefusals = new Map<string, DocxFormatCandidateRefusal>();
  const externalFlowId = crypto.randomUUID();
  const origin = () => {
    const value = ordinaryOrigin(opts);
    return value.kind === "external" ? { ...value, flowId: opts?.runId?.() ?? externalFlowId } : value;
  };
  const assertChatRead = () => {
    opts?.signal?.throwIfAborted();
    if (origin().kind !== "chat") throw new Error("This chat no longer owns the Word session.");
  };
  const perform = <T,>(sessionId: string | undefined, operation: string, action: () => Promise<T>, paragraphRef?: string) =>
    reportDocxOperation(registrationFor(sessionId), operation, origin(), action, paragraphRef);
  const assertDirectFormattingAllowed = (registration: RegisteredDocxSession): void => {
    const templates = registration.getFormatCandidateTemplates?.();
    if (origin().kind === "chat" && (templates?.selected || templates?.bound)) {
      throw new Error(
        "This Word document has a selected journal template. Use create_docx_format_candidate so the formatting stays in an isolated candidate; direct live formatting is disabled in ordinary chat.",
      );
    }
  };
  const host: DocxToolsHost = {
    ...DOCX_AGENT_HOST,
    revealWorkingCopy: (input) => perform(input.sessionId, "reveal", () => DOCX_AGENT_HOST.revealWorkingCopy!(input), input.paragraphRef),
    prepareFonts: (sessionId) => perform(sessionId, "prepare_fonts", () => DOCX_AGENT_HOST.prepareFonts!(sessionId)),
    exportDocument: (sessionId) => perform(sessionId, "export", () => DOCX_AGENT_HOST.exportDocument!(sessionId)),
    applySuggestion: (input, context) => {
      const target = targetFor(input.targetId);
      return perform(target.registration.sessionId, "apply", () => DOCX_AGENT_HOST.applySuggestion(input, context), target.record.paragraph.ref);
    },
    formatParagraph: (sessionId, paragraphRef, revision, format, context) => perform(sessionId, "format", () => {
      assertDirectFormattingAllowed(registrationFor(sessionId));
      return DOCX_AGENT_HOST.formatParagraph!(sessionId, paragraphRef, revision, format, context);
    }, paragraphRef),
    formatObject: (sessionId, paragraphRef, revision, format, context) => perform(sessionId, "format", () => {
      assertDirectFormattingAllowed(registrationFor(sessionId));
      return DOCX_AGENT_HOST.formatObject!(sessionId, paragraphRef, revision, format, context);
    }, paragraphRef),
    formatBatch: (sessionId, revision, operations, context) => perform(sessionId, "format_batch", () => {
      assertDirectFormattingAllowed(registrationFor(sessionId));
      return DOCX_AGENT_HOST.formatBatch!(sessionId, revision, operations, context);
    }, operations[0]?.paragraphRef),
    importTemplateStyles: (sessionId, template, styleIds, revision, context) => perform(sessionId, "import_styles", () => {
      assertDirectFormattingAllowed(registrationFor(sessionId));
      return DOCX_AGENT_HOST.importTemplateStyles!(sessionId, template, styleIds, revision, context);
    }),
    listJournalTemplates: async () => journalTemplates(await journalRequest<JournalState>("/api/state")).map(describeDocxFormatTemplate),
    readSavedContent: async (sessionId, query) => {
      assertChatRead();
      const registration = registrationFor(sessionId);
      const result = await invoke("journal_docx_content_for_agent", {
        projectId: registration.workbenchProjectId, sessionId,
        baselineId: registration.baselineId, sourceSha256: registration.sourceSha256, query,
      });
      assertChatRead();
      currentRegistration(registration);
      return result;
    },
    readTemplateStyles: async (sessionId, query) => {
      assertChatRead();
      const registration = registrationFor(sessionId);
      const result = await invoke("journal_docx_template_styles_for_agent", {
        projectId: registration.workbenchProjectId, sessionId, query,
      });
      assertChatRead();
      currentRegistration(registration);
      return result;
    },
    readTemplateCheck: async (sessionId, query) => {
      assertChatRead();
      const registration = registrationFor(sessionId);
      const result = await invoke<Record<string, unknown>>("journal_docx_check_for_agent", {
        projectId: registration.workbenchProjectId, sessionId, query,
      });
      assertChatRead();
      const current = currentRegistration(registration);
      if (result.operation !== "status") return result;
      return { ...result, document: document(current), selectedTemplate: current.getFormatCandidateTemplates?.().selected ?? null,
        candidateReviewRead: candidateReviewRead(sessionId) };
    },
    readCandidateReview: async (sessionId, query) => {
      assertChatRead();
      const registration = registrationFor(sessionId);
      const liveBasis = registration.getFormatCandidateBasis?.();
      const result = await invoke("journal_candidate_review_for_agent", {
        projectId: registration.workbenchProjectId, sessionId, query, ...(liveBasis ? { liveBasis } : {}),
      });
      assertChatRead();
      const after = currentRegistration(registration).getFormatCandidateBasis?.();
      if (liveBasis?.check_id !== after?.check_id || liveBasis?.matches !== after?.matches) {
        throw new Error("The Word candidate or its working copy changed during the read. Read the review again.");
      }
      return result;
    },
    prepareFormatCandidate: async (sessionId, worldVersionId, context) => {
      const registration = registrationFor(sessionId);
      if (origin().kind !== "chat") {
        throw new Error("The Word format candidate is available only in ordinary chat.");
      }
      if (!registration.prepareFormatCandidate) {
        throw new Error("The Word format candidate is unavailable for this working copy.");
      }
      if (context?.signal?.aborted) {
        throw new Error("The Word format candidate was cancelled before it started.");
      }
      const key = JSON.stringify([registration.sessionId, worldVersionId]);
      const previous = candidateRefusals.get(key);
      const workspaceRead = templateCheckRead(registration.sessionId);
      if (previous) return { ...previous, workspaceRead };
      return reportDocxOperation(registration, "format_candidate", origin(), async () => {
        try {
          const result = await registration.prepareFormatCandidate!({ worldVersionId, signal: context?.signal });
          return { ...result, document: liveDocument(registration), workspaceRead,
            reviewRead: candidateReviewRead(registration.sessionId, result.candidateCheckId) };
        } catch (cause) {
          if (!(cause instanceof JournalWorkbenchError)) throw cause;
          const conflict = ["baseline_conflict", "binding_conflict", "candidate_review_conflict"].includes(cause.detail.code);
          const refusal: DocxFormatCandidateRefusal = { ...cause.detail, ok: false,
            ...(conflict ? { status: "conflict" } : {}), retryable_with_same_params: false };
          candidateRefusals.set(key, refusal);
          return { ...refusal, workspaceRead };
        }
      });
    },
    replaceTextRange: (input, context) => perform(
      input.sessionId,
      "replace_range",
      () => DOCX_AGENT_HOST.replaceTextRange!(input, context),
      input.paragraphRef,
    ),
    writeEquation: (input, context) => perform(input.sessionId, "write_equation",
      () => DOCX_AGENT_HOST.writeEquation!(input, context), input.paragraphRef),
    saveDocument: (sessionId, revision, context) => perform(sessionId, "save",
      () => DOCX_AGENT_HOST.saveDocument!(sessionId, revision, context)),
    checkTemplate: (sessionId, template, context) => perform(sessionId, "check", async () => {
      const registration = registrationFor(sessionId);
      const result = await DOCX_AGENT_HOST.checkTemplate!(registration.sessionId, template, context);
      if (origin().kind !== "chat") return result;
      const objectRead = templateCheckRead(registration.sessionId, result.check.check_id);
      return { ...result, check: { ...result.check, objectRead,
        ...(result.check.template_comparison ? { findingsRead: { tool: objectRead.tool,
          arguments: { ...objectRead.arguments, operation: "finding_groups", offset: 0, limit: 20 } } } : {}),
        readBoundary: "Use objectRead for retained status and evidence, or page findingsRead for template differences. Neither operation runs a new check.",
      } };
    }),
  };
  const tools = createDocxTools(host, opts);
  if (origin().kind !== "chat") {
    const exposed = tools as Partial<typeof tools>;
    delete exposed.create_docx_format_candidate;
    delete exposed.read_docx_template_check;
    delete exposed.read_docx_candidate_review;
    delete exposed.read_docx_saved_content;
    delete exposed.read_docx_template_styles;
  }
  return tools;
}

export function subscribeDocxAgentSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetDocxAgentHostForTest(): void {
  for (const controller of generations.values()) controller.abort();
  generations.clear();
  for (const unsubscribe of sessionSubscriptions.values()) unsubscribe();
  sessionSubscriptions.clear();
  sessions.clear();
  targets.clear();
  listeners.clear();
  activeSessionId = null;
}

import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import {
  createDocxTools,
  type DocxActivityDocument,
  type DocxDocumentRead,
  type DocxDocumentState,
  type DocxFormatMutation,
  type DocxFormatReadQuery,
  type DocxFormatReadResult,
  type DocxOperationContext,
  type DocxSaveResult,
  type DocxSuggestionApplyResult,
  type DocxSuggestionResult,
  type DocxTargetView,
  type DocxTemplateCheckResult,
  type DocxToolsOptions,
  type DocxToolsHost,
} from "@oleafly/ai-tools";
import { runInlineCompletion } from "@/lib/ai-inline";
import type { DocxApplyResult, DocxSession, DocxTarget } from "@/lib/docx-session";
import type { DocxActivity, DocxDocumentIdentity } from "@/lib/docx-task-activity";
import { useFilesStore } from "@/store/files";

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
  readFormat?(query: DocxFormatReadQuery): Promise<DocxFormatReadResult>;
  save?(request: {
    expectedRevision: number;
    signal?: AbortSignal;
  }): Promise<DocxSaveResult>;
  check?(request: {
    template: string;
    signal?: AbortSignal;
  }): Promise<DocxTemplateCheckResult>;
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

function registrationFor(sessionId?: string): RegisteredDocxSession {
  const projectId = useFilesStore.getState().projectId;
  const projectSessions = [...sessions.values()].filter(
    (registration) => registration.appProjectId === projectId,
  );
  const id = sessionId ?? (
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

function capture(
  registration: RegisteredDocxSession,
  paragraphRef: string,
): { targetId: string; view: DocxTargetView } {
  const paragraphs = registration.session.listParagraphs();
  const paragraph = paragraphs.find((item) => item.handle.ref === paragraphRef);
  if (!paragraph) throw new Error(`Paragraph ${paragraphRef} is not present in this DOCX session.`);
  return targetFrom(registration, registration.session.captureTarget(paragraph.handle));
}

export const DOCX_AGENT_HOST: DocxToolsHost = {
  listDocuments: async () =>
    [...sessions.values()]
      .filter(
        (registration) =>
          registration.appProjectId === useFilesStore.getState().projectId,
      )
      .map(document),
  readDocument: async (sessionId) => {
    const registration = registrationFor(sessionId);
    return {
      document: document(registration),
      paragraphs: registration.session.listParagraphs().map((paragraph) => ({
        paragraphRef: paragraph.handle.ref,
        text: paragraph.text,
        ...(paragraph.paraId === undefined ? {} : { paraId: paragraph.paraId }),
      })),
    } satisfies DocxDocumentRead;
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
  saveDocument: async (sessionId, expectedRevision, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.save) throw new Error("Live DOCX saving is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX save request was cancelled before it started.");
    if (registration.session.revision() !== expectedRevision) {
      throw new Error(`DOCX save revision changed: expected ${expectedRevision}, current ${registration.session.revision()}.`);
    }
    return registration.save({
      expectedRevision,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
  },
  checkTemplate: async (sessionId, template, context) => {
    assertAttribution(context);
    const registration = registrationFor(sessionId);
    if (!registration.check) throw new Error("Explicit DOCX template checking is unavailable for this working copy.");
    if (context?.signal?.aborted) throw new Error("The DOCX template check was cancelled before it started.");
    return registration.check({
      template,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
  },
};

export interface DocxTaskScope {
  projectId: string;
  workbenchProjectId: string | null;
  operationId?: string;
}

function taskRegistration(scope: DocxTaskScope, sessionId?: string): RegisteredDocxSession {
  const matching = [...sessions.values()].filter((item) =>
    item.appProjectId === scope.projectId && (scope.workbenchProjectId === null || item.workbenchProjectId === scope.workbenchProjectId) &&
    (sessionId === undefined || item.sessionId === sessionId));
  if (matching.length !== 1) throw new Error("The task's DOCX working copy is unavailable or ambiguous.");
  return matching[0];
}

export function docxTaskDocument(scope: DocxTaskScope, sessionId?: string): DocxDocumentIdentity {
  const registration = taskRegistration(scope, sessionId);
  const { sessionId: id, baselineId, sessionRevision, savedRevision } = state(registration);
  return { sessionId: id, appProjectId: registration.appProjectId,
    workbenchProjectId: registration.workbenchProjectId, baselineId,
    sourceSha256: registration.sourceSha256, sessionRevision, savedRevision };
}

export async function settleTaskDocxOperation(
  scope: DocxTaskScope, operationId: string, sessionId?: string,
): Promise<void> {
  await taskRegistration(scope, sessionId).onTaskOperationRecorded?.(operationId);
}

export interface DocxTaskReadFormatArgs { query: DocxFormatReadQuery }
export interface DocxTaskFormatArgs {
  paragraphRef: string; expectedRevision: number; format: DocxFormatMutation;
}
export interface DocxTaskApplyArgs {
  targetId: string; expectedRevision: number; text: string;
}
export interface DocxTaskSaveArgs { expectedRevision: number }
export interface DocxTaskCheckArgs { template: string }

export type DocxTaskOperation = "read_format" | "format" | "apply" | "save" | "check";
export type DocxTaskOperationArgs =
  | DocxTaskReadFormatArgs | DocxTaskFormatArgs | DocxTaskApplyArgs
  | DocxTaskSaveArgs | DocxTaskCheckArgs;
export type DocxTaskOperationResult = (
  | {
      operation: "read_format"; ok: true; document: DocxDocumentIdentity;
      result: DocxFormatReadResult;
    }
  | {
      operation: "format" | "apply"; ok: boolean; document: DocxDocumentIdentity;
      result: DocxApplyResult;
    }
  | {
      operation: "save"; ok: true; document: DocxDocumentIdentity;
      result: DocxSaveResult;
    }
  | {
      operation: "check"; ok: true; document: DocxDocumentIdentity;
      result: DocxTemplateCheckResult;
    }) & { checkpoint?: { status: "recorded" | "failed"; error?: string } };

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
        ["check_id", "project_id", "baseline_id", "world_version_id", "summary"].filter((key) => result.result.check[key] !== undefined).map(
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
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "read_format",
  args: DocxTaskReadFormatArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "read_format" }>>;
export function runTaskDocxOperation(
  scope: DocxTaskScope,
  sessionId: string | undefined,
  operation: "format",
  args: DocxTaskFormatArgs,
): Promise<Extract<DocxTaskOperationResult, { operation: "format" }>>;
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
  if (operation === "read_format") {
    if (!registration.readFormat) throw new Error("Live DOCX formatting reads are unavailable for this working copy.");
    const result = await registration.readFormat((args as DocxTaskReadFormatArgs).query);
    return {
      operation, ok: true, document: docxTaskDocument(scope, registration.sessionId), result,
    };
  }
  if (operation === "format") {
    if (!registration.session.formatParagraph) throw new Error("Live DOCX formatting is unavailable for this working copy.");
    const input = args as DocxTaskFormatArgs;
    const paragraph = registration.session.listParagraphs().find(
      (item) => item.handle.ref === input.paragraphRef,
    );
    if (!paragraph) throw new Error(`Paragraph ${input.paragraphRef} is not present in this DOCX session.`);
    const result = registration.session.formatParagraph(
      paragraph.handle, input.expectedRevision, input.format,
    );
    return checkpointTaskOperation(scope, registration, {
      operation, ok: result.ok, document: docxTaskDocument(scope, registration.sessionId), result,
    }) as Promise<Extract<DocxTaskOperationResult, { operation: "format" }>>;
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
    const result = await registration.save({ expectedRevision: input.expectedRevision });
    const latest = taskRegistration(scope, registration.sessionId);
    sessions.set(latest.sessionId, { ...latest, baselineId: result.baselineId,
      savedRevision: result.revision, sourceSha256: result.sourceSha256 });
    notify();
    return checkpointTaskOperation(scope, latest, {
      operation, ok: true, document: docxTaskDocument(scope, latest.sessionId), result,
    }) as Promise<Extract<DocxTaskOperationResult, { operation: "save" }>>;
  }
  if (!registration.check) throw new Error("Explicit DOCX template checking is unavailable for this working copy.");
  const input = args as DocxTaskCheckArgs;
  if (!input.template.trim()) throw new Error("template must be an explicit world version ID.");
  const document = docxTaskDocument(scope, registration.sessionId);
  const result = await registration.check({ template: input.template });
  const current = docxTaskDocument(scope, registration.sessionId);
  if (current.sessionRevision !== document.sessionRevision || current.savedRevision !== document.savedRevision ||
    current.baselineId !== document.baselineId || current.sourceSha256 !== document.sourceSha256) {
    throw new Error("The DOCX working copy changed while its saved baseline was being checked. Read the current document before checking again.");
  }
  return checkpointTaskOperation(scope, registration, {
    operation, ok: true, document, result,
  }) as Promise<Extract<DocxTaskOperationResult, { operation: "check" }>>;
}

export function listTaskDocxDocuments(scope: DocxTaskScope, sessionId?: string) {
  return [...sessions.values()].filter((item) => item.appProjectId === scope.projectId &&
    item.workbenchProjectId === scope.workbenchProjectId && (sessionId === undefined || item.sessionId === sessionId)).map((item) => docxTaskDocument(scope, item.sessionId));
}

export function readTaskDocxDocument(scope: DocxTaskScope, sessionId?: string, offset = 0, limit = 20) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Read one to fifty DOCX paragraphs from a non-negative offset.");
  const registration = taskRegistration(scope, sessionId);
  const all = registration.session.listParagraphs();
  const paragraphs = [];
  let bytes = 0;
  for (const paragraph of all.slice(offset, offset + limit)) {
    const value = { paragraphRef: paragraph.handle.ref, text: paragraph.text, paraId: paragraph.paraId };
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes + size > 32 * 1024) {
      if (!paragraphs.length) throw new Error("This DOCX paragraph exceeds the 32 KiB read window.");
      break;
    }
    bytes += size;
    paragraphs.push(value);
  }
  const end = offset + paragraphs.length;
  return { document: docxTaskDocument(scope, registration.sessionId), paragraphs, offset,
    nextOffset: end < all.length ? end : null, totalParagraphs: all.length };
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

export function unregisterDocxAgentSession(sessionId: string): void {
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
}

export function createDocxAgentTools(
  opts?: DocxToolsOptions,
) {
  return createDocxTools(DOCX_AGENT_HOST, opts);
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

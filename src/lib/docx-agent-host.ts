import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import {
  createDocxTools,
  type DocxActivityDocument,
  type DocxDocumentRead,
  type DocxDocumentState,
  type DocxOperationContext,
  type DocxSuggestionApplyResult,
  type DocxSuggestionResult,
  type DocxTargetView,
  type DocxToolsOptions,
  type DocxToolsHost,
} from "@oleafly/ai-tools";
import { runInlineCompletion } from "@/lib/ai-inline";
import type { DocxSession, DocxTarget } from "@/lib/docx-session";
import { useFilesStore } from "@/store/files";

export interface DocxAgentRegistration {
  sessionId: string;
  appProjectId: string;
  workbenchProjectId: string;
  title: string;
  filename: string;
  baselineId: string;
  savedRevision: number;
  session: DocxSession;
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
    if (generations.has(registration.sessionId)) {
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
};

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
  update: { baselineId?: string; savedRevision?: number },
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

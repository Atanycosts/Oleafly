import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  captureTaskDocxTarget, docxTaskDocument, listTaskDocxDocuments,
  presentTaskDocxProposal, readTaskDocxDocument, validateTaskDocxProposal,
  runTaskDocxOperation,
  settleTaskDocxOperation,
} from "@/lib/docx-agent-host";
import type { DocxFormatMutation, DocxFormatReadQuery } from "@oleafly/ai-tools";

export interface DocxDocumentIdentity {
  sessionId: string; appProjectId: string; workbenchProjectId: string;
  baselineId: string; sourceSha256: string; sessionRevision: number; savedRevision: number;
}
export interface DocxActivityTarget {
  targetId: string; paragraphRef: string; revision: number; original: string;
  paraId?: string; structure?: string;
}
export interface DocxActivityOrigin {
  taskId: string; generation: number; groupId: string | null; memberId: string | null;
  executionId: string | null; workIds: string[];
}
export type DocxRuntimeEvent =
  | { kind: "bound" }
  | { kind: "read"; offset: number; paragraphs: { paragraphRef: string; text: string; paraId?: string }[] }
  | { kind: "captured"; target: DocxActivityTarget }
  | { kind: "proposed"; target: DocxActivityTarget; proposed: string }
  | { kind: "operationStarted"; operation: string; request: Record<string, unknown> }
  | { kind: "operation"; operationId?: string; operation: string; request: Record<string, unknown>; result: Record<string, unknown> };
export type DocxProposalOutcome =
  | { kind: "applied" | "rejected" | "withdrawn" }
  | { kind: "recovered"; recoveryKey: string; contentSha256: string; fromDocument: DocxDocumentIdentity }
  | { kind: "saved"; requestId: string; contentSha256: string };
export interface DocxActivity {
  id: string; origin: DocxActivityOrigin; document: DocxDocumentIdentity;
  proposalId: string | null; createdAt: number;
  event: { type: "runtime"; event: DocxRuntimeEvent } | { type: "outcome"; outcome: DocxProposalOutcome }
    | { type: "operationCheckpoint"; operationId: string; phase: "saved" | "recovered";
        recoveryKey: string; contentSha256: string; fromDocument: DocxDocumentIdentity; requestId?: string };
}
export interface DocxActivityPage {
  activities: { cursor: number; activity: DocxActivity }[]; nextCursor: number; hasMore: boolean;
}
export interface DocxRendererRequest {
  token: string; projectId: string; workbenchProjectId: string | null;
  operationId?: string;
  operation: "list" | "read" | "capture" | "propose" | "present" | "identity" | "read_format" | "format" | "apply" | "save" | "check";
  arguments: {
    session_id?: string; paragraph_ref?: string; target_id?: string;
    expected_revision?: number; text?: string; offset?: number; limit?: number; activity?: DocxActivity;
    query?: Record<string, unknown>; format?: DocxFormatMutation; template?: string;
  };
}
const changes = new Set<() => void>();
export function subscribeDocxTaskActivity(listener: () => void) {
  changes.add(listener);
  return () => { changes.delete(listener); };
}
export function notifyDocxTaskActivity() { for (const listener of changes) listener(); }
export const loadDocxTaskActivities = (projectId: string, workbenchProjectId: string, afterCursor = 0, limit = 20) =>
  invoke<DocxActivityPage>("research_docx_activities", { projectId, workbenchProjectId, afterCursor, limit });
export const bindDocxTask = (projectId: string, taskId: string, sessionId: string) =>
  invoke<void>("research_docx_bind_task", { projectId, taskId, sessionId });
export async function settleDocxTaskActivity(projectId: string, workbenchProjectId: string,
  proposalId: string, document: DocxDocumentIdentity, outcome: DocxProposalOutcome) {
  const result = await invoke<DocxActivity>("research_docx_activity_settle", {
    projectId, workbenchProjectId, proposalId, document, outcome,
  });
  notifyDocxTaskActivity();
  return result;
}

function formatReadQuery(value: Record<string, unknown> | undefined): DocxFormatReadQuery {
  const query = value ?? {};
  const attribute = query.attribute && typeof query.attribute === "object"
    ? query.attribute as Record<string, unknown> : {};
  return {
    ...(query.kind === "objects" || query.kind === "nodes" ? { kind: query.kind } : {}),
    ...(typeof query.paragraph_ref === "string" ? { paragraphRef: query.paragraph_ref } : {}),
    ...(typeof query.part === "string" ? { part: query.part } : {}),
    ...(Array.isArray(query.path)
      ? { path: query.path.filter((item): item is number => Number.isInteger(item)) } : {}),
    ...(typeof query.namespace_uri === "string" ? { namespaceUri: query.namespace_uri } : {}),
    ...(typeof query.local_name === "string" ? { localName: query.local_name } : {}),
    ...(typeof attribute.local_name === "string" ? { attribute: {
      localName: attribute.local_name,
      ...(typeof attribute.namespace_uri === "string" ? { namespaceUri: attribute.namespace_uri } : {}),
      ...(typeof attribute.value === "string" ? { value: attribute.value } : {}),
    } } : {}),
    ...(typeof query.offset === "number" ? { offset: query.offset } : {}),
    ...(typeof query.limit === "number" ? { limit: query.limit } : {}),
  };
}

export function handleDocxRendererRequest(request: DocxRendererRequest): unknown {
  const scope = { projectId: request.projectId, workbenchProjectId: request.workbenchProjectId,
    ...(request.operationId ? { operationId: request.operationId } : {}) };
  const input = request.arguments;
  switch (request.operation) {
    case "identity": return { document: docxTaskDocument(scope, input.session_id) };
    case "list": return { documents: listTaskDocxDocuments(scope, input.session_id) };
    case "read": return readTaskDocxDocument(scope, input.session_id, input.offset, input.limit);
    case "capture":
      if (!input.paragraph_ref) throw new Error("paragraph_ref is required.");
      return captureTaskDocxTarget(scope, input.session_id, input.paragraph_ref);
    case "propose":
      if (!input.target_id || input.expected_revision === undefined || input.text === undefined)
        throw new Error("target_id, expected_revision and text are required.");
      return validateTaskDocxProposal(scope, input.target_id, input.expected_revision, input.text, input.session_id);
    case "present":
      if (!input.activity) throw new Error("A retained activity is required.");
      presentTaskDocxProposal(scope, input.activity);
      notifyDocxTaskActivity();
      return { presented: true };
    case "read_format": return runTaskDocxOperation(scope, input.session_id, "read_format", {
      query: formatReadQuery(input.query),
    });
    case "format":
      if (!input.paragraph_ref || input.expected_revision === undefined || !input.format) throw new Error("paragraph_ref, expected_revision and format are required.");
      return runTaskDocxOperation(scope, input.session_id, "format", { paragraphRef: input.paragraph_ref, expectedRevision: input.expected_revision, format: input.format });
    case "apply":
      if (!input.target_id || input.expected_revision === undefined || input.text === undefined) throw new Error("target_id, expected_revision and text are required.");
      return runTaskDocxOperation(scope, input.session_id, "apply", { targetId: input.target_id, expectedRevision: input.expected_revision, text: input.text });
    case "save":
      if (input.expected_revision === undefined) throw new Error("expected_revision is required.");
      return runTaskDocxOperation(scope, input.session_id, "save", { expectedRevision: input.expected_revision });
    case "check":
      if (!input.template) throw new Error("An explicit template world version is required.");
      return runTaskDocxOperation(scope, input.session_id, "check", { template: input.template });
  }
}

/** Installed once by the application, independent of the selected task or panel. */
export function mountDocxTaskBridge() {
  const handle = async ({ payload }: { payload: DocxRendererRequest }) => {
    try {
      await invoke<void>("research_docx_request_claim", { token: payload.token });
    } catch {
      // Cancelled, expired and duplicate deliveries cannot take over the request.
      return;
    }
    let result: unknown;
    let error: string | undefined;
    try { result = await handleDocxRendererRequest(payload); }
    catch (cause) { error = String(cause); }
    try {
      const recorded = await invoke<boolean>("research_docx_result", { token: payload.token, result, error });
      if (recorded && payload.operationId) {
        await settleTaskDocxOperation({ projectId: payload.projectId, workbenchProjectId: payload.workbenchProjectId },
          payload.operationId, payload.arguments.session_id);
      }
    } catch {
      // Preserve the checkpoint if the native result or its cleanup was not acknowledged.
    }
  };
  // Keep the next task operation behind the previous native acknowledgement
  // and recovery cleanup, even if its model result has already been delivered.
  let pending: Promise<void> | null = null;
  return listen<DocxRendererRequest>("research-docx-request", (event) => {
    const work = pending ? pending.then(() => handle(event)) : handle(event);
    pending = work;
    void work.finally(() => { if (pending === work) pending = null; });
    return work;
  });
}

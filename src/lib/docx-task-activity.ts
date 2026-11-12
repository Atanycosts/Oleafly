import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  captureTaskDocxTarget, docxTaskDocument, listTaskDocxDocuments,
  presentTaskDocxProposal, readTaskDocxDocument, validateTaskDocxProposal,
} from "@/lib/docx-agent-host";

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
  | { kind: "proposed"; target: DocxActivityTarget; proposed: string };
export type DocxProposalOutcome =
  | { kind: "applied" | "rejected" | "withdrawn" }
  | { kind: "saved"; requestId: string; contentSha256: string };
export interface DocxActivity {
  id: string; origin: DocxActivityOrigin; document: DocxDocumentIdentity;
  proposalId: string | null; createdAt: number;
  event: { type: "runtime"; event: DocxRuntimeEvent } | { type: "outcome"; outcome: DocxProposalOutcome };
}
export interface DocxActivityPage {
  activities: { cursor: number; activity: DocxActivity }[]; nextCursor: number; hasMore: boolean;
}
export interface DocxRendererRequest {
  token: string; projectId: string; workbenchProjectId: string | null;
  operation: "list" | "read" | "capture" | "propose" | "present" | "identity";
  arguments: {
    session_id?: string; paragraph_ref?: string; target_id?: string;
    expected_revision?: number; text?: string; offset?: number; limit?: number; activity?: DocxActivity;
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

export function handleDocxRendererRequest(request: DocxRendererRequest): unknown {
  const scope = { projectId: request.projectId, workbenchProjectId: request.workbenchProjectId };
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
  }
}

/** Installed once by the application, independent of the selected task or panel. */
export function mountDocxTaskBridge() {
  return listen<DocxRendererRequest>("research-docx-request", async ({ payload }) => {
    try {
      await invoke<void>("research_docx_request_claim", { token: payload.token });
    } catch {
      // Cancelled, expired and duplicate deliveries cannot take over the request.
      return;
    }
    let result: unknown;
    let error: string | undefined;
    try { result = handleDocxRendererRequest(payload); }
    catch (cause) { error = String(cause); }
    await invoke("research_docx_result", { token: payload.token, result, error }).catch(() => {
      // The native request may have timed out or been cancelled before delivery.
    });
  });
}

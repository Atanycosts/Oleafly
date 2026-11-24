import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  captureTaskDocxTarget, docxTaskDocument, listTaskDocxDocuments,
  presentTaskDocxProposal, readTaskDocxDocumentPage, readTaskDocxImage,
  validateTaskDocxProposal,
  runTaskDocxOperation,
  settleTaskDocxOperation,
} from "@/lib/docx-agent-host";
import {
  docxFormatQuery,
  docxImageForTool,
  docxReadForTool,
  type DocxFormatBatchItem,
  type DocxFormatMutation,
  type DocxImageReadRequest,
  type DocxObjectFormatMutation,
} from "@oleafly/ai-tools";
import type { AgentExecutionOrigin } from "@/store/agent-workspace";

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
  origin?: Extract<AgentExecutionOrigin, { kind: "task" }>;
  operation: "list" | "read" | "read_image" | "capture" | "propose" | "present" | "identity" | "read_format" | "replace_range" | "write_equation" | "format" | "format_batch" | "import_styles" | "apply" | "save" | "check" | "context" | "reveal" | "prepare_fonts" | "export";
  arguments: {
    session_id?: string; paragraph_ref?: string; object_ref?: string; target_id?: string;
    expected_revision?: number; text?: string; offset?: number; limit?: number; text_offset?: number; text_limit?: number;
    atom_offset?: number; payload_offset?: number; read_version?: string;
    range?: { start: number; end: number }; expected_text?: string; replacement?: string; activity?: DocxActivity;
    query?: Record<string, unknown>; format?: DocxFormatMutation; object_format?: DocxObjectFormatMutation; template?: string;
    operations?: DocxFormatBatchItem[];
    style_ids?: string[];
    latex?: string; macros?: string; expected_fingerprint?: string; adopt_source?: boolean; display?: boolean;
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
export const bindDocxTask = (projectId: string, taskId: string, sessionId: string, expectedRevision?: number, expectedSessionIdentity?: DocxDocumentIdentity) =>
  invoke<void>("research_docx_bind_task", { projectId, taskId, sessionId,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(expectedSessionIdentity ? { expectedSessionIdentity } : {}) });
export async function settleDocxTaskActivity(projectId: string, workbenchProjectId: string,
  proposalId: string, document: DocxDocumentIdentity, outcome: DocxProposalOutcome) {
  const result = await invoke<DocxActivity>("research_docx_activity_settle", {
    projectId, workbenchProjectId, proposalId, document, outcome,
  });
  notifyDocxTaskActivity();
  return result;
}

export function handleDocxRendererRequest(request: DocxRendererRequest, beforeCommit?: () => Promise<void>): unknown {
  const scope = { projectId: request.projectId, workbenchProjectId: request.workbenchProjectId,
    ...(request.operationId ? { operationId: request.operationId } : {}),
    ...(beforeCommit ? { beforeCommit } : {}),
    ...(request.origin ? { origin: request.origin } : {}) };
  const input = request.arguments;
  switch (request.operation) {
    case "context": case "prepare_fonts": case "export":
      return runTaskDocxOperation(scope, input.session_id, request.operation, {});
    case "reveal":
      return runTaskDocxOperation(scope, input.session_id, "reveal", {
        paragraphRef: input.paragraph_ref, expectedRevision: input.expected_revision,
      });
    case "identity": return { document: docxTaskDocument(scope, input.session_id) };
    case "list": return { documents: listTaskDocxDocuments(scope, input.session_id) };
    case "read": {
      const page = readTaskDocxDocumentPage(
        scope, input.session_id, {
          ...(input.session_id ? { sessionId: input.session_id } : {}),
          ...(input.paragraph_ref ? { paragraphRef: input.paragraph_ref } : {}),
          ...(input.read_version ? { readVersion: input.read_version } : {}),
          offset: input.offset ?? 0,
          limit: input.limit ?? 20,
          ...(input.expected_revision == null ? {} : { expectedRevision: input.expected_revision }),
          ...(input.text_offset == null || input.text_limit == null ? {} :
            { textOffset: input.text_offset, textLimit: input.text_limit }),
          ...(input.atom_offset == null ? {} : { atomOffset: input.atom_offset }),
          ...(input.payload_offset == null ? {} : { payloadOffset: input.payload_offset }),
        },
      );
      return { ...docxReadForTool(page), document: docxTaskDocument(scope, input.session_id) };
    }
    case "read_image": {
      if (!input.paragraph_ref || !input.object_ref || input.expected_revision === undefined) {
        throw new Error("paragraph_ref, object_ref and expected_revision are required.");
      }
      const request: DocxImageReadRequest = {
        paragraphRef: input.paragraph_ref,
        objectRef: input.object_ref,
        expectedRevision: input.expected_revision,
      };
      return readTaskDocxImage(scope, input.session_id, request).then((result) => {
        const image = docxImageForTool(result, request, input.session_id);
        const document = docxTaskDocument(scope, input.session_id);
        if (
          document.sessionRevision !== request.expectedRevision ||
          document.sourceSha256 !== result.sourceSha256
        ) {
          throw new Error("The task's DOCX image changed before its document receipt was built.");
        }
        return {
          document,
          result: image.metadata,
          image: image.dataUrl,
        };
      });
    }
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
      query: docxFormatQuery(input.query),
    });
    case "replace_range":
      if (!input.paragraph_ref || input.expected_revision === undefined || !input.range ||
          input.expected_text === undefined || input.replacement === undefined)
        throw new Error("paragraph_ref, expected_revision, range, expected_text and replacement are required.");
      return runTaskDocxOperation(scope, input.session_id, "replace_range", {
        paragraphRef: input.paragraph_ref,
        expectedRevision: input.expected_revision,
        range: input.range,
        expectedText: input.expected_text,
        replacement: input.replacement,
      });
    case "write_equation":
      if (!input.paragraph_ref || input.expected_revision === undefined || input.latex === undefined)
        throw new Error("paragraph_ref, expected_revision and latex are required.");
      return runTaskDocxOperation(scope, input.session_id, "write_equation", {
        paragraphRef: input.paragraph_ref, expectedRevision: input.expected_revision,
        latex: input.latex, macros: input.macros, objectRef: input.object_ref,
        expectedFingerprint: input.expected_fingerprint, adoptSource: input.adopt_source,
        offset: input.offset, display: input.display,
      });
    case "format":
      if (!input.paragraph_ref || input.expected_revision === undefined || (!input.format && !input.object_format)) throw new Error("paragraph_ref, expected_revision and a format are required.");
      if (input.object_format) return runTaskDocxOperation(scope, input.session_id, "format", { paragraphRef: input.paragraph_ref, expectedRevision: input.expected_revision, objectFormat: input.object_format });
      if (!input.format) throw new Error("A paragraph format is required.");
      return runTaskDocxOperation(scope, input.session_id, "format", { paragraphRef: input.paragraph_ref, expectedRevision: input.expected_revision, format: input.format });
    case "format_batch":
      if (input.expected_revision === undefined || !input.operations?.length) throw new Error("expected_revision and operations are required.");
      return runTaskDocxOperation(scope, input.session_id, "format_batch", { expectedRevision: input.expected_revision, operations: input.operations });
    case "import_styles":
      if (!input.template || !input.style_ids?.length || input.expected_revision === undefined) throw new Error("template, style_ids and expected_revision are required.");
      return runTaskDocxOperation(scope, input.session_id, "import_styles", { expectedRevision: input.expected_revision, template: input.template, styleIds: input.style_ids });
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
    try { result = await handleDocxRendererRequest(payload, () => invoke<void>("research_docx_request_validate", { token: payload.token })); }
    catch (cause) { error = String(cause); }
    try {
      const recorded = await invoke<boolean>("research_docx_result", { token: payload.token, result, error });
      if (recorded && payload.operationId) {
        notifyDocxTaskActivity();
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

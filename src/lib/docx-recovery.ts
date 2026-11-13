import { invoke } from "@tauri-apps/api/core";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import type { DocxActivity, DocxDocumentIdentity, DocxProposalOutcome } from "@/lib/docx-task-activity";
import type { DocxSave } from "@/lib/docx-workbench";

export interface DocxRecoveryApplied {
  proposalId: string;
  document: DocxDocumentIdentity;
}

export interface DocxRecoveryReceipt extends DocxRecoveryApplied {
  outcome: DocxProposalOutcome;
}

export interface DocxRecoveryOperation {
  operationId: string;
  document: DocxDocumentIdentity;
  result: Record<string, unknown>;
}

export interface DocxRecoveryTaskState {
  document: DocxDocumentIdentity;
  applied: DocxRecoveryApplied[];
  receipts: DocxRecoveryReceipt[];
  operations?: DocxRecoveryOperation[];
  pendingSave?: {
    projectId: string; expectedBaselineId: string; filename: string;
    reason: string; requestId: string; revision: number;
  };
}

export function recoveryPendingSave(save: DocxSave): NonNullable<DocxRecoveryTaskState["pendingSave"]> {
  return { projectId: save.project_id, expectedBaselineId: save.expected_baseline_id,
    filename: save.filename, reason: save.reason, requestId: save.request_id, revision: save.revision };
}

export interface DocxRecoveryIdentity {
  appProjectId: string;
  workbenchProjectId: string;
  baseBaselineId: string;
  sourceSha256: string;
}

export interface DocxRecoveryMetadata extends DocxRecoveryIdentity {
  recoveryKey: string;
  revision: number;
  updatedAt: string;
  contentSha256: string;
  taskState?: DocxRecoveryTaskState;
}

export interface DocxRecoverySnapshot extends DocxRecoveryMetadata {
  bytes: Uint8Array;
}

export interface DocxRecoveryListing {
  snapshots: DocxRecoveryMetadata[];
  failures: { recoveryKey: string; error: string }[];
}

interface StoredDocxRecoverySnapshot extends DocxRecoveryMetadata {
  bytesBase64: string;
}

interface SaveRequest extends DocxRecoveryIdentity {
  recoveryKey: string;
  revision: number;
  updatedAt: string;
  contentBase64: string;
  taskState?: DocxRecoveryTaskState;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function docxContentSha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return sha256Hex(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export async function docxRecoveryKey(identity: DocxRecoveryIdentity): Promise<string> {
  const stableIdentity = [
    identity.appProjectId,
    identity.workbenchProjectId,
    identity.baseBaselineId,
    identity.sourceSha256,
  ].map((value) => {
    const bytes = new TextEncoder().encode(value);
    return `${bytes.length}:${value}`;
  }).join("\n");
  return sha256Hex(new TextEncoder().encode(stableIdentity));
}

export async function saveDocxRecovery(
  identity: DocxRecoveryIdentity,
  revision: number,
  bytes: ArrayBuffer,
  taskState?: DocxRecoveryTaskState,
): Promise<DocxRecoveryMetadata> {
  const content = new Uint8Array(bytes);
  const request: SaveRequest = {
    ...identity,
    recoveryKey: await docxRecoveryKey(identity),
    revision,
    updatedAt: new Date().toISOString(),
    contentBase64: bytesToBase64(content),
    ...(taskState ? { taskState } : {}),
  };
  return invoke<DocxRecoveryMetadata>("docx_recovery_save", { request });
}

export type DocxRecoveryRefusal = "BASELINE_CONFLICT" | "REJECTED" | "IDEMPOTENCY_CONFLICT";
export type DocxRecoveryCommitResult =
  | { baselineId: string; sourceSha256: string; revision: number }
  | { refusal: DocxRecoveryRefusal };

export function commitDocxRecovery(snapshot: Pick<DocxRecoveryMetadata, "recoveryKey" | "contentSha256">) {
  return invoke<DocxRecoveryCommitResult>("docx_recovery_commit", {
    request: { recoveryKey: snapshot.recoveryKey, contentSha256: snapshot.contentSha256 },
  });
}

export function resumeDocxRecovery(snapshot: Pick<DocxRecoveryMetadata, "recoveryKey" | "contentSha256">,
  document: DocxDocumentIdentity) {
  return invoke<DocxActivity[]>("docx_recovery_resume", {
    request: { recoveryKey: snapshot.recoveryKey, contentSha256: snapshot.contentSha256 }, document,
  });
}

export async function readDocxRecovery(identity: DocxRecoveryIdentity): Promise<DocxRecoverySnapshot | null> {
  const recoveryKey = await docxRecoveryKey(identity);
  const stored = await invoke<StoredDocxRecoverySnapshot | null>("docx_recovery_read", {
    request: { recoveryKey },
  });
  if (!stored) return null;
  const { bytesBase64, ...metadata } = stored;
  return { ...metadata, bytes: base64ToBytes(bytesBase64) };
}

export function listDocxRecovery(): Promise<DocxRecoveryListing> {
  return invoke<DocxRecoveryListing>("docx_recovery_list");
}

export function discardDocxRecovery(snapshot: DocxRecoveryMetadata): Promise<boolean> {
  return invoke<boolean>("docx_recovery_clear", {
    request: { recoveryKey: snapshot.recoveryKey, contentSha256: snapshot.contentSha256 },
  });
}

export async function clearDocxRecovery(
  identity: DocxRecoveryIdentity,
  committedBytes: ArrayBuffer | Uint8Array,
): Promise<boolean> {
  const recoveryKey = await docxRecoveryKey(identity);
  const contentSha256 = await docxContentSha256(committedBytes);
  return invoke<boolean>("docx_recovery_clear", {
    request: { recoveryKey, contentSha256 },
  });
}

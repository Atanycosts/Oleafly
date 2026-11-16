import type { Editor, EditorSnapshot } from "@docx-editor.dev/core/contracts/editor";
import { createMaterialDocument, type MaterialAnchor, type MaterialDocument } from "./material-surface";

export const DOCX_MATERIAL_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DocxMaterialMetadata {
  projectId: string;
  documentId: string;
  title: string;
}

export interface DocxMaterialSelection {
  anchor: Extract<MaterialAnchor, { kind: "object" }>;
  quote: string;
}

export type DocxMaterialCaptureErrorCode = "not-ready" | "revision-changed";

export class DocxMaterialCaptureError extends Error {
  readonly code: DocxMaterialCaptureErrorCode;

  constructor(code: DocxMaterialCaptureErrorCode) {
    super(code === "revision-changed"
      ? "The DOCX changed while its annotation copy was being prepared."
      : "The DOCX is not ready to export.");
    this.name = "DocxMaterialCaptureError";
    this.code = code;
  }
}

export interface CapturedDocxMaterial {
  document: MaterialDocument;
  sessionRevision: number;
}

export function readDocxMaterialSelection(
  editor: Pick<Editor, "query" | "snapshot">,
  snapshot: EditorSnapshot = editor.snapshot(),
): DocxMaterialSelection | null {
  if (snapshot.selectionCollapsed || !snapshot.selection) return null;
  const from = snapshot.selection.from;
  const to = snapshot.selection.to;
  if (!("paraId" in from) || !("paraId" in to) || from.paraId !== to.paraId) return null;
  const quote = editor.query({ type: "selectedText" });
  return {
    anchor: { kind: "object", id: from.paraId, ...(quote ? { label: quote } : {}) },
    quote,
  };
}

export async function captureWorkingDocxMaterial(input: {
  metadata: DocxMaterialMetadata;
  editor: { save(): Promise<ArrayBuffer | null> };
  session: { revision(): number };
}): Promise<CapturedDocxMaterial> {
  const sessionRevision = input.session.revision();
  const bytes = await input.editor.save();
  if (!bytes) throw new DocxMaterialCaptureError("not-ready");
  if (input.session.revision() !== sessionRevision) throw new DocxMaterialCaptureError("revision-changed");
  const document = await createMaterialDocument(
    { ...input.metadata, path: null, kind: "docx" },
    { bytes, mediaType: DOCX_MATERIAL_MEDIA_TYPE },
  );
  if (input.session.revision() !== sessionRevision) throw new DocxMaterialCaptureError("revision-changed");
  return { document, sessionRevision };
}

export function captureRetainedDocxMaterial(
  metadata: DocxMaterialMetadata,
  bytes: Uint8Array,
): Promise<MaterialDocument> {
  return createMaterialDocument(
    { ...metadata, path: null, kind: "docx" },
    { bytes, mediaType: DOCX_MATERIAL_MEDIA_TYPE },
  );
}

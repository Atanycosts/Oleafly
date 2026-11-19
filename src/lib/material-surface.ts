import type { AnnotationTarget } from "@/lib/task-collaboration";

export type MaterialKind = "docx" | "pdf" | "markdown" | "source" | "image" | "diagram" | "html";
export interface MaterialRect { x: number; y: number; width: number; height: number }
/** Coordinates belong exclusively to the document revision that captured them. */
export type MaterialAnchor =
  | { kind: "whole" }
  | { kind: "text"; from: number; to: number; quote: string }
  | { kind: "page"; page: number; rects: MaterialRect[]; quote?: string }
  | { kind: "pdf"; pages: { page: number; rects: MaterialRect[] }[]; quote?: string; rotation: 0 | 90 | 180 | 270 }
  | { kind: "region"; rect: MaterialRect }
  | { kind: "html"; selector: string; quote: string }
  | { kind: "object"; id: string; label?: string };

export type MaterialContent = { text: string; mediaType?: string } | { bytes: Uint8Array | ArrayBuffer; mediaType?: string };
export interface MaterialDocument {
  projectId: string;
  /** Stable within a project, including across retained content versions. */
  documentId: string;
  path: string | null;
  title: string;
  kind: MaterialKind;
  /** Exact byte SHA-256, optionally prefixed with sha256:. Never a timestamp. */
  revision: string;
  /** Capture the displayed version, including unsaved buffers or retained bytes. */
  source: MaterialContent | (() => Promise<MaterialContent>);
}
export type MaterialReference = Omit<MaterialDocument, "source">;
export interface MaterialSnapshot { document: MaterialReference; anchor: MaterialAnchor; sha256: string; mediaType: string; size: number }

export async function materialBytes(content: MaterialContent): Promise<Uint8Array> {
  return "text" in content ? new TextEncoder().encode(content.text)
    : new Uint8Array(content.bytes);
}

export async function materialRevision(content: MaterialContent): Promise<string> {
  const bytes = await materialBytes(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Freeze content before hashing so later editor or navigation changes cannot replace it. */
export async function createMaterialDocument(
  document: Omit<MaterialDocument, "revision" | "source">,
  content: MaterialContent,
): Promise<MaterialDocument> {
  const source = "text" in content ? { ...content } : { ...content, bytes: (await materialBytes(content)).slice() };
  return { ...document, revision: await materialRevision(source), source };
}

export function materialTarget(document: MaterialReference): AnnotationTarget {
  return { projectId: document.projectId, taskId: null, objectKind: "material", objectId: document.documentId,
    objectRevision: document.revision, path: null };
}

export function sameMaterialVersion(left: MaterialReference, right: MaterialReference): boolean {
  return left.projectId === right.projectId && left.documentId === right.documentId && left.revision === right.revision;
}

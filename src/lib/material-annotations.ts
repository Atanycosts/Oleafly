import { invoke } from "@tauri-apps/api/core";
import { materialBytes, type MaterialAnchor, type MaterialDocument, type MaterialReference, type MaterialSnapshot } from "@/lib/material-surface";
import { normalizeTask, type ResearchTask, type ResearchTaskDraft } from "@/lib/research-tasks";
import type { TaskAnnotation, TaskAnnotationDraft } from "@/lib/task-collaboration";

export interface RetainedMaterial { snapshot: MaterialSnapshot; bytes: number[] }
export interface MaterialRequest { annotation: TaskAnnotation; task: ResearchTask; needsStart: boolean }

export async function saveMaterialAnnotation(document: MaterialDocument, anchor: MaterialAnchor, draft: TaskAnnotationDraft): Promise<TaskAnnotation> {
  // Replies inherit their parent's frozen source in the owning native adapter.
  const content = draft.parentId ? null : typeof document.source === "function" ? await document.source() : document.source;
  const bytes = content ? await materialBytes(content) : new Uint8Array();
  const { source: _source, ...reference } = document;
  return invoke<TaskAnnotation>("material_annotation_save", {
    document: reference, anchor, bytes: Array.from(bytes), mediaType: content?.mediaType ?? null,
    body: draft.body, parentId: draft.parentId, mentions: draft.mentions,
  });
}

export const readMaterialAnnotation = (projectId: string, annotationId: string) =>
  invoke<RetainedMaterial>("material_annotation_read", { projectId, annotationId });

export async function requestMaterialAnnotation(projectId: string, annotationId: string, draft: ResearchTaskDraft): Promise<MaterialRequest> {
  const result = await invoke<MaterialRequest>("material_annotation_request", { projectId, annotationId, draft });
  return { ...result, task: normalizeTask(result.task) };
}

/** Reference metadata is presentation data; native read verifies the bytes and scope. */
export function materialAnnotationSnapshot(annotation: TaskAnnotation): MaterialSnapshot | null {
  if (annotation.source?.kind !== "material_snapshot") return null;
  return JSON.parse(annotation.source.content) as MaterialSnapshot;
}

export function materialReference(document: MaterialDocument): MaterialReference {
  const { source: _source, ...reference } = document;
  return reference;
}

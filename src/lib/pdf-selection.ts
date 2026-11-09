import { invoke } from "@tauri-apps/api/core";
import type { PdfTextSelection } from "@/components/pdf/PdfViewer";
import type { CompileSuccessCheckpoint } from "@/lib/compile-checkpoint";
import type { captureAssistantTarget } from "@/lib/assistant-delegation-capture";
import { uint8ToBase64 } from "@/lib/tauri";
import { defaultBrief, normalizeTask, startResearchTask, type ResearchTask, type ResearchTaskDraft, type TaskCompiledArtifact } from "@/lib/research-tasks";
import type { TaskAnnotation } from "@/lib/task-collaboration";
import { useFilesStore } from "@/store/files";
import { useResearchTasksStore } from "@/store/research-tasks";
import { researchTasksEnabled } from "@/store/research-tasks-flag";
import { useSettingsStore } from "@/store/settings";

export interface PdfSelectionInput {
  projectId: string;
  mainDocument: string;
  checkpoint: CompileSuccessCheckpoint | null;
  selection: PdfTextSelection;
  pdfSha256: string;
  size: number;
}

export interface FrozenPdfSelection {
  projectId: string;
  mainDocument: string;
  checkpoint: CompileSuccessCheckpoint | null;
  selection: PdfTextSelection;
  bytes: Uint8Array;
}

export interface RetainedPdfSelection {
  annotationId: string;
  originalAnnotationId: string;
  input: PdfSelectionInput;
  reference: TaskCompiledArtifact;
}

export function pdfSelectionInput(annotation: TaskAnnotation): PdfSelectionInput {
  if (annotation.source?.kind !== "pdf_selection") throw new Error("This annotation has no retained PDF selection.");
  return JSON.parse(annotation.source.content) as PdfSelectionInput;
}

export async function savePdfSelection(frozen: FrozenPdfSelection, body: string): Promise<TaskAnnotation> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(frozen.bytes));
  const pdfSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return invoke("research_pdf_selection_save", {
    projectId: frozen.projectId, mainDocument: frozen.mainDocument, checkpoint: frozen.checkpoint,
    selection: frozen.selection, pdfBase64: uint8ToBase64(frozen.bytes), pdfSha256, body,
  });
}

export const listPdfSelections = (projectId: string) =>
  invoke<TaskAnnotation[]>("research_pdf_selections", { projectId });

export const readPdfSelection = (projectId: string, annotationId: string) =>
  invoke<ArrayBuffer>("research_pdf_selection_read", { projectId, annotationId });

export const loadTaskPdfSelection = (taskId: string) =>
  invoke<RetainedPdfSelection | null>("research_task_pdf_selection", { taskId });

export const createPdfSelectionTask = (draft: ResearchTaskDraft, annotationId: string) =>
  invoke<ResearchTask>("research_task_create_from_pdf_selection", { draft, annotationId }).then(normalizeTask);

export async function createPdfReviewTask(annotation: TaskAnnotation, request: string, target: Awaited<ReturnType<typeof captureAssistantTarget>>): Promise<ResearchTask> {
  if (!researchTasksEnabled()) throw new Error("Enable research tasks in Settings, Research before starting a PDF review.");
  const projectId = annotation.target.projectId;
  const brief = defaultBrief(request.slice(0, 2000));
  const task = await createPdfSelectionTask({
    projectId, title: `${annotation.target.path}: ${request}`.slice(0, 100), prompt: request,
    ...target, brief, skillIds: [], dependencyIds: [],
  }, annotation.id);
  if (useFilesStore.getState().projectId === projectId) useResearchTasksStore.getState().receiveTask(task);
  return task;
}

export async function startPdfReviewTask(task: ResearchTask): Promise<ResearchTask> {
  const started = await startResearchTask(task.id);
  if (useFilesStore.getState().projectId === task.projectId) {
    useResearchTasksStore.getState().receiveTask(started);
    useResearchTasksStore.getState().openTaskDetail(started.id, "annotations");
    useSettingsStore.getState().setRailTab("research");
  }
  return started;
}
